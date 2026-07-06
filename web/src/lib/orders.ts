import { useCallback, useEffect, useState } from "react";
import { Side } from "@eclipse/shared";

/**
 * Client-side order blotter — deliberately local-only.
 *
 * Eclipse's whole point is that the order book never leaks: the relay hides pool
 * size and reveals nothing per-order, and settlement is net-only. So we CANNOT
 * (and must not) ask a server "did my order fill?" — that would reconstruct the
 * very side channel the design closes. Instead each browser remembers the orders
 * IT submitted in localStorage and infers status from public signals the trader
 * is already entitled to: the wall clock (expiry) and the trader's own escrow /
 * the public BatchSettled batch id. Nothing here is shared or correlatable by an
 * outsider.
 */

export type OrderStatus = "sealed" | "filled" | "expired";

export interface TrackedOrder {
  submissionId: string;
  account: string;
  side: Side;
  /** Human-readable amounts as entered. */
  baseAmount: string;
  limitPrice: string;
  createdAt: number; // unix seconds
  expiry: number; // unix seconds
  /** Latest settled batch id known at submit time (snapshot for correlation). */
  sinceBatchId: string;
  /** Combined escrow (fxrp+usdt0 base units) snapshot at submit, as a string. */
  escrowSnapshot: string;
  /** Set once we infer the order cleared. */
  filledBatchId?: string;
}

const KEY = "eclipse.orders.v1";
const MAX_PER_ACCOUNT = 50;

/** Validate one persisted record's shape. Corrupt/foreign localStorage entries
 *  (extension, shared machine, schema drift) must not crash the blotter render,
 *  which calls o.account.toLowerCase(), Number(o.baseAmount), o.expiry - now,
 *  etc. (Audit web M2.) */
function isTrackedOrder(o: unknown): o is TrackedOrder {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.submissionId === "string" &&
    typeof r.account === "string" &&
    (r.side === Side.Buy || r.side === Side.Sell) &&
    typeof r.baseAmount === "string" &&
    typeof r.limitPrice === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.expiry === "number" &&
    typeof r.sinceBatchId === "string" &&
    typeof r.escrowSnapshot === "string" &&
    (r.filledBatchId === undefined || typeof r.filledBatchId === "string")
  );
}

function load(): TrackedOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Drop any element that doesn't match the shape instead of trusting the cast.
    return Array.isArray(parsed) ? parsed.filter(isTrackedOrder) : [];
  } catch {
    return [];
  }
}

function persist(orders: TrackedOrder[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(orders));
  } catch {
    /* quota / disabled storage — the blotter is best-effort */
  }
  // Notify other hook instances in the same tab.
  window.dispatchEvent(new Event("eclipse-orders-changed"));
}

/** Derive a live status from public signals the trader already has access to. */
export function deriveStatus(
  o: TrackedOrder,
  ctx: { nowSec: number; latestBatchId: bigint; currentEscrow: bigint },
): OrderStatus {
  if (o.filledBatchId) return "filled";
  // A batch newer than the one at submit ran AND the trader's escrow moved →
  // this order (net) settled. Escrow moving is the trader's own private proof.
  const snapshot = safeBig(o.escrowSnapshot);
  const since = safeBig(o.sinceBatchId);
  const newerBatch = ctx.latestBatchId > since;
  if (newerBatch && ctx.currentEscrow !== snapshot) return "filled";
  if (ctx.nowSec > o.expiry) return "expired";
  return "sealed";
}

function safeBig(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** React hook over the local blotter, scoped to one account. */
export function useTrackedOrders(account?: string) {
  const [orders, setOrders] = useState<TrackedOrder[]>([]);

  const refresh = useCallback(() => {
    const all = load();
    setOrders(
      account
        ? all.filter((o) => o.account.toLowerCase() === account.toLowerCase())
        : [],
    );
  }, [account]);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("eclipse-orders-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("eclipse-orders-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  const record = useCallback((o: TrackedOrder) => {
    const all = load();
    all.unshift(o);
    // Cap per-account history so storage can't grow without bound.
    const byAccount = new Map<string, number>();
    const trimmed = all.filter((x) => {
      const k = x.account.toLowerCase();
      const n = (byAccount.get(k) ?? 0) + 1;
      byAccount.set(k, n);
      return n <= MAX_PER_ACCOUNT;
    });
    persist(trimmed);
  }, []);

  /** Persist an inferred fill so it sticks even after escrow changes again. */
  const markFilled = useCallback((submissionId: string, batchId: string) => {
    const all = load();
    let changed = false;
    for (const o of all) {
      if (o.submissionId === submissionId && !o.filledBatchId) {
        o.filledBatchId = batchId;
        changed = true;
      }
    }
    if (changed) persist(all);
  }, []);

  const clear = useCallback(() => {
    if (!account) return;
    const all = load().filter((o) => o.account.toLowerCase() !== account.toLowerCase());
    persist(all);
  }, [account]);

  return { orders, record, markFilled, clear, refresh };
}
