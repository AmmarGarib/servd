'use client'
// KitchenBoard — "Right now" as a diner departures board: each kitchen's
// name clacks in on split-flap tiles, a neon sign says whether it's open
// (pulsing dot + words, never colour alone), then the area, the posted
// hours and the two ways to reach it (order / WhatsApp).
//
// Live status comes from the same hours endpoint and the same rules as
// OpenNowPill (useHoursData + the same-day window check), rendered as a
// sign instead of a pill. Until the hours land it shows the "Today"
// fallback, exactly like the pill did.
//
// Toys: hovering, focusing or tapping a row re-flaps its name. Tapping the
// board header five times inside three seconds flaps in gate 13 (the staff
// meal, boarding never) and finds the 'gate-13' sticker. The "Right now"
// label is the keyboard path (a real button, Enter/Space).
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, MapPin, MessageCircle } from 'lucide-react'
import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { collect, sfx } from '@/lib/play'
import { useHoursData } from '../../brand/parts/OpenStatusBadge'
import { locationFor, whatsappLink } from '../../../lib/brandLocations'
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

function Tiles({ text, delay, replay }: { text: string; delay: number; replay: number }) {
  const reduce = useReducedMotion()
  // First pass waits for the board to scroll into view; every replay (and
  // the gate 13 row) flaps straight away.
  const live = replay > 0
  return (
    <span className={k.tiles} aria-hidden>
      {Array.from(text).map((ch, i) => (
        <motion.span
          key={`${ch}-${i}-${replay}`}
          className={k.tile}
          initial={reduce ? false : live ? { rotateX: -90, opacity: 0.4 } : { rotateX: -100, opacity: 0 }}
          {...(live
            ? { animate: { rotateX: 0, opacity: 1 } }
            : { whileInView: { rotateX: 0, opacity: 1 }, viewport: { once: true, amount: 0.3 } })}
          transition={
            reduce
              ? { duration: 0 }
              : { type: 'spring', stiffness: live ? 320 : 260, damping: 16, delay: live ? delay + i * 0.035 : delay + i * 0.045 }
          }
        >
          {ch === ' ' ? '\u00A0' : ch}
        </motion.span>
      ))}
    </span>
  )
}

const FLAP_THROTTLE_MS = 220

function BoardRow({ b, i }: { b: BoardBrand; i: number }) {
  const reduce = useReducedMotion()
  const [replay, setReplay] = useState(0)
  const last = useRef(0)
  const loc = locationFor(b.slug)

  const flap = useCallback(() => {
    const now = Date.now()
    if (now - last.current < FLAP_THROTTLE_MS) return
    last.current = now
    sfx('clack')
    // Reduced motion: the board stays put (no re-flap).
    if (!reduce) setReplay((r) => r + 1)
  }, [reduce])

  return (
    <li
      className={k.row}
      style={{ '--signal': SIGNAL[b.slug] ?? '#FFD447' } as CSSProperties}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') flap() }}
      onPointerDown={(e) => { if (e.pointerType !== 'mouse') flap() }}
      onFocus={flap}
    >
      <h3 className={k.name}>
        <span className={s.srOnly}>{b.name}</span>
        <Tiles text={b.name} delay={replay > 0 ? 0 : 0.1 + i * 0.15} replay={replay} />
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
    </li>
  )
}

/** The staff-meal row that only exists for people who knock five times. */
function GateThirteen() {
  const reduce = useReducedMotion()
  return (
    <motion.li
      className={`${k.row} ${k.eggRow}`}
      style={{ '--signal': '#FF5A3C' } as CSSProperties}
      initial={reduce ? { opacity: 0 } : { rotateX: -90, opacity: 0 }}
      animate={{ rotateX: 0, opacity: 1 }}
      transition={reduce ? { duration: 0.12 } : { type: 'spring', stiffness: 260, damping: 18 }}
    >
      <h3 className={k.name}>
        <span className={s.srOnly}>gate 13</span>
        <Tiles text="gate 13" delay={0.12} replay={1} />
      </h3>
      <div className={k.where}>
        <p className={k.area}>the staff meal</p>
        <p className={k.hours}>boarding: never</p>
      </div>
      <div className={k.status}>
        <span className={k.sign} data-state="soon">
          <span className={k.bulb} aria-hidden />
          soon
        </span>
      </div>
      <div className={k.links} aria-hidden />
    </motion.li>
  )
}

const EGG_TAPS = 5
const EGG_WINDOW_MS = 3000

export function KitchenBoard({ brands }: { brands: BoardBrand[] }) {
  const reduce = useReducedMotion()
  const headRef = useRef<HTMLDivElement>(null)
  const taps = useRef<number[]>([])
  const [egg, setEgg] = useState(false)

  function knock() {
    if (egg) return
    const now = Date.now()
    taps.current = [...taps.current.filter((t) => now - t < EGG_WINDOW_MS), now]
    if (taps.current.length < EGG_TAPS) return
    taps.current = []
    setEgg(true)
    sfx('clack')
    const r = headRef.current?.getBoundingClientRect()
    collect('gate-13', r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined)
  }

  return (
    <section className={k.section} aria-labelledby="board-title">
      <div className={s.wrap}>
        <div className={k.head} ref={headRef}>
          <div>
            <button type="button" className={`${s.eyebrow} ${k.eyebrow} ${k.knock}`} onClick={knock}>
              Right now
            </button>
            <h2 id="board-title" className={`${s.h2} ${k.title}`} onClick={knock}>
              Who&rsquo;s cooking, <em>live.</em>
            </h2>
          </div>
          <p className={k.live}>
            <span className={k.liveDot} aria-hidden />
            live hours from each kitchen
          </p>
        </div>

        <motion.div
          className={k.board}
          initial={reduce ? false : { opacity: 0, y: 40, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 18 }}
        >
          <div className={k.boardHead} aria-hidden onClick={knock}>
            <span>kitchen</span>
            <span>where</span>
            <span>status</span>
            <span />
          </div>
          <ul className={k.rows}>
            {brands.map((b, i) => (
              <BoardRow key={b.id} b={b} i={i} />
            ))}
            {egg && <GateThirteen />}
          </ul>
          <span className={s.srOnly} role="status">{egg ? 'gate 13 found: the staff meal, boarding never' : ''}</span>
        </motion.div>
      </div>
    </section>
  )
}
