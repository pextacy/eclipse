import { Contract, JsonRpcProvider } from "ethers";
import { FLARE_CONTRACT_REGISTRY, XRP_USD_FEED_ID } from "@eclipse/shared";
import type { FtsoReader } from "./engine.js";
import type { FtsoRef } from "./auction.js";

const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FTSO_ABI = [
  "function getFeedById(bytes21) payable returns (uint256 value, int8 decimals, uint64 timestamp)",
];

/** Reads the real FTSOv2 XRP/USD feed on Coston2 (no mock — CLAUDE.md §2). */
export class LiveFtsoReader implements FtsoReader {
  private readonly provider: JsonRpcProvider;
  private readonly feedId: string;

  constructor(rpc: string, feedId: string = XRP_USD_FEED_ID) {
    this.provider = new JsonRpcProvider(rpc);
    this.feedId = feedId;
  }

  async read(): Promise<FtsoRef> {
    const registry = new Contract(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, this.provider);
    const ftsoAddr: string = await registry.getFunction("getContractAddressByName")("FtsoV2");
    const ftso = new Contract(ftsoAddr, FTSO_ABI, this.provider);
    // Read via eth_call (staticCall) — no fee needed to read the value.
    const [value, decimals] = await ftso.getFunction("getFeedById").staticCall(this.feedId);
    return { value: BigInt(value), decimals: Number(decimals) };
  }
}

/** Fixed reference for local dev / tests. */
export class StaticFtsoReader implements FtsoReader {
  constructor(private readonly ref: FtsoRef) {}
  async read(): Promise<FtsoRef> {
    return this.ref;
  }
}
