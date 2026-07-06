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
  // Per-batch dedup indexes (cleared on drain). Reject a repeated submissionId or
  // ciphertext WITHIN the current batch so a caller can't amplify the pool (or a
  // batch side) by resubmitting one envelope. Cross-batch resubmission of a
  // resting order stays allowed — the pool is drained each batch.
  private seenSubmissionIds = new Set<string>();
  private seenCiphertexts = new Set<string>();

  /** Hard cap so an unauthenticated flood of valid envelopes can't OOM the relay.
   *  Combined with the schema's per-ciphertext byte cap this bounds total memory.
   *  NOTE: this does NOT stop a flood of DISTINCT junk envelopes — that needs
   *  per-IP/connection rate limiting at the edge (see SECURITY.md residual). */
  constructor(private readonly log: Logger, private readonly maxSize = 5_000) {}

  /** Validate the envelope shape and accept the ciphertext. Throws on bad shape.
   *  Duplicate submissionId/ciphertext within the batch are idempotent no-ops. */
  accept(raw: unknown): SealedOrder {
    const parsed = SealedOrderSchema.parse(raw);
    // Idempotent dedup: a repeat of an already-pooled envelope is ignored, not
    // added again — it can't inflate the pool or a batch side.
    if (this.seenSubmissionIds.has(parsed.submissionId) || this.seenCiphertexts.has(parsed.ciphertext)) {
      return parsed;
    }
    if (this.orders.length >= this.maxSize) throw new PoolFull();
    this.orders.push(parsed);
    this.seenSubmissionIds.add(parsed.submissionId);
    this.seenCiphertexts.add(parsed.ciphertext);
    // Log ONLY the opaque submissionId — never any order field and not the
    // ciphertext length (a length is a plaintext-size side channel if order
    // plaintexts ever vary in size). We cannot read the contents regardless.
    this.log.info("order accepted", { submissionId: parsed.submissionId });
    return parsed;
  }

  size(): number {
    return this.orders.length;
  }

  /** Drain the pool for a batch close; resets the per-batch dedup indexes. */
  drain(): SealedOrder[] {
    const batch = this.orders;
    this.orders = [];
    this.seenSubmissionIds = new Set<string>();
    this.seenCiphertexts = new Set<string>();
    return batch;
  }
}
