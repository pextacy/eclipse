"use client";

import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { Panel } from "./Panel";
import { AddressLink } from "./AddressLink";
import { MonoNumber } from "./MonoNumber";
import { eclipseRegistryAbi } from "../lib/abis";
import { deployment, isConfigured, relayUrl } from "../lib/deployment";
import { useBatchStatus } from "../lib/market";
import { truncateHex } from "../lib/format";

interface EnginePubkey {
  publicKey: string;
  signerAddress: `0x${string}`;
}

/**
 * Operational health at a glance: is the relay reachable, which attested engine
 * signer is live, is that signer bound to a whitelisted code-hash, and what is
 * the batch cadence. Consolidates the "is the system up right now" question the
 * Verifier tab (which proves a past settlement) doesn't answer.
 */
export function SystemStatus() {
  const [engine, setEngine] = useState<EnginePubkey | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const batch = useBatchStatus();

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${relayUrl()}/engine/pubkey`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as EnginePubkey;
        if (!cancelled) {
          setEngine(data);
          setOnline(true);
        }
      } catch {
        if (!cancelled) {
          setOnline(false);
        }
      }
    };
    void poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const signer = engine?.signerAddress;
  const authorized = useReadContract({
    address: deployment.eclipseRegistry,
    abi: eclipseRegistryAbi,
    functionName: "isAuthorized",
    args: signer ? [signer] : undefined,
    query: { enabled: isConfigured && !!signer },
  });
  const codeHash = useReadContract({
    address: deployment.eclipseRegistry,
    abi: eclipseRegistryAbi,
    functionName: "codeHashOf",
    args: signer ? [signer] : undefined,
    query: { enabled: isConfigured && !!signer },
  });
  const isAuthorized = authorized.data === true;
  const codeHashHex = typeof codeHash.data === "string" ? codeHash.data : undefined;

  return (
    <Panel title="System status" subtitle="Live operational health of the relay, engine and attestation">
      <div className="space-y-2 text-xs">
        <StatusRow
          label="Relay"
          ok={online === true}
          pending={online === null}
          value={online === null ? "checking…" : online ? "online" : "offline"}
          detail={relayUrl()}
        />
        <StatusRow
          label="Engine signer"
          ok={!!signer}
          pending={online === null}
          value={signer ? <AddressLink address={signer} showCopy={false} /> : online ? "unpublished" : "—"}
        />
        <StatusRow
          label="Attested build"
          ok={isAuthorized}
          pending={!!signer && authorized.isLoading}
          value={
            !signer
              ? "—"
              : authorized.isLoading
                ? "checking…"
                : isAuthorized
                  ? "whitelisted code-hash"
                  : "NOT authorized"
          }
          detail={codeHashHex ? truncateHex(codeHashHex, 10, 8) : undefined}
        />
        <StatusRow
          label="Engine sealed-box key"
          ok={!!engine?.publicKey}
          pending={online === null}
          value={
            engine?.publicKey ? (
              <MonoNumber tone="muted">{truncateHex(engine.publicKey, 8, 6)}</MonoNumber>
            ) : (
              "—"
            )
          }
        />
        <StatusRow
          label="Batch cadence"
          ok={batch.online}
          pending={false}
          value={
            batch.online
              ? batch.autoClose
                ? `auto · every ${batch.intervalSeconds}s`
                : "operator-closed"
              : "relay offline"
          }
        />
      </div>
      <p className="mt-3 border-t border-line pt-2 text-2xs text-muted">
        The relay is untrusted — even online it can't move funds or forge a settlement. What matters is
        that the engine signer maps to a whitelisted, reproducible-build code-hash above; only that
        attested build can produce a signature the settlement contract accepts.
      </p>
    </Panel>
  );
}

function StatusRow({
  label,
  ok,
  pending,
  value,
  detail,
}: {
  label: string;
  ok: boolean;
  pending: boolean;
  value: React.ReactNode;
  detail?: string;
}) {
  const dot = pending ? "bg-muted animate-pulse" : ok ? "bg-good" : "bg-loss";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 ${dot}`} />
        <span className="text-muted">{label}</span>
      </div>
      <div className="flex items-center gap-2 text-right">
        <span className={`mono text-2xs ${ok ? "text-subtle" : pending ? "text-muted" : "text-warn"}`}>
          {value}
        </span>
        {detail && <span className="mono text-2xs text-muted">{detail}</span>}
      </div>
    </div>
  );
}
