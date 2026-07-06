"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import { Tabs, type TabDef } from "./components/Tabs";
import { ConnectWallet } from "./components/ConnectWallet";
import { AddressLink } from "./components/AddressLink";
import { TraderConsole } from "./views/TraderConsole";
import { ComparisonView } from "./views/ComparisonView";
import { VerifierPanel } from "./views/VerifierPanel";
import { BatchesView } from "./views/BatchesView";
import { PortfolioView } from "./views/PortfolioView";
import { OverviewView } from "./views/OverviewView";
import { MarketBar } from "./components/MarketBar";
import { SettingsButton } from "./components/SettingsButton";
import { eclipseSettlementAbi } from "./lib/abis";
import { deployment, isConfigured } from "./lib/deployment";

/** Global banner shown when the guardian has halted matching (custody stays open). */
function TradingPausedBanner() {
  const paused = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "tradingPaused",
    query: { enabled: isConfigured, refetchInterval: 12000 },
  });
  if (paused.data !== true) return null;
  return (
    <div className="border-b border-warn bg-loss-dim px-5 py-2 text-center text-xs text-warn">
      ⚠ Trading is paused by the guardian — new batches are halted. Your escrow is unaffected:
      deposits, withdrawals and expired-leg release stay open.
    </div>
  );
}

const TABS: TabDef[] = [
  { id: "compare", label: "Comparison", hint: "why it matters" },
  { id: "overview", label: "Overview", hint: "at a glance" },
  { id: "trade", label: "Trader Console", hint: "seal & settle" },
  { id: "portfolio", label: "Portfolio", hint: "position & P&L" },
  { id: "batches", label: "Batches", hint: "fair over time" },
  { id: "verify", label: "Verifier", hint: "prove it" },
];

export function App() {
  const [tab, setTab] = useState<string>("compare");

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-surface px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-6 w-6 items-center justify-center border border-eclipse bg-eclipse-dim">
            <div className="h-2.5 w-2.5 rounded-full bg-eclipse" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide text-ink">
              ECLIPSE
              <span className="ml-2 font-normal text-muted">confidential dark pool · FXRP</span>
            </div>
            <div className="mono text-2xs text-muted">
              Flare Coston2 · chain 114 · sealed orders · FTSO-fair uniform clearing
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="tag border-line-strong text-muted">
            settlement&nbsp;
            {isConfigured ? (
              <AddressLink address={deployment.eclipseSettlement} showCopy={false} />
            ) : (
              <span className="mono text-warn">not configured</span>
            )}
          </span>
          <ConnectWallet />
          <SettingsButton />
        </div>
      </header>

      <MarketBar />

      <TradingPausedBanner />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-6">
        {tab === "compare" && <ComparisonView />}
        {tab === "overview" && <OverviewView onNavigate={setTab} />}
        {tab === "trade" && <TraderConsole />}
        {tab === "portfolio" && <PortfolioView />}
        {tab === "batches" && <BatchesView />}
        {tab === "verify" && <VerifierPanel />}
      </main>

      <footer className="border-t border-line bg-surface px-5 py-2.5">
        <div className="mono flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
          <span>eclipse@0.1.0</span>
          <span>·</span>
          <span>RPC coston2-api.flare.network</span>
          <span>·</span>
          <span>
            explorer{" "}
            <a
              href="https://coston2-explorer.flare.network"
              target="_blank"
              rel="noreferrer"
              className="text-info hover:text-eclipse"
            >
              coston2-explorer.flare.network
            </a>
          </span>
          <span>·</span>
          <span>orders sealed client-side (crypto_box_seal) — the relay never sees plaintext</span>
        </div>
      </footer>
    </div>
  );
}
