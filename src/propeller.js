// src/propeller.js — SOVEREIGN propeller controller
// P1–P10 throttle on execution rate
// P1 = $500K/day target. P10 = $3B/day target.
// Level controls how many qualifying blocks SOVEREIGN executes per day

import { PROPELLER, H, setPropeller, DAILY_TARGET } from './config.js'

export function activatePropeller(level, HOT) {
  const ok = setPropeller(level)
  if (!ok) return false
  HOT[H.PROPELLER]    = parseInt(level.replace('P', ''))
  HOT[H.DAILY_TARGET] = PROPELLER[level].target
  console.log(`[PROPELLER] ${level} | target: ${PROPELLER[level].label}`)
  return true
}

export function getPropellerStats() {
  return Object.entries(PROPELLER).map(([level, data]) => ({
    level,
    target: data.target,
    label:  data.label,
    chains: data.chains,
  }))
}

export function getProgress(HOT) {
  const target = HOT[H.DAILY_TARGET] || DAILY_TARGET
  if (!target) return 0
  return Math.min(100, ((HOT[H.REV_TODAY] || 0) / target) * 100)
}

export function getVelocity(HOT) {
  const uptime = HOT[H.UPTIME] || 1
  const rev    = HOT[H.REV_TODAY] || 0
  return rev / uptime
}
