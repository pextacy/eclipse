/**
 * Phase 0 exit gate: print the LIVE, registry-resolved Flare protocol addresses
 * on Coston2. No hardcoded protocol addresses — everything derives from the
 * FlareContractRegistry (CLAUDE.md §2.2).
 *
 *   pnpm --filter @eclipse/scripts resolve
 */
import { FLARE_CONTRACT_REGISTRY, XRP_USD_FEED_ID, COSTON2 } from "@eclipse/shared";
import { provider, optional, explorerAddress } from "./lib/env.js";
import { resolveByName, resolveFxrp } from "./lib/flare.js";
import { erc20 } from "./lib/contracts.js";

async function main() {
  const p = provider();
  const net = await p.getNetwork();
  console.log(`\nNetwork: ${COSTON2.name} (chainId ${net.chainId})`);
  console.log(`Registry (hardcoded root, same on all Flare nets): ${FLARE_CONTRACT_REGISTRY}\n`);

  const names = ["FtsoV2", "FeeCalculator", "FdcHub", "AssetManagerController"];
  console.log("Registry-resolved core contracts:");
  for (const name of names) {
    try {
      const addr = await resolveByName(p, name);
      console.log(`  ${name.padEnd(24)} ${addr}   ${explorerAddress(addr)}`);
    } catch (e) {
      console.log(`  ${name.padEnd(24)} <not found>`);
    }
  }

  console.log("\nFAssets FXRP (resolved via AssetManager.fAsset()):");
  try {
    const override = optional("ASSET_MANAGER_ADDRESS", "");
    const { assetManager, fxrp, symbol } = await resolveFxrp(p, override || undefined);
    const decimals = await erc20(fxrp, p).decimals();
    console.log(`  AssetManager             ${assetManager}`);
    console.log(`  FXRP (${symbol}, ${decimals} dp)      ${fxrp}   ${explorerAddress(fxrp)}`);
  } catch (e) {
    console.log(`  <${(e as Error).message}>`);
  }

  console.log(`\nUSDT0: set USDT0_ADDRESS in .env (faucet quote token — an ERC-20).`);
  const usdt0 = optional("USDT0_ADDRESS", "");
  console.log(`  USDT0                    ${usdt0 || "<not set>"}`);

  console.log(`\nXRP/USD feed id: ${XRP_USD_FEED_ID}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
