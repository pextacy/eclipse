// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST-ONLY stand-in for FXRP / USDT0 on the local Hardhat network.
/// @dev CLAUDE.md §2.1 permits simulation ONLY in local unit tests. The deployed
/// Coston2 demo uses the real faucet FXRP/USDT0 resolved via the registry — this
/// mock is never in the settlement path there.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
