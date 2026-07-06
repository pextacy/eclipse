import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId, useBalance } from "wagmi";
import { coston2 } from "../wagmi";
import { AddressLink } from "./AddressLink";
import { fmtNum } from "../lib/format";

/** Below this native balance, on-chain actions may fail for lack of gas. */
const LOW_GAS = 0.05;

function lowGas(value: bigint, decimals: number): boolean {
  return Number(value) / 10 ** decimals < LOW_GAS;
}

/** Injected-wallet connect control + Coston2 network guard + gas balance. */
export function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const chainId = useChainId();
  const gas = useBalance({
    address,
    query: { enabled: !!address, refetchInterval: 12000 },
  });

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const wrongChain = isConnected && chainId !== coston2.id;

  if (!isConnected) {
    return (
      <button
        type="button"
        className="btn btn-accent"
        disabled={isPending || !injected}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {wrongChain && (
        <button
          type="button"
          className="btn btn-loss"
          onClick={() => switchChain({ chainId: coston2.id })}
        >
          Switch to Coston2
        </button>
      )}
      <span className="tag border-line-strong text-subtle">
        <span className="mr-1 inline-block h-1.5 w-1.5 bg-good" />
        {wrongChain ? "wrong net" : "Coston2"}
      </span>
      {gas.data &&
        (lowGas(gas.data.value, gas.data.decimals) ? (
          <a
            href="https://faucet.flare.network/coston2"
            target="_blank"
            rel="noreferrer"
            className="tag border-warn text-warn hover:bg-loss-dim"
            title="Low gas — click to open the Coston2 faucet, or transactions may fail"
          >
            {fmtNum(Number(gas.data.value) / 10 ** gas.data.decimals, 3)} {gas.data.symbol} · faucet ↗
          </a>
        ) : (
          <span className="tag border-line-strong text-subtle" title="Native gas balance">
            {fmtNum(Number(gas.data.value) / 10 ** gas.data.decimals, 3)} {gas.data.symbol}
          </span>
        ))}
      {address && <AddressLink address={address} showCopy />}
      <button type="button" className="btn" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
