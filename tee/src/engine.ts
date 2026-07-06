import { verifyTypedData, type TypedDataField } from "ethers";
import type { Order, SealedOrder, Settlement, BatchCommit, SignedSettlement } from "@eclipse/shared";
import { EIP712_ORDER_TYPES, orderEip712Domain, orderSigningValue } from "@eclipse/shared";
import { runAuction, type FtsoRef, type AuctionResult, type TokenDecimals } from "./auction.js";
import { openOrder, type SealedKeypair } from "./seal.js";
import { EngineSigner } from "./signer.js";

const ORDER_TYPES = EIP712_ORDER_TYPES as unknown as Record<string, TypedDataField[]>;

/** Reads the live FTSO XRP/USD reference. Live impl reads Coston2; tests stub it. */
export interface FtsoReader {
  read(): Promise<FtsoRef>;
}

export interface EngineConfig {
  chainId: number;
  settlementAddress: string;
  bandBps: bigint;
  /** How long after clearing the signed batch stays valid on-chain. */
  batchTtlSeconds: number;
  /** On-chain decimals of FXRP (base) and the quote token. Defaults to 6/6. */
  tokenDecimals?: TokenDecimals;
  /**
   * Require each order to carry a valid EIP-712 signature from its `account`
   * (default true). Prevents anyone from submitting an order — and forcing a
   * trade — against another trader's escrow. Only tests set this false.
   */
  requireSignedOrders?: boolean;
  /** Injected clock (seconds). Defaults to wall clock; tests can pin it. */
  now?: () => number;
}

export interface BatchOutcome {
  crossed: boolean;
  auction: AuctionResult;
  signed?: SignedSettlement;
  batchId: bigint;
}

/**
 * The confidential matching engine. Holds the sealed-box secret key and the
 * settlement signing key. Orders are opened, matched, and reduced to NET deltas
 * entirely in-process; only the signed net Settlement + participant BatchCommit
 * leave. Nothing about the order book is returned or logged.
 */
export class MatchingEngine {
  private readonly keypair: SealedKeypair;
  private readonly signer: EngineSigner;
  private readonly reader: FtsoReader;
  private readonly cfg: EngineConfig;
  private seq = 0n;
  /** Consumed order ids (`account:nonce` → order expiry) — replay guard. */
  private readonly consumed = new Map<string, number>();

  constructor(
    keypair: SealedKeypair,
    signerKey: string,
    reader: FtsoReader,
    cfg: EngineConfig,
  ) {
    this.keypair = keypair;
    this.signer = new EngineSigner(signerKey, cfg.chainId, cfg.settlementAddress);
    this.reader = reader;
    this.cfg = cfg;
  }

  get publicKey(): string {
    return this.keypair.publicKey;
  }

  get signerAddress(): string {
    return this.signer.address;
  }

  /**
   * Seed the batch/nonce counter from the on-chain state at boot. The contract
   * enforces strictly-increasing commit/settlement nonces, so after a restart
   * the engine must resume ABOVE the highest nonce the chain already recorded —
   * otherwise every new batch reverts `ReplayedBatch` forever. Idempotent: only
   * ever advances the counter.
   */
  seedSequence(highestOnChainNonce: bigint): void {
    if (highestOnChainNonce > this.seq) this.seq = highestOnChainNonce;
  }

