import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
  useSignTypedData,
} from "wagmi";
import nacl from "tweetnacl";
import {
  Side,
  type Order,
  EIP712_ORDER_TYPES,
  orderEip712Domain,
  orderSigningValue,
} from "@eclipse/shared";
import { Panel } from "../components/Panel";
import { StatTile } from "../components/StatTile";
import { MonoNumber } from "../components/MonoNumber";
import { AddressLink } from "../components/AddressLink";
import { TxLink } from "../components/TxLink";
import { eclipseSettlementAbi, erc20Abi } from "../lib/abis";
import { deployment, isConfigured, relayUrl } from "../lib/deployment";
import { sealOrder, b64encode } from "../lib/seal";
import { formatUnits, parseUnits, fmtNum, truncateHex } from "../lib/format";

interface EnginePubkey {
  publicKey: string;
  signerAddress: string;
}

// Decimals of the Coston2 XRP/USD FTSO feed (getFeedById returns 6). The sealed
// order's limitPrice MUST use this same scale as the engine's live reference, or
// every order would be mis-scaled by a power of ten and never cross the band.
const FTSO_PRICE_DECIMALS = 6;

export function TraderConsole() {
  const { address, isConnected } = useAccount();

  if (!isConfigured) {
    return (
      <NotConfigured>
        The Trader Console needs a deployed settlement contract. It becomes live once the deploy
        script writes <span className="mono text-subtle">deployments/coston2.json</span> (or the
        <span className="mono text-subtle"> VITE_ECLIPSE_SETTLEMENT / VITE_FXRP / VITE_USDT0</span>{" "}
        env vars are set). The sealed-order form below still works offline so you can prove nothing
        leaks.
      </NotConfigured>
    );
  }

  return (
    <div className="space-y-6">
      {!isConnected && (
        <div className="border border-line bg-panel px-4 py-3 text-sm text-subtle">
          Connect an injected wallet (top right) on Coston2 to read your escrow balances and submit
          transactions.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EscrowSummary account={address} />
          <div className="grid gap-6 md:grid-cols-2">
            <MoveFunds account={address} mode="deposit" />
            <MoveFunds account={address} mode="withdraw" />
          </div>
          <BatchFills />
        </div>
        <div className="space-y-6">
          <SealedOrderForm account={address} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function useTokenMeta(token: `0x${string}`, fallbackSymbol: string, fallbackDecimals: number) {
  const { data: decimals } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: isConfigured, staleTime: Infinity },
  });
  const { data: symbol } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: isConfigured, staleTime: Infinity },
  });
  return {
    decimals: typeof decimals === "number" ? decimals : fallbackDecimals,
    symbol: typeof symbol === "string" && symbol.length > 0 ? symbol : fallbackSymbol,
  };
}

