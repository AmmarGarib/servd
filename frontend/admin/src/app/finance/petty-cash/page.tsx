'use client'
// Petty cash boxes — float register for small operational spend.
// Receipt photo required above PKR 500. Reconciliation flags variance.
// Money is typed in rupees (MoneyInput) and sent in paisa. Every change to a
// float is a movement on the box: a spend, a top-up (a manager, finance or
// the box's custodian), a transfer between two boxes of the same company, or
// a count. Petty cash is not booked to the ledger yet (pending owner
// decisions) — only a spend that pays a supplier bill is.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../../../components/pos/pinErrors'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { useAuthStore } from '../../../store/auth'

interface User { id: string; name: string }
interface Box {
  id: string
  tenantId: string | null
  name: string
  custodianId: string
  /** The custodian's name, sent with the box (GET /trustops/petty-cash/boxes). */
  custodianName?: string | null
  floatCents: number
  topUpLimitCents: number
  isActive: boolean
  movements: Movement[]
}
interface OpenBill { id: string; billNumber: string; status: string; totalCents: number; whtCents: number; paidCents: number; creditedCents?: number; supplier: { name: string } }
interface Movement {
  id: string
  type: 'topup' | 'spend' | 'reconcile' | 'transfer'
  amountCents: number
  category: string | null
  reason: string
  receiptUrl: string | null
  createdAt: string
}

const TYPE_LABEL: Record<Movement['type'], string> = { topup: 'Top-up', spend: 'Spend', reconcile: 'Count', transfer: 'Transfer' }
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

