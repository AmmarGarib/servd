'use client'
// KitchenBoard — act iii, "the board". "Right now" as a diner departures
// board: each kitchen's name sits on split-flap tiles, a neon sign says
// whether it's open (breathing dot + words, never colour alone), then the
// area, the posted hours and the two ways to reach it (order / WhatsApp).
//
// Choreography (scrubbed by scroll, snapshot-proof):
//   - p = the board's 'enter' progress.
//   - Every tile always shows a letter. Until p passes
//     0.25 + row * 0.18 + i * 0.012 it shows a deterministic scrambled
//     letter (seeded by row, index and a coarse scroll stage, so the board
//     "shuffles" as you scroll); then it flips to the real letter. The name
//     column is never blank, and the real name is always in the DOM for
//     assistive tech (sr-only).
//   - The board and its rows move by position, never by opacity.
//   - Reduced motion: resolved names, no flips, no drift.
//
// Live status comes from the same hours endpoint and the same rules as
// OpenNowPill (useHoursData + the same-day window check), rendered as a
// sign instead of a pill. Until the hours land (or with the API down) it
// shows the "Today" fallback, exactly like the pill did.
import Link from 'next/link'
import { motion, useTransform, type MotionStyle, type MotionValue } from 'framer-motion'
import { ArrowRight, MapPin, MessageCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHoursData } from '../../brand/parts/OpenStatusBadge'
import { locationFor, whatsappLink } from '../../../lib/brandLocations'
import { lerp, seg, usePrefersReducedMotion, useScene } from '../../../lib/film/motion'
import { Slate } from '../../film/Slate'
import s from './home.module.css'
import k from './board.module.css'

export interface BoardBrand {
  id: string
  name: string
  slug: string
  hours: string
}

// Brand signal colours on the ink board (decorative bars only).
const SIGNAL: Record<string, string> = { stackd: '#FCE8CE', simmer: '#E94E1B', flipd: '#3AA8FF' }

// Mirrors OpenNowPill.computeOpen — same-day windows, local browser time.
type Status = { open: boolean; label: string } | null
function useOpenStatus(slug: string): Status {
  const d = useHoursData(slug) as { isActive: boolean; hours: Array<{ dayOfWeek: number; openMin: number; closeMin: number }> } | null
  if (!d) return null
  if (!d.isActive || d.hours.length === 0) return { open: false, label: 'Closed today' }
  const now = new Date()
  const dow = now.getDay()
  const mins = now.getHours() * 60 + now.getMinutes()
  const today = d.hours.filter((r) => r.dayOfWeek === dow)
  for (const w of today) {
    if (mins >= w.openMin && mins < w.closeMin) return { open: true, label: `Open · closes ${fmt(w.closeMin)}` }
  }
  const next = today.filter((r) => r.openMin > mins).sort((a, b) => a.openMin - b.openMin)[0]
  return { open: false, label: next ? `Opens ${fmt(next.openMin)}` : 'Closed today' }
}
function fmt(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  const period = h >= 12 ? 'pm' : 'am'
  const h12 = ((h + 11) % 12) + 1
  return min === 0 ? `${h12}${period}` : `${h12}:${String(min).padStart(2, '0')}${period}`
}

function NeonSign({ slug }: { slug: string }) {
  const status = useOpenStatus(slug)
  const state = !status ? 'pending' : status.open ? 'open' : 'closed'
  return (
    <span className={k.sign} data-state={state}>
      <span className={k.bulb} aria-hidden />
      {status ? status.label : 'Today'}
    </span>
  )
}

// ── Split-flap tiles ──────────────────────────────────────────────────────
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'
/** How many scramble "stages" the enter progress is cut into. */
const STAGES = 28

/** Progress at which tile i of row `row` flips to its real letter. */
function flipAt(row: number, i: number): number {
  return 0.25 + row * 0.18 + i * 0.012
}

/** A deterministic stand-in letter, never equal to the real one, same case. */
function scrambled(real: string, row: number, i: number, stage: number): string {
  if (!/[a-z]/i.test(real)) return real
  let h = Math.imul(row + 1, 73856093) ^ Math.imul(i + 1, 19349663) ^ Math.imul(stage + 1, 83492791)
  h = (h ^ (h >>> 13)) >>> 0
  let c = ALPHA[h % 26] ?? 'x'
  if (c === real.toLowerCase()) c = ALPHA[(h + 7) % 26] ?? 'x'
  return real === real.toUpperCase() ? c.toUpperCase() : c
}

