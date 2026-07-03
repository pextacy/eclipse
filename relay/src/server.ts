/**
 * Untrusted relay HTTP server. Stateless intake of sealed orders → forwards
 * ciphertext to the engine → relays the engine-signed settlement on-chain. Holds
 * no custody and no signing authority over funds (CLAUDE.md §6).
 *
 *   pnpm --filter @eclipse/relay start
 *
 *   GET  /health
 *   GET  /engine/pubkey        → engine sealed-box public key + signer address
 *   POST /orders               → accept one SealedOrder envelope
 *   POST /batch/close          → close the batch, relay settlement on-chain
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import "dotenv/config";
import { Relay } from "./relay.js";
import { EngineClient } from "./engineClient.js";
import { OnChainRelay } from "./onchain.js";
import { Logger } from "./logger.js";

export function createRelayServer(relay: Relay, engine: EngineClient) {
  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
      if (req.method === "GET" && req.url === "/engine/pubkey") return send(200, await engine.pubkey());
      if (req.method === "POST" && req.url === "/orders") {
        const accepted = relay.submit(await readJson(req));
        return send(202, { accepted: true, submissionId: accepted.submissionId, pool: relay.pool.size() });
      }
      if (req.method === "POST" && req.url === "/batch/close") {
        return send(200, await relay.closeBatch());
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: (e as Error).message });
    }
  });
}

async function main() {
  const engineUrl = process.env.ENGINE_URL ?? "http://localhost:8899";
  const engine = new EngineClient(engineUrl);

  let onchain: OnChainRelay | undefined;
  const { RELAY_PRIVATE_KEY, COSTON2_RPC, ECLIPSE_SETTLEMENT_ADDRESS } = process.env;
  if (RELAY_PRIVATE_KEY && ECLIPSE_SETTLEMENT_ADDRESS) {
    onchain = new OnChainRelay(
      COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc",
      RELAY_PRIVATE_KEY,
      ECLIPSE_SETTLEMENT_ADDRESS,
    );
  }

  const relay = new Relay({ engine, onchain, logger: new Logger() });
  const port = Number(process.env.RELAY_PORT ?? "8787");
  createRelayServer(relay, engine).listen(port, () => {
    console.log(`Eclipse relay listening on :${port} → engine ${engineUrl}`);
    if (!onchain) console.log("  (dry run: no RELAY_PRIVATE_KEY/settlement address — will not relay on-chain)");
  });
}

// Only run the server when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
