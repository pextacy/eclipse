/**
 * Phase 2 on-chain proof (end-to-end, no mocks):
 *   4 sealed orders → engine (in-process TEE logic) → one clearing price + net
 *   deltas → a REAL commitBatch + settleBatch on Coston2.
 *
 *   pnpm --filter @eclipse/scripts demo:batch
 *
 * Requires a funded deployment (deployments/coston2.json), DEPLOYER_PRIVATE_KEY
 * (desk A + gas), DEMO_DESK_B_PRIVATE_KEY (desk B), ENGINE_SIGNER_PRIVATE_KEY
 * (registered in EclipseRegistry). Reads the LIVE FTSO XRP/USD feed for the band.
 */
import { Wallet, parseUnits } from "ethers";
import { Side, type Order } from "@eclipse/shared";
import { MatchingEngine, LiveFtsoReader, generateKeypair, sealOrder } from "@eclipse/tee";
import { OnChainRelay } from "@eclipse/relay";
import { provider, required, optional, explorerTx } from "./lib/env.js";
import { loadDeployment } from "./lib/deployments.js";
import { erc20, typed, type SettlementDepositContract } from "./lib/contracts.js";

const SETTLEMENT_DEPOSIT_ABI = ["function deposit(address token, uint256 amount)"];

function order(side: Side, base: bigint, limit: bigint, account: string, nonce: number): Order {
  return {
    side,
    baseAmount: base.toString(),
    limitPrice: limit.toString(),
    account,
    nonce: nonce.toString(),
    expiry: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function main() {
  const dep = loadDeployment("coston2");
  const p = provider();
  const deskA = new Wallet(required("DEPLOYER_PRIVATE_KEY"), p);
  const deskB = new Wallet(required("DEMO_DESK_B_PRIVATE_KEY"), p);
  const bandBps = BigInt(dep.bandBps);

  const fxrpDec = Number(await erc20(dep.fxrp, p).decimals());
  const usdtDec = Number(await erc20(dep.usdt0, p).decimals());

  // 1. Read the live FTSO reference so demo limits sit inside the band.
  const reader = new LiveFtsoReader(optional("COSTON2_RPC", "https://coston2-api.flare.network/ext/C/rpc"));
  const ftso = await reader.read();
  console.log(`Live FTSO XRP/USD = ${ftso.value} (10^${ftso.decimals}) `);
  const nudge = (bps: bigint) => (ftso.value * bps) / 10_000n;
  const buyLimit = ftso.value + nudge(10n); // +0.1%
  const sellLimit = ftso.value - nudge(10n); // −0.1%

  // 2. Desk A escrows USDT0 (buyer), desk B escrows FXRP (seller).
  const qty = parseUnits("10", fxrpDec); // 10 FXRP per order, 2 orders/side = 20 FXRP
  const usdtNeeded = (20n * ftso.value) / 10n ** BigInt(ftso.decimals); // ~20 * price, in 1e0
  const usdtDeposit = parseUnits((usdtNeeded > 0n ? usdtNeeded : 20n).toString(), usdtDec);
  const fxrpDeposit = qty * 2n;

  const settleA = typed<SettlementDepositContract>(dep.eclipseSettlement, SETTLEMENT_DEPOSIT_ABI, deskA);
  const settleB = typed<SettlementDepositContract>(dep.eclipseSettlement, SETTLEMENT_DEPOSIT_ABI, deskB);

  console.log("Depositing escrow…");
  await (await erc20(dep.usdt0, deskA).approve(dep.eclipseSettlement, usdtDeposit)).wait();
  await (await settleA.deposit(dep.usdt0, usdtDeposit)).wait();
  await (await erc20(dep.fxrp, deskB).approve(dep.eclipseSettlement, fxrpDeposit)).wait();
  await (await settleB.deposit(dep.fxrp, fxrpDeposit)).wait();

  // 3. Build the engine (real TEE matching logic + live FTSO). In production this
  //    runs inside the attested FCC extension; here we run the same code locally
  //    signing with the registered engine key.
  const keypair = await generateKeypair();
  const engine = new MatchingEngine(keypair, required("ENGINE_SIGNER_PRIVATE_KEY"), reader, {
    chainId: dep.chainId,
    settlementAddress: dep.eclipseSettlement,
    bandBps,
    batchTtlSeconds: 1800,
  });

  // 4. Four sealed orders (2 buys from A, 2 sells from B).
  const orders: Order[] = [
    order(Side.Buy, qty, buyLimit, deskA.address, 1),
    order(Side.Buy, qty, buyLimit, deskA.address, 2),
    order(Side.Sell, qty, sellLimit, deskB.address, 3),
    order(Side.Sell, qty, sellLimit, deskB.address, 4),
  ];
  const sealed = await Promise.all(
    orders.map(async (o, i) => ({
      ciphertext: await sealOrder(o, keypair.publicKey),
      enginePublicKey: keypair.publicKey,
      submissionId: `00000000-0000-4000-8000-00000000000${i + 1}`,
    })),
  );
  console.log(`Sealed ${sealed.length} orders (ciphertext only leaves the client).`);

  // 5. Match in-enclave → signed net settlement.
  const outcome = await engine.runBatch(sealed);
  if (!outcome.crossed || !outcome.signed) throw new Error("batch did not cross in-band");
  console.log(`Clearing price: ${outcome.signed.settlement.clearingPrice}`);
  console.log(`Net deltas (only these touch chain):`);
  outcome.signed.settlement.accounts.forEach((a, i) => {
    console.log(`  ${a}  FXRP ${outcome.signed!.settlement.fxrpDeltas[i]}  USDT0 ${outcome.signed!.settlement.usdt0Deltas[i]}`);
  });

  // 6. Relay commit + settle on-chain (relay pays gas, carries no signing authority).
  const onchain = new OnChainRelay(
    optional("COSTON2_RPC", "https://coston2-api.flare.network/ext/C/rpc"),
    required("DEPLOYER_PRIVATE_KEY"),
    dep.eclipseSettlement,
  );
  const tx = await onchain.relay(outcome.signed);
  console.log(`\ncommitBatch:  ${explorerTx(tx.commitTx)}`);
  console.log(`settleBatch:  ${explorerTx(tx.settleTx)}`);
  console.log(`\n✅ 4 sealed orders settled at one FTSO-fair clearing price on Coston2.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
