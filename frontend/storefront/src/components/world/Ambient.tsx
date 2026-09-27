// Ambient life: stars, warm motes and steam.
//
// Pure render, no hooks and no 'use client' needed — safe in server and client
// trees alike. Every position and timing comes from a seeded PRNG, so the
// server and the client draw the identical sky (no hydration mismatch), and
// all motion is CSS keyframes on transform/opacity only. Negative delays start
// each loop mid-flight, so the very first frame is already alive.
//
// Stars show only under html[data-world-dark='1']; motes only when it is not.
// Under reduced motion everything holds still and faint.

import type { CSSProperties } from 'react'
import s from './world.module.css'

type Seed = number | string

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedOf(seed: Seed | undefined, salt: number): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (Math.floor(seed) ^ salt) >>> 0
  const str = String(seed ?? 'servd')
  let h = 2166136261 ^ salt
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

// Two decimals is plenty and keeps the SSR string short and stable.
const r2 = (n: number) => Math.round(n * 100) / 100
const cx = (...c: Array<string | undefined | false>) => c.filter(Boolean).join(' ')

type Vars = CSSProperties & Record<`--${string}`, string>

export interface StarsProps { count?: number; seed?: Seed; className?: string }

export function Stars({ count = 24, seed, className }: StarsProps) {
  const rnd = mulberry32(seedOf(seed, 0x51a5))
  const stars = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
    const size = r2(1.2 + rnd() * 2.4)
    const dur = r2(2.4 + rnd() * 2.6)
    const style: Vars = {
      left: `${r2(rnd() * 100)}%`,
      top: `${r2(Math.pow(rnd(), 1.35) * 92)}%`, // denser toward the top of the sky
      width: `${size}px`,
      height: `${size}px`,
      '--dur': `${dur}s`,
      '--delay': `${r2(-rnd() * dur)}s`,
      '--peak': `${r2(0.6 + rnd() * 0.4)}`,
    }
    return <span key={i} className={cx(s.star, size > 3 && s.starBig)} style={style} />
  })
  return <span aria-hidden="true" className={cx(s.layer, s.stars, className)}>{stars}</span>
}

export interface MotesProps { count?: number; seed?: Seed; className?: string; color?: string }

export function Motes({ count = 14, seed, className, color }: MotesProps) {
  const rnd = mulberry32(seedOf(seed, 0x3073))
  const motes = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
    const size = r2(3 + rnd() * 6)
    const dur = r2(9 + rnd() * 7)
    const style: Vars = {
      left: `${r2(rnd() * 100)}%`,
      top: `${r2(20 + rnd() * 75)}%`,
      width: `${size}px`,
      height: `${size}px`,
      '--dur': `${dur}s`,
      '--delay': `${r2(-rnd() * dur)}s`,
      '--dx': `${r2((rnd() - 0.5) * 60)}px`,
      '--rise': `${r2(-(80 + rnd() * 120))}px`,
    }
    return <span key={i} className={s.mote} style={style} />
  })
  const rootStyle: Vars | undefined = color ? { '--mote': color } : undefined
  return <span aria-hidden="true" className={cx(s.layer, s.motes, className)} style={rootStyle}>{motes}</span>
}

export interface SteamProps { count?: number; seed?: Seed; className?: string; color?: string }

// Three hand-drawn wisps; more are variations on them.
const WISPS = [
  'M30 96 C 18 82, 42 70, 30 56 S 18 30, 30 14',
  'M30 96 C 42 84, 20 70, 32 54 S 44 28, 28 10',
  'M30 96 C 24 86, 38 76, 28 62 S 22 38, 34 20',
]

export function Steam({ count = 3, seed, className, color }: SteamProps) {
  const rnd = mulberry32(seedOf(seed, 0x57ea))
  const n = Math.max(0, Math.floor(count))
  const wisps = Array.from({ length: n }, (_, i) => {
    const dur = r2(2.8 + rnd() * 1.2)
    const style: Vars = {
      '--dur': `${dur}s`,
      '--delay': `${r2(-(i / Math.max(1, n)) * dur - rnd() * 0.4)}s`,
    }
    const dx = n > 1 ? r2((i - (n - 1) / 2) * (22 / (n - 1))) : 0
    return { d: WISPS[i % WISPS.length] ?? WISPS[0], style, dx }
  })
  const rootStyle: Vars | undefined = color ? { '--steam': color } : undefined
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 60 100"
      preserveAspectRatio="xMidYMax meet"
      className={cx(s.steam, className)}
      style={rootStyle}
    >
      {/* The wrapper group holds the static offset as an attribute, apart from
          the path's animated CSS transform, which would otherwise replace it. */}
      {wisps.map((w, i) => (
        <g key={i} transform={w.dx ? `translate(${w.dx} 0)` : undefined}>
          <path d={w.d} className={s.wisp} style={w.style} />
        </g>
      ))}
    </svg>
  )
}
