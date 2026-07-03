import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { COSTON2 } from "@eclipse/shared";

/** Read a required env var or throw a clear error. */
export function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

export function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export function provider(): JsonRpcProvider {
  const rpc = optional("COSTON2_RPC", COSTON2.rpc);
  // staticNetwork avoids an extra eth_chainId round-trip per call on Coston2.
  return new JsonRpcProvider(rpc, COSTON2.chainId, { staticNetwork: true });
}

export function wallet(pkEnv = "DEPLOYER_PRIVATE_KEY"): Wallet {
  return new Wallet(required(pkEnv), provider());
}

export function explorerTx(hash: string): string {
  return `${COSTON2.explorer}/tx/${hash}`;
}

export function explorerAddress(addr: string): string {
  return `${COSTON2.explorer}/address/${addr}`;
}
