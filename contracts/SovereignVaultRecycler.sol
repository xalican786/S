// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SovereignRecycler — Profit reinvestment engine
// Receives 20% of each execution profit from SovereignVault
// Deposits to Aave to earn yield and increase flash loan capacity
// As aToken balance grows, more flash capital becomes available

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IAToken {
    function balanceOf(address account) external view returns (uint256);
}

contract SovereignRecycler {
    address public immutable owner;
    address public immutable treasury;

    address constant USDC      = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant A_USDC    = 0x625E7708f30cA75bfd92586e17077590C60eb4cD; // aPolUSDC

    uint256 public totalRecycled;
    uint256 public totalYield;
    uint256 public lastDeposit;

    event Recycled(uint256 amount, uint256 totalInAave);
    event YieldHarvested(uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "R:!owner");
        _;
    }

    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury;
    }

    // Called when USDC arrives from vault
    receive() external payable {}

    // Deposit USDC to Aave — increases flash loan capacity
    function recycle(uint256 amount) external {
        uint256 bal = IERC20(USDC).balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt > 0, "R:zero");
        IERC20(USDC).approve(AAVE_POOL, amt);
        IAavePool(AAVE_POOL).supply(USDC, amt, address(this), 0);
        totalRecycled += amt;
        lastDeposit    = block.timestamp;
        emit Recycled(amt, IAToken(A_USDC).balanceOf(address(this)));
    }

    // Harvest yield — difference between aToken balance and deposited
    function harvestYield() external onlyOwner {
        uint256 aBalance = IAToken(A_USDC).balanceOf(address(this));
        if (aBalance > totalRecycled) {
            uint256 yield = aBalance - totalRecycled;
            IAavePool(AAVE_POOL).withdraw(USDC, yield, treasury);
            totalYield += yield;
            emit YieldHarvested(yield);
        }
    }

    // Emergency withdraw all from Aave
    function withdrawAll() external onlyOwner {
        uint256 aBalance = IAToken(A_USDC).balanceOf(address(this));
        if (aBalance > 0) {
            IAavePool(AAVE_POOL).withdraw(USDC, type(uint256).max, treasury);
        }
    }

    // Total capital in Aave (principal + yield)
    function aaveBalance() external view returns (uint256) {
        return IAToken(A_USDC).balanceOf(address(this));
    }
}
