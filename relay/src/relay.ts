import type { SealedOrder, SignedSettlement } from "@eclipse/shared";
import { Logger } from "./logger.js";
import { OrderPool } from "./pool.js";
import type { IEngineClient } from "./engineClient.js";
import type { OnChainRelay, RelayTxResult } from "./onchain.js";

export interface RelayDeps {
  engine: IEngineClient;
  onchain?: OnChainRelay; // absent in unit tests / dry runs
  logger?: Logger;
}

export interface CloseResult {
  crossed: boolean;
  batchId: string;
  orderCount: number;
  signed: SignedSettlement | null;
  tx?: RelayTxResult;
}

/**
 * The untrusted relay's core logic, decoupled from HTTP so it can be unit
 * tested without a socket. Holds no custody and no settlement-signing authority.
 */
export class Relay {
  readonly pool: OrderPool;
  readonly log: Logger;
  private readonly engine: IEngineClient;
  private readonly onchain?: OnChainRelay;

  constructor(deps: RelayDeps) {
    this.log = deps.logger ?? new Logger();
    this.pool = new OrderPool(this.log);
    this.engine = deps.engine;
    this.onchain = deps.onchain;
  }

  /** Intake a sealed order. Validates envelope shape only. */
  submit(raw: unknown): SealedOrder {
    return this.pool.accept(raw);
  }

  /**
   * Close the current batch: forward the sealed pool to the engine, receive the
   * signed net settlement, and (if wired) relay it on-chain. The relay never
   * sees order contents and never signs the settlement.
   */
  async closeBatch(): Promise<CloseResult> {
    const orders = this.pool.drain();
    this.log.info("closing batch", { orderCount: orders.length });
    if (orders.length === 0) {
      return { crossed: false, batchId: "0", orderCount: 0, signed: null };
    }

    const { crossed, batchId, signed } = await this.engine.runBatch(orders);
    if (!crossed || !signed) {
      this.log.info("batch did not cross in-band", { batchId });
      return { crossed: false, batchId, orderCount: orders.length, signed: null };
    }

    this.log.info("engine returned signed settlement", {
      batchId,
      accounts: signed.settlement.accounts.length,
      clearingPrice: signed.settlement.clearingPrice,
    });

    let tx: RelayTxResult | undefined;
    if (this.onchain) {
      tx = await this.onchain.relay(signed);
      this.log.info("settlement relayed on-chain", { batchId, ...tx });
    }
    return { crossed: true, batchId, orderCount: orders.length, signed, tx };
  }
}
