/**
 * Phase 3 config: whitelist the reproducible-build code-hash of the attested TEE
 * engine and bind it to the extension's signer public key in EclipseRegistry.
 * After this, EclipseSettlement only accepts settlements signed by that attested
 * signer; any other build reverts with UnattestedSigner (CLAUDE.md §2.3).
 *
 *   ENGINE_CODE_HASH=0x.. ENGINE_SIGNER_ADDRESS=0x.. \
 *     pnpm --filter @eclipse/scripts register:codehash
 *
 * The code-hash comes from the reproducible build: `pnpm --filter @eclipse/tee build:reproducible`.
 */
import { wallet, required, explorerTx } from "./lib/env.js";
import { loadArtifact } from "./lib/artifacts.js";
import { loadDeployment } from "./lib/deployments.js";
import { typed, type EclipseRegistryContract } from "./lib/contracts.js";

async function main() {
  const w = wallet();
  const codeHash = required("ENGINE_CODE_HASH");
  const signer = required("ENGINE_SIGNER_ADDRESS");
  if (!/^0x[0-9a-fA-F]{64}$/.test(codeHash)) {
    throw new Error("ENGINE_CODE_HASH must be a 32-byte hex string (0x + 64 hex chars).");
  }

  const dep = loadDeployment("coston2");
  const reg = typed<EclipseRegistryContract>(
    dep.eclipseRegistry,
    loadArtifact("EclipseRegistry").abi,
    w,
  );

  console.log(`Registering code-hash ${codeHash}\n  bound to signer ${signer}\n  in EclipseRegistry ${dep.eclipseRegistry}`);
  const tx = await reg.registerCodeHash(codeHash, signer);
  console.log(`tx: ${tx.hash}\n${explorerTx(tx.hash)}`);
  await tx.wait();

  const ok = await reg.isAuthorized(signer);
  console.log(`isAuthorized(${signer}) = ${ok}. ✅ Attested signer whitelisted on Coston2.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
