// src/treasury.js — SOVEREIGN treasury reconciliation
// Reads real on-chain USDC balance of SovereignVault
// Reconciles every 10 minutes
// Routes withdrawals via ModemPay

import { ethers } from 'ethers'
import {
  PRIMARY_CHAIN, CONTRACT, H, TREASURY,
} from './config.js'

function makeProvider() {
  const c = PRIMARY_CHAIN
  const n = new ethers.Network(c.name, c.id)
  return new ethers.JsonRpcProvider(c.http, n, { staticNetwork: n })
}

const provider = makeProvider()

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
]
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

let lastScannedBlock = 0

export async function reconcile(HOT) {
  if (!provider) return
  try {
    const usdc    = new ethers.Contract(USDC_POLYGON, USDC_ABI, provider)

    // Read vault balance if deployed, otherwise treasury balance
    const watchAddr = CONTRACT.SOVEREIGN_VAULT || TREASURY
    const rawBal    = await usdc.balanceOf(watchAddr)
    const balance   = Number(rawBal) / 1e6

    HOT[H.VAULT_BALANCE] = balance

    if (HOT[H.FIRST_REV] === 0 && balance > 0) {
      HOT[H.FIRST_REV] = 1
      console.log(`[TREASURY] First revenue confirmed — $${balance.toFixed(2)} USDC on-chain`)
    }

    // Also read recycler balance if deployed
    if (CONTRACT.SOVEREIGN_RECYCLER) {
      const recycBal = await usdc.balanceOf(CONTRACT.SOVEREIGN_RECYCLER)
      HOT[H.RECYCLER_BAL] = Number(recycBal) / 1e6
    }

    // Log every other reconciliation
    if (!reconcile._count) reconcile._count = 0
    reconcile._count++
    if (reconcile._count % 2 === 0) {
      const fmt = balance >= 1e9
        ? `$${(balance/1e9).toFixed(2)}B`
        : balance >= 1e6
        ? `$${(balance/1e6).toFixed(2)}M`
        : `$${balance.toFixed(2)}`
      console.log(`[TREASURY] ${fmt} USDC on-chain | recycler: $${(HOT[H.RECYCLER_BAL]||0).toFixed(2)}`)
    }
  } catch (e) {
    if (process.env.DEBUG) console.log(`[TREASURY] ${e.message?.slice(0, 60)}`)
  }
}

export function startTreasury(HOT) {
  reconcile(HOT)
  setInterval(() => reconcile(HOT), 600_000)
  console.log(`[TREASURY] Watching ${CONTRACT.SOVEREIGN_VAULT || TREASURY}`)
}
