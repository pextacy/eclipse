import { explorerAddress, truncateHex, isZeroHex } from "../lib/format";
import { CopyButton } from "./CopyButton";

interface AddressLinkProps {
  address: string;
  label?: string;
  showCopy?: boolean;
  className?: string;
}

/** Truncated 0x1234…abcd address that links to the Coston2 explorer. */
export function AddressLink({ address, label, showCopy = true, className }: AddressLinkProps) {
  if (isZeroHex(address)) {
    return <span className={`mono text-2xs text-muted ${className ?? ""}`}>not set</span>;
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <a
        href={explorerAddress(address)}
        target="_blank"
        rel="noreferrer"
        title={address}
        className="mono text-info underline decoration-line underline-offset-2 hover:text-eclipse hover:decoration-eclipse"
      >
        {label ?? truncateHex(address)}
      </a>
      {showCopy && <CopyButton value={address} label="Copy address" />}
    </span>
  );
}
