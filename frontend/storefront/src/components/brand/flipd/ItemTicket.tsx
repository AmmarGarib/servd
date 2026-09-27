'use client'
// One menu item as a kitchen order ticket: clipped to the rail, torn foot,
// swings in when its section arrives, straightens and lifts on hover.
// Everything printed on it comes from the live menu API — name, build line
// (the item's description, verbatim), options, price, availability.
//
// Tapping Order is a conductor's punch: a notch is punched out of the
// ticket's edge (it stays punched for a beat after release), the ticket
// wiggles on its clip, and every crowd on the page cheers. Navigation is the
// plain link, unchanged.

import Link from 'next/link'
import { useEffect, useRef, type CSSProperties } from 'react'
import { brandKinds, emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { tick } from '../../../lib/tactile'
import { fmtPkr, itemOptions, type FlipdMenuItemLive } from './types'
import f from './flipd.module.css'
import t from './tickets.module.css'

// A small, fixed set of tilts so a row of tickets reads hand-hung, not random
// on every render (and identical on server and client).
const TILTS = [-2.2, 1.6, -1.1, 2.4, -1.8, 0.9]

/** How long the punched notch stays after the finger lifts. */
const PUNCH_HOLD_MS = 600

/** Flipd's cast, as the fallback should the bus ever return none. */
const FLIPD_KINDS: CharacterKind[] = ['burger', 'fries', 'shake']

/** The whole Flipd cast cheers. */
function cheerFlipd() {
  const kinds = brandKinds('flipd')
  emitCrowd({ type: 'cheer', kinds: kinds.length > 0 ? kinds : FLIPD_KINDS })
}

export function ItemTicket({
  item,
  index,
  orderHref,
  label,
}: {
  item: FlipdMenuItemLive
  index: number
  orderHref: string
  /** Right-hand head text — the category name on the menu page. */
  label?: string
}) {
  const soldOut = item.isAvailable === false
  const options = itemOptions(item)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const releaseTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(releaseTimer.current), [])

  // The punch lives on a data attribute, not React state: no re-render, and
  // the ticket's entrance animation is never restarted.
  function punch() {
    const el = wrapRef.current
    if (!el) return
    window.clearTimeout(releaseTimer.current)
    el.dataset.punch = '1'
  }
  function release() {
    window.clearTimeout(releaseTimer.current)
    releaseTimer.current = window.setTimeout(() => {
      if (wrapRef.current) delete wrapRef.current.dataset.punch
    }, PUNCH_HOLD_MS)
  }

  return (
    <div
      ref={wrapRef}
      className={`${f.ticketWrap} ${t.wrap}`}
      style={{ '--r': `${TILTS[index % TILTS.length]}deg`, '--i': index % 8 } as CSSProperties}
    >
      <span className={f.clip} aria-hidden />
      <article className={`${f.ticket} ${t.ticket}`} aria-label={soldOut ? `${item.name}, sold out` : undefined}>
        <div className={f.ticketHead}>
          <span>No. {String(index + 1).padStart(2, '0')}</span>
          {label && <span className={t.label}>{label}</span>}
        </div>
        <hr className={f.perf} />
        <h3 className={t.name}>{item.name}</h3>
        {item.description && <p className={t.build}>{item.description}</p>}
        {options.length > 0 && (
          <ul className={t.options} aria-label="Options">
            {options.map((o) => (
              <li key={o} className={t.chip}>{o}</li>
            ))}
          </ul>
        )}
        <div className={t.foot}>
          <span className={t.price}>{fmtPkr(item.priceCents)}</span>
          {!soldOut && (
            <Link
              href={orderHref}
              className={t.order}
              aria-label={`Order ${item.name}`}
              onPointerDown={punch}
              onPointerUp={release}
              onPointerCancel={release}
              onPointerLeave={release}
              onClick={() => {
                // Keyboard activation gets the same punch as a tap.
                punch()
                release()
                cheerFlipd()
                tick('light')
              }}
            >
              Order
              <svg aria-hidden viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          )}
        </div>
        {soldOut && (
          <span className={t.soldOut} aria-hidden>
            Sold out
          </span>
        )}
      </article>
    </div>
  )
}
