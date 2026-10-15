'use client'
// Head office → Runs (read-only) and Reconciliation. Runs are prepared and
// approved in Accounting → Inter-company → Head office; nothing is posted here.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { fmtPkr } from '../../../../lib/money'
import { headOfficeApi, monthLabel, type HeadOfficeDetail } from '../../../../lib/headOfficeApi'

const STATUS_BADGE: Record<string, string> = { posted: 's-badge-green', submitted: 's-badge-purple', draft: 's-badge-muted', rejected: 's-badge-red', reversed: 's-badge-amber' }

export default function RunsTab({ detail }: { detail: HeadOfficeDetail }) {
  const runs = detail.lastRuns
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-white/60">The last {runs.length || 12} monthly recharge runs. Read-only here.</p>
        <Link href="/finance/intercompany?tab=head-office" className="text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>
          Accounting → Inter-company → Head office
        </Link>
      </div>
      <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <table className="s-table">
          <thead><tr><th>Month</th><th>Status</th><th className="text-right">Cost base</th><th className="text-right">Charged</th><th className="text-right">Retained</th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={5} className="text-white/45">No run yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="font-semibold">{monthLabel(r.period)}{r.kind !== 'regular' && <span className="s-badge-muted ml-2">{r.kind}</span>}</td>
                <td><span className={STATUS_BADGE[r.status] ?? 's-badge-muted'}>{r.status}</span>{r.stale && <span className="s-badge-amber ml-2">Out of date</span>}</td>
                <td className="text-right">{fmtPkr(r.baseCents)}</td>
                <td className="text-right">{fmtPkr(r.rechargedCents)}</td>
                <td className="text-right">{fmtPkr(r.retainedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Reconciliation: each head-office pair's two books side by side (/accounting/intercompany/balances). */
export function ReconciliationTab({ hoId }: { hoId: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['ho-balances'], queryFn: headOfficeApi.balances })
  if (isLoading) return <p className="text-sm text-white/45">Loading…</p>
  if (error) return <p className="text-sm text-red-600">Could not load the balances.</p>
  const pairs = (data?.pairs ?? []).filter((p) => p.a.id === hoId || p.b.id === hoId)
  return (
    <div>
      <p className="text-sm text-white/60 mb-3">What each side says. A difference means a hand entry or reversal landed in one book only.</p>
      <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <table className="s-table">
          <thead><tr><th>Company</th><th className="text-right">Company owes head office</th><th className="text-right">Head office says owed</th><th className="text-right">Difference</th></tr></thead>
          <tbody>
            {pairs.length === 0 && <tr><td colSpan={4} className="text-white/45">No balances yet.</td></tr>}
            {pairs.map((p) => {
              const hoIsA = p.a.id === hoId
              const other = hoIsA ? p.b : p.a
              // Company's liability to the head office, and the head office's receivable from the company.
              const companyOwes = hoIsA ? p.bDueToA : p.aDueToB
              const hoSays = hoIsA ? p.aDueFromB : p.bDueFromA
              const diff = p.mismatchCents
              return (
                <tr key={other.id}>
                  <td className="font-semibold">{other.name ?? other.id}</td>
                  <td className="text-right">{companyOwes == null ? '—' : fmtPkr(companyOwes)}</td>
                  <td className="text-right">{hoSays == null ? '—' : fmtPkr(hoSays)}</td>
                  <td className="text-right">{diff == null ? '—' : diff === 0 ? <span className="text-success font-bold">Agrees</span> : <span className="s-badge-red">{fmtPkr(diff)}</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
