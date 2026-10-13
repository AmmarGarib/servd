'use client'
// Deposit drops — record cash taken to the bank. Expected from a shift = its
// drops to the safe + its counted close − the float kept in the drawer; a
// variance beyond the company's cash tolerance auto-flags. The drop posts to
// the picked bank's ledger code so the bank statement can match it. Photo of
// teller receipt strongly recommended (auto-flagged when missing for drops >
// PKR 1,000). Amounts are typed in rupees; the bank is the one picker
// (BankAccountSelect), showing only the active company's banks — the drop
// belongs to the active company and its shift must be one of that company's.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { useActiveCompany } from '../../../lib/connectorsApi'

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
  withinTolerance: boolean
}
interface RecentShift { shiftId: string; cashier: string; openedAt: string; closedAt: string | null; status: string }

export default function DepositDropsPage() {
  const qc = useQueryClient()
  const { data: drops = [] } = useQuery<Drop[]>({ queryKey: ['deposit-drops'], queryFn: () => api.get('/trustops/deposit-drops'), refetchInterval: 30_000 })
  const [adding, setAdding] = useState(false)
  const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-black text-white/90">Bank deposit drops</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Record every cash drop to the bank. It posts to the bank's ledger account, and a variance against the shift (drops + counted close − float kept) auto-flags. Snap a teller-receipt photo to make the drop reconcilable on the bank statement.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ Record drop</button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-2">
        {drops.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No drops recorded</p>
            <p className="text-sm text-white/45 mt-1">Drop cash at the bank? Record it here so we can reconcile.</p>
          </div>
        )}
        {drops.map((d) => (
          <div key={d.id} className="rounded-2xl p-5"
            style={{
              background: 'rgb(var(--fg-rgb) / 0.025)',
              border: `1px solid ${!d.withinTolerance ? 'color-mix(in srgb, var(--erp-warning) 30%, transparent)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
            }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-black text-white/90">{pkr(d.amountCents)}</span>
                  {d.expectedCents > 0 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={d.withinTolerance
                        ? { background: 'rgb(var(--erp-accent-rgb) / 0.15)', color: 'var(--erp-success)' }
                        : { background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', color: 'var(--erp-warning)' }}>
                      {d.varianceCents >= 0 ? '+' : ''}{pkr(d.varianceCents)}
                    </span>
                  )}
                  {!d.receiptUrl && d.amountCents >= 100000 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--erp-warning)' }}>No receipt</span>
                  )}
                </div>
                <p className="text-xs text-white/45 mt-1">
                  Expected from shift (drops + count − float): {pkr(d.expectedCents)} · {new Date(d.droppedAt).toLocaleString()}
                </p>
                {d.bagSerial && <p className="text-xs text-white/55 font-mono mt-1">Bag: {d.bagSerial}</p>}
                {d.notes && <p className="text-xs text-white/55 mt-1">{d.notes}</p>}
              </div>
              {d.receiptUrl && <a href={d.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary-ink hover:underline">View receipt ↗</a>}
            </div>
          </div>
        ))}
      </div>

      {adding && <DropModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['deposit-drops'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function DropModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // The drop binds to the active company; its banks are the only ones offered.
  const company = useActiveCompany()
  // Recent drawers to deposit from, so nobody types a shift UUID by hand.
  const { data: recent } = useQuery<{ shifts: RecentShift[] }>({
    queryKey: ['deposit-drop-shifts'],
    queryFn: () => api.get('/reconciliation/summary'),
    retry: false,
  })
  const shifts = recent?.shifts ?? []
  const [shiftId, setShiftId] = useState('')
  const [amountCents, setAmountCents] = useState(0)
  const [bankAccountId, setBankAccountId] = useState('')
  const [bagSerial, setBagSerial] = useState('')
  const [receiptUrl, setReceiptUrl] = useState('')
  const [notes, setNotes] = useState('')
  // Saved but the ledger refused the posting (e.g. a closed period): the drop
  // stands and finance is flagged to re-post it — say so before closing.
  const [notBooked, setNotBooked] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => api.post<{ posted?: boolean; postingError?: string | null }>('/trustops/deposit-drops', {
      shiftId: shiftId || null,
      bankAccountId: bankAccountId || null,
      amountCents,
      bagSerial: bagSerial || null,
      receiptUrl: receiptUrl || null,
      notes: notes || null,
    }),
    onSuccess: (r) => { if (r?.postingError) setNotBooked(r.postingError); else onSaved() },
  })

  const close = notBooked ? onSaved : onClose
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={close}>
    <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">Record bank deposit</h2>
        <button onClick={close} aria-label="Close" className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
        <Field label="Shift (optional — for the variance check)">
          {shifts.length > 0 ? (
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className={fieldCls}>
              <option value="">— not from one shift —</option>
              {shifts.map((s) => (
                <option key={s.shiftId} value={s.shiftId}>
                  {s.cashier} · {new Date(s.openedAt).toLocaleString()}{s.status === 'open' ? ' (open)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input value={shiftId} onChange={(e) => setShiftId(e.target.value)} placeholder="Shift UUID — leave blank to skip the variance check" className={fieldCls} />
          )}
        </Field>
        <Field label="Amount counted at drop (PKR) *">
          <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
        </Field>
        <BankAccountSelect tenantId={company?.id} value={bankAccountId} onChange={setBankAccountId} id="deposit-bank" label="Bank account" className={fieldCls} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Tamper-bag serial"><input value={bagSerial} onChange={(e) => setBagSerial(e.target.value)} className={fieldCls + ' font-mono'} /></Field>
          <Field label="Receipt photo URL"><input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="https://…" className={fieldCls} /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        {save.error && <div className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>{(save.error as Error).message}</div>}
        {notBooked && (
          <div role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
            The drop is saved, but it is not in the books yet ({notBooked}). Finance has been flagged to post it.
          </div>
        )}
      </div>
      <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
        {notBooked ? (
          <button onClick={onSaved} className="ml-auto rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90">Done</button>
        ) : (
          <>
            <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Record drop'}</button>
          </>
        )}
      </div>
    </div>
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
