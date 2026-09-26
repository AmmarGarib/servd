'use client'
// Visit — the door sign swinging on its nail, the hours printed out on a till
// receipt, and where to find us. Replaces the shared OpenStatusBadge/HoursGrid
// here because their red/white-on-tint colours fail contrast on plum.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { HoursData } from '../parts/OpenStatusBadge'
import { addressLine, locationFor } from '../../../lib/brandLocations'
import { DAY_LABELS, formatMins, pktNow, type OpenStatus } from './hours'
import { OpenSign } from './OpenSign'
import { useInView } from './hooks'
import s from './visit.module.css'
import ui from './ui.module.css'

interface Props {
  slug: string
  hoursData: HoursData | null
  status: OpenStatus | null
  fallbackHours?: string
  address: string | null
  locality: string | null
  latitude: number | null
  longitude: number | null
  phone: string | null
  reservations: boolean
}

// Monday first, the way a week is read off a receipt.
const WEEK = [1, 2, 3, 4, 5, 6, 0]

function mapsUrl(address: string | null, locality: string | null, lat: number | null, lng: number | null): string | null {
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
  }
  if (address) {
    const q = [address, locality ?? 'Karachi'].filter(Boolean).join(', ')
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
  }
  return null
}

export function Visit({ slug, hoursData, status, fallbackHours, address, locality, latitude, longitude, phone, reservations }: Props) {
  const { ref, inView } = useInView<HTMLDivElement>({ once: true, rootMargin: '0px 0px -15% 0px' })
  const [today, setToday] = useState<number | null>(null)
  useEffect(() => setToday(pktNow().day), [])

  const hours = hoursData?.hours ?? []
  // The operator's pinned Google Maps link (the same one the nav's "Visit"
  // uses) wins; then coordinates; then a search for the address.
  const loc = locationFor(slug)
  const map = loc?.mapsUrl || mapsUrl(address, locality, latitude, longitude)
  const shownAddress = address || (loc ? addressLine(loc) : '') || null

  return (
    <section id="visit" className={s.section} aria-labelledby="stackd-visit">
      <div className={`${ui.wrap} ${s.grid}`}>
        <div className={s.when}>
          <p className={ui.spec}>Hours</p>
          <h2 id="stackd-visit" className={ui.h2}>When we&rsquo;re <em>on.</em></h2>

          <div className={s.pair}>
            <OpenSign status={status} fallback={hours.length === 0 ? fallbackHours : undefined} />

            <div ref={ref} className={`${s.receipt} ${inView ? s.printed : ''}`}>
              <p className={s.rHead}>stackd &amp; servd</p>
              <p className={s.rSub}>opening hours</p>
              <hr className={s.rRule} />
              {hours.length > 0 ? (
                <ul className={s.rows}>
                  {WEEK.map((d) => {
                    const w = hours.filter((h) => h.dayOfWeek === d).sort((a, b) => a.openMin - b.openMin)
                    const isToday = d === today
                    return (
                      <li key={d} className={isToday ? s.today : undefined}>
                        <span>{DAY_LABELS[d]}{isToday && <span className={ui.srOnly}> (today)</span>}</span>
                        <span className={s.dots} aria-hidden />
                        <span>{w.length === 0 ? 'closed' : w.map((x) => `${formatMins(x.openMin)}–${formatMins(x.closeMin)}`).join(', ')}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className={s.rLine}>{fallbackHours ?? 'Hours not published yet.'}</p>
              )}
              <hr className={s.rRule} />
              <p className={s.rFoot}>cooked here. wrapped, not plated.</p>
              <svg className={s.barcode} viewBox="0 0 120 22" preserveAspectRatio="none" aria-hidden focusable="false">
                {[2, 5, 7, 11, 13, 17, 20, 22, 27, 29, 31, 36, 38, 43, 45, 47, 52, 55, 57, 61, 64, 66, 71, 73, 78, 80, 82, 87, 90, 92, 97, 99, 103, 106, 108, 113, 116].map((x, i) => (
                  <rect key={x} x={x} y="0" width={i % 3 === 0 ? 2 : 1} height="22" />
                ))}
              </svg>
            </div>
          </div>
        </div>

        <div className={s.where}>
          <p className={ui.spec}>Where</p>
          <h2 className={ui.h2}>Find <em>us.</em></h2>
          <div className={s.pin} aria-hidden>
            <svg viewBox="0 0 48 60" focusable="false">
              <path d="M24 58 C 24 58, 44 36, 44 22 C 44 10, 35 2, 24 2 C 13 2, 4 10, 4 22 C 4 36, 24 58, 24 58 Z" />
              <circle cx="24" cy="22" r="8" />
            </svg>
            <span className={s.pinShadow} />
          </div>
          <address className={s.address}>{shownAddress ?? 'Karachi · address to be announced'}</address>
          {phone && (
            <p className={s.phone}>
              <a href={`tel:${phone.replace(/\s/g, '')}`}>
                <svg viewBox="0 0 24 24" aria-hidden focusable="false"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
                {phone}
              </a>
            </p>
          )}
          <div className={s.actions}>
            {map && (
              <a href={map} target="_blank" rel="noopener noreferrer" className={`${ui.btn} ${ui.ghost}`}>
                Open in maps
                <span className={ui.srOnly}> (opens in a new tab)</span>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M7 17 17 7M9 7h8v8" /></svg>
              </a>
            )}
            {reservations && (
              <Link href={`/reserve/${slug}`} className={ui.btn}>Reserve a table</Link>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
