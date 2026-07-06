import { useEffect, useState } from "react";
import { useAccount, useReadContract, usePublicClient } from "wagmi";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { TxLink } from "../components/TxLink";
import { eclipseSettlementAbi, erc20Abi } from "../lib/abis";
import { deployment, isConfigured } from "../lib/deployment";
import { useLivePrice } from "../lib/market";
import { formatUnits, fmtNum, fmtUsd } from "../lib/format";

/**
 * Portfolio & P&L, derived entirely from public, per-account chain data.
 *
 * BatchSettled emits only the batch-level clearing price (never per-account
 * deltas — that's the whole point). But escrow accounting is a closed system, so
 * the net effect of trading is exact:
 *
 *   currentEscrow(token) = deposits(token) − withdrawals(token) + tradingDelta(token)
 *   ⇒ tradingDelta(token) = currentEscrow − deposits + withdrawals
 *
 * Deposits/withdrawals ARE per-account events, so we reconstruct exactly how much
 * FXRP and USDT0 the desk gained/spent through the pool — its realized flow — and
 * mark the net FXRP position to the live FTSO mid for unrealized P&L.
 */

interface FlowEvent {
  kind: "deposit" | "withdraw";
  token: `0x${string}`;
  amount: bigint;
  txHash: `0x${string}`;
  block: bigint;
}

