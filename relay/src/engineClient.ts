import { SignedSettlementSchema, type SealedOrder, type SignedSettlement } from "@eclipse/shared";

export interface EnginePubkey {
  publicKey: string;
  signerAddress: string;
}

export interface BatchResponse {
  crossed: boolean;
  batchId: string;
  signed: SignedSettlement | null;
}

/** Structural interface so the relay can be unit-tested with a stub engine. */
export interface IEngineClient {
  pubkey(): Promise<EnginePubkey>;
  runBatch(orders: SealedOrder[]): Promise<BatchResponse>;
}

/** Talks to the (trusted) engine over the loopback / private link. The relay
 * forwards ciphertext and receives only the public signed settlement back. */
export class EngineClient implements IEngineClient {
  constructor(private readonly baseUrl: string) {}

  async pubkey(): Promise<EnginePubkey> {
    const res = await fetch(`${this.baseUrl}/pubkey`);
    if (!res.ok) throw new Error(`engine /pubkey failed: ${res.status}`);
    return (await res.json()) as EnginePubkey;
  }

  async runBatch(orders: SealedOrder[]): Promise<BatchResponse> {
    const res = await fetch(`${this.baseUrl}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orders }),
    });
    if (!res.ok) throw new Error(`engine /batch failed: ${res.status}`);
    const body = (await res.json()) as { crossed: boolean; batchId: string; signed: unknown };
    const signed = body.signed ? SignedSettlementSchema.parse(body.signed) : null;
    return { crossed: body.crossed, batchId: body.batchId, signed };
  }
}
