import { useAccount } from "wagmi";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { TxLink } from "../components/TxLink";
import { deployment, isConfigured } from "../lib/deployment";
import { usePortfolio } from "../lib/portfolio";
import { formatUnits, fmtNum, fmtUsd } from "../lib/format";

/**
 * Portfolio & P&L, derived entirely from public, per-account chain data via the
 * shared usePortfolio() hook (see lib/portfolio.ts for the escrow-accounting
 * derivation). No order data is ever needed — only the trader's own escrow and
 * deposit/withdraw events.
 */
export function PortfolioView() {
  const { address, isConnected } = useAccount();
  const p = usePortfolio(address);

  if (!isConfigured) {
    return (
      <div className="border border-warn bg-panel px-5 py-4">
        <div className="mb-1 text-sm font-semibold text-warn">Deployment not configured</div>
        <p className="max-w-2xl text-xs text-muted">
          Portfolio & P&L read live from EclipseSettlement. They light up once the app is pointed at a
          deployed contract.
        </p>
      </div>
    );
  }
  if (!isConnected || !address) {
    return (
      <div className="border border-line bg-panel px-4 py-3 text-sm text-subtle">
        Connect a wallet to see your position, realized flow through the pool, and mark-to-market P&L.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Panel title="Position" subtitle="Net effect of every batch fill, derived from escrow accounting">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label={`Net ${p.fxrp.symbol} traded`}
            value={`${p.fxrpTradedNum >= 0 ? "+" : ""}${fmtNum(p.fxrpTradedNum, 2)}`}
            sub={p.fxrpTradedNum >= 0 ? "acquired via pool" : "sold via pool"}
            tone={p.fxrpTradedNum >= 0 ? "good" : "loss"}
          />
          <StatTile
            label={`Net ${p.usdt0.symbol} flow`}
            value={`${p.usdt0TradedNum >= 0 ? "+" : ""}${fmtNum(p.usdt0TradedNum, 2)}`}
            sub={p.usdt0TradedNum >= 0 ? "received" : "spent"}
            tone={p.usdt0TradedNum >= 0 ? "good" : "loss"}
          />
          <StatTile
            label="Avg execution"
            value={p.hasPosition ? fmtNum(p.avgPrice, 5) : "—"}
            sub="XRP/USD (pool fills)"
            tone="info"
          />
          <StatTile
            label="Live FTSO mid"
            value={p.midPrice > 0 ? fmtNum(p.midPrice, 5) : "…"}
            sub="mark price"
          />
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Mark-to-market" subtitle="Net FXRP position valued at the live oracle mid">
          {p.hasPosition ? (
            <dl className="space-y-2 text-xs">
              <Row label={`Position (${p.fxrp.symbol})`}>
                {`${p.fxrpTradedNum >= 0 ? "+" : ""}${fmtNum(p.fxrpTradedNum, 2)}`}
              </Row>
              <Row label="Cost basis (USDT0 spent)">{fmtUsd(p.costBasis)}</Row>
              <Row label="Mark value @ mid">{fmtUsd(p.markValue)}</Row>
              <div className="border-t border-line pt-2">
                <Row label="Unrealized P&L">
                  <span className={p.unrealized >= 0 ? "text-good" : "text-loss"}>
                    {p.unrealized >= 0 ? "+" : ""}
                    {fmtUsd(p.unrealized)}
                  </span>
                </Row>
              </div>
              <p className="pt-1 text-2xs text-muted">
                P&L is mark-to-oracle: your realized USDT0 flow vs your net FXRP marked at the current
                FTSO mid. It ignores fees (there are none in the settlement path) and any FXRP still
                held outside escrow.
              </p>
            </dl>
          ) : (
            <p className="mono text-2xs text-muted">
              no net pool position yet — once a batch fills your order, your net traded size, average
              execution and mark-to-market P&L appear here.
            </p>
          )}
        </Panel>

        <Panel title="Escrow vs external flow" subtitle="How the position reconciles">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-2xs">
              <thead>
                <tr className="text-muted">
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">token</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">deposited−withdrawn</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">in escrow</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">traded (Δ)</th>
                </tr>
              </thead>
              <tbody className="mono text-subtle">
                <ReconRow
                  sym={p.fxrp.symbol}
                  ext={p.fxrpExternal}
                  escrow={p.fxrpEscrow}
                  traded={p.fxrpTraded}
                  decimals={p.fxrp.decimals}
                />
                <ReconRow
                  sym={p.usdt0.symbol}
                  ext={p.usdt0External}
                  escrow={p.usdt0Escrow}
                  traded={p.usdt0Traded}
                  decimals={p.usdt0.decimals}
                />
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel
        title="Collateral activity"
        subtitle="Your Deposited / Withdrawn events"
        actions={<span className="tag border-line-strong text-muted">{p.flows.length} shown</span>}
      >
        {p.state === "loading" && <p className="mono text-2xs text-muted">loading your events…</p>}
        {p.state === "error" && (
          <p className="mono text-2xs text-warn">could not read logs from RPC (range/limit).</p>
        )}
        {p.state === "empty" && (
          <p className="mono text-2xs text-muted">no deposits or withdrawals yet.</p>
        )}
        {p.flows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-2xs">
              <thead>
                <tr className="text-muted">
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">action</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">token</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">amount</th>
                  <th className="px-2 py-1.5 font-normal uppercase tracking-wide">tx</th>
                </tr>
              </thead>
              <tbody className="mono">
                {p.flows.slice(0, 20).map((f, i) => {
                  const isFxrp = f.token.toLowerCase() === deployment.fxrp.toLowerCase();
                  const meta = isFxrp ? p.fxrp : p.usdt0;
                  return (
                    <tr key={`${f.txHash}-${i}`} className="border-t border-line">
                      <td className="px-2 py-1.5">
                        <span className={f.kind === "deposit" ? "text-good" : "text-warn"}>
                          {f.kind === "deposit" ? "DEPOSIT" : "WITHDRAW"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-subtle">{meta.symbol}</td>
                      <td className="px-2 py-1.5 text-subtle">
                        {formatUnits(f.amount, meta.decimals)}
                      </td>
                      <td className="px-2 py-1.5">
                        <TxLink hash={f.txHash} showCopy={false} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ReconRow({
  sym,
  ext,
  escrow,
  traded,
  decimals,
}: {
  sym: string;
  ext: bigint;
  escrow: bigint;
  traded: bigint;
  decimals: number;
}) {
  return (
    <tr className="border-t border-line">
      <td className="px-2 py-1.5">{sym}</td>
      <td className="px-2 py-1.5">{signedUnits(ext, decimals)}</td>
      <td className="px-2 py-1.5">{formatUnits(escrow, decimals)}</td>
      <td className={`px-2 py-1.5 ${traded >= 0n ? "text-good" : "text-loss"}`}>
        {signedUnits(traded, decimals)}
      </td>
    </tr>
  );
}

function signedUnits(v: bigint, decimals: number): string {
  const s = formatUnits(v < 0n ? -v : v, decimals);
  return v < 0n ? `-${s}` : v > 0n ? `+${s}` : s;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}
