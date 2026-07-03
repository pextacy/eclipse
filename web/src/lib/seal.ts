import sealedbox from "tweetnacl-sealedbox-js";
import { OrderSchema, type Order } from "@eclipse/shared";

/**
 * Client-side order sealing. Uses libsodium-compatible anonymous sealed boxes
 * (`crypto_box_seal`) via tweetnacl-sealedbox-js — the EXACT same scheme the
 * enclave uses to open orders (see tee/src/seal.ts). The relay only ever sees
 * the ciphertext and can never read the order.
 *
 * The browser has no Node `Buffer`, so base64 is done over the Uint8Array with
 * btoa/atob directly.
 */

export function b64encode(u: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < u.length; i += 1) {
    binary += String.fromCharCode(u[i]!);
  }
  return btoa(binary);
}

export function b64decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Seal a validated plaintext order to the engine's sealed-box public key. */
export function sealOrder(order: Order, enginePublicKeyB64: string): string {
  // Validate the shape locally before sealing so we never ship garbage.
  const clean = OrderSchema.parse(order);
  const pk = b64decode(enginePublicKeyB64);
  const message = new TextEncoder().encode(JSON.stringify(clean));
  return b64encode(sealedbox.seal(message, pk));
}
