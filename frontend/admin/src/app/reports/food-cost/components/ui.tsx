'use client'
// Small shared pieces of the food-cost report. Tokens only: purple = actions,
// green = on target / good, amber = watch / warnings, red = over / bad.
import Link from 'next/link'
import { fmtPkrWhole } from '../../../../lib/money'
import type { FoodCostStatus, Warning } from './types'

export const STATUS_BADGE: Record<FoodCostStatus, string> = {
  good: 's-badge-green',
  warning: 's-badge-amber',
  critical: 's-badge-red',
  incomplete: 's-badge-amber',
  no_data: 's-badge-muted',
}

export function StatusBadge({ status, label }: { status: FoodCostStatus; label: string }) {
  return <span className={STATUS_BADGE[status]}>{label}</span>
}

export const pkr = (c: number | null | undefined) => fmtPkrWhole(c)
export const pctText = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
export const qtyText = (q: number, unit?: string) => `${(Math.round(q * 1000) / 1000).toLocaleString('en-PK')}${unit ? ` ${unit}` : ''}`

/** Text colour for a cost figure against its target: green on/under, red over. */
export function overUnder(actual: number | null | undefined, target: number | null | undefined): string {
  if (actual == null || target == null) return 'var(--text)'
  return actual <= target ? 'var(--erp-success)' : 'var(--erp-danger)'
}

export function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="metric-card">
      <p className="metric-label">{label}</p>
      <p className="metric-value" style={color ? { color } : undefined}>{value}</p>
      {sub && <p className="text-[11px] text-s-dim">{sub}</p>}
    </div>
  )
}

/** Warnings as amber banners (timing notes in a quieter tint). */
export function Warnings({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null
  return (
    <div className="space-y-2">
      {warnings.map((w) => {
        const tone = w.severity === 'timing' ? 'var(--muted)' : 'var(--erp-warning)'
        return (
          <div key={w.code} className="rounded-xl px-4 py-3 text-sm"
            style={{ color: tone, background: `color-mix(in srgb, ${tone} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 25%, transparent)` }}>
            <p>
              {w.severity === 'incomplete' && <span className="font-semibold">Incomplete data: </span>}
              {w.message}
              {w.link && <> <Link href={w.link} className="font-semibold underline">Open</Link></>}
            </p>
            {w.names && w.names.length > 0 && <p className="mt-1 text-xs opacity-80">{w.names.join(', ')}{w.count > w.names.length ? ` and ${w.count - w.names.length} more` : ''}</p>}
          </div>
        )
      })}
    </div>
  )
}

export function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="s-card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-s-muted">{title}</p>
          {hint && <p className="mt-0.5 text-xs text-s-dim">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)' }}>{(error as Error).message}</p>
}
