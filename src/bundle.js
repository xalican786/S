// src/bundle.js — SOVEREIGN Flashbots bundle builder
// Submits MEV bundles to Polygon Flashbots relay
// Private mempool — prevents front-running
// Tracks landing rate

import { ethers }        from 'ethers'
import {
  EXECUTOR_PK, EXECUTOR,
  CONTRACT, FLASHBOTS_RELAY,
} from './config.js'

const signer = new ethers.Wallet(EXECUTOR_PK)

let bundlesSubmitted = 0
let bundlesLanded    = 0

export async function buildBundle(txs, targetBlock, provider) {
  const block = targetBlock || (await provider.getBlockNumber()) + 1
  return {
    jsonrpc: '2.0',
    method:  'eth_sendBundle',
    params:  [{
      txs,
      blockNumber:       '0x' + block.toString(16),
      minTimestamp:      0,
      maxTimestamp:      Math.floor(Date.now() / 1000) + 30,
      revertingTxHashes: [],
    }],
    id: Date.now(),
  }
}

export async function submitBundle(bundle) {
  bundlesSubmitted++
  try {
    const body    = JSON.stringify(bundle)
    const message = ethers.id(body)
    const sig     = await signer.signMessage(ethers.getBytes(message))
    const r = await fetch(FLASHBOTS_RELAY, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Flashbots-Signature': `${EXECUTOR}:${sig}`,
      },
      body,
      signal: AbortSignal.timeout(2_000),
    })
    const d = await r.json()
    if (d?.result?.bundleHash) {
      bundlesLanded++
      return { ok: true, bundleHash: d.result.bundleHash }
    }
    return { ok: false, error: d?.error?.message || 'no hash' }
  } catch (e) {
    return { ok: false, error: e.message?.slice(0, 60) }
  }
}

export function getBundleStats() {
  return {
    submitted:   bundlesSubmitted,
    landed:      bundlesLanded,
    landingRate: bundlesSubmitted > 0
      ? Math.round(bundlesLanded / bundlesSubmitted * 100) + '%'
      : '0%',
  }
}
