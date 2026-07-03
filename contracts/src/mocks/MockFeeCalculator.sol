// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IFeeCalculator} from "../interfaces/flare/IFeeCalculator.sol";

/// @notice TEST-ONLY FeeCalculator stand-in (fee 0 by default, matching Coston2).
contract MockFeeCalculator is IFeeCalculator {
    uint256 public fee;

    constructor(uint256 _fee) {
        fee = _fee;
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function calculateFeeByIds(bytes21[] memory) external view returns (uint256) {
        return fee;
    }
}
