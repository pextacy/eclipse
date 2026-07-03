import { Side, type Order } from "@eclipse/shared";

/** Live FTSO XRP/USD reference used to clamp the clearing price into the band. */
export interface FtsoRef {
  value: bigint; // XRP/USD * 10^decimals
  decimals: number;
}

export interface AccountDelta {
  account: string;
  fxrpDelta: bigint; // + receives FXRP, - pays FXRP
  usdt0Delta: bigint; // + receives USDT0, - pays USDT0
}

export interface AuctionResult {
  crossed: boolean;
  clearingPrice: bigint; // FTSO scale; 0 if no cross
  matchedVolume: bigint; // FXRP base units matched on each side
  deltas: AccountDelta[]; // per-account NET deltas (only these leave the enclave)
}

interface Norm {
  account: string;
  base: bigint;
  limit: bigint;
  nonce: bigint;
}

/** Absolute distance between two bigints. */
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function withinBand(price: bigint, ref: bigint, bandBps: bigint): boolean {
  if (ref === 0n) return false;
  return absDiff(price, ref) * 10_000n <= bandBps * ref;
}

/**
 * Classic uniform-price call auction with an FTSO fairness clamp.
 *
 * 1. Candidate clearing prices are every distinct limit price that ALSO sits
 *    inside the FTSO band (defense in depth — the contract re-checks the band).
 * 2. Pick the price maximizing crossed volume `min(demand, supply)`.
 * 3. Tie-break deterministically: closest to the FTSO reference, then lower price.
 * 4. Allocate fills by price priority (buys: highest limit first; sells: lowest
 *    first), then compute exact-conserving NET per-account deltas — the last
 *    filled account on each side absorbs any USDT0 rounding remainder so both
 *    sides move exactly the same total USDT0.
 *
 * Only NET deltas are returned; individual fills and the book never leave here.
 */
export function runAuction(
  orders: Order[],
  ftso: FtsoRef,
  bandBps: bigint,
): AuctionResult {
  const scale = 10n ** BigInt(ftso.decimals);
  const buys: Norm[] = [];
  const sells: Norm[] = [];
  for (const o of orders) {
    const n: Norm = {
      account: o.account,
      base: BigInt(o.baseAmount),
      limit: BigInt(o.limitPrice),
      nonce: BigInt(o.nonce),
    };
    if (n.base <= 0n) continue;
    (o.side === Side.Buy ? buys : sells).push(n);
  }

  const empty: AuctionResult = { crossed: false, clearingPrice: 0n, matchedVolume: 0n, deltas: [] };
  if (buys.length === 0 || sells.length === 0) return empty;

  // Candidate prices: distinct limits inside the band.
  const candidates = [...new Set([...buys, ...sells].map((o) => o.limit))]
    .filter((p) => withinBand(p, ftso.value, bandBps))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (candidates.length === 0) return empty;

  const demandAt = (p: bigint) => buys.filter((b) => b.limit >= p).reduce((s, b) => s + b.base, 0n);
  const supplyAt = (p: bigint) => sells.filter((a) => a.limit <= p).reduce((s, a) => s + a.base, 0n);

  let best: { price: bigint; volume: bigint } | null = null;
  for (const p of candidates) {
    const vol = demandAt(p) < supplyAt(p) ? demandAt(p) : supplyAt(p);
    if (vol <= 0n) continue;
    if (
      best === null ||
      vol > best.volume ||
      (vol === best.volume && absDiff(p, ftso.value) < absDiff(best.price, ftso.value)) ||
      (vol === best.volume &&
        absDiff(p, ftso.value) === absDiff(best.price, ftso.value) &&
        p < best.price)
    ) {
      best = { price: p, volume: vol };
    }
  }
  if (best === null) return empty;

  const price = best.price;
  const volume = best.volume;

  // Priority: most aggressive first, deterministic tie-break by nonce.
  const eligibleBuys = buys
    .filter((b) => b.limit >= price)
    .sort((a, b) => (b.limit === a.limit ? cmp(a.nonce, b.nonce) : cmp(b.limit, a.limit)));
  const eligibleSells = sells
    .filter((a) => a.limit <= price)
    .sort((a, b) => (a.limit === b.limit ? cmp(a.nonce, b.nonce) : cmp(a.limit, b.limit)));

  const buyFills = allocate(eligibleBuys, volume);
  const sellFills = allocate(eligibleSells, volume);

  // Total USDT0 that changes hands (single division keeps both sides equal).
  const totalUsdt0 = (volume * price) / scale;

  const deltas = new Map<string, AccountDelta>();
  const add = (account: string, fxrp: bigint, usdt0: bigint) => {
    const d = deltas.get(account) ?? { account, fxrpDelta: 0n, usdt0Delta: 0n };
    d.fxrpDelta += fxrp;
    d.usdt0Delta += usdt0;
    deltas.set(account, d);
  };

  distribute(buyFills, volume, totalUsdt0, (account, base, usdt0) => add(account, base, -usdt0));
  distribute(sellFills, volume, totalUsdt0, (account, base, usdt0) => add(account, -base, usdt0));

  return {
    crossed: true,
    clearingPrice: price,
    matchedVolume: volume,
    deltas: [...deltas.values()].filter((d) => d.fxrpDelta !== 0n || d.usdt0Delta !== 0n),
  };
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Allocate `volume` base units across `orders` in priority order. */
function allocate(orders: Norm[], volume: bigint): Array<{ account: string; base: bigint }> {
  const fills: Array<{ account: string; base: bigint }> = [];
  let remaining = volume;
  for (const o of orders) {
    if (remaining <= 0n) break;
    const take = o.base < remaining ? o.base : remaining;
    fills.push({ account: o.account, base: take });
    remaining -= take;
  }
  return fills;
}

/**
 * Distribute `totalUsdt0` across fills proportional to filled base, giving the
 * last fill the rounding remainder so the side sums to EXACTLY `totalUsdt0`.
 */
function distribute(
  fills: Array<{ account: string; base: bigint }>,
  volume: bigint,
  totalUsdt0: bigint,
  emit: (account: string, base: bigint, usdt0: bigint) => void,
): void {
  let assigned = 0n;
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i]!;
    const isLast = i === fills.length - 1;
    const usdt0 = isLast ? totalUsdt0 - assigned : (totalUsdt0 * f.base) / volume;
    assigned += usdt0;
    emit(f.account, f.base, usdt0);
  }
}
