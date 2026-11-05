'use client'
// The PO → GRN workflow screens (owner, 2026-11-05; backend procurement/poWorkflow.ts):
//   MyTasksTab — the caller's OWN tasks: to buy (attach the invoice, invoice no. / date, actual rates, "Mark
//     completed"), to confirm (what arrived, per line, in the line's order unit; "Confirm receipt" / "Not received —
//     send back"), to fix (a GRN returned by finance / the CEO: correct the invoice and resubmit).
//   GrnsTab — every GRN of the companies in view, with its PO lines ordered vs received vs invoiced, the invoice files
//     and the bill. Finance verifies and the CEO approves from the approvals inbox (or here, when it is theirs).
// ERP tokens only; dropdowns are the shared Select; every action calls the module's own route.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkrWhole, todayPktIso } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { Button, Field, Input, LinkButton } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import { Modal } from '../ui/Modal'
import { MoneyInput } from '../ui/MoneyInput'
import { RecordFiles } from '@/components/files/RecordFiles'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WfLine {
  id: string; inventoryItemId: string; quantityOrdered: number; quantityReceived: number; unitCostCents: number
  orderUnit?: string | null; orderUnitFactor?: number | null; orderUnitCostCents?: number | null
  inventoryItem?: { name: string; unit: string } | null
}
export interface WfPo {
  id: string; reference?: string | null; status: string; totalCents: number; createdAt: string; approvedAt?: string | null
  invoiceNumber?: string | null; invoiceDate?: string | null; receiptReturnNote?: string | null; payByCash?: boolean
  supplier?: { id?: string; name: string; tenantId?: string | null; systemKind?: string | null } | null
  lines: WfLine[]; invoiceFiles: number
}
interface WfGrnRow {
  id: string; grnNumber: string; grnStatus: string; invoiceNumber: string | null; invoiceDate: string | null; tenantId: string | null
  receivedAt: string; returnNote: string | null; returnCount: number; valueCents: number; invoicedCents: number
  supplierBillId: string | null; bill: { id: string; billNumber: string; status: string; totalCents: number } | null
  supplier: { id: string; name: string } | null
  po: { id: string; reference: string | null; payByCash: boolean; status: string } | null
  names: { createdBy: string | null; buyer: string | null; receivedBy: string | null; financeChecked: string | null; approvedBy: string | null }
}
interface WfFix { id: string; grnNumber: string; invoiceNumber: string | null; invoiceDate: string | null; returnNote: string | null; lines: Array<{ poLineId: string | null; receivedQty: number }>; po: WfPo }
export interface MyTasks { toBuy: WfPo[]; toConfirm: WfPo[]; toFix: WfFix[] }

export const MY_TASKS_KEY = ['procurement', 'my-tasks'] as const
export function useMyPoTasks(enabled = true) {
  return useQuery({ queryKey: MY_TASKS_KEY, queryFn: () => api.get<MyTasks>('/procurement/my-tasks'), enabled, staleTime: 30_000 })
}
export const taskCount = (t: MyTasks | undefined) => (t ? t.toBuy.length + t.toConfirm.length + t.toFix.length : 0)

/** A line in the unit it was ordered in (backend poUnits.ts lineDisplay). */
const shown = (l: WfLine) => l.orderUnit && l.orderUnitCostCents != null && (l.orderUnitFactor ?? 0) > 0
  ? { factor: l.orderUnitFactor!, unit: l.orderUnit, rate: l.orderUnitCostCents }
  : { factor: 1, unit: l.inventoryItem?.unit ?? '', rate: l.unitCostCents }
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const errOf = (e: unknown) => (e instanceof Error ? e.message : 'That did not work')
const ref = (po: { reference?: string | null; id: string }) => po.reference ?? `PO ${po.id.slice(-8).toUpperCase()}`
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

