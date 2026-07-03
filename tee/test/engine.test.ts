import { describe, it, expect } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import {
  Side,
  type Order,
  eip712Domain,
  EIP712_SETTLEMENT_TYPES,
  EIP712_COMMIT_TYPES,
  EIP712_ORDER_TYPES,
  orderEip712Domain,
  orderSigningValue,
} from "@eclipse/shared";
import { MatchingEngine } from "../src/engine.js";
import { StaticFtsoReader } from "../src/ftso.js";
import { generateKeypair, sealOrder } from "../src/seal.js";
import type { SealedOrder } from "@eclipse/shared";

const CHAIN_ID = 114;
const SETTLEMENT = "0x" + "e".repeat(40);
const FTSO = { value: 50_000_000n, decimals: 8 };

// Real signing wallets, so orders carry valid EIP-712 signatures.
const wallets = {
  A: Wallet.createRandom(),
  B: Wallet.createRandom(),
  C: Wallet.createRandom(),
  D: Wallet.createRandom(),
};
const desks = {
  A: wallets.A.address,
  B: wallets.B.address,
  C: wallets.C.address,
  D: wallets.D.address,
};

let nonce = 0;
/** Build an order signed by the account's wallet (unless `account` casing is overridden). */
async function order(
  wallet: Wallet,
  side: Side,
  base: string,
  limit: string,
  account: string = wallet.address,
): Promise<Order> {
  const o: Order = {
    side,
    baseAmount: base,
    limitPrice: limit,
    account,
    nonce: String(++nonce),
    expiry: 9_999_999_999,
  };
  const signature = await wallet.signTypedData(
    orderEip712Domain(CHAIN_ID, SETTLEMENT),
    EIP712_ORDER_TYPES as never,
    orderSigningValue(o),
  );
  return { ...o, signature };
}

async function seal(engineKeyPub: string, o: Order): Promise<SealedOrder> {
  return {
    ciphertext: await sealOrder(o, engineKeyPub),
    enginePublicKey: engineKeyPub,
    submissionId: crypto.randomUUID(),
  };
}

function makeEngine(kp: Awaited<ReturnType<typeof generateKeypair>>, signerKey?: string) {
  return new MatchingEngine(kp, signerKey ?? Wallet.createRandom().privateKey, new StaticFtsoReader(FTSO), {
    chainId: CHAIN_ID,
    settlementAddress: SETTLEMENT,
    bandBps: 50n,
    batchTtlSeconds: 300,
    now: () => 1_000,
  });
}

