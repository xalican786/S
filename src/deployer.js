// src/deployer.js — SOVEREIGN contract deployer
// Compiles 6 contracts with viaIR:true — no stack too deep
// Deploys on Polygon when 0.1 POL arrives
// Links all companions after deployment
// staticNetwork:true — no localhost:8545

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { ethers }        from 'ethers'
import {
  EXECUTOR_PK, EXECUTOR, TREASURY,
  CONTRACT, H, PRIMARY_CHAIN,
} from './config.js'

const require        = createRequire(import.meta.url)
const CONTRACTS_PATH = '/data/sovereign_contracts.json'

function makeProvider() {
  const c = PRIMARY_CHAIN
  const n = new ethers.Network(c.name, c.id)
  return new ethers.JsonRpcProvider(c.http, n, { staticNetwork: n })
}

const provider = makeProvider()
const signer   = new ethers.Wallet(EXECUTOR_PK, provider)

const SOURCES = {
  Sovereign:           './contracts/Sovereign.sol',
  SovereignVault:      './contracts/SovereignVault.sol',
  SovereignFlash:      './contracts/SovereignFlash.sol',
  SovereignRecycler:   './contracts/SovereignVaultRecycler.sol',
  SovereignSignal:     './contracts/SovereignSignal.sol',
}

const compiled = {}
let   ready    = false

// ── COMPILE ───────────────────────────────────────────────────────────────────
function compileSingle(sourcePath, contractName) {
  if (!existsSync(sourcePath)) {
    console.log(`[DEPLOYER] Missing: ${sourcePath}`)
    return null
  }
  if (global.gc) global.gc()
  const solc   = require('solc')
  const source = readFileSync(sourcePath, 'utf8')
  const input  = JSON.stringify({
    language: 'Solidity',
    sources:  { [`${contractName}.sol`]: { content: source } },
    settings: {
      viaIR:           true,
      optimizer:       { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })
  let out
  try { out = JSON.parse(solc.compile(input)) } catch { return null }
  const fatals = (out.errors || []).filter(e => e.severity === 'error')
  if (fatals.length) {
    fatals.forEach(f => console.log(`[DEPLOYER] ${contractName}: ${f.formattedMessage?.slice(0, 150)}`))
    return null
  }
  const c = out.contracts?.[`${contractName}.sol`]?.[contractName]
  if (!c?.evm?.bytecode?.object) return null
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, name: contractName }
}

function precompile() {
  let ok = true
  for (const [name, path] of Object.entries(SOURCES)) {
    const r = compileSingle(path, name)
    if (!r && name === 'Sovereign') { ok = false; break }
    if (r) compiled[name] = r
  }
  if (ok) console.log(`[DEPLOYER] Compiled: ${Object.keys(compiled).join(', ')} | awaiting 0.1 POL at ${EXECUTOR}`)
  return ok
}

// ── PERSIST ───────────────────────────────────────────────────────────────────
function load() {
  try {
    if (!existsSync(CONTRACTS_PATH)) return {}
    const d = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'))
    return Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== 'string' || ethers.isAddress(v)))
  } catch { return {} }
}

function save(data) {
  try {
    if (!existsSync('/data')) mkdirSync('/data', { recursive: true })
    writeFileSync(CONTRACTS_PATH, JSON.stringify(data, null, 2))
  } catch {}
}

function inject(addrs) {
  if (addrs.Sovereign)         { process.env.SOVEREIGN          = addrs.Sovereign;         CONTRACT.SOVEREIGN          = addrs.Sovereign         }
  if (addrs.SovereignVault)    { process.env.SOVEREIGN_VAULT    = addrs.SovereignVault;    CONTRACT.SOVEREIGN_VAULT    = addrs.SovereignVault    }
  if (addrs.SovereignFlash)    { process.env.SOVEREIGN_FLASH    = addrs.SovereignFlash;    CONTRACT.SOVEREIGN_FLASH    = addrs.SovereignFlash    }
  if (addrs.SovereignRecycler) { process.env.SOVEREIGN_RECYCLER = addrs.SovereignRecycler; CONTRACT.SOVEREIGN_RECYCLER = addrs.SovereignRecycler }
  if (addrs.SovereignSignal)   { process.env.SOVEREIGN_SIGNAL   = addrs.SovereignSignal;   CONTRACT.SOVEREIGN_SIGNAL   = addrs.SovereignSignal   }
}

// ── DEPLOY ────────────────────────────────────────────────────────────────────
async function deployOne(name, args) {
  const c = compiled[name]
  if (!c) throw new Error(`${name} not compiled`)
  const fee      = await provider.getFeeData()
  const rawGas   = fee.gasPrice || ethers.parseUnits('30', 'gwei')
  const capGas   = ethers.parseUnits('1000', 'gwei')
  const gasPrice = (rawGas > capGas ? capGas : rawGas) * 130n / 100n
  const factory  = new ethers.ContractFactory(c.abi, c.bytecode, signer)
  const contract = await factory.deploy(...args, { gasLimit: 3_000_000, gasPrice })
  const receipt  = await contract.deploymentTransaction().wait(2)
  const address  = await contract.getAddress()
  if (!receipt?.status) throw new Error(`${name} reverted`)
  console.log(`[DEPLOYER] ${name} → ${address}`)
  return { address, contract }
}

