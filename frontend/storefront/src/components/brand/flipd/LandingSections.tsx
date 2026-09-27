'use client'
// The Flipd landing page's lower sections, each owning its own motion:
//   OffTheGrill  — live menu highlights as order tickets on the rail
//   CourtSide    — hours + where, with the crowd on the counter watching a
//                  ball fly back and forth (tennis-spectator heads), a fries
//                  regular on a stool, and the diner neon that keeps the
//                  grill's real hours

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { emitCrowd } from '../../characters/crowdBus'
import { CrowdCameo, type CameoPose } from '../../world/cast/CrowdCameo'
import { kitchenLine } from '../../../lib/world/voice'
import { useWorld } from '../../../lib/world/useWorld'
import type { Concept } from '../../../lib/concept'
import type { HoursData } from '../parts/OpenStatusBadge'
import { DAY_LABELS, formatMins, useOpenStatus, usePktToday, windowsFor } from './hours'
import { FlipdCrowd, Words, Arrow } from './FlipdBits'
import { ItemTicket } from './ItemTicket'
import type { FlipdMenuCategoryLive, FlipdMenuItemLive } from './types'
import { useInView, useSectionMotion } from './useFlipdMotion'
import f from './flipd.module.css'
import l from './landing.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ── Off the grill ────────────────────────────────────────────────────────

/**
 * Up to six items from the live menu (the same `/storefront/:slug/menu` the
 * menu page and the till read), available ones first. If the API is down or
 * nothing is published, the tickets are simply absent and the section is
 * a heading and a link to the full menu.
 */
function useMenuHighlights(slug: string, max = 6) {
  const [items, setItems] = useState<{ item: FlipdMenuItemLive; cat: string }[] | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(slug)}/menu`)
      .then((r) => (r.ok ? (r.json() as Promise<FlipdMenuCategoryLive[] | { categories?: FlipdMenuCategoryLive[] }>) : null))
      .then((payload) => {
        if (!alive || !payload) return
        const cats = Array.isArray(payload) ? payload : payload.categories ?? []
        const all = cats.flatMap((c) => (c.items ?? []).map((item) => ({ item, cat: c.name })))
        const picked = [
          ...all.filter((x) => x.item.isAvailable !== false),
          ...all.filter((x) => x.item.isAvailable === false),
        ].slice(0, max)
        setItems(picked)
      })
      .catch(() => { /* API down — the section degrades to a link */ })
    return () => { alive = false }
  }, [slug, max])
  return items
}

export function OffTheGrill({ slug, orderHref, menuHref }: { slug: string; orderHref: string; menuHref: string }) {
  const ref = useSectionMotion<HTMLElement>()
  const items = useMenuHighlights(slug)
  const has = !!items && items.length > 0

  return (
    <section ref={ref} className={l.section} aria-labelledby="flipd-grill-title">
      <div className={l.inner}>
        <div className={l.railHead}>
          <div>
            <p className={l.eyebrow}>On the rail</p>
            <h2 id="flipd-grill-title" className={l.h2}>
              <Words text="Off the grill." />
            </h2>
          </div>
          <Link href={menuHref} className={`${f.btn} ${f.btnGhost}`}>
            Full menu
            <Arrow />
          </Link>
        </div>

        {has && (
          <div className={l.railBlock}>
            <div className={f.rail} aria-hidden />
            <div className={l.tickets}>
              {items!.map(({ item, cat }, i) => (
                <ItemTicket key={item.id} item={item} index={i} orderHref={orderHref} label={cat} />
              ))}
            </div>
            <span className={l.swipeHint} aria-hidden>
              Swipe the rail
              <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Court-side: the counter, the crowd, the ball ─────────────────────────

/** A diner stool. The stripes on the seat band slide to fake a spin. */
function Stool({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 64 92" aria-hidden>
      <defs>
        <clipPath id={id}>
          <rect x="4" y="12" width="56" height="12" rx="3" />
        </clipPath>
      </defs>
      <g className={l.seat}>
        <ellipse cx="32" cy="12" rx="28" ry="8" fill="#F9F0E1" stroke="#294375" strokeWidth="3" />
        <rect x="4" y="12" width="56" height="12" rx="3" fill="#FED561" stroke="#294375" strokeWidth="3" />
        <g clipPath={`url(#${id})`}>
          <g className={l.stoolStripes}>
            {Array.from({ length: 6 }, (_, k) => (
              <rect key={k} x={2 + k * 16} y="12" width="8" height="12" fill="#294375" />
            ))}
          </g>
        </g>
        <rect x="4" y="12" width="56" height="12" rx="3" fill="none" stroke="#294375" strokeWidth="3" />
      </g>
      <rect x="28" y="24" width="8" height="52" fill="#294375" />
      <ellipse cx="32" cy="56" rx="16" ry="4" fill="none" stroke="#294375" strokeWidth="3" />
      <ellipse cx="32" cy="84" rx="22" ry="6" fill="#294375" />
    </svg>
  )
}

/** The seat the regular sits on. */
const RIDER_STOOL = 1

