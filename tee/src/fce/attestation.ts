/**
 * Attested-key registration model.
 *
 * On-chain full attestation verification is heavy, so Eclipse verifies the
 * hardware attestation ONCE, at registration time (off-chain / by governance),
 * then binds the enclave's signing public key to its reproducible-build
 * code-hash in EclipseRegistry. Thereafter every settlement is checked cheaply:
 * the signature must recover to that bound signer (CLAUDE.md §2.3, risk register
 * in phases.md).
 */

/** Where the enclave's signing key came from. */
export type SignerProvenance =
  | { kind: "fce-extension"; codeHash: string } // real FCC extension, fce-sign key
  | { kind: "confidential-vm"; tee: "tdx" | "sev-snp"; codeHash: string } // documented fallback
  | { kind: "dev"; note: string }; // local dev only — never deployed

/** The bundle a verifier checks once before calling registerCodeHash on-chain. */
export interface AttestationBundle {
  /** Reproducible-build code-hash (from build/codehash.json). */
  codeHash: string;
  /** The enclave's settlement signing address (bound to the code-hash). */
  signerAddress: string;
  /** The enclave's sealed-box public key (traders seal orders to this). */
  sealedPublicKey: string;
  /** Raw hardware attestation quote (TDX/SEV-SNP/FCC), base64. Verified off-chain. */
  quote: string;
  provenance: SignerProvenance;
}

/**
 * Validate the linkage a verifier must confirm before whitelisting: the quote's
 * measured code-hash equals the reproducible-build code-hash, and the quote
 * commits to the signer key. (Quote signature verification itself is delegated
 * to the platform's attestation library — Intel/AMD/FCC — and is out of scope of
 * this glue.) Returns the on-chain registration arguments.
 */
export function toRegistration(bundle: AttestationBundle): {
  codeHash: string;
  signer: string;
} {
  if (!/^0x[0-9a-fA-F]{64}$/.test(bundle.codeHash)) {
    throw new Error("codeHash must be a 32-byte hex string");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(bundle.signerAddress)) {
    throw new Error("signerAddress must be a 20-byte address");
  }
  if (bundle.provenance.kind === "dev") {
    throw new Error("refusing to register a dev-provenance signer for the deployed demo");
  }
  if ("codeHash" in bundle.provenance && bundle.provenance.codeHash !== bundle.codeHash) {
    throw new Error("attested code-hash does not match the reproducible-build code-hash");
  }
  return { codeHash: bundle.codeHash, signer: bundle.signerAddress };
}
