'use client'
// Tier-up: a one-time celebration when the guest's loyalty tier has changed
// since they last looked (localStorage 'servd:tier-seen'). One confetti burst
// (40 transform-only particles, 1.4s), a chime if sound is on, a haptic
// triple-tap, and a "new tier" sticker. Under reduced motion only the static
// sticker shows. Storage can be blocked; then nothing plays and nothing breaks.
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { sfx } from '../../lib/film/sfx'
import { haptic } from '../../lib/haptics'
import { tierRank } from './scene'
import a from './account.module.css'

const KEY = 'servd:tier-seen'
const COLORS = ['#FFD447', '#4E2A4F', '#FF5A3C', '#FFF4D6']
const COUNT = 40
const DURATION = 1.4

/** Deterministic spread so every burst looks hand-thrown but never random-jank. */
const PARTICLES = Array.from({ length: COUNT }, (_, i) => {
  const golden = i * 2.39996 // golden angle, radians
  const reach = 0.55 + ((i * 37) % 45) / 100 // 0.55..1.0
  const dx = Math.cos(golden) * 260 * reach
  const up = 140 + ((i * 53) % 120)
  const fall = 220 + ((i * 29) % 160)
  return {
    color: COLORS[i % COLORS.length]!,
    round: i % 3 === 0,
    dx,
    up: -up * (0.6 + 0.4 * Math.abs(Math.sin(golden))),
    fall,
    spin: (i % 2 ? 1 : -1) * (240 + ((i * 41) % 360)),
    delay: (i % 8) * 0.012,
  }
})

function Confetti() {
  return (
    <div className={a.confetti} aria-hidden>
      {PARTICLES.map((pt, i) => (
        <motion.span
          key={i}
          className={pt.round ? a.bitRound : a.bit}
          style={{ background: pt.color }}
          initial={{ x: 0, y: 0, rotate: 0, scale: 0.4 }}
          animate={{
            x: [0, pt.dx * 0.8, pt.dx],
            y: [0, pt.up, pt.fall],
            rotate: [0, pt.spin * 0.6, pt.spin],
            scale: [0.4, 1.1, 0],
          }}
          transition={{ duration: DURATION - pt.delay, delay: pt.delay, ease: 'easeOut', times: [0, 0.35, 1] }}
        />
      ))}
    </div>
  )
}

export function TierUp({ tier, label }: { tier: string | null | undefined; label?: string }) {
  const reduce = useReducedMotion()
  const [celebrate, setCelebrate] = useState<string | null>(null)
  const [burst, setBurst] = useState(false)

  useEffect(() => {
    const now = (tier ?? '').trim().toLowerCase()
    if (!now) return
    let seen: string | null
    try {
      seen = window.localStorage.getItem(KEY)
    } catch {
      return
    }
    if (seen === now) return
    try { window.localStorage.setItem(KEY, now) } catch { /* private mode: celebrate once anyway */ }
    // A brand-new guest at the entry tier has nothing to celebrate yet, and a
    // step down is never a party.
    if (seen === null && tierRank(now) <= 0) return
    if (seen !== null && tierRank(seen) >= 0 && tierRank(now) <= tierRank(seen)) return

    setCelebrate(now)
    sfx('chime')
    haptic([10, 30, 10])
    if (!reduce) setBurst(true)
  }, [tier, reduce])

  // One shot: the particles unmount once they have fallen.
  useEffect(() => {
    if (!burst) return
    const t = window.setTimeout(() => setBurst(false), DURATION * 1000 + 150)
    return () => window.clearTimeout(t)
  }, [burst])

  if (!celebrate) return null
  return (
    <div className={a.tierUp} role="status">
      <span className={a.tierSticker}>
        <span className={a.tierKicker}>new tier</span>
        <span className={a.tierName}>{label ?? celebrate}</span>
      </span>
      <span className={a.tierLine}>you levelled up. the crowd noticed.</span>
      {burst && <Confetti />}
    </div>
  )
}
