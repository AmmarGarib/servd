'use client'
// Deposit drops — record cash dropped at the bank. Variance vs shift cash sales
// auto-flags. Photo of teller receipt strongly recommended (auto-flagged
// when missing for drops > PKR 1,000).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Drop {
  id: string
  shiftId: string | null
  amountCents: number
  expectedCents: number
  varianceCents: number
  bagSerial: string | null
  receiptUrl: string | null
  droppedById: string
  droppedAt: string
  notes: string | null
}
interface BankAccount { id: string; name: string }

export default function DepositDropsPage() {
  const qc = useQueryClient()
  const { data: drops = [] } = useQuery<Drop[]>({ queryKey: ['deposit-drops'], queryFn: () => api.get('/trustops/deposit-drops'), refetchInterval: 30_000 })
  const { data: banks = [] } = useQuery<BankAccount[]>({ queryKey: ['bank-accounts'], queryFn: () => api.get('/setup/bank-accounts') })
  const [adding, setAdding] = useState(false)

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🏦 Bank deposit drops</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Record every cash drop to the bank. Variance vs shift cash sales auto-flags. Snap a teller-receipt photo to make the drop reconcilable on the bank statement.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ Record drop</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-2">
        {drops.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No drops recorded</p>
            <p className="text-sm text-white/45 mt-1">Drop cash at the bank? Record it here so we can reconcile.</p>
          </div>
        )}
        {drops.map((d) => (
          <div key={d.id} className="rounded-2xl p-5"
            style={{
              background: 'rgba(255,255,255,0.025)',
              border: `1px solid ${Math.abs(d.varianceCents) >= 20000 ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.06)'}`,
            }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-black text-white/90">PKR {(d.amountCents / 100).toLocaleString()}</span>
                  {d.expectedCents > 0 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={Math.abs(d.varianceCents) < 20000
                        ? { background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }
                        : { background: 'rgba(245,158,11,0.12)', color: '#FCD34D' }}>
                      {d.varianceCents >= 0 ? '+' : ''}PKR {(d.varianceCents / 100).toLocaleString()}
                    </span>
                  )}
                  {!d.receiptUrl && d.amountCents >= 100000 && (
                    <span className="text-[10px] font-bold text-amber-400">⚠ NO RECEIPT</span>
                  )}
                </div>
                <p className="text-xs text-white/45 mt-1">
                  Expected from shift: PKR {(d.expectedCents / 100).toLocaleString()} · {new Date(d.droppedAt).toLocaleString()}
                </p>
                {d.bagSerial && <p className="text-xs text-white/55 font-mono mt-1">Bag: {d.bagSerial}</p>}
                {d.notes && <p className="text-xs text-white/55 mt-1">{d.notes}</p>}
              </div>
              {d.receiptUrl && <a href={d.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-kds-green hover:underline">View receipt ↗</a>}
            </div>
          </div>
        ))}
      </div>

      {adding && <DropModal banks={banks} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['deposit-drops'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function DropModal({ banks, onClose, onSaved }: { banks: BankAccount[]; onClose: () => void; onSaved: () => void }) {
  const [shiftId, setShiftId] = useState('')
  const [amountCents, setAmountCents] = useState(0)
  const [bankAccountId, setBankAccountId] = useState('')
  const [bagSerial, setBagSerial] = useState('')
  const [receiptUrl, setReceiptUrl] = useState('')
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () => api.post('/trustops/deposit-drops', {
      shiftId: shiftId || null,
      bankAccountId: bankAccountId || null,
      amountCents,
      bagSerial: bagSerial || null,
      receiptUrl: receiptUrl || null,
      notes: notes || null,
    }),
    onSuccess: () => onSaved(),
  })

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">Record bank deposit</h2>
        <button onClick={onClose} className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-3">
        <Field label="Shift ID (optional — for variance match)">
          <input value={shiftId} onChange={(e) => setShiftId(e.target.value)} placeholder="UUID — leave blank to skip variance check" className={fieldCls} />
        </Field>
        <Field label="Amount counted at drop (paisa) *">
          <input type="number" value={amountCents} onChange={(e) => setAmountCents(parseInt(e.target.value) || 0)} className={fieldCls} autoFocus />
          <p className="text-[10px] text-white/30 mt-1">≈ PKR {(amountCents / 100).toLocaleString()}</p>
        </Field>
        <Field label="Bank account">
          <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={fieldCls}>
            <option value="">— pick account —</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tamper-bag serial"><input value={bagSerial} onChange={(e) => setBagSerial(e.target.value)} className={fieldCls + ' font-mono'} /></Field>
          <Field label="Receipt photo URL"><input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="https://…" className={fieldCls} /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        {save.error && <div className="rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{(save.error as Error).message}</div>}
      </div>
      <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
        <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0} className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Record drop'}</button>
      </div>
    </div>
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
