// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEclipseRegistry} from "./interfaces/IEclipseRegistry.sol";

/// @title EclipseRegistry
/// @notice Thin trust anchor for Eclipse settlement. Holds the set of
/// whitelisted TEE code-hashes and the signer public key each one is bound to.
/// `EclipseSettlement` accepts a settlement ONLY if it recovers to a signer that
/// is bound to a currently-whitelisted code-hash here.
///
/// @dev The chain trusts the *build*, not the operator (CLAUDE.md §2.3). In
/// production `owner` is a governance/multisig. Traders never depend on the
/// owner for custody: idle escrow in EclipseSettlement is always withdrawable
/// regardless of the signer set (CLAUDE.md §2.4).
contract EclipseRegistry is IEclipseRegistry, Ownable {
    /// @dev code-hash => signer bound to it (zero if the hash is not registered).
    mapping(bytes32 => address) public signerOf;
    /// @dev signer => code-hash it is bound to (zero if not authorized).
    mapping(address => bytes32) private _codeHashOf;

    error ZeroCodeHash();
    error ZeroSigner();
    error CodeHashAlreadyRegistered();
    error CodeHashNotRegistered();
    error SignerAlreadyBound();

    event CodeHashRegistered(bytes32 indexed codeHash, address indexed signer);
    event CodeHashRevoked(bytes32 indexed codeHash, address indexed signer);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Whitelist a reproducible-build code-hash and bind it to the
    /// attested extension's signer public key.
    /// @dev Verifying the hardware attestation happens once, off-chain / at
    /// registration time; thereafter settlements are checked cheaply against the
    /// registered signer (see risk register in phases.md).
    function registerCodeHash(bytes32 codeHash, address signer) external onlyOwner {
        if (codeHash == bytes32(0)) revert ZeroCodeHash();
        if (signer == address(0)) revert ZeroSigner();
        if (signerOf[codeHash] != address(0)) revert CodeHashAlreadyRegistered();
        if (_codeHashOf[signer] != bytes32(0)) revert SignerAlreadyBound();

        signerOf[codeHash] = signer;
        _codeHashOf[signer] = codeHash;
        emit CodeHashRegistered(codeHash, signer);
    }

    /// @notice Revoke a code-hash. A settlement signed by its signer then reverts.
    function revokeCodeHash(bytes32 codeHash) external onlyOwner {
        address signer = signerOf[codeHash];
        if (signer == address(0)) revert CodeHashNotRegistered();

        delete signerOf[codeHash];
        delete _codeHashOf[signer];
        emit CodeHashRevoked(codeHash, signer);
    }

    /// @inheritdoc IEclipseRegistry
    function isAuthorized(address signer) external view returns (bool) {
        return _codeHashOf[signer] != bytes32(0);
    }

    /// @inheritdoc IEclipseRegistry
    function codeHashOf(address signer) external view returns (bytes32) {
        return _codeHashOf[signer];
    }
}