const GRN_STATUS: Record<string, { label: string; cls: string }> = {
  finance_review: { label: 'With finance', cls: 'text-s-amber bg-s-amber-dim/60' },
  buyer_fix: { label: 'Back with the buyer', cls: 'text-s-red bg-s-red/10' },
  ceo_review: { label: 'With the CEO', cls: 'text-s-amber bg-s-amber-dim/60' },
  approved: { label: 'Approved — billed', cls: 'text-success bg-accent-dim' },
}
function GrnBadge({ status }: { status: string }) {
  const s = GRN_STATUS[status] ?? { label: status.replace(/_/g, ' '), cls: 'text-s-muted bg-s-elevated' }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide whitespace-nowrap ${s.cls}`}>{s.label}</span>
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>, poId?: string) {
  void qc.invalidateQueries({ queryKey: MY_TASKS_KEY })
  void qc.invalidateQueries({ queryKey: ['procurement', 'pos'] })
  void qc.invalidateQueries({ queryKey: ['procurement', 'grns'] })
  if (poId) void qc.invalidateQueries({ queryKey: ['procurement', 'po', poId] })
}

// ─── My tasks ────────────────────────────────────────────────────────────────

export function MyTasksTab() {
  const { data, isLoading, isError, error } = useMyPoTasks()
  if (isLoading) return <div className="p-6"><p className="text-s-muted text-sm">Loading…</p></div>
  if (isError) return <div className="p-6"><p role="alert" className="text-sm text-s-red">{errOf(error)}</p></div>
  const t = data ?? { toBuy: [], toConfirm: [], toFix: [] }
  if (taskCount(t) === 0) {
    return <div className="p-6"><CompactEmptyState message="Nothing waiting for you" detail="POs you buy, receipts you confirm and GRNs sent back to you show here." /></div>
  }
  return (
    <div className="p-4 sm:p-6 space-y-6">
      {t.toFix.length > 0 && (
        <section className="space-y-2" aria-labelledby="wf-fix">
          <h2 id="wf-fix" className="text-sm font-black text-s-text">To fix — GRNs sent back to you ({t.toFix.length})</h2>
          {t.toFix.map((g) => <FixCard key={g.id} g={g} />)}
        </section>
      )}
      {t.toBuy.length > 0 && (
        <section className="space-y-2" aria-labelledby="wf-buy">
          <h2 id="wf-buy" className="text-sm font-black text-s-text">To buy ({t.toBuy.length})</h2>
          {t.toBuy.map((po) => <BuyCard key={po.id} po={po} />)}
        </section>
      )}
      {t.toConfirm.length > 0 && (
        <section className="space-y-2" aria-labelledby="wf-confirm">
          <h2 id="wf-confirm" className="text-sm font-black text-s-text">To confirm — did it arrive? ({t.toConfirm.length})</h2>
          {t.toConfirm.map((po) => <ConfirmCard key={po.id} po={po} />)}
        </section>
      )}
    </div>
  )
}

function Card({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3 min-w-0">
      <div className="min-w-0">
        <p className="font-bold text-s-text break-words">{title}</p>
        {sub && <p className="text-xs text-s-muted mt-0.5 break-words">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

/** Rate inputs per line (rupees per the line's order unit): only changed ones are sent. */
function RateFields({ lines, rates, setRates }: { lines: WfLine[]; rates: Record<string, number>; setRates: (r: Record<string, number>) => void }) {
  return (
    <div className="space-y-2">
      {lines.map((l) => {
        const s = shown(l)
        return (
          <div key={l.id} className="grid grid-cols-1 sm:grid-cols-[1fr_12rem] gap-1 sm:gap-3 items-center">
            <span className="text-xs text-s-text break-words">{l.inventoryItem?.name ?? 'Item'} · {round6(l.quantityOrdered / s.factor)} {s.unit}</span>
            <MoneyInput value={rates[l.id] ?? s.rate} onChange={(c) => setRates({ ...rates, [l.id]: c })} ariaLabel={`Rate per ${s.unit} for ${l.inventoryItem?.name ?? 'item'}`} className="s-input w-full" />
          </div>
        )
      })}
      <p className="text-[11px] text-s-muted">The rate per the unit ordered in — change it only when the invoice price differs.</p>
    </div>
  )
}
const changedRates = (lines: WfLine[], rates: Record<string, number>) =>
  lines.filter((l) => rates[l.id] != null && rates[l.id] !== shown(l).rate).map((l) => ({ poLineId: l.id, rateCents: rates[l.id]! }))

function BuyCard({ po }: { po: WfPo }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(todayPktIso())
  const [rates, setRates] = useState<Record<string, number>>({})
  const [tried, setTried] = useState(false)
  const done = useMutation({
    mutationFn: () => api.post(`/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: invoiceNumber.trim(), invoiceDate, lines: changedRates(po.lines, rates) }),
    onSuccess: () => { setOpen(false); invalidateAll(qc, po.id) },
  })
  const noSupplier = !!po.supplier?.systemKind
  return (
    <Card title={`${ref(po)} — ${noSupplier ? 'supplier not chosen yet' : po.supplier?.name ?? ''}`}
      sub={<>{fmtPkrWhole(po.totalCents)} · {po.lines.length} line{po.lines.length === 1 ? '' : 's'} · {po.payByCash ? 'Paid in cash from your box' : 'On the supplier\'s credit'}</>}>
      {po.receiptReturnNote && <p className="text-xs text-s-red">Sent back by the requester: {po.receiptReturnNote}</p>}
      {noSupplier && <p className="text-xs text-s-amber">Choose the supplier on the Purchase Orders tab before completing it.</p>}
      <RecordFiles ownerType="purchase_order" ownerId={po.id} canUpload title="Supplier's invoice / bill" tenantId={po.supplier?.tenantId ?? undefined}
        emptyText="Attach the supplier's invoice or bill (photo, PDF or Office file)." />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { setOpen(true); setTried(false); done.reset() }} disabled={noSupplier}>Mark completed</Button>
      </div>
      {open && (
        <Modal title={`Mark ${ref(po)} completed`} onClose={() => setOpen(false)} dirty={invoiceNumber !== ''}>
          <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!invoiceNumber.trim() || !invoiceDate || done.isPending) return; done.mutate() }}>
            <p className="text-xs text-s-muted">It goes to whoever raised it to confirm what arrived. The invoice must be attached first.</p>
            <Field label="Invoice / bill number" required error={tried && !invoiceNumber.trim() ? "Enter the supplier's invoice number." : null}>
              <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={100} className="w-full" autoFocus />
            </Field>
            <Field label="Invoice date" required>
              <Input type="date" value={invoiceDate} max={todayPktIso()} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full" />
            </Field>
            <RateFields lines={po.lines} rates={rates} setRates={setRates} />
            {done.error && <p role="alert" className="text-xs text-s-red">{errOf(done.error)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={done.isPending}>Mark completed</Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>Back</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  )
}

