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
import { formatUnits, parseUnits, fmtNum, fmtUsd, truncateHex } from "../lib/format";
import {
  useLivePrice,
  useBandBps,
  useAccountEscrowTotal,
  useLatestSettledBatchId,
} from "../lib/market";
import { useTrackedOrders, deriveStatus, type OrderStatus } from "../lib/orders";
import { useToast } from "../components/Toast";
import { useSettings } from "../lib/settings";
import { toCsv, downloadCsv } from "../lib/csv";

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
          <OrderBlotter account={address} />
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
  const toast = useToast();
  const [releaseState, setReleaseState] = useState<string>("");

  const fxrpVal = fxrpBal.data ?? 0n;
  const usdt0Val = usdt0Bal.data ?? 0n;
  const locked = openLeg.data === true;
  const expiryTs = typeof legExpiry.data === "bigint" ? Number(legExpiry.data) : 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const legExpired = locked && expiryTs > 0 && nowTs > expiryTs;

  async function releaseLeg() {
    setReleaseState("Releasing…");
    const tid = toast.push({
      kind: "pending",
      title: "Release expired leg",
      message: "Awaiting wallet…",
    });
    try {
      const hash = await writeContractAsync({
        address: deployment.eclipseSettlement,
        abi: eclipseSettlementAbi,
        functionName: "releaseExpiredLeg",
      });
      setReleaseState(`Released — ${hash.slice(0, 10)}…. Your escrow is withdrawable.`);
      toast.update(tid, {
        kind: "success",
        title: "Leg released",
        message: "Escrow is withdrawable again",
        txHash: hash,
        autoDismissMs: 8000,
      });
      void openLeg.refetch?.();
    } catch (e) {
      const msg = (e as Error).message ?? "Release failed.";
      setReleaseState(msg);
      toast.update(tid, {
        kind: "error",
        title: "Release failed",
        message: shortError(msg),
        autoDismissMs: 9000,
      });
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
  const toast = useToast();

  // The relevant balance for this action: for deposit, what's in the trader's
  // wallet; for withdraw, what's idle in escrow. Drives the "Balance / Max" row
  // so a trader never has to guess the maximum they can move.
  const walletBal = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: isConfigured && !!account && isDeposit, refetchInterval: 8000 },
  });
  const escrowBal = useReadContract({
    address: deployment.eclipseSettlement,
    abi: eclipseSettlementAbi,
    functionName: "balanceOf",
    args: account ? [account, token] : undefined,
    query: { enabled: isConfigured && !!account && !isDeposit, refetchInterval: 8000 },
  });
  const available = (isDeposit ? walletBal.data : escrowBal.data) ?? 0n;

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
    const tid = toast.push({
      kind: "pending",
      title: `${isDeposit ? "Deposit" : "Withdraw"} ${meta.symbol}`,
      message: `${amount} ${meta.symbol} — awaiting wallet…`,
    });
    try {
      if (isDeposit) {
        setStatus(`Approving ${meta.symbol}…`);
        toast.update(tid, { message: `Approving ${meta.symbol}…` });
        const approveHash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.eclipseSettlement, units],
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approveHash });

        setStatus(`Depositing ${meta.symbol}…`);
        toast.update(tid, { message: `Depositing ${amount} ${meta.symbol}…` });
        const depositHash = await writeContractAsync({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          functionName: "deposit",
          args: [token, units],
        });
        setTxHash(depositHash);
        setStatus("Deposit submitted.");
        toast.update(tid, {
          kind: "success",
          title: `Deposited ${meta.symbol}`,
          message: `${amount} ${meta.symbol} escrowed`,
          txHash: depositHash,
          autoDismissMs: 8000,
        });
      } else {
        setStatus(`Withdrawing ${meta.symbol}…`);
        toast.update(tid, { message: `Withdrawing ${amount} ${meta.symbol}…` });
        const withdrawHash = await writeContractAsync({
          address: deployment.eclipseSettlement,
          abi: eclipseSettlementAbi,
          functionName: "withdraw",
          args: [token, units],
        });
        setTxHash(withdrawHash);
        setStatus("Withdraw submitted.");
        toast.update(tid, {
          kind: "success",
          title: `Withdrew ${meta.symbol}`,
          message: `${amount} ${meta.symbol} returned to wallet`,
          txHash: withdrawHash,
          autoDismissMs: 8000,
        });
      }
    } catch (e) {
      const msg = (e as Error).message ?? "Transaction failed.";
      setError(msg);
      setStatus("");
      toast.update(tid, {
        kind: "error",
        title: `${isDeposit ? "Deposit" : "Withdraw"} failed`,
        message: shortError(msg),
        autoDismissMs: 9000,
      });
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
          <div className="mb-1 flex items-center justify-between">
            <label className="label">Amount ({meta.symbol})</label>
            <span className="mono text-2xs text-muted">
              {isDeposit ? "wallet" : "escrow"}:{" "}
              <button
                type="button"
                className="text-info hover:text-eclipse disabled:text-muted"
                disabled={!account || available === 0n}
                // Strip thousands separators — parseUnits() rejects grouped input.
                onClick={() => setAmount(formatUnits(available, meta.decimals).replace(/,/g, ""))}
                title="Use full balance"
              >
                {account ? `${formatUnits(available, meta.decimals)} ${meta.symbol}` : "—"}
              </button>
            </span>
          </div>
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

/** Review-and-confirm modal shown before the wallet signature — a fat-finger
 *  guard summarizing exactly what will be sealed and submitted. */
function OrderConfirm({
  side,
  baseAmount,
  limitPrice,
  notionalUsd,
  devBps,
  band,
  midPrice,
  limitInsideBand,
  tifSec,
  onCancel,
  onConfirm,
}: {
  side: Side;
  baseAmount: number;
  limitPrice: string;
  notionalUsd: number;
  devBps: number;
  band: number;
  midPrice: number;
  limitInsideBand: boolean;
  tifSec: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const isBuy = side === Side.Buy;
  const tifLabel = tifSec >= 3600 ? `${tifSec / 3600}h` : tifSec >= 60 ? `${tifSec / 60}m` : `${tifSec}s`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onCancel}>
      <div className="w-full max-w-sm border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">Review sealed order</h2>
          <span className={`tag ${isBuy ? "border-eclipse text-eclipse" : "border-loss text-loss"}`}>
            {isBuy ? "BUY" : "SELL"}
          </span>
        </header>
        <div className="space-y-2 p-4 text-xs">
          <ConfirmRow label="Size">{fmtNum(baseAmount, 0)} FXRP</ConfirmRow>
          <ConfirmRow label="Limit price">{limitPrice} XRP/USD</ConfirmRow>
          <ConfirmRow label="Notional">{fmtUsd(notionalUsd)}</ConfirmRow>
          <ConfirmRow label={isBuy ? "You pay (max)" : "You sell"}>
            <span className="text-loss">
              {isBuy ? `${fmtNum(notionalUsd, 2)} USDT0` : `${fmtNum(baseAmount, 0)} FXRP`}
            </span>
          </ConfirmRow>
          <ConfirmRow label="You receive">
            <span className="text-good">
              {isBuy ? `${fmtNum(baseAmount, 0)} FXRP` : `${fmtNum(notionalUsd, 2)} USDT0`}
            </span>
          </ConfirmRow>
          <ConfirmRow label="Time in force">{tifLabel}</ConfirmRow>
          <div className="border-t border-line pt-2">
            <ConfirmRow label={`vs FTSO mid (${midPrice > 0 ? fmtNum(midPrice, 5) : "…"})`}>
              <span className={limitInsideBand ? "text-good" : "text-warn"}>
                {midPrice > 0 ? `${devBps >= 0 ? "+" : ""}${fmtNum(devBps, 1)} bps` : "—"}
                {midPrice > 0 && (limitInsideBand ? " · eligible" : ` · outside ±${band}bps`)}
              </span>
            </ConfirmRow>
          </div>
          {midPrice > 0 && !limitInsideBand && (
            <p className="mono text-2xs text-warn">
              This limit is outside the on-chain fairness band — it will rest sealed but can't clear
              until the mid moves toward it.
            </p>
          )}
          <p className="mono border-t border-line pt-2 text-2xs text-muted">
            The order is encrypted client-side before it leaves your browser. You'll sign it in your
            wallet next — the relay only ever sees ciphertext.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-accent" onClick={onConfirm}>
            Confirm &amp; sign
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConfirmRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="mono text-subtle">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SealedOrderForm({ account }: { account?: `0x${string}` }) {
  const [side, setSide] = useState<Side>(Side.Buy);
  const [baseAmount, setBaseAmount] = useState("1000");
  const [limitPrice, setLimitPrice] = useState("0.50");
  // Time-in-force: how long the sealed order stays eligible before its leg can be
  // self-released. Drives the order's `expiry`; the batch cadence is separate.
  const [tifSec, setTifSec] = useState(300);
  const [engine, setEngine] = useState<EnginePubkey | null>(null);
  const [engineErr, setEngineErr] = useState<string>("");
  const [ciphertext, setCiphertext] = useState<string>("");
  const [submitState, setSubmitState] = useState<string>("");
  const [usingDemoKey, setUsingDemoKey] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();
  const toast = useToast();

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
      expiry: Math.floor(Date.now() / 1000) + tifSec,
    };
  }, [account, baseAmount, limitPrice, side, tifSec]);

  // Live oracle context: quote the order against the SAME FTSO reference the
  // settlement contract bounds every clearing price to. Shows the trader whether
  // their limit would even be eligible to clear (inside ±band) before they sign,
  // plus the USD notional they're committing.
  const mid = useLivePrice();
  const band = useBandBps();
  const { settings } = useSettings();
  // Snapshots for the local order blotter (see lib/orders.ts — privacy-preserving).
  const escrowTotal = useAccountEscrowTotal(account);
  const latestBatchId = useLatestSettledBatchId();
  const { record } = useTrackedOrders(account);
  const limitNum = Number(limitPrice);
  const baseNum = Number(baseAmount);
  const notionalUsd = Number.isFinite(limitNum * baseNum) ? limitNum * baseNum : 0;
  const devBps =
    mid.price > 0 && Number.isFinite(limitNum) ? ((limitNum - mid.price) / mid.price) * 10_000 : 0;
  // A BUY limit above the low band edge (and a SELL below the high edge) can clear;
  // the uniform clearing price itself must land inside ±band of the FTSO ref.
  const limitInsideBand = mid.price > 0 && Math.abs(devBps) <= band;
  // Softer, user-configurable guard on top of the hard on-chain band.
  const beyondSlippage =
    mid.price > 0 && limitInsideBand && Math.abs(devBps) > settings.slippageBps;

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
    const submissionId = crypto.randomUUID();
    try {
      const res = await fetch(`${relayUrl()}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ciphertext: sealed.ciphertext,
          enginePublicKey: sealed.enginePublicKey,
          submissionId,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`relay ${res.status}`);
      setSubmitState("Accepted by relay. Order stays sealed until the batch runs in the TEE.");
      toast.push({
        kind: "success",
        title: "Sealed order submitted",
        message: `${side === Side.Buy ? "BUY" : "SELL"} ${fmtNum(Number(baseAmount), 0)} FXRP @ ${limitPrice} — queued for the next batch`,
        autoDismissMs: 8000,
      });
      // Remember it locally so the trader can track its lifecycle. Nothing here
      // leaves the browser; status is inferred from the trader's own escrow.
      if (account) {
        record({
          submissionId,
          account,
          side: signedOrder.side,
          baseAmount,
          limitPrice,
          createdAt: Math.floor(Date.now() / 1000),
          expiry: signedOrder.expiry,
          sinceBatchId: latestBatchId.toString(),
          escrowSnapshot: escrowTotal.toString(),
        });
      }
    } catch (e) {
      const msg = (e as Error).message ?? "submit failed";
      setSubmitState(`Submit failed: ${msg}. Ciphertext preview below proves nothing leaked.`);
      toast.push({
        kind: "error",
        title: "Order submit failed",
        message: shortError(msg),
        autoDismissMs: 9000,
      });
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
          <div className="mb-1 flex items-center justify-between">
            <label className="label">Limit price (XRP/USD)</label>
            <button
              type="button"
              className="mono text-2xs text-info hover:text-eclipse disabled:text-muted"
              disabled={mid.price <= 0}
              onClick={() => mid.price > 0 && setLimitPrice(mid.price.toFixed(FTSO_PRICE_DECIMALS))}
              title="Use the live FTSO mid"
            >
              mid {mid.price > 0 ? fmtNum(mid.price, 5) : "…"}
            </button>
          </div>
          <input className="input" inputMode="decimal" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
          {/* Quick limit relative to the live mid. A buyer sets a ceiling at/above
              mid; a seller a floor at/below mid — so offsets flip sign by side. */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[0, 10, 25, 50].map((bps) => {
              const signed = side === Side.Buy ? bps : -bps;
              const target = mid.price > 0 ? mid.price * (1 + signed / 10_000) : 0;
              return (
                <button
                  key={bps}
                  type="button"
                  className="tag border-line px-2 py-0.5 text-2xs text-muted hover:border-eclipse hover:text-eclipse disabled:opacity-40"
                  disabled={mid.price <= 0}
                  onClick={() => target > 0 && setLimitPrice(target.toFixed(FTSO_PRICE_DECIMALS))}
                  title={`Set limit ${bps === 0 ? "at" : `${side === Side.Buy ? "+" : "−"}${bps} bps from`} mid`}
                >
                  {bps === 0 ? "mid" : `${side === Side.Buy ? "+" : "−"}${bps}bps`}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="label mb-1">Time in force</label>
          <div className="flex flex-wrap gap-1">
            {[
              { s: 60, label: "1m" },
              { s: 300, label: "5m" },
              { s: 900, label: "15m" },
              { s: 3600, label: "1h" },
            ].map(({ s, label }) => (
              <button
                key={s}
                type="button"
                onClick={() => setTifSec(s)}
                className={`tag px-2.5 py-0.5 ${tifSec === s ? "border-eclipse text-eclipse" : "border-line text-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mono mt-1 text-2xs text-muted">
            expires {new Date((Math.floor(Date.now() / 1000) + tifSec) * 1000).toLocaleTimeString()} ·
            self-releasable after
          </p>
        </div>

        {/* Oracle context — is this limit even eligible to clear, and for how much */}
        <div className="grid grid-cols-3 gap-2 border-y border-line py-2 text-2xs">
          <div>
            <div className="label">Notional</div>
            <div className="mono mt-0.5 text-subtle">{notionalUsd > 0 ? fmtUsd(notionalUsd) : "—"}</div>
          </div>
          <div>
            <div className="label">vs FTSO mid</div>
            <div className={`mono mt-0.5 ${Math.abs(devBps) <= band ? "text-good" : "text-warn"}`}>
              {mid.price > 0 ? `${devBps >= 0 ? "+" : ""}${fmtNum(devBps, 1)} bps` : "—"}
            </div>
          </div>
          <div>
            <div className="label">Band ±{band}bps</div>
            <div className={`mono mt-0.5 ${limitInsideBand ? "text-good" : "text-warn"}`}>
              {mid.price <= 0 ? "—" : limitInsideBand ? "eligible" : "out of band"}
            </div>
          </div>
        </div>
        {mid.price > 0 && !limitInsideBand && (
          <p className="mono text-2xs text-warn">
            Limit is outside ±{band} bps of the live FTSO mid — a uniform clearing price this far from
            the oracle would be rejected on-chain (PriceOutsideBand). It can still rest, but won't
            cross until the mid moves toward it.
          </p>
        )}
        {beyondSlippage && (
          <p className="mono text-2xs text-warn">
            {fmtNum(Math.abs(devBps), 1)} bps from mid exceeds your {settings.slippageBps} bps slippage
            tolerance (still within the on-chain ±{band} bps band). Adjust in ⚙ settings if intended.
          </p>
        )}

        {/* You pay / you receive at the limit (fills clear at or better) */}
        {baseNum > 0 && limitNum > 0 && (
          <div className="flex items-center justify-between gap-3 text-2xs">
            <span className="mono text-muted">
              you {side === Side.Buy ? "pay" : "sell"}{" "}
              <span className="text-loss">
                {side === Side.Buy ? `${fmtNum(notionalUsd, 2)} USDT0` : `${fmtNum(baseNum, 0)} FXRP`}
              </span>
            </span>
            <span className="text-subtle">→</span>
            <span className="mono text-muted">
              receive{" "}
              <span className="text-good">
                {side === Side.Buy ? `${fmtNum(baseNum, 0)} FXRP` : `${fmtNum(notionalUsd, 2)} USDT0`}
              </span>
            </span>
          </div>
        )}

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
          <button
            type="button"
            className="btn btn-accent flex-1"
            onClick={() => {
              if (!previewOrder) {
                setSubmitState("Invalid amount/price.");
                return;
              }
              setConfirmOpen(true);
            }}
          >
            Seal + submit
          </button>
        </div>

        {confirmOpen && previewOrder && (
          <OrderConfirm
            side={side}
            baseAmount={baseNum}
            limitPrice={limitPrice}
            notionalUsd={notionalUsd}
            devBps={devBps}
            band={band}
            midPrice={mid.price}
            limitInsideBand={limitInsideBand}
            tifSec={tifSec}
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              void submit();
            }}
          />
        )}

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

/* ------------------------------------------------------------------ */

const STATUS_STYLE: Record<OrderStatus, { label: string; tone: string }> = {
  sealed: { label: "sealed · queued", tone: "border-eclipse text-eclipse" },
  filled: { label: "filled", tone: "border-good text-good" },
  expired: { label: "expired", tone: "border-warn text-warn" },
};

/**
 * The trader's own order blotter. Purely local (localStorage) and privacy-safe:
 * status is inferred from the wall clock and the trader's own escrow, never from
 * a server that could leak the sealed book.
 */
function OrderBlotter({ account }: { account?: `0x${string}` }) {
  const { orders, markFilled, clear } = useTrackedOrders(account);
  const escrowTotal = useAccountEscrowTotal(account);
  const latestBatchId = useLatestSettledBatchId();
  const toast = useToast();
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = orders.map((o) => ({
    o,
    status: deriveStatus(o, { nowSec, latestBatchId, currentEscrow: escrowTotal }),
  }));

  // Persist a newly-inferred fill (and notify). markFilled only runs while
  // filledBatchId is unset, so this fires exactly once at the fill transition —
  // not on reload for already-filled orders.
  useEffect(() => {
    for (const { o, status } of rows) {
      if (status === "filled" && !o.filledBatchId) {
        markFilled(o.submissionId, latestBatchId.toString());
        toast.push({
          kind: "success",
          title: "Order filled",
          message: `${o.side === Side.Buy ? "BUY" : "SELL"} ${fmtNum(Number(o.baseAmount), 0)} FXRP cleared in a batch`,
          autoDismissMs: 9000,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => `${r.o.submissionId}:${r.status}`).join(",")]);

  if (!account) return null;

  return (
    <Panel
      title="My orders"
      subtitle="Local blotter — nothing leaves this browser"
      actions={
        orders.length > 0 ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="tag border-line text-muted hover:text-eclipse"
              onClick={() => {
                const csv = toCsv(
                  ["submissionId", "side", "baseAmount", "limitPrice", "status", "created", "expiry", "filledBatchId"],
                  rows.map(({ o, status }) => [
                    o.submissionId,
                    o.side === Side.Buy ? "BUY" : "SELL",
                    o.baseAmount,
                    o.limitPrice,
                    status,
                    new Date(o.createdAt * 1000).toISOString(),
                    new Date(o.expiry * 1000).toISOString(),
                    o.filledBatchId ?? "",
                  ]),
                );
                downloadCsv(`eclipse-orders-${account?.slice(0, 8) ?? "account"}.csv`, csv);
              }}
            >
              export csv
            </button>
            <button type="button" className="tag border-line text-muted hover:text-loss" onClick={clear}>
              clear
            </button>
          </div>
        ) : undefined
      }
    >
      {orders.length === 0 ? (
        <p className="mono text-2xs text-muted">
          no orders yet — submit a sealed order and it will appear here with a live status inferred
          from your own escrow (never from a server).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-2xs">
            <thead>
              <tr className="text-muted">
                <Th>side</Th>
                <Th>size</Th>
                <Th>limit</Th>
                <Th>status</Th>
                <Th>expiry</Th>
              </tr>
            </thead>
            <tbody className="mono">
              {rows.map(({ o, status }) => {
                const st = STATUS_STYLE[status];
                const ttl = o.expiry - nowSec;
                return (
                  <tr key={o.submissionId} className="border-t border-line">
                    <Td>
                      <span className={o.side === Side.Buy ? "text-eclipse" : "text-loss"}>
                        {o.side === Side.Buy ? "BUY" : "SELL"}
                      </span>
                    </Td>
                    <Td>{fmtNum(Number(o.baseAmount), 0)}</Td>
                    <Td>{o.limitPrice}</Td>
                    <Td>
                      <span className={`tag ${st.tone}`}>{st.label}</span>
                      {status === "filled" && o.filledBatchId && o.filledBatchId !== "0" && (
                        <span className="ml-1 text-muted">#{o.filledBatchId}</span>
                      )}
                    </Td>
                    <Td>
                      {status === "sealed"
                        ? ttl > 0
                          ? `${ttl}s`
                          : "expiring…"
                        : new Date(o.expiry * 1000).toLocaleTimeString()}
                    </Td>
                  </tr>
                );
              })}
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

/** Trim a wallet/RPC error to its first meaningful line for a toast. */
function shortError(msg: string): string {
  const firstLine = msg.split("\n")[0] ?? msg;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function NotConfigured({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-warn bg-panel px-5 py-4">
      <div className="mb-1 text-sm font-semibold text-warn">Deployment not configured</div>
      <p className="max-w-2xl text-xs text-muted">{children}</p>
    </div>
  );
}
