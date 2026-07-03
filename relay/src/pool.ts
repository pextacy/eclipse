import { SealedOrderSchema, type SealedOrder } from "@eclipse/shared";
import type { Logger } from "./logger.js";

/**
 * In-memory pool of sealed order envelopes awaiting the next batch. The relay
 * validates ONLY the envelope shape (zod) — it can never read the contents.
 */
export class OrderPool {
  private orders: SealedOrder[] = [];
  constructor(private readonly log: Logger) {}

  /** Validate the envelope shape and accept the ciphertext. Throws on bad shape. */
  accept(raw: unknown): SealedOrder {
    const parsed = SealedOrderSchema.parse(raw);
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
