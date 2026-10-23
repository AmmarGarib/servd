'use client'
// Month calendar: 7 columns from sm up, a plain list on phones (no horizontal scroll).
import { type CalendarDay, ymd } from './types'

export function dayChip(d: CalendarDay): { cls: string; label: string } {
  if (d.inClosedPeriod && d.status === 'closed') return { cls: 's-badge-green', label: 'Closed' }
  if (d.status === 'closed') return { cls: 's-badge-green', label: 'Closed' }
  if (d.status === 'audited') {
    const n = d.lastCheck?.phase === 'settlement' ? d.lastCheck.blocks.length : 0
    return { cls: 's-badge-purple', label: n > 0 ? `Awaiting settlement · ${n}` : 'Awaiting settlement' }
  }
  if (d.future) return { cls: 's-badge-muted', label: '' }
  if (d.isToday) return { cls: 's-badge-muted', label: 'Trading' }
  if (!d.active) return { cls: 's-badge-muted', label: 'No trading' }
  if (d.beforeStart) return { cls: 's-badge-muted', label: 'Before start' }
  return { cls: 's-badge-red', label: 'Not run' }
}

function Markers({ d }: { d: CalendarDay }) {
  return (
    <span className="flex flex-wrap gap-x-2 text-xs text-s-muted">
      {d.overridden && <span>Override</span>}
      {d.reopenCount > 0 && <span>Reopened ×{d.reopenCount}</span>}
      {d.inClosedPeriod && <span>Period closed</span>}
    </span>
  )
}

export function MonthCalendar({ month, days, selected, onSelect }: {
  month: string
  days: CalendarDay[]
  selected: string | null
  onSelect: (day: string) => void
}) {
  const [y, m] = ymd(month)
  // Monday-first offset.
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const cell = (d: CalendarDay) => {
    const chip = dayChip(d)
    const dim = d.future || d.beforeStart || (!d.active && d.status === 'open')
    const sel = selected === d.day
    return (
      <button
        key={d.day}
        type="button"
        onClick={() => onSelect(d.day)}
        aria-pressed={sel}
        className={`text-left rounded-lg border p-2 w-full min-h-[76px] flex flex-col gap-1 transition-colors ${sel ? 'border-primary' : 'border-s-border hover:border-primary/50'} ${dim ? 'opacity-60' : ''}`}
        style={sel ? { background: 'rgb(var(--erp-primary-rgb) / 0.06)' } : undefined}
      >
        <span className="flex items-center justify-between gap-1">
          <span className={`text-sm font-semibold ${d.isToday ? 'text-primary-ink' : 'text-s-text'}`}>{Number(d.day.slice(8))}</span>
        </span>
        {chip.label && <span className={`${chip.cls} text-xs leading-tight self-start`}>{chip.label}</span>}
        <Markers d={d} />
      </button>
    )
  }

  return (
    <>
      <div className="hidden sm:grid grid-cols-7 gap-2" role="grid" aria-label={`Business days of ${month}`}>
        {heads.map((h) => <div key={h} className="text-xs text-s-muted text-center">{h}</div>)}
        {Array.from({ length: lead }).map((_, i) => <div key={`pad${i}`} />)}
        {days.map(cell)}
      </div>
      <ul className="sm:hidden space-y-2">
        {days.map((d) => {
          const chip = dayChip(d)
          const sel = selected === d.day
          return (
            <li key={d.day}>
              <button
                type="button"
                onClick={() => onSelect(d.day)}
                aria-pressed={sel}
                className={`w-full text-left rounded-lg border px-3 py-2 flex items-center justify-between gap-2 ${sel ? 'border-primary' : 'border-s-border'} ${d.future || d.beforeStart ? 'opacity-60' : ''}`}
                style={sel ? { background: 'rgb(var(--erp-primary-rgb) / 0.06)' } : undefined}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-s-text">
                    {new Date(Date.UTC(y, m - 1, Number(d.day.slice(8)))).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}
                  </span>
                  <Markers d={d} />
                </span>
                {chip.label && <span className={`${chip.cls} text-xs whitespace-nowrap`}>{chip.label}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
