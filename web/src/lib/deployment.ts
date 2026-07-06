import { getAddress, isAddress, type Address } from "viem";
import { XRP_USD_FEED_ID, DEFAULT_BAND_BPS } from "@eclipse/shared";
import example from "./deployment.example.json";
import { getSettings } from "./settings";

/**
 * Deployment resolution.
 *
 * The deploy script writes `deployments/coston2.json` at the repo root. That
 * file lives OUTSIDE the web workspace and may not exist at build time, so we
 * never hard-import it (that would break `next build`). Instead:
 *
 *   1. Start from the committed `deployment.example.json` (all-zero addresses).
 *   2. Override with `NEXT_PUBLIC_*` env vars when provided (the deploy script /
 *      CI exports these, or the operator copies the JSON values into `.env.local`).
 *
 * `isConfigured` is true only when the settlement address is a real (non-zero)
 * address, so views can render a clean "not configured" empty state otherwise.
 */

export interface Deployment {
  network: string;
  chainId: number;
  eclipseRegistry: Address;
  eclipseSettlement: Address;
  fxrp: Address;
  usdt0: Address;
  bandBps: number;
  feedId: `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function pick(envVal: string | undefined, fallback: string): Address {
  const raw = envVal && envVal.trim().length > 0 ? envVal.trim() : fallback;
  return isAddress(raw) ? getAddress(raw) : (ZERO as Address);
}

export const deployment: Deployment = {
  network: example.network,
  chainId: example.chainId,
  eclipseRegistry: pick(process.env.NEXT_PUBLIC_ECLIPSE_REGISTRY, example.eclipseRegistry),
  eclipseSettlement: pick(process.env.NEXT_PUBLIC_ECLIPSE_SETTLEMENT, example.eclipseSettlement),
  fxrp: pick(process.env.NEXT_PUBLIC_FXRP, example.fxrp),
  usdt0: pick(process.env.NEXT_PUBLIC_USDT0, example.usdt0),
  bandBps: typeof example.bandBps === "number" ? example.bandBps : DEFAULT_BAND_BPS,
  feedId: (example.feedId as `0x${string}`) || XRP_USD_FEED_ID,
};

/** True when a real settlement contract is wired up. */
export const isConfigured: boolean = deployment.eclipseSettlement !== ZERO;

export function relayUrl(): string {
  // Runtime user override (Settings) wins, then env, then the local default.
  const override = getSettings().relayUrl.trim();
  if (override) return override;
  return process.env.NEXT_PUBLIC_RELAY_URL?.trim() || "http://localhost:8787";
}
