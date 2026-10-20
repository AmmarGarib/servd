'use client'
// Tax invoices — the register of every tax invoice and credit note issued
// (finance audit 2026-10-17 item 23). Read-only: invoices are issued from the
// order (POST /invoices/orders/:id/issue | credit-note). The API
// (GET /invoices, GET /invoices/register.csv) scopes the list to the
// companies in view; finance reads it with its 'accounting' module. Numbers
// run per company, prefix, Karachi year and type, so the same number can
// appear once in each company.
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { orderRef } from '../../../lib/orderRef'
import { ExportMenu } from '@/components/ui/ExportMenu'

interface TaxInvoiceRow {
  id: string
  tenantId: string
  invoiceNumber: string
  type: 'invoice' | 'credit_note'
  orderId: string
  issuedAt: string
  sellerLegalName: string
  buyerName: string | null
  buyerStrn: string | null
  buyerNtn: string | null
  taxableValueCents: number
  fbrTaxCents: number
  provincialTaxCents: number
  totalCents: number
  originalInvoiceId: string | null
}

const firstOfMonth = () => `${todayPktIso().slice(0, 7)}-01`
/** A Karachi day as the instant it starts / ends. */
const dayStart = (d: string) => `${d}T00:00:00+05:00`
const dayEnd = (d: string) => `${d}T23:59:59.999+05:00`
const pktDay = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10)

export default function TaxInvoicesPage() {
  const [from, setFrom] = useState(firstOfMonth())
  const [to, setTo] = useState(todayPktIso())
  const [type, setType] = useState<'' | 'invoice' | 'credit_note'>('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')

  const params = new URLSearchParams()
  if (from) params.set('from', dayStart(from))
  if (to) params.set('to', dayEnd(to))
  if (type) params.set('type', type)
  if (q.trim()) params.set('q', q.trim())
  const qs = params.toString()

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['tax-invoices', qs],
    queryFn: () => api.get<TaxInvoiceRow[]>(`/invoices?${qs}`),
  })
  const byId = new Map(data.map((r) => [r.id, r.invoiceNumber]))
  // A credit note is stored with NEGATIVE amounts (invoices/service.ts
  // issueCreditNote), so a plain sum already deducts it — never flip its sign.
  const totals = data.reduce((t, r) => ({
    taxable: t.taxable + r.taxableValueCents, fbr: t.fbr + r.fbrTaxCents, prov: t.prov + r.provincialTaxCents, total: t.total + r.totalCents,
  }), { taxable: 0, fbr: 0, prov: 0, total: 0 })


  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <p className="text-[11px] font-bold uppercase tracking-wider text-success">Sales tax</p>
          <h1 className="text-xl font-bold text-s-text">Tax invoices</h1>
        </div>
        <ExportMenu path={`/invoices/register.csv?${qs}`} filename={`tax-invoices-${from}-${to}`} onError={(m) => setErr(m)} />
      </header>

      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto space-y-4">
        <p className="text-xs text-s-muted">
          Every tax invoice and credit note issued, newest first (up to 200 on screen; the CSV holds the whole period).
          Credit notes count against the totals. Tie these to the <Link href="/accounting/sales-tax-return" className="underline">sales tax return</Link>.
        </p>
        <div className="s-card p-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">From</span>
            <input type="date" className="s-input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">To</span>
            <input type="date" className="s-input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">Type</span>
            <Select className="s-input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="">Invoices and credit notes</option>
              <option value="invoice">Invoices</option>
              <option value="credit_note">Credit notes</option>
            </Select>
          </label>
          <label className="block flex-1 min-w-[180px]">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">Number or buyer</span>
            <input className="s-input w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. STX-2026-00012" />
          </label>
        </div>
        {err && <p role="alert" className="text-xs text-s-red">{err}</p>}
        {isLoading && <p className="text-s-muted text-sm" role="status">Loading…</p>}
        {error && <p className="text-s-red text-sm" role="alert">{(error as Error).message}</p>}

        {!isLoading && !error && (
          <div className="s-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted bg-s-bg-soft">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Number</th>
                    <th className="px-4 py-2 text-left font-medium">Issued</th>
                    <th className="px-4 py-2 text-left font-medium">Seller</th>
                    <th className="px-4 py-2 text-left font-medium">Buyer</th>
                    <th className="px-4 py-2 text-left font-medium">Order</th>
                    <th className="px-4 py-2 text-right font-medium">Taxable value</th>
                    <th className="px-4 py-2 text-right font-medium">FBR tax</th>
                    <th className="px-4 py-2 text-right font-medium">Provincial tax</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.id} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 font-mono text-xs text-s-text whitespace-nowrap">
                        {r.invoiceNumber}
                        {r.type === 'credit_note' && (
                          <div className="font-sans"><span className="s-badge-purple text-[10px]">Credit note</span>{r.originalInvoiceId && <span className="text-s-muted"> for {byId.get(r.originalInvoiceId) ?? 'an earlier invoice'}</span>}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{pktDay(r.issuedAt)}</td>
                      <td className="px-4 py-2 text-xs text-s-text">{r.sellerLegalName}</td>
                      <td className="px-4 py-2 text-xs text-s-text">
                        {r.buyerName ?? <span className="text-s-muted">—</span>}
                        {(r.buyerStrn || r.buyerNtn) && <div className="text-s-muted">{[r.buyerStrn && `STRN ${r.buyerStrn}`, r.buyerNtn && `NTN ${r.buyerNtn}`].filter(Boolean).join(' · ')}</div>}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-s-muted">{orderRef(r.orderId)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.taxableValueCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.fbrTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.provincialTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalCents)}</td>
                    </tr>
                  ))}
                  {data.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-xs text-s-muted">No tax invoices or credit notes in this period.</td></tr>
                  )}
                </tbody>
                {data.length > 0 && (
                  <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                    <tr>
                      <td className="px-4 py-2 text-s-text" colSpan={5}>Net (credit notes deducted){data.length >= 200 ? ' — first 200 only; download the CSV for all' : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(totals.taxable)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(totals.fbr)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(totals.prov)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(totals.total)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
