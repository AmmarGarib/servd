'use client'
// Journal entry — the screen for the ONE manual-entry writer
// (POST /accounting/journal) and its reversal
// (POST /accounting/journal/:id/reverse). Opening balances (bank, cash,
// inventory, capital), month-end accruals and corrections are booked here.
//
//   • Balanced lines only: the Post button stays off until debits equal
//     credits, and the server checks again (postJournalEntry).
//   • Period lock: an entry dated in a closed period is refused by the server;
//     its message ("books are closed through …") is shown as-is.
//   • Direct posting is CEO only, like the API — every manual entry and every
//     reversal lands in the Exceptions inbox and on the accounting audit trail.
//   • Everyone else who prepares journals (owner, management, finance) uses
//     "Send for approval": a draft / submitted / returned / posted REQUEST
//     (modules/accounting/journalRequests.ts) that the CEO approves. Their
//     "My requests" tab lists them with edit, send and withdraw; the CEO has a
//     Requests tab to approve or return.
//   • A wrong entry is undone by a reversing entry (every line flipped), never
//     deleted. Each manual entry can be reversed once.
import { Button, Field, Input, LinkButton } from '@/components/finance/ui'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { useMyTenants } from '../../../components/ui/TenantPicker'
import { Select } from '@/components/ui/Select'
import { dateBounds } from '../../finance/cash-vouchers/ui'
import { JournalRequests, type JournalRequest } from './JournalRequests'
import { RecordFiles } from '@/components/files/RecordFiles'
import { PendingFilesPicker } from '@/components/files/PendingFilesPicker'
import {
  EMPTY_PAYMENT_CLASSIFICATION, PaymentClassificationFields, paymentClassificationBody, paymentClassificationError,
  type PaymentClassificationValue,
} from '@/components/finance/PaymentClassificationFields'
import { uploadRecordFiles, type PickedFile } from '@/components/files/recordFiles'

interface Account { id: string; tenantId: string | null; code: string; name: string; type: string; isActive: boolean }
interface Brand { id: string; name: string; tenantId: string | null }
interface CurrentLock { tenantId?: string | null; lockedThrough: string | null; reopenedThrough?: string | null }
interface LedgerLine { id: string; accountId?: string; conceptId?: string | null; type: 'debit' | 'credit'; amountCents: number; memo: string | null; account: { code: string; name: string } }
interface LedgerEntry {
  id: string
  tenantId: string | null
  reference: string | null
  description: string
  entryDate: string
  /** Automatic voucher number (JV-00001…), stamped when posted. */
  voucherNo?: string | null
  lines: LedgerLine[]
  reversedBy: { id: string; entryDate: string } | null
}
interface LedgerPage { data: LedgerEntry[]; hasMore: boolean }

interface DraftLine { key: number; accountId: string; debit: string; credit: string; memo: string; conceptId: string }

const PKT_OFFSET_MS = 5 * 3600_000
const pktDate = (iso: string) => new Date(new Date(iso).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10)
const daysAgoPkt = (n: number) => new Date(Date.now() + PKT_OFFSET_MS - n * 86400_000).toISOString().slice(0, 10)

