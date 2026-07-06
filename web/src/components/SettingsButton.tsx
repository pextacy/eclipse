"use client";

import { useEffect, useState } from "react";
import { useSettings, DEFAULT_SETTINGS } from "../lib/settings";
import { useBandBps } from "../lib/market";

/**
 * Header gear → settings modal. Runtime knobs every serious trading UI exposes:
 * a relay endpoint override and the trader's own slippage tolerance (a softer,
 * configurable guard layered on the hard on-chain fairness band).
 */
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const { settings, update, reset } = useSettings();
  const band = useBandBps();

  // Local draft so typing doesn't thrash localStorage / the relay poll.
  const [relay, setRelay] = useState(settings.relayUrl);
  const [slip, setSlip] = useState(String(settings.slippageBps));

  useEffect(() => {
    if (open) {
      setRelay(settings.relayUrl);
      setSlip(String(settings.slippageBps));
    }
  }, [open, settings.relayUrl, settings.slippageBps]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function save() {
    const parsed = Number(slip);
    update({
      relayUrl: relay.trim(),
      slippageBps: Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : DEFAULT_SETTINGS.slippageBps,
    });
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="btn px-2"
        title="Settings"
        aria-label="Settings"
        onClick={() => setOpen(true)}
      >
        ⚙
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-16"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md border border-line-strong bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">Settings</h2>
              <button
                type="button"
                className="mono text-2xs text-muted hover:text-ink"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </header>

            <div className="space-y-4 p-4">
              <div>
                <label className="label mb-1">Relay URL</label>
                <input
                  className="input"
                  placeholder="http://localhost:8787"
                  value={relay}
                  onChange={(e) => setRelay(e.target.value)}
                />
                <p className="mono mt-1 text-2xs text-muted">
                  Where sealed orders are submitted. Overrides the build-time default. Leave blank to
                  use it.
                </p>
              </div>

              <div>
                <label className="label mb-1">Slippage tolerance (bps)</label>
                <div className="flex flex-wrap gap-1">
                  {[10, 20, 30, 50].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setSlip(String(v))}
                      className={`tag px-2.5 py-0.5 ${Number(slip) === v ? "border-eclipse text-eclipse" : "border-line text-muted"}`}
                    >
                      {v}
                    </button>
                  ))}
                  <input
                    className="input w-20 py-0.5 text-2xs"
                    inputMode="numeric"
                    value={slip}
                    onChange={(e) => setSlip(e.target.value)}
                  />
                </div>
                <p className="mono mt-1 text-2xs text-muted">
                  Warns before submitting an order whose limit sits more than this far from the FTSO
                  mid. The chain still enforces its own ±{band} bps band regardless.
                </p>
              </div>
            </div>

            <footer className="flex items-center justify-between border-t border-line px-4 py-3">
              <button
                type="button"
                className="mono text-2xs text-muted hover:text-loss"
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
              >
                reset to defaults
              </button>
              <button type="button" className="btn btn-accent" onClick={save}>
                Save
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
