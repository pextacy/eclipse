import { z } from "zod";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "./constants.js";

/** A limit order side. */
export enum Side {
  Buy = 0,
  Sell = 1,
}

/**
 * The plaintext order that lives ONLY inside the trader's client and the TEE.
 * It is sealed to the engine's public key before it ever touches the relay.
 *
 * Amounts are strings to preserve full uint256/bigint precision across JSON.
 * - `baseAmount`  : FXRP base units (the asset being traded).
 * - `limitPrice`  : XRP/USD expressed in FTSO scale (value * 10^decimals).
 */
export const OrderSchema = z.object({
  side: z.nativeEnum(Side),
  baseAmount: z.string().regex(/^\d+$/, "baseAmount must be a base-unit integer"),
  limitPrice: z.string().regex(/^\d+$/, "limitPrice must be an FTSO-scaled integer"),
  account: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "account must be a 20-byte address"),
  nonce: z.string().regex(/^\d+$/),
  expiry: z.number().int().positive(),
  /**
   * EIP-712 signature by `account` over the order fields. The engine REQUIRES it
   * and rejects any order whose signature doesn't recover to `account`, so nobody
   * can submit an order (and force a trade) on another trader's escrow. Optional
   * in the type only so non-engine code (the auction) needn't carry it.
   */
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
});

export type Order = z.infer<typeof OrderSchema>;

/**
 * EIP-712 type for a trader's order signature. Verified off-chain by the engine
 * (never on-chain), so it binds an order to the account that authorized it.
 */
export const EIP712_ORDER_TYPES = {
  Order: [
    { name: "side", type: "uint8" },
    { name: "baseAmount", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "account", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/** EIP-712 domain for order signatures (same domain family as settlement). */
export function orderEip712Domain(chainId: number, verifyingContract: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

/** Value object an EIP-712 signer signs for an Order. */
export function orderSigningValue(o: Order) {
  return {
    side: o.side,
    baseAmount: BigInt(o.baseAmount),
    limitPrice: BigInt(o.limitPrice),
    account: o.account,
    nonce: BigInt(o.nonce),
    expiry: BigInt(o.expiry),
  };
}

/**
 * The sealed envelope the relay handles. The relay validates ONLY this shape —
 * it can never read `ciphertext` (sealed to the engine's public key).
 */
export const SealedOrderSchema = z.object({
  /**
   * libsodium sealed box, base64. Opaque to the relay. Bounded so a flood of
   * valid-but-oversized envelopes can't exhaust relay/engine memory: a sealed
   * Order (with signature) is a few hundred base64 chars, so 2 KB is generous
   * headroom while still capping per-order retained bytes.
   */
  ciphertext: z.string().min(1).max(2048),
  /** Which engine public key this was sealed to (base64 32-byte key ≈ 44 chars). */
  enginePublicKey: z.string().min(1).max(128),
  /** Client-chosen submission id for correlation; carries no order content. */
  submissionId: z.string().uuid(),
});

export type SealedOrder = z.infer<typeof SealedOrderSchema>;
