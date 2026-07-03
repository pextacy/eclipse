/**
 * Phase 1 deploy: publish EclipseRegistry + EclipseSettlement to Coston2 using
 * REGISTRY-RESOLVED token addresses (no hardcoding — CLAUDE.md §2.2). Writes the
 * live addresses to deployments/coston2.json and prints explorer links.
 *
 *   pnpm --filter @eclipse/scripts deploy
 *
 * Then verify the source on the Blockscout explorer from the contracts package:
 *   pnpm --filter @eclipse/contracts exec hardhat verify --network coston2 <settlement> \
 *     <flareRegistry> <eclipseRegistry> <fxrp> <usdt0> <feedId> <bandBps>
 */
import { ContractFactory, computeAddress } from "ethers";
import {
  FLARE_CONTRACT_REGISTRY,
  XRP_USD_FEED_ID,
  DEFAULT_BAND_BPS,
  COSTON2,
} from "@eclipse/shared";
import { wallet, required, optional, explorerAddress } from "./lib/env.js";
import { loadArtifact } from "./lib/artifacts.js";
import { resolveFxrp } from "./lib/flare.js";
import { saveDeployment } from "./lib/deployments.js";
import { type EclipseRegistryContract } from "./lib/contracts.js";

async function main() {
  const w = wallet();
  console.log(`Deployer: ${w.address}`);
  const bandBps = Number(optional("BAND_BPS", String(DEFAULT_BAND_BPS)));

  // Resolve real token addresses.
  const { assetManager, fxrp, symbol } = await resolveFxrp(
    w.provider!,
    optional("ASSET_MANAGER_ADDRESS", "") || undefined,
  );
  // Quote token. NOTE: there is no canonical USDT0 on Coston2 (USDT0 is a Flare
  // *mainnet* token); the operator supplies a real quote ERC-20 via USDT0_ADDRESS.
  const usdt0 = required("USDT0_ADDRESS");
  console.log(`FXRP  (${symbol}): ${fxrp}`);
  console.log(`Quote (USDT0_ADDRESS): ${usdt0}`);

  // Deploy EclipseRegistry(owner = deployer for the demo; multisig in prod).
  const regArt = loadArtifact("EclipseRegistry");
  const RegistryFactory = new ContractFactory(regArt.abi, regArt.bytecode, w);
  const registry = await RegistryFactory.deploy(w.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  const regTx = registry.deploymentTransaction()!.hash;
  console.log(`EclipseRegistry:   ${registryAddr}  ${explorerAddress(registryAddr)}`);

  // Deploy EclipseSettlement.
  const setArt = loadArtifact("EclipseSettlement");
  const SettlementFactory = new ContractFactory(setArt.abi, setArt.bytecode, w);
  const settlement = await SettlementFactory.deploy(
    FLARE_CONTRACT_REGISTRY,
    registryAddr,
    fxrp,
    usdt0,
    XRP_USD_FEED_ID,
    bandBps,
  );
  await settlement.waitForDeployment();
  const settlementAddr = await settlement.getAddress();
  const setTx = settlement.deploymentTransaction()!.hash;
  console.log(`EclipseSettlement: ${settlementAddr}  ${explorerAddress(settlementAddr)}`);

  // Phase 1 dev path: optionally register a DEV engine signer under a placeholder
  // code-hash. This bypasses real attestation, so it is gated behind an explicit
  // ALLOW_DEV_SIGNER=true opt-in — a production deploy must instead whitelist the
  // attested FCC signer via `register:codehash` (Phase 3). Never auto-register.
  const txHashes: Record<string, string> = { registry: regTx, settlement: setTx };
  const devPk = optional("ENGINE_SIGNER_PRIVATE_KEY", "");
  const allowDevSigner = optional("ALLOW_DEV_SIGNER", "").toLowerCase() === "true";
  if (devPk && allowDevSigner) {
    const signerAddr = computeAddress(devPk.startsWith("0x") ? devPk : `0x${devPk}`);
    const codeHash = optional("ENGINE_CODE_HASH", "0x" + "de".repeat(32));
    const reg = registry as unknown as EclipseRegistryContract;
    const tx = await reg.registerCodeHash(codeHash, signerAddr);
    await tx.wait();
    txHashes.registerDevSigner = tx.hash;
    console.log(`⚠️  DEV signer ${signerAddr} registered under placeholder code-hash ${codeHash}`);
    console.log(`    This is NOT attested — for production, register the attested signer instead.`);
  } else if (devPk) {
    console.log(
      "ENGINE_SIGNER_PRIVATE_KEY is set but ALLOW_DEV_SIGNER!=true — skipping dev-signer\n" +
        "  registration. Whitelist the attested signer with `register:codehash` (Phase 3).",
    );
  }

  const blockNumber = await w.provider!.getBlockNumber();
  const path = saveDeployment({
    network: COSTON2.name,
    chainId: COSTON2.chainId,
    eclipseRegistry: registryAddr,
    eclipseSettlement: settlementAddr,
    fxrp,
    usdt0,
    assetManager,
    bandBps,
    feedId: XRP_USD_FEED_ID,
    deployer: w.address,
    blockNumber,
    txHashes,
  });
  console.log(`\nSaved ${path}. ✅ Contracts deployed on Coston2.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
