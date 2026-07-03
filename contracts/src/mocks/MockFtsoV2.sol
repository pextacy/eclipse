// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IFtsoV2} from "../interfaces/flare/IFtsoV2.sol";

/// @notice TEST-ONLY FTSOv2 stand-in with a settable XRP/USD value.
/// @dev Used only on the local Hardhat network to exercise the on-chain band
/// check. The deployed demo reads the real FTSOv2 feed via the registry.
contract MockFtsoV2 is IFtsoV2 {
    uint256 public value;
    int8 public feedDecimals;
    uint64 public timestamp;

    constructor(uint256 _value, int8 _decimals) {
        value = _value;
        feedDecimals = _decimals;
        timestamp = 1;
    }

    function setValue(uint256 _value) external {
        value = _value;
    }

    function getFeedById(bytes21) external payable returns (uint256, int8, uint64) {
        return (value, feedDecimals, timestamp);
    }
}