  private clock(): number {
    return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000);
  }

  /** True iff `o.signature` is a valid EIP-712 order signature by `account`. */
  private orderSignerMatches(o: Order, account: string): boolean {
    if (!o.signature) return false;
    try {
      const domain = orderEip712Domain(this.cfg.chainId, this.cfg.settlementAddress);
      const recovered = verifyTypedData(domain, ORDER_TYPES, orderSigningValue(o), o.signature);
      return recovered.toLowerCase() === account;
    } catch {
      return false;
    }
  }

  /** Decrypt a sealed envelope inside the enclave. */
  async open(sealed: SealedOrder): Promise<Order> {
    return openOrder(sealed.ciphertext, this.keypair);
  }

  /**
   * Run one batch: decrypt, drop expired orders, cross at a uniform FTSO-bounded
   * price, and return a signed net Settlement (+ commit) ready for the relay to
   * push on-chain. Returns `crossed: false` when nothing matches inside the band.
   */
  async runBatch(sealedOrders: SealedOrder[]): Promise<BatchOutcome> {
    const now = this.clock();
    // Drop replay guards for orders that have since expired (bounded memory).
    for (const [key, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(key);
    }

    const orders: Order[] = [];
    const seenThisBatch = new Set<string>();
    const expiryByKey = new Map<string, number>();
    // Hard ceiling on how far in the future an order may be valid. The in-memory
    // replay guard (`consumed`) does not survive a restart, so a filled order's
    // ciphertext (held by the untrusted relay) could in principle be re-executed
    // after a restart within its own validity window. Bounding the accepted
    // expiry horizon caps that window regardless of what a client signs. A full
    // fix (durable/on-chain per-order nonces) is tracked in SECURITY.md.
    const maxOrderTtl = this.cfg.batchTtlSeconds * 4;
    for (const s of sealedOrders) {
      try {
        const o = await this.open(s);
        if (o.expiry <= now) continue; // expired
        if (o.expiry > now + maxOrderTtl) continue; // absurd far-future expiry
        // Normalize the address so mixed-case duplicates can't split a trader's
        // netting (which would revert the whole batch on-chain), and so it keys
        // the guards consistently.
        const account = o.account.toLowerCase();
        // Authenticate the order to its account (unless a test disables it) so no
        // one can force a trade against another trader's escrow.
        if (this.cfg.requireSignedOrders !== false && !this.orderSignerMatches(o, account)) {
          continue;
        }
        const key = `${account}:${o.nonce.toString()}`;
        // Already FILLED in a prior batch → one-shot, drop it (replay guard).
        if (this.consumed.has(key)) continue;
        // Duplicate within THIS batch → drop, so a relay can't inflate a side by
        // resubmitting one ciphertext multiple times in the same interval.
        if (seenThisBatch.has(key)) continue;
        seenThisBatch.add(key);
        // Cap retained expiry so an order with an absurd far-future expiry can't
        // pin a consumed-guard entry in memory forever.
        expiryByKey.set(key, Math.min(o.expiry, now + this.cfg.batchTtlSeconds * 4));
        orders.push({ ...o, account });
      } catch {
        // Undecryptable / malformed ciphertext is silently dropped — the relay
        // cannot read it and neither will we leak why.
      }
    }

    const ftso = await this.reader.read();
    const auction = runAuction(orders, ftso, this.cfg.bandBps, this.cfg.tokenDecimals);
    const batchId = ++this.seq;

    if (!auction.crossed || auction.deltas.length === 0) {
      // Nothing crossed — consume NOTHING. Unmatched orders may rest / be
      // resubmitted for a later interval (a real counterparty may still arrive).
      return { crossed: false, auction, batchId };
    }

    // Consume ONLY the orders that actually filled, so double-execution of a
    // settled order is prevented while resting orders survive.
    for (const f of auction.filled) {
      const key = `${f.account}:${f.nonce.toString()}`;
      this.consumed.set(key, expiryByKey.get(key) ?? now + this.cfg.batchTtlSeconds * 4);
    }

    const expiry = BigInt(now + this.cfg.batchTtlSeconds);
    const accounts = auction.deltas.map((d) => d.account);

    const settlement: Settlement = {
      batchId,
      accounts,
      fxrpDeltas: auction.deltas.map((d) => d.fxrpDelta),
      usdt0Deltas: auction.deltas.map((d) => d.usdt0Delta),
      clearingPrice: auction.clearingPrice,
      ftsoRef: ftso.value,
      expiry,
      nonce: batchId,
    };
    const commit: BatchCommit = { batchId, accounts, expiry, nonce: batchId };

    const [settlementSignature, commitSignature] = await Promise.all([
      this.signer.signSettlement(settlement),
      this.signer.signCommit(commit),
    ]);

    const signed: SignedSettlement = {
      settlement: {
        batchId: settlement.batchId.toString(),
        accounts,
        fxrpDeltas: settlement.fxrpDeltas.map((v) => v.toString()),
        usdt0Deltas: settlement.usdt0Deltas.map((v) => v.toString()),
        clearingPrice: settlement.clearingPrice.toString(),
        ftsoRef: settlement.ftsoRef.toString(),
        expiry: settlement.expiry.toString(),
        nonce: settlement.nonce.toString(),
      },
      commit: {
        batchId: commit.batchId.toString(),
        accounts,
        expiry: commit.expiry.toString(),
        nonce: commit.nonce.toString(),
      },
      settlementSignature,
      commitSignature,
    };

    return { crossed: true, auction, signed, batchId };
  }
}