function Tiles({ text, row, p, reduce }: { text: string; row: number; p: MotionValue<number>; reduce: boolean }) {
  const chars = useMemo(() => Array.from(text), [text])
  const thresholds = useMemo(() => chars.map((_, i) => flipAt(row, i)), [chars, row])

  // Only re-render when a tile resolves or the scramble stage ticks over —
  // never per scroll frame.
  const [frame, setFrame] = useState({ resolved: 0, stage: 0 })
  useEffect(() => {
    const update = (v: number) => {
      let resolved = 0
      for (const t of thresholds) if (v >= t) resolved++
      // Once every tile has resolved the stage no longer matters: freeze it.
      const stage = resolved >= thresholds.length ? 0 : Math.floor(v * STAGES)
      setFrame((prev) => (prev.resolved === resolved && prev.stage === stage ? prev : { resolved, stage }))
    }
    update(p.get())
    return p.on('change', update)
  }, [p, thresholds])

  const resolved = reduce ? chars.length : frame.resolved
  return (
    <span className={k.tiles} aria-hidden>
      {chars.map((ch, i) => {
        const done = i < resolved
        return (
          <span
            // Re-keyed on resolve, so the flip keyframe plays exactly once.
            key={`${i}-${done ? 'r' : 's'}`}
            className={`${k.tile} ${done ? k.tileFlip : k.tileScramble}`}
          >
            {done ? ch : scrambled(ch, row, i, frame.stage)}
          </span>
        )
      })}
    </span>
  )
}

function Row({ b, row, p, reduce }: { b: BoardBrand; row: number; p: MotionValue<number>; reduce: boolean }) {
  const loc = locationFor(b.slug)
  // Rows slide up into their slot, staggered, by position only.
  const y = useTransform(p, (v) => lerp(44, 0, 1 - Math.pow(1 - seg(v, 0.05 + row * 0.12, 0.55 + row * 0.12), 3)))
  return (
    <motion.li
      className={k.row}
      style={{ y, '--signal': SIGNAL[b.slug] ?? '#FFD447' } as MotionStyle}
    >
      <h3 className={k.name}>
        <span className={s.srOnly}>{b.name}</span>
        <Tiles text={b.name} row={row} p={p} reduce={reduce} />
      </h3>
      <div className={k.where}>
        {loc && !loc.area.startsWith('TODO') && (
          <p className={k.area}><MapPin aria-hidden size={15} strokeWidth={2.4} />{loc.area}</p>
        )}
        <p className={k.hours}>{b.hours}</p>
      </div>
      <div className={k.status}><NeonSign slug={b.slug} /></div>
      {loc && (
        <div className={k.links}>
          <Link href={`/${b.slug}`} className={k.orderLink} aria-label={`Order from ${b.name}`}>
            Order <ArrowRight aria-hidden size={16} strokeWidth={2.6} />
          </Link>
          <a
            href={whatsappLink(loc, `hi ${b.name.toLowerCase()}`)}
            target="_blank"
            rel="noopener noreferrer"
            className={k.waLink}
            aria-label={`WhatsApp ${b.name} (opens in a new tab)`}
          >
            <MessageCircle aria-hidden size={16} strokeWidth={2.4} /> WhatsApp
          </a>
        </div>
      )}
    </motion.li>
  )
}

export function KitchenBoard({ brands }: { brands: BoardBrand[] }) {
  const reduce = usePrefersReducedMotion()
  const boardRef = useRef<HTMLDivElement>(null)
  const p = useScene(boardRef, 'enter')

  // The board swings down into place like a hung sign, by position only.
  const boardY = useTransform(p, (v) => lerp(56, 0, 1 - Math.pow(1 - seg(v, 0, 0.5), 3)))
  const boardRotate = useTransform(p, (v) => lerp(-1.6, 0, seg(v, 0, 0.55)))

  return (
    <section id="right-now" className={k.section} aria-labelledby="board-title">
      <div className={s.wrap}>
        <div className={k.slate}>
          <Slate act="iii" title="who's cooking, live" tone="dark" />
        </div>
        <div className={k.head}>
          <h2 id="board-title" className={`${s.h2} ${k.title}`}>
            The board, <em>right now.</em>
          </h2>
          <p className={k.live}>
            <span className={k.liveDot} aria-hidden />
            live hours from each kitchen
          </p>
        </div>

        <motion.div ref={boardRef} className={k.board} style={{ y: boardY, rotate: boardRotate }}>
          <div className={k.boardHead} aria-hidden>
            <span>kitchen</span>
            <span>where</span>
            <span>status</span>
            <span />
          </div>
          <ul className={k.rows}>
            {brands.map((b, i) => <Row key={b.id} b={b} row={i} p={p} reduce={reduce} />)}
          </ul>
        </motion.div>
      </div>
    </section>
  )
}
