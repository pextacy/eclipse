// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice Minimal view of the FTSO `FeeCalculator`.
/// @dev Mirrors the Flare periphery. Used to stay future-proof against a
/// non-zero feed fee even though the fee is currently 0 on Coston2.
interface IFeeCalculator {
    function calculateFeeByIds(bytes21[] memory _feedIds) external view returns (uint256 _fee);
}
