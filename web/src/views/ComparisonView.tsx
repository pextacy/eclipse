import { useMemo, useState } from "react";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { MonoNumber } from "../components/MonoNumber";
import {
  simulateSandwich,
  simulateEclipse,
  spotPrice,
  type PoolState,
} from "../lib/simulation";
import { fmtNum, fmtUsd } from "../lib/format";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
  tone?: "eclipse" | "loss";
}

function Slider({ label, value, min, max, step, onChange, format, tone = "eclipse" }: SliderProps) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <MonoNumber className="text-sm">{format(value)}</MonoNumber>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full"
        style={{ accentColor: tone === "loss" ? "#ff5470" : "#22d3aa" }}
      />
    </label>
  );
}

/** Flat SVG bar comparing effective execution prices. Solid fills, no gradient. */
function PriceImpactChart({
  midPrice,
  fairPrice,
  sandwichPrice,
  eclipsePrice,
}: {
  midPrice: number;
  fairPrice: number;
  sandwichPrice: number;
  eclipsePrice: number;
}) {
  const bars = [
    { label: "Pool mid", price: midPrice, color: "#4aa8ff" },
    { label: "Public fair", price: fairPrice, color: "#7d8695" },
    { label: "Public sandwiched", price: sandwichPrice, color: "#ff5470" },
    { label: "Eclipse uniform", price: eclipsePrice, color: "#22d3aa" },
  ];
  const max = Math.max(...bars.map((b) => b.price)) * 1.06;
  const min = Math.min(...bars.map((b) => b.price)) * 0.985;
  const W = 520;
  const H = 150;
  const padL = 8;
  const padR = 8;
  const barW = (W - padL - padR) / bars.length;
  const scaleY = (p: number) => H - ((p - min) / (max - min)) * (H - 24);

  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label="Price impact">
      {/* baseline */}
      <line x1={0} y1={H} x2={W} y2={H} stroke="#232a35" strokeWidth={1} />
      {bars.map((b, i) => {
        const x = padL + i * barW + barW * 0.16;
        const w = barW * 0.68;
        const y = scaleY(b.price);
        const h = H - y;
        return (
          <g key={b.label}>
            <rect x={x} y={y} width={w} height={h} fill={b.color} />
            <text
              x={x + w / 2}
              y={y - 5}
              textAnchor="middle"
              fontSize={11}
              fontFamily="ui-monospace, monospace"
              fill={b.color}
            >
              {b.price.toFixed(4)}
            </text>
            <text
              x={x + w / 2}
              y={H + 15}
              textAnchor="middle"
              fontSize={9.5}
              fontFamily="ui-monospace, monospace"
              fill="#7d8695"
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ComparisonView() {
  const [priceUsd, setPriceUsd] = useState(0.5); // XRP/USD-ish
  const [poolFxrpM, setPoolFxrpM] = useState(2); // millions of FXRP in pool
  const [orderUsdK, setOrderUsdK] = useState(250); // thousands USD
  const [aggression, setAggression] = useState(1);

  const pool: PoolState = useMemo(() => {
    const base = poolFxrpM * 1_000_000;
    return { baseReserve: base, quoteReserve: base * priceUsd };
  }, [poolFxrpM, priceUsd]);

  const orderUsd = orderUsdK * 1000;

  const sandwich = useMemo(
    () => simulateSandwich(pool, orderUsd, aggression),
    [pool, orderUsd, aggression],
  );
  const eclipse = useMemo(() => simulateEclipse(pool, orderUsd), [pool, orderUsd]);
  const mid = spotPrice(pool);

  return (
    <div className="space-y-6">
      {/* Headline */}
      <div className="border border-line bg-panel">
        <div className="border-b border-line px-5 py-3">
          <h1 className="text-base font-semibold tracking-wide text-ink">
            The same large order, two ways
          </h1>
          <p className="mt-0.5 text-xs text-muted">
            A confidential dark pool vs a public AMM. Fully offline simulation — drag the inputs and
            watch the front-running loss move. Constant-product pool (x·y=k).
          </p>
        </div>

        <div className="grid gap-5 p-5 md:grid-cols-4">
          <Slider
            label="XRP/USD price"
            value={priceUsd}
            min={0.2}
            max={2}
            step={0.01}
            onChange={setPriceUsd}
            format={(n) => fmtUsd(n, 3)}
          />
          <Slider
            label="Pool depth (FXRP)"
            value={poolFxrpM}
            min={0.25}
            max={10}
            step={0.25}
            onChange={setPoolFxrpM}
            format={(n) => `${fmtNum(n, 2)}M`}
          />
          <Slider
            label="Your order (USD)"
            value={orderUsdK}
            min={10}
            max={2000}
            step={10}
            onChange={setOrderUsdK}
            format={(n) => fmtUsd(n * 1000, 0)}
            tone="loss"
          />
          <Slider
            label="Attacker aggression"
            value={aggression}
            min={0}
            max={1}
            step={0.05}
            onChange={setAggression}
            format={(n) => `${Math.round(n * 100)}%`}
            tone="loss"
          />
        </div>

        {/* The money shot line */}
        <div className="flex flex-col gap-1 border-t border-line bg-loss-dim px-5 py-4 md:flex-row md:items-baseline md:justify-between">
          <div className="text-lg font-semibold text-ink">
            Public DEX cost you{" "}
            <MonoNumber tone="loss" className="text-2xl">
              {fmtUsd(sandwich.usdLost)}
            </MonoNumber>{" "}
            to front-running.
          </div>
          <div className="text-lg font-semibold text-ink">
            Eclipse: <MonoNumber tone="good" className="text-2xl">$0</MonoNumber>
          </div>
        </div>
      </div>

      {/* Side by side */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Public DEX */}
        <Panel
          title="Public DEX (AMM)"
          subtitle="Order visible in the mempool → sandwiched"
          actions={<span className="tag border-loss text-loss">exposed</span>}
          className="border-loss"
        >
          <p className="mb-4 text-xs text-muted">
            Your buy sits in the public mempool. A searcher front-runs it (buys first, pushing the
            price up), lets you fill at the worse price, then back-runs (sells into your impact) —
            pocketing the difference.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label="You wanted (fair fill)"
              value={<>{fmtNum(sandwich.fairBaseOut, 2)}</>}
              sub="FXRP at the honest pool"
            />
            <StatTile
              label="You actually got"
              value={<>{fmtNum(sandwich.sandwichedBaseOut, 2)}</>}
              sub="FXRP after the sandwich"
              tone="loss"
            />
            <StatTile
              label="FXRP lost"
              value={<>-{fmtNum(sandwich.fxrpLost, 2)}</>}
              sub={`${fmtNum(sandwich.victimSlippagePct, 3)}% slippage`}
              tone="loss"
            />
            <StatTile
              label="USD extracted from you"
              value={fmtUsd(sandwich.usdLost)}
              sub={`attacker profit ${fmtUsd(sandwich.attackerProfitUsd)}`}
              tone="loss"
            />
          </div>

          <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-2xs text-muted">
            <Row
              k="Attacker front-run"
              v={`${fmtUsd(sandwich.attackerQuoteIn)} buy — leaked to mempool`}
              tone="loss"
            />
            <Row
              k="Your effective price"
              v={`${fmtUsd(sandwich.victimEffectivePrice, 4)} / FXRP`}
              tone="loss"
            />
            <Row k="Honest mid price" v={`${fmtUsd(mid, 4)} / FXRP`} />
          </div>
        </Panel>

        {/* Eclipse */}
        <Panel
          title="Eclipse (sealed batch)"
          subtitle="Nothing in the mempool → FTSO-fair uniform clearing"
          actions={<span className="tag border-eclipse text-eclipse">sealed</span>}
          className="border-eclipse"
        >
          <p className="mb-4 text-xs text-muted">
            Your order is sealed client-side and only ever opened inside the TEE. Nothing is visible
            to front-run. The batch clears at a single uniform FTSO-fair price — everyone in the
            batch gets the same price.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label="You got"
              value={<>{fmtNum(eclipse.baseOut, 2)}</>}
              sub="FXRP at the uniform price"
              tone="good"
            />
            <StatTile
              label="Uniform clearing price"
              value={fmtUsd(eclipse.uniformPrice, 4)}
              sub="inside the ±FTSO band"
              tone="good"
            />
            <StatTile label="Leaked to mempool" value="0" sub="nothing to see" tone="good" />
            <StatTile label="Extracted by MEV" value="$0" sub="zero sandwich loss" tone="good" />
          </div>

          <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-2xs text-muted">
            <Row
              k="You keep vs public DEX"
              v={`+${fmtNum(eclipse.baseOut - sandwich.sandwichedBaseOut, 2)} FXRP (${fmtUsd(sandwich.usdLost)})`}
              tone="good"
            />
            <Row k="Price fairness" v="uniform, FTSO-anchored, one price for all" tone="good" />
            <Row k="Order visibility" v="sealed — relay never sees plaintext" tone="good" />
          </div>
        </Panel>
      </div>

      {/* Price impact chart */}
      <Panel title="Execution price impact" subtitle="Effective USD/FXRP price paid, per venue">
        <PriceImpactChart
          midPrice={mid}
          fairPrice={orderUsd / sandwich.fairBaseOut}
          sandwichPrice={sandwich.victimEffectivePrice}
          eclipsePrice={eclipse.uniformPrice}
        />
        <p className="mt-2 text-2xs text-muted">
          Lower is better for a buyer. The red bar is what the public DEX makes you pay once you are
          sandwiched; the green bar is the uniform Eclipse price.
        </p>
      </Panel>
    </div>
  );
}

function Row({ k, v, tone = "default" }: { k: string; v: string; tone?: "default" | "good" | "loss" }) {
  const toneClass = tone === "good" ? "text-good" : tone === "loss" ? "text-loss" : "text-subtle";
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{k}</span>
      <span className={`mono ${toneClass}`}>{v}</span>
    </div>
  );
}
