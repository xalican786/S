// src/index.js — SOVEREIGN boot
// Starts all services in correct order
// SharedArrayBuffer for zero-copy inter-process communication

import { Worker }        from 'worker_threads'
import { fileURLToPath } from 'url'
import path              from 'path'
import {
  SAB_SIZE, H, SYSTEM, VERSION,
  EXECUTOR, TREASURY, PORT,
  CHAINS, PROPELLER,
  TOTAL_FLASH_CAPACITY,
} from './config.js'
import { startDeployer }  from './deployer.js'
import { startTreasury }  from './treasury.js'
import { startDashboard } from './dashboard.js'
import { startDiag }      from './diag.js'

export const SAB = new SharedArrayBuffer(SAB_SIZE)
export const HOT = new Float64Array(SAB)

// Boot defaults
HOT[H.GAS_OK]       = 1
HOT[H.PROPELLER]    = 1
HOT[H.DAILY_TARGET] = PROPELLER.P1.target

const tf = (TOTAL_FLASH_CAPACITY / 1e6).toFixed(0)

console.log('╔═══════════════════════════════════════════════════════════╗')
console.log('║              S O V E R E I G N                            ║')
console.log(`║   Version: ${VERSION}  |  Flash: $${tf}M  |  20 chains            ║`)
console.log(`║   Executor: ${EXECUTOR.slice(0,20)}...              ║`)
console.log('║   Treasury: 0xCCCF1C9A2154... (classified)               ║')
console.log('║   Strategy: JIT + ARB + SANDWICH + LIQUIDATION            ║')
console.log('║   P1: $500K/day → P10: $3B/day                           ║')
console.log('╚═══════════════════════════════════════════════════════════╝')

const __dir = path.dirname(fileURLToPath(import.meta.url))

// Start deployer — watches for 0.1 POL, deploys contracts
startDeployer(SAB)

// Start treasury — reconciles on-chain USDC balance
startTreasury(HOT)

// Start dashboard — 10 tabs, WebSocket, FTW
startDashboard(SAB)

// Start diagnostic logger
startDiag(SAB)

// Chains worker — 20 WebSocket connections, swap detection
const chainsWorker = new Worker(path.join(__dir, 'chains.js'), {
  workerData: { SAB },
  resourceLimits: { maxOldGenerationSizeMb: 150 },
})
chainsWorker.on('message', msg => {
  if (msg.type === 'swap') HOT[H.NATURAL_TODAY]++
})
chainsWorker.on('error', e => console.log(`[CHAINS] ${e.message?.slice(0, 80)}`))

// Executor worker — 1ms ring, strategy execution
const execWorker = new Worker(path.join(__dir, 'executor.js'), {
  workerData: { SAB },
  resourceLimits: { maxOldGenerationSizeMb: 100 },
})
execWorker.on('message', msg => {
  if (msg.type === 'execution') {
    HOT[H.REV_TODAY]   = (HOT[H.REV_TODAY]   || 0) + (msg.profit || 0)
    HOT[H.SWAPS_TODAY] = (HOT[H.SWAPS_TODAY]  || 0) + 1
  }
})
execWorker.on('error', e => console.log(`[EXECUTOR] ${e.message?.slice(0, 80)}`))

// Uptime + memory
setInterval(() => {
  HOT[H.UPTIME]++
  HOT[H.MB] = process.memoryUsage().heapUsed / 1024 / 1024 | 0
}, 1_000)

// Midnight reset
const scheduleMidnight = () => {
  const nx = new Date()
  nx.setUTCHours(0, 0, 0, 0)
  nx.setUTCDate(nx.getUTCDate() + 1)
  setTimeout(() => {
    ;[H.SWAPS_TODAY, H.REV_TODAY, H.NET_TODAY, H.NATURAL_TODAY,
      H.EXEC_TODAY, H.SUCCESS_TODAY, H.FAIL_TODAY, H.FEES_TODAY,
      H.FLASH_DEPLOYED, H.FLASH_RETURNED, H.AAVE_FEES, H.PROGRESS,
    ].forEach(i => { HOT[i] = 0 })
    scheduleMidnight()
  }, nx - Date.now())
}
scheduleMidnight()

process.on('uncaughtException',  e => console.log(`[SOVEREIGN] ${e.message?.slice(0, 100)}`))
process.on('unhandledRejection', r => console.log(`[SOVEREIGN] ${String(r).slice(0, 100)}`))
process.on('SIGTERM',            () => process.exit(0))

console.log(`[SOVEREIGN] Operational :${PORT} | Send 0.1 POL to ${EXECUTOR.slice(0, 20)}... to deploy`)