function useTokenMeta(token: `0x${string}`, fallbackSymbol: string, fallbackDecimals: number) {
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

export function PortfolioView() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const mid = useLivePrice();
  const fxrp = useTokenMeta(deployment.fxrp, "FXRP", 6);
  const usdt0 = useTokenMeta(deployment.usdt0, "USDT0", 6);

  const [flows, setFlows] = useState<FlowEvent[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "empty" | "error">("idle");

  const fxrpEscrow = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: address ? [address, deployment.fxrp] : undefined,
    query: { enabled: isConfigured && !!address, refetchInterval: 8000 },
  });
  const usdt0Escrow = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: address ? [address, deployment.usdt0] : undefined,
    query: { enabled: isConfigured && !!address, refetchInterval: 8000 },
  });

  useEffect(() => {
    if (!isConfigured || !publicClient || !address) return;
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
            args: { account: address },
            fromBlock,
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            address: deployment.eclipseSettlement,
            abi: eclipseSettlementAbi,
            eventName: "Withdrawn",
            args: { account: address },
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
  }, [publicClient, address]);

  if (!isConfigured) {
    return (
      <div className="border border-warn bg-panel px-5 py-4">
        <div className="mb-1 text-sm font-semibold text-warn">Deployment not configured</div>
        <p className="max-w-2xl text-xs text-muted">
          Portfolio & P&L read live from EclipseSettlement. They light up once the app is pointed at a
          deployed contract.
        </p>
      </div>
    );
  }
  if (!isConnected || !address) {
    return (
      <div className="border border-line bg-panel px-4 py-3 text-sm text-subtle">
        Connect a wallet to see your position, realized flow through the pool, and mark-to-market P&L.
      </div>
    );
  }

  // Per-token external flow (deposits − withdrawals) from events.
  const sumFlow = (token: `0x${string}`) =>
    flows.reduce((acc, f) => {
      if (f.token.toLowerCase() !== token.toLowerCase()) return acc;
      return acc + (f.kind === "deposit" ? f.amount : -f.amount);
    }, 0n);

  const fxrpEscrowVal = fxrpEscrow.data ?? 0n;
  const usdt0EscrowVal = usdt0Escrow.data ?? 0n;
  const fxrpExternal = sumFlow(deployment.fxrp);
  const usdt0External = sumFlow(deployment.usdt0);
  // tradingDelta = escrow − (deposits − withdrawals). Exact net effect of fills.
  const fxrpTraded = fxrpEscrowVal - fxrpExternal;
  const usdt0Traded = usdt0EscrowVal - usdt0External;

  // Convert directly to a signed JS number — NOT via formatUnits(), whose output
  // is thousands-grouped ("1,234.5"), which Number() would parse as NaN.
  const fxrpTradedNum = Number(fxrpTraded) / 10 ** fxrp.decimals;
  const usdt0TradedNum = Number(usdt0Traded) / 10 ** usdt0.decimals;

  // Net bought FXRP (fxrpTraded > 0) was paid for with USDT0 (usdt0Traded < 0).
  const avgPrice =
    fxrpTradedNum !== 0 ? Math.abs(usdt0TradedNum) / Math.abs(fxrpTradedNum) : 0;
  // Mark the net FXRP position to the live mid; unrealized vs USDT0 actually moved.
  const markValue = fxrpTradedNum * mid.price;
  const costBasis = -usdt0TradedNum; // USDT0 spent (positive if net buyer)
  const unrealized = markValue - costBasis;
  const hasPosition = Math.abs(fxrpTradedNum) > 1e-9;

  return (
    <div className="space-y-6">
      <Panel title="Position" subtitle="Net effect of every batch fill, derived from escrow accounting">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label={`Net ${fxrp.symbol} traded`}
            value={`${fxrpTradedNum >= 0 ? "+" : ""}${fmtNum(fxrpTradedNum, 2)}`}
            sub={fxrpTradedNum >= 0 ? "acquired via pool" : "sold via pool"}
            tone={fxrpTradedNum >= 0 ? "good" : "loss"}
          />
          <StatTile
            label={`Net ${usdt0.symbol} flow`}
            value={`${usdt0TradedNum >= 0 ? "+" : ""}${fmtNum(usdt0TradedNum, 2)}`}
            sub={usdt0TradedNum >= 0 ? "received" : "spent"}
            tone={usdt0TradedNum >= 0 ? "good" : "loss"}
          />
          <StatTile
            label="Avg execution"
            value={hasPosition ? fmtNum(avgPrice, 5) : "—"}
            sub="XRP/USD (pool fills)"
            tone="info"
          />
          <StatTile
            label="Live FTSO mid"
            value={mid.price > 0 ? fmtNum(mid.price, 5) : "…"}
            sub="mark price"
          />
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Mark-to-market" subtitle="Net FXRP position valued at the live oracle mid">
          {hasPosition ? (
            <dl className="space-y-2 text-xs">
              <Row label={`Position (${fxrp.symbol})`}>
                {`${fxrpTradedNum >= 0 ? "+" : ""}${fmtNum(fxrpTradedNum, 2)}`}
              </Row>
              <Row label="Cost basis (USDT0 spent)">{fmtUsd(costBasis)}</Row>
              <Row label="Mark value @ mid">{fmtUsd(markValue)}</Row>
              <div className="border-t border-line pt-2">
                <Row label="Unrealized P&L">
                  <span className={unrealized >= 0 ? "text-good" : "text-loss"}>
                    {unrealized >= 0 ? "+" : ""}
                    {fmtUsd(unrealized)}
                  </span>
                </Row>
              </div>
              <p className="pt-1 text-2xs text-muted">
                P&L is mark-to-oracle: your realized USDT0 flow vs your net FXRP marked at the current
                FTSO mid. It ignores fees (there are none in the settlement path) and any FXRP still
                held outside escrow.
              </p>
            </dl>
          ) : (
            <p className="mono text-2xs text-muted">
              no net pool position yet — once a batch fills your order, your net traded size, average
              execution and mark-to-market P&L appear here.
            </p>
          )}
        </Panel>

        <Panel title="Escrow vs external flow" subtitle="How the position reconciles">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-2xs">
              <thead>
                <tr className="text-muted">
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">token</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">deposited−withdrawn</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">in escrow</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">traded (Δ)</th>
                </tr>
              </thead>
              <tbody className="mono text-subtle">
                <ReconRow
                  sym={fxrp.symbol}
                  ext={fxrpExternal}
                  escrow={fxrpEscrowVal}
                  traded={fxrpTraded}
                  decimals={fxrp.decimals}
                />
                <ReconRow
                  sym={usdt0.symbol}
                  ext={usdt0External}
                  escrow={usdt0EscrowVal}
                  traded={usdt0Traded}
                  decimals={usdt0.decimals}
                />
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel
        title="Collateral activity"
        subtitle="Your Deposited / Withdrawn events"
        actions={<span className="tag border-line-strong text-muted">{flows.length} shown</span>}
      >
        {state === "loading" && <p className="mono text-2xs text-muted">loading your events…</p>}
        {state === "error" && (
          <p className="mono text-2xs text-warn">could not read logs from RPC (range/limit).</p>
        )}
        {state === "empty" && (
          <p className="mono text-2xs text-muted">no deposits or withdrawals yet.</p>
        )}
        {flows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-2xs">
              <thead>
                <tr className="text-muted">
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">action</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">token</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">amount</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">tx</th>
                </tr>
              </thead>
              <tbody className="mono">
                {flows.slice(0, 20).map((f, i) => {
                  const isFxrp = f.token.toLowerCase() === deployment.fxrp.toLowerCase();
                  const meta = isFxrp ? fxrp : usdt0;
                  return (
                    <tr key={`${f.txHash}-${i}`} className="border-t border-line">
                      <td className="px-2 py-1.5">
                        <span className={f.kind === "deposit" ? "text-good" : "text-warn"}>
                          {f.kind === "deposit" ? "DEPOSIT" : "WITHDRAW"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-subtle">{meta.symbol}</td>
                      <td className="px-2 py-1.5 text-subtle">
                        {formatUnits(f.amount, meta.decimals)}
                      </td>
                      <td className="px-2 py-1.5">
                        <TxLink hash={f.txHash} showCopy={false} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ReconRow({
  sym,
  ext,
  escrow,
  traded,
  decimals,
}: {
  sym: string;
  ext: bigint;
  escrow: bigint;
  traded: bigint;
  decimals: number;
}) {
  return (
    <tr className="border-t border-line">
      <td className="px-2 py-1.5">{sym}</td>
      <td className="px-2 py-1.5">{signedUnits(ext, decimals)}</td>
      <td className="px-2 py-1.5">{formatUnits(escrow, decimals)}</td>
      <td className={`px-2 py-1.5 ${traded >= 0n ? "text-good" : "text-loss"}`}>
        {signedUnits(traded, decimals)}
      </td>
    </tr>
  );
}

function signedUnits(v: bigint, decimals: number): string {
  const s = formatUnits(absBig(v), decimals);
  return v < 0n ? `-${s}` : v > 0n ? `+${s}` : s;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}
