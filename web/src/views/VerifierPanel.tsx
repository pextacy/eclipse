import { useEffect, useState } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { MonoNumber } from "../components/MonoNumber";
import { AddressLink } from "../components/AddressLink";
import { TxLink } from "../components/TxLink";
import { eclipseSettlementAbi, eclipseRegistryAbi } from "../lib/abis";
import { deployment, isConfigured } from "../lib/deployment";
import { truncateHex, ftsoToNumber, fmtNum } from "../lib/format";
import { SystemStatus } from "../components/SystemStatus";

interface LatestBatch {
  batchId: bigint;
  clearingPrice: bigint;
  ftsoRef: bigint;
  ftsoOnChain: bigint;
  signer: `0x${string}`;
  txHash: `0x${string}`;
}

export function VerifierPanel() {
  const publicClient = usePublicClient();
  const [batch, setBatch] = useState<LatestBatch | null>(null);
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
        const last = logs.at(-1);
        if (!last) {
          setState("empty");
          setBatch(null);
          return;
        }
        setBatch({
          batchId: last.args.batchId ?? 0n,
          clearingPrice: last.args.clearingPrice ?? 0n,
          ftsoRef: last.args.ftsoRef ?? 0n,
          ftsoOnChain: last.args.ftsoOnChain ?? 0n,
          signer: (last.args.signer ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          txHash: last.transactionHash,
        });
        setState("idle");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  const signer = batch?.signer;

  // Fairness parameters read straight from the settlement contract — not from
  // client config — so the verdict reflects what the chain actually enforces.
  const bandOnChain = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "bandBps",
    query: { enabled: isConfigured },
  });
  const feedIdOnChain = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "xrpUsdFeedId",
    query: { enabled: isConfigured },
  });

  const codeHash = useReadContract({
    address: deployment.eclipseRegistry,
    abi: eclipseRegistryAbi,
    functionName: "codeHashOf",
    args: signer ? [signer] : undefined,
    query: { enabled: isConfigured && !!signer },
  });
  const authorized = useReadContract({
    address: deployment.eclipseRegistry,
    abi: eclipseRegistryAbi,
    functionName: "isAuthorized",
    args: signer ? [signer] : undefined,
    query: { enabled: isConfigured && !!signer },
  });

  // Prefer the on-chain immutables; fall back to config only until they load.
  const band = typeof bandOnChain.data === "bigint" ? Number(bandOnChain.data) : deployment.bandBps;
  const feedId =
    typeof feedIdOnChain.data === "string" ? feedIdOnChain.data : deployment.feedId;
  const ref = batch ? ftsoToNumber(batch.ftsoRef) : 0;
  const onChain = batch ? ftsoToNumber(batch.ftsoOnChain) : 0;
  const clearing = batch ? ftsoToNumber(batch.clearingPrice) : 0;
  // Deviation is measured against the value the contract re-read in the settle
  // tx (ftsoOnChain), which is exactly what the band check used.
  const deviationBps =
    onChain > 0 && batch ? Math.abs((clearing - onChain) / onChain) * 10_000 : 0;
  const insideBand = batch ? deviationBps <= band : false;
  const isAuthorized = authorized.data === true;
  const codeHashHex = typeof codeHash.data === "string" ? codeHash.data : undefined;

  return (
    <div className="space-y-6">
      <div className="border border-line bg-panel px-5 py-4">
        <h1 className="text-base font-semibold tracking-wide text-ink">
          Anyone can verify — without special access
        </h1>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Every settlement is public and self-verifying. This proves two things straight from chain
          state, revealing no order: (a) the settlement was signed by an{" "}
          <span className="text-eclipse">attested, whitelisted TEE build</span> (the signer maps to a
          registered reproducible-build code-hash), and (b) the clearing price was{" "}
          <span className="text-eclipse">inside the FTSO fairness band</span> re-checked on-chain in
          the same transaction.
        </p>
      </div>

      {!isConfigured ? (
        <div className="border border-warn bg-panel px-5 py-4">
          <div className="mb-1 text-sm font-semibold text-warn">No deployment configured</div>
          <p className="max-w-2xl text-xs text-muted">
            Point the app at a deployed EclipseSettlement + EclipseRegistry (via{" "}
            <span className="mono text-subtle">deployments/coston2.json</span> or the{" "}
            <span className="mono text-subtle">VITE_ECLIPSE_SETTLEMENT / VITE_ECLIPSE_REGISTRY</span>{" "}
            env vars) and the latest settlement will be verified here live.
          </p>
        </div>
      ) : (
        <>
          <SystemStatus />

          {state === "loading" && (
            <Panel title="Latest settlement">
              <p className="mono text-2xs text-muted">scanning chain for BatchSettled…</p>
            </Panel>
          )}
          {state === "error" && (
            <Panel title="Latest settlement">
              <p className="mono text-2xs text-warn">could not read logs from RPC (range/limit).</p>
            </Panel>
          )}
          {state === "empty" && (
            <Panel title="Latest settlement">
              <p className="mono text-2xs text-muted">
                no BatchSettled events yet — run a demo batch, then verify it here.
              </p>
            </Panel>
          )}

          {batch && (
            <>
              <Panel
                title="Latest settlement"
                subtitle={<>batch #{batch.batchId.toString()}</>}
                actions={<TxLink hash={batch.txHash} />}
              >
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatTile label="Batch id" value={<>#{batch.batchId.toString()}</>} />
                  <StatTile
                    label="Clearing price"
                    value={fmtNum(clearing, 5)}
                    sub="XRP/USD (FTSO scale)"
                    tone="good"
                  />
                  <StatTile label="FTSO ref (engine)" value={fmtNum(ref, 5)} sub="engine-read" />
                  <StatTile
                    label="FTSO on-chain"
                    value={fmtNum(onChain, 5)}
                    sub="re-read in settle tx"
                    tone="info"
                  />
                </div>
              </Panel>

              <div className="grid gap-6 lg:grid-cols-2">
                {/* Proof A: attested signer */}
                <Panel
                  title="Proof A — attested, whitelisted signer"
                  actions={
                    <span className={`tag ${isAuthorized ? "border-eclipse text-eclipse" : "border-loss text-loss"}`}>
                      {authorized.isLoading ? "checking…" : isAuthorized ? "authorized" : "NOT authorized"}
                    </span>
                  }
                >
                  <dl className="space-y-2 text-xs">
                    <Field label="Settlement signer">
                      <AddressLink address={batch.signer} />
                    </Field>
                    <Field label="registry.isAuthorized(signer)">
                      <MonoNumber tone={isAuthorized ? "good" : "loss"}>
                        {authorized.isLoading ? "…" : String(isAuthorized)}
                      </MonoNumber>
                    </Field>
                    <Field label="registry.codeHashOf(signer)">
                      {codeHash.isLoading ? (
                        <MonoNumber tone="muted">…</MonoNumber>
                      ) : codeHashHex ? (
                        <span title={codeHashHex}>
                          <MonoNumber tone="good">{truncateHex(codeHashHex, 10, 8)}</MonoNumber>
                        </span>
                      ) : (
                        <MonoNumber tone="muted">—</MonoNumber>
                      )}
                    </Field>
                    <Field label="Registry contract">
                      <AddressLink address={deployment.eclipseRegistry} />
                    </Field>
                  </dl>
                  <p className="mt-3 border-t border-line pt-2 text-2xs text-muted">
                    The signer is bound to a reproducible-build code-hash registered in
                    EclipseRegistry. Only an enclave running that exact attested build can produce a
                    signature the settlement contract accepts.
                  </p>
                </Panel>

                {/* Proof B: FTSO band */}
                <Panel
                  title="Proof B — price inside the FTSO band"
                  actions={
                    <span className={`tag ${insideBand ? "border-eclipse text-eclipse" : "border-loss text-loss"}`}>
                      {insideBand ? "inside band" : "out of band"}
                    </span>
                  }
                >
                  <dl className="space-y-2 text-xs">
                    <Field label="Fairness band">
                      <MonoNumber>±{band} bps ({(band / 100).toFixed(2)}%)</MonoNumber>
                    </Field>
                    <Field label="Clearing vs FTSO deviation">
                      <MonoNumber tone={insideBand ? "good" : "loss"}>
                        {fmtNum(deviationBps, 2)} bps
                      </MonoNumber>
                    </Field>
                    <Field label="FTSO on-chain (settle tx)">
                      <MonoNumber tone="info">{fmtNum(onChain, 5)}</MonoNumber>
                    </Field>
                    <Field label="XRP/USD feed id">
                      <span title={feedId}>
                        <MonoNumber tone="muted">{truncateHex(feedId, 10, 8)}</MonoNumber>
                      </span>
                    </Field>
                  </dl>
                  <p className="mt-3 border-t border-line pt-2 text-2xs text-muted">
                    The settlement contract re-reads the FTSO XRP/USD feed in the same transaction and
                    rejects any clearing price outside ±{band} bps — so the uniform price is provably
                    fair without revealing any order.
                  </p>
                </Panel>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