/**
 * The row of counter stools. Hover or tap a stool and it swivels (a 20°
 * turn and back, stripes whirring). One of them has a regular: a fries who
 * keeps the grill's hours — watching the rally while it is on, asleep on
 * the seat when it is cold. Tap him and he wakes with a wave (or, open,
 * cheers and sets the counter off).
 */
function Stools({ cold }: { cold: boolean }) {
  const [spinning, setSpinning] = useState<Record<number, boolean>>({})
  const [poked, setPoked] = useState(false)
  const timers = useRef<number[]>([])
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)) }, [])

  const spin = (k: number) => {
    setSpinning((m) => ({ ...m, [k]: true }))
    timers.current.push(window.setTimeout(() => setSpinning((m) => ({ ...m, [k]: false })), 640))
  }
  const pokeRider = () => {
    setPoked(true)
    if (cold) emitCrowd({ type: 'react', mood: 'surprised', kind: 'fries', seconds: 1.6 })
    else emitCrowd({ type: 'cheer', kind: 'fries' })
    timers.current.push(window.setTimeout(() => setPoked(false), 2400))
  }

  const pose: CameoPose = poked ? (cold ? 'wave' : 'cheer') : cold ? 'sleep' : 'idle'

  return (
    <div className={l.stools}>
      {[0, 1, 2, 3].map((k) => (
        <span
          key={k}
          className={l.stool}
          data-spin={spinning[k] ? '1' : undefined}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') spin(k) }}
          onClick={() => {
            spin(k)
            if (k === RIDER_STOOL) pokeRider()
          }}
        >
          {k === RIDER_STOOL && (
            <span className={l.rider}>
              <CrowdCameo kind="fries" size={64} pose={pose} look={cold ? 'down' : 'right'} delay={400} />
            </span>
          )}
          <Stool id={`flipd-stool-${k}`} />
        </span>
      ))}
    </div>
  )
}

/** Line-art ball in the book's colours — a nod to the court, not a copy of it. */
function Ball() {
  return (
    <svg className={l.ball} viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r="17" fill="#F9F0E1" stroke="#294375" strokeWidth="3" />
      <path d="M6 12 C 16 18, 16 22, 6 28" fill="none" stroke="#294375" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M34 12 C 24 18, 24 22, 34 28" fill="none" stroke="#294375" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * While the stand is on screen, the crowd's eyes follow the ball — heads
 * going back and forth like a court-side crowd.
 *
 *  - Fine pointer: once the pointer has been still for a moment (moving it
 *    takes their attention back to the cursor).
 *  - Touch: there is no cursor to watch, so once the page has been still for
 *    1.2 s they look at the ball, re-aiming every 900 ms, and stop the moment
 *    the reader scrolls again.
 */
function useWatchTheBall(active: boolean, ballRef: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const look = () => {
      const r = ballRef.current?.getBoundingClientRect()
      if (!r) return
      emitCrowd({ type: 'look', x: r.left + r.width / 2, y: r.top + r.height / 2 })
    }

    if (window.matchMedia?.('(pointer: coarse)').matches) {
      let lastScroll = performance.now()
      const onScroll = () => { lastScroll = performance.now() }
      window.addEventListener('scroll', onScroll, { passive: true })
      const id = window.setInterval(() => {
        if (performance.now() - lastScroll >= 1200) look()
      }, 900)
      return () => {
        window.removeEventListener('scroll', onScroll)
        window.clearInterval(id)
      }
    }

    let lastMove = -1e9
    let raf = 0
    let lastEmit = 0
    const onMove = () => { lastMove = performance.now() }
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastMove < 1500 || now - lastEmit < 90) return
      lastEmit = now
      look()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [active, ballRef])
}

/**
 * The diner neon. One buzzing tube on a blue board, keeping the grill's real
 * hours (the same kitchen state as the home board and the buddy):
 *   open     — lit mustard, with a rare flicker
 *   closing  — amber LAST CALL, buzzing
 *   opening  — the tube warming up, stuttering on
 *   closed   — the tube is dark; the line under it says when it fires up
 * The line is the kitchen's own voice (kitchenLine). Never blank: until the
 * brand's hours load it reads the world's fallback for Flipd.
 */
function OpenSign({ hoursData }: { hoursData: HoursData | null }) {
  const status = useOpenStatus(hoursData)
  const world = useWorld()
  const phase = status.inactive ? 'closed' : status.phase
  const tube = phase === 'closing' ? 'Last call' : phase === 'closed' ? 'Closed' : 'Open'
  const head = status.inactive
    ? 'Temporarily closed'
    : phase === 'closing' ? 'Last call' : phase === 'open' ? 'Open now' : phase === 'opening' ? 'Opening soon' : 'Closed'
  const line = status.inactive ? 'Temporarily closed.' : kitchenLine(status.kitchen, world.dayPart)
  return (
    <div className={l.signHang}>
      <p className={l.neon} data-phase={phase}>
        <span className={f.srOnly}>{head}. </span>
        <span className={l.tube} aria-hidden>{tube}</span>
        <span className={l.neonLine} suppressHydrationWarning>{line}</span>
      </p>
    </div>
  )
}

