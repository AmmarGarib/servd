'use client'
// One menu item as a kitchen order ticket: clipped to the rail, torn foot,
// swings in when its section arrives, straightens and lifts on hover.
// Everything printed on it comes from the live menu API — name, build line
// (the item's description, verbatim), options, price, availability.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { fmtPkr, itemOptions, type FlipdMenuItemLive } from './types'
import f from './flipd.module.css'
import t from './tickets.module.css'

// A small, fixed set of tilts so a row of tickets reads hand-hung, not random
// on every render (and identical on server and client).
const TILTS = [-2.2, 1.6, -1.1, 2.4, -1.8, 0.9]

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
  return (
    <div
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
            <Link href={orderHref} className={t.order} aria-label={`Order ${item.name}`}>
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
