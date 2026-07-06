"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { explorerTx } from "../lib/format";
import { truncateHex } from "../lib/format";

export type ToastKind = "pending" | "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  txHash?: `0x${string}`;
}

interface ToastApi {
  /** Show a toast; returns its id so it can be updated (e.g. pending → success). */
  push: (t: Omit<Toast, "id"> & { id?: string; autoDismissMs?: number }) => string;
  /** Patch an existing toast in place. */
  update: (id: string, patch: Partial<Omit<Toast, "id">> & { autoDismissMs?: number }) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** App-wide transaction/status toasts. Wrap the app once, read via useToast(). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const seq = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((ts) => ts.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const scheduleDismiss = useCallback(
    (id: string, ms?: number) => {
      if (!ms || ms <= 0) return;
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [clearTimer, dismiss],
  );

  const push = useCallback<ToastApi["push"]>(
    ({ id, autoDismissMs, ...rest }) => {
      // Avoid Math.random / Date.now for the id (deterministic, SSR-safe counter).
      const toastId = id ?? `t${++seq.current}`;
      setToasts((ts) => {
        const existing = ts.find((t) => t.id === toastId);
        if (existing) return ts.map((t) => (t.id === toastId ? { ...t, ...rest, id: toastId } : t));
        return [...ts, { ...rest, id: toastId }];
      });
      scheduleDismiss(toastId, autoDismissMs);
      return toastId;
    },
    [scheduleDismiss],
  );

  const update = useCallback<ToastApi["update"]>(
    (id, { autoDismissMs, ...patch }) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      scheduleDismiss(id, autoDismissMs);
    },
    [scheduleDismiss],
  );

  return (
    <ToastContext.Provider value={{ push, update, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const KIND_STYLE: Record<ToastKind, { border: string; dot: string; label: string }> = {
  pending: { border: "border-info", dot: "bg-info animate-pulse", label: "text-info" },
  success: { border: "border-good", dot: "bg-good", label: "text-good" },
  error: { border: "border-loss", dot: "bg-loss", label: "text-loss" },
  info: { border: "border-line-strong", dot: "bg-muted", label: "text-subtle" },
};

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,360px)] flex-col gap-2">
      {toasts.map((t) => {
        const s = KIND_STYLE[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto border ${s.border} bg-panel px-3 py-2.5 shadow-lg`}
            role="status"
          >
            <div className="flex items-start gap-2">
              <span className={`mt-1 inline-block h-2 w-2 shrink-0 ${s.dot}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-xs font-semibold ${s.label}`}>{t.title}</div>
                {t.message && <div className="mono mt-0.5 break-words text-2xs text-muted">{t.message}</div>}
                {t.txHash && (
                  <a
                    href={explorerTx(t.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono mt-1 inline-block text-2xs text-info hover:text-eclipse"
                  >
                    tx {truncateHex(t.txHash, 10, 8)} ↗
                  </a>
                )}
              </div>
              <button
                type="button"
                className="mono shrink-0 text-2xs text-muted hover:text-ink"
                onClick={() => onDismiss(t.id)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