function EscrowSummary({ account }: { account?: `0x${string}` }) {
  const fxrp = useTokenMeta(deployment.fxrp, "FXRP", 6);
  const usdt0 = useTokenMeta(deployment.usdt0, "USDT0", 6);

  const fxrpBal = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.fxrp] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const usdt0Bal = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, deployment.usdt0] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const openLeg = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "hasOpenLeg",
    args: account ? [account] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const legExpiry = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "openLegExpiry",
    args: account ? [account] : undefined,
    query: { enabled: isConfigured && !!account, refetchInterval: 8000 },
  });
  const { writeContractAsync } = useWriteContract();
  const [releaseState, setReleaseState] = useState<string>("");

  const fxrpVal = fxrpBal.data ?? 0n;
  const usdt0Val = usdt0Bal.data ?? 0n;
  const locked = openLeg.data === true;
  const expiryTs = typeof legExpiry.data === "bigint" ? Number(legExpiry.data) : 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const legExpired = locked && expiryTs > 0 && nowTs > expiryTs;

  async function releaseLeg() {
    setReleaseState("Releasing…");
    try {
      const hash = await writeContractAsync({
        address: deployment.eclipseSettlement,
        abi: eclipseSettlementAbi,
        functionName: "releaseExpiredLeg",
      });
      setReleaseState(`Released — ${hash.slice(0, 10)}…. Your escrow is withdrawable.`);
      void openLeg.refetch?.();
    } catch (e) {
      setReleaseState((e as Error).message ?? "Release failed.");
    }
  }

  return (
    <Panel
      title="Escrow balances"
      subtitle="Backing collateral held in EclipseSettlement"
      actions={
        <span className={`tag ${locked ? "border-warn text-warn" : "border-line-strong text-muted"}`}>
          {locked ? "leg open · locked" : "no open leg"}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile
          label={`${fxrp.symbol} escrow`}
          value={account ? formatUnits(fxrpVal, fxrp.decimals) : "—"}
          sub={<AddressLink address={deployment.fxrp} showCopy={false} />}
          tone="good"
        />
        <StatTile
          label={`${usdt0.symbol} escrow`}
          value={account ? formatUnits(usdt0Val, usdt0.decimals) : "—"}
          sub={<AddressLink address={deployment.usdt0} showCopy={false} />}
          tone="info"
        />
        <StatTile
          label="Open leg"
          value={account ? (locked ? "YES" : "no") : "—"}
          sub="hasOpenLeg(account)"
          tone={locked ? "warn" : "default"}
        />
      </div>

      {locked && (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3 md:flex-row md:items-center md:justify-between">
          <p className="text-2xs text-muted">
            {legExpired
              ? "This leg is past its expiry and was never settled — you can self-release it and withdraw. No admin can hold your funds."
              : `Leg locked until ${expiryTs > 0 ? new Date(expiryTs * 1000).toLocaleTimeString() : "settlement"}. After expiry you can self-release it.`}
          </p>
          <button
            type="button"
            className="btn btn-accent shrink-0"
            disabled={!legExpired}
            onClick={releaseLeg}
          >
            Release expired leg
          </button>
        </div>
      )}
      {releaseState && <p className="mono mt-2 text-2xs text-subtle">{releaseState}</p>}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

function MoveFunds({ account, mode }: { account?: `0x${string}`; mode: "deposit" | "withdraw" }) {
  const isDeposit = mode === "deposit";
  const [tokenKey, setTokenKey] = useState<"fxrp" | "usdt0">("fxrp");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string>("");

  const token = tokenKey === "fxrp" ? deployment.fxrp : deployment.usdt0;
  const meta = useTokenMeta(token, tokenKey === "fxrp" ? "FXRP" : "USDT0", 6);
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  async function submit() {
    setError("");
    setTxHash(null);
    setStatus("");
    if (!account) {
      setError("Connect a wallet first.");
      return;
    }
    let units: bigint;
    try {
      units = parseUnits(amount, meta.decimals);
    } catch {
      setError("Enter a valid amount.");
      return;
    }
    if (units <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }

    setBusy(true);
    try {
      if (isDeposit) {
        setStatus(`Approving ${meta.symbol}…`);
        const approveHash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.eclipseSettlement, units],
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approveHash });

        setStatus(`Depositing ${meta.symbol}…`);
        const depositHash = await writeContractAsync({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          functionName: "deposit",
          args: [token, units],
        });
        setTxHash(depositHash);
        setStatus("Deposit submitted.");
      } else {
        setStatus(`Withdrawing ${meta.symbol}…`);
        const withdrawHash = await writeContractAsync({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          functionName: "withdraw",
          args: [token, units],
        });
        setTxHash(withdrawHash);
        setStatus("Withdraw submitted.");
      }
    } catch (e) {
      setError((e as Error).message ?? "Transaction failed.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={isDeposit ? "Deposit collateral" : "Withdraw collateral"}>
      <div className="space-y-3">
        <div className="flex gap-2">
          {(["fxrp", "usdt0"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTokenKey(k)}
              className={`tag ${tokenKey === k ? "border-eclipse text-eclipse" : "border-line text-muted"}`}
            >
              {k === "fxrp" ? "FXRP" : "USDT0"}
            </button>
          ))}
        </div>
        <div>
          <label className="label mb-1">Amount ({meta.symbol})</label>
          <input
            className="input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <button
          type="button"
          className={`btn w-full ${isDeposit ? "btn-accent" : ""}`}
          disabled={busy || !account}
          onClick={submit}
        >
          {busy ? status || "Working…" : isDeposit ? "Approve + Deposit" : "Withdraw"}
        </button>

        {status && !error && <p className="mono text-2xs text-muted">{status}</p>}
        {error && <p className="mono text-2xs text-loss">{error}</p>}
        {txHash && (
          <div className="border-t border-line pt-2 text-2xs text-muted">
            tx <TxLink hash={txHash} />
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

function SealedOrderForm({ account }: { account?: `0x${string}` }) {
  const [side, setSide] = useState<Side>(Side.Buy);
  const [baseAmount, setBaseAmount] = useState("1000");
  const [limitPrice, setLimitPrice] = useState("0.50");
  const [engine, setEngine] = useState<EnginePubkey | null>(null);
  const [engineErr, setEngineErr] = useState<string>("");
  const [ciphertext, setCiphertext] = useState<string>("");
  const [submitState, setSubmitState] = useState<string>("");
  const [usingDemoKey, setUsingDemoKey] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();

  // Try to fetch the engine sealed-box public key from the relay.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${relayUrl()}/engine/pubkey`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`relay ${res.status}`);
        const data = (await res.json()) as EnginePubkey;
        if (!cancelled) {
          setEngine(data);
          setEngineErr("");
        }
      } catch (e) {
        if (!cancelled) {
          setEngine(null);
          setEngineErr((e as Error).message ?? "relay unreachable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const previewOrder: Order | null = useMemo(() => {
    const acct = account ?? "0x0000000000000000000000000000000000000000";
    let base: string;
    let price: string;
    try {
      base = parseUnits(baseAmount, 6).toString();
      price = parseUnits(limitPrice, FTSO_PRICE_DECIMALS).toString();
    } catch {
      return null;
    }
    return {
      side,
      baseAmount: base,
      limitPrice: price,
      account: acct as `0x${string}`,
      nonce: Date.now().toString(),
      expiry: Math.floor(Date.now() / 1000) + 300,
    };
  }, [account, baseAmount, limitPrice, side]);

  function seal(order: Order): { ciphertext: string; enginePublicKey: string } {
    // Real engine key if the relay is up; otherwise an ephemeral demo key so the
    // user can still SEE that a sealed ciphertext reveals nothing.
    let pk = engine?.publicKey;
    if (!pk) {
      const kp = nacl.box.keyPair();
      pk = b64encode(kp.publicKey);
      setUsingDemoKey(true);
    } else {
      setUsingDemoKey(false);
    }
    const ct = sealOrder(order, pk);
    setCiphertext(ct);
    return { ciphertext: ct, enginePublicKey: pk };
  }

  async function submit() {
    if (!previewOrder) {
      setSubmitState("Invalid amount/price.");
      return;
    }
    // Authenticate the order to the connected wallet so nobody can submit an
    // order (and force a trade) against another trader's escrow. The engine
    // rejects any order whose signature doesn't recover to `account`.
    let signedOrder: Order;
    try {
      setSubmitState("Sign the order in your wallet…");
      const domain = orderEip712Domain(deployment.chainId, deployment.eclipseSettlement);
      const value = orderSigningValue(previewOrder);
      const signature = await signTypedDataAsync({
        domain: { ...domain, verifyingContract: deployment.eclipseSettlement },
        types: EIP712_ORDER_TYPES,
        primaryType: "Order",
        message: { ...value, account: previewOrder.account as `0x${string}`, side: Number(value.side) },
      });
      signedOrder = { ...previewOrder, signature };
    } catch (e) {
      setSubmitState(`Signature rejected: ${(e as Error).message}`);
      return;
    }

    setSubmitState("Sealing…");
    const sealed = seal(signedOrder);
    if (!engine) {
      setSubmitState("Relay offline — order sealed locally (not submitted). Ciphertext preview below.");
      return;
    }
    try {
      const res = await fetch(`${relayUrl()}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ciphertext: sealed.ciphertext,
          enginePublicKey: sealed.enginePublicKey,
          submissionId: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`relay ${res.status}`);
      setSubmitState("Accepted by relay. Order stays sealed until the batch runs in the TEE.");
    } catch (e) {
      setSubmitState(`Submit failed: ${(e as Error).message}. Ciphertext preview below proves nothing leaked.`);
    }
  }

  return (
    <Panel
      title="Submit sealed order"
      subtitle="Encrypted client-side (crypto_box_seal)"
      actions={
        <span className={`tag ${engine ? "border-eclipse text-eclipse" : "border-warn text-warn"}`}>
          {engine ? "relay online" : "relay offline"}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          {[
            { s: Side.Buy, label: "BUY" },
            { s: Side.Sell, label: "SELL" },
          ].map(({ s, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => setSide(s)}
              className={`tag flex-1 justify-center py-1.5 ${
                side === s
                  ? s === Side.Buy
                    ? "border-eclipse text-eclipse"
                    : "border-loss text-loss"
                  : "border-line text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div>
          <label className="label mb-1">Base amount (FXRP)</label>
          <input className="input" inputMode="decimal" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} />
        </div>
        <div>
          <label className="label mb-1">Limit price (XRP/USD)</label>
          <input className="input" inputMode="decimal" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="btn flex-1"
            onClick={() => {
              // Preview only — seals the (unsigned) order to show the ciphertext
              // reveals nothing. Submission signs it first.
              if (previewOrder) seal(previewOrder);
              else setSubmitState("Invalid amount/price.");
            }}
          >
            Seal preview
          </button>
          <button type="button" className="btn btn-accent flex-1" onClick={submit}>
            Seal + submit
          </button>
        </div>

        {engine ? (
          <div className="border-t border-line pt-2 text-2xs text-muted">
            <div className="flex justify-between">
              <span>engine signer</span>
              <AddressLink address={engine.signerAddress} showCopy={false} />
            </div>
            <div className="mt-1 flex justify-between">
              <span>engine pubkey</span>
              <MonoNumber tone="muted">{truncateHex(engine.publicKey, 8, 6)}</MonoNumber>
            </div>
          </div>
        ) : (
          <p className="mono text-2xs text-warn">
            relay unreachable ({engineErr || "offline"}) — you can still seal locally to prove the
            order never leaks in plaintext.
          </p>
        )}

        {submitState && <p className="mono text-2xs text-subtle">{submitState}</p>}

        {ciphertext && (
          <div className="border border-line bg-surface p-2">
            <div className="label mb-1 flex items-center justify-between">
              <span>sealed ciphertext {usingDemoKey && "(demo key)"}</span>
              <span className="mono text-muted">{ciphertext.length} b64</span>
            </div>
            <div className="mono max-h-24 overflow-auto break-all text-2xs text-eclipse">
              {ciphertext}
            </div>
            <p className="mt-1 text-2xs text-muted">
              This is everything the relay ever sees. Side, size and price are unreadable without the
              engine secret key inside the TEE.
            </p>
          </div>
        )}

        {previewOrder && (
          <div className="border-t border-line pt-2 text-2xs text-muted">
            <div className="flex justify-between">
              <span>plaintext (local only)</span>
              <span className="mono">
                {side === Side.Buy ? "BUY" : "SELL"} {fmtNum(Number(baseAmount), 0)} @ {limitPrice}
              </span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

interface FillRow {
  batchId: bigint;
  clearingPrice: bigint;
  ftsoRef: bigint;
  ftsoOnChain: bigint;
  signer: `0x${string}`;
  txHash: `0x${string}`;
}

function BatchFills() {
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<FillRow[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "empty" | "error">("idle");

  useEffect(() => {
    if (!isConfigured || !publicClient) return;
    let cancelled = false;
    (async () => {
      setState("loading");
      try {
        const latest = await publicClient.getBlockNumber();
        const lookback = 50_000n;
        const fromBlock = latest > lookback ? latest - lookback : 0n;
        const logs = await publicClient.getContractEvents({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          eventName: "BatchSettled",
          fromBlock,
          toBlock: "latest",
        });
        if (cancelled) return;
        const mapped: FillRow[] = logs
          .map((l) => ({
            batchId: l.args.batchId ?? 0n,
            clearingPrice: l.args.clearingPrice ?? 0n,
            ftsoRef: l.args.ftsoRef ?? 0n,
            ftsoOnChain: l.args.ftsoOnChain ?? 0n,
            signer: (l.args.signer ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
            txHash: l.transactionHash,
          }))
          .reverse()
          .slice(0, 12);
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

  return (
    <Panel
      title="Recent batch settlements"
      subtitle="BatchSettled events on EclipseSettlement"
      actions={<span className="tag border-line-strong text-muted">{rows.length} shown</span>}
    >
      {state === "loading" && <p className="mono text-2xs text-muted">loading logs…</p>}
      {state === "error" && (
        <p className="mono text-2xs text-warn">could not read logs from RPC (range/limit).</p>
      )}
      {state === "empty" && (
        <p className="mono text-2xs text-muted">no settlements yet — run a batch to populate.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-2xs">
            <thead>
              <tr className="text-muted">
                <Th>batch</Th>
                <Th>clearing</Th>
                <Th>ftsoRef</Th>
                <Th>ftsoOnChain</Th>
                <Th>signer</Th>
                <Th>tx</Th>
              </tr>
            </thead>
            <tbody className="mono">
              {rows.map((r) => (
                <tr key={r.txHash} className="border-t border-line">
                  <Td>#{r.batchId.toString()}</Td>
                  <Td>{(Number(r.clearingPrice) / 10 ** FTSO_PRICE_DECIMALS).toFixed(5)}</Td>
                  <Td>{(Number(r.ftsoRef) / 10 ** FTSO_PRICE_DECIMALS).toFixed(5)}</Td>
                  <Td>{(Number(r.ftsoOnChain) / 10 ** FTSO_PRICE_DECIMALS).toFixed(5)}</Td>
                  <Td>
                    <AddressLink address={r.signer} showCopy={false} />
                  </Td>
                  <Td>
                    <TxLink hash={r.txHash} showCopy={false} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1.5 font-normal uppercase tracking-wide">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-1.5 text-subtle">{children}</td>;
}

function NotConfigured({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-warn bg-panel px-5 py-4">
      <div className="mb-1 text-sm font-semibold text-warn">Deployment not configured</div>
      <p className="max-w-2xl text-xs text-muted">{children}</p>
    </div>
  );
}
