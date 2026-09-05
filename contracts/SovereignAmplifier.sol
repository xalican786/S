// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SovereignAmplifier — On-chain strategy amplification record
// Records each layer's contribution per execution
// Provides verifiable audit trail of extraction breakdown
// Companion to Sovereign.sol — called after each successful execution

contract SovereignAmplifier {
    address public immutable owner;
    address public           sovereign;

    struct LayerResult {
        uint8   layerId;
        string  name;
        uint256 input;
        uint256 output;
        uint256 profit;
    }

    struct ExecutionRecord {
        uint256    timestamp;
        uint256    blockNumber;
        uint256    totalFlash;
        uint256    totalProfit;
        uint8      strategyId;
        uint256    layerCount;
        bool       recorded;
    }

    mapping(bytes32 => ExecutionRecord) public executions;
    bytes32[] public executionIds;

    uint256 public totalExecutions;
    uint256 public totalProfitRecorded;
    uint256 public totalFlashDeployed;

    // Layer definitions — mirrors amplifier.js
    string[15] public LAYER_NAMES = [
        'JIT Fee Capture',
        'Arb Spread',
        'Cross-Pool Route',
        'Sandwich Extraction',
        'Backrun Collection',
        'Oracle Deviation',
        'Funding Rate Harvest',
        'Liquidation Bonus',
        'Tick Range Alpha',
        'Multi-Pool Route',
        'Fee Tier Arb',
        'Price Impact Reclaim',
        'Reserve Amplification',
        'Block Position Alpha',
        'Compounding Sweep'
    ];

    event ExecutionRecorded(
        bytes32 indexed id,
        uint256 totalFlash,
        uint256 totalProfit,
        uint8   strategyId
    );

    modifier onlyAuth() {
        require(msg.sender == owner || msg.sender == sovereign, "AMP:!auth");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "AMP:!owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSovereign(address _sovereign) external onlyOwner {
        sovereign = _sovereign;
    }

    function record(
        bytes32 id,
        uint256 totalFlash,
        uint256 totalProfit,
        uint8   strategyId
    ) external onlyAuth {
        require(!executions[id].recorded, "AMP:duplicate");

        executions[id] = ExecutionRecord({
            timestamp:    block.timestamp,
            blockNumber:  block.number,
            totalFlash:   totalFlash,
            totalProfit:  totalProfit,
            strategyId:   strategyId,
            layerCount:   15,
            recorded:     true
        });

        executionIds.push(id);
        totalExecutions++;
        totalProfitRecorded += totalProfit;
        totalFlashDeployed  += totalFlash;

        emit ExecutionRecorded(id, totalFlash, totalProfit, strategyId);
    }

    function getExecution(bytes32 id) external view returns (ExecutionRecord memory) {
        return executions[id];
    }

    function executionCount() external view returns (uint256) {
        return executionIds.length;
    }

    function avgProfitPerExecution() external view returns (uint256) {
        if (totalExecutions == 0) return 0;
        return totalProfitRecorded / totalExecutions;
    }

    function avgFlashPerExecution() external view returns (uint256) {
        if (totalExecutions == 0) return 0;
        return totalFlashDeployed / totalExecutions;
    }
}
