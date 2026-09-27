'use client'
// "Your reel": the guest's recent orders as a strip of film tickets. Native
// horizontal scroll-snap (phones swipe it, desktops scroll or tab through),
// and a short deal-in (≤ 450ms, full opacity from the first frame).
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { formatBrandName } from '../../lib/concept'
import { statusFor } from '../../lib/orderStatus'
import { fmt } from '../../lib/ui'
import { EASE_SETTLE } from '../../lib/film/motion'
import { brandBar } from './scene'
import a from './account.module.css'

export interface ReelOrder {
  id: string
  status: string
  totalCents: number
  placedAt: string
  concept: { name: string; slug: string }
}

export function YourReel({ orders, limit = 8 }: { orders: ReelOrder[]; limit?: number }) {
  const reduce = useReducedMotion()
  const recent = [...orders]
    .sort((x, y) => Date.parse(y.placedAt) - Date.parse(x.placedAt))
    .slice(0, limit)
  if (recent.length === 0) return null

  return (
    <section className={a.reelSection} aria-labelledby="reel-title">
      <div className={a.reelHead}>
        <h2 id="reel-title" className={a.reelTitle}>your reel</h2>
        <span className={a.reelCount}>{recent.length} scene{recent.length === 1 ? '' : 's'}</span>
      </div>
      <ol className={a.reel}>
        {recent.map((o, i) => {
          const sc = statusFor(o.status)
          const name = formatBrandName(o.concept.name)
          const date = new Date(o.placedAt)
          const dateLabel = Number.isFinite(date.getTime())
            ? date.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })
            : ''
          return (
            <motion.li
              key={o.id}
              className={a.reelItem}
              initial={reduce ? false : { y: 18, rotate: i % 2 ? 2 : -2 }}
              whileInView={{ y: 0, rotate: 0 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ duration: 0.3, ease: EASE_SETTLE, delay: Math.min(i, 3) * 0.05 }}
            >
              <Link href={`/${o.concept.slug}/order/${o.id}`} className={a.ticket}>
                <span className={a.ticketBar} style={{ background: brandBar(o.concept.slug) }} aria-hidden />
                <span className={a.ticketBody}>
                  <span className={a.ticketScene}>scene {String(recent.length - i).padStart(2, '0')}</span>
                  <span className={a.ticketName}>{name}</span>
                  <span className={a.ticketMeta}>
                    {dateLabel}
                    <span aria-hidden> · </span>
                    <strong>{fmt(o.totalCents)}</strong>
                  </span>
                  <span className={a.chip} style={{ background: sc.bg, color: sc.text }}>{sc.label}</span>
                </span>
              </Link>
            </motion.li>
          )
        })}
      </ol>
    </section>
  )
}
