'use client'
// Bank accounts are the bank DETAILS of a chart-of-accounts code: the ledger
// holds the balance. Each account links to its code (1020 for the first bank,
// a new 102x child for each further one, or an asset account you pick), and
// deposits and bank-statement imports use that code.
//
// Raast QR (spec §7.5) is set up HERE and nowhere else: each account may carry
// its Raast ID (the alias the till shows the customer), one account is the
// company's DEFAULT Raast receiving account, and a brand may take its own
// account ("Raast by brand"). A Raast payment debits the receiving account's
// ledger code, so it must be linked to an active chart code. One physical
// account receives Raast for ONE company only (S4: 409 RAAST_ACCOUNT_SHARED —
// otherwise both companies would book the same transfer).
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError, deleteWithUndo } from '../../../lib/api'
import { Select } from '@/components/ui/Select'
import { NavIcon } from '../../../components/ui/NavIcon'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'

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
  tenantId?: string | null
  /** The Raast ID / alias shown at the till (absent on an API without Raast). */
  raastId?: string | null
  /** The company's default Raast receiving account. */
  raastDefault?: boolean
}

// GET /setup/raast-accounts — the active company's Raast set-up (backend connectors/raast/accounts.ts).
interface RaastAccount { bankAccountId: string; ledgerCode: string; bankName: string | null; accountTitle: string | null; raastId: string | null; last4: string | null }
interface RaastAccountsView {
  default: RaastAccount | null
  brands: Array<{ conceptId: string; name: string; overrideBankAccountId: string | null; effective: RaastAccount | null }>
  accounts: Array<RaastAccount & { name: string; isDefault: boolean }>
}

/** A Raast set-up refusal in plain words (S4's shared-account rule first). */
function raastSetupError(e: unknown): { title: string; text: string } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'RAAST_ACCOUNT_SHARED':
        return {
          title: 'This bank account already receives Raast for another company',
          text: 'One bank account can receive Raast QR payments for one company only — otherwise both companies would import the same statement and book the same transfer twice. Use a different account for this company, or ask the CEO to move Raast off the other company first.',
        }
      case 'BANK_ACCOUNT_NOT_LINKED':
        return { title: 'Link the account to a ledger code first', text: e.message || 'Every Raast payment debits the receiving account’s ledger code — set an active chart code on the account, then try again.' }
      case 'BANK_ACCOUNT_INACTIVE':
        return { title: 'The account is not active', text: e.message || 'An inactive bank account cannot receive Raast payments.' }
      case 'BANK_ACCOUNT_NOT_IN_COMPANY':
        return { title: 'Not this company’s account', text: e.message || 'Pick an active bank account of this company.' }
      case 'NO_COMPANY':
        return { title: 'The account has no company', text: e.message || 'This bank account belongs to no company, so it cannot receive Raast payments.' }
    }
    return { title: 'Not saved', text: e.message || e.code }
  }
  return { title: 'Not saved', text: e instanceof Error ? e.message : 'Something went wrong' }
}

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const { title, text } = raastSetupError(error)
  return (
    <div role="alert" className="rounded-xl border border-s-red/40 bg-s-red/10 p-3">
      <p className="text-sm font-bold text-s-red">{title}</p>
      <p className="text-xs text-white/70 mt-1">{text}</p>
    </div>
  )
}

const acctLabel = (a: { name?: string; bankName: string | null; last4: string | null; raastId?: string | null }) =>
  [a.name ?? a.bankName ?? 'Account', a.last4 ? `••${a.last4}` : null, a.raastId ? `Raast ${a.raastId}` : null].filter(Boolean).join(' · ')

