import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const deploymentsDir = resolve(here, "../../../deployments");

export interface Deployment {
  network: string;
  chainId: number;
  eclipseRegistry: string;
  eclipseSettlement: string;
  fxrp: string;
  usdt0: string;
  assetManager: string;
  bandBps: number;
  feedId: string;
  deployer: string;
  blockNumber: number;
  txHashes: Record<string, string>;
}

const file = (network: string) => resolve(deploymentsDir, `${network}.json`);

export function saveDeployment(d: Deployment): string {
  if (!existsSync(deploymentsDir)) mkdirSync(deploymentsDir, { recursive: true });
  const path = file(d.network);
  writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  return path;
}

export function loadDeployment(network = "coston2"): Deployment {
  const path = file(network);
  if (!existsSync(path)) {
    throw new Error(`No deployment found at ${path}. Run: pnpm --filter @eclipse/scripts deploy`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}
