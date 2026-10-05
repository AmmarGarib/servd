'use client'
// Petty cash boxes — float register for small operational spend.
// Receipt photo required above PKR 500. Reconciliation flags variance.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface User { id: string; name: string }
interface Box {
  id: string
  name: string
  custodianId: string
  floatCents: number
  topUpLimitCents: number
  isActive: boolean
  movements: Movement[]
}
interface OpenBill { id: string; billNumber: string; status: string; totalCents: number; whtCents: number; paidCents: number; supplier: { name: string } }
interface Movement {
  id: string
  type: 'topup' | 'spend' | 'reconcile' | 'transfer'
  amountCents: number
  category: string | null
  reason: string
  receiptUrl: string | null
  createdAt: string
}

export default function PettyCashPage() {
  const qc = useQueryClient()
  const { data: boxes = [] } = useQuery<Box[]>({ queryKey: ['petty-cash-boxes'], queryFn: () => api.get('/trustops/petty-cash/boxes') })
  const { data: users = [] } = useQuery<User[]>({ queryKey: ['users'], queryFn: () => api.get('/auth/users') })
  const [creating, setCreating] = useState(false)
  const [movingFor, setMovingFor] = useState<Box | null>(null)
  const [reconcileFor, setReconcileFor] = useState<Box | null>(null)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">💰 Petty cash</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Float boxes for small operational spend. Every spend &gt; PKR 500 requires a receipt photo. Reconcile monthly — variance auto-flags to the owner inbox.
            </p>
          </div>
          <button onClick={() => setCreating(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New box</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-3">
        {boxes.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No petty cash boxes</p>
            <p className="text-sm text-white/45 mt-1">Add a box to start tracking small spend with a paper trail.</p>
          </div>
        )}
        {boxes.map((b) => (
          <div key={b.id} className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-black text-white/90">{b.name}</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgb(135 197 64 / 0.1)', color: 'var(--erp-primary-ink)' }}>
                    PKR {(b.floatCents / 100).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-white/45 mt-1">
                  Custodian: {users.find((u) => u.id === b.custodianId)?.name ?? '—'} · Top-up limit PKR {(b.topUpLimitCents / 100).toLocaleString()}
                </p>
                {b.movements.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {b.movements.slice(0, 3).map((m) => (
                      <div key={m.id} className="text-xs flex items-center gap-2">
                        <span className="font-bold" style={{ color: m.amountCents >= 0 ? 'var(--erp-primary-ink)' : '#a15c00' }}>
                          {m.amountCents >= 0 ? '+' : ''}PKR {(m.amountCents / 100).toLocaleString()}
                        </span>
                        <span className="text-white/55">{m.reason}</span>
                        <span className="text-white/30">· {new Date(m.createdAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={() => setMovingFor(b)} className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold hover:opacity-90">+ Movement</button>
                <button onClick={() => setReconcileFor(b)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Reconcile</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {creating && <CreateBoxModal users={users} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] }) }} />}
      {movingFor && <MovementModal box={movingFor} onClose={() => setMovingFor(null)} onSaved={() => { setMovingFor(null); qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] }) }} />}
      {reconcileFor && <ReconcileModal box={reconcileFor} onClose={() => setReconcileFor(null)} onSaved={() => { setReconcileFor(null); qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function CreateBoxModal({ users, onClose, onSaved }: { users: User[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [custodianId, setCustodianId] = useState('')
  const [floatCents, setFloatCents] = useState(100000)
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/boxes', { name, custodianId, floatCents, topUpLimitCents: 2000000 }),
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
    <Field label="Opening float (paisa)">
      <input type="number" value={floatCents} onChange={(e) => setFloatCents(parseInt(e.target.value) || 0)} className={fieldCls} />
      <p className="text-[10px] text-white/30 mt-1">≈ PKR {(floatCents / 100).toLocaleString()}</p>
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !custodianId} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Create box'}</button>} />
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
    retry: false,
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

  return <Modal title={`${type === 'topup' ? 'Top up' : 'Spend from'} ${box.name}`} onClose={onClose}>
    <div className="flex gap-2">
      <button type="button" onClick={() => setType('spend')} className="flex-1 rounded-lg px-4 py-2 text-sm font-bold"
        style={type === 'spend' ? { background: 'rgba(245,158,11,0.15)', color: '#a15c00', border: '1px solid rgba(245,158,11,0.4)' } : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        Spend
      </button>
      <button type="button" onClick={() => setType('topup')} className="flex-1 rounded-lg px-4 py-2 text-sm font-bold"
        style={type === 'topup' ? { background: 'rgb(135 197 64 / 0.12)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(135 197 64 / 0.4)' } : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        Top up
      </button>
    </div>
    <Field label="Amount (paisa) *">
      <input type="number" value={amountCents} onChange={(e) => setAmountCents(parseInt(e.target.value) || 0)} className={fieldCls} />
      <p className="text-[10px] text-white/30 mt-1">≈ PKR {(amountCents / 100).toLocaleString()}</p>
    </Field>
    <Field label="Reason *">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'spend' ? 'Bottled water for staff lunch' : 'Top up from main till'} className={fieldCls} />
    </Field>
    {type === 'spend' && (
      <>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="supplies · courier" className={fieldCls} /></Field>
          <Field label="Vendor"><input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Optional" className={fieldCls} /></Field>
        </div>
        {openBills.length > 0 && (
          <Field label="Pays a supplier bill?">
            <select value={supplierBillId} onChange={(e) => setSupplierBillId(e.target.value)} className={fieldCls}>
              <option value="">— no, a general spend —</option>
              {openBills.map((b) => (
                <option key={b.id} value={b.id}>{b.supplier.name} · {b.billNumber} · PKR {((b.totalCents - (b.whtCents ?? 0) - b.paidCents) / 100).toLocaleString()} due</option>
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
    {type === 'topup' && amountCents > box.topUpLimitCents && (
      <Field label="Manager PIN">
        <input type="password" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Required — exceeds top-up limit" className={fieldCls} />
      </Field>
    )}
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0 || !reason.trim()} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Record movement'}</button>} />
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

  return <Modal title={`Reconcile ${box.name}`} onClose={onClose}>
    <div className="rounded-lg p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-xs text-white/55">System float</p>
      <p className="text-2xl font-black text-white/90">PKR {(box.floatCents / 100).toLocaleString()}</p>
    </div>
    <Field label="Physical count (paisa) *">
      <input type="number" value={counted} onChange={(e) => setCounted(parseInt(e.target.value) || 0)} className={fieldCls} autoFocus />
      <p className="text-[10px] text-white/30 mt-1">≈ PKR {(counted / 100).toLocaleString()}</p>
    </Field>
    {Math.abs(variance) > 0 && (
      <div className="rounded-lg p-3 text-sm font-bold" style={{ background: Math.abs(variance) >= 20000 ? 'rgba(245,158,11,0.08)' : 'rgb(135 197 64 / 0.08)', color: Math.abs(variance) >= 20000 ? '#a15c00' : 'var(--erp-primary)', border: `1px solid ${Math.abs(variance) >= 20000 ? 'rgba(245,158,11,0.3)' : 'rgb(135 197 64 / 0.3)'}` }}>
        Variance: {variance > 0 ? '+' : ''}PKR {(variance / 100).toLocaleString()}
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
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">{title}</h2>
        <button onClick={onClose} className="text-white/40 text-xl">✕</button>
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
function ErrorBanner({ error }: { error: unknown }) { const msg = error instanceof Error ? error.message : 'Failed'; return <div className="rounded-xl px-4 py-3 text-sm text-red-700" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{msg}</div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
const primaryBtn = "rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
