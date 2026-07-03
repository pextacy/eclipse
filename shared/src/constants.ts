/**
 * Network + protocol constants shared across the Eclipse workspaces.
 *
 * The ONLY hardcoded Flare address permitted (CLAUDE.md §2.2) is the
 * `FlareContractRegistry`, which is the same on every Flare network and is the
 * root from which every other protocol address is resolved at runtime.
 */

export const COSTON2 = {
  chainId: 114,
  name: "coston2",
  rpc: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
} as const;

/** Same on all Flare networks. Everything else is resolved through it. */
export const FLARE_CONTRACT_REGISTRY =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

/**
 * FTSOv2 XRP/USD feed id. Category `01` (crypto) + "XRP/USD" hex, zero-padded
 * to 21 bytes. See docs.md appendix for the derivation.
 */
export const XRP_USD_FEED_ID =
  "0x015852502f55534400000000000000000000000000" as const;

/** Default fairness band: ±0.5% of the FTSO XRP/USD value. */
export const DEFAULT_BAND_BPS = 50;

/** Default discrete batch interval. */
export const DEFAULT_BATCH_INTERVAL_SECONDS = 30;

/** EIP-712 domain used by the engine signer and verified on-chain. */
export const EIP712_DOMAIN_NAME = "Eclipse";
export const EIP712_DOMAIN_VERSION = "1";
