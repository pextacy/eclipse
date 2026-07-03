import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { coston2 } from "../wagmi";
import { AddressLink } from "./AddressLink";

/** Injected-wallet connect control + Coston2 network guard. */
export function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const chainId = useChainId();

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
      {address && <AddressLink address={address} showCopy />}
      <button type="button" className="btn" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
