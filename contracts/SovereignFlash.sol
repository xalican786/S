// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SovereignFlash — Multi-source flash loan orchestrator
// Balancer: 0% fee, up to vault balance
// Aave V3: 0.09% fee, up to available liquidity
// Sequences flash sources to maximise capital per execution

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface ISovereign {
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

contract SovereignFlash {
    address public immutable owner;
    address public           sovereign;

    address constant BALANCER  = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "SF:reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "SF:!owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSovereign(address _sovereign) external onlyOwner {
        sovereign = _sovereign;
    }

    // Execute Balancer flash — 0% fee
    function balancerFlash(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external nonReentrant onlyOwner {
        IBalancerVault(BALANCER).flashLoan(sovereign, tokens, amounts, userData);
    }

    // Execute Aave simple flash — 0.09% fee
    function aaveFlash(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external nonReentrant onlyOwner {
        IAavePool(AAVE_POOL).flashLoanSimple(sovereign, asset, amount, params, 0);
    }

    // Query Balancer vault token balance (= max flash available)
    function balancerAvailable(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(BALANCER);
    }
}
