import { SealedOrderSchema, type SealedOrder } from "@eclipse/shared";
import type { Logger } from "./logger.js";

/**
 * In-memory pool of sealed order envelopes awaiting the next batch. The relay
 * validates ONLY the envelope shape (zod) — it can never read the contents.
 */
/** Thrown when the pool is full — surfaced as a 429-class client error. */
export class PoolFull extends Error {
  constructor() {
    super("order pool is full; try the next batch");
    this.name = "PoolFull";
  }
}

export class OrderPool {
  private orders: SealedOrder[] = [];
  /** Hard cap so an unauthenticated flood of valid envelopes can't OOM the relay. */
  constructor(private readonly log: Logger, private readonly maxSize = 10_000) {}

  /** Validate the envelope shape and accept the ciphertext. Throws on bad shape. */
  accept(raw: unknown): SealedOrder {
    const parsed = SealedOrderSchema.parse(raw);
    if (this.orders.length >= this.maxSize) throw new PoolFull();
    this.orders.push(parsed);
    // NOTE: we log only the opaque submissionId and ciphertext length — never
    // any order field, because we cannot read them.
    this.log.info("order accepted", {
      submissionId: parsed.submissionId,
      ciphertextBytes: parsed.ciphertext.length,
    });
    return parsed;
  }

  size(): number {
    return this.orders.length;
  }

  /** Drain the pool for a batch close. */
  drain(): SealedOrder[] {
    const batch = this.orders;
    this.orders = [];
    return batch;
  }
}
