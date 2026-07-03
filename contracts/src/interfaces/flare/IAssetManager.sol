// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice Minimal view of the FAssets `AssetManager`.
/// @dev Used off-chain by the deploy/resolver scripts to resolve the FXRP ERC-20
/// address dynamically via `fAsset()` — the legacy hardcoded FXRP address is
/// deprecated (CLAUDE.md §2.2). Kept here so tooling shares one interface.
interface IAssetManager {
    function fAsset() external view returns (address);
}
