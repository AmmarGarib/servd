'use client'

// Starter number tiles for a dashboard (owner, 2026-10-26, C4). Reads GET /dashboards/:id/numbers — every number is
// computed server-side from an existing report, inside the signed-in company view. Each tile opens its full report.
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'
import { CompactEmptyState } from './CompactEmptyState'

export type DashboardId = 'ceo' | 'operations' | 'finance' | 'marketing' | 'hr'

interface Tile {
  key: string; label: string; unit: 'pkr' | 'count' | 'pct' | 'minutes'; href: string
  value: number | null; monthToDate?: number | null
  breakdown?: Array<{ label: string; value: number | null }>
  hidden?: boolean; reason?: string
}

function show(unit: Tile['unit'], v: number | null | undefined): string {
  if (v == null) return '—'
  if (unit === 'pkr') return fmtPkrShort(v)
  if (unit === 'pct') return `${v}%`
  if (unit === 'minutes') return `${v} min`
  return v.toLocaleString('en-PK')
}

export function DashboardTiles({ id }: { id: DashboardId }) {
  const { data, isLoading, isError } = useQuery<{ numbers: Tile[] }>({
    queryKey: ['dashboard-numbers', id],
    queryFn: () => api.get(`/dashboards/${id}/numbers`),
    refetchInterval: 60_000,
  })
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl" style={{ background: 'var(--surface)' }} />)}
      </div>
    )
  }
  if (isError || !data) return <CompactEmptyState message="The numbers could not be loaded." detail="Try again in a moment." />
  if (data.numbers.length === 0) return <CompactEmptyState message="No numbers on this dashboard yet." />

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {data.numbers.map((t) => (
        <Link key={t.key} href={t.href} className="flex min-h-[7rem] flex-col rounded-xl p-4 transition-opacity hover:opacity-90"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/45">{t.label}</span>
          {t.hidden ? (
            <span className="mt-2 text-sm text-white/40">Amount not shown for your role.</span>
          ) : t.value == null && t.breakdown == null ? (
            <span className="mt-2 text-sm text-white/40">{t.reason ?? 'No figure yet.'}</span>
          ) : (
            <>
              {t.value != null && <span className="mt-1 text-2xl font-black text-white/90">{show(t.unit, t.value)}</span>}
              {t.monthToDate != null && <span className="text-xs text-white/45">Month to date {show(t.unit, t.monthToDate)}</span>}
              {t.breakdown && (
                <ul className="mt-2 space-y-0.5 text-xs text-white/60">
                  {t.breakdown.slice(0, 5).map((b) => (
                    <li key={b.label} className="flex justify-between gap-3">
                      <span className="truncate">{b.label}</span>
                      <span className="font-bold text-white/80">{show(t.unit === 'pkr' && t.key === 'bills_due' ? 'count' : t.unit, b.value)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Link>
      ))}
    </div>
  )
}
