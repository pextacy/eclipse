import type { Provider } from "ethers";
import { FLARE_CONTRACT_REGISTRY } from "@eclipse/shared";
import {
  erc20,
  typed,
  type RegistryContract,
  type AssetManagerContract,
} from "./contracts.js";

const REGISTRY_ABI = [
  "function getContractAddressByName(string) view returns (address)",
  "function getAllContracts() view returns (string[], address[])",
];
const ASSET_MANAGER_CONTROLLER_ABI = ["function getAssetManagers() view returns (address[])"];
const ASSET_MANAGER_ABI = ["function fAsset() view returns (address)"];
const ZERO = "0x0000000000000000000000000000000000000000";

export function registry(provider: Provider): RegistryContract {
  return typed<RegistryContract>(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, provider);
}

export async function resolveByName(provider: Provider, name: string): Promise<string> {
  return registry(provider).getContractAddressByName(name);
}

/**
 * Resolve the FXRP ERC-20 address dynamically (CLAUDE.md §2.2 — never hardcode).
 *   1. If ASSET_MANAGER_ADDRESS is provided, call fAsset() on it.
 *   2. Else use the registry's direct "AssetManagerFXRP" entry if present.
 *   3. Else resolve "AssetManagerController", enumerate its asset managers, and
 *      pick the one whose fAsset symbol looks like FXRP.
 */
export async function resolveFxrp(
  provider: Provider,
  assetManagerOverride?: string,
): Promise<{ assetManager: string; fxrp: string; symbol: string }> {
  if (assetManagerOverride) {
    const am = typed<AssetManagerContract>(assetManagerOverride, ASSET_MANAGER_ABI, provider);
    const fxrp = await am.fAsset();
    const symbol = await erc20(fxrp, provider).symbol();
    return { assetManager: assetManagerOverride, fxrp, symbol };
  }

  // Coston2 (and Flare) expose the FXRP asset manager directly in the registry.
  const directAm = await resolveByName(provider, "AssetManagerFXRP").catch(() => ZERO);
  if (directAm && directAm !== ZERO) {
    try {
      const fxrp = await typed<AssetManagerContract>(directAm, ASSET_MANAGER_ABI, provider).fAsset();
      const symbol = await erc20(fxrp, provider).symbol();
      if (symbol.toUpperCase().includes("XRP")) {
        return { assetManager: directAm, fxrp, symbol };
      }
    } catch {
      // fall through to the controller walk
    }
  }

  const controllerAddr = await resolveByName(provider, "AssetManagerController");
  if (!controllerAddr || controllerAddr === ZERO) {
    throw new Error(
      "AssetManagerController not found in the registry. Set ASSET_MANAGER_ADDRESS in .env " +
        "to the FXRP AssetManager (from the Flare FAssets deployment / faucet page).",
    );
  }
  const controller = typed<RegistryContract>(
    controllerAddr,
    ASSET_MANAGER_CONTROLLER_ABI,
    provider,
  );
  const managers = await controller.getAssetManagers();
  for (const m of managers) {
    try {
      const fxrp = await typed<AssetManagerContract>(m, ASSET_MANAGER_ABI, provider).fAsset();
      const symbol = await erc20(fxrp, provider).symbol();
      if (symbol.toUpperCase().includes("XRP")) {
        return { assetManager: m, fxrp, symbol };
      }
    } catch {
      // skip managers that don't expose fAsset / symbol
    }
  }
  throw new Error("No FXRP AssetManager found. Set ASSET_MANAGER_ADDRESS in .env.");
}