function ConfirmCard({ po }: { po: WfPo }) {
  const qc = useQueryClient()
  const outstanding = (l: WfLine) => Math.max(0, l.quantityOrdered - l.quantityReceived)
  // Typed in each line's order unit; sent in stock units.
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(po.lines.map((l) => [l.id, String(round6(outstanding(l) / shown(l).factor))])))
  const [sendBack, setSendBack] = useState(false)
  const [note, setNote] = useState('')
  const [tried, setTried] = useState(false)
  const confirm = useMutation({
    mutationFn: () => api.post(`/procurement/purchase-orders/${po.id}/confirm-receipt`, {
      lines: po.lines.map((l) => ({ poLineId: l.id, quantityReceived: round6((Number(qty[l.id]) || 0) * shown(l).factor) })),
    }),
    onSuccess: () => invalidateAll(qc, po.id),
  })
  const reject = useMutation({
    mutationFn: () => api.post(`/procurement/purchase-orders/${po.id}/reject-receipt`, { note: note.trim() }),
    onSuccess: () => { setSendBack(false); invalidateAll(qc, po.id) },
  })
  const bad = po.lines.some((l) => !(Number(qty[l.id]) >= 0) || qty[l.id] === '')
  return (
    <Card title={`${ref(po)} — ${po.supplier?.name ?? ''}`}
      sub={<>Bought on invoice {po.invoiceNumber ?? '—'} ({day(po.invoiceDate)}) · {fmtPkrWhole(po.totalCents)}</>}>
      <RecordFiles ownerType="purchase_order" ownerId={po.id} canUpload={false} title="Supplier's invoice / bill" tenantId={po.supplier?.tenantId ?? undefined} lazy />
      <div className="space-y-2">
        {po.lines.map((l) => {
          const s = shown(l)
          const typed = Number(qty[l.id]) || 0
          return (
            <div key={l.id} className="grid grid-cols-1 sm:grid-cols-[1fr_9rem] gap-1 sm:gap-3 items-center">
              <div className="min-w-0">
                <p className="text-xs text-s-text break-words">{l.inventoryItem?.name ?? 'Item'}</p>
                <p className="text-[11px] text-s-muted">Ordered {round6(l.quantityOrdered / s.factor)} {s.unit}{l.quantityReceived > 0 ? ` · ${round6(l.quantityReceived / s.factor)} already in` : ''}
                  {s.factor !== 1 ? ` · = ${round6(typed * s.factor)} ${l.inventoryItem?.unit ?? ''} in stock` : ''}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Input inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^0-9.]/g, '') })}
                  aria-label={`Received ${s.unit} of ${l.inventoryItem?.name ?? 'item'}`} className="w-full text-right" />
                <span className="text-xs text-s-muted shrink-0">{s.unit}</span>
              </div>
            </div>
          )
        })}
      </div>
      {confirm.error && <p role="alert" className="text-xs text-s-red">{errOf(confirm.error)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={bad || confirm.isPending} onClick={() => confirm.mutate()}>Confirm receipt</Button>
        <Button size="sm" variant="secondary" onClick={() => { setSendBack(true); setTried(false); reject.reset() }}>Not received — send back</Button>
      </div>
      {sendBack && (
        <Modal title={`Send ${ref(po)} back to the buyer`} onClose={() => setSendBack(false)} dirty={note !== ''}>
          <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); if (note.trim().length < 10 || reject.isPending) return; reject.mutate() }}>
            <Field label="What did not arrive, or is wrong" required error={tried && note.trim().length < 10 ? 'At least 10 characters.' : null}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} className="w-full" autoFocus />
            </Field>
            {reject.error && <p role="alert" className="text-xs text-s-red">{errOf(reject.error)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" type="submit" disabled={reject.isPending}>Send back</Button>
              <Button variant="secondary" onClick={() => setSendBack(false)}>Back</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  )
}

