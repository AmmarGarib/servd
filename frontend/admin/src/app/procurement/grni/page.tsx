'use client'
// Received, not billed — goods received not invoiced (GRNI, account 2015).
//
// A delivery is booked the day it arrives: Dr stock / Cr 2015. The supplier's
// bill later clears it. This page lists every delivery line that is still
// waiting for its bill (received − billed), what it is worth, how long it has
// been waiting (stale after 30 days), and the bills that came in BEFORE their
// goods did (pending matches — they clear when the delivery is received).
//
// A line the supplier will never bill (a free replacement, a bill lost for good)
// can be written off: finance, management or procurement ASK, with a reason;
// the CEO approves or rejects (a request the CEO raises applies at once). The
// write-off moves the value from 2015 to cost of sales and leaves the stock where
// it is. Reads: GET /procurement/grni (procurement + accounting modules).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { TenantChip, useMyTenants } from '../../../components/ui/TenantPicker'
import { stockErrorText } from '../../../lib/stockUi'
import { Select } from '@/components/ui/Select'

interface GrniLine {
  receiptLineId: string; receiptId: string; tenantId: string | null
  supplierId: string; supplierName: string | null; poId: string | null
  description: string; unit: string
  receivedQty: number; billedQty: number; openQty: number
  unitCostCents: number; openValueCents: number
  receivedAt: string; ageDays: number; stale: boolean
  writeOffRequest: { requestedAt: string; requestedById: string | null; reason: string | null } | null
}
interface PendingMatch {
  matchId: string; tenantId: string; billId: string; billNumber: string; billDate: string
  supplierId: string; supplierName: string; description: string
  qty: number; billedUnitCostCents: number; billedCents: number; billedAt: string
}
interface GrniResponse {
  tenantIds: string[]; staleDays: number
  lines: GrniLine[]
  totals: { openValueCents: number; staleValueCents: number; pendingBilledCents: number }
  pendingBillMatches: PendingMatch[]
  /** Optional capability flags — when the API sends them they decide the buttons. */
  canRequestWriteOff?: boolean
  canApprove?: boolean
}
interface SupplierLite { id: string; name: string; tenantId?: string | null }

const fi = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'
const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: '2-digit' })
const qty = (n: number) => String(Math.round(n * 1000) / 1000)

