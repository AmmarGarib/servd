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
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, MapPin, MessageCircle } from 'lucide-react'
import type { CSSProperties } from 'react'
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

function Tiles({ text, delay }: { text: string; delay: number }) {
  const reduce = useReducedMotion()
  return (
    <span className={k.tiles} aria-hidden>
      {Array.from(text).map((ch, i) => (
        <motion.span
          key={`${ch}-${i}`}
          className={k.tile}
          initial={{ rotateX: -100, opacity: 0 }}
          whileInView={{ rotateX: 0, opacity: 1 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 16, delay: delay + i * 0.06 }}
        >
          {ch}
        </motion.span>
      ))}
    </span>
  )
}

export function KitchenBoard({ brands }: { brands: BoardBrand[] }) {
  const reduce = useReducedMotion()
  return (
    <section className={k.section} aria-labelledby="board-title">
      <div className={s.wrap}>
        <div className={k.head}>
          <div>
            <p className={`${s.eyebrow} ${k.eyebrow}`}>Right now</p>
            <h2 id="board-title" className={`${s.h2} ${k.title}`}>
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
          initial={{ opacity: 0, y: 50, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 150, damping: 17 }}
        >
          <div className={k.boardHead} aria-hidden>
            <span>kitchen</span>
            <span>where</span>
            <span>status</span>
            <span />
          </div>
          <ul className={k.rows}>
            {brands.map((b, i) => {
              const loc = locationFor(b.slug)
              return (
                <li key={b.id} className={k.row} style={{ '--signal': SIGNAL[b.slug] ?? '#FFD447' } as CSSProperties}>
                  <h3 className={k.name}>
                    <span className={s.srOnly}>{b.name}</span>
                    <Tiles text={b.name} delay={0.15 + i * 0.25} />
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
            })}
          </ul>
        </motion.div>
      </div>
    </section>
  )
}
