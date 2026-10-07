'use client'
import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHourRow {
  dayOfWeek: number   // 0 = Sun … 6 = Sat (matches JS Date.getDay())
  openMin:   number   // minutes since midnight
  closeMin:  number
  isReservable: boolean
}

export interface HoursData {
  isActive: boolean
  hours: ServiceHourRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PKT_OFFSET_MINS = 5 * 60  // UTC+5

/** Current PKT time as { day, mins } */
function pktNow(): { day: number; mins: number } {
  const now = new Date()
  // Shift to PKT
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const pktMs = utcMs + PKT_OFFSET_MINS * 60_000
  const pkt   = new Date(pktMs)
  return { day: pkt.getDay(), mins: pkt.getHours() * 60 + pkt.getMinutes() }
}

function formatMins(m: number): string {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${mm.toString().padStart(2, '0')} ${period}`
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Given a day + current minutes, find today's windows and determine open status.
 *  Returns { open, opensAt, closesAt } where opensAt/closesAt are formatted strings. */
function computeStatus(hours: ServiceHourRow[], day: number, mins: number, words: { today: string; tomorrow: string } = DEFAULT_OPEN_STATUS_LABELS) {
  const todayWindows = hours
    .filter((h) => h.dayOfWeek === day)
    .sort((a, b) => a.openMin - b.openMin)

  if (todayWindows.length === 0) {
    // Try to find next day with hours
    for (let offset = 1; offset <= 6; offset++) {
      const nextDay = (day + offset) % 7
      const nextWindows = hours
        .filter((h) => h.dayOfWeek === nextDay)
        .sort((a, b) => a.openMin - b.openMin)
      if (nextWindows.length > 0) {
        const label = offset === 1 ? words.tomorrow : DAY_LABELS[nextDay]!
        return { open: false, closesAt: null, opensAt: `${label} ${formatMins(nextWindows[0]!.openMin)}` }
      }
    }
    return { open: false, closesAt: null, opensAt: null }
  }

  // Check if currently inside a window
  for (const w of todayWindows) {
    if (mins >= w.openMin && mins < w.closeMin) {
      return { open: true, closesAt: formatMins(w.closeMin), opensAt: null }
    }
  }

  // Find next open window today
  const nextToday = todayWindows.find((w) => w.openMin > mins)
  if (nextToday) {
    return { open: false, closesAt: null, opensAt: `${words.today} ${formatMins(nextToday.openMin)}` }
  }

  // Find next day with hours
  for (let offset = 1; offset <= 6; offset++) {
    const nextDay = (day + offset) % 7
    const nextWindows = hours
      .filter((h) => h.dayOfWeek === nextDay)
      .sort((a, b) => a.openMin - b.openMin)
    if (nextWindows.length > 0) {
      const label = offset === 1 ? words.tomorrow : DAY_LABELS[nextDay]!
      return { open: false, closesAt: null, opensAt: `${label} ${formatMins(nextWindows[0]!.openMin)}` }
    }
  }

  return { open: false, closesAt: null, opensAt: null }
}

// ── OpenStatusBadge ───────────────────────────────────────────────────────────
// Small pill badge: green "Open Now" or red "Closed · Opens [time]".
// When hoursData is null (still fetching), renders nothing to avoid flash.
// When isActive=false on the concept, shows "Temporarily Closed" regardless.

/** The badge's words — every one optional; editable as section fields. */
export interface OpenStatusLabels {
  open: string               // "Open Now"
  closes: string             // "Closes" (· Closes 11:00 PM)
  closed: string             // "Closed"
  opens: string              // "Opens"  (· Opens tomorrow 12:00 PM)
  today: string              // "today"
  tomorrow: string           // "tomorrow"
  temporarilyClosed: string  // "Temporarily Closed"
}

export const DEFAULT_OPEN_STATUS_LABELS: OpenStatusLabels = {
  open: 'Open Now',
  closes: 'Closes',
  closed: 'Closed',
  opens: 'Opens',
  today: 'today',
  tomorrow: 'tomorrow',
  temporarilyClosed: 'Temporarily Closed',
}

/** Defaults with any non-empty overrides on top. */
function withLabels(labels?: Partial<OpenStatusLabels>): OpenStatusLabels {
  const out = { ...DEFAULT_OPEN_STATUS_LABELS }
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (typeof v === 'string' && v.trim()) out[k as keyof OpenStatusLabels] = v
  }
  return out
}

interface BadgeProps {
  hoursData: HoursData | null
  accentColor?: string
  size?: 'sm' | 'md'
  /** Override any of the badge's words (empty = default). */
  labels?: Partial<OpenStatusLabels>
}

export function OpenStatusBadge({ hoursData, accentColor, size = 'md', labels }: BadgeProps) {
  const words = withLabels(labels)
  const [status, setStatus] = useState<{ open: boolean; closesAt: string | null; opensAt: string | null } | null>(null)

  useEffect(() => {
    if (!hoursData) { setStatus(null); return }

    function tick() {
      if (!hoursData) return
      if (!hoursData.isActive) {
        setStatus({ open: false, closesAt: null, opensAt: null })
        return
      }
      if (hoursData.hours.length === 0) {
        setStatus({ open: true, closesAt: null, opensAt: null }) // no hours set = assume open (fallback)
        return
      }
      const { day, mins } = pktNow()
      setStatus(computeStatus(hoursData.hours, day, mins, words))
    }
    tick()
    // Re-evaluate every 60 seconds in case the window crosses open/close time
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoursData, words.today, words.tomorrow])

  if (status === null) return null

  const fs   = size === 'sm' ? '0.62rem' : '0.72rem'
  const px   = size === 'sm' ? '0.55rem' : '0.7rem'
  const py   = size === 'sm' ? '0.25rem' : '0.35rem'

  if (!hoursData?.isActive) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
        fontSize: fs, fontWeight: 800, letterSpacing: '0.04em',
        padding: `${py} ${px}`, borderRadius: '999px',
        background: 'rgba(239,68,68,0.12)', color: '#dc2626',
        border: '1px solid rgba(239,68,68,0.25)',
      }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
        {words.temporarilyClosed}
      </span>
    )
  }

  if (status.open) {
    const green = accentColor ?? 'var(--servd-green)'
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
        fontSize: fs, fontWeight: 800, letterSpacing: '0.04em',
        padding: `${py} ${px}`, borderRadius: '999px',
        background: `${green}1a`, color: green,
        border: `1px solid ${green}44`,
      }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%', background: green, flexShrink: 0,
          boxShadow: `0 0 5px ${green}`,
          animation: 'openPulse 2s ease-in-out infinite',
        }} />
        {words.open}{status.closesAt ? ` · ${words.closes} ${status.closesAt}` : ''}
        <style>{`@keyframes openPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>
      </span>
    )
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      fontSize: fs, fontWeight: 800, letterSpacing: '0.04em',
      padding: `${py} ${px}`, borderRadius: '999px',
      background: 'rgba(239,68,68,0.1)', color: '#dc2626',
      border: '1px solid rgba(239,68,68,0.22)',
    }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
      {words.closed}{status.opensAt ? ` · ${words.opens} ${status.opensAt}` : ''}
    </span>
  )
}

