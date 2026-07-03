import { describe, it, expect } from "vitest";
import { generateKeypair, sealOrder, openOrder } from "../src/seal.js";
import { Side, type Order } from "@eclipse/shared";

const sampleOrder: Order = {
  side: Side.Buy,
  baseAmount: "100000000",
  limitPrice: "50100000",
  account: "0x" + "1".repeat(40),
  nonce: "1",
  expiry: 9_999_999_999,
};

describe("sealed orders", () => {
  it("round-trips a sealed order through the engine keypair", async () => {
    const kp = await generateKeypair();
    const ciphertext = await sealOrder(sampleOrder, kp.publicKey);
    expect(ciphertext).to.be.a("string");
    const opened = await openOrder(ciphertext, kp);
    expect(opened).to.deep.equal(sampleOrder);
  });

  it("cannot be opened with a different keypair", async () => {
    const engine = await generateKeypair();
    const attacker = await generateKeypair();
    const ciphertext = await sealOrder(sampleOrder, engine.publicKey);
    await expect(openOrder(ciphertext, attacker)).rejects.toThrow();
  });
});
