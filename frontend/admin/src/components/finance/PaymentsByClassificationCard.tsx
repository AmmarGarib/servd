'use client'
// Finance dashboard → "Payments by classification" (owner, 2026-10-20): this
// month's payments split Official / Unofficial / Unclassified, from the
// Payments register (GET /accounting/payments — module accounting; the card
// hides itself for a login without it). Internal reporting label only.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'

interface Totals { count: number; netCents: number }
interface Resp { totals: Record<'official' | 'unofficial' | 'unclassified' | 'all', Totals>; tieOut: { ties: boolean; differenceCents: number } }

export function PaymentsByClassificationCard() {
  const from = `${todayPktIso().slice(0, 7)}-01`
  const { data, error } = useQuery<Resp>({
    queryKey: ['payments-register', 'dashboard', from],
    queryFn: () => api.get(`/accounting/payments?classification=all&from=${from}&to=${todayPktIso()}`),
    retry: false,
  })
  if (error) return null
  const t = data?.totals
  const all = t?.all.netCents ?? 0
  const rows: Array<[string, Totals | undefined, string]> = [
    ['Official', t?.official, 'var(--erp-success)'],
    ['Unofficial', t?.unofficial, 'var(--erp-primary)'],
    ['Unclassified', t?.unclassified, 'var(--muted)'],
  ]
  return (
    <Link href="/finance/payments" className="block rounded-2xl p-5 hover:opacity-95" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-success">This month</p>
      <h2 className="text-lg font-black text-white/90">Payments by classification</h2>
      <p className="mt-1 text-2xl font-black text-white/90">{fmtPkr(all)}</p>
      <div className="mt-3 space-y-2">
        {rows.map(([label, v, color]) => {
          const pct = all > 0 ? Math.round(((v?.netCents ?? 0) / all) * 100) : 0
          return (
            <div key={label}>
              <div className="flex justify-between text-xs">
                <span className="text-white/60">{label} · {v?.count ?? 0}</span>
                <span className="font-semibold text-white/85">{fmtPkr(v?.netCents ?? 0)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full" style={{ background: 'rgb(var(--fg-rgb) / 0.06)' }}>
                <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
              </div>
            </div>
          )
        })}
      </div>
      {data && (
        <p className="mt-3 text-[11px]" style={{ color: data.tieOut.ties ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
          {data.tieOut.ties ? 'Ties to the ledger' : `Differs from the ledger by ${fmtPkr(data.tieOut.differenceCents)}`}
        </p>
      )}
    </Link>
  )
}
