import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { AddressLink } from "../components/AddressLink";
import { TxLink } from "../components/TxLink";
import { eclipseSettlementAbi } from "../lib/abis";
import { deployment, isConfigured } from "../lib/deployment";
import { ftsoToNumber, fmtNum } from "../lib/format";

interface BatchRow {
  batchId: bigint;
  clearingPrice: bigint;
  ftsoRef: bigint;
  ftsoOnChain: bigint;
  signer: `0x${string}`;
  txHash: `0x${string}`;
}

/**
 * Batch analytics — every settled batch, straight from `BatchSettled` events.
 * Shows the clearing price vs the on-chain FTSO reference over time: the whole
 * fairness guarantee, made visual. No order data is revealed (only aggregates).
 */
export function BatchesView() {
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "empty" | "error">("idle");

  useEffect(() => {
    if (!isConfigured || !publicClient) return;
    let cancelled = false;
    (async () => {
      setState("loading");
      try {
        const latest = await publicClient.getBlockNumber();
        const lookback = 100_000n;
        const fromBlock = latest > lookback ? latest - lookback : 0n;
        const logs = await publicClient.getContractEvents({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          eventName: "BatchSettled",
          fromBlock,
          toBlock: "latest",
        });
        if (cancelled) return;
        const mapped = logs.map((l) => ({
          batchId: l.args.batchId ?? 0n,
          clearingPrice: l.args.clearingPrice ?? 0n,
          ftsoRef: l.args.ftsoRef ?? 0n,
          ftsoOnChain: l.args.ftsoOnChain ?? 0n,
          signer: (l.args.signer ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          txHash: l.transactionHash,
        }));
        setRows(mapped);
        setState(mapped.length === 0 ? "empty" : "idle");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  const recent = rows.slice(-30);
  const worstDev = rows.reduce((m, r) => {
    const ref = ftsoToNumber(r.ftsoOnChain);
    const dev = ref > 0 ? Math.abs((ftsoToNumber(r.clearingPrice) - ref) / ref) * 10_000 : 0;
    return Math.max(m, dev);
  }, 0);

  return (
    <div className="space-y-6">
      <div className="border border-line bg-panel px-5 py-4">
        <h1 className="text-base font-semibold tracking-wide text-ink">
          Every batch, provably fair — over time
        </h1>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Each dot is a settled batch. The clearing price (green) is plotted against the on-chain
          FTSO reference (blue) the contract re-read in the same transaction. Nothing about any order
          is shown — only the public aggregates that prove fairness.
        </p>
      </div>

      {!isConfigured ? (
        <NotConfigured />
      ) : state === "loading" ? (
        <Panel title="Batch history">
          <p className="mono text-2xs text-muted">scanning chain for BatchSettled…</p>
        </Panel>
      ) : state === "error" ? (
        <Panel title="Batch history">
          <p className="mono text-2xs text-warn">could not read logs from RPC (range/limit).</p>
        </Panel>
      ) : state === "empty" ? (
        <Panel title="Batch history">
          <p className="mono text-2xs text-muted">
            no BatchSettled events yet — run a demo batch, then watch them appear here.
          </p>
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Batches settled" value={rows.length.toString()} tone="good" />
            <StatTile
              label="Latest clearing"
              value={fmtNum(ftsoToNumber(recent[recent.length - 1]!.clearingPrice), 5)}
              sub="XRP/USD"
              tone="good"
            />
            <StatTile
              label="Latest FTSO (on-chain)"
              value={fmtNum(ftsoToNumber(recent[recent.length - 1]!.ftsoOnChain), 5)}
              sub="re-read in settle tx"
              tone="info"
            />
            <StatTile
              label="Worst deviation"
              value={`${fmtNum(worstDev, 2)} bps`}
              sub="clearing vs FTSO, all batches"
              tone={worstDev > deployment.bandBps ? "loss" : "good"}
            />
          </div>

          <Panel title="Clearing price vs FTSO reference" subtitle="last 30 batches">
            <FairnessChart rows={recent} />
          </Panel>

          <Panel title="Settled batches" subtitle={`${rows.length} total`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-2xs uppercase tracking-wide text-muted">
                    <Th>Batch</Th>
                    <Th>Clearing</Th>
                    <Th>FTSO on-chain</Th>
                    <Th>Deviation</Th>
                    <Th>Signer</Th>
                    <Th>Tx</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => {
                    const ref = ftsoToNumber(r.ftsoOnChain);
                    const dev = ref > 0 ? Math.abs((ftsoToNumber(r.clearingPrice) - ref) / ref) * 10_000 : 0;
                    const bad = dev > deployment.bandBps;
                    return (
                      <tr key={r.txHash} className="border-t border-line">
                        <Td>#{r.batchId.toString()}</Td>
                        <Td>{fmtNum(ftsoToNumber(r.clearingPrice), 5)}</Td>
                        <Td>{fmtNum(ref, 5)}</Td>
                        <Td>
                          <span className={bad ? "text-loss" : "text-good"}>{fmtNum(dev, 2)} bps</span>
                        </Td>
                        <Td>
                          <AddressLink address={r.signer} showCopy={false} />
                        </Td>
                        <Td>
                          <TxLink hash={r.txHash} showCopy={false} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/** Flat SVG scatter of clearing vs FTSO across batches. Solid marks, no gradient. */
function FairnessChart({ rows }: { rows: BatchRow[] }) {
  const clearing = rows.map((r) => ftsoToNumber(r.clearingPrice));
  const ftso = rows.map((r) => ftsoToNumber(r.ftsoOnChain));
  const all = [...clearing, ...ftso].filter((n) => n > 0);
  if (all.length === 0) return null;
  const min = Math.min(...all) * 0.999;
  const max = Math.max(...all) * 1.001;
  const W = 640;
  const H = 180;
  const padX = 12;
  const n = rows.length;
  const x = (i: number) => padX + (n <= 1 ? 0 : (i * (W - 2 * padX)) / (n - 1));
  const y = (p: number) => H - 14 - ((p - min) / (max - min || 1)) * (H - 28);
  const line = (vals: number[]) => vals.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Clearing vs FTSO">
      <line x1={0} y1={H - 14} x2={W} y2={H - 14} stroke="#232a35" strokeWidth={1} />
      <path d={line(ftso)} fill="none" stroke="#4aa8ff" strokeWidth={1.5} />
      <path d={line(clearing)} fill="none" stroke="#22d3aa" strokeWidth={1.5} />
      {clearing.map((p, i) => (
        <circle key={`c${i}`} cx={x(i)} cy={y(p)} r={2.4} fill="#22d3aa" />
      ))}
      {ftso.map((p, i) => (
        <circle key={`f${i}`} cx={x(i)} cy={y(p)} r={2.4} fill="#4aa8ff" />
      ))}
      <text x={padX} y={12} fontSize={10} fontFamily="ui-monospace, monospace" fill="#22d3aa">
        clearing
      </text>
      <text x={padX + 64} y={12} fontSize={10} fontFamily="ui-monospace, monospace" fill="#4aa8ff">
        FTSO on-chain
      </text>
    </svg>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1.5 font-normal">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="mono px-2 py-1.5 text-subtle">{children}</td>;
}
function NotConfigured() {
  return (
    <div className="border border-warn bg-panel px-5 py-4">
      <div className="mb-1 text-sm font-semibold text-warn">No deployment configured</div>
      <p className="max-w-2xl text-xs text-muted">
        Point the app at a deployed EclipseSettlement (via <span className="mono">NEXT_PUBLIC_*</span>{" "}
        env) and settled batches will chart here live.
      </p>
    </div>
  );
}
