/**
 * Phase 0 on-chain proof: move 1 test FXRP between two addresses you control on
 * Coston2, printing the explorer link. Proves the plumbing before any product
 * logic exists.
 *
 *   TO_ADDRESS=0x... pnpm --filter @eclipse/scripts transfer:fxrp
 */
import { parseUnits } from "ethers";
import { wallet, required, optional, explorerTx } from "./lib/env.js";
import { resolveFxrp } from "./lib/flare.js";
import { erc20 } from "./lib/contracts.js";

async function main() {
  const w = wallet();
  const to = required("TO_ADDRESS");
  const amountHuman = optional("AMOUNT", "1");

  const { fxrp } = await resolveFxrp(w.provider!, optional("ASSET_MANAGER_ADDRESS", "") || undefined);
  const token = erc20(fxrp, w);
  const decimals: number = Number(await token.decimals());
  const symbol: string = await token.symbol();
  const amount = parseUnits(amountHuman, decimals);

  const before = await token.balanceOf(w.address);
  console.log(`Sending ${amountHuman} ${symbol} (${fxrp}) → ${to}`);
  console.log(`Sender balance: ${before}`);

  const tx = await token.transfer(to, amount);
  console.log(`tx: ${tx.hash}\n${explorerTx(tx.hash)}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber}. ✅ FXRP moved on Coston2.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
