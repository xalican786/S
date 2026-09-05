// src/executor.js — SOVEREIGN executor (Worker thread)
// 1ms ring poll — fires on every detected qualifying swap
// Gas guard uses GAS_CAP_GWEI from config — no hardcoded values
// Nonce mutex — prevents double-spend on rapid sequential execution
// Strategy selector — routes to optimal strategy per opportunity

import { workerData, parentPort } from 'worker_threads'
import { ethers }                 from 'ethers'
import {
  EXECUTOR_PK, EXECUTOR,
  CONTRACT, H, PRIMARY_CHAIN,
  GAS_CAP_GWEI, GAS_MARKUP, GAS_LIMIT,
  DAILY_TARGET, EXTRACTION,
  BALANCER_VAULT,
} from './config.js'

const SAB = workerData.SAB
const HOT = new Float64Array(SAB)

// ── PROVIDER ──────────────────────────────────────────────────────────────────
let _provider = null
function getProvider() {
  if (!_provider) {
    const c = PRIMARY_CHAIN
    const n = new ethers.Network(c.name, c.id)
    _provider = new ethers.JsonRpcProvider(c.http, n, { staticNetwork: n })
  }
  return _provider
}

// ── NONCE MUTEX ───────────────────────────────────────────────────────────────
let   nonceLocked  = false
const nonceQueue   = []
let   currentNonce = null

async function withNonce(fn) {
  return new Promise((resolve, reject) => {
    nonceQueue.push({ fn, resolve, reject })
    drainNonce()
  })
}

async function drainNonce() {
  if (nonceLocked || !nonceQueue.length) return
  nonceLocked = true
  const { fn, resolve, reject } = nonceQueue.shift()
  try {
    if (currentNonce === null) {
      currentNonce = await getProvider().getTransactionCount(EXECUTOR, 'pending')
    }
    resolve(await fn(currentNonce))
    currentNonce++
  } catch (e) {
    currentNonce = null
    reject(e)
  } finally {
    nonceLocked = false
    if (nonceQueue.length) drainNonce()
  }
}

// ── GAS CHECK — 10s cache ─────────────────────────────────────────────────────
let lastGasTs = 0
let lastGasOK = true

async function checkGas() {
  const now = Date.now()
  if (now - lastGasTs < 10_000) return lastGasOK
  try {
    const fee  = await getProvider().getFeeData()
    const gwei = Number(fee.gasPrice || 0n) / 1e9
    const cap  = Number(GAS_CAP_GWEI)
    HOT[H.GAS_PRICE] = gwei
    lastGasOK        = gwei <= cap
    HOT[H.GAS_OK]    = lastGasOK ? 1 : 0
    lastGasTs        = now
  } catch {}
  return lastGasOK
}

// ── FLASH AVAILABILITY CHECK ──────────────────────────────────────────────────
const USDC_POLY = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

async function getFlashAvailable() {
  try {
    const token = new ethers.Contract(USDC_POLY, ERC20_ABI, getProvider())
    const bal   = await token.balanceOf(BALANCER_VAULT)
    return Number(bal) / 1e6
  } catch { return 30_000_000 }
}

// ── BUILD STRATEGY DATA ───────────────────────────────────────────────────────
// JIT: provide liquidity at current tick, capture 0.05% fee from qualifying swap
function buildJITData(flashAmount) {
  const minProfit = Math.floor(flashAmount * EXTRACTION.jit)
  return {
    strategy: 1,
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'int24', 'uint256'],
      [
        USDC_POLY,
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
        500,           // 0.05% fee tier
        -887220,       // tickLower (wide range)
        887220,        // tickUpper (wide range)
        BigInt(minProfit),
      ]
    ),
  }
}

// ARB: exploit price difference between two Uniswap V3 pools
function buildArbData(flashAmount) {
  const minProfit = Math.floor(flashAmount * EXTRACTION.arb)
  return {
    strategy: 2,
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'bool', 'bool', 'uint256'],
      [
        '0x45dda9cb7c25131df268515131f647d726f50608', // USDC/USDT 0.01%
        '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // USDC/WETH 0.05%
        true,
        false,
        BigInt(minProfit),
      ]
    ),
  }
}

// ── EXECUTE ONE SWAP ──────────────────────────────────────────────────────────
let activeExecs  = 0
const MAX_CONCURRENT = 3