function FixCard({ g }: { g: WfFix }) {
  const qc = useQueryClient()
  const [invoiceNumber, setInvoiceNumber] = useState(g.invoiceNumber ?? '')
  const [invoiceDate, setInvoiceDate] = useState(g.invoiceDate ? g.invoiceDate.slice(0, 10) : todayPktIso())
  const [rates, setRates] = useState<Record<string, number>>({})
  const onGrn = new Set(g.lines.map((l) => l.poLineId))
  const lines = g.po.lines.filter((l) => onGrn.has(l.id))
  const re = useMutation({
    mutationFn: () => api.post(`/procurement/grns/${g.id}/resubmit`, { invoiceNumber: invoiceNumber.trim(), invoiceDate, lines: changedRates(lines, rates) }),
    onSuccess: () => invalidateAll(qc, g.po.id),
  })
  return (
    <Card title={`${g.grnNumber} — ${ref(g.po)} — ${g.po.supplier?.name ?? ''}`} sub={`Invoice ${g.invoiceNumber ?? '—'}`}>
      {g.returnNote && <p className="text-xs text-s-red">Returned: {g.returnNote}</p>}
      <RecordFiles ownerType="purchase_order" ownerId={g.po.id} canUpload title="Supplier's invoice / bill" tenantId={g.po.supplier?.tenantId ?? undefined} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Invoice / bill number" required><Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={100} className="w-full" /></Field>
        <Field label="Invoice date" required><Input type="date" value={invoiceDate} max={todayPktIso()} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full" /></Field>
      </div>
      <RateFields lines={lines} rates={rates} setRates={setRates} />
      {re.error && <p role="alert" className="text-xs text-s-red">{errOf(re.error)}</p>}
      <Button size="sm" disabled={!invoiceNumber.trim() || re.isPending} onClick={() => re.mutate()}>Resubmit to finance</Button>
    </Card>
  )
}

// ─── GRNs ────────────────────────────────────────────────────────────────────

const GRN_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' }, { id: 'finance_review', label: 'With finance' }, { id: 'buyer_fix', label: 'Back with the buyer' },
  { id: 'ceo_review', label: 'With the CEO' }, { id: 'approved', label: 'Approved' },
]

