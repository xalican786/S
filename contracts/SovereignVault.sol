// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SovereignVault — Treasury accumulator
// All profits land here. Operator withdraws via ModemPay.
// Balance is real on-chain USDC. Withdrawal is real.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

contract SovereignVault {
    address public immutable owner;
    address public immutable treasury;
    address public            sovereign;
    address public            recycler;

    address constant USDC      = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalToRecycler;

    // Split: 70% treasury, 20% recycler, 10% reserve in vault
    uint256 constant TREASURY_BPS  = 7000;
    uint256 constant RECYCLER_BPS  = 2000;
    uint256 constant RESERVE_BPS   = 1000;
    uint256 constant BPS_BASE      = 10000;

    event Deposited(address token, uint256 amount, uint256 toTreasury, uint256 toRecycler);
    event Withdrawn(address to, uint256 amount);

    modifier onlyAuth() {
        require(
            msg.sender == owner ||
            msg.sender == sovereign ||
            msg.sender == recycler,
            "V:!auth"
        );
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "V:!owner");
        _;
    }

    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury;
    }

    function setSovereign(address _sovereign) external onlyOwner {
        sovereign = _sovereign;
    }

    function setRecycler(address _recycler) external onlyOwner {
        recycler = _recycler;
    }

    // Called by Sovereign.sol after each successful execution
    function deposit(address token, uint256 amount) external onlyAuth {
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "V:transfer failed"
        );
        totalDeposited += amount;

        uint256 toTreasury = (amount * TREASURY_BPS) / BPS_BASE;
        uint256 toRecycler = (amount * RECYCLER_BPS) / BPS_BASE;
        // Remaining 10% stays in vault as reserve

        if (toTreasury > 0) {
            IERC20(token).transfer(treasury, toTreasury);
            totalWithdrawn += toTreasury;
        }

        if (toRecycler > 0 && recycler != address(0)) {
            IERC20(token).transfer(recycler, toRecycler);
            totalToRecycler += toRecycler;
        }

        emit Deposited(token, amount, toTreasury, toRecycler);
    }

    // Manual withdrawal — operator triggers via dashboard FTW tab
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "V:zero addr");
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "V:insufficient");
        IERC20(token).transfer(to, amt);
        totalWithdrawn += amt;
        emit Withdrawn(to, amt);
    }

    // Supply reserve to Aave to earn yield + increase flash capacity
    function supplyToAave(address token, uint256 amount) external onlyOwner {
        IERC20(token).approve(AAVE_POOL, amount);
        IAavePool(AAVE_POOL).supply(token, amount, address(this), 0);
    }

    // Withdraw from Aave back to vault
    function withdrawFromAave(address token, uint256 amount) external onlyOwner {
        IAavePool(AAVE_POOL).withdraw(token, amount, address(this));
    }

    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