export default function GrniPage() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const { data: tenants = [] } = useMyTenants()
  const [tenantId, setTenantId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [olderThan, setOlderThan] = useState('')
  const [requestedOnly, setRequestedOnly] = useState(false)
  // The line a write-off is being asked for / rejected on, and its text.
  const [panel, setPanel] = useState<{ id: string; mode: 'ask' | 'reject' } | null>(null)
  const [text, setText] = useState('')
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const qs = new URLSearchParams()
  if (tenantId) qs.set('tenantId', tenantId)
  if (supplierId) qs.set('supplierId', supplierId)
  if (olderThan) qs.set('olderThanDays', olderThan)
  if (requestedOnly) qs.set('writeOffRequested', '1')

  const { data, isLoading, error } = useQuery<GrniResponse>({
    queryKey: ['procurement', 'grni', tenantId, supplierId, olderThan, requestedOnly],
    queryFn: () => api.get(`/procurement/grni${qs.size ? `?${qs}` : ''}`),
  })
  const { data: suppliers = [] } = useQuery<SupplierLite[]>({
    queryKey: ['procurement', 'suppliers'], queryFn: () => api.get('/procurement/suppliers'), retry: false, meta: { background: true },
  })

  // The CEO (role admin) approves; the API may also send canApprove / canRequestWriteOff.
  const isCeo = me?.role === 'admin'
  const canApprove = data?.canApprove ?? isCeo
  const canAsk = data?.canRequestWriteOff ?? true   // the server refuses roles outside the requester list (403)

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['procurement', 'grni'] }); void qc.invalidateQueries({ queryKey: ['approvals'] }) }
  const onFail = (id: string) => (e: unknown) => {
    setRowError({ id, text: stockErrorText(e) })
    refresh()   // a 409 usually means someone else just answered it
  }
  const ask = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<{ status: 'requested' | 'written_off'; valueCents?: number }>(`/procurement/grni/${id}/write-off-request`, { reason }),
    onSuccess: (r) => {
      setPanel(null); setText(''); setRowError(null); refresh()
      setNotice(r.status === 'written_off'
        ? `Written off${r.valueCents != null ? ` — ${fmtPkrWhole(r.valueCents)} moved to cost of sales` : ''}.`
        : 'Sent to the CEO for approval.')
    },
    onError: (e, v) => onFail(v.id)(e),
  })
  const approve = useMutation({
    mutationFn: (id: string) => api.post<{ valueCents?: number }>(`/procurement/grni/${id}/write-off/approve`, {}),
    onSuccess: (r) => { setRowError(null); refresh(); setNotice(`Written off${r.valueCents != null ? ` — ${fmtPkrWhole(r.valueCents)} moved to cost of sales` : ''}.`) },
    onError: (e, id) => onFail(id)(e),
  })
  const reject = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api.post(`/procurement/grni/${id}/write-off/reject`, { note }),
    onSuccess: () => { setPanel(null); setText(''); setRowError(null); refresh(); setNotice('Request rejected — the line stays open.') },
    onError: (e, v) => onFail(v.id)(e),
  })
  const busy = ask.isPending || approve.isPending || reject.isPending

  const lines = data?.lines ?? []
  const pending = data?.pendingBillMatches ?? []
  const staleDays = data?.staleDays ?? 30
  const multi = tenants.length > 1

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-4 sm:px-6 py-4">
        <Link href="/procurement/receiving" className="text-xs text-s-muted hover:text-s-text">← Receiving</Link>
        <h1 className="text-2xl font-black text-s-text mt-1">Received, not billed</h1>
        <p className="text-sm text-s-muted mt-1 max-w-2xl">
          Goods that arrived and whose supplier bill has not been recorded yet. They sit in Goods received not invoiced until the bill clears them.
          Record the bill under <Link href="/procurement?tab=bills" className="text-primary-ink hover:underline">Procurement → Bills</Link> using &ldquo;Fill from receipt&rdquo;.
        </p>
      </header>

      <div className="px-4 sm:px-6 py-5 max-w-6xl mx-auto space-y-5">
        {notice && (
          <div role="status" className="rounded-xl px-4 py-3 text-sm font-semibold flex items-center justify-between gap-3"
            style={{ background: 'rgb(var(--erp-accent-rgb) / 0.14)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.45)', color: 'var(--erp-success)' }}>
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-xs text-s-muted hover:text-s-text" aria-label="Dismiss">✕</button>
          </div>
        )}

        {/* Totals */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Received, not billed" value={fmtPkrWhole(data?.totals.openValueCents ?? 0)} sub={`${lines.length} line${lines.length === 1 ? '' : 's'}`} />
          <Stat label={`Waiting over ${staleDays} days`} value={fmtPkrWhole(data?.totals.staleValueCents ?? 0)}
            sub={lines.filter((l) => l.stale).length > 0 ? `${lines.filter((l) => l.stale).length} stale line${lines.filter((l) => l.stale).length === 1 ? '' : 's'}` : 'Nothing stale'}
            tone={(data?.totals.staleValueCents ?? 0) > 0 ? 'warn' : undefined} />
          <Stat label="Billed before the goods came" value={fmtPkrWhole(data?.totals.pendingBilledCents ?? 0)} sub={`${pending.length} bill line${pending.length === 1 ? '' : 's'} waiting for delivery`} />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          {multi && (
            <label className="text-xs text-s-muted">Company
              <Select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setSupplierId('') }} className={fi + ' mt-1 min-w-[10rem]'}>
                <option value="">All my companies</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </label>
          )}
          <label className="text-xs text-s-muted">Supplier
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fi + ' mt-1 min-w-[10rem]'}>
              <option value="">All suppliers</option>
              {suppliers.filter((s) => !tenantId || s.tenantId === tenantId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
          <label className="text-xs text-s-muted">Waiting for
            <Select value={olderThan} onChange={(e) => setOlderThan(e.target.value)} className={fi + ' mt-1'}>
              <option value="">Any time</option>
              <option value="7">over 7 days</option>
              <option value="30">over 30 days</option>
              <option value="60">over 60 days</option>
              <option value="90">over 90 days</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-xs text-s-text pb-2 cursor-pointer">
            <input type="checkbox" className="accent-accent" checked={requestedOnly} onChange={(e) => setRequestedOnly(e.target.checked)} />
            Write-off requested only
          </label>
        </div>

        {error && <p role="alert" className="text-sm text-s-red">{stockErrorText(error, 'The list could not be loaded')}</p>}
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}

        {/* Open lines */}
        {!isLoading && !error && (
          lines.length === 0 ? (
            <div className="rounded-xl border border-s-border p-8 text-center">
              <p className="font-semibold text-success">Everything received has been billed</p>
              <p className="text-sm text-s-muted mt-1">{requestedOnly ? 'No write-off request is waiting.' : 'Deliveries appear here until their bill is recorded.'}</p>
            </div>
          ) : (
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-s-border bg-s-surface/40 text-left text-xs text-s-muted">
                      <th className="px-4 py-2.5 font-semibold">Supplier / item</th>
                      <th className="px-4 py-2.5 font-semibold">Received</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Open quantity</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Value</th>
                      <th className="px-4 py-2.5 font-semibold">Write-off</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const open = panel?.id === l.receiptLineId
                      const failed = rowError?.id === l.receiptLineId ? rowError.text : null
                      return (
                        <tr key={l.receiptLineId} className="border-b border-s-border/50 last:border-0 align-top">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-s-text">{l.description}</p>
                            <p className="text-xs text-s-muted">
                              {l.supplierName ?? 'Supplier'}
                              {multi && l.tenantId && <span className="ml-2"><TenantChip tenantId={l.tenantId} tenants={tenants} /></span>}
                            </p>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <p className="text-s-text">{fmt(l.receivedAt)}</p>
                            <p className="text-xs">
                              {l.stale
                                ? <span className="s-badge-amber">Stale · {l.ageDays} days</span>
                                : <span className="text-s-muted">{l.ageDays} day{l.ageDays === 1 ? '' : 's'}</span>}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap font-mono">
                            <p className="text-s-text">{qty(l.openQty)} {l.unit}</p>
                            <p className="text-[11px] text-s-muted">{qty(l.receivedQty)} received − {qty(l.billedQty)} billed</p>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-s-text">{fmtPkrWhole(l.openValueCents)}</td>
                          <td className="px-4 py-3 min-w-[14rem]">
                            {l.writeOffRequest ? (
                              <div className="space-y-1.5">
                                <span className="s-badge-amber">Write-off requested</span>
                                <p className="text-xs text-s-muted">{fmt(l.writeOffRequest.requestedAt)}{l.writeOffRequest.reason ? ` — “${l.writeOffRequest.reason}”` : ''}</p>
                                {canApprove ? (
                                  open && panel?.mode === 'reject' ? (
                                    <NotePanel label="Why is it rejected? (3+ characters)" text={text} setText={setText} busy={busy}
                                      submitLabel="Reject" tone="danger"
                                      onSubmit={() => reject.mutate({ id: l.receiptLineId, note: text.trim() })}
                                      onCancel={() => { setPanel(null); setText('') }} />
                                  ) : (
                                    <div className="flex gap-2 flex-wrap">
                                      <button disabled={busy} onClick={() => approve.mutate(l.receiptLineId)}
                                        className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold disabled:opacity-50">
                                        Approve write-off
                                      </button>
                                      <button disabled={busy} onClick={() => { setPanel({ id: l.receiptLineId, mode: 'reject' }); setText(''); setRowError(null) }}
                                        className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold text-s-red hover:bg-s-elevated disabled:opacity-50">
                                        Reject
                                      </button>
                                    </div>
                                  )
                                ) : (
                                  <p className="text-xs text-s-muted">Waiting for the CEO.</p>
                                )}
                              </div>
                            ) : canAsk ? (
                              open && panel?.mode === 'ask' ? (
                                <NotePanel label={canApprove ? 'Why is it never going to be billed? (3+ characters)' : 'Why will the supplier never bill it? (3+ characters)'}
                                  text={text} setText={setText} busy={busy}
                                  submitLabel={canApprove ? 'Write off now' : 'Send to the CEO'} tone="primary"
                                  onSubmit={() => ask.mutate({ id: l.receiptLineId, reason: text.trim() })}
                                  onCancel={() => { setPanel(null); setText('') }} />
                              ) : (
                                <button onClick={() => { setPanel({ id: l.receiptLineId, mode: 'ask' }); setText(''); setRowError(null) }}
                                  className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink">
                                  {canApprove ? 'Write off' : 'Ask to write off'}
                                </button>
                              )
                            ) : <span className="text-xs text-s-muted">—</span>}
                            {failed && <p role="alert" className="text-xs text-s-red mt-1.5">{failed}</p>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}
        {lines.length > 0 && (
          <p className="text-xs text-s-muted">
            A write-off is for goods the supplier will never bill. It moves the value from Goods received not invoiced to cost of sales; the stock stays on hand.
            Finance, management and procurement can ask; the CEO approves or rejects.
          </p>
        )}

        {/* Billed before the goods arrived */}
        {pending.length > 0 && !requestedOnly && (
          <section className="space-y-2">
            <h2 className="text-sm font-black text-s-text">Billed before the goods arrived</h2>
            <p className="text-xs text-s-muted">
              These bill lines were recorded against a purchase order before the delivery. They clear on their own when the goods are received.
            </p>
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-s-border bg-s-surface/40 text-left text-xs text-s-muted">
                      <th className="px-4 py-2.5 font-semibold">Bill</th>
                      <th className="px-4 py-2.5 font-semibold">Item</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Quantity</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Billed at</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Billed amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((p) => (
                      <tr key={p.matchId} className="border-b border-s-border/50 last:border-0">
                        <td className="px-4 py-2.5">
                          <p className="font-mono text-xs text-primary-ink">{p.billNumber}</p>
                          <p className="text-xs text-s-muted">{p.supplierName} · {fmt(p.billDate)}</p>
                        </td>
                        <td className="px-4 py-2.5 text-s-text">{p.description}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-s-text whitespace-nowrap">{qty(p.qty)}</td>
                        <td className="px-4 py-2.5 text-right text-s-muted whitespace-nowrap">PKR {(p.billedUnitCostCents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })} each</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-s-text whitespace-nowrap">{fmtPkrWhole(p.billedCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4">
      <p className="text-xs text-s-muted">{label}</p>
      <p className="text-2xl font-black mt-1" style={{ color: tone === 'warn' ? 'var(--erp-warning)' : 'var(--text)' }}>{value}</p>
      {sub && <p className="text-xs text-s-muted mt-0.5">{sub}</p>}
    </div>
  )
}

function NotePanel({ label, text, setText, busy, submitLabel, tone, onSubmit, onCancel }: {
  label: string; text: string; setText: (v: string) => void; busy: boolean
  submitLabel: string; tone: 'primary' | 'danger'; onSubmit: () => void; onCancel: () => void
}) {
  const ok = text.trim().length >= 3
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] text-s-muted">{label}
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={500} autoFocus className={fi + ' mt-1'} />
      </label>
      <div className="flex gap-2">
        <button disabled={!ok || busy} onClick={onSubmit}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50 ${tone === 'danger' ? 'bg-s-red text-bone' : 'bg-primary text-primary-on'}`}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-muted">Cancel</button>
      </div>
    </div>
  )
}
