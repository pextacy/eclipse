/**
 * Self-contained sandwich-attack simulation for the Comparison View.
 *
 * Pure math, NO chain access. Models a constant-product AMM (x*y=k) where a
 * victim submits a large public buy. Because the buy is visible in the mempool,
 * an attacker front-runs (buys first, pushing the price up), lets the victim
 * fill at the worse price, then back-runs (sells into the victim's impact) to
 * extract the difference.
 *
 * Convention: pool holds FXRP (base) and USD-stable (quote). Price = quote/base.
 * A "buy" spends `quote` to receive `base` (FXRP).
 */

export interface PoolState {
  /** FXRP reserve (base). */
  baseReserve: number;
  /** USD-stable reserve (quote). */
  quoteReserve: number;
}

/** Amount of base out for a given quote in, on a constant-product pool. */
function baseOutForQuoteIn(pool: PoolState, quoteIn: number): number {
  const k = pool.baseReserve * pool.quoteReserve;
  const newQuote = pool.quoteReserve + quoteIn;
  const newBase = k / newQuote;
  return pool.baseReserve - newBase;
}

/** Amount of quote out for a given base in (a sell). */
function quoteOutForBaseIn(pool: PoolState, baseIn: number): number {
  const k = pool.baseReserve * pool.quoteReserve;
  const newBase = pool.baseReserve + baseIn;
  const newQuote = k / newBase;
  return pool.quoteReserve - newQuote;
}

function applyBuy(pool: PoolState, quoteIn: number): { pool: PoolState; baseOut: number } {
  const baseOut = baseOutForQuoteIn(pool, quoteIn);
  return {
    pool: {
      baseReserve: pool.baseReserve - baseOut,
      quoteReserve: pool.quoteReserve + quoteIn,
    },
    baseOut,
  };
}

function applySell(pool: PoolState, baseIn: number): { pool: PoolState; quoteOut: number } {
  const quoteOut = quoteOutForBaseIn(pool, baseIn);
  return {
    pool: {
      baseReserve: pool.baseReserve + baseIn,
      quoteReserve: pool.quoteReserve - quoteOut,
    },
    quoteOut,
  };
}

export function spotPrice(pool: PoolState): number {
  return pool.quoteReserve / pool.baseReserve;
}

export interface SandwichResult {
  midPrice: number;
  /** FXRP the victim receives with NO attacker (fair public fill). */
  fairBaseOut: number;
  /** FXRP the victim actually receives after being sandwiched. */
  sandwichedBaseOut: number;
  /** Effective price the victim paid (USD/FXRP) when sandwiched. */
  victimEffectivePrice: number;
  /** FXRP the victim lost to the attacker. */
  fxrpLost: number;
  /** USD value of the extracted loss (attacker profit at mid). */
  usdLost: number;
  /** Attacker's gross profit in USD. */
  attackerProfitUsd: number;
  /** % slippage the victim suffered vs the fair fill. */
  victimSlippagePct: number;
  /** Attacker's front-run size in USD (quote). */
  attackerQuoteIn: number;
}

/**
 * Simulate the sandwich. `attackerAggression` in [0,1] scales the attacker's
 * front-run relative to the victim's order (a rational attacker sizes it to the
 * victim's impact; 1.0 ≈ matching the victim's notional).
 */
export function simulateSandwich(
  pool: PoolState,
  victimQuoteIn: number,
  attackerAggression = 1,
): SandwichResult {
  const mid = spotPrice(pool);

  // Baseline: victim alone against the honest pool.
  const fair = applyBuy(pool, victimQuoteIn);
  const fairBaseOut = fair.baseOut;

  // Attacker front-runs with a fraction of the victim's notional.
  const attackerQuoteIn = victimQuoteIn * clamp(attackerAggression, 0, 1);
  const front = applyBuy(pool, attackerQuoteIn);
  const attackerBaseHeld = front.baseOut;

  // Victim now fills against the pushed-up pool → gets less FXRP.
  const victim = applyBuy(front.pool, victimQuoteIn);
  const sandwichedBaseOut = victim.baseOut;

  // Attacker back-runs, dumping the base they bought into the victim's impact.
  const back = applySell(victim.pool, attackerBaseHeld);
  const attackerQuoteOut = back.quoteOut;
  const attackerProfitUsd = attackerQuoteOut - attackerQuoteIn;

  const fxrpLost = Math.max(0, fairBaseOut - sandwichedBaseOut);
  const victimEffectivePrice = sandwichedBaseOut > 0 ? victimQuoteIn / sandwichedBaseOut : 0;
  const usdLost = fxrpLost * mid;
  const victimSlippagePct = fairBaseOut > 0 ? (fxrpLost / fairBaseOut) * 100 : 0;

  return {
    midPrice: mid,
    fairBaseOut,
    sandwichedBaseOut,
    victimEffectivePrice,
    fxrpLost,
    usdLost,
    attackerProfitUsd: Math.max(0, attackerProfitUsd),
    victimSlippagePct,
    attackerQuoteIn,
  };
}

/**
 * Eclipse outcome for the SAME order. Nothing hits the mempool; the batch
 * clears at the uniform FTSO-fair price (the honest mid), so the victim gets
 * exactly `victimQuoteIn / mid` FXRP with zero leakage and zero extraction.
 */
export interface EclipseResult {
  uniformPrice: number;
  baseOut: number;
  leaked: number;
  extracted: number;
}

export function simulateEclipse(pool: PoolState, victimQuoteIn: number): EclipseResult {
  const mid = spotPrice(pool);
  return {
    uniformPrice: mid,
    baseOut: victimQuoteIn / mid,
    leaked: 0,
    extracted: 0,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
