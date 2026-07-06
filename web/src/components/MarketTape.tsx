"use client";

import { useRecentBatches } from "../lib/market";
import { deployment } from "../lib/deployment";
import { ftsoToNumber, fmtNum } from "../lib/format";

/**
 * Compact live "tape" of recent settled batches — the confidential-pool analogue
 * of a recent-trades ticker. Each chip is one uniform-price clearing with its
 * deviation from the on-chain FTSO reference. Reveals only public aggregates.
 */
export function MarketTape({ limit = 10 }: { limit?: number }) {
  const { batches, state } = useRecentBatches(limit);

  if (state === "loading") return <span className="mono text-2xs text-muted">loading tape…</span>;
  if (state === "empty")
    return <span className="mono text-2xs text-muted">no settlements yet</span>;
  if (state === "error")
    return <span className="mono text-2xs text-warn">tape unavailable (RPC)</span>;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {batches.map((b) => {
        const clearing = ftsoToNumber(b.clearingPrice);
        const ref = ftsoToNumber(b.ftsoOnChain);
        const devBps = ref > 0 ? ((clearing - ref) / ref) * 10_000 : 0;
        const within = Math.abs(devBps) <= deployment.bandBps;
        return (
          <a
            key={b.txHash}
            href={`https://coston2-explorer.flare.network/tx/${b.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="mono flex shrink-0 items-baseline gap-1.5 border border-line bg-surface px-2 py-1 text-2xs hover:border-eclipse"
            title={`Batch #${b.batchId} · ${fmtNum(devBps, 2)} bps from FTSO`}
          >
            <span className="text-muted">#{b.batchId.toString()}</span>
            <span className="text-ink">{fmtNum(clearing, 5)}</span>
            <span className={within ? "text-good" : "text-loss"}>
              {devBps >= 0 ? "+" : ""}
              {fmtNum(devBps, 1)}
            </span>
          </a>
        );
      })}
    </div>
  );
}
