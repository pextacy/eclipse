import { Contract, Wallet, JsonRpcProvider } from "ethers";
import type { SignedSettlement } from "@eclipse/shared";

/**
 * Minimal settlement ABI. The relay has NO signing authority over settlements —
 * it only forwards the engine's signature and pays gas. Its key cannot move user
 * funds: settleBatch reverts unless the signature recovers to the attested,
 * whitelisted signer (CLAUDE.md §2.3, §6 relay-is-untrusted).
 */
const SETTLEMENT_ABI = [
  "function commitBatch((uint256 batchId,address[] accounts,uint256 expiry,uint256 nonce) c, bytes signature)",
  "function settleBatch((uint256 batchId,address[] accounts,int256[] fxrpDeltas,int256[] usdt0Deltas,uint256 clearingPrice,uint256 ftsoRef,uint256 expiry,uint256 nonce) s, bytes signature) payable",
];

export interface RelayTxResult {
  commitTx: string;
  settleTx: string;
}

export class OnChainRelay {
  private readonly settlement: Contract;

  constructor(rpc: string, relayPrivateKey: string, settlementAddress: string) {
    const provider = new JsonRpcProvider(rpc);
    const wallet = new Wallet(relayPrivateKey, provider);
    this.settlement = new Contract(settlementAddress, SETTLEMENT_ABI, wallet);
  }

  /** Push the engine's signed commit + settlement on-chain. */
  async relay(signed: SignedSettlement): Promise<RelayTxResult> {
    const commit = {
      batchId: BigInt(signed.commit.batchId),
      accounts: signed.commit.accounts,
      expiry: BigInt(signed.commit.expiry),
      nonce: BigInt(signed.commit.nonce),
    };
    const settlement = {
      batchId: BigInt(signed.settlement.batchId),
      accounts: signed.settlement.accounts,
      fxrpDeltas: signed.settlement.fxrpDeltas.map(BigInt),
      usdt0Deltas: signed.settlement.usdt0Deltas.map(BigInt),
      clearingPrice: BigInt(signed.settlement.clearingPrice),
      ftsoRef: BigInt(signed.settlement.ftsoRef),
      expiry: BigInt(signed.settlement.expiry),
      nonce: BigInt(signed.settlement.nonce),
    };

    const commitTx = await (this.settlement as any).commitBatch(commit, signed.commitSignature);
    await commitTx.wait();
    const settleTx = await (this.settlement as any).settleBatch(settlement, signed.settlementSignature);
    await settleTx.wait();

    return { commitTx: commitTx.hash, settleTx: settleTx.hash };
  }
}
