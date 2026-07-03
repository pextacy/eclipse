import { ethers } from "hardhat";
import type { Signer, TypedDataDomain } from "ethers";

/** XRP/USD feed id (category 01 crypto). Mirrors shared/constants. */
export const XRP_USD_FEED_ID =
  "0x015852502f55534400000000000000000000000000";

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "batchId", type: "uint256" },
    { name: "accounts", type: "address[]" },
    { name: "fxrpDeltas", type: "int256[]" },
    { name: "usdt0Deltas", type: "int256[]" },
    { name: "clearingPrice", type: "uint256" },
    { name: "ftsoRef", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const COMMIT_TYPES = {
  BatchCommit: [
    { name: "batchId", type: "uint256" },
    { name: "accounts", type: "address[]" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface Settlement {
  batchId: bigint;
  accounts: string[];
  fxrpDeltas: bigint[];
  usdt0Deltas: bigint[];
  clearingPrice: bigint;
  ftsoRef: bigint;
  expiry: bigint;
  nonce: bigint;
}

export interface BatchCommit {
  batchId: bigint;
  accounts: string[];
  expiry: bigint;
  nonce: bigint;
}

export function domain(
  chainId: number,
  verifyingContract: string,
): TypedDataDomain {
  return { name: "Eclipse", version: "1", chainId, verifyingContract };
}

export async function signSettlement(
  signer: Signer,
  dom: TypedDataDomain,
  s: Settlement,
): Promise<string> {
  return signer.signTypedData(dom, SETTLEMENT_TYPES as unknown as Record<string, any>, s);
}

export async function signCommit(
  signer: Signer,
  dom: TypedDataDomain,
  c: BatchCommit,
): Promise<string> {
  return signer.signTypedData(dom, COMMIT_TYPES as unknown as Record<string, any>, c);
}

/** A far-future expiry relative to the latest block. */
export async function futureExpiry(secondsAhead = 3600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt((block?.timestamp ?? 0) + secondsAhead);
}
