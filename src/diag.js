// src/diag.js — SOVEREIGN diagnostic logger
// Logs system state every 5 minutes
// Clean, readable, no spam

import { H, SYSTEM, VERSION, EXECUTOR, PROPELLER } from './config.js'

export function startDiag(SAB) {
  const HOT = new Float64Array(SAB)
  let tick = 0

  setInterval(() => {
    tick++
    const upSec  = HOT[H.UPTIME] | 0
    const upMin  = Math.floor(upSec / 60)
    const upHr   = Math.floor(upMin / 60)
    const upFmt  = `${upHr}h ${upMin % 60}m ${upSec % 60}s`

    const rev    = HOT[H.REV_TODAY] || 0
    const revFmt = rev >= 1e9
      ? `$${(rev/1e9).toFixed(3)}B`
      : rev >= 1e6
      ? `$${(rev/1e6).toFixed(3)}M`
      : `$${rev.toFixed(2)}`

    const pl = 'P' + (HOT[H.PROPELLER] | 0 || 1)
    const tgt = HOT[H.DAILY_TARGET] || 0
    const tgtFmt = tgt >= 1e9
      ? `$${(tgt/1e9).toFixed(1)}B`
      : `$${(tgt/1e6).toFixed(0)}M`

    const success = HOT[H.SUCCESS_TODAY] | 0
    const fail    = HOT[H.FAIL_TODAY]    | 0
    const total   = success + fail
    const rate    = total > 0 ? Math.round(success / total * 100) : 0

    const vaultBal = HOT[H.VAULT_BALANCE] || 0
    const vaultFmt = vaultBal >= 1e6
      ? `$${(vaultBal/1e6).toFixed(2)}M`
      : `$${vaultBal.toFixed(2)}`

    console.log(`\n[DIAG #${tick}] ${SYSTEM} ${VERSION} | ${new Date().toTimeString().slice(0,8)} | up: ${upFmt}`)
    console.log('─'.repeat(60))
    console.log(`[MEM]  ${HOT[H.MB]|0}MB heap | rss: ${process.memoryUsage().rss/1024/1024|0}MB`)
    console.log(`[CTRS] ${HOT[H.DEPLOYMENT]===1 ? `${HOT[H.CONTRACTS]|0} deployed` : `Awaiting 0.1 POL → ${EXECUTOR.slice(0,20)}...`}`)
    console.log(`[CHN]  ${HOT[H.CHAIN_COUNT]|0}/20 connected`)
    console.log(`[EXEC] gas: ${HOT[H.GAS_OK]===1 ? `✓ ${(HOT[H.GAS_PRICE]||0).toFixed(1)} gwei` : `⚠ PAUSED ${(HOT[H.GAS_PRICE]||0).toFixed(1)} gwei`} | swaps: ${HOT[H.SWAPS_TODAY]|0} | success: ${success} (${rate}%) | fail: ${fail} | speed: ${(HOT[H.EXEC_SPEED_MS]||0).toFixed(1)}ms`)
    console.log(`[REV]  today: ${revFmt} | vault: ${vaultFmt} | all-time: $${((HOT[H.REV_TOTAL]||0)/1e6).toFixed(2)}M`)
    console.log(`[PROP] ${pl} | target: ${tgtFmt}/day | progress: ${(HOT[H.PROGRESS]||0).toFixed(1)}% | detected: ${HOT[H.NATURAL_TODAY]|0} qualifying swaps`)
  }, 300_000)

  console.log('[DIAG] Diagnostic logger active | 5 min interval')
}
