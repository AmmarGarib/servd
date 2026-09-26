'use client'
// Tonight's service, on the restaurant's clock.
//
// simmer serves tuesday to sunday, dinner from 7pm and late until 2:30am. The
// "service date" is the night the table belongs to, so 1am on a wednesday is
// still tuesday's service. Everything is computed in Asia/Karachi so a reader
// abroad sees the room's night, not their own.
//
// Computed per render (the stamp used to be a module constant that froze at
// server start), re-read on mount, then once a minute.

import { useEffect, useState } from 'react'

const TZ = 'Asia/Karachi'
const OPEN_MIN = 19 * 60           // 7:00pm
const LATE_END_MIN = 2 * 60 + 30   // 2:30am the next morning
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const SERVICE_DAYS = new Set([0, 2, 3, 4, 5, 6])  // closed monday

interface KarachiNow { y: number, m: number, d: number, dow: number, min: number }

function karachiNow(at: Date = new Date()): KarachiNow {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const dow = DAYS.indexOf(get('weekday').slice(0, 3).toLowerCase())
    return {
      y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
      dow: dow < 0 ? at.getDay() : dow,
      min: Number(get('hour')) * 60 + Number(get('minute')),
    }
  } catch {
    return { y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate(), dow: at.getDay(), min: at.getHours() * 60 + at.getMinutes() }
  }
}

export interface Service {
  /** `sat · 27.09.26` — the night this table belongs to. */
  stamp: string
  /** Short status line, lowercase. */
  status: string
  /** True while the kitchen is serving. */
  open: boolean
}

export function serviceNow(at: Date = new Date()): Service {
  const k = karachiNow(at)
  // Before 2:30am the table still belongs to last night's service — if there
  // was one. (Monday is dark, so tuesday's small hours are simply tuesday.)
  const yesterdayServed = SERVICE_DAYS.has((k.dow + 6) % 7)
  const lateCarry = k.min < LATE_END_MIN && yesterdayServed
  const serviceDate = new Date(Date.UTC(k.y, k.m - 1, k.d - (lateCarry ? 1 : 0)))
  const sdow = serviceDate.getUTCDay()
  const dd = String(serviceDate.getUTCDate()).padStart(2, '0')
  const mm = String(serviceDate.getUTCMonth() + 1).padStart(2, '0')
  const yy = String(serviceDate.getUTCFullYear()).slice(-2)
  const stamp = `${DAYS[sdow]} · ${dd}.${mm}.${yy}`

  let status: string
  let open = false
  if (lateCarry) {
    open = true
    status = 'late service · until 2:30'
  } else if (!SERVICE_DAYS.has(sdow)) {
    status = 'closed tonight · back tuesday'
  } else if (k.min < OPEN_MIN) {
    status = 'doors at 7pm tonight'
  } else {
    open = true
    status = k.min < 22 * 60 + 30 ? 'dinner service is on' : 'late service · until 2:30'
  }
  return { stamp, status, open }
}

export function useService(): Service {
  const [svc, setSvc] = useState<Service>(() => serviceNow())
  useEffect(() => {
    setSvc(serviceNow())
    const id = window.setInterval(() => setSvc(serviceNow()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return svc
}
