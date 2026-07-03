/**
 * Engine host process. Holds the sealed-box secret key and the settlement
 * signing key; exposes the minimal surface the (untrusted) relay talks to.
 * In Phase 3 this process is what runs inside the FCC extension / Confidential
 * VM and whose reproducible-build code-hash is whitelisted on-chain.
 *
 *   pnpm --filter @eclipse/tee start
 *
 * Endpoints:
 *   GET  /pubkey  → { publicKey, signerAddress }   (traders seal orders to this)
 *   POST /batch   → { orders: SealedOrder[] } → BatchOutcome (signed net settlement)
 */
import { createServer } from "node:http";
import "dotenv/config";
import { z } from "zod";
import { Contract, JsonRpcProvider } from "ethers";
import { SealedOrderSchema, DEFAULT_BAND_BPS, DEFAULT_BATCH_INTERVAL_SECONDS } from "@eclipse/shared";
import { MatchingEngine } from "./engine.js";
import { LiveFtsoReader, StaticFtsoReader } from "./ftso.js";
import { generateKeypair, type SealedKeypair } from "./seal.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const NONCE_ABI = [
  "function lastSettlementNonce() view returns (uint256)",
  "function lastCommitNonce() view returns (uint256)",
];

/**
 * Resume the batch counter above the highest nonce the settlement contract has
 * already recorded, so a restarted engine can't be bricked by `ReplayedBatch`.
 * Best-effort: on any RPC error we start from 0 (safe on a fresh deployment).
 */
async function seedSequenceFromChain(engine: MatchingEngine, rpc: string, settlementAddress: string) {
  if (!settlementAddress || settlementAddress === ZERO_ADDR) return;
  try {
    const c = new Contract(settlementAddress, NONCE_ABI, new JsonRpcProvider(rpc)) as any;
    const [settle, commit] = await Promise.all([c.lastSettlementNonce(), c.lastCommitNonce()]);
    const highest = settle > commit ? settle : commit;
    engine.seedSequence(BigInt(highest));
    if (highest > 0n) console.log(`  resumed batch counter above on-chain nonce ${highest}`);
  } catch (e) {
    console.warn(`  could not read on-chain nonces (${(e as Error).message}); starting from 0`);
  }
}

const BatchRequest = z.object({ orders: z.array(SealedOrderSchema).min(1).max(1024) });

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.trim() !== "") return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

async function buildEngine(): Promise<MatchingEngine> {
  let keypair: SealedKeypair;
  if (process.env.ENGINE_SEALED_PUBLIC_KEY && process.env.ENGINE_SEALED_SECRET_KEY) {
    keypair = {
      publicKey: process.env.ENGINE_SEALED_PUBLIC_KEY.trim(),
      secretKey: process.env.ENGINE_SEALED_SECRET_KEY.trim(),
    };
  } else {
    keypair = await generateKeypair();
    console.log("Generated ephemeral engine keypair. Publish this public key to traders:");
    console.log(`  ENGINE_SEALED_PUBLIC_KEY=${keypair.publicKey}`);
  }

  const chainId = Number(env("CHAIN_ID", "114"));
  const settlementAddress = env("ECLIPSE_SETTLEMENT_ADDRESS", "0x0000000000000000000000000000000000000000");
  const bandBps = BigInt(env("BAND_BPS", String(DEFAULT_BAND_BPS)));
  const batchTtlSeconds = Number(env("BATCH_INTERVAL_SECONDS", String(DEFAULT_BATCH_INTERVAL_SECONDS))) * 4;

  // Real feed by default; a static reference only if explicitly requested for a
  // network-free local demo (never in the deployed settlement path).
  const reader = process.env.FTSO_STATIC_VALUE
    ? new StaticFtsoReader({
        value: BigInt(process.env.FTSO_STATIC_VALUE),
        decimals: Number(env("FTSO_STATIC_DECIMALS", "8")),
      })
    : new LiveFtsoReader(env("COSTON2_RPC", "https://coston2-api.flare.network/ext/C/rpc"));

  return new MatchingEngine(keypair, env("ENGINE_SIGNER_PRIVATE_KEY"), reader, {
    chainId,
    settlementAddress,
    bandBps,
    batchTtlSeconds,
  });
}

async function main() {
  const engine = await buildEngine();
  await seedSequenceFromChain(
    engine,
    env("COSTON2_RPC", "https://coston2-api.flare.network/ext/C/rpc"),
    env("ECLIPSE_SETTLEMENT_ADDRESS", ZERO_ADDR),
  );
  const port = Number(env("ENGINE_PORT", "8899"));

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/pubkey") {
      return send(200, { publicKey: engine.publicKey, signerAddress: engine.signerAddress });
    }
    if (req.method === "POST" && req.url === "/batch") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        try {
          const parsed = BatchRequest.parse(JSON.parse(raw));
          const outcome = await engine.runBatch(parsed.orders);
          // Only public data is returned: whether it crossed, the batchId, and
          // the signed net settlement. The order book never leaves this process.
          send(200, { crossed: outcome.crossed, batchId: outcome.batchId.toString(), signed: outcome.signed ?? null });
        } catch (e) {
          send(400, { error: (e as Error).message });
        }
      });
      return;
    }
    send(404, { error: "not found" });
  });

  server.listen(port, () => {
    console.log(`Eclipse engine listening on :${port}`);
    console.log(`  signer:  ${engine.signerAddress}`);
    console.log(`  pubkey:  ${engine.publicKey}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
