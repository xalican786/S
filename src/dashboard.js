// src/dashboard.js — SOVEREIGN 10-tab dashboard
// Tabs: Overview, Executor, Amplifier, Chains, Flash, Propeller, Vault, Contracts, Bundles, FTW
// WebSocket broadcast every 500ms
// ModemPay FTW withdrawal endpoint

import { createRequire }  from 'module'
import { createServer }   from 'http'
import { existsSync }     from 'fs'
import { fileURLToPath }  from 'url'
import path               from 'path'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const _req  = createRequire(import.meta.url)
const express             = _req(path.join(__dir, '../node_modules/express'))
const { WebSocketServer } = _req(path.join(__dir, '../node_modules/ws'))

import {
  H, PORT, SYSTEM, VERSION, EXECUTOR, TREASURY,
  CONTRACT, CHAINS, PROPELLER, FLASH,
  TOTAL_FLASH_CAPACITY,
} from './config.js'
import { activatePropeller, getPropellerStats, getProgress, getVelocity } from './propeller.js'
import { layerBreakdown, updateLayer, blendedRate }  from './amplifier.js'
import { getBundleStats }                             from './bundle.js'
import { startTreasury, reconcile }                   from './treasury.js'
import { send as mpSend, calcFee, networks }          from './adapters/modempay.js'

let SAB_REF    = null
const WS_CLIENTS = new Set()
const hot      = () => SAB_REF ? new Float64Array(SAB_REF) : null

function fmt(n) {
  if (n >= 1e12) return `$${(n/1e12).toFixed(3)}T`
  if (n >= 1e9)  return `$${(n/1e9).toFixed(3)}B`
  if (n >= 1e6)  return `$${(n/1e6).toFixed(3)}M`
  return `$${n.toFixed(2)}`
}

function fullState() {
  const H2 = hot()
  if (!H2) return { type: 'state', ts: Date.now(), booting: true }
  return {
    type: 'state', ts: Date.now(),
    // Revenue
    revToday:    H2[H.REV_TODAY],
    revTotal:    H2[H.REV_TOTAL],
    netToday:    H2[H.NET_TODAY],
    revFmt:      fmt(H2[H.REV_TODAY] || 0),
    // Execution
    swapsToday:   H2[H.SWAPS_TODAY]   | 0,
    swapsTotal:   H2[H.SWAPS_TOTAL]   | 0,
    naturalToday: H2[H.NATURAL_TODAY] | 0,
    execToday:    H2[H.EXEC_TODAY]    | 0,
    successToday: H2[H.SUCCESS_TODAY] | 0,
    failToday:    H2[H.FAIL_TODAY]    | 0,
    execSpeed:    H2[H.EXEC_SPEED_MS] || 0,
    peakSwap:     H2[H.PEAK_SWAP]     || 0,
    avgSwap:      H2[H.AVG_SWAP]      || 0,
    // Flash
    flashDeployed: H2[H.FLASH_DEPLOYED] || 0,
    flashCap:      TOTAL_FLASH_CAPACITY,
    flashPerChain: FLASH,
    // Gas
    gasPrice: H2[H.GAS_PRICE] || 0,
    gasOK:    H2[H.GAS_OK] === 1,
    // Propeller
    propeller:      'P' + (H2[H.PROPELLER] | 0 || 1),
    propellerNum:   H2[H.PROPELLER] | 0,
    dailyTarget:    H2[H.DAILY_TARGET] || PROPELLER.P1.target,
    progress:       H2[H.PROGRESS]    || 0,
    velocity:       getVelocity(H2),
    propellerStats: getPropellerStats(),
    // Vault
    vaultBalance:  H2[H.VAULT_BALANCE]  || 0,
    recyclerBal:   H2[H.RECYCLER_BAL]   || 0,
    firstRev:      H2[H.FIRST_REV]      === 1,
    // System
    contracts:  H2[H.CONTRACTS]  | 0,
    deployment: H2[H.DEPLOYMENT] === 1,
    uptime:     H2[H.UPTIME]     | 0,
    mb:         H2[H.MB]         | 0,
    chainCount: H2[H.CHAIN_COUNT]| 0,
    executor:   EXECUTOR,
    treasury:   TREASURY,
    contractAddrs: CONTRACT,
    // Chains
    chainStates: Object.fromEntries(
      CHAINS.map(c => [c.name, H2[H['C_' + c.name.toUpperCase()]] === 1])
    ),
    // Amplifier
    ampLayers:   layerBreakdown(),
    blendedRate: blendedRate(),
    // Bundles
    bundleStats: getBundleStats(),
    version: VERSION,
    wsClients: WS_CLIENTS.size,
  }
}

