import { z } from "zod";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
} from "./constants.js";

/**
 * Net-only settlement result the engine produces and signs.
 *
 * Only NET per-account deltas leave the enclave — never individual fills or the
 * book. `fxrpDeltas[i]` / `usdt0Deltas[i]` are the signed net change for
 * `accounts[i]`: positive = the account receives, negative = the account pays.
 * Each token array MUST net to zero across the batch (conservation).
 *
 * `clearingPrice` and `ftsoRef` are XRP/USD in FTSO scale (value * 10^decimals).
 * The contract re-reads FTSO in the same tx and enforces the fairness band.
 */
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

/**
 * The engine locks the batch's participants on-chain (so their backing escrow
 * cannot be withdrawn mid-batch) before it settles. Only the participant set is
 * revealed — never sides, amounts, prices, or fills.
 */
export interface BatchCommit {
  batchId: bigint;
  accounts: string[];
  expiry: bigint;
  nonce: bigint;
}

/**
 * EIP-712 type definitions — MUST match the typehashes in EclipseSettlement.sol.
 * Each primary type is exported on its own so an ethers signer can be given an
 * unambiguous single-type `types` object (a combined object would make the
 * primary type ambiguous).
 */
export const EIP712_SETTLEMENT_TYPES = {
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

export const EIP712_COMMIT_TYPES = {
  BatchCommit: [
    { name: "batchId", type: "uint256" },
    { name: "accounts", type: "address[]" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function eip712Domain(chainId: number, verifyingContract: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

/** Value object passed to an EIP-712 signer for a Settlement (stringified bigints). */
export function settlementSigningValue(s: Settlement) {
  return {
    batchId: s.batchId,
    accounts: s.accounts,
    fxrpDeltas: s.fxrpDeltas,
    usdt0Deltas: s.usdt0Deltas,
    clearingPrice: s.clearingPrice,
    ftsoRef: s.ftsoRef,
    expiry: s.expiry,
    nonce: s.nonce,
  };
}

export function batchCommitSigningValue(c: BatchCommit) {
  return {
    batchId: c.batchId,
    accounts: c.accounts,
    expiry: c.expiry,
    nonce: c.nonce,
  };
}

/** Zod schema for the signed settlement bundle the relay forwards on-chain. */
export const SignedSettlementSchema = z.object({
  settlement: z.object({
    batchId: z.string().regex(/^\d+$/),
    accounts: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    fxrpDeltas: z.array(z.string().regex(/^-?\d+$/)),
    usdt0Deltas: z.array(z.string().regex(/^-?\d+$/)),
    clearingPrice: z.string().regex(/^\d+$/),
    ftsoRef: z.string().regex(/^\d+$/),
    expiry: z.string().regex(/^\d+$/),
    nonce: z.string().regex(/^\d+$/),
  }),
  commit: z.object({
    batchId: z.string().regex(/^\d+$/),
    accounts: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    expiry: z.string().regex(/^\d+$/),
    nonce: z.string().regex(/^\d+$/),
  }),
  settlementSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  commitSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export type SignedSettlement = z.infer<typeof SignedSettlementSchema>;
