'use client'
// Bank accounts are the bank DETAILS of a chart-of-accounts code: the ledger
// holds the balance. Each account links to its code (1020 for the first bank,
// a new 102x child for each further one, or an asset account you pick), and
// deposits and bank-statement imports use that code.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Bank {
  id: string
  name: string
  bankName: string | null
  accountTitle: string | null
  accountNumber: string | null
  iban: string | null
  branchCode: string | null
  swiftCode: string | null
  currency: string
  accountCode: string | null
  ledgerBalanceCents: number | null
  openingBalanceCents: number
  isActive: boolean
  notes: string | null
}

export default function BankAccountsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Bank | null>(null)
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Bank[]>({ queryKey: ['bank-accounts'], queryFn: () => api.get('/setup/bank-accounts') })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/setup/bank-accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bank-accounts'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🏦 Bank accounts</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Bank details for each ledger bank account. The balance is the ledger's — deposits post to the linked code and statements reconcile against it.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ Add account</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        {data.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No bank accounts yet</p>
            <p className="text-sm text-white/45 mt-1">Add your operating accounts to enable reconciliation reports.</p>
          </div>
        )}
        {data.map((b) => (
          <div key={b.id} className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-black text-white/90">{b.name}</h3>
                  {b.bankName && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--ink-rgb) / 0.12)', color: 'var(--erp-primary-ink)' }}>{b.bankName}</span>}
                  <span className="text-[10px] text-white/40 font-mono">{b.currency}</span>
                </div>
                {b.accountTitle && <p className="text-sm text-white/65 mt-0.5">{b.accountTitle}</p>}
                <div className="text-xs text-white/40 mt-1 flex flex-wrap gap-x-4">
                  {b.iban && <span className="font-mono">IBAN: {b.iban}</span>}
                  {b.accountNumber && <span className="font-mono">A/C: {b.accountNumber}</span>}
                </div>
                <p className="text-xs text-white/55 mt-1">
                  Ledger {b.accountCode ?? '—'}
                  {b.ledgerBalanceCents !== null && <> · balance PKR {(b.ledgerBalanceCents / 100).toLocaleString()}</>}
                </p>
                {b.openingBalanceCents !== 0 && (
                  <p className="text-xs text-white/30 mt-0.5">Opening balance recorded at setup: PKR {(b.openingBalanceCents / 100).toLocaleString()} (not in the ledger — post it as a journal entry)</p>
                )}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button onClick={() => setEditing(b)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                <button onClick={() => { if (confirm(`Archive "${b.name}"?`)) del.mutate(b.id) }} className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs">Archive</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {(adding || editing) && (
        <Modal account={editing} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['bank-accounts'] }) }} />
      )}
    </div>
  )
}

function Modal({ account, onClose, onSaved }: { account: Bank | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(account?.name ?? '')
  const [bankName, setBankName] = useState(account?.bankName ?? '')
  const [accountTitle, setAccountTitle] = useState(account?.accountTitle ?? '')
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '')
  const [iban, setIban] = useState(account?.iban ?? '')
  const [branchCode, setBranchCode] = useState(account?.branchCode ?? '')
  const [currency, setCurrency] = useState(account?.currency ?? 'PKR')
  const [accountCode, setAccountCode] = useState(account?.accountCode ?? '')
  const [notes, setNotes] = useState(account?.notes ?? '')

  const save = useMutation({
    mutationFn: () => {
      const payload = { name: name.trim(), bankName: bankName || null, accountTitle: accountTitle || null, accountNumber: accountNumber || null, iban: iban || null, branchCode: branchCode || null, notes: notes || null }
      const code = accountCode.trim()
      if (account) return api.patch(`/setup/bank-accounts/${account.id}`, { ...payload, ...(code && code !== account.accountCode && { accountCode: code }) })
      return api.post('/setup/bank-accounts', { ...payload, currency, ...(code && { accountCode: code }) })
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{account ? 'Edit account' : 'Add bank account'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <Field label="Display name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="HBL Operations" className={fieldCls} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bank"><input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="HBL" className={fieldCls} /></Field>
            <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className={fieldCls} /></Field>
          </div>
          <Field label="Account title"><input value={accountTitle} onChange={(e) => setAccountTitle(e.target.value)} placeholder="Mubarak Foods (Pvt) Ltd" className={fieldCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account number"><input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className={fieldCls} /></Field>
            <Field label="Branch code"><input value={branchCode} onChange={(e) => setBranchCode(e.target.value)} className={fieldCls} /></Field>
          </div>
          <Field label="IBAN"><input value={iban} onChange={(e) => setIban(e.target.value.toUpperCase())} placeholder="PK36SCBL0000001123456702" className={fieldCls} /></Field>
          <Field label="Ledger account code">
            <input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder={account ? '' : 'Leave blank — 1020, or a new 102x for a further bank'} className={fieldCls + ' font-mono'} />
            <p className="text-[10px] text-white/30 mt-1">An asset account in this company's chart of accounts. Its ledger balance is this bank's balance.</p>
          </Field>
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : account ? 'Save changes' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
