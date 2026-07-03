import { describe, it, expect } from "vitest";
import { runAuction, type FtsoRef } from "../src/auction.js";
import { Side, type Order } from "@eclipse/shared";

const FTSO: FtsoRef = { value: 50_000_000n, decimals: 8 }; // XRP/USD = 0.5
const BAND = 50n; // ±0.5% → [49_750_000, 50_250_000]

let n = 0;
function order(side: Side, base: string, limit: string, account: string): Order {
  return {
    side,
    baseAmount: base,
    limitPrice: limit,
    account,
    nonce: String(++n),
    expiry: 9_999_999_999,
  };
}
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);

function conserves(deltas: { fxrpDelta: bigint; usdt0Delta: bigint }[]) {
  const f = deltas.reduce((s, d) => s + d.fxrpDelta, 0n);
  const u = deltas.reduce((s, d) => s + d.usdt0Delta, 0n);
  return f === 0n && u === 0n;
}

describe("runAuction", () => {
  it("crosses a simple two-sided batch at a uniform in-band price and conserves value", () => {
    const orders = [
      order(Side.Buy, "100000000", "50200000", A), // buy 100 FXRP @ 0.502
      order(Side.Sell, "100000000", "49800000", B), // sell 100 FXRP @ 0.498
    ];
    const r = runAuction(orders, FTSO, BAND);
    expect(r.crossed).to.equal(true);
    expect(r.matchedVolume).to.equal(100_000_000n);
    // Tie between 0.498 and 0.502 (equidistant from 0.5) → lower price wins.
    expect(r.clearingPrice).to.equal(49_800_000n);
    // USDT0 = 100 * 0.498 = 49.8 → 49_800_000 base units (6dp cancels via /1e8).
    const buyer = r.deltas.find((d) => d.account === A)!;
    expect(buyer.fxrpDelta).to.equal(100_000_000n);
    expect(buyer.usdt0Delta).to.equal(-49_800_000n);
    expect(conserves(r.deltas)).to.equal(true);
  });

  it("maximizes matched volume across many price levels", () => {
    const orders = [
      order(Side.Buy, "60000000", "50200000", A),
      order(Side.Buy, "40000000", "49900000", B),
      order(Side.Sell, "70000000", "49800000", C),
      order(Side.Sell, "30000000", "50100000", D),
    ];
    const r = runAuction(orders, FTSO, BAND);
    expect(r.crossed).to.equal(true);
    // Best cross is 100 vs ... at p=0.501: demand(>=.501)=60, supply(<=.501)=100 → 60;
    // at p=0.499: demand(>=.499)=100, supply(<=.499)=70 → 70; at .498 supply 70 demand 100→70.
    // Max crossed volume = 70 at price 0.499.
    expect(r.matchedVolume).to.equal(70_000_000n);
    expect(r.clearingPrice).to.equal(49_900_000n);
    expect(conserves(r.deltas)).to.equal(true);
  });

  it("keeps USDT0 exactly conserved even when per-account amounts round", () => {
    // Amounts chosen so pro-rata USDT0 does not divide evenly.
    const orders = [
      order(Side.Buy, "33333333", "50100000", A),
      order(Side.Buy, "33333333", "50100000", B),
      order(Side.Sell, "66666666", "49900000", C),
    ];
    const r = runAuction(orders, FTSO, BAND);
    expect(r.crossed).to.equal(true);
    expect(conserves(r.deltas)).to.equal(true);
    // Sum of buyers' FXRP received equals seller's FXRP given.
    const sellerFxrp = r.deltas.find((d) => d.account === C)!.fxrpDelta;
    expect(sellerFxrp).to.equal(-r.matchedVolume);
  });

  it("does not cross when the book does not overlap", () => {
    const orders = [
      order(Side.Buy, "100000000", "49800000", A), // willing to pay only 0.498
      order(Side.Sell, "100000000", "50200000", B), // wants at least 0.502
    ];
    const r = runAuction(orders, FTSO, BAND);
    expect(r.crossed).to.equal(false);
    expect(r.deltas).to.have.length(0);
  });

  it("excludes clearing prices outside the FTSO band (defense in depth)", () => {
    // A fat cross exists at 0.60, but that is outside the ±0.5% band, so the
    // engine refuses to clear there.
    const orders = [
      order(Side.Buy, "100000000", "60000000", A),
      order(Side.Sell, "100000000", "60000000", B),
    ];
    const r = runAuction(orders, FTSO, BAND);
    expect(r.crossed).to.equal(false);
  });
});
