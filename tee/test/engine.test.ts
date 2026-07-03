import { describe, it, expect } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import {
  Side,
  type Order,
  eip712Domain,
  EIP712_SETTLEMENT_TYPES,
  EIP712_COMMIT_TYPES,
} from "@eclipse/shared";
import { MatchingEngine } from "../src/engine.js";
import { StaticFtsoReader } from "../src/ftso.js";
import { generateKeypair, sealOrder } from "../src/seal.js";
import type { SealedOrder } from "@eclipse/shared";

const CHAIN_ID = 114;
const SETTLEMENT = "0x" + "e".repeat(40);
const FTSO = { value: 50_000_000n, decimals: 8 };

const desks = {
  A: "0x" + "a".repeat(40),
  B: "0x" + "b".repeat(40),
  C: "0x" + "c".repeat(40),
  D: "0x" + "d".repeat(40),
};

let nonce = 0;
function order(side: Side, base: string, limit: string, account: string): Order {
  return { side, baseAmount: base, limitPrice: limit, account, nonce: String(++nonce), expiry: 9_999_999_999 };
}

async function seal(engineKeyPub: string, o: Order): Promise<SealedOrder> {
  return {
    ciphertext: await sealOrder(o, engineKeyPub),
    enginePublicKey: engineKeyPub,
    submissionId: crypto.randomUUID(),
  };
}

describe("MatchingEngine end-to-end", () => {
  it("turns 4 sealed orders into one signed, verifiable, conserving settlement", async () => {
    const kp = await generateKeypair();
    const signerKey = Wallet.createRandom().privateKey;
    const engine = new MatchingEngine(kp, signerKey, new StaticFtsoReader(FTSO), {
      chainId: CHAIN_ID,
      settlementAddress: SETTLEMENT,
      bandBps: 50n,
      batchTtlSeconds: 300,
      now: () => 1_000,
    });

    const orders = [
      order(Side.Buy, "60000000", "50200000", desks.A),
      order(Side.Buy, "40000000", "50000000", desks.B),
      order(Side.Sell, "70000000", "49800000", desks.C),
      order(Side.Sell, "30000000", "50100000", desks.D),
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
      EIP712_SETTLEMENT_TYPES as any,
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
      EIP712_COMMIT_TYPES as any,
      commitVal,
      signed.commitSignature,
    );
    expect(recoveredCommit).to.equal(engine.signerAddress);
  });

  it("returns crossed:false when nothing matches in-band, leaking nothing", async () => {
    const kp = await generateKeypair();
    const engine = new MatchingEngine(kp, Wallet.createRandom().privateKey, new StaticFtsoReader(FTSO), {
      chainId: CHAIN_ID, settlementAddress: SETTLEMENT, bandBps: 50n, batchTtlSeconds: 300, now: () => 1_000,
    });
    const sealed = await Promise.all([
      seal(kp.publicKey, order(Side.Buy, "100000000", "49800000", desks.A)),
      seal(kp.publicKey, order(Side.Sell, "100000000", "50200000", desks.B)),
    ]);
    const outcome = await engine.runBatch(sealed);
    expect(outcome.crossed).to.equal(false);
    expect(outcome.signed).to.equal(undefined);
  });
});