/** "1,234.5" → 123450 paisa; null when not a positive amount with at most 2 decimals. Empty → 0. */
function toPaisa(input: string): number | null {
  const s = input.replace(/,/g, '').trim()
  if (s === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [rupees, paisa = ''] = s.split('.')
  return Number(rupees) * 100 + Number(paisa.padEnd(2, '0'))
}

/** A date picked on the form → the instant sent to the API (noon PKT, so it can't slip a day). Today → omitted (posted now). */
function entryInstant(date: string): string | undefined {
  if (date === todayPktIso()) return undefined
  return new Date(`${date}T12:00:00+05:00`).toISOString()
}

let lineSeq = 0
const blankLine = (): DraftLine => ({ key: ++lineSeq, accountId: '', debit: '', credit: '', memo: '', conceptId: '' })

const inputCls = 's-input py-1.5'

type PageTab = 'entry' | 'requests'
const PREPARER_ROLES = ['admin', 'owner', 'management', 'finance']

export default function JournalEntryPage() {
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const canPrepare = useAuthStore((s) => s.isRole(...PREPARER_ROLES))
  // Posts, edits and cancels manual entries directly — the CEO and finance
  // (owner, 2026-10-16: no CEO approval to book a journal).
  const canPost = useAuthStore((s) => s.isRole('admin', 'finance'))
  /** A posted manual entry being edited: posting reverses it and books the corrected one. */
  const [amending, setAmending] = useState<LedgerEntry | null>(null)
  const [amendReason, setAmendReason] = useState('')
  // Supporting documents (owner, 2026-10-20): uploaded to the posted entry once it exists.
  const [files, setFiles] = useState<PickedFile[]>([])
  // Official / Unofficial (owner, 2026-10-20): asked when the entry pays money out (a credit to cash or a bank).
  const [cls, setCls] = useState<PaymentClassificationValue>(EMPTY_PAYMENT_CLASSIFICATION)
  const [tab, setTab] = useState<PageTab>('entry')
  /** The request being edited in the form (a draft or returned one of mine). */
  const [editing, setEditing] = useState<JournalRequest | null>(null)
  const [reqRefresh, setReqRefresh] = useState(0)
  const { data: myTenants = [] } = useMyTenants()

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
  })
  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ['concepts', isAdmin ? 'all' : 'picker'],
    queryFn: () => api.get(isAdmin ? '/concepts' : '/concepts?view=picker'),
    enabled: canPrepare,
  })
  const { data: lock } = useQuery<CurrentLock>({
    queryKey: ['period-close'],
    queryFn: () => api.get('/accounting/period-close'),
  })

  // The chart in view may span companies ("All companies"); an entry is
  // posted into ONE company's books, against that company's accounts.
  const companyIds = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.tenantId).filter((t): t is string => !!t))),
    [accounts],
  )
  const companyName = (id: string | null) => myTenants.find((t) => t.id === id)?.name ?? 'Company'
  const [pickedCompany, setPickedCompany] = useState('')
  const company = companyIds.length === 1 ? companyIds[0]! : pickedCompany

  const companyAccounts = useMemo(
    () => accounts.filter((a) => a.isActive && a.tenantId === company).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts, company],
  )
  const companyBrands = useMemo(() => brands.filter((b) => !b.tenantId || b.tenantId === company), [brands, company])

  const [date, setDate] = useState(todayPktIso())
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(), blankLine()])
  const [result, setResult] = useState<{ ok: boolean; msg: string; entryId?: string } | null>(null)

  function patchLine(key: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  // Live validation and totals.
  const parsed = lines.map((l) => {
    const debit = toPaisa(l.debit)
    const credit = toPaisa(l.credit)
    let error: string | null = null
    if (debit === null || credit === null) error = 'Amount: digits, up to 2 decimals'
    else if (debit > 0 && credit > 0) error = 'Debit or credit, not both'
    else if (debit === 0 && credit === 0) error = l.accountId ? 'Enter a debit or a credit' : null
    else if (!l.accountId) error = 'Pick an account'
    return { line: l, debit: debit ?? 0, credit: credit ?? 0, error, filled: !!l.accountId || (debit ?? 0) > 0 || (credit ?? 0) > 0 }
  })
  const used = parsed.filter((p) => p.filled)
  const debitTotal = used.reduce((s, p) => s + p.debit, 0)
  const creditTotal = used.reduce((s, p) => s + p.credit, 0)
  const difference = debitTotal - creditTotal
  const lockedThrough = lock?.lockedThrough ? pktDate(lock.lockedThrough) : null
  const dateLocked = !!lockedThrough && companyIds.length === 1 && date <= lockedThrough
  // A month the CEO reopened: only the CEO posts there (closedBooks.ts).
  const reopenedThrough = lock?.reopenedThrough ? pktDate(lock.reopenedThrough) : null
  const dateReopened = !dateLocked && !!reopenedThrough && companyIds.length === 1 && date <= reopenedThrough
  // The latest closed-or-reopened day of the active company: an entry dated
  // on or before it is the CEO's to edit or cancel.
  const closedBooksThrough = [lockedThrough, reopenedThrough].filter((d): d is string => !!d).sort().pop() ?? null

  // A credit to a money account (cash 1010 / 1011, banks 10xx) = a payment: the register asks how it is classified.
  // The server decides for good (paymentsRegister.ts) — a transfer between money accounts is not a payment there.
  const codeOfAccount = (id: string) => accounts.find((a) => a.id === id)?.code ?? ''
  const isMoneyCode = (c: string) => /^10\d\d$/.test(c) && c !== '1015' && c !== '1030'
  const paysOut = !editing && used.some((p) => p.credit > 0 && isMoneyCode(codeOfAccount(p.line.accountId)))
    && !used.every((p) => isMoneyCode(codeOfAccount(p.line.accountId)))
  const clsError = paysOut && !(amending && !cls.classification) ? paymentClassificationError(cls) : null

  const blockers: string[] = []
  if (!company) blockers.push('Pick the company whose books this is')
  if (!description.trim()) blockers.push('Add a description')
  if (amending && amendReason.trim().length < 5) blockers.push('Say why you are editing it (5+ characters)')
  if (used.length < 2) blockers.push('At least two lines')
  if (used.some((p) => p.error)) blockers.push('Fix the lines marked below')
  if (clsError) blockers.push(clsError)
  if (debitTotal === 0) blockers.push('Enter the amounts')
  else if (difference !== 0) blockers.push(`Debits and credits differ by ${fmtPkr(Math.abs(difference))}`)
  if (dateLocked) blockers.push(`Books are closed through ${lockedThrough} — pick a later date`)
  if (dateReopened && !isAdmin) blockers.push(`${date} is in a month the CEO reopened (through ${reopenedThrough}) — only the CEO can post there; pick a later date`)
  if (!date || date < dateBounds().min || date > dateBounds().max) blockers.push(`Pick a date between ${dateBounds().min} and ${dateBounds().max}`)

  const post = useMutation({
    mutationFn: async () => {
      const pin = amending?.tenantId ?? company
      const entry = await api.post<{ id: string; voucherNo?: string | null }>(amending ? `/accounting/journal/${amending.id}/amend` : '/accounting/journal', {
      ...(amending && { reason: amendReason.trim() }),
      description: description.trim(),
      ...(reference.trim() && { reference: reference.trim() }),
      ...(entryInstant(date) && { entryDate: entryInstant(date) }),
      ...(paysOut ? paymentClassificationBody(cls) : {}),
      lines: used.map((p) => ({
        accountId: p.line.accountId,
        type: p.debit > 0 ? 'debit' : 'credit',
        amountCents: p.debit > 0 ? p.debit : p.credit,
        ...(p.line.memo.trim() && { memo: p.line.memo.trim() }),
        ...(p.line.conceptId && { conceptId: p.line.conceptId }),
      })),
    }, { tenantId: pin })
      // The entry is in the books; a file that fails to upload is attached from its row below.
      let fileError: string | null = null
      if (files.length) {
        try { await uploadRecordFiles('journal_entry', entry.id, files, { tenantId: pin ?? undefined }) }
        catch (x) { fileError = (x as Error).message }
      }
      return { entry, fileError }
    },
    onSuccess: ({ entry, fileError }) => {
      const done = amending
        ? `Edited — the old entry is reversed and the corrected one is posted${entry.voucherNo ? ` as ${entry.voucherNo}` : ''} (${fmtPkr(debitTotal)} on ${date}).`
        : `Posted${entry.voucherNo ? ` as ${entry.voucherNo}` : ''} — ${fmtPkr(debitTotal)} on ${date}. It is in the Exceptions inbox for review.`
      setResult({ ok: !fileError, msg: fileError ? `${done} The documents did not upload (${fileError}) — attach them from the entry's Files below.` : done, entryId: entry.id })
      setDescription(''); setReference(''); setLines([blankLine(), blankLine()]); setAmending(null); setAmendReason(''); setFiles([]); setCls(EMPTY_PAYMENT_CLASSIFICATION)
      void qc.invalidateQueries({ queryKey: ['record-files'] })
      void qc.invalidateQueries({ queryKey: ['manual-journal'] })
      void qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (err: Error) => setResult({ ok: false, msg: err.message }),
  })

  /** The form's lines in the request shape (paisa, brand optional). */
  const requestLines = () => used.map((p) => ({
    accountId: p.line.accountId,
    type: p.debit > 0 ? 'debit' : 'credit',
    amountCents: p.debit > 0 ? p.debit : p.credit,
    ...(p.line.memo.trim() && { memo: p.line.memo.trim() }),
    ...(p.line.conceptId && { conceptId: p.line.conceptId }),
  }))
  function resetForm() {
    setDescription(''); setReference(''); setLines([blankLine(), blankLine()]); setEditing(null); setDate(todayPktIso())
  }

  /** Save the request (create or edit) and, when `send`, submit it. Never touches the books. */
  const saveRequest = useMutation({
    mutationFn: async (send: boolean) => {
      const body = {
        description: description.trim(),
        reference: reference.trim() || null,
        entryDate: entryInstant(date) ?? null,
        lines: requestLines(),
      }
      let id = editing?.id
      const pin = { tenantId: editing?.tenantId ?? company }
      if (id) await api.patch(`/accounting/journal-requests/${id}`, body, pin)
      else id = (await api.post<{ request: { id: string } }>('/accounting/journal-requests', { kind: 'post', ...body }, pin)).request.id
      if (send) await api.post(`/accounting/journal-requests/${id}/submit`, {}, pin)
      return send
    },
    onSuccess: (send) => {
      setResult({ ok: true, msg: send ? 'Sent for approval — the CEO will see it in the approvals inbox. Nothing is posted yet.' : 'Saved as a draft. Send it when it is ready.' })
      resetForm()
      setReqRefresh((n) => n + 1)
      void qc.invalidateQueries({ queryKey: ['journal-requests'] })
      if (!isAdmin) setTab('requests')
    },
    onError: (err: Error) => setResult({ ok: false, msg: err.message }),
  })

  /** Load a posted manual entry into the form to correct it. */
  function editEntry(e: LedgerEntry) {
    setEditing(null)
    setAmending(e)
    setAmendReason('')
    if (e.tenantId) setPickedCompany(e.tenantId)
    // The operator's own reference travels in the description (" · ref X",
    // manualJournal.ts) — bring it back into its own field, not lost.
    const refMatch = e.description.match(/ · ref (.*)$/)
    setDescription(e.description.replace(/ · ref .*$/, ''))
    setReference(refMatch?.[1] ?? '')
    setDate(pktDate(e.entryDate))
    setLines(e.lines.map((l) => ({
      key: ++lineSeq, accountId: l.accountId ?? '', memo: l.memo ?? '', conceptId: l.conceptId ?? '',
      debit: l.type === 'debit' ? (l.amountCents / 100).toFixed(2) : '',
      credit: l.type === 'credit' ? (l.amountCents / 100).toFixed(2) : '',
    })))
    setResult(null)
    setTab('entry')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /** Load a draft / returned request of mine back into the form. */
  function editRequest(r: JournalRequest) {
    const ls = Array.isArray(r.lines) ? r.lines : []
    setEditing(r)
    setPickedCompany(r.tenantId)
    setDescription(r.description)
    setReference(r.reference ?? '')
    setDate(r.entryDate ? pktDate(r.entryDate) : todayPktIso())
    setLines(ls.length >= 2
      ? ls.map((l) => ({
        key: ++lineSeq, accountId: l.accountId, memo: l.memo ?? '', conceptId: l.conceptId ?? '',
        debit: l.type === 'debit' ? (l.amountCents / 100).toFixed(2) : '',
        credit: l.type === 'credit' ? (l.amountCents / 100).toFixed(2) : '',
      }))
      : [blankLine(), blankLine()])
    setResult(null)
    setTab('entry')
  }

  return (
    <div className="min-h-screen bg-s-bg min-w-0 max-w-full">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Journal entry</h1>
          <p className="text-xs text-s-muted">Opening balances, accruals and corrections — balanced lines, posted to one company&apos;s books.</p>
        </div>
        <Link href="/accounting/ledger" className="s-btn-secondary text-sm">Ledger</Link>
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4 min-w-0">
        {canPrepare && (
          <div role="tablist" aria-label="Journal sections" className="flex gap-1 border-b border-s-border">
            {([['entry', amending ? 'Editing an entry' : editing ? 'Editing a request' : 'New entry'], ['requests', isAdmin ? 'Requests' : 'My requests']] as Array<[PageTab, string]>).map(([k, label]) => (
              <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'text-s-text' : 'border-transparent text-s-muted hover:text-s-text'}`}
                style={tab === k ? { borderColor: 'var(--erp-accent)' } : undefined}>
                {label}
              </button>
            ))}
          </div>
        )}

        {!canPrepare && (
          <div className="s-card p-4 text-sm text-s-muted">
            Manual journal entries are posted by finance and the CEO — every one is reviewed in the Exceptions inbox. The entries below are read-only.
          </div>
        )}
        {canPrepare && !canPost && tab === 'entry' && (
          <div className="s-card p-4 text-sm text-s-muted">
            Only the CEO posts directly. Prepare the entry here and send it for approval — it reaches the books when the CEO approves it.
          </div>
        )}

        {canPrepare && tab === 'requests' && (
          <JournalRequests mode={isAdmin ? 'all' : 'mine'} accounts={accounts} canDecide={isAdmin} onEdit={editRequest} refreshKey={reqRefresh} />
        )}

        {result && (
          <div role={result.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${result.ok ? 'text-success' : 'text-s-red'}`}>
            {result.msg}
            {result.entryId && <> <Link href={`/accounting/ledger?id=${result.entryId}`} className="underline">Open in the ledger</Link></>}
          </div>
        )}

        {canPrepare && tab === 'entry' && (
          <section className="s-card p-4 space-y-4 min-w-0" aria-label="New journal entry">
            {amending && (
              <div className="rounded-lg border border-s-border p-3 space-y-2">
                <p className="text-xs text-s-muted">
                  Editing the entry of {pktDate(amending.entryDate)} ({amending.description}). Saving reverses the old entry and posts this one in its place — both stay in the ledger.
                </p>
                <Field label="Why are you editing it? (required)">
                  <Input type="text" value={amendReason} onChange={(x) => setAmendReason(x.target.value)} maxLength={500}
                    placeholder="e.g. Wrong account on the second line" className={inputCls} />
                </Field>
              </div>
            )}
            {editing && (
              <p className="text-xs text-s-muted">
                Editing your {editing.status === 'returned' ? 'returned ' : ''}request for {companyName(editing.tenantId)}.
                {editing.decisionNote && editing.status === 'returned' && <> The CEO said: “{editing.decisionNote}”.</>}
                {' '}<LinkButton size="md" type="button"  onClick={resetForm}>Start a new entry instead</LinkButton>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              {companyIds.length > 1 && (
                <Field label="Company (whose books)">
                  <Select value={pickedCompany} disabled={!!editing || !!amending} onChange={(e) => { setPickedCompany(e.target.value); setLines([blankLine(), blankLine()]) }} className="s-select py-1.5">
                    <option value="">— pick a company —</option>
                    {companyIds.map((id) => <option key={id} value={id}>{companyName(id)}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Date">
                <Input type="date" min={dateBounds().min} max={dateBounds().max} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls}
                  aria-invalid={dateLocked || !date || date < dateBounds().min || date > dateBounds().max ? true : undefined}
                  aria-describedby={dateLocked ? 'journal-date-note' : undefined} />
                {dateLocked && <span id="journal-date-note" role="alert" className="block text-xs text-s-red mt-1">Books are closed through {lockedThrough} — pick a later date.</span>}
                {dateReopened && <span role={isAdmin ? 'status' : 'alert'} className={`block text-xs mt-1 ${isAdmin ? 'text-s-muted' : 'text-s-red'}`}>
                  {isAdmin ? `This month is reopened (through ${reopenedThrough}) — only you can post into it.` : `The CEO reopened the books through ${reopenedThrough} — only the CEO can post there. Pick a later date.`}
                </span>}
                {!dateLocked && !dateReopened && reopenedThrough && companyIds.length === 1 && (
                  <span className="block text-xs text-s-muted mt-1">Reopened by the CEO through {reopenedThrough} (CEO only).</span>
                )}
                {!dateLocked && date && (date < dateBounds().min || date > dateBounds().max) && <span role="alert" className="block text-xs text-s-red mt-1">Pick a date between {dateBounds().min} and {dateBounds().max}.</span>}
              </Field>
              <Field label="Description">
                <Input type="text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
                  placeholder="e.g. Opening balance — HBL operating account" className={inputCls} />
              </Field>
              <Field label="Cheque / bank reference (optional)">
                <Input type="text" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60}
                  placeholder="e.g. cheque 004512" className={inputCls} />
              </Field>
            </div>
            {lockedThrough && companyIds.length === 1 && (
              <p className={`text-xs ${dateLocked ? 'text-s-red' : 'text-s-muted'}`}>
                Books are closed through {lockedThrough}. Entries dated on or before it are refused — post the adjustment in the open period.
              </p>
            )}

            {/* Only this wrapper scrolls sideways. It is `relative` so the table header's sr-only text cannot escape it and widen the page. */}
            <div className="relative overflow-x-auto -mx-4 px-4 min-w-0" tabIndex={0} aria-label="Journal lines (scrolls sideways on a narrow screen)">
              <table className="w-full text-sm min-w-[44rem]">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="text-left font-medium py-1 pr-2">Account</th>
                    <th className="text-left font-medium py-1 pr-2">Brand</th>
                    <th className="text-left font-medium py-1 pr-2">Memo</th>
                    <th className="text-right font-medium py-1 pr-2 w-32">Debit (PKR)</th>
                    <th className="text-right font-medium py-1 pr-2 w-32">Credit (PKR)</th>
                    <th className="w-8 relative"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map(({ line, error }, i) => (
                    <tr key={line.key} className="align-top border-t border-s-border">
                      <td className="py-1.5 pr-2">
                        <Select aria-label={`Line ${i + 1} account`} value={line.accountId} disabled={!company}
                          onChange={(e) => patchLine(line.key, { accountId: e.target.value })} className="s-select py-1.5">
                          <option value="">— account —</option>
                          {companyAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                        </Select>
                        {error && <p className="text-xs text-s-red mt-1">{error}</p>}
                      </td>
                      <td className="py-1.5 pr-2">
                        <Select aria-label={`Line ${i + 1} brand`} value={line.conceptId}
                          onChange={(e) => patchLine(line.key, { conceptId: e.target.value })} className="s-select py-1.5">
                          <option value="">Shared</option>
                          {companyBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </Select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input aria-label={`Line ${i + 1} memo`} type="text" value={line.memo} maxLength={200}
                          onChange={(e) => patchLine(line.key, { memo: e.target.value })} className={inputCls} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input aria-label={`Line ${i + 1} debit`} inputMode="decimal" value={line.debit} placeholder="0.00"
                          onChange={(e) => patchLine(line.key, { debit: e.target.value, ...(e.target.value && { credit: '' }) })}
                          className={`${inputCls} text-right font-mono`} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input aria-label={`Line ${i + 1} credit`} inputMode="decimal" value={line.credit} placeholder="0.00"
                          onChange={(e) => patchLine(line.key, { credit: e.target.value, ...(e.target.value && { debit: '' }) })}
                          className={`${inputCls} text-right font-mono`} />
                      </td>
                      <td className="py-1.5">
                        <Button size="sm" variant="ghost" type="button" onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                          disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`}>Remove</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-s-border font-semibold">
                  <tr>
                    <td colSpan={3} className="py-2 pr-2">
                      <Button size="sm" variant="secondary" type="button" onClick={() => setLines((ls) => [...ls, blankLine()])}>Add line</Button>
                    </td>
                    <td className="py-2 pr-2 text-right font-mono text-s-text">{fmtPkr(debitTotal)}</td>
                    <td className="py-2 pr-2 text-right font-mono text-s-text">{fmtPkr(creditTotal)}</td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-1 pr-2 text-xs font-normal text-s-muted">Difference</td>
                    <td colSpan={2} className={`py-1 pr-2 text-right font-mono text-xs ${difference === 0 ? 'text-success' : 'text-s-red'}`}>
                      {difference === 0 ? (debitTotal > 0 ? 'Balanced' : '—') : fmtPkr(Math.abs(difference))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {canPost && !editing && (
              <div className="space-y-2">
                {amending && (
                  <RecordFiles ownerType="journal_entry" ownerId={amending.id} tenantId={amending.tenantId ?? undefined} canUpload={false} compact
                    title="Documents on the original entry" emptyText="No documents on the original entry." />
                )}
                {paysOut ? (
                  <div>
                    <PaymentClassificationFields value={cls} onChange={setCls} />
                    <p className="mt-1 text-xs text-s-muted">
                      This entry pays money out of cash or a bank, so it is listed in the Payments register.
                      {amending ? ' Leave it blank to keep the original entry\'s classification.' : ''}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-s-border px-3 py-2">
                    <p className="text-xs font-semibold">Classification — Official / Unofficial / Unclassified</p>
                    <p className="text-xs text-s-muted">
                      Asked when the entry pays money out: a credit line to Cash on hand (1010), Petty cash (1011) or a bank account.
                      This entry has none yet, so it is not a payment and needs no classification.
                    </p>
                  </div>
                )}
                <PendingFilesPicker ownerType="journal_entry" value={files} onChange={setFiles}
                  label={amending ? 'Supporting documents for the corrected entry' : 'Supporting documents'}
                  hint="Invoices, bank advices, workings — PDF, photos, Excel or Word. Saved with the entry when it is posted." />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <ul className="text-xs text-s-muted space-y-0.5">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
              <div className="flex flex-wrap gap-2">
                {amending && (
                  <Button variant="ghost" type="button" onClick={() => { setAmending(null); setAmendReason(''); setDescription(''); setReference(''); setLines([blankLine(), blankLine()]); setFiles([]) }}>Stop editing</Button>
                )}
                {canPost && !editing && (
                  <Button type="button" onClick={() => { setResult(null); post.mutate() }}
                    disabled={blockers.length > 0 || post.isPending || saveRequest.isPending}>
                    {post.isPending ? 'Posting…' : amending ? 'Save changes' : 'Post entry'}
                  </Button>
                )}
                {!amending && !canPost && (<>
                <Button variant="secondary" type="button" onClick={() => { setResult(null); saveRequest.mutate(false) }}
                  disabled={blockers.length > 0 || saveRequest.isPending || post.isPending}>
                  Save as draft
                </Button>
                <button type="button" onClick={() => { setResult(null); saveRequest.mutate(true) }}
                  disabled={blockers.length > 0 || saveRequest.isPending || post.isPending}
                  className={isAdmin && !editing ? 's-btn-secondary text-sm' : 's-btn-primary text-sm'}>
                  {saveRequest.isPending ? 'Saving…' : 'Send for approval'}
                </button>
                </>)}
              </div>
            </div>
          </section>
        )}

        <RecentManualEntries isAdmin={canPost} isCeo={isAdmin} canRequest={canPrepare} companyName={companyName} multiCompany={companyIds.length > 1} onEdit={canPost ? editEntry : undefined}
          closedBooks={lock?.tenantId && closedBooksThrough ? { tenantId: lock.tenantId, through: closedBooksThrough } : null} />
      </div>
    </div>
  )
}

type ClosedBooks = { tenantId: string; through: string } | null

function RecentManualEntries({ isAdmin, isCeo, canRequest, companyName, multiCompany, onEdit, closedBooks }: { isAdmin: boolean; isCeo: boolean; canRequest: boolean; companyName: (id: string | null) => string; multiCompany: boolean; onEdit?: (e: LedgerEntry) => void; closedBooks: ClosedBooks }) {
  const from = daysAgoPkt(90)
  const to = todayPktIso()
  const { data, isLoading, error } = useQuery<LedgerPage>({
    queryKey: ['manual-journal', from, to],
    queryFn: () => api.get(`/accounting/ledger?source=manual&dateFrom=${from}&dateTo=${to}&limit=100`),
  })
  const entries = data?.data ?? []

  return (
    <section className="s-card overflow-hidden" aria-label="Recent manual entries">
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
        <h2 className="text-sm font-semibold text-s-text">Manual entries — last 90 days</h2>
        <p className="text-xs text-s-muted">A wrong entry is undone by a reversing entry dated in the open period. Each entry can be reversed once.</p>
      </div>
      {isLoading && <p className="px-4 py-6 text-sm text-s-muted">Loading…</p>}
      {error && <p className="px-4 py-6 text-sm text-s-red">{(error as Error).message}</p>}
      {!isLoading && !error && entries.length === 0 && (
        <p className="px-4 py-6 text-sm text-s-muted text-center">No manual entries in the last 90 days.</p>
      )}
      {entries.map((e) => {
        // Dated in closed or reopened books: cancelling or editing it is the CEO's (403 CEO_ONLY_CLOSED_BOOKS).
        const ceoOnly = !isCeo && !!closedBooks && e.tenantId === closedBooks.tenantId && pktDate(e.entryDate) <= closedBooks.through
        // There a non-CEO may still ASK for the reversal (a journal request the CEO approves).
        return <ManualEntryRow key={e.id} e={e} isAdmin={isAdmin && !ceoOnly} canAttach={isAdmin} canRequest={canRequest} company={multiCompany ? companyName(e.tenantId) : null} onEdit={ceoOnly ? undefined : onEdit} ceoOnly={ceoOnly} />
      })}
      {data?.hasMore && <p className="px-4 py-3 text-xs text-s-muted">Showing the latest 100 — older entries are in the ledger.</p>}
    </section>
  )
}

function ManualEntryRow({ e, isAdmin, canAttach, canRequest, company, onEdit, ceoOnly }: { e: LedgerEntry; isAdmin: boolean; canAttach: boolean; canRequest: boolean; company: string | null; onEdit?: (e: LedgerEntry) => void; ceoOnly: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(todayPktIso())
  const [err, setErr] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const isReversal = !!e.reference?.startsWith('manual.reversal:')
  const total = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)

  // A non-CEO preparer asks for the reversal: a 'reverse' request the CEO approves.
  const requestReversal = useMutation({
    mutationFn: () => api.post('/accounting/journal-requests', {
      kind: 'reverse', reverseEntryId: e.id, reason: reason.trim(), submit: true,
      ...(entryInstant(date) && { entryDate: entryInstant(date) }),
    }, e.tenantId ? { tenantId: e.tenantId } : undefined),
    onSuccess: () => {
      setOpen(false); setReason(''); setErr(null); setAsked(true)
      void qc.invalidateQueries({ queryKey: ['journal-requests'] })
    },
    onError: (x: Error) => setErr(x.message),
  })
  const reverse = useMutation({
    mutationFn: () => api.post(`/accounting/journal/${e.id}/reverse`, {
      reason: reason.trim(),
      ...(entryInstant(date) && { entryDate: entryInstant(date) }),
    }, e.tenantId ? { tenantId: e.tenantId } : undefined),
    onSuccess: () => {
      setOpen(false); setReason(''); setErr(null)
      void qc.invalidateQueries({ queryKey: ['manual-journal'] })
      void qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (x: Error) => setErr(x.message),
  })

  return (
    <div className="border-b border-s-border last:border-0 px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <span className="font-mono text-xs font-semibold text-s-text w-20 shrink-0">{e.voucherNo ?? '—'}</span>
        <span className="font-mono text-xs text-s-muted w-24 shrink-0">{pktDate(e.entryDate)}</span>
        <span className="flex-1 min-w-0">
          <Link href={`/accounting/ledger?id=${e.id}`} className="block text-sm text-s-text truncate hover:underline">{e.description}</Link>
          <span className="block text-xs text-s-muted truncate">
            {company && <>{company} · </>}
            {e.lines.map((l) => `${l.account.code} ${l.type === 'debit' ? 'Dr' : 'Cr'}`).join(' · ')}
          </span>
        </span>
        <span className="font-mono text-xs text-s-text shrink-0">{fmtPkr(total)}</span>
        {isReversal && <span className="s-badge-muted shrink-0">Reversal</span>}
        {e.reversedBy && <span className="s-badge-amber shrink-0">Reversed {pktDate(e.reversedBy.entryDate)}</span>}
        {asked && <span className="s-badge-amber shrink-0">Reversal requested</span>}
        {ceoOnly && !isReversal && !e.reversedBy && (
          <span className="s-badge-muted shrink-0" title="Dated in closed books — only the CEO can edit or cancel it; you can ask for the reversal">Closed books — CEO only</span>
        )}
        {(isAdmin || canRequest) && !isReversal && !e.reversedBy && !open && !asked && (
          <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(true)} className="shrink-0">{isAdmin ? 'Cancel (reverse)' : 'Request reversal'}</Button>
        )}
        {onEdit && !isReversal && !e.reversedBy && !open && (
          <Button size="sm" variant="secondary" type="button" onClick={() => onEdit(e)} className="shrink-0">Edit</Button>
        )}
      </div>
      {!isReversal && (
        // Supporting documents (owner, 2026-10-20): loaded on "Files" — one request per opened row, never per row.
        <RecordFiles ownerType="journal_entry" ownerId={e.id} tenantId={e.tenantId ?? undefined} canUpload={canAttach} compact lazy
          emptyText="No supporting documents yet." />
      )}
      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
          <Field label="Reason (required)">
            <Input type="text" value={reason} onChange={(x) => setReason(x.target.value)} maxLength={500}
              placeholder="e.g. Posted to the wrong bank account" className={inputCls} />
          </Field>
          <Field label="Reversal date">
            <Input type="date" min={dateBounds().min} max={dateBounds().max} value={date} onChange={(x) => setDate(x.target.value)} className={inputCls} />
          </Field>
          {isAdmin ? (
            <Button variant="danger" type="button" onClick={() => reverse.mutate()} disabled={reason.trim().length < 5 || reverse.isPending}>
              {reverse.isPending ? 'Reversing…' : 'Post reversal'}
            </Button>
          ) : (
            <Button type="button" onClick={() => requestReversal.mutate()} disabled={reason.trim().length < 5 || requestReversal.isPending}>
              {requestReversal.isPending ? 'Sending…' : 'Send for approval'}
            </Button>
          )}
          <Button variant="ghost" type="button" onClick={() => { setOpen(false); setErr(null) }}>Cancel</Button>
          {err && <p role="alert" className="sm:col-span-4 text-xs text-s-red">{err}</p>}
        </div>
      )}
    </div>
  )
}
