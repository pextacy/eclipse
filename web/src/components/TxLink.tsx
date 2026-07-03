import { explorerTx, truncateHex } from "../lib/format";
import { CopyButton } from "./CopyButton";

interface TxLinkProps {
  hash: string;
  label?: string;
  showCopy?: boolean;
  className?: string;
}

/** Transaction hash linking to the Coston2 explorer /tx/ page. */
export function TxLink({ hash, label, showCopy = true, className }: TxLinkProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <a
        href={explorerTx(hash)}
        target="_blank"
        rel="noreferrer"
        title={hash}
        className="mono text-info underline decoration-line underline-offset-2 hover:text-eclipse hover:decoration-eclipse"
      >
        {label ?? truncateHex(hash, 10, 8)}
      </a>
      {showCopy && <CopyButton value={hash} label="Copy tx hash" />}
    </span>
  );
}
