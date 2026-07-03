import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { InterfaceAbi } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "../../../contracts");

interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}

/**
 * Load a compiled Hardhat artifact from the contracts workspace. Run
 * `pnpm --filter @eclipse/contracts build` first so the artifact exists.
 */
export function loadArtifact(contractName: string): Artifact {
  const path = resolve(
    contractsRoot,
    "artifacts/src",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return { abi: json.abi, bytecode: json.bytecode };
  } catch (err) {
    throw new Error(
      `Could not load artifact for ${contractName} at ${path}. ` +
        `Build the contracts first: pnpm --filter @eclipse/contracts build`,
    );
  }
}
