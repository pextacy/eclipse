import type { ReactNode } from "react";

interface MonoNumberProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "good" | "loss" | "warn" | "muted" | "info";
}

const toneClass: Record<NonNullable<MonoNumberProps["tone"]>, string> = {
  default: "text-ink",
  good: "text-good",
  loss: "text-loss",
  warn: "text-warn",
  muted: "text-muted",
  info: "text-info",
};

/** Tabular monospace wrapper — use for every number, price, hash. */
export function MonoNumber({ children, className, tone = "default" }: MonoNumberProps) {
  return (
    <span className={`mono ${toneClass[tone]} ${className ?? ""}`}>{children}</span>
  );
}
