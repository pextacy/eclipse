// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice Minimal view of the FTSOv2 block-latency feed reader.
/// @dev Mirrors `FtsoV2Interface` from the Flare periphery. `getFeedById` is
/// `payable` (fee routed through `IFeeCalculator`, currently 0 on Coston2).
/// The returned `_value` is scaled by `10 ** _decimals`.
interface IFtsoV2 {
    function getFeedById(bytes21 _feedId)
        external
        payable
        returns (uint256 _value, int8 _decimals, uint64 _timestamp);
}
