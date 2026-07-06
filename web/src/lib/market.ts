import { useEffect, useState } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { eclipseSettlementAbi } from "./abis";
import { deployment, isConfigured, relayUrl } from "./deployment";

/**
 * Shared market-data hooks. Both the persistent MarketBar and the trader console
 * read from here so the whole app quotes against a single source of truth — the
 * *same* FTSO reference the settlement contract bounds every clearing price to.
 */

export interface LivePrice {
  /** XRP/USD as a human number (already scaled by the feed's decimals). */
  price: number;
  /** Raw feed value (base units), for exact-scale order pricing. */
  raw: bigint;
  /** Feed decimals reported on-chain. */
  decimals: number;
  /** Feed last-update time (unix seconds), or 0 if unread. */
  updatedAt: number;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Live XRP/USD from `EclipseSettlement.currentXrpUsdPrice()` — the exact oracle
 * value the on-chain band check uses. Refreshes on Coston2's ~2s block cadence
 * (polled every 10s to stay light).
 */
export function useLivePrice(): LivePrice {
  const q = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "currentXrpUsdPrice",
    query: { enabled: isConfigured, refetchInterval: 10_000 },
  });

  const tuple = q.data as readonly [bigint, number, bigint] | undefined;
  const raw = tuple ? tuple[0] : 0n;
  const decimals = tuple ? Number(tuple[1]) : 6;
  const updatedAt = tuple ? Number(tuple[2]) : 0;
  return {
    price: raw > 0n ? Number(raw) / 10 ** decimals : 0,
    raw,
    decimals,
    updatedAt,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}

/**
 * Rolling in-memory history of the live price, for a sparkline. Session-only (no
 * persistence) — it samples whatever `useLivePrice` already polls, so it adds no
 * RPC. Keeps the most recent `max` distinct-tick samples.
 */
export function usePriceHistory(max = 60): number[] {
  const { price } = useLivePrice();
  const [history, setHistory] = useState<number[]>([]);
  useEffect(() => {
    if (price <= 0) return;
    setHistory((h) => {
      if (h.length > 0 && h[h.length - 1] === price) return h;
      const next = [...h, price];
      return next.length > max ? next.slice(next.length - max) : next;
    });
  }, [price, max]);
  return history;
}

/** On-chain fairness band half-width in basis points (±). */
export function useBandBps(): number {
  const q = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "bandBps",
    query: { enabled: isConfigured, staleTime: 60_000 },
  });
  return typeof q.data === "bigint" ? Number(q.data) : deployment.bandBps;
}

/**
 * Combined escrow (FXRP + USDT0, base units summed) for one account. Used as the
 * private "did my net position move?" signal for the local order blotter. Shares
 * wagmi's query cache with the escrow panel, so it adds no extra RPC.
 */
export function useAccountEscrowTotal(account?: `0x${string}`): bigint {
  const fxrp = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.fxrp] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const usdt0 = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.usdt0] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const a = typeof fxrp.data === "bigint" ? fxrp.data : 0n;
  const b = typeof usdt0.data === "bigint" ? usdt0.data : 0n;
  return a + b;
}

/**
 * Highest `batchId` seen in public BatchSettled events. The blotter snapshots
 * this at submit and treats any later batch as a chance its order cleared.
 */
export function useLatestSettledBatchId(): bigint {
  const publicClient = usePublicClient();
  const [latest, setLatest] = useState<bigint>(0n);

  useEffect(() => {
    if (!isConfigured || !publicClient) return;
    let cancelled = false;
    const scan = async () => {
      try {
        const head = await publicClient.getBlockNumber();
        const lookback = 100_000n;
        const fromBlock = head > lookback ? head - lookback : 0n;
        const logs = await publicClient.getContractEvents({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          eventName: "BatchSettled",
          fromBlock,
          toBlock: "latest",
        });
        if (cancelled) return;
        let max = 0n;
        for (const l of logs) {
          const id = l.args.batchId ?? 0n;
          if (id > max) max = id;
        }
        setLatest(max);
      } catch {
        /* transient RPC range/limit — keep the last known id */
      }
    };
    void scan();
    const id = setInterval(scan, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [publicClient]);

  return latest;
}

export interface BatchStatus {
  autoClose: boolean;
  intervalSeconds: number;
  /** Seconds until the next auto-close, counted down locally between polls. */
  nextCloseInSeconds: number;
  online: boolean;
}

/**
 * Relay batch cadence from `GET /batch/status`. The relay deliberately never
 * reveals pool size (a pre-settlement side channel), only the timer — so this is
 * a countdown to the next uniform-price auction, nothing about who is in it.
 */
export function useBatchStatus(): BatchStatus {
  const [status, setStatus] = useState<BatchStatus>({
    autoClose: false,
    intervalSeconds: 0,
    nextCloseInSeconds: 0,
    online: false,
  });

  // Poll the relay for the authoritative cadence every 5s.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${relayUrl()}/batch/status`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`relay ${res.status}`);
        const data = (await res.json()) as Partial<BatchStatus>;
        if (cancelled) return;
        setStatus({
          autoClose: data.autoClose === true,
          intervalSeconds: Number(data.intervalSeconds ?? 0),
          nextCloseInSeconds: Number(data.nextCloseInSeconds ?? 0),
          online: true,
        });
      } catch {
        if (!cancelled) setStatus((s) => ({ ...s, online: false }));
      }
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Tick the countdown down locally each second so it feels live between polls.
  useEffect(() => {
    if (!status.online || !status.autoClose) return;
    const id = setInterval(() => {
      setStatus((s) => ({ ...s, nextCloseInSeconds: Math.max(0, s.nextCloseInSeconds - 1) }));
    }, 1000);
    return () => clearInterval(id);
  }, [status.online, status.autoClose]);

  return status;
}
