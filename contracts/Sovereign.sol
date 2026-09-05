// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// SOVEREIGN — Master MEV Executor
// Flash loans from Balancer (0% fee) + Aave V3 (0.09% fee)
// Strategies: JIT liquidity, arbitrage, sandwich, liquidation
// All atomic — profit or revert, never partial
// Treasury: 0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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

interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee;
        int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId; uint128 liquidity;
        uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId; address recipient;
        uint128 amount0Max; uint128 amount1Max;
    }
    function mint(MintParams calldata) external returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external returns (uint256, uint256);
    function collect(CollectParams calldata) external returns (uint256, uint256);
    function burn(uint256 tokenId) external;
}

interface ISovereignVault {
    function deposit(address token, uint256 amount) external;
}

contract Sovereign {
    // ── IMMUTABLES ────────────────────────────────────────────────────────────
    address public immutable owner;
    address public immutable treasury;

    // ── PROTOCOL ADDRESSES — Polygon ─────────────────────────────────────────
    address constant BALANCER  = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant NFPM      = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant USDC      = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant WETH      = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address constant WBTC      = 0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6;
    address constant USDT      = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    // ── COMPANION CONTRACTS ───────────────────────────────────────────────────
    address public vault;
    address public signal;
    address public recycler;
    address public amplifier;

    // ── STATE ─────────────────────────────────────────────────────────────────
    bool    private _locked;
    uint256 public  totalProfit;
    uint256 public  totalExecutions;
    uint256 public  successfulExecutions;

    // ── STRATEGY ENUM ─────────────────────────────────────────────────────────
    uint8 constant STRAT_JIT         = 1;
    uint8 constant STRAT_ARB         = 2;
    uint8 constant STRAT_SANDWICH    = 3;
    uint8 constant STRAT_LIQUIDATION = 4;
    uint8 constant STRAT_COMBINED    = 5;

    // ── EVENTS ────────────────────────────────────────────────────────────────
    event Executed(uint8 strategy, uint256 profit, uint256 flashUsed);
    event Swept(address token, uint256 amount);
    event CompanionSet(string name, address addr);

    modifier nonReentrant() {
        require(!_locked, "S:reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "S:owner");
        _;
    }

    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury;
    }

    // ── SET COMPANIONS ────────────────────────────────────────────────────────
    function setCompanions(
        address _vault,
        address _signal,
        address _recycler,
        address _amplifier
    ) external onlyOwner {
        vault     = _vault;
        signal    = _signal;
        recycler  = _recycler;
        amplifier = _amplifier;
        emit CompanionSet("vault",     _vault);
        emit CompanionSet("signal",    _signal);
        emit CompanionSet("recycler",  _recycler);
        emit CompanionSet("amplifier", _amplifier);
    }

    // ── ENTRY: BALANCER FLASH ─────────────────────────────────────────────────
    function execute(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint8   strategy,
        bytes   calldata stratData
    ) external nonReentrant onlyOwner {
        totalExecutions++
        bytes memory userData = abi.encode(strategy, stratData);
        IBalancerVault(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    // ── BALANCER CALLBACK ─────────────────────────────────────────────────────
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes    memory userData
    ) external nonReentrant {
        require(msg.sender == BALANCER, "S:!balancer");

        (uint8 strategy, bytes memory stratData) = abi.decode(userData, (uint8, bytes));
        uint256 balBefore = IERC20(tokens[0]).balanceOf(address(this));

        if      (strategy == STRAT_JIT)         _jit(tokens, amounts, stratData);
        else if (strategy == STRAT_ARB)         _arb(tokens, amounts, stratData);
        else if (strategy == STRAT_SANDWICH)    _sandwich(tokens, amounts, stratData);
        else if (strategy == STRAT_LIQUIDATION) _liquidation(tokens, amounts, stratData);
        else if (strategy == STRAT_COMBINED)    _combined(tokens, amounts, stratData);

        // Repay Balancer — zero fee
        for (uint256 i; i < tokens.length;) {
            uint256 owed = amounts[i] + feeAmounts[i];
            require(
                IERC20(tokens[i]).balanceOf(address(this)) >= owed,
                "S:insufficient repay"
            );
            IERC20(tokens[i]).transfer(BALANCER, owed);
            unchecked { ++i; }
        }

        // Profit to treasury
        uint256 profit = IERC20(tokens[0]).balanceOf(address(this));
        if (profit > 0) {
            if (vault != address(0)) {
                IERC20(tokens[0]).approve(vault, profit);
                ISovereignVault(vault).deposit(tokens[0], profit);
            } else {
                IERC20(tokens[0]).transfer(treasury, profit);
            }
            totalProfit += profit;
            successfulExecutions++;
            emit Executed(strategy, profit, amounts[0]);
            emit Swept(tokens[0], profit);
        }
    }

    // ── AAVE SIMPLE FLASH CALLBACK ────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external nonReentrant returns (bool) {
        require(msg.sender == AAVE_POOL, "S:!aave");
        require(initiator == address(this), "S:!init");

        (uint8 strategy, bytes memory stratData) = abi.decode(params, (uint8, bytes));
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = asset;
        amounts[0] = amount;

        if      (strategy == STRAT_ARB)  _arb(tokens, amounts, stratData);
        else if (strategy == STRAT_JIT)  _jit(tokens, amounts, stratData);

        // Repay Aave
        uint256 owed = amount + premium;
        IERC20(asset).approve(AAVE_POOL, owed);
        return true;
    }

    // ── STRATEGY 1: JIT LIQUIDITY ─────────────────────────────────────────────
    // Provide concentrated liquidity for one block, capture swap fees
    // Real profit: 0.05% of swap volume × position size / total liquidity
    function _jit(
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory data
    ) internal {
        (
            address token0,
            address token1,
            uint24  fee,
            int24   tickLower,
            int24   tickUpper,
            uint256 minProfit
        ) = abi.decode(data, (address, address, uint24, int24, int24, uint256));

        IERC20(tokens[0]).approve(NFPM, amounts[0]);

        (uint256 tokenId, uint128 liquidity,,) = INonfungiblePositionManager(NFPM).mint(
            INonfungiblePositionManager.MintParams({
                token0:         token0,
                token1:         token1,
                fee:            fee,
                tickLower:      tickLower,
                tickUpper:      tickUpper,
                amount0Desired: amounts[0],
                amount1Desired: 0,
                amount0Min:     0,
                amount1Min:     0,
                recipient:      address(this),
                deadline:       block.timestamp + 60
            })
        );

        // Withdraw immediately after swap executes in same block
        INonfungiblePositionManager(NFPM).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId:    tokenId,
                liquidity:  liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline:   block.timestamp
            })
        );

        INonfungiblePositionManager(NFPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId:    tokenId,
                recipient:  address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        INonfungiblePositionManager(NFPM).burn(tokenId);

        require(
            IERC20(tokens[0]).balanceOf(address(this)) >= amounts[0] + minProfit,
            "S:JIT unprofitable"
        );
    }

    // ── STRATEGY 2: ARBITRAGE ─────────────────────────────────────────────────
    // Exploit price difference between two pools
    // Real profit: spread × flash amount, after gas
    function _arb(
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory data
    ) internal {
        (
            address pool1,
            address pool2,
            bool    zeroForOne1,
            bool    zeroForOne2,
            uint256 minProfit
        ) = abi.decode(data, (address, address, bool, bool, uint256));

        IERC20(tokens[0]).approve(pool1, amounts[0]);

        // Swap on pool1
        (int256 a0, int256 a1) = IUniswapV3Pool(pool1).swap(
            address(this),
            zeroForOne1,
            int256(amounts[0]),
            zeroForOne1
                ? 4295128740
                : 1461446703485210103287273052203988822378723970341,
            abi.encode(tokens[0])
        );

        // Determine output token and amount
        address midToken  = zeroForOne1 ? IUniswapV3Pool(pool1).token1() : IUniswapV3Pool(pool1).token0();
        uint256 midAmount = uint256(zeroForOne1 ? -a1 : -a0);

        IERC20(midToken).approve(pool2, midAmount);

        // Swap back on pool2
        IUniswapV3Pool(pool2).swap(
            address(this),
            zeroForOne2,
            int256(midAmount),
            zeroForOne2
                ? 4295128740
                : 1461446703485210103287273052203988822378723970341,
            abi.encode(midToken)
        );

        require(
            IERC20(tokens[0]).balanceOf(address(this)) >= amounts[0] + minProfit,
            "S:ARB unprofitable"
        );
    }

    // ── STRATEGY 3: SANDWICH ──────────────────────────────────────────────────
    // Front-run a large pending swap, back-run after it executes
    // Real profit: slippage captured from victim swap
    function _sandwich(
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory data
    ) internal {
        (
            address pool,
            bool    zeroForOne,
            uint256 frontAmount,
            uint256 minProfit
        ) = abi.decode(data, (address, bool, uint256, uint256));

        require(frontAmount <= amounts[0], "S:front > flash");

        // Front-run: buy before victim
        IERC20(tokens[0]).approve(pool, frontAmount);
        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(frontAmount),
            zeroForOne
                ? 4295128740
                : 1461446703485210103287273052203988822378723970341,
            abi.encode(tokens[0])
        );

        // Victim swap executes here (same block, different tx position)
        // Back-run: sell after victim moves price
        address outToken = zeroForOne
            ? IUniswapV3Pool(pool).token1()
            : IUniswapV3Pool(pool).token0();
        uint256 outBal = IERC20(outToken).balanceOf(address(this));

        IERC20(outToken).approve(pool, outBal);
        IUniswapV3Pool(pool).swap(
            address(this),
            !zeroForOne,
            int256(outBal),
            !zeroForOne
                ? 4295128740
                : 1461446703485210103287273052203988822378723970341,
            abi.encode(outToken)
        );

        require(
            IERC20(tokens[0]).balanceOf(address(this)) >= amounts[0] + minProfit,
            "S:SANDWICH unprofitable"
        );
    }

    // ── STRATEGY 4: LIQUIDATION ───────────────────────────────────────────────
    // Liquidate undercollateralised Aave positions for 5–15% bonus
    function _liquidation(
        address[] memory tokens,
        uint256[] memory,
        bytes memory data
    ) internal {
        (
            address collateralAsset,
            address debtAsset,
            address user,
            uint256 debtAmount,
            uint256 minProfit
        ) = abi.decode(data, (address, address, address, uint256, uint256));

        IERC20(debtAsset).approve(AAVE_POOL, debtAmount);

        (bool ok,) = AAVE_POOL.call(
            abi.encodeWithSignature(
                "liquidationCall(address,address,address,uint256,bool)",
                collateralAsset, debtAsset, user, debtAmount, false
            )
        );
        require(ok, "S:LIQ failed");

        uint256 colBal = IERC20(collateralAsset).balanceOf(address(this));
        if (colBal > 0) IERC20(collateralAsset).transfer(treasury, colBal);

        require(
            IERC20(tokens[0]).balanceOf(address(this)) >= debtAmount + minProfit,
            "S:LIQ unprofitable"
        );
    }

    // ── STRATEGY 5: COMBINED ──────────────────────────────────────────────────
    // JIT + ARB in same flash — maximises flash capital utilisation
    function _combined(
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory data
    ) internal {
        (bytes memory jitData, bytes memory arbData) = abi.decode(data, (bytes, bytes));
        uint256 half = amounts[0] / 2;
        uint256[] memory halfAmounts = new uint256[](1);
        halfAmounts[0] = half;
        _jit(tokens, halfAmounts, jitData);
        _arb(tokens, halfAmounts, arbData);
    }

    // ── UNISWAP V3 SWAP CALLBACK ──────────────────────────────────────────────
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        address token = abi.decode(data, (address));
        if (amount0Delta > 0) {
            IERC20(token).transfer(msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            IERC20(token).transfer(msg.sender, uint256(amount1Delta));
        }
    }

    // ── EMERGENCY SWEEP ───────────────────────────────────────────────────────
    function sweep(address[] calldata tokens) external onlyOwner {
        for (uint256 i; i < tokens.length;) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(treasury, bal);
            unchecked { ++i; }
        }
    }

    function tipBuilder() external payable onlyOwner {
        if (block.coinbase != address(0) && msg.value > 0) {
            (bool ok,) = block.coinbase.call{value: msg.value}("");
            if (!ok) payable(treasury).transfer(msg.value);
        }
    }

    receive() external payable {}
    fallback() external payable {}
}
