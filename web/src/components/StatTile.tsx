import type { ReactNode } from "react";

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "good" | "loss" | "warn" | "info";
  className?: string;
}

const valueTone: Record<NonNullable<StatTileProps["tone"]>, string> = {
  default: "text-ink",
  good: "text-good",
  loss: "text-loss",
  warn: "text-warn",
  info: "text-info",
};

/** Dense KPI tile. Solid fill, flat border. */
export function StatTile({ label, value, sub, tone = "default", className }: StatTileProps) {
  return (
    <div className={`border border-line bg-panel-2 px-3 py-2.5 ${className ?? ""}`}>
      <div className="label">{label}</div>
      <div className={`mono mt-1 text-lg leading-tight ${valueTone[tone]}`}>{value}</div>
      {sub && <div className="mono mt-0.5 text-2xs text-muted">{sub}</div>}
    </div>
  );
}
