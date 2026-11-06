'use client'
// Plain CSS / SVG charts for the Results dashboard — ERP tokens only, readable at 390px.

import { ProgressBar } from './shared'

export const ChartCard = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="rounded-2xl p-4 min-w-0" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
    <h3 className="text-sm font-black text-white/90">{title}</h3>
    {hint && <p className="text-xs text-white/55 mt-0.5">{hint}</p>}
    <div className="mt-3">{children}</div>
  </section>
)

export interface BarRow { label: string; value: number; display: string; tone?: string; sub?: string }

/** Horizontal bars: label above the bar so long names wrap on a phone. */
export function HBars({ rows, max, empty = 'Nothing to show yet.' }: { rows: BarRow[]; max: number; empty?: string }) {
  if (rows.length === 0) return <p className="text-sm text-white/55">{empty}</p>
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-white/80 font-bold min-w-0 break-words">{r.label}{r.sub && <span className="text-white/50 font-normal"> · {r.sub}</span>}</span>
            <span className="text-white/90 font-black shrink-0">{r.display}</span>
          </div>
          <div className="mt-1"><ProgressBar value={r.value} max={max} tone={r.tone} label={r.label} /></div>
        </li>
      ))}
    </ul>
  )
}

export interface PairRow { label: string; a: number | null; b: number | null }

/** Two bars per row (a = self, b = manager). */
export function PairedBars({ rows, max, aLabel, bLabel, fmt }: { rows: PairRow[]; max: number; aLabel: string; bLabel: string; fmt: (v: number | null) => string }) {
  if (rows.length === 0) return <p className="text-sm text-white/55">Nothing to show yet.</p>
  return (
    <div>
      <div className="flex gap-4 text-[11px] text-white/65 mb-2" aria-hidden="true">
        <span><i className="inline-block h-2 w-3 rounded-sm mr-1" style={{ background: 'var(--erp-accent)' }} />{aLabel}</span>
        <span><i className="inline-block h-2 w-3 rounded-sm mr-1" style={{ background: 'var(--erp-primary)' }} />{bLabel}</span>
      </div>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.label}>
            <p className="text-xs font-bold text-white/80 break-words">{r.label}</p>
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 mt-1">
              <ProgressBar value={r.a ?? 0} max={max} tone="var(--erp-accent)" label={`${r.label} ${aLabel}`} /><span className="text-[11px] text-white/80 font-bold w-14 text-right">{fmt(r.a)}</span>
              <ProgressBar value={r.b ?? 0} max={max} tone="var(--erp-primary)" label={`${r.label} ${bLabel}`} /><span className="text-[11px] text-white/80 font-bold w-14 text-right">{fmt(r.b)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A simple line / dot chart over cycles. Values null are skipped. */
export function LineChart({ points, max = 10000, fmt }: { points: Array<{ label: string; value: number | null }>; max?: number; fmt: (v: number) => string }) {
  const W = 320, H = 130, padX = 24, padY = 16
  const n = points.length
  if (n === 0) return <p className="text-sm text-white/55">No cycles yet.</p>
  const x = (i: number) => (n === 1 ? W / 2 : padX + (i * (W - padX * 2)) / (n - 1))
  const y = (v: number) => H - padY - (Math.max(0, Math.min(max, v)) / max) * (H - padY * 2)
  const have = points.map((p, i) => ({ ...p, i })).filter((p): p is { label: string; value: number; i: number } => p.value != null)
  const d = have.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Average final score per cycle: ${have.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}`}>
        {[0, 0.5, 1].map((t) => <line key={t} x1={padX} x2={W - padX} y1={y(max * t)} y2={y(max * t)} stroke="currentColor" strokeOpacity="0.12" className="text-white" />)}
        {have.length > 1 && <path d={d} fill="none" stroke="var(--erp-primary)" strokeWidth="2" />}
        {have.map((p) => (
          <g key={p.i}>
            <circle cx={x(p.i)} cy={y(p.value)} r="4" fill="var(--erp-primary)" />
            <text x={x(p.i)} y={y(p.value) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill="currentColor" className="text-white">{fmt(p.value)}</text>
          </g>
        ))}
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/60 mt-1">{points.map((p) => <li key={p.label}>{p.label}</li>)}</ul>
    </div>
  )
}
