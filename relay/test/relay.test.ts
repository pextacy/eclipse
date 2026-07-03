import { describe, it, expect } from "vitest";
import { Relay } from "../src/relay.js";
import { Logger } from "../src/logger.js";
import type { IEngineClient, BatchResponse } from "../src/engineClient.js";
import type { SealedOrder, SignedSettlement } from "@eclipse/shared";

// Plaintext markers that must NEVER appear in relay logs.
const SECRET_ACCOUNT = "0xSECRETdeadbeefSECRETdeadbeefSECRETdead01";
const SECRET_AMOUNT = "1337424242";

/** An opaque sealed envelope. We stuff recognizable plaintext into the ciphertext
 * blob to prove the relay never decodes or logs it. */
function envelope(): SealedOrder {
  const fakePlaintext = JSON.stringify({ account: SECRET_ACCOUNT, baseAmount: SECRET_AMOUNT });
  return {
    ciphertext: Buffer.from(fakePlaintext).toString("base64"),
    enginePublicKey: Buffer.from("engine-pubkey").toString("base64"),
    submissionId: crypto.randomUUID(),
  };
}

class StubEngine implements IEngineClient {
  constructor(private readonly response: BatchResponse) {}
  async pubkey() {
    return { publicKey: "pk", signerAddress: "0x" + "e".repeat(40) };
  }
  async runBatch(): Promise<BatchResponse> {
    return this.response;
  }
}

function cannedSettlement(): SignedSettlement {
  const accounts = ["0x" + "a".repeat(40), "0x" + "b".repeat(40)];
  return {
    settlement: {
      batchId: "1",
      accounts,
      fxrpDeltas: ["100000000", "-100000000"],
      usdt0Deltas: ["-49800000", "49800000"],
      clearingPrice: "49800000",
      ftsoRef: "50000000",
      expiry: "9999999999",
      nonce: "1",
    },
    commit: { batchId: "1", accounts, expiry: "9999999999", nonce: "1" },
    settlementSignature: "0x" + "ab".repeat(65),
    commitSignature: "0x" + "cd".repeat(65),
  };
}

describe("Relay (untrusted)", () => {
  it("rejects malformed envelopes", () => {
    const relay = new Relay({ engine: new StubEngine({ crossed: false, batchId: "0", signed: null }) });
    expect(() => relay.submit({ ciphertext: "" })).toThrow(); // missing fields / empty
    expect(() => relay.submit({ foo: "bar" })).toThrow();
    expect(relay.pool.size()).to.equal(0);
  });

  it("accepts a valid envelope and NEVER logs order plaintext", async () => {
    const logger = new Logger(false);
    const relay = new Relay({
      engine: new StubEngine({ crossed: true, batchId: "1", signed: cannedSettlement() }),
      logger,
    });

    relay.submit(envelope());
    relay.submit(envelope());
    expect(relay.pool.size()).to.equal(2);

    const result = await relay.closeBatch();
    expect(result.crossed).to.equal(true);
    expect(result.orderCount).to.equal(2);
    expect(result.signed?.settlement.clearingPrice).to.equal("49800000");

    // Grep the logs: no plaintext order field, and not even the raw ciphertext.
    const logs = logger.dump();
    expect(logs).not.to.contain(SECRET_ACCOUNT);
    expect(logs).not.to.contain(SECRET_AMOUNT);
    expect(logs).not.to.contain(Buffer.from(SECRET_ACCOUNT).toString("base64").slice(0, 12));
  });

  it("does not settle when the batch does not cross", async () => {
    const relay = new Relay({ engine: new StubEngine({ crossed: false, batchId: "2", signed: null }) });
    relay.submit(envelope());
    const result = await relay.closeBatch();
    expect(result.crossed).to.equal(false);
    expect(result.signed).to.equal(null);
  });

  it("closing an empty batch is a no-op", async () => {
    const relay = new Relay({ engine: new StubEngine({ crossed: false, batchId: "0", signed: null }) });
    const result = await relay.closeBatch();
    expect(result.orderCount).to.equal(0);
    expect(result.crossed).to.equal(false);
  });
});
