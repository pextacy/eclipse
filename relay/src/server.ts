/**
 * Untrusted relay HTTP server. Stateless intake of sealed orders → forwards
 * ciphertext to the engine → relays the engine-signed settlement on-chain. Holds
 * no custody and no signing authority over funds (CLAUDE.md §6).
 *
 *   pnpm --filter @eclipse/relay start
 *
 *   GET  /health
 *   GET  /engine/pubkey        → engine sealed-box public key + signer address
 *   GET  /batch/status         → batch cadence (auto-close countdown; no pool size)
 *   POST /orders               → accept one SealedOrder envelope
 *   POST /batch/close          → close the batch, relay settlement on-chain
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import "dotenv/config";
import { Relay } from "./relay.js";
import { EngineClient } from "./engineClient.js";
import { OnChainRelay } from "./onchain.js";
import { Logger } from "./logger.js";
import { BatchScheduler } from "./scheduler.js";

/** Constant-time string compare (hash to normalize length first). */
function secretEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Cap intake body size so an unauthenticated POST can't exhaust memory. */
const MAX_BODY_BYTES = 256 * 1024;

/** Marks an error as caused by bad client input → HTTP 400 (vs 500 internal). */
class BadRequest extends Error {}

export interface RelayServerOptions {
  /** Shared secret required to close a batch. If unset, close is loopback-only. */
  operatorToken?: string;
  /** Public batch-cadence status for GET /batch/status (no private pool size). */
  status?: () => unknown;
}

export function createRelayServer(relay: Relay, engine: EngineClient, opts: RelayServerOptions = {}) {
  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let raw = "";
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new BadRequest("request body too large"));
          req.destroy();
          return;
        }
        raw += c;
      });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new BadRequest("invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  const isLoopback = (req: IncomingMessage) => {
    const a = req.socket.remoteAddress ?? "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  };

  // Batch close must never be publicly triggerable: an attacker who force-closes
  // right after their own order shrinks the batch and de-anonymizes a victim's
  // sealed trade in the public settlement. Require the operator token, or (if
  // none is configured) restrict to loopback for local demos.
  const authorizedToClose = (req: IncomingMessage) => {
    if (opts.operatorToken) {
      const provided = req.headers["x-operator-token"];
      return typeof provided === "string" && secretEqual(provided, opts.operatorToken);
    }
    // Loopback fallback is only safe when the process listens on 127.0.0.1 with
    // no reverse proxy in front (see main() — it binds to localhost in this mode).
    return isLoopback(req);
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
      if (req.method === "GET" && req.url === "/engine/pubkey") return send(200, await engine.pubkey());
      if (req.method === "GET" && req.url === "/batch/status") {
        return send(200, opts.status ? opts.status() : { autoClose: false });
      }
      if (req.method === "POST" && req.url === "/orders") {
        const accepted = relay.submit(await readJson(req));
        // Do not echo pool size — it is a pre-settlement metadata side channel.
        return send(202, { accepted: true, submissionId: accepted.submissionId });
      }
      if (req.method === "POST" && req.url === "/batch/close") {
        if (!authorizedToClose(req)) return send(401, { error: "unauthorized" });
        return send(200, await relay.closeBatch());
      }
      send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof BadRequest) return send(400, { error: e.message });
      const name = (e as { name?: string })?.name;
      // Malformed sealed-order envelope (zod) is a client error.
      if (name === "ZodError") return send(400, { error: "invalid order envelope" });
      // Pool is full — a retryable client condition, not a server fault.
      if (name === "PoolFull") return send(429, { error: "order pool is full" });
      // Don't leak internals (ethers/RPC messages) to clients.
      relay.log.error("request failed", { message: (e as Error).message });
      send(500, { error: "internal error" });
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

  const logger = new Logger();
  const relay = new Relay({ engine, onchain, logger });
  const port = Number(process.env.RELAY_PORT ?? "8787");
  const operatorToken = process.env.RELAY_OPERATOR_TOKEN?.trim() || undefined;

  // Optional automatic batch scheduler: close a batch every interval when orders
  // are pending, matching the discrete-auction design (default 30s cadence).
  let scheduler: BatchScheduler | undefined;
  if (process.env.RELAY_AUTO_CLOSE === "true") {
    const intervalSec = Number(process.env.BATCH_INTERVAL_SECONDS ?? "30");
    scheduler = new BatchScheduler(relay, intervalSec * 1000, logger);
    scheduler.start();
    console.log(`  auto-close: every ${intervalSec}s (batches clear automatically)`);
  }
  // Without an operator token, bind to localhost ONLY so /batch/close cannot be
  // reached from off-box (a reverse proxy would make every request look like
  // loopback and let anyone force-close a batch). With a token, bind to all
  // interfaces so a remote operator can authenticate.
  const host = operatorToken ? "0.0.0.0" : "127.0.0.1";
  const status = scheduler ? () => scheduler!.status() : undefined;
  createRelayServer(relay, engine, { operatorToken, status }).listen(port, host, () => {
    console.log(`Eclipse relay listening on ${host}:${port} → engine ${engineUrl}`);
    if (!onchain) console.log("  (dry run: no RELAY_PRIVATE_KEY/settlement address — will not relay on-chain)");
    console.log(
      operatorToken
        ? "  batch close: requires x-operator-token header (bound to 0.0.0.0)"
        : "  batch close: loopback-only, bound to 127.0.0.1 (set RELAY_OPERATOR_TOKEN for remote operator)",
    );
  });
}

// Only run the server when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