// ── HoursGrid ─────────────────────────────────────────────────────────────────
// Mon–Sun grid showing today highlighted and all windows per day.
// Used below the brand name in brand page hero sections.

interface GridProps {
  hoursData: HoursData
  accentColor?: string
  /** A day with no service windows (default "Closed"). */
  closedLabel?: string
}

export function HoursGrid({ hoursData, accentColor, closedLabel }: GridProps) {
  const [todayDay, setTodayDay] = useState<number | null>(null)

  useEffect(() => {
    setTodayDay(pktNow().day)
  }, [])

  const accent = accentColor ?? 'var(--servd-green)'

  if (hoursData.hours.length === 0) return null

  // Group windows by day
  const byDay: Map<number, ServiceHourRow[]> = new Map()
  for (const h of hoursData.hours) {
    const existing = byDay.get(h.dayOfWeek) ?? []
    existing.push(h)
    byDay.set(h.dayOfWeek, existing)
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      gap: '0.35rem',
      maxWidth: '460px',
    }}>
      {DAY_LABELS.map((label, day) => {
        const windows = byDay.get(day) ?? []
        const isToday = day === todayDay
        const isClosed = windows.length === 0

        return (
          <div key={day} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem',
            padding: '0.4rem 0.2rem',
            borderRadius: '8px',
            background: isToday ? `${accent}22` : 'rgba(255,255,255,0.08)',
            border: isToday ? `1px solid ${accent}55` : '1px solid rgba(255,255,255,0.1)',
          }}>
            <span style={{
              fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: isToday ? accent : 'rgba(255,255,255,0.7)',
            }}>
              {label}
            </span>
            {isClosed ? (
              <span style={{ fontSize: '0.52rem', color: 'rgba(255,255,255,0.4)', fontWeight: 700 }}>{closedLabel?.trim() || 'Closed'}</span>
            ) : (
              windows.map((w, i) => (
                <span key={i} style={{
                  fontSize: '0.52rem', fontWeight: 700,
                  color: isToday ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.65)',
                  textAlign: 'center', lineHeight: 1.3,
                }}>
                  {formatMins(w.openMin)}–{formatMins(w.closeMin)}
                </span>
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── useHoursData ──────────────────────────────────────────────────────────────
// Hook to fetch service hours from the backend. Used by brand pages.

const API_URL = typeof window !== 'undefined'
  ? (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001')
  : (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001')

export function useHoursData(slug: string): HoursData | null {
  const [data, setData] = useState<HoursData | null>(null)

  useEffect(() => {
    fetch(`${API_URL}/api/v1/storefront/brands/${encodeURIComponent(slug)}/hours`)
      .then((r) => (r.ok ? r.json() as Promise<HoursData> : null))
      .then((d) => { if (d) setData(d) })
      .catch(() => {})
  }, [slug])

  return data
}