async function deployAll(SAB, HOT) {
  const addrs = {}

  // Deploy in dependency order
  const order = [
    { name: 'SovereignVault',    args: [TREASURY]              },
    { name: 'SovereignFlash',    args: []                      },
    { name: 'SovereignRecycler', args: [TREASURY]              },
    { name: 'SovereignSignal',   args: []                      },
    { name: 'Sovereign',         args: [TREASURY]              },
  ]

  for (const { name, args } of order) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { address } = await deployOne(name, args)
        addrs[name] = address
        break
      } catch (e) {
        console.log(`[DEPLOYER] ${name} attempt ${attempt}/3: ${e.message?.slice(0, 80)}`)
        if (attempt < 3) await new Promise(r => setTimeout(r, 8_000))
        else if (name === 'Sovereign') return false
      }
    }
  }

  // Link companions
  if (addrs.Sovereign) {
    try {
      const s   = new ethers.Contract(addrs.Sovereign, compiled.Sovereign.abi, signer)
      const fee = await provider.getFeeData()
      const gp  = fee.gasPrice || ethers.parseUnits('30', 'gwei')
      await (await s.setCompanions(
        addrs.SovereignVault    || ethers.ZeroAddress,
        addrs.SovereignSignal   || ethers.ZeroAddress,
        addrs.SovereignRecycler || ethers.ZeroAddress,
        ethers.ZeroAddress,
        { gasLimit: 200_000, gasPrice: gp }
      )).wait(1)
      console.log('[DEPLOYER] Companions linked')
    } catch (e) {
      console.log(`[DEPLOYER] Link failed: ${e.message?.slice(0, 60)}`)
    }
  }

  // Set sovereign on vault
  if (addrs.SovereignVault && addrs.Sovereign) {
    try {
      const v   = new ethers.Contract(addrs.SovereignVault, compiled.SovereignVault.abi, signer)
      const fee = await provider.getFeeData()
      await (await v.setSovereign(addrs.Sovereign, {
        gasLimit: 100_000, gasPrice: fee.gasPrice || ethers.parseUnits('30', 'gwei')
      })).wait(1)
      await (await v.setRecycler(addrs.SovereignRecycler || ethers.ZeroAddress, {
        gasLimit: 100_000, gasPrice: fee.gasPrice || ethers.parseUnits('30', 'gwei')
      })).wait(1)
      console.log('[DEPLOYER] Vault configured')
    } catch {}
  }

  inject(addrs)
  save({ ...addrs, deployedAt: Date.now() })
  HOT[H.CONTRACTS]  = Object.values(addrs).filter(v => typeof v === 'string' && ethers.isAddress(v)).length
  HOT[H.DEPLOYMENT] = 1

  console.log(`[DEPLOYER] ${HOT[H.CONTRACTS]} contracts live — SOVEREIGN operational`)
  return true
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export function startDeployer(SAB) {
  const HOT = new Float64Array(SAB)

  const existing = load()
  if (existing.Sovereign && ethers.isAddress(existing.Sovereign)) {
    inject(existing)
    HOT[H.CONTRACTS]  = Object.values(existing).filter(v => typeof v === 'string' && ethers.isAddress(v)).length
    HOT[H.DEPLOYMENT] = 1
    console.log(`[DEPLOYER] Contracts restored | Sovereign: ${existing.Sovereign}`)
    return
  }

  let attempts = 0
  const tryCompile = () => {
    attempts++
    if (precompile()) { ready = true; watchPOL(SAB, HOT) }
    else if (attempts < 5) setTimeout(tryCompile, 30_000)
    else console.log('[DEPLOYER] Compilation failed after 5 attempts')
  }
  tryCompile()
}

function watchPOL(SAB, HOT) {
  let deploying = false, lastLog = -1
  const iv = setInterval(async () => {
    if (deploying || !ready) return
    try {
      const bal     = await provider.getBalance(EXECUTOR)
      const pol     = parseFloat(ethers.formatEther(bal))
      const rounded = Math.floor(pol * 100) / 100
      if (rounded !== lastLog && pol > 0 && pol < 0.1) {
        lastLog = rounded
        console.log(`[DEPLOYER] ${pol.toFixed(4)} POL | need 0.1`)
      }
      if (pol >= 0.1) {
        deploying = true
        clearInterval(iv)
        console.log(`[DEPLOYER] ${pol.toFixed(4)} POL confirmed — deploying SOVEREIGN`)
        const ok = await deployAll(SAB, HOT)
        if (!ok) {
          console.log('[DEPLOYER] Failed — retry in 60s')
          setTimeout(() => watchPOL(SAB, HOT), 60_000)
        }
      }
    } catch {}
  }, 500)
}
