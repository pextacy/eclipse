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
  "function flareRegistry() view returns (address)",
  "function xrpUsdFeedId() view returns (bytes21)",
];
const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FEE_ABI = ["function calculateFeeByIds(bytes21[]) view returns (uint256)"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export interface RelayTxResult {
  commitTx: string;
  settleTx: string;
}

export class OnChainRelay {
  private readonly settlement: Contract;
  private readonly provider: JsonRpcProvider;

  constructor(rpc: string, relayPrivateKey: string, settlementAddress: string) {
    this.provider = new JsonRpcProvider(rpc);
    const wallet = new Wallet(relayPrivateKey, this.provider);
    this.settlement = new Contract(settlementAddress, SETTLEMENT_ABI, wallet);
  }

  /**
   * The FTSO feed fee `settleBatch` forwards. Zero on Coston2 today, but read it
   * live so settlement doesn't start reverting `InsufficientFtsoFee` if Flare
   * ever enables a non-zero fee. Best-effort: any lookup failure → 0 (the
   * contract also treats a missing FeeCalculator as fee 0). Cached after success.
   */
  private feeCache?: bigint;
  private async ftsoFee(): Promise<bigint> {
    if (this.feeCache !== undefined) return this.feeCache;
    try {
      const [registryAddr, feedId] = await Promise.all([
        (this.settlement as any).flareRegistry() as Promise<string>,
        (this.settlement as any).xrpUsdFeedId() as Promise<string>,
      ]);
      const registry = new Contract(registryAddr, REGISTRY_ABI, this.provider) as any;
      const feeCalc: string = await registry.getContractAddressByName("FeeCalculator");
      if (!feeCalc || feeCalc === ZERO_ADDR) return (this.feeCache = 0n);
      const feeContract = new Contract(feeCalc, FEE_ABI, this.provider) as any;
      const fee: bigint = await feeContract.calculateFeeByIds([feedId]);
      return (this.feeCache = fee);
    } catch {
      return 0n; // don't cache a transient failure
    }
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
    // Forward the (currently 0) FTSO feed fee; the contract refunds any excess.
    const fee = await this.ftsoFee();
    const settleTx = await (this.settlement as any).settleBatch(settlement, signed.settlementSignature, {
      value: fee,
    });
    await settleTx.wait();

    return { commitTx: commitTx.hash, settleTx: settleTx.hash };
  }
}