function broadcast(data) {
  const p = JSON.stringify(data)
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) try { ws.send(p) } catch { WS_CLIENTS.delete(ws) }
  }
}

setInterval(() => { if (WS_CLIENTS.size > 0) broadcast(fullState()) }, 500)

const app = express()
const srv = createServer(app)
const wss = new WebSocketServer({ server: srv, perMessageDeflate: false })

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dir, '../dashboard')))

app.get('/', (_, res) => {
  const p = path.join(__dir, '../dashboard/sovereign.html')
  existsSync(p) ? res.sendFile(p) : res.status(404).send('sovereign.html missing')
})

app.get('/ping', (_, res) => {
  const H2 = hot()
  res.json({
    ok: true, system: SYSTEM, version: VERSION,
    uptime: H2?.[H.UPTIME] | 0, deployed: H2?.[H.DEPLOYMENT] === 1,
    chains: H2?.[H.CHAIN_COUNT] | 0,
  })
})

app.get('/api/state',  (_, res) => res.json(fullState()))
app.get('/api/layers', (_, res) => res.json({ layers: layerBreakdown(), blended: blendedRate() }))
app.get('/api/flash',  (_, res) => res.json({ perChain: FLASH, total: TOTAL_FLASH_CAPACITY }))
app.get('/api/propeller', (_, res) => res.json(getPropellerStats()))

// Set propeller level
app.post('/api/propeller', (req, res) => {
  const { level } = req.body
  const H2 = hot(); if (!H2) return res.status(503).json({ error: 'not ready' })
  const ok = activatePropeller(level, H2)
  res.json({ ok, level, target: PROPELLER[level]?.target })
})

// Tune amplifier layer
app.post('/api/amplifier/layer', (req, res) => {
  const { id, rate } = req.body
  const ok = updateLayer(parseInt(id), parseFloat(rate))
  res.json({ ok, layers: layerBreakdown() })
})

// Pause/resume executor
app.post('/api/executor/pause',  (req, res) => {
  const H2 = hot(); if (!H2) return res.status(503).json({ error: 'not ready' })
  H2[H.GAS_OK] = 0; res.json({ ok: true, status: 'paused' })
})
app.post('/api/executor/resume', (req, res) => {
  const H2 = hot(); if (!H2) return res.status(503).json({ error: 'not ready' })
  H2[H.GAS_OK] = 1; res.json({ ok: true, status: 'resumed' })
})

// Force treasury reconciliation
app.post('/api/treasury/reconcile', async (req, res) => {
  const H2 = hot(); if (!H2) return res.status(503).json({ error: 'not ready' })
  await reconcile(H2)
  res.json({ ok: true, balance: H2[H.VAULT_BALANCE] })
})

// FTW — quote
app.post('/api/ftw/quote', (req, res) => {
  const { amount, network } = req.body
  if (!amount) return res.status(400).json({ error: 'amount required' })
  res.json({ ...calcFee(parseFloat(amount), network || 'wave'), ts: Date.now() })
})

// FTW — withdraw USDC → fiat
app.post('/api/ftw/withdraw', async (req, res) => {
  const { amount, type, phone, accountNumber, accountName, swiftCode, network, address } = req.body
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' })
  const key = process.env.MODEMPAY_SECRET_KEY || ''
  if (!key) return res.status(400).json({ error: 'MODEMPAY_SECRET_KEY not configured in Railway env vars' })
  try {
    const result = await mpSend(key, {
      type, amount: parseFloat(amount),
      phone, accountNumber, accountName,
      swiftCode, network, address,
    })
    broadcast({ type: 'ftw', amount, network: result.network })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ error: e.message?.slice(0, 120) })
  }
})

// FTW — available networks
app.get('/api/ftw/networks', (_, res) => res.json(networks()))

wss.on('connection', ws => {
  WS_CLIENTS.add(ws)
  ws.send(JSON.stringify(fullState()))
  ws.on('close', () => WS_CLIENTS.delete(ws))
  ws.on('error', () => WS_CLIENTS.delete(ws))
})

export function startDashboard(SAB) {
  SAB_REF = SAB
  srv.listen(PORT, () => {
    console.log(`[DASHBOARD] SOVEREIGN :${PORT} | 10 tabs | /ping`)
  })
}