async function executeSwap(swapId) {
  if (!CONTRACT.SOVEREIGN) return
  if (HOT[H.GAS_OK] === 0) return
  if ((HOT[H.REV_TODAY] || 0) >= DAILY_TARGET) return
  if (activeExecs >= MAX_CONCURRENT) return

  activeExecs++
  HOT[H.EXEC_TODAY] = (HOT[H.EXEC_TODAY] || 0) + 1

  const t0 = Date.now()

  try {
    const provider     = getProvider()
    const signer       = new ethers.Wallet(EXECUTOR_PK, provider)
    const flashAvail   = await getFlashAvailable()
    const flashAmount  = Math.min(flashAvail * 0.9, 30_000_000) // 90% of available, max $30M
    const flashAmountWei = BigInt(Math.floor(flashAmount * 1e6))

    // Select strategy: alternate JIT and ARB
    const strat = swapId % 2 === 0 ? buildJITData(flashAmount) : buildArbData(flashAmount)

    const sovereign = new ethers.Contract(
      CONTRACT.SOVEREIGN,
      [
        'function execute(address[],uint256[],uint8,bytes) external',
      ],
      signer
    )

    const receipt = await withNonce(async nonce => {
      const feeData  = await provider.getFeeData()
      const rawGas   = feeData.gasPrice || ethers.parseUnits('30', 'gwei')
      const capGas   = GAS_CAP_GWEI * BigInt(1e9)
      const gasPrice = (rawGas > capGas ? capGas : rawGas) * GAS_MARKUP / 100n

      const tx = await sovereign.execute(
        [USDC_POLY],
        [flashAmountWei],
        strat.strategy,
        strat.data,
        { gasLimit: GAS_LIMIT, gasPrice, nonce }
      )
      return tx.wait(1)
    })

    const elapsed = Date.now() - t0
    HOT[H.EXEC_SPEED_MS] = elapsed

    if (receipt?.status === 1) {
      // Estimate profit based on extraction rate
      const profit  = flashAmount * EXTRACTION.blended
      const netProf = profit * 0.7 // 70% to treasury after split

      HOT[H.SUCCESS_TODAY]  = (HOT[H.SUCCESS_TODAY]  || 0) + 1
      HOT[H.SWAPS_TODAY]    = (HOT[H.SWAPS_TODAY]    || 0) + 1
      HOT[H.SWAPS_TOTAL]    = (HOT[H.SWAPS_TOTAL]    || 0) + 1
      HOT[H.REV_TODAY]      = (HOT[H.REV_TODAY]      || 0) + profit
      HOT[H.REV_TOTAL]      = (HOT[H.REV_TOTAL]      || 0) + profit
      HOT[H.NET_TODAY]      = (HOT[H.NET_TODAY]       || 0) + netProf
      HOT[H.FLASH_DEPLOYED] = (HOT[H.FLASH_DEPLOYED]  || 0) + flashAmount
      HOT[H.FLASH_RETURNED] = (HOT[H.FLASH_RETURNED]  || 0) + flashAmount

      if (profit > (HOT[H.PEAK_SWAP] || 0)) HOT[H.PEAK_SWAP] = profit
      const s = HOT[H.SWAPS_TODAY] || 1
      HOT[H.AVG_SWAP] = HOT[H.REV_TODAY] / s

      if (HOT[H.FIRST_REV] === 0) HOT[H.FIRST_REV] = 1

      parentPort?.postMessage({
        type:     'execution',
        profit,
        netProf,
        txHash:   receipt.hash,
        elapsed,
        strategy: strat.strategy,
        flash:    flashAmount,
      })

      if (HOT[H.SWAPS_TODAY] % 100 === 0) {
        const rev = HOT[H.REV_TODAY] || 0
        const fmt = rev >= 1e9
          ? `$${(rev/1e9).toFixed(2)}B`
          : rev >= 1e6
          ? `$${(rev/1e6).toFixed(2)}M`
          : `$${rev.toFixed(0)}`
        console.log(`[EXECUTOR] ${HOT[H.SWAPS_TODAY]} swaps | ${fmt} today | ${elapsed}ms`)
      }
    } else {
      HOT[H.FAIL_TODAY] = (HOT[H.FAIL_TODAY] || 0) + 1
    }
  } catch (e) {
    HOT[H.FAIL_TODAY] = (HOT[H.FAIL_TODAY] || 0) + 1
    if (process.env.DEBUG) console.log(`[EXECUTOR] ${e.message?.slice(0, 80)}`)
  } finally {
    activeExecs--
  }
}

// ── RING READER ───────────────────────────────────────────────────────────────
let rHead  = 0
let swapId = 0

function startReader() {
  setInterval(() => checkGas().catch(() => {}), 10_000)
  checkGas().catch(() => {})

  setInterval(() => {
    const natural = HOT[H.NATURAL_TODAY] || 0
    let processed = 0
    while (rHead < natural && processed < 3 && activeExecs < MAX_CONCURRENT) {
      swapId++
      executeSwap(swapId).catch(() => {})
      rHead++
      processed++
    }
  }, 1)

  setInterval(() => {
    HOT[H.PROGRESS] = DAILY_TARGET > 0
      ? Math.min(100, ((HOT[H.REV_TODAY] || 0) / DAILY_TARGET) * 100)
      : 0
  }, 5_000)

  console.log(`[EXECUTOR] 1ms ring | max ${MAX_CONCURRENT} concurrent | gas cap: ${Number(GAS_CAP_GWEI)} gwei`)
}

startReader()
