"use client";

import { useEffect, useState } from "react";

const SEEN_KEY = "eclipse.help.seen.v1";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Deposit collateral",
    body: "Escrow real FXRP and a USDT0-style quote token into EclipseSettlement. Idle escrow is withdrawable at any time — no admin key can seize it.",
  },
  {
    title: "Submit a sealed order",
    body: "Your limit order is encrypted client-side (crypto_box_seal) before it leaves the browser. The relay only ever sees ciphertext — side, size and price stay hidden.",
  },
  {
    title: "The TEE clears a batch",
    body: "An attested Confidential-Compute build matches orders at a single uniform price and signs only the NET per-account deltas. Individual orders never touch the chain.",
  },
  {
    title: "FTSO-bounded net settlement",
    body: "The contract re-reads the live FTSO XRP/USD feed in the settle tx and rejects any clearing price outside ±band. Only the net result settles — nothing to front-run.",
  },
  {
    title: "Anyone can verify",
    body: "Every settlement proves on-chain that it was signed by a whitelisted, reproducible-build code-hash and cleared in-band — without revealing a single order.",
  },
];

/**
 * First-run onboarding / help overlay. Explains the sealed-order → batch →
 * net-settlement flow that makes Eclipse different from a public DEX. Auto-opens
 * once per browser, re-openable from the header "?".
 */
export function HelpOverlay() {
  const [open, setOpen] = useState(false);

  // Auto-open on first visit only.
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      /* storage disabled — just don't auto-open */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn px-2"
        title="How Eclipse works"
        aria-label="Help"
        onClick={() => setOpen(true)}
      >
        ?
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-12" onClick={close}>
          <div className="w-full max-w-lg border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center justify-between border-b border-line px-5 py-3">
              <div>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  How Eclipse works
                  <span className="ml-2 font-normal text-muted">confidential dark pool · FXRP</span>
                </h2>
              </div>
              <button type="button" className="mono text-2xs text-muted hover:text-ink" onClick={close} aria-label="Close">
                ✕
              </button>
            </header>

            <ol className="space-y-3 p-5">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="mono flex h-5 w-5 shrink-0 items-center justify-center border border-eclipse bg-eclipse-dim text-2xs text-eclipse">
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-ink">{s.title}</div>
                    <p className="mt-0.5 text-2xs text-muted">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <footer className="flex items-center justify-between border-t border-line px-5 py-3">
              <span className="mono text-2xs text-muted">tip: keys 1–6 switch tabs</span>
              <button type="button" className="btn btn-accent" onClick={close}>
                Got it
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
