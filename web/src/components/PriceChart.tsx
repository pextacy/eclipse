"use client";

import { useRef, useState } from "react";
import { fmtNum } from "../lib/format";

interface PriceChartProps {
  /** Session price samples, oldest → newest. */
  data: number[];
  /** Current mid, for the band overlay centre. */
  mid: number;
  /** Fairness band half-width in bps (shaded region). */
  bandBps: number;
  height?: number;
  className?: string;
}

const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 18;

/**
 * Interactive session price chart — flat, no gradients (CLAUDE.md §5): a solid
 * line, a translucent solid band region, min/max/mid axis labels, and a hover
 * crosshair with a price readout. Pure SVG, no chart lib.
 */
export function PriceChart({ data, mid, bandBps, height = 200, className }: PriceChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = 640; // viewBox width; SVG scales to container via width=100%.

  if (data.length < 2) {
    return (
      <div className={`flex items-center justify-center border border-line bg-surface ${className ?? ""}`} style={{ height }}>
        <span className="mono text-2xs text-muted">
          collecting price samples… (updates every ~10s)
        </span>
      </div>
    );
  }

  const bandAbs = mid > 0 ? (mid * bandBps) / 10_000 : 0;
  // Include the band edges in the y-range so the shaded region is always visible.
  const lo = mid > 0 ? Math.min(...data, mid - bandAbs) : Math.min(...data);
  const hi = mid > 0 ? Math.max(...data, mid + bandAbs) : Math.max(...data);
  const span = hi - lo || 1;
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const xOf = (i: number) => PAD_L + (i / (data.length - 1)) * plotW;
  const yOf = (v: number) => PAD_T + plotH - ((v - lo) / span) * plotH;

  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const up = data[data.length - 1]! >= data[0]!;
  const stroke = up ? "#22d3aa" : "#ff5470";

  const bandTop = yOf(mid + bandAbs);
  const bandBottom = yOf(mid - bandAbs);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const frac = Math.max(0, Math.min(1, (relX - PAD_L) / plotW));
    setHover(Math.round(frac * (data.length - 1)));
  };

  const hv = hover != null ? data[hover] : undefined;

  return (
    <div ref={wrapRef} className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Band region (solid translucent fill — flat, not a gradient) */}
        {bandAbs > 0 && (
          <rect
            x={PAD_L}
            y={bandTop}
            width={plotW}
            height={Math.max(0, bandBottom - bandTop)}
            fill="#22d3aa"
            fillOpacity={0.08}
          />
        )}
        {/* Mid line */}
        {mid > 0 && (
          <line
            x1={PAD_L}
            y1={yOf(mid)}
            x2={PAD_L + plotW}
            y2={yOf(mid)}
            stroke="#3b82f6"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {/* Axis labels */}
        <AxisLabel y={PAD_T} value={hi} />
        <AxisLabel y={PAD_T + plotH / 2} value={(hi + lo) / 2} />
        <AxisLabel y={PAD_T + plotH} value={lo} />
        {/* Price line */}
        <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
        {/* Hover crosshair */}
        {hover != null && hv !== undefined && (
          <>
            <line
              x1={xOf(hover)}
              y1={PAD_T}
              x2={xOf(hover)}
              y2={PAD_T + plotH}
              stroke="#64748b"
              strokeWidth={1}
            />
            <circle cx={xOf(hover)} cy={yOf(hv)} r={2.5} fill={stroke} />
          </>
        )}
      </svg>
      <div className="mono mt-1 flex items-center justify-between text-2xs text-muted">
        <span>{data.length} samples · session</span>
        <span>
          {hv !== undefined ? (
            <span className="text-ink">hover {fmtNum(hv, 5)}</span>
          ) : (
            <>
              last <span className="text-ink">{fmtNum(data[data.length - 1]!, 5)}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function AxisLabel({ y, value }: { y: number; value: number }) {
  return (
    <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="fill-muted" fontSize={9} fontFamily="monospace">
      {fmtNum(value, 4)}
    </text>
  );
}
