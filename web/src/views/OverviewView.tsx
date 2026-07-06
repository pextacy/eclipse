import { useAccount, useReadContract } from "wagmi";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { Sparkline } from "../components/Sparkline";
import { eclipseSettlementAbi } from "../lib/abis";
import { deployment, isConfigured } from "../lib/deployment";
import {
  useLivePrice,
  useBandBps,
  useBatchStatus,
  usePriceHistory,
  useLatestSettledBatchId,
} from "../lib/market";
import { usePortfolio } from "../lib/portfolio";
import { fmtNum, fmtUsd } from "../lib/format";

/**
 * The trader's home screen. One glanceable surface tying together the live
 * market, the trader's own position/P&L (from usePortfolio), and pool activity —
 * with quick jumps into the deeper tabs. Everything reads live from chain.
 */
export function OverviewView({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const { address, isConnected } = useAccount();
  const mid = useLivePrice();
  const band = useBandBps();
  const batch = useBatchStatus();
  const history = usePriceHistory(60);
  const latestBatchId = useLatestSettledBatchId();
  const p = usePortfolio(address);

  const openLeg = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "hasOpenLeg",
    args: address ? [address] : undefined,
    query: { enabled: isConfigured && !!address, refetchInterval: 8000 },
  });
  const locked = openLeg.data === true;

  if (!isConfigured) {
    return (
      <div className="border border-warn bg-panel px-5 py-4">
        <div className="mb-1 text-sm font-semibold text-warn">Deployment not configured</div>
        <p className="max-w-2xl text-xs text-muted">
          The overview reads live market and account state from EclipseSettlement. It lights up once
          the app is pointed at a deployed contract.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Market row */}
      <Panel
        title="Market"
        subtitle="XRP/USD from FTSOv2, read on-chain (the reference the band enforces)"
        actions={history.length >= 2 ? <Sparkline data={history} width={120} height={24} /> : undefined}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="XRP / USD"
            value={mid.price > 0 ? fmtNum(mid.price, 5) : "…"}
            sub="live FTSO mid"
            tone="good"
          />
          <StatTile
            label="Fairness band"
            value={`±${band} bps`}
            sub={mid.price > 0 ? `${fmtNum(mid.price * (1 - band / 10_000), 5)} – ${fmtNum(mid.price * (1 + band / 10_000), 5)}` : "clearing bound"}
            tone="info"
          />
          <StatTile
            label="Next batch"
            value={
              batch.online
                ? batch.autoClose
                  ? fmtCountdown(batch.nextCloseInSeconds)
                  : "manual"
                : "relay off"
            }
            sub={batch.online && batch.autoClose ? `every ${batch.intervalSeconds}s` : "uniform-price auction"}
            tone={batch.online ? "default" : "warn"}
          />
          <StatTile
            label="Batches settled"
            value={latestBatchId > 0n ? `#${latestBatchId.toString()}` : "—"}
            sub="latest on-chain"
          />
        </div>
      </Panel>

      {/* Account row */}
      <Panel
        title="Your account"
        subtitle="Position & P&L derived from your escrow — no order data needed"
        actions={
          <span className={`tag ${locked ? "border-warn text-warn" : "border-line-strong text-muted"}`}>
            {locked ? "leg open · locked" : "no open leg"}
          </span>
        }
      >
        {!isConnected || !address ? (
          <p className="text-xs text-muted">
            Connect a wallet to see your escrow value, net position and mark-to-market P&L.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile
              label="Escrow value"
              value={fmtUsd(p.escrowValueUsd)}
              sub="FXRP@mid + USDT0"
              tone="good"
            />
            <StatTile
              label={`Net ${p.fxrp.symbol}`}
              value={`${p.fxrpTradedNum >= 0 ? "+" : ""}${fmtNum(p.fxrpTradedNum, 2)}`}
              sub="traded via pool"
              tone={p.fxrpTradedNum >= 0 ? "good" : "loss"}
            />
            <StatTile
              label="Avg execution"
              value={p.hasPosition ? fmtNum(p.avgPrice, 5) : "—"}
              sub="pool fills"
              tone="info"
            />
            <StatTile
              label="Unrealized P&L"
              value={p.hasPosition ? `${p.unrealized >= 0 ? "+" : ""}${fmtUsd(p.unrealized)}` : "—"}
              sub="mark-to-oracle"
              tone={!p.hasPosition ? "default" : p.unrealized >= 0 ? "good" : "loss"}
            />
          </div>
        )}
      </Panel>

      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-3">
        <ActionCard
          title="Trade"
          body="Deposit collateral and submit a sealed order for the next batch."
          cta="Open trader console →"
          onClick={() => onNavigate?.("trade")}
        />
        <ActionCard
          title="Portfolio"
          body="Full position reconciliation and mark-to-market P&L breakdown."
          cta="View portfolio →"
          onClick={() => onNavigate?.("portfolio")}
        />
        <ActionCard
          title="Verify"
          body="Check the latest settlement was signed by an attested build and cleared in-band."
          cta="Open verifier →"
          onClick={() => onNavigate?.("verify")}
        />
      </div>
    </div>
  );
}

function ActionCard({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-line bg-panel px-4 py-3 text-left transition-colors hover:border-eclipse"
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-subtle">{title}</div>
      <p className="mt-1 text-2xs text-muted">{body}</p>
      <div className="mono mt-2 text-2xs text-info">{cta}</div>
    </button>
  );
}

function fmtCountdown(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}
