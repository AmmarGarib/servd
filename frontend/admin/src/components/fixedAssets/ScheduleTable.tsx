'use client'
// An asset's depreciation schedule: the months already posted, the completed
// months the nightly run still has to charge, and the forecast to the end of
// its life. Green = posted, amber = due (charged by the next nightly run),
// plain = forecast. A month posted late says which month it landed in.

import { fmtMonth, money, card } from './shared'

export interface PostedMonth {
  period: string
  amountCents: number
  status: 'posted' | 'reversed'
  postedPeriod: string | null
  revision: number
}
export interface UpcomingMonth { period: string; amountCents: number; status: 'due' | 'forecast' }

export function ScheduleTable({ posted, upcoming }: { posted: PostedMonth[]; upcoming: UpcomingMonth[] }) {
  const live = posted.filter((p) => p.status === 'posted')
  const postedTotal = live.reduce((s, p) => s + p.amountCents, 0)
  const dueTotal = upcoming.filter((u) => u.status === 'due').reduce((s, u) => s + u.amountCents, 0)
  const forecastTotal = upcoming.filter((u) => u.status === 'forecast').reduce((s, u) => s + u.amountCents, 0)

  if (posted.length === 0 && upcoming.length === 0) {
    return <p className="text-sm text-white/45">This asset has no depreciation schedule (land, or a disposed asset with nothing posted).</p>
  }

  const rows: Array<{ key: string; period: string; amount: number; kind: 'posted' | 'reversed' | 'due' | 'forecast'; note: string }> = [
    ...posted.map((p) => ({
      key: `p-${p.period}-${p.revision}`, period: p.period, amount: p.amountCents, kind: p.status as 'posted' | 'reversed',
      note: p.status === 'reversed' ? 'Reversed' : p.postedPeriod && p.postedPeriod !== p.period ? `Posted late, in ${fmtMonth(p.postedPeriod)}` : '',
    })),
    ...upcoming.map((u) => ({
      key: `u-${u.period}`, period: u.period, amount: u.amountCents, kind: u.status,
      note: u.status === 'due' ? 'The nightly run charges this' : '',
    })),
  ]

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 mb-3 text-sm">
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Posted</p><p className="font-black text-success">{money(postedTotal)}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Due now</p><p className="font-black text-white/85">{money(dueTotal)}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Still to come</p><p className="font-black text-white/60">{money(forecastTotal)}</p></div>
      </div>
      <div className="rounded-xl overflow-hidden max-h-[420px] overflow-y-auto" style={card}>
        <table className="w-full text-sm">
          <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
            <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
              <th className="px-3 py-2 font-bold">Month</th>
              <th className="px-3 py-2 font-bold text-right">Charge</th>
              <th className="px-3 py-2 font-bold">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/[0.05]" style={{ opacity: r.kind === 'reversed' ? 0.55 : 1 }}>
                <td className="px-3 py-2 text-white/80 whitespace-nowrap">{fmtMonth(r.period)}</td>
                <td className={`px-3 py-2 text-right font-mono whitespace-nowrap ${r.kind === 'reversed' ? 'line-through text-white/50' : 'text-white/85'}`}>{money(r.amount)}</td>
                <td className="px-3 py-2">
                  {r.kind === 'posted' && <span className="s-badge-green">Posted</span>}
                  {r.kind === 'reversed' && <span className="s-badge-muted">Reversed</span>}
                  {r.kind === 'due' && <span className="s-badge-amber">Due</span>}
                  {r.kind === 'forecast' && <span className="s-badge-muted">Forecast</span>}
                  {r.note && <span className="text-[11px] text-white/45 ml-2">{r.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
