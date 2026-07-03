import { useState } from "react";

/** Tiny copy-to-clipboard control used by address/hash components. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={label ?? "Copy"}
      className="text-muted transition-colors hover:text-eclipse"
      aria-label={label ?? "Copy"}
    >
      <span className="mono text-2xs">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
