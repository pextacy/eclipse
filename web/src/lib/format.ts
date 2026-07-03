import { COSTON2 } from "@eclipse/shared";

/** Coston2 explorer helpers. Every on-chain reference links here. */
export function explorerTx(hash: string): string {
  return `${COSTON2.explorer}/tx/${hash}`;
}

export function explorerAddress(addr: string): string {
  return `${COSTON2.explorer}/address/${addr}`;
}

/** 0x1234…abcd truncation for addresses / hashes. */
export function truncateHex(value: string, lead = 6, tail = 4): string {
  if (!value || value.length <= lead + tail + 2) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

const ZERO = "0x0000000000000000000000000000000000000000";
export function isZeroHex(value: string | undefined | null): boolean {
  if (!value) return true;
  return /^0x0+$/.test(value);
}
export { ZERO };

/** Format a bigint token amount (base units) to a human decimal string. */
export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0");
  if (maxFrac < decimals) fracStr = fracStr.slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, "");
  const wholeStr = groupThousands(whole.toString());
  const body = fracStr.length > 0 ? `${wholeStr}.${fracStr}` : wholeStr;
  return neg ? `-${body}` : body;
}

/** Parse a decimal string into base units (bigint). Throws on invalid input. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("invalid amount");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format a plain JS number with fixed decimals and thousands grouping. */
export function fmtNum(n: number, frac = 2): string {
  if (!Number.isFinite(n)) return "—";
  const fixed = n.toFixed(frac);
  const [whole = "0", f] = fixed.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const grouped = groupThousands(whole.replace("-", ""));
  return f ? `${sign}${grouped}.${f}` : `${sign}${grouped}`;
}

export function fmtUsd(n: number, frac = 2): string {
  return `$${fmtNum(n, frac)}`;
}

/**
 * FTSO price value (value * 10^decimals) → human number. Defaults to 6, the
 * decimals of the Coston2 XRP/USD feed (getFeedById returns 6). Using the wrong
 * scale would misprint the clearing price by a power of ten.
 */
export function ftsoToNumber(value: bigint, decimals = 6): number {
  return Number(value) / 10 ** decimals;
}
