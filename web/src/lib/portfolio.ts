import { useEffect, useState } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { eclipseSettlementAbi, erc20Abi } from "./abis";
import { deployment, isConfigured } from "./deployment";
import { useLivePrice } from "./market";

/**
 * Shared portfolio derivation, used by both the Portfolio tab and the Overview
 * dashboard so the P&L math lives in exactly one place.
 *
 * BatchSettled never emits per-account deltas (by design). But escrow is a closed
 * system, so the net effect of trading is exact:
 *
 *   tradingDelta(token) = currentEscrow(token) − deposits(token) + withdrawals(token)
 *
 * deposits/withdrawals ARE per-account events, so this reconstructs the desk's
 * realized flow through the pool, and marks the net FXRP to the live FTSO mid.
 */

export interface FlowEvent {
  kind: "deposit" | "withdraw";
  token: `0x${string}`;
  amount: bigint;
  txHash: `0x${string}`;
  block: bigint;
}

export interface TokenMeta {
  decimals: number;
  symbol: string;
}

export interface Portfolio {
  fxrp: TokenMeta;
  usdt0: TokenMeta;
  fxrpEscrow: bigint;
  usdt0Escrow: bigint;
  fxrpExternal: bigint; // deposits − withdrawals
  usdt0External: bigint;
  fxrpTraded: bigint; // net FXRP moved by fills (signed)
  usdt0Traded: bigint;
  /** Signed JS numbers for display/math (NOT via grouped formatUnits). */
  fxrpTradedNum: number;
  usdt0TradedNum: number;
  avgPrice: number;
  markValue: number;
  costBasis: number;
  unrealized: number;
  hasPosition: boolean;
  midPrice: number;
  /** Total escrow value in USDT0 terms (FXRP marked at mid + USDT0). */
  escrowValueUsd: number;
  flows: FlowEvent[];
  state: "idle" | "loading" | "empty" | "error";
}

export function useTokenMeta(
  token: `0x${string}`,
  fallbackSymbol: string,
  fallbackDecimals: number,
): TokenMeta {
  const { data: decimals } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: isConfigured, staleTime: Infinity },
  });
  const { data: symbol } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: isConfigured, staleTime: Infinity },
  });
  return {
    decimals: typeof decimals === "number" ? decimals : fallbackDecimals,
    symbol: typeof symbol === "string" && symbol.length > 0 ? symbol : fallbackSymbol,
  };
}

export function usePortfolio(account?: `0x${string}`): Portfolio {
  const publicClient = usePublicClient();
  const mid = useLivePrice();
  const fxrp = useTokenMeta(deployment.fxrp, "FXRP", 6);
  const usdt0 = useTokenMeta(deployment.usdt0, "USDT0", 6);

  const [flows, setFlows] = useState<FlowEvent[]>([]);
  const [state, setState] = useState<Portfolio["state"]>("idle");

  const fxrpEscrowQ = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.fxrp] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const usdt0EscrowQ = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.usdt0] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });

  useEffect(() => {
    if (!isConfigured || !publicClient || !account) {
      setFlows([]);
      setState("idle");
      return;
    }
    let cancelled = false;
    (async () => {
      setState("loading");
      try {
        const head = await publicClient.getBlockNumber();
        const lookback = 200_000n;
        const fromBlock = head > lookback ? head - lookback : 0n;
        const [deposits, withdrawals] = await Promise.all([
          publicClient.getContractEvents({
            address: deployment.eclipseSettlement,
            abi: eclipseSettlementAbi,
            eventName: "Deposited",
            args: { account },
            fromBlock,
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            address: deployment.eclipseSettlement,
            abi: eclipseSettlementAbi,
            eventName: "Withdrawn",
            args: { account },
            fromBlock,
            toBlock: "latest",
          }),
        ]);
        if (cancelled) return;
        const mapped: FlowEvent[] = [
          ...deposits.map((l) => ({
            kind: "deposit" as const,
            token: (l.args.token ?? deployment.fxrp) as `0x${string}`,
            amount: l.args.amount ?? 0n,
            txHash: l.transactionHash,
            block: l.blockNumber ?? 0n,
          })),
          ...withdrawals.map((l) => ({
            kind: "withdraw" as const,
            token: (l.args.token ?? deployment.fxrp) as `0x${string}`,
            amount: l.args.amount ?? 0n,
            txHash: l.transactionHash,
            block: l.blockNumber ?? 0n,
          })),
        ].sort((a, b) => (a.block > b.block ? -1 : a.block < b.block ? 1 : 0));
        setFlows(mapped);
        setState(mapped.length === 0 ? "empty" : "idle");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, account]);

  const sumFlow = (token: `0x${string}`) =>
    flows.reduce((acc, f) => {
      if (f.token.toLowerCase() !== token.toLowerCase()) return acc;
      return acc + (f.kind === "deposit" ? f.amount : -f.amount);
    }, 0n);

  const fxrpEscrow = fxrpEscrowQ.data ?? 0n;
  const usdt0Escrow = usdt0EscrowQ.data ?? 0n;
  const fxrpExternal = sumFlow(deployment.fxrp);
  const usdt0External = sumFlow(deployment.usdt0);
  const fxrpTraded = fxrpEscrow - fxrpExternal;
  const usdt0Traded = usdt0Escrow - usdt0External;

  // Direct signed conversion — NOT via grouped formatUnits() (Number() → NaN).
  const fxrpTradedNum = Number(fxrpTraded) / 10 ** fxrp.decimals;
  const usdt0TradedNum = Number(usdt0Traded) / 10 ** usdt0.decimals;
  const fxrpEscrowNum = Number(fxrpEscrow) / 10 ** fxrp.decimals;
  const usdt0EscrowNum = Number(usdt0Escrow) / 10 ** usdt0.decimals;

  const avgPrice = fxrpTradedNum !== 0 ? Math.abs(usdt0TradedNum) / Math.abs(fxrpTradedNum) : 0;
  const markValue = fxrpTradedNum * mid.price;
  const costBasis = -usdt0TradedNum;
  const unrealized = markValue - costBasis;
  const hasPosition = Math.abs(fxrpTradedNum) > 1e-9;
  const escrowValueUsd = fxrpEscrowNum * mid.price + usdt0EscrowNum;

  return {
    fxrp,
    usdt0,
    fxrpEscrow,
    usdt0Escrow,
    fxrpExternal,
    usdt0External,
    fxrpTraded,
    usdt0Traded,
    fxrpTradedNum,
    usdt0TradedNum,
    avgPrice,
    markValue,
    costBasis,
    unrealized,
    hasPosition,
    midPrice: mid.price,
    escrowValueUsd,
    flows,
    state,
  };
}