export default function BankAccountsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Bank | null>(null)
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Bank[]>({ queryKey: ['bank-accounts'], queryFn: () => api.get('/setup/bank-accounts') })
  const del = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/setup/bank-accounts/${id}`, { trashType: 'bank_account', id, onRestored: () => { void qc.invalidateQueries({ queryKey: ['bank-accounts'] }); void qc.invalidateQueries({ queryKey: ['raast-accounts'] }) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bank-accounts'] }); void qc.invalidateQueries({ queryKey: ['raast-accounts'] }) },
  })
  // The company default Raast account: set (unsets the company's other default) or clear.
  const setDefault = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.patch(`/setup/bank-accounts/${id}`, { raastDefault: on }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bank-accounts'] }); void qc.invalidateQueries({ queryKey: ['raast-accounts'] }) },
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Bank accounts</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Bank details for each ledger bank account. The balance is the ledger's — deposits post to the linked code and statements reconcile against it.
              Raast QR payments land in the company&rsquo;s default Raast account, or a brand&rsquo;s own.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ Add account</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        <ErrorBox error={setDefault.error} />
        {data.length === 0 && (
          <CompactEmptyState message="No bank accounts yet" detail="Add your operating accounts to enable reconciliation reports." />
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
                {b.raastDefault !== undefined && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {b.raastDefault && <span className="s-badge-green text-[10px] font-bold">Default Raast account</span>}
                    {b.raastId ? <span className="text-white/55">Raast ID <span className="font-mono">{b.raastId}</span></span> : <span className="text-white/30">No Raast ID</span>}
                    {b.isActive && (
                      <label className="inline-flex items-center gap-1.5 text-white/55 cursor-pointer">
                        <input type="radio" className="accent-primary" name={`raast-default-${b.tenantId ?? 'none'}`}
                          checked={!!b.raastDefault} disabled={setDefault.isPending || !b.accountCode}
                          onChange={() => { if (!b.raastDefault) setDefault.mutate({ id: b.id, on: true }) }} />
                        Company default Raast account
                      </label>
                    )}
                    {b.raastDefault && (
                      <button onClick={() => { if (confirm(`Stop receiving Raast QR on "${b.name}" by default? Brands without their own Raast account will not be able to take Raast until another default is set.`)) setDefault.mutate({ id: b.id, on: false }) }}
                        disabled={setDefault.isPending} className="text-white/40 underline hover:text-white/70">Clear default</button>
                    )}
                    {!b.accountCode && <span className="text-white/30">(link a ledger code to receive Raast)</span>}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button onClick={() => setEditing(b)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                <button onClick={() => { if (confirm(`Archive "${b.name}"?`)) del.mutate(b.id) }} className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs">Archive</button>
              </div>
            </div>
          </div>
        ))}

        {data.length > 0 && <RaastByBrand />}
      </div>

      {(adding || editing) && (
        <Modal account={editing} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['bank-accounts'] }); void qc.invalidateQueries({ queryKey: ['raast-accounts'] }) }} />
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
  const [repointReason, setRepointReason] = useState('')
  const [raastId, setRaastId] = useState(account?.raastId ?? '')
  const [raastDefault, setRaastDefault] = useState(!!account?.raastDefault)
  // Set when the account was created but its Raast details were refused (the account itself stays).
  const [createdId, setCreatedId] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name: name.trim(), bankName: bankName || null, accountTitle: accountTitle || null, accountNumber: accountNumber || null, iban: iban || null, branchCode: branchCode || null, notes: notes || null }
      const code = accountCode.trim()
      const raast = {
        ...((raastId.trim() || null) !== (account?.raastId ?? null) && { raastId: raastId.trim() || null }),
        ...(raastDefault !== !!account?.raastDefault && { raastDefault }),
      }
      if (account) {
        const repoint = !!code && code !== account.accountCode
        return api.patch(`/setup/bank-accounts/${account.id}`, {
          ...payload, ...(repoint && { accountCode: code }), ...(repoint && repointReason.trim().length >= 10 && { repointReason: repointReason.trim() }), ...raast,
        })
      }
      // A new account: created first (the Raast fields are set on the saved row).
      const id = createdId ?? (await api.post<{ id: string }>('/setup/bank-accounts', { ...payload, currency, ...(code && { accountCode: code }) })).id
      setCreatedId(id)
      if (Object.keys(raast).length > 0) await api.patch(`/setup/bank-accounts/${id}`, raast)
      return null
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
          <button onClick={onClose} className="text-white/40 text-xl"><NavIcon name="x" size={16} /></button>
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
            <p className="text-[10px] text-white/30 mt-1">A bank code in this company&apos;s chart (1020–1029, or another 10xx bank account) that no other bank uses. Never cash, petty cash, the till, card or customer receivables. Its ledger balance is this bank&apos;s balance.</p>
          </Field>
          {account && accountCode.trim() && accountCode.trim() !== (account.accountCode ?? '') && (
            <Field label="Why re-point it? (only the CEO, when the old code still holds money)">
              <input value={repointReason} onChange={(e) => setRepointReason(e.target.value)} maxLength={500} placeholder="At least 10 characters" className={fieldCls} />
              <p className="text-[10px] text-white/30 mt-1">While the old code still holds this bank&apos;s balance or open statement lines, the change is refused unless the CEO gives a reason. Move the balance with a journal first where you can.</p>
            </Field>
          )}
          <div className="rounded-xl p-3 space-y-3" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <p className="text-xs font-bold text-white/70">Raast QR</p>
            <Field label="Raast ID / alias">
              <input value={raastId} onChange={(e) => setRaastId(e.target.value)} maxLength={40} placeholder="e.g. the registered mobile number or alias" className={fieldCls + ' font-mono'} />
              <p className="text-[10px] text-white/30 mt-1">Shown at the till so the cashier can check the customer is paying the right account.</p>
            </Field>
            <label className="flex items-start gap-2 text-xs text-white/70">
              <input type="checkbox" className="mt-0.5 accent-primary" checked={raastDefault} onChange={(e) => setRaastDefault(e.target.checked)} />
              <span>
                Company default Raast account
                <span className="block text-[10px] text-white/30">Raast QR payments of every brand without its own account land here. Needs a ledger code. One per company; one company per physical account.</span>
              </span>
            </label>
          </div>
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
          {createdId && save.isError && (
            <p className="text-xs text-white/55">The account was added; its Raast details were not saved — fix them and save again.</p>
          )}
          <ErrorBox error={save.error} />
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : account || createdId ? 'Save changes' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Raast by brand ──────────────────────────────────────────────────────────
// The active company's brands and the account each one's Raast payments land
// in: its own (an override), else the company default. Saved with
// PUT /setup/raast-accounts (only the brands changed).

function RaastByBrand() {
  const qc = useQueryClient()
  const view = useQuery<RaastAccountsView>({
    queryKey: ['raast-accounts'],
    queryFn: () => api.get<RaastAccountsView>('/setup/raast-accounts'),
    retry: false,
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  useEffect(() => { setDraft({}) }, [view.data])
  const changed = useMemo(() => {
    const brands = view.data?.brands ?? []
    return brands.filter((b) => b.conceptId in draft && (draft[b.conceptId] || null) !== b.overrideBankAccountId)
  }, [draft, view.data])
  const save = useMutation({
    mutationFn: () => api.put<RaastAccountsView>('/setup/raast-accounts', {
      brands: changed.map((b) => ({ conceptId: b.conceptId, bankAccountId: draft[b.conceptId] || null })),
    }),
    onSuccess: (v) => { qc.setQueryData(['raast-accounts'], v); setDraft({}) },
  })

  if (view.isError) {
    const e = view.error
    // An API without Raast, or no active company picked (portfolio view): say so quietly.
    return (
      <div className="rounded-2xl p-5 mt-4" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
        <h2 className="font-black text-white/85">Raast by brand</h2>
        <p className="text-xs text-white/40 mt-1">{e instanceof ApiError && e.status === 404 ? 'Raast QR is not available on this server yet.' : 'Pick one company (not all companies) to set its brands’ Raast accounts.'}</p>
      </div>
    )
  }
  const v = view.data
  if (!v) return null
  return (
    <div className="rounded-2xl p-5 mt-4 space-y-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div>
        <h2 className="font-black text-white/90">Raast by brand</h2>
        <p className="text-xs text-white/40 mt-1 max-w-2xl">
          Where each brand&rsquo;s Raast QR payments land. A brand without its own account uses the company default
          {v.default ? <> (<span className="text-white/70">{acctLabel({ bankName: v.default.bankName, last4: v.default.last4, raastId: v.default.raastId, name: v.accounts.find((a) => a.bankAccountId === v.default!.bankAccountId)?.name })}</span>)</> : null}.
          Only accounts linked to an active ledger code are offered.
        </p>
      </div>
      {!v.default && (
        <p className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-xs text-white/75">
          No default Raast account: tills cannot take Raast QR for a brand without its own account. Tick &ldquo;Company default Raast account&rdquo; on one account above.
        </p>
      )}
      {v.brands.length === 0 ? (
        <p className="text-xs text-white/40">This company has no brands.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-white/40">
              <tr>
                <th className="py-2 text-left">Brand</th>
                <th className="py-2 text-left">Receiving account</th>
                <th className="py-2 text-left">Payments land in</th>
              </tr>
            </thead>
            <tbody>
              {v.brands.map((b) => {
                const value = b.conceptId in draft ? draft[b.conceptId]! : (b.overrideBankAccountId ?? '')
                const overrideUnusable = !!b.overrideBankAccountId && !v.accounts.some((a) => a.bankAccountId === b.overrideBankAccountId)
                return (
                  <tr key={b.conceptId} className="border-t border-white/[0.06] align-top">
                    <td className="py-2 pr-3 font-semibold text-white/85">{b.name}</td>
                    <td className="py-2 pr-3">
                      <Select value={value} onChange={(e) => setDraft((d) => ({ ...d, [b.conceptId]: e.target.value }))}
                        className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-2 py-1.5 text-sm text-white/85">
                        <option value="">Company default</option>
                        {v.accounts.map((a) => <option key={a.bankAccountId} value={a.bankAccountId}>{acctLabel(a)}</option>)}
                        {overrideUnusable && value === b.overrideBankAccountId && <option value={b.overrideBankAccountId!}>(an account that can no longer receive Raast)</option>}
                      </Select>
                      {overrideUnusable && <p className="text-[10px] text-s-amber mt-1">Its own account is archived, inactive or unlinked — payments fall back to the company default.</p>}
                    </td>
                    <td className="py-2 text-xs">
                      {b.effective
                        ? <span className="text-white/70">{acctLabel({ bankName: b.effective.bankName, last4: b.effective.last4, raastId: b.effective.raastId, name: v.accounts.find((a) => a.bankAccountId === b.effective!.bankAccountId)?.name })} <span className="font-mono text-white/35">({b.effective.ledgerCode})</span></span>
                        : <span className="text-s-red">Not set up — the till cannot take Raast for this brand</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="flex items-center gap-3">
        <button onClick={() => save.mutate()} disabled={save.isPending || changed.length === 0}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-40">
          {save.isPending ? 'Saving…' : `Save brand accounts${changed.length ? ` (${changed.length})` : ''}`}
        </button>
        {changed.length > 0 && <button onClick={() => setDraft({})} className="text-xs text-white/45 hover:text-white/70">Discard</button>}
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
