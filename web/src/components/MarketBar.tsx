"use client";

import { useEffect, useRef, useState } from "react";
import { useLivePrice, useBandBps, useBatchStatus, usePriceHistory } from "../lib/market";
import { isConfigured } from "../lib/deployment";
import { fmtNum } from "../lib/format";
import { Sparkline } from "./Sparkline";

/**
 * Persistent market strip under the header. Gives the app the feel of a real
 * trading terminal: a live XRP/USD oracle tick (the exact reference the band
 * enforces), the fairness band width, and a countdown to the next uniform-price
 * batch auction. All three are read straight from chain / the relay — nothing
 * simulated.
 */
export function MarketBar() {
  const { price, updatedAt, isLoading, isError } = useLivePrice();
  const band = useBandBps();
  const batch = useBatchStatus();
  const history = usePriceHistory(60);

  // Flash the price cell green/red on each change, like a ticker.
  const prev = useRef<number>(0);
  const [dir, setDir] = useState<"up" | "down" | "flat">("flat");
  useEffect(() => {
    if (price > 0 && prev.current > 0 && price !== prev.current) {
      setDir(price > prev.current ? "up" : "down");
      const id = setTimeout(() => setDir("flat"), 900);
      prev.current = price;
      return () => clearTimeout(id);
    }
    if (price > 0) prev.current = price;
  }, [price]);

  if (!isConfigured) return null;

  const priceTone =
    dir === "up" ? "text-good" : dir === "down" ? "text-loss" : "text-ink";
  const ageSec = updatedAt > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - updatedAt) : null;
  const bandAbs = price > 0 ? (price * band) / 10_000 : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-panel px-5 py-2 text-2xs">
      <Cell label="XRP / USD" hint="FTSOv2 · on-chain">
        <span className={`mono text-sm font-semibold tabular-nums ${priceTone}`}>
          {isError ? "—" : isLoading && price === 0 ? "…" : fmtNum(price, 5)}
        </span>
        {history.length >= 2 && <span className="ml-2 hidden sm:inline"><Sparkline data={history} /></span>}
        {ageSec !== null && (
          <span className="mono ml-2 text-2xs text-muted">{ageSec}s ago</span>
        )}
      </Cell>

      <Divider />

      <Cell label="Fairness band" hint="enforced in settle tx">
        <span className="mono text-info">±{band} bps</span>
        {bandAbs > 0 && (
          <span className="mono ml-2 text-muted">
            ({fmtNum(price - bandAbs, 5)} – {fmtNum(price + bandAbs, 5)})
          </span>
        )}
      </Cell>

      <Divider />

      <Cell label="Next batch" hint="uniform-price auction">
        {batch.online ? (
          batch.autoClose ? (
            <span className="mono text-eclipse tabular-nums">
              {fmtCountdown(batch.nextCloseInSeconds)}
              <span className="ml-2 text-muted">every {batch.intervalSeconds}s</span>
            </span>
          ) : (
            <span className="mono text-muted">operator-closed (manual)</span>
          )
        ) : (
          <span className="mono text-warn">relay offline</span>
        )}
      </Cell>
    </div>
  );
}

function fmtCountdown(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

function Cell({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="label whitespace-nowrap">{label}</span>
      <span className="flex items-baseline">{children}</span>
      {hint && <span className="mono hidden text-2xs text-subtle lg:inline">· {hint}</span>}
    </div>
  );
}

function Divider() {
  return <span className="hidden h-4 w-px bg-line md:inline-block" />;
}
