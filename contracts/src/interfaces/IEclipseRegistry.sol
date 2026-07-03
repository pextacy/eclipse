// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice The trust anchor: which TEE build (code-hash) is allowed to sign
/// settlements, and the signer address bound to it.
interface IEclipseRegistry {
    /// @return true if `signer` is bound to a currently-whitelisted code-hash.
    function isAuthorized(address signer) external view returns (bool);

    /// @return the code-hash `signer` is bound to (zero if none).
    function codeHashOf(address signer) external view returns (bytes32);
}
