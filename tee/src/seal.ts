import nacl from "tweetnacl";
import sealedbox from "tweetnacl-sealedbox-js";
import { OrderSchema, type Order } from "@eclipse/shared";

/**
 * Sealed-order transport. Uses libsodium-compatible anonymous sealed boxes
 * (`crypto_box_seal`) via tweetnacl, so the exact same scheme works in the
 * browser (trader client) and in Node (the enclave). The relay only ever holds
 * the ciphertext and can never open it.
 */
export interface SealedKeypair {
  publicKey: string; // base64
  secretKey: string; // base64
}

function b64encode(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}
function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Generate the engine's sealed-box keypair. The secret key never leaves the enclave. */
export async function generateKeypair(): Promise<SealedKeypair> {
  const kp = nacl.box.keyPair();
  return { publicKey: b64encode(kp.publicKey), secretKey: b64encode(kp.secretKey) };
}

/** Seal a plaintext order to the engine's public key (anonymous sealed box). */
export async function sealOrder(order: Order, enginePublicKeyB64: string): Promise<string> {
  const pk = b64decode(enginePublicKeyB64);
  const message = new TextEncoder().encode(JSON.stringify(order));
  return b64encode(sealedbox.seal(message, pk));
}

/** Open a sealed order inside the enclave and validate its shape. */
export async function openOrder(
  ciphertextB64: string,
  keypair: SealedKeypair,
): Promise<Order> {
  const opened = sealedbox.open(
    b64decode(ciphertextB64),
    b64decode(keypair.publicKey),
    b64decode(keypair.secretKey),
  );
  if (!opened) throw new Error("failed to open sealed box");
  const parsed = JSON.parse(new TextDecoder().decode(opened));
  return OrderSchema.parse(parsed);
}
