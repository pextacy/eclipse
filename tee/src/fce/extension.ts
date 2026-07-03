/**
 * FCC extension entrypoint.
 *
 * Scaffolded to match `fce-extension-scaffold`: the same MatchingEngine code
 * runs unmodified inside the Flare Confidential Compute TEE. The ONLY difference
 * from local dev is where the settlement signing key comes from:
 *
 *   - In the enclave: the key is provisioned/derived by the platform and signing
 *     goes through the `fce-sign` pattern. The key material never leaves the TEE.
 *   - In local dev: an ordinary key from ENGINE_SIGNER_PRIVATE_KEY.
 *
 * Because the signing key is the same shape either way (an secp256k1 key whose
 * address is bound on-chain to the reproducible-build code-hash), the on-chain
 * contract does not care which path produced it — it only checks the recovered
 * signer is whitelisted. That is what makes this a Confidential Compute app and
 * not merely a private server (CLAUDE.md §2.3).
 */
import { MatchingEngine, type EngineConfig, type FtsoReader } from "../engine.js";
import { generateKeypair, type SealedKeypair } from "../seal.js";

export interface ExtensionBootOptions {
  reader: FtsoReader;
  config: EngineConfig;
  /** Enclave-provided signing key (fce-sign). In dev, ENGINE_SIGNER_PRIVATE_KEY. */
  signerKey: string;
  /** Persisted sealed-box keypair; generated on first boot if absent. */
  keypair?: SealedKeypair;
}

export interface BootedExtension {
  engine: MatchingEngine;
  sealedPublicKey: string;
  signerAddress: string;
}

/**
 * Boot the engine as it runs inside FCC. In a real deployment, `signerKey` is
 * obtained through fce-sign rather than an env var, and `keypair` is sealed to
 * the enclave — but the wiring here is identical, which is the point: the code
 * that gets measured/whitelisted is exactly this.
 */
export async function bootExtension(opts: ExtensionBootOptions): Promise<BootedExtension> {
  const keypair = opts.keypair ?? (await generateKeypair());
  const engine = new MatchingEngine(keypair, opts.signerKey, opts.reader, opts.config);
  return {
    engine,
    sealedPublicKey: engine.publicKey,
    signerAddress: engine.signerAddress,
  };
}
