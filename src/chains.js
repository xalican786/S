// src/chains.js — SOVEREIGN chain monitor (Worker thread)
// WebSocket subscription to all 20 chains
// Detects qualifying swaps in real mempool
// Signals executor via SharedArrayBuffer

import { workerData, parentPort } from 'worker_threads'
import { WebSocket }              from 'ws'
import { CHAINS, H, CHAIN_HOT }  from './config.js'

const SAB = workerData.SAB
const HOT = new Float64Array(SAB)

// Minimum swap size to qualify as MEV opportunity — $100K USDC
const MIN_SWAP_USDC = 100_000

// Uniswap V3 Swap event topic
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

let connected = 0

function connectChain(chain) {
  if (!chain.ws) return
  const chainKey = 'C_' + chain.name.toUpperCase()
  const hotKey   = CHAIN_HOT[chain.name]

  let ws
  let pingTimer
  let reconnectTimer

  function connect() {
    try {
      ws = new WebSocket(chain.ws)

      ws.on('open', () => {
        connected++
        HOT[H.CHAIN_COUNT] = connected
        if (hotKey !== undefined) HOT[hotKey] = 1

        // Subscribe to Uniswap V3 swap events
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'eth_subscribe',
          params:  ['logs', {
            topics: [SWAP_TOPIC],
          }],
        }))

        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping()
        }, 30_000)
      })

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw)
          if (!msg?.params?.result?.topics) return

          const log    = msg.params.result
          const data   = log.data || '0x'

          // Decode swap amount from Uniswap V3 event data
          // data = amount0, amount1, sqrtPriceX96, liquidity, tick
          if (data.length < 130) return

          // amount0 is first 32 bytes (int256 — can be negative)
          const amount0Hex = data.slice(2, 66)
          const amount0    = BigInt('0x' + amount0Hex)
          // Convert to positive and estimate USD value (rough USDC approximation)
          const absAmount  = amount0 < 0n ? -amount0 : amount0
          const usdEst     = Number(absAmount) / 1e6 // assume USDC 6 decimals

          if (usdEst >= MIN_SWAP_USDC) {
            HOT[H.NATURAL_TODAY] = (HOT[H.NATURAL_TODAY] || 0) + 1

            parentPort?.postMessage({
              type:   'swap',
              chain:  chain.name,
              usd:    usdEst,
              txHash: log.transactionHash,
            })
          }
        } catch {}
      })

      ws.on('pong', () => {})

      ws.on('close', () => {
        connected = Math.max(0, connected - 1)
        HOT[H.CHAIN_COUNT] = connected
        if (hotKey !== undefined) HOT[hotKey] = 0
        clearInterval(pingTimer)
        reconnectTimer = setTimeout(connect, 5_000)
      })

      ws.on('error', () => {
        clearInterval(pingTimer)
        try { ws.terminate() } catch {}
      })

    } catch {
      reconnectTimer = setTimeout(connect, 10_000)
    }
  }

  connect()
}

// Connect all chains
for (const chain of CHAINS) {
  setTimeout(() => connectChain(chain), Math.random() * 2000)
}

console.log(`[CHAINS] Connecting ${CHAINS.length} chains | raw eth_subscribe | Alchemy`)