describe("MatchingEngine end-to-end", () => {
  it("turns 4 sealed orders into one signed, verifiable, conserving settlement", async () => {
    const kp = await generateKeypair();
    const signerKey = Wallet.createRandom().privateKey;
    const engine = makeEngine(kp, signerKey);

    const orders = [
      await order(wallets.A, Side.Buy, "60000000", "50200000"),
      await order(wallets.B, Side.Buy, "40000000", "50000000"),
      await order(wallets.C, Side.Sell, "70000000", "49800000"),
      await order(wallets.D, Side.Sell, "30000000", "50100000"),
    ];
    const sealed = await Promise.all(orders.map((o) => seal(kp.publicKey, o)));

    const outcome = await engine.runBatch(sealed);
    expect(outcome.crossed).to.equal(true);
    const signed = outcome.signed!;
    expect(signed).toBeTruthy();

    // Conservation of both tokens.
    const fSum = signed.settlement.fxrpDeltas.reduce((s, v) => s + BigInt(v), 0n);
    const uSum = signed.settlement.usdt0Deltas.reduce((s, v) => s + BigInt(v), 0n);
    expect(fSum).to.equal(0n);
    expect(uSum).to.equal(0n);

    // The settlement signature recovers to the engine's signer address (this is
    // exactly what EclipseSettlement checks on-chain against the whitelist).
    const domain = eip712Domain(CHAIN_ID, SETTLEMENT);
    const value = {
      batchId: BigInt(signed.settlement.batchId),
      accounts: signed.settlement.accounts,
      fxrpDeltas: signed.settlement.fxrpDeltas.map(BigInt),
      usdt0Deltas: signed.settlement.usdt0Deltas.map(BigInt),
      clearingPrice: BigInt(signed.settlement.clearingPrice),
      ftsoRef: BigInt(signed.settlement.ftsoRef),
      expiry: BigInt(signed.settlement.expiry),
      nonce: BigInt(signed.settlement.nonce),
    };
    const recovered = verifyTypedData(
      domain,
      EIP712_SETTLEMENT_TYPES as never,
      value,
      signed.settlementSignature,
    );
    expect(recovered).to.equal(engine.signerAddress);

    // Commit signature also recovers to the engine signer and covers the same set.
    const commitVal = {
      batchId: BigInt(signed.commit.batchId),
      accounts: signed.commit.accounts,
      expiry: BigInt(signed.commit.expiry),
      nonce: BigInt(signed.commit.nonce),
    };
    const recoveredCommit = verifyTypedData(
      domain,
      EIP712_COMMIT_TYPES as never,
      commitVal,
      signed.commitSignature,
    );
    expect(recoveredCommit).to.equal(engine.signerAddress);
  });

  it("returns crossed:false when nothing matches in-band, leaking nothing", async () => {
    const kp = await generateKeypair();
    const engine = makeEngine(kp);
    const sealed = await Promise.all([
      seal(kp.publicKey, await order(wallets.A, Side.Buy, "100000000", "49800000")),
      seal(kp.publicKey, await order(wallets.B, Side.Sell, "100000000", "50200000")),
    ]);
    const outcome = await engine.runBatch(sealed);
    expect(outcome.crossed).to.equal(false);
    expect(outcome.signed).to.equal(undefined);
  });

  it("rejects an order whose signature does not match its account (forged order)", async () => {
    const kp = await generateKeypair();
    const engine = makeEngine(kp);
    // Attacker forges an order CLAIMING to be desk A but signs with their own key.
    const forged = await order(wallets.D, Side.Sell, "100000000", "49900000", desks.A);
    const honestBuy = await order(wallets.B, Side.Buy, "100000000", "50100000");
    const sealed = await Promise.all([
      seal(kp.publicKey, forged),
      seal(kp.publicKey, honestBuy),
    ]);
    const outcome = await engine.runBatch(sealed);
    // The forged sell is dropped → no counterparty → no cross. Desk A is not force-traded.
    expect(outcome.crossed).to.equal(false);
  });

  it("lets an unfilled order rest and fill in a LATER batch (consume-on-fill)", async () => {
    const kp = await generateKeypair();
    const engine = makeEngine(kp);
    const buy = await order(wallets.A, Side.Buy, "100000000", "50100000"); // in-band buy @ 0.501
    const buySealed = await seal(kp.publicKey, buy);

    // Batch 1: only the buy → no counterparty → no cross. Must NOT be consumed.
    const r1 = await engine.runBatch([buySealed]);
    expect(r1.crossed).to.equal(false);

    // Batch 2: the SAME buy is resubmitted plus a seller now → it should cross.
    const sellSealed = await seal(kp.publicKey, await order(wallets.B, Side.Sell, "100000000", "49900000"));
    const r2 = await engine.runBatch([buySealed, sellSealed]);
    expect(r2.crossed).to.equal(true);
    expect(r2.signed!.settlement.accounts.length).to.equal(2);
  });

  it("does not re-match a FILLED order that the relay resubmits (replay guard)", async () => {
    const kp = await generateKeypair();
    const engine = makeEngine(kp);
    const buy = await seal(kp.publicKey, await order(wallets.A, Side.Buy, "100000000", "50100000"));
    const sell = await seal(kp.publicKey, await order(wallets.B, Side.Sell, "100000000", "49900000"));

    const r1 = await engine.runBatch([buy, sell]);
    expect(r1.crossed).to.equal(true);

    // Relay maliciously resubmits BOTH already-settled orders → must not re-cross.
    const r2 = await engine.runBatch([buy, sell]);
    expect(r2.crossed).to.equal(false);
  });

  it("normalizes account casing so a trader's mixed-case orders net into one entry", async () => {
    const kp = await generateKeypair();
    const engine = makeEngine(kp);
    // Same wallet, two orders — one with the checksummed address, one lower-cased.
    const sealed = await Promise.all([
      seal(kp.publicKey, await order(wallets.A, Side.Buy, "50000000", "50100000", wallets.A.address)),
      seal(kp.publicKey, await order(wallets.A, Side.Buy, "50000000", "50100000", wallets.A.address.toLowerCase())),
      seal(kp.publicKey, await order(wallets.B, Side.Sell, "100000000", "49900000")),
    ]);
    const outcome = await engine.runBatch(sealed);
    expect(outcome.crossed).to.equal(true);
    // Both buys collapse to ONE on-chain account (lower-cased), so 2 accounts total.
    expect(outcome.signed!.settlement.accounts.length).to.equal(2);
    expect(outcome.signed!.settlement.accounts).to.contain(desks.A.toLowerCase());
  });
});
