// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice Minimal view of the canonical `FlareContractRegistry`.
/// @dev Mirrors `@flarenetwork/flare-periphery-contracts`. Kept local so the
/// build is deterministic and does not depend on the periphery package's
/// pinned solc version. The registry address is the same on every Flare network
/// and is the ONLY hardcoded protocol address permitted (CLAUDE.md §2.2).
interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);

    function getContractAddressByHash(bytes32 _nameHash) external view returns (address);
}
