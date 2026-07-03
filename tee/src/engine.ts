import type { Order, SealedOrder, Settlement, BatchCommit, SignedSettlement } from "@eclipse/shared";
import { runAuction, type FtsoRef, type AuctionResult } from "./auction.js";
import { openOrder, type SealedKeypair } from "./seal.js";
import { EngineSigner } from "./signer.js";

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
    for (const s of sealedOrders) {
      try {
        const o = await this.open(s);
        if (o.expiry <= now) continue; // expired
        // Replay guard: each sealed order (account, nonce) is one-shot. The
        // untrusted relay can resubmit the same ciphertext; we match it at most
        // once. A trader who wasn't filled resubmits a fresh order (new nonce).
        const key = `${o.account.toLowerCase()}:${o.nonce.toString()}`;
        if (this.consumed.has(key)) continue;
        this.consumed.set(key, o.expiry);
        orders.push(o);
      } catch {
        // Undecryptable / malformed ciphertext is silently dropped — the relay
        // cannot read it and neither will we leak why.
      }
    }

    const ftso = await this.reader.read();
    const auction = runAuction(orders, ftso, this.cfg.bandBps);
    const batchId = ++this.seq;

    if (!auction.crossed || auction.deltas.length === 0) {
      return { crossed: false, auction, batchId };
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
