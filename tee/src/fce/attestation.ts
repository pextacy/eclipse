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
 * Verifies a raw hardware attestation quote: checks the quote's signature chain
 * (Intel PCS / AMD KDS / FCC) AND that the quote's measured code-hash and
 * report-data actually commit to `bundle.codeHash` and `bundle.signerAddress`.
 *
 * This cryptographic step CANNOT be faked in application code — it requires the
 * platform attestation library. So it is an INJECTED dependency: `toRegistration`
 * refuses to produce on-chain args unless a real verifier is supplied and passes.
 * (A stub that returns true is only acceptable in local unit tests.)
 */
export type QuoteVerifier = (bundle: AttestationBundle) => boolean;

/**
 * Produce the on-chain `registerCodeHash(codeHash, signer)` arguments — but ONLY
 * after: (1) structural checks, (2) provenance is not `dev`, (3) the attested
 * code-hash matches the reproducible build, and (4) the supplied `verifyQuote`
 * confirms the hardware quote binds this code-hash + signer. Without a passing
 * quote verification there is no registration — this is what prevents whitelisting
 * an unattested signer (the "attestation theater" failure mode).
 */
export function toRegistration(
  bundle: AttestationBundle,
  verifyQuote: QuoteVerifier,
): {
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
  // Every non-dev provenance MUST carry a code-hash that matches the build's —
  // never skip this check just because the field is absent at runtime.
  const provCodeHash = (bundle.provenance as { codeHash?: string }).codeHash;
  if (!provCodeHash) {
    throw new Error("attested provenance is missing its code-hash");
  }
  if (provCodeHash !== bundle.codeHash) {
    throw new Error("attested code-hash does not match the reproducible-build code-hash");
  }
  if (!bundle.quote || bundle.quote.length === 0) {
    throw new Error("missing hardware attestation quote");
  }
  if (!verifyQuote(bundle)) {
    throw new Error("hardware attestation quote failed verification");
  }
  return { codeHash: bundle.codeHash, signer: bundle.signerAddress };
}
