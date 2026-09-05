// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SovereignSignal — On-chain MEV signal and bundle commitment
// Records execution commitments before block close
// Prevents front-running by competing bots via commitment scheme

contract SovereignSignal {
    address public immutable owner;
    address public           sovereign;

    struct Signal {
        bytes32 commitment;
        uint256 blockNumber;
        uint256 minProfit;
        bool    revealed;
        bool    executed;
        uint256 actualProfit;
    }

    mapping(bytes32 => Signal) public signals;
    bytes32[] public signalIds;

    uint256 public totalSignals;
    uint256 public executedSignals;
    uint256 public totalProfitSignalled;

    event SignalCommitted(bytes32 indexed id, uint256 blockNumber, uint256 minProfit);
    event SignalRevealed(bytes32 indexed id, uint256 actualProfit);
    event SignalMissed(bytes32 indexed id);

    modifier onlyAuth() {
        require(msg.sender == owner || msg.sender == sovereign, "SIG:!auth");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "SIG:!owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSovereign(address _sovereign) external onlyOwner {
        sovereign = _sovereign;
    }

    // Commit to executing a bundle — hash conceals strategy details
    function commit(
        bytes32 id,
        bytes32 commitment,
        uint256 minProfit
    ) external onlyAuth {
        signals[id] = Signal({
            commitment:   commitment,
            blockNumber:  block.number,
            minProfit:    minProfit,
            revealed:     false,
            executed:     false,
            actualProfit: 0
        });
        signalIds.push(id);
        totalSignals++;
        emit SignalCommitted(id, block.number, minProfit);
    }

    // Reveal outcome after execution
    function reveal(bytes32 id, uint256 actualProfit) external onlyAuth {
        Signal storage s = signals[id];
        require(!s.revealed, "SIG:already revealed");
        s.revealed     = true;
        s.executed     = actualProfit >= s.minProfit;
        s.actualProfit = actualProfit;

        if (s.executed) {
            executedSignals++;
            totalProfitSignalled += actualProfit;
            emit SignalRevealed(id, actualProfit);
        } else {
            emit SignalMissed(id);
        }
    }

    // Landing rate
    function landingRate() external view returns (uint256) {
        if (totalSignals == 0) return 0;
        return (executedSignals * 10000) / totalSignals;
    }

    function getSignal(bytes32 id) external view returns (Signal memory) {
        return signals[id];
    }

    function signalCount() external view returns (uint256) {
        return signalIds.length;
    }
}