export default function PettyCashPage() {
  const qc = useQueryClient()
  const { data: boxes = [] } = useQuery<Box[]>({ queryKey: ['petty-cash-boxes'], queryFn: () => api.get('/trustops/petty-cash/boxes') })
  // The staff-account list is the managers' (and HR's). Finance works petty
  // cash without it: the box already carries its custodian's name, and the
  // picker below falls back to "me" — no 403 toast (meta.background).
  const me = useAuthStore((s) => s.user)
  const { data: staff } = useQuery<User[]>({
    queryKey: ['users'], queryFn: () => api.get('/auth/users'),
    retry: false, meta: { background: true },
  })
  const users: User[] = staff ?? (me ? [{ id: me.id, name: me.name }] : [])
  const [creating, setCreating] = useState(false)
  const [movingFor, setMovingFor] = useState<Box | null>(null)
  const [reconcileFor, setReconcileFor] = useState<Box | null>(null)
  const [transferFrom, setTransferFrom] = useState<Box | null>(null)
  const [editing, setEditing] = useState<Box | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-black text-white/90">Petty cash</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Float boxes for small operational spend. Every spend &gt; PKR 500 requires a receipt photo. Reconcile monthly — variance auto-flags to the owner inbox.
            </p>
          </div>
          <button onClick={() => setCreating(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New box</button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-3">
        <Link href="/finance/cash-vouchers" className="s-card-hover flex items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="font-black text-white/90">Cash vouchers</p>
            <p className="text-xs text-white/45 mt-0.5">Signed and paid vouchers land here as spends — the HOD signs, the director approves, and the photo of the cashier-signed voucher books it on its box.</p>
          </div>
          <span className="text-sm font-bold text-primary-ink shrink-0">Open →</span>
        </Link>
        {boxes.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No petty cash boxes</p>
            <p className="text-sm text-white/45 mt-1">Add a box to start tracking small spend with a paper trail.</p>
          </div>
        )}
        {boxes.map((b) => {
          const siblings = boxes.filter((o) => o.id !== b.id && o.tenantId === b.tenantId)
          return (
            <div key={b.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-black text-white/90 break-words">{b.name}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)' }}>
                      {pkr(b.floatCents)}
                    </span>
                  </div>
                  <p className="text-xs text-white/45 mt-1">
                    Custodian: {b.custodianName ?? users.find((u) => u.id === b.custodianId)?.name ?? '—'} · Top-up limit {pkr(b.topUpLimitCents)}
                  </p>
                  {b.movements.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {b.movements.slice(0, 3).map((m) => (
                        <div key={m.id} className="text-xs flex items-baseline gap-2 flex-wrap">
                          <span className="font-bold" style={{ color: m.amountCents >= 0 ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                            {m.amountCents >= 0 ? '+' : ''}{pkr(m.amountCents)}
                          </span>
                          <span className="text-white/40">{TYPE_LABEL[m.type] ?? m.type}</span>
                          <span className="text-white/55 break-words min-w-0">{m.reason}</span>
                          <span className="text-white/30">· {new Date(m.createdAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap sm:flex-col gap-1.5 shrink-0">
                  <button onClick={() => setMovingFor(b)} className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold hover:opacity-90">+ Movement</button>
                  <button onClick={() => setTransferFrom(b)} disabled={siblings.length === 0}
                    title={siblings.length === 0 ? 'No other box of this company to move cash to' : undefined}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white disabled:opacity-40">Transfer</button>
                  <button onClick={() => setReconcileFor(b)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Reconcile</button>
                  <button onClick={() => setEditing(b)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {creating && <CreateBoxModal users={users} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />}
      {movingFor && <MovementModal box={movingFor} onClose={() => setMovingFor(null)} onSaved={() => { setMovingFor(null); refresh() }} />}
      {transferFrom && <TransferModal from={transferFrom} boxes={boxes} onClose={() => setTransferFrom(null)} onSaved={() => { setTransferFrom(null); refresh() }} />}
      {editing && <EditBoxModal box={editing} users={users} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {reconcileFor && <ReconcileModal box={reconcileFor} onClose={() => setReconcileFor(null)} onSaved={() => { setReconcileFor(null); refresh(); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function CreateBoxModal({ users, onClose, onSaved }: { users: User[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [custodianId, setCustodianId] = useState('')
  const [floatCents, setFloatCents] = useState(100000)
  const [topUpLimitCents, setTopUpLimitCents] = useState(2000000)
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/boxes', { name: name.trim(), custodianId, floatCents, topUpLimitCents }),
    onSuccess: () => onSaved(),
  })
  return <Modal title="New petty cash box" onClose={onClose}>
    <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front-of-house drawer" className={fieldCls} autoFocus /></Field>
    <Field label="Custodian *">
      <select value={custodianId} onChange={(e) => setCustodianId(e.target.value)} className={fieldCls}>
        <option value="">— pick a user —</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </Field>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Opening float (PKR)">
        <MoneyInput value={floatCents} onChange={setFloatCents} className={fieldCls} ariaLabel="Opening float in rupees" />
      </Field>
      <Field label="Top-up limit (PKR)">
        <MoneyInput value={topUpLimitCents} onChange={setTopUpLimitCents} className={fieldCls} ariaLabel="Top-up limit in rupees" />
      </Field>
    </div>
    <p className="text-[10px] text-white/30">The opening float is recorded as the box&apos;s first top-up. A top-up above the limit needs a manager PIN.</p>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !custodianId} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Create box'}</button>} />
  </Modal>
}

function EditBoxModal({ box, users, onClose, onSaved }: { box: Box; users: User[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(box.name)
  const [custodianId, setCustodianId] = useState(box.custodianId)
  const [topUpLimitCents, setTopUpLimitCents] = useState(box.topUpLimitCents)
  const [managerOverridePin, setManagerOverridePin] = useState('')
  const raising = topUpLimitCents > box.topUpLimitCents
  // The current custodian stays pickable even when the staff list is not readable.
  const options = users.some((u) => u.id === box.custodianId)
    ? users
    : [{ id: box.custodianId, name: box.custodianName ?? 'Current custodian' }, ...users]
  const save = useMutation({
    mutationFn: () => api.patch(`/trustops/petty-cash/boxes/${box.id}`, {
      ...(name.trim() !== box.name && { name: name.trim() }),
      ...(custodianId !== box.custodianId && { custodianId }),
      ...(topUpLimitCents !== box.topUpLimitCents && { topUpLimitCents }),
      ...(raising && managerOverridePin && { managerOverridePin }),
    }),
    onSuccess: () => onSaved(),
  })
  const unchanged = name.trim() === box.name && custodianId === box.custodianId && topUpLimitCents === box.topUpLimitCents
  return <Modal title={`Edit ${box.name}`} onClose={onClose}>
    <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
    <Field label="Custodian *">
      <select value={custodianId} onChange={(e) => setCustodianId(e.target.value)} className={fieldCls}>
        {options.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </Field>
    <Field label="Top-up limit (PKR)">
      <MoneyInput value={topUpLimitCents} onChange={setTopUpLimitCents} className={fieldCls} ariaLabel="Top-up limit in rupees" />
      <p className="text-[10px] text-white/30 mt-1">Now {pkr(box.topUpLimitCents)}. A top-up above the limit needs a manager PIN.</p>
    </Field>
    {raising && (
      <Field label="Manager PIN *">
        <input type="password" inputMode="numeric" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Raising the limit needs a manager" className={fieldCls} />
      </Field>
    )}
    {save.error && <ErrorBanner error={pinRefusal(save.error) ?? save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || unchanged || !name.trim() || (raising && !managerOverridePin)} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Save'}</button>} />
  </Modal>
}

function MovementModal({ box, onClose, onSaved }: { box: Box; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'topup' | 'spend'>('spend')
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const [category, setCategory] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [receiptUrl, setReceiptUrl] = useState('')
  const [managerOverridePin, setManagerOverridePin] = useState('')
  // Paying a supplier's open bill in cash records it as that bill's supplier
  // payment (Dr AP / Cr cash) — so the bill, already booked through AP, is not
  // expensed a second time.
  const [supplierBillId, setSupplierBillId] = useState('')
  const { data: bills = [] } = useQuery<OpenBill[]>({
    queryKey: ['procurement-bills-open'],
    queryFn: () => api.get('/procurement/bills'),
    // Not everyone who records a spend reads the payables; without them this
    // is just a general spend (no 403 toast).
    retry: false, meta: { background: true },
  })
  const openBills = bills.filter((b) => b.status === 'open' || b.status === 'partially_paid')

  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/movements', {
      boxId: box.id, type, amountCents,
      reason, category: category || null, vendorName: vendorName || null,
      receiptUrl: receiptUrl || null,
      ...(type === 'spend' && supplierBillId && { supplierBillId }),
      ...(managerOverridePin && { managerOverridePin }),
    }),
    onSuccess: () => onSaved(),
  })

  const tab = (on: boolean, tone: string) => on
    ? { background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone, border: `1px solid ${tone}` }
    : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }

  return <Modal title={`${type === 'topup' ? 'Top up' : 'Spend from'} ${box.name}`} onClose={onClose}>
    <div className="flex gap-2">
      <button type="button" onClick={() => setType('spend')} className="flex-1 rounded-lg px-4 py-2 text-sm font-bold" style={tab(type === 'spend', 'var(--erp-warning)')}>
        Spend
      </button>
      <button type="button" onClick={() => setType('topup')} className="flex-1 rounded-lg px-4 py-2 text-sm font-bold" style={tab(type === 'topup', 'var(--erp-success)')}>
        Top up
      </button>
    </div>
    <Field label="Amount (PKR) *">
      <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] text-white/30 mt-1">In the box now: {pkr(box.floatCents)}</p>
    </Field>
    <Field label="Reason *">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'spend' ? 'Bottled water for staff lunch' : 'Top up from the safe'} className={fieldCls} />
    </Field>
    {type === 'spend' && (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="supplies · courier" className={fieldCls} /></Field>
          <Field label="Vendor"><input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Optional" className={fieldCls} /></Field>
        </div>
        {openBills.length > 0 && (
          <Field label="Pays a supplier bill?">
            <select value={supplierBillId} onChange={(e) => setSupplierBillId(e.target.value)} className={fieldCls}>
              <option value="">— no, a general spend —</option>
              {openBills.map((b) => (
                <option key={b.id} value={b.id}>{b.supplier.name} · {b.billNumber} · {pkr(b.totalCents - (b.whtCents ?? 0) - b.paidCents - (b.creditedCents ?? 0))} due</option>
              ))}
            </select>
            <p className="text-[10px] text-white/30 mt-1">Recorded as a cash payment against the bill, so it is not expensed twice.</p>
          </Field>
        )}
        <Field label="Receipt photo URL">
          <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="https://… (required above PKR 500)" className={fieldCls} />
          <p className="text-[10px] text-white/30 mt-1">Required for spends above PKR 500.</p>
        </Field>
      </>
    )}
    {type === 'topup' && (
      <p className="text-[10px] text-white/30">Only a manager, finance or this box&apos;s custodian can top it up. Limit without a PIN: {pkr(box.topUpLimitCents)}.</p>
    )}
    {type === 'topup' && amountCents > box.topUpLimitCents && (
      <Field label="Manager PIN">
        <input type="password" inputMode="numeric" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Required — exceeds top-up limit" className={fieldCls} />
      </Field>
    )}
    {save.error && <ErrorBanner error={pinRefusal(save.error) ?? save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0 || !reason.trim()} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Record movement'}</button>} />
  </Modal>
}

function TransferModal({ from, boxes, onClose, onSaved }: { from: Box; boxes: Box[]; onClose: () => void; onSaved: () => void }) {
  // Only boxes of the same company: cash never moves between companies here.
  const targets = boxes.filter((b) => b.id !== from.id && b.tenantId === from.tenantId)
  const [toBoxId, setToBoxId] = useState(targets[0]?.id ?? '')
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/transfers', { fromBoxId: from.id, toBoxId, amountCents, reason: reason.trim() }),
    onSuccess: () => onSaved(),
  })
  const over = amountCents > from.floatCents
  return <Modal title={`Move cash from ${from.name}`} onClose={onClose}>
    <Field label="To box *">
      <select value={toBoxId} onChange={(e) => setToBoxId(e.target.value)} className={fieldCls}>
        {targets.map((b) => <option key={b.id} value={b.id}>{b.name} · {pkr(b.floatCents)}</option>)}
      </select>
    </Field>
    <Field label="Amount (PKR) *">
      <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] mt-1" style={{ color: over ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
        {over ? `More than the ${pkr(from.floatCents)} in ${from.name}` : `In ${from.name} now: ${pkr(from.floatCents)}`}
      </p>
    </Field>
    <Field label="Reason *">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={160} placeholder="Weekend float for the kitchen box" className={fieldCls} />
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || !toBoxId || amountCents <= 0 || over || !reason.trim()} className={primaryBtn}>{save.isPending ? 'Moving…' : 'Move cash'}</button>} />
  </Modal>
}

function ReconcileModal({ box, onClose, onSaved }: { box: Box; onClose: () => void; onSaved: () => void }) {
  const [counted, setCounted] = useState(box.floatCents)
  const [notes, setNotes] = useState('')
  const variance = counted - box.floatCents
  const save = useMutation({
    mutationFn: () => api.post(`/trustops/petty-cash/boxes/${box.id}/reconcile`, { countedCents: counted, notes: notes || undefined }),
    onSuccess: () => onSaved(),
  })
  const tone = Math.abs(variance) >= 20000 ? 'var(--erp-warning)' : 'var(--erp-success)'

  return <Modal title={`Reconcile ${box.name}`} onClose={onClose}>
    <div className="rounded-lg p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-xs text-white/55">System float</p>
      <p className="text-2xl font-black text-white/90">{pkr(box.floatCents)}</p>
    </div>
    <Field label="Physical count (PKR) *">
      <MoneyInput value={counted} onChange={setCounted} className={fieldCls} autoFocus ariaLabel="Counted cash in rupees" />
    </Field>
    {Math.abs(variance) > 0 && (
      <div className="rounded-lg p-3 text-sm font-bold" style={{ background: `color-mix(in srgb, ${tone} 10%, transparent)`, color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}>
        Variance: {variance > 0 ? '+' : ''}{pkr(variance)}
        {Math.abs(variance) >= 20000 && ' — will flag'}
      </div>
    )}
    <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything noteworthy" className={fieldCls} /></Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Save count'}</button>} />
  </Modal>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
    <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90 min-w-0 truncate">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">{children}</div>
    </div>
  </div>
}
function Footer({ onCancel, primary }: { onCancel: () => void; primary: React.ReactNode }) {
  return <div className="flex justify-between gap-3 pt-3 border-t border-white/[0.05] -mx-5 -mb-5 px-4 py-4 mt-4 bg-white/[0.01]">
    <button onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
    {primary}
  </div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
// A top-up over the box limit (or raising the limit) is approved with a
// manager PIN: the same words as every other PIN prompt for a wrong PIN or a
// lock-out (pinErrors.ts).
function pinRefusal(e: unknown): Error | null {
  const locked = managerPinLockedMessage(e)
  if (locked) return new Error(locked)
  if (e instanceof ApiError && e.code === 'INVALID_MANAGER_PIN') return new Error(WRONG_PIN_MESSAGE)
  return null
}
function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Failed'
  return <div className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>{msg}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
const primaryBtn = "rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