export function GrnsTab({ initialId }: { initialId?: string | null }) {
  const [status, setStatus] = useState('')
  const [openId, setOpenId] = useState<string | null>(initialId ?? null)
  const { data: rows = [], isLoading, isError, error } = useQuery({
    queryKey: ['procurement', 'grns', status],
    queryFn: () => api.get<WfGrnRow[]>(`/procurement/grns${status ? `?status=${status}` : ''}`),
  })
  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex gap-1 flex-wrap">
        {GRN_FILTERS.map((f) => (
          <button type="button" key={f.id} onClick={() => setStatus(f.id)} aria-pressed={status === f.id}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${status === f.id ? 'bg-accent-dim border border-accent text-s-text' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
            {f.label}
          </button>
        ))}
      </div>
      {isLoading ? <p className="text-s-muted text-sm">Loading…</p>
        : isError ? <p role="alert" className="text-sm text-s-red">{errOf(error)}</p>
          : rows.length === 0 ? <CompactEmptyState message="No GRNs" detail="A GRN is made when the requester confirms a purchase arrived." />
            : (
              <div className="rounded-xl border border-s-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-s-border bg-s-surface/40">
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold">GRN</th>
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold">PO</th>
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Invoice</th>
                        <th className="text-right px-3 py-2.5 text-xs text-s-muted font-semibold">Invoice value</th>
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold">Status</th>
                        <th className="text-left px-3 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Bill</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((g) => (
                        <tr key={g.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                          <td className="px-3 py-2.5"><LinkButton onClick={() => setOpenId(openId === g.id ? null : g.id)}>{g.grnNumber}</LinkButton></td>
                          <td className="px-3 py-2.5 text-s-text whitespace-nowrap">{g.po?.reference ?? '—'}</td>
                          <td className="px-3 py-2.5 text-s-text">{g.supplier?.name ?? '—'}</td>
                          <td className="px-3 py-2.5 text-s-muted hidden md:table-cell">{g.invoiceNumber ?? '—'}</td>
                          <td className="px-3 py-2.5 text-right font-semibold text-s-text">{fmtPkrWhole(g.invoicedCents)}</td>
                          <td className="px-3 py-2.5"><GrnBadge status={g.grnStatus} /></td>
                          <td className="px-3 py-2.5 text-s-muted hidden md:table-cell">{g.bill?.billNumber ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
      {openId && <GrnDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

interface GrnDetailRow extends WfGrnRow {
  lines: Array<{ poLineId: string; item: string; unit: string; stockUnit: string; rateCents: number; orderedInUnit: number; receivedHereInUnit: number; receivedAllGrns: number; invoicedCents: number }>
  files: Array<{ id: string }>
  activity: Array<{ id: string; action: string; createdAt: string; user: { name: string | null } | null; details: { note?: string } | null }>
}

function GrnDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const { data: g, isError, error } = useQuery({ queryKey: ['procurement', 'grns', 'one', id], queryFn: () => api.get<GrnDetailRow>(`/procurement/grns/${id}`) })
  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(`/procurement/grns/${id}/${path}`, body ?? {}),
    onSuccess: () => { setReturning(false); setNote(''); invalidateAll(qc, g?.po?.id); void qc.invalidateQueries({ queryKey: ['procurement', 'grns', 'one', id] }) },
  })
  if (isError) return <p role="alert" className="text-sm text-s-red">{errOf(error)}</p>
  if (!g) return <p className="text-s-muted text-sm">Loading…</p>
  const role = me?.role ?? ''
  const canFinance = g.grnStatus === 'finance_review' && (role === 'finance' || role === 'admin')
  const canCeo = g.grnStatus === 'ceo_review' && role === 'admin'
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-s-text break-words">{g.grnNumber} — {g.po?.reference ?? 'PO'} — {g.supplier?.name ?? ''}</p>
          <p className="text-xs text-s-muted">Invoice {g.invoiceNumber ?? '—'} · {day(g.invoiceDate)} · received {day(g.receivedAt)}{g.names.receivedBy ? ` by ${g.names.receivedBy}` : ''}</p>
        </div>
        <LinkButton tone="muted" onClick={onClose}>Close</LinkButton>
      </div>
      <GrnBadge status={g.grnStatus} />
      {g.returnNote && g.grnStatus === 'buyer_fix' && <p className="text-xs text-s-red">Returned: {g.returnNote}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-s-border/50">
              <th className="text-left py-1.5 text-s-muted">Item</th>
              <th className="text-right py-1.5 text-s-muted">Ordered</th>
              <th className="text-right py-1.5 text-s-muted">This GRN</th>
              <th className="text-right py-1.5 text-s-muted">Rate</th>
              <th className="text-right py-1.5 text-s-muted">Invoiced</th>
            </tr>
          </thead>
          <tbody>
            {g.lines.map((l) => (
              <tr key={l.poLineId} className={`border-b border-s-border/30 last:border-0 ${Math.abs(l.receivedHereInUnit - l.orderedInUnit) > 1e-9 ? 'bg-s-amber-dim/30' : ''}`}>
                <td className="py-1.5 text-s-text">{l.item}</td>
                <td className="py-1.5 text-right text-s-text whitespace-nowrap">{l.orderedInUnit} {l.unit}</td>
                <td className="py-1.5 text-right text-s-text whitespace-nowrap">{l.receivedHereInUnit} {l.unit}</td>
                <td className="py-1.5 text-right text-s-muted whitespace-nowrap">{fmtPkrWhole(l.rateCents)} / {l.unit}</td>
                <td className="py-1.5 text-right font-semibold text-s-text">{fmtPkrWhole(l.invoicedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-s-muted">Booked at receipt {fmtPkrWhole(g.valueCents)} · invoice value {fmtPkrWhole(g.invoicedCents)} · paid {g.po?.payByCash ? "in cash from the buyer's box" : "on the supplier's credit"}</p>
      {g.po && <RecordFiles ownerType="purchase_order" ownerId={g.po.id} canUpload={false} title="Supplier's invoice / bill" tenantId={g.tenantId ?? undefined} />}
      <ol className="flex flex-wrap gap-2" aria-label="GRN steps">
        {[
          { label: 'Receipt confirmed', who: g.names.createdBy },
          { label: 'Finance check', who: g.names.financeChecked },
          { label: 'CEO approval', who: g.names.approvedBy },
        ].map((st) => (
          <li key={st.label} className="rounded-lg border border-s-border bg-s-bg px-2.5 py-1.5 text-xs">
            <span className="font-semibold text-s-text">{st.label}</span>
            <span className="block text-s-muted">{st.who ?? '—'}</span>
          </li>
        ))}
      </ol>
      {g.bill && (
        <p className="text-xs text-s-text">Bill <Link className="font-semibold text-primary-ink underline" href="/procurement?tab=bills">{g.bill.billNumber}</Link> — {fmtPkrWhole(g.bill.totalCents)} · {g.bill.status.replace(/_/g, ' ')}</p>
      )}
      {g.activity.length > 0 && (
        <ul className="text-[11px] text-s-muted space-y-0.5">
          {g.activity.map((a) => <li key={a.id}>{day(a.createdAt)} · {a.action.replace(/^grn_/, '').replace(/_/g, ' ')}{a.user?.name ? ` · ${a.user.name}` : ''}{a.details?.note ? ` — ${a.details.note}` : ''}</li>)}
        </ul>
      )}
      {act.error && <p role="alert" className="text-xs text-s-red">{errOf(act.error)}</p>}
      {(canFinance || canCeo) && (
        <div className="flex flex-wrap gap-2">
          {canFinance && <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'finance-pass' })}>Verified — to the CEO</Button>}
          {canCeo && <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve' })}>Approve &amp; book the bill</Button>}
          <Button size="sm" variant="secondary" onClick={() => setReturning(true)}>Return to the buyer</Button>
        </div>
      )}
      {returning && (
        <Modal title={`Return ${g.grnNumber} to the buyer`} onClose={() => setReturning(false)} dirty={note !== ''}>
          <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (note.trim().length < 10 || act.isPending) return; act.mutate({ path: 'return', body: { note: note.trim() } }) }}>
            <Field label="What the buyer must correct" required error={note && note.trim().length < 10 ? 'At least 10 characters.' : null}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} className="w-full" autoFocus />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" disabled={act.isPending || note.trim().length < 10}>Return</Button>
              <Button variant="secondary" onClick={() => setReturning(false)}>Back</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

/** The buyer picker of the CEO's approve dialog (active logins of the PO's company, buyers first). */
export function BuyerPicker({ poId, value, onChange }: { poId: string; value: string; onChange: (v: string) => void }) {
  const { data: opts = [], isError } = useQuery({
    queryKey: ['procurement', 'buyer-options', poId],
    queryFn: () => api.get<Array<{ id: string; name: string | null; email: string | null; role: string }>>(`/procurement/purchase-orders/${poId}/buyer-options`),
  })
  return (
    <Field label="Buyer" hint="Empty = the company's buyer, else whoever raised it">
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="s-input w-full">
        <option value="">The company&apos;s buyer (else the requester)</option>
        {opts.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? 'Login'} · {u.role.replace(/_/g, ' ')}</option>)}
      </Select>
      {isError && <p className="text-xs text-s-red">Could not load the logins.</p>}
    </Field>
  )
}
