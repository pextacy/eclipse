import type { Relay } from "./relay.js";
import type { Logger } from "./logger.js";

/**
 * Drives discrete batch auctions on a fixed interval. The Eclipse design clears
 * a batch every `BATCH_INTERVAL_SECONDS` (default 30s); this closes the current
 * batch automatically when orders are pending, so the operator doesn't have to
 * poke `/batch/close` by hand. The scheduler IS the operator, so it bypasses the
 * external close-auth (which exists only to stop *outsiders* force-closing).
 *
 * The tick logic is separated from the timer so it can be unit-tested.
 */
export class BatchScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private nextCloseAt = 0;

  constructor(
    private readonly relay: Relay,
    private readonly intervalMs: number,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** One scheduling step: close the batch iff orders are pending. */
  async tick(): Promise<boolean> {
    this.nextCloseAt = this.now() + this.intervalMs;
    if (this.relay.pool.size() === 0) return false; // nothing to clear
    try {
      const result = await this.relay.closeBatch();
      this.log.info("scheduled batch closed", {
        batchId: result.batchId,
        crossed: result.crossed,
        orderCount: result.orderCount,
      });
      return true;
    } catch (e) {
      this.log.error("scheduled batch close failed", { message: (e as Error).message });
      return false;
    }
  }

  start(): void {
    this.nextCloseAt = this.now() + this.intervalMs;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public batch cadence (no pool size — that stays private). */
  status(): { autoClose: boolean; intervalSeconds: number; nextCloseInSeconds: number } {
    return {
      autoClose: true,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      nextCloseInSeconds: Math.max(0, Math.round((this.nextCloseAt - this.now()) / 1000)),
    };
  }
}
