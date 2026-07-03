import {
  Contract,
  type ContractRunner,
  type ContractTransactionResponse,
  type InterfaceAbi,
} from "ethers";

/**
 * Typed facades over ethers Contract instances. ethers' dynamic method proxy is
 * typed via an index signature, which under `noUncheckedIndexedAccess` surfaces
 * as `T | undefined`; these interfaces give us fully-typed calls with no `any`
 * (CLAUDE.md §6).
 */
export interface Erc20 {
  approve(spender: string, amount: bigint): Promise<ContractTransactionResponse>;
  transfer(to: string, amount: bigint): Promise<ContractTransactionResponse>;
  balanceOf(account: string): Promise<bigint>;
  decimals(): Promise<bigint>;
  symbol(): Promise<string>;
  name(): Promise<string>;
}

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

export function erc20(address: string, runner: ContractRunner): Erc20 {
  return new Contract(address, ERC20_ABI, runner) as unknown as Erc20;
}

export interface RegistryContract {
  getContractAddressByName(name: string): Promise<string>;
  getAssetManagers(): Promise<string[]>;
}

export interface AssetManagerContract {
  fAsset(): Promise<string>;
}

export interface EclipseRegistryContract {
  registerCodeHash(codeHash: string, signer: string): Promise<ContractTransactionResponse>;
  revokeCodeHash(codeHash: string): Promise<ContractTransactionResponse>;
  isAuthorized(signer: string): Promise<boolean>;
}

export interface SettlementDepositContract {
  deposit(token: string, amount: bigint): Promise<ContractTransactionResponse>;
}

/** Generic typed-contract factory for the interfaces above. */
export function typed<T>(address: string, abi: InterfaceAbi, runner: ContractRunner): T {
  return new Contract(address, abi, runner) as unknown as T;
}
