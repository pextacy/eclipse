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
  /** Optional shared token for the engine's /batch auth (loopback needs none). */
  constructor(
    private readonly baseUrl: string,
    private readonly operatorToken?: string,
  ) {}

  async pubkey(): Promise<EnginePubkey> {
    const res = await fetch(`${this.baseUrl}/pubkey`);
    if (!res.ok) throw new Error(`engine /pubkey failed: ${res.status}`);
    return (await res.json()) as EnginePubkey;
  }

  async runBatch(orders: SealedOrder[]): Promise<BatchResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.operatorToken) headers["x-operator-token"] = this.operatorToken;
    const res = await fetch(`${this.baseUrl}/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ orders }),
    });
    if (!res.ok) throw new Error(`engine /batch failed: ${res.status}`);
    const body = (await res.json()) as { crossed: boolean; batchId: string; signed: unknown };
    const signed = body.signed ? SignedSettlementSchema.parse(body.signed) : null;
    return { crossed: body.crossed, batchId: body.batchId, signed };
  }
}
