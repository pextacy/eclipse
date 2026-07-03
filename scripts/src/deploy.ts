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
  const usdt0 = required("USDT0_ADDRESS");
  console.log(`FXRP  (${symbol}): ${fxrp}`);
  console.log(`USDT0:            ${usdt0}`);

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

  // Phase 1 dev path: optionally register a dev engine signer (replaced by the
  // attested FCC signer in Phase 3 via registerCodeHash).
  const txHashes: Record<string, string> = { registry: regTx, settlement: setTx };
  const devPk = optional("ENGINE_SIGNER_PRIVATE_KEY", "");
  if (devPk) {
    const signerAddr = computeAddress(devPk.startsWith("0x") ? devPk : `0x${devPk}`);
    const codeHash = optional("ENGINE_CODE_HASH", "0x" + "de".repeat(32));
    const reg = registry as unknown as EclipseRegistryContract;
    const tx = await reg.registerCodeHash(codeHash, signerAddr);
    await tx.wait();
    txHashes.registerDevSigner = tx.hash;
    console.log(`Registered dev engine signer ${signerAddr} under code-hash ${codeHash}`);
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
