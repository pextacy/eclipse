import { z } from "zod";

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
    .regex(/^0x[0-9a-fA-F]{40}$/, "account must be a checksummed 20-byte address"),
  nonce: z.string().regex(/^\d+$/),
  expiry: z.number().int().positive(),
});

export type Order = z.infer<typeof OrderSchema>;

/**
 * The sealed envelope the relay handles. The relay validates ONLY this shape —
 * it can never read `ciphertext` (sealed to the engine's public key).
 */
export const SealedOrderSchema = z.object({
  /** libsodium sealed box, base64. Opaque to the relay. */
  ciphertext: z.string().min(1),
  /** Which engine public key this was sealed to (base64), for key rotation. */
  enginePublicKey: z.string().min(1),
  /** Client-chosen submission id for correlation; carries no order content. */
  submissionId: z.string().uuid(),
});

export type SealedOrder = z.infer<typeof SealedOrderSchema>;
