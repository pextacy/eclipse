import { Wallet, type TypedDataDomain, type TypedDataField } from "ethers";
import {
  EIP712_SETTLEMENT_TYPES,
  EIP712_COMMIT_TYPES,
  eip712Domain,
  settlementSigningValue,
  batchCommitSigningValue,
  type Settlement,
  type BatchCommit,
} from "@eclipse/shared";

const SETTLEMENT_TYPES = EIP712_SETTLEMENT_TYPES as unknown as Record<string, TypedDataField[]>;
const COMMIT_TYPES = EIP712_COMMIT_TYPES as unknown as Record<string, TypedDataField[]>;

/**
 * Wraps the enclave signing key. In local dev this is an ordinary key; in the
 * deployed demo it is the attested FCC extension signer (Phase 3, `fce-sign`).
 * The public interface is identical either way — the chain only ever checks that
 * the recovered signer is bound to a whitelisted code-hash.
 */
export class EngineSigner {
  private readonly wallet: Wallet;
  private readonly domain: TypedDataDomain;

  constructor(privateKey: string, chainId: number, settlementAddress: string) {
    this.wallet = new Wallet(privateKey);
    this.domain = eip712Domain(chainId, settlementAddress) as TypedDataDomain;
  }

  get address(): string {
    return this.wallet.address;
  }

  signSettlement(s: Settlement): Promise<string> {
    return this.wallet.signTypedData(this.domain, SETTLEMENT_TYPES, settlementSigningValue(s));
  }

  signCommit(c: BatchCommit): Promise<string> {
    return this.wallet.signTypedData(this.domain, COMMIT_TYPES, batchCommitSigningValue(c));
  }
}
