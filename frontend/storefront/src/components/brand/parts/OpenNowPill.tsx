'use client'
import { useHoursData } from './OpenStatusBadge'

// Compact open/closed indicator for surfaces that don't have room for
// the full OpenStatusBadge (the eyebrow tags on /reserve brand cards,
// the brand pill on home, etc.). Until the hours fetch lands, falls
// back to a static label so the visual placeholder is preserved.

interface Props {
  slug: string
  fallback: string
}

export function OpenNowPill({ slug, fallback }: Props) {
  const data = useHoursData(slug)

  // Compute open/closed against the local browser time. Returns null
  // until the hours come back so we can render the fallback (avoids a
  // CLS flash from "Dine-in" → "Closed today" after hydrate).
  const status = data ? computeOpen(data) : null

  const tone = !status
    ? { bg: 'rgba(255,255,255,0.92)', fg: 'var(--servd-black)', label: fallback }
    : status.open
      ? { bg: 'rgba(34,197,94,0.92)', fg: '#0a2415', label: `Open · closes ${status.closesAt ?? 'soon'}` }
      : { bg: 'rgba(0,0,0,0.78)',     fg: 'rgba(255,255,255,0.95)', label: status.opensAt ? `Opens ${status.opensAt}` : 'Closed today' }

  return (
    <span style={{
      background: tone.bg, color: tone.fg,
      fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em',
      textTransform: 'uppercase', padding: '0.3rem 0.65rem', borderRadius: '999px',
    }}>{tone.label}</span>
  )
}

// Lightweight open/closed check against the brand's service-hours rows.
// Returns the nearest closing time (HH:MM) when open, the nearest opening
// time when closed. Same-day windows only; midnight wraparound deliberately
// not supported here (covered by the heavier OpenStatusBadge which renders
// the full week grid).
interface HoursRow { dayOfWeek: number; openMin: number; closeMin: number }
interface HoursData { isActive: boolean; hours: HoursRow[] }
function computeOpen(d: HoursData): { open: boolean; opensAt?: string; closesAt?: string } {
  if (!d.isActive || d.hours.length === 0) return { open: false }
  const now = new Date()
  const dow = now.getDay()
  const mins = now.getHours() * 60 + now.getMinutes()
  const today = d.hours.filter((r) => r.dayOfWeek === dow)
  for (const w of today) {
    if (mins >= w.openMin && mins < w.closeMin) {
      return { open: true, closesAt: fmtMins(w.closeMin) }
    }
  }
  const upcoming = today.filter((r) => r.openMin > mins).sort((a, b) => a.openMin - b.openMin)[0]
  return { open: false, opensAt: upcoming ? fmtMins(upcoming.openMin) : undefined }
}
function fmtMins(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  const period = h >= 12 ? 'pm' : 'am'
  const h12 = ((h + 11) % 12) + 1
  return min === 0 ? `${h12}${period}` : `${h12}:${String(min).padStart(2, '0')}${period}`
}
