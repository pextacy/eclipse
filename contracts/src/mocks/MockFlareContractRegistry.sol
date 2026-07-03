// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IFlareContractRegistry} from "../interfaces/flare/IFlareContractRegistry.sol";

/// @notice TEST-ONLY FlareContractRegistry stand-in. Lets local tests wire the
/// "FtsoV2"/"FeeCalculator" names to mock contracts. The deployed demo points at
/// the real registry at 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019.
contract MockFlareContractRegistry is IFlareContractRegistry {
    mapping(bytes32 => address) private _byHash;

    function setAddress(string calldata name, address addr) external {
        _byHash[keccak256(bytes(name))] = addr;
    }

    function getContractAddressByName(string calldata name) external view returns (address) {
        return _byHash[keccak256(bytes(name))];
    }

    function getContractAddressByHash(bytes32 nameHash) external view returns (address) {
        return _byHash[nameHash];
    }
}