/** The week, as a diner menu board. Today is lit. */
function HoursBoard({ hoursData }: { hoursData: HoursData }) {
  const today = usePktToday()
  // Monday first, the way a counter board reads.
  const order = [1, 2, 3, 4, 5, 6, 0]
  return (
    <ul className={l.hours}>
      {order.map((d) => {
        const w = windowsFor(hoursData.hours, d)
        const isToday = d === today
        return (
          <li key={d} className={`${l.hourRow} ${isToday ? l.hourToday : ''}`}>
            <span className={l.hourDay}>
              {DAY_LABELS[d]}
              {isToday && <span className={f.srOnly}> (today)</span>}
            </span>
            <span className={l.hourTime}>
              {w.length === 0 ? 'Closed' : w.map((x) => `${formatMins(x.openMin)} – ${formatMins(x.closeMin)}`).join(', ')}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function CourtSide({
  concept,
  hoursData,
  mapsUrl,
  reservations,
}: {
  concept: Concept
  hoursData: HoursData | null
  mapsUrl: string | null
  reservations: boolean
}) {
  const sectionRef = useSectionMotion<HTMLElement>()
  const standMotion = useSectionMotion<HTMLDivElement>(0)
  const [standRef, standInView] = useInView<HTMLDivElement>()
  const ballRef = useRef<HTMLSpanElement>(null)
  useWatchTheBall(standInView, ballRef)
  const grill = useOpenStatus(hoursData)
  const cold = !grill.open

  // One element carries both hooks' refs.
  const setStand = (el: HTMLDivElement | null) => {
    standMotion.current = el
    standRef.current = el
  }

  return (
    <section ref={sectionRef} className={l.section} aria-labelledby="flipd-visit-title" id="visit">
      <div className={l.inner}>
        <div className={l.visitHead}>
          <p className={l.eyebrow}>Court-side</p>
          <h2 id="flipd-visit-title" className={l.h2}>
            <Words text="Pull up a stool." />
          </h2>
          <p className={l.body}>
            Whether you just came off the court or came only for the food. Same burger, every time.
          </p>
        </div>

        <div ref={setStand} className={l.stand} aria-hidden data-grill={cold ? 'cold' : 'hot'}>
          <div className={l.rally}>
            <div className={l.ballX}>
              <span ref={ballRef} className={l.ballY}>
                <Ball />
              </span>
            </div>
          </div>
          <FlipdCrowd className={l.standCrowd} excitement={0.35} />
          <Stools cold={cold} />
        </div>

        <div className={l.visitGrid}>
          <div className={f.ticketWrap} style={{ '--r': '-1.2deg', '--i': 0 } as CSSProperties}>
            <span className={f.clip} aria-hidden />
            <div className={`${f.ticket} ${l.visitTicket}`}>
              <div className={f.ticketHead}><span>Hours</span><span>PKT</span></div>
              <hr className={f.perf} />
              <h3 className={l.visitTitle}>When we&rsquo;re on.</h3>
              <OpenSign hoursData={hoursData} />
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursBoard hoursData={hoursData} />
              ) : (
                <p className={l.muted}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div className={f.ticketWrap} style={{ '--r': '1.4deg', '--i': 1 } as CSSProperties}>
            <span className={f.clip} aria-hidden />
            <div className={`${f.ticket} ${l.visitTicket}`}>
              <div className={f.ticketHead}><span>Where</span><span>Karachi</span></div>
              <hr className={f.perf} />
              <h3 className={l.visitTitle}>Find us.</h3>
              <p className={l.address}>{concept.address ?? 'Karachi · address TBA'}</p>
              <div className={l.visitLinks}>
                {concept.phone && (
                  <a href={`tel:${concept.phone.replace(/\s/g, '')}`} className={f.textLink}>
                    <svg aria-hidden viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
                    {concept.phone}
                  </a>
                )}
                {mapsUrl && (
                  <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={f.textLink}>
                    <svg aria-hidden viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
                    Get directions
                    <span className={f.srOnly}> (opens in a new tab)</span>
                  </a>
                )}
              </div>
              <svg className={l.route} viewBox="0 0 320 120" aria-hidden>
                <path className={`${l.routePath} ${l.routeDraw}`} d="M8 104 C 60 104, 70 60, 120 64 S 190 104, 230 70 S 270 30, 282 34" />
                <g className={l.pin}>
                  <path d="M282 44 c -14 -16 -16 -22 -16 -28 a16 16 0 0 1 32 0 c 0 6 -2 12 -16 28 z" fill="#294375" />
                  <circle cx="282" cy="16" r="6" fill="#FED561" />
                </g>
                <circle cx="8" cy="104" r="6" fill="#F9F0E1" stroke="#294375" strokeWidth="3" />
              </svg>
              {reservations && (
                <div className={l.visitCta}>
                  <Link href={`/reserve/${concept.slug}`} className={`${f.btn} ${f.btnGhost}`}>Book a table</Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
