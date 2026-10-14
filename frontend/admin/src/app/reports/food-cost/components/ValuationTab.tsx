'use client'
// Valuation: the lots by class against 1210 / 1220 / 1230, with the
// reconciling items, and Goods received not invoiced (2015) against the open
// receipts. The CEO's one-time FIFO alignment (dry run first) lives here.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { ErrorNote, Section, pkr } from './ui'
import type { ValuationResponse } from './types'

interface AlignResult { tenantId: string; dryRun: boolean; posted: boolean; byClass: Record<string, number> }
const CLASS_LABEL: Record<string, string> = { food: 'Food', beverage: 'Drinks', packaging: 'Packaging' }

export function ValuationTab({ tenantId, isCeo }: { tenantId: string; isCeo: boolean }) {
  const qc = useQueryClient()
  const [asOf, setAsOf] = useState('')
  const [preview, setPreview] = useState<AlignResult | null>(null)
  const qs = new URLSearchParams({ tenantId, ...(asOf ? { asOf } : {}) }).toString()
  const { data: v, error, isLoading } = useQuery<ValuationResponse>({
    queryKey: ['food-cost', 'valuation', qs],
    queryFn: () => api.get(`/reports/food-cost/valuation?${qs}`),
  })
  const align = useMutation({
    mutationFn: (dryRun: boolean) => api.post<AlignResult>('/reports/food-cost/align-inventory', { tenantId, dryRun }),
    onSuccess: (r) => {
      setPreview(r)
      if (!r.dryRun) void qc.invalidateQueries({ queryKey: ['food-cost'] })
    },
  })

  if (isLoading) return <p className="py-6 text-center text-sm text-s-dim">Loading…</p>
  if (error || !v) return <ErrorNote error={error} />
  const canAlign = isCeo && !!v.cutover.at && !v.cutover.aligned

  return (
    <div className="space-y-4">
      <Section
        title="Stock against the ledger"
        hint="Lots at the price paid against the inventory accounts. Issued, not booked: stock out for open orders and drawers not yet closed. Pre-FIFO difference: what the cut-over found, until it is aligned."
        right={
          <div className="flex items-center gap-2">
            <label className="text-xs text-s-muted" htmlFor="fc-asof">As of</label>
            <input id="fc-asof" type="date" className="s-input w-auto" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            <span className={v.ties ? 's-badge-green' : 's-badge-red'}>{v.ties ? 'Ties to the ledger' : 'Does not tie'}</span>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="s-table">
            <thead>
              <tr><th>Class</th><th>Account</th><th className="text-right">Lots</th><th className="text-right">Ledger</th><th className="text-right">Issued, not booked</th><th className="text-right">Pre-FIFO difference</th><th className="text-right">Unreconciled</th></tr>
            </thead>
            <tbody>
              {v.classes.map((c) => (
                <tr key={c.costClass}>
                  <td>{c.label}</td><td className="font-mono text-s-muted">{c.glCode}</td>
                  <td className="text-right font-mono">{pkr(c.lotsCents)}</td>
                  <td className="text-right font-mono">{pkr(c.glCents)}</td>
                  <td className="text-right font-mono">{pkr(c.issuedNotBookedCents)}</td>
                  <td className="text-right font-mono">{pkr(c.preFifoDiffCents)}</td>
                  <td className="text-right font-mono font-semibold" style={{ color: c.unreconciledCents === 0 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>{pkr(c.unreconciledCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {v.failedPostings.count > 0 && (
          <p className="mt-3 rounded-xl px-4 py-2 text-sm" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
            {v.failedPostings.count} stock posting(s) the ledger refused ({pkr(v.failedPostings.cents)}) may explain a difference.{' '}
            <Link href="/exceptions?kind=posting_failed" className="font-semibold underline">Open them</Link>
          </p>
        )}
        {v.stockDifferencesSuspenseCents !== 0 && (
          <p className="mt-2 text-xs text-s-muted">Stock differences waiting for the CEO (1290): {pkr(v.stockDifferencesSuspenseCents)}.</p>
        )}
        <p className="mt-2 text-[11px] text-s-dim">Issued, not booked is read as of now.</p>
      </Section>

      <Section title="Goods received not invoiced (2015)" hint="Open receipt lines at their receipt cost, less quantities billed before they arrived, against the ledger." right={<Link href="/procurement/grni" className="text-xs text-primary-ink hover:underline">Received, not billed</Link>}>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-s-muted">Ledger (credit)</p><p className="font-mono">{pkr(v.grni.glCreditCents)}</p></div>
          <div><p className="text-xs text-s-muted">Open receipts ({v.grni.openReceiptLines})</p><p className="font-mono">{pkr(v.grni.openReceiptCents)}</p></div>
          <div><p className="text-xs text-s-muted">Billed before arrival</p><p className="font-mono">{pkr(v.grni.pendingMatchCents)}</p></div>
          <div><p className="text-xs text-s-muted">Difference</p><p className="font-mono font-semibold" style={{ color: v.grni.differenceCents === 0 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>{pkr(v.grni.differenceCents)}</p></div>
        </div>
        {v.grni.staleLines > 0 && <p className="mt-2 text-xs" style={{ color: 'var(--erp-warning)' }}>{v.grni.staleLines} line(s) over 30 days old ({pkr(v.grni.staleCents)}) — chase the bills.</p>}
      </Section>

      <Section title="FIFO cut-over" hint="The pre-FIFO difference is a prior-period difference: aligning posts it to retained earnings (3020), never to cost of sales.">
        <div className="space-y-2 text-sm">
          <p>{v.cutover.at ? `Stock moved to FIFO lots on ${v.cutover.at.slice(0, 10)}.` : 'This company is not on FIFO lots yet.'}</p>
          {v.cutover.preFifoDiff && (
            <p className="text-s-muted">Difference found at the cut-over: {Object.entries(v.cutover.preFifoDiff).map(([k, c]) => `${CLASS_LABEL[k] ?? k} ${pkr(c)}`).join(' · ')}</p>
          )}
          {v.cutover.aligned && <p><span className="s-badge-green">Aligned</span> <span className="text-xs text-s-dim">{v.cutover.alignedAt?.slice(0, 10)}</span></p>}
          {v.cutover.catchupRefused.length > 0 && (
            <p style={{ color: 'var(--erp-warning)' }}>{v.cutover.catchupRefused.length} old bill price difference(s) could not be applied before the cut-over — they are inside the difference above (see Exceptions → posting failed).</p>
          )}
          {v.cutover.untied && (v.cutover.untied.bills.length + v.cutover.untied.receiptLines.length + v.cutover.untied.billedAhead.length) > 0 && (
            <p style={{ color: 'var(--erp-warning)' }}>
              The cut-over could not tie {v.cutover.untied.bills.length} bill(s), {v.cutover.untied.receiptLines.length} receipt line(s) and {v.cutover.untied.billedAhead.length} billed-ahead order(s) — for the accountant to review.
            </p>
          )}
          {canAlign && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="s-btn-secondary" disabled={align.isPending} onClick={() => align.mutate(true)}>Preview alignment</button>
              {preview?.dryRun && (
                <button className="s-btn-primary" disabled={align.isPending}
                  onClick={() => { if (window.confirm('Post the alignment? It is done once and posts the difference to retained earnings.')) align.mutate(false) }}>
                  Post alignment
                </button>
              )}
            </div>
          )}
          {preview && (
            <p className="text-sm">
              {preview.dryRun ? 'Would post' : preview.posted ? 'Posted' : 'Nothing to post'}:{' '}
              {Object.entries(preview.byClass).map(([k, c]) => `${CLASS_LABEL[k] ?? k} ${pkr(c)}`).join(' · ')}
            </p>
          )}
          <ErrorNote error={align.error} />
        </div>
      </Section>
    </div>
  )
}
