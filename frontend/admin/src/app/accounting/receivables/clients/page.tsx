'use client'
// City Ledger accounts (on-account clients billed on credit) — the list.
//
// API: /accounting/customer-accounts (receivables/customerAccounts.ts) and
// /accounting/till-clearing (accounting/tillClearing*.ts). UI only: every
// figure, rule and permission is the server's.
//
//   Step 1 panel   Until the company's till clearing is moved off 1110 onto
//                  1115, no client can be approved. The panel shows what the
//                  cut-over would move and the 1110 tie-out. The CEO gets
//                  "Split till clearing" (reason of 10+ characters, the
//                  server's canCutover flag); everyone else sees "Waiting
//                  for the CEO".
//   The list       status chip, limit, exposure bar, available, overdue
//                  badge, unbilled; filters: pending, overdue.
//   New client     rupees typed, sent as paisa (toPaisa); brands from
//                  GET /concepts?view=picker through the searchable Select;
//                  a client the CEO did not create waits for the CEO.
//   Issue <Month> statements   bulk, for the last day of the previous
//                  Karachi month; shows what was created and skipped.

import { Button, CheckLabel, Field, Input, LinkButton, Textarea } from '@/components/finance/ui'
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../../lib/api'
import { fmtPkrWhole, startOfMonthPktIso } from '../../../../lib/money'
import { useActiveCompany } from '../../../../lib/connectorsApi'
import { Select } from '@/components/ui/Select'
import { Modal as SharedModal } from '../../../../components/ui/Modal'
import { NumberField } from '../../../../components/ui/NumberField'
import { DialogForm, RupeeField } from '../../../../components/finance/PaymentReceivedFields'
import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'
import { FIcon } from '../../../../components/finance/ui/icons'

type AccountType = 'company' | 'corporate' | 'travel_agent' | 'guest' | 'other'
const ACCOUNT_TYPES: Array<{ value: AccountType; label: string }> = [
  { value: 'company', label: 'Company' }, { value: 'corporate', label: 'Corporate' },
  { value: 'travel_agent', label: 'Travel agent' }, { value: 'guest', label: 'Guest' }, { value: 'other', label: 'Other' },
]
type ClientStatus = 'pending' | 'active' | 'suspended' | 'closed'
interface Overdue { invoiceId: string; number: string; dueDate: string; balanceCents: number }
interface ClientRow {
  id: string; tenantId: string; companyName: string | null; number: string; legalName: string; tradeName: string | null
  status: ClientStatus; creditLimitCents: number; requestedCreditLimitCents: number | null
  unbilledCents: number; invoicesDueCents: number; exposureCents: number; availableCents: number
  /** Money owed back to the client (a refund after its statement was paid) — blocks closing. */
  creditCents?: number
  overdue: Overdue | null; cardsActive: number; pending: 'new_client' | 'limit_increase' | null
  brands: Array<{ id: string; name: string | null }>
  accountType?: AccountType; accountTypeLabel?: string; receivableAccountCode?: string; termsDays?: number
}
interface TieOut {
  gl1110: number; openInvoicesCents: number; openStatementsCents: number; unbilledBookedCents: number
  unbilledNotBookedCents: number; tillClearingOn1110Cents: number; differenceCents: number
  unexplainedCount: number; cutoverAt: string | null
}
interface TillStatus {
  tenantId: string; cutoverAt: string | null; previewCents: number; canCutover: boolean; tieOut: TieOut
}
interface PickerConcept { id: string; name: string; tenantId?: string }
interface BulkResult {
  periodTo: string
  created: Array<{ accountId: string; accountNumber: string; number: string; totalCents: number }>
  skipped: Array<{ accountId: string; accountNumber: string; code: string; message: string }>
}

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 's-input w-full'
/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong — try again')

const STATUS: Record<ClientStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--erp-warning)' },
  active: { label: 'Active', color: 'var(--erp-success)' },
  suspended: { label: 'Suspended', color: 'var(--erp-danger)' },
  closed: { label: 'Closed', color: 'rgb(var(--fg-rgb) / 0.4)' },
}

/** Last day of the previous Karachi month, and that month's name. */
function previousMonthEnd(): { periodTo: string; month: string } {
  const [y, m] = startOfMonthPktIso().split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m - 1, 0))
  return {
    periodTo: last.toISOString().slice(0, 10),
    month: last.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  }
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <Field label={t}>{children}</Field>
}
/** Thin wrapper over the shared Modal (Escape, focus trap, scroll lock, "Discard changes?" when `dirty`). */
function Modal({ title, children, onClose, dirty }: { title: string; children: React.ReactNode; onClose: () => void; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} dirty={dirty}>{children}</SharedModal>
}
function Err({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="mt-3 text-sm font-bold" style={{ color: 'var(--erp-danger)' }}>{msg}</p> : null
}

// ─── Step 1: the till-clearing cut-over ──────────────────────────────────────

function CutoverPanel({ status, onDone }: { status: TillStatus; onDone: () => void }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const t = status.tieOut
  const split = useMutation({
    mutationFn: () => api.post('/accounting/till-clearing/cutover', { reason: reason.trim() }),
    onSuccess: () => { setAsking(false); setReason(''); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  const rows: Array<[string, number]> = [
    ['On 1110 now', t.gl1110],
    ['Open invoices', t.openInvoicesCents],
    ['Open statements', t.openStatementsCents],
    ['Unbilled client bills (booked)', t.unbilledBookedCents],
    ['Till clearing still on 1110', t.tillClearingOn1110Cents],
  ]
  return (
    <section className="rounded-2xl p-5" style={{ ...card, borderColor: 'color-mix(in srgb, var(--erp-warning) 40%, transparent)' }}>
      <p className="text-xs uppercase tracking-wider font-bold text-success">Step 1</p>
      <h2 className="text-lg font-black text-white/90 mt-1">Split till clearing before approving clients</h2>
      <p className="text-sm text-white/60 mt-1 max-w-2xl">
        Before clients can be approved, till clearing moves off 1110 onto 1115. Confirm with your CA.
        Clients can still be created and wait for approval.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 mt-4 max-w-2xl text-sm">
        <div className="flex justify-between sm:col-span-2 font-black text-white/90">
          <span>The cut-over would move</span><span>{fmtPkrWhole(status.previewCents)}</span>
        </div>
        {rows.map(([l, v]) => (
          <div key={l} className="flex justify-between text-white/60"><span>{l}</span><span>{fmtPkrWhole(v)}</span></div>
        ))}
        <div className="flex justify-between font-bold sm:col-span-2" style={{ color: t.differenceCents === 0 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
          <span>Tie-out difference</span><span>{fmtPkrWhole(t.differenceCents)}</span>
        </div>
        {t.unexplainedCount > 0 && (
          <p className="sm:col-span-2 text-xs text-s-muted">{t.unexplainedCount} other line(s) on 1110 (manual journals, openings) are never moved.</p>
        )}
      </div>
      <div className="mt-4">
        {status.canCutover
          ? <Button type="submit" onClick={() => { setErr(null); setAsking(true) }}>Split till clearing</Button>
          : <p className="text-sm font-bold text-white/60">Waiting for the CEO</p>}
      </div>
      {asking && (
        <Modal title="Split till clearing" onClose={() => setAsking(false)} dirty={!split.isPending && !!reason.trim()}>
          <DialogForm busy={split.isPending} onSubmit={() => split.mutate()} missing={reason.trim().length < 10 ? 'Give the reason (10 characters or more).' : null}>
          <p className="text-sm text-white/60 mb-3">
            Moves {fmtPkrWhole(status.previewCents)} of till clearing from 1110 to 1115 in the active company, once. It is audited.
          </p>
          <L t="Why (at least 10 characters)">
            <Textarea className={inp} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reason.trim().length < 10 ? true : undefined} placeholder="CA confirmed on …" />
          </L>
          <Err msg={err} />
          <div className="flex gap-2 mt-5">
            <Button type="submit" disabled={split.isPending}>
              {split.isPending ? 'Splitting…' : 'Split till clearing'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setAsking(false)}>Cancel</Button>
          </div>
          </DialogForm>
        </Modal>
      )}
    </section>
  )
}

// ─── New client ──────────────────────────────────────────────────────────────

function NewClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const company = useActiveCompany()
  const [f, setF] = useState({
    legalName: '', tradeName: '', ntn: '', strn: '', address: '', contactName: '', contactPhone: '', contactEmail: '',
    limit: '', termsDays: '30', graceDays: '7', requiresReference: false, notes: '', number: '', accountType: 'company' as AccountType,
  })
  const [termsPreset, setTermsPreset] = useState<'0' | '7' | '15' | '30' | 'custom'>('30')
  const [codeTaken, setCodeTaken] = useState(false)
  const [brandIds, setBrandIds] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const { data: concepts } = useQuery<PickerConcept[]>({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<PickerConcept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })
  // Only the active company's brands (the server refuses any other: 422).
  const brands = useMemo(
    () => (concepts ?? []).filter((c) => !c.tenantId || !company || c.tenantId === company.id),
    [concepts, company],
  )
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const create = useMutation({
    mutationFn: () => api.post('/accounting/customer-accounts', {
      legalName: f.legalName.trim(),
      tradeName: f.tradeName, ntn: f.ntn, strn: f.strn, address: f.address,
      contactName: f.contactName, contactPhone: f.contactPhone, contactEmail: f.contactEmail,
      creditLimitCents: toPaisa(f.limit),
      termsDays: termsPreset === 'custom' ? Math.min(180, Math.max(0, Number(f.termsDays) || 0)) : Number(termsPreset),
      accountType: f.accountType,
      ...(f.number.trim() ? { number: f.number.trim() } : {}),
      overdueGraceDays: Number(f.graceDays) || 0,
      requiresReference: f.requiresReference,
      conceptIds: brandIds,
      notes: f.notes,
    }),
    onSuccess: onCreated,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ACCOUNT_CODE_TAKEN') { setCodeTaken(true); setErr(null) } else setErr(errText(e))
    },
  })
  const codeBad = f.number.trim() !== '' && !/^[A-Za-z0-9-]{2,20}$/.test(f.number.trim())
  const missing = codeBad ? 'The account code is 2 to 20 letters, numbers or dashes.' : f.legalName.trim().length < 2 ? 'Enter the client\'s legal name.' : toPaisa(f.limit) <= 0 ? 'Enter a credit limit above zero.' : null
  return (
    <Modal title="New City Ledger account" onClose={onClose} dirty={!create.isPending && (!!f.legalName.trim() || !!f.tradeName.trim() || !!f.limit || !!f.notes.trim())}>
      <DialogForm busy={create.isPending} onSubmit={() => { setErr(null); create.mutate() }} missing={missing}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <L t="Account name"><Input className={inp} aria-invalid={f.legalName.trim().length < 2 ? true : undefined} value={f.legalName} onChange={(e) => set('legalName', e.target.value)} /></L>
          </div>
          <L t="Account type">
            <Select className={inp} value={f.accountType} onChange={(e) => set('accountType', e.target.value as AccountType)}>
              {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </L>
        </div>
        <Field label="Account code (optional)" hint="Leave empty to number it automatically"
          error={codeTaken ? 'This account code is already used — choose another.' : codeBad ? '2 to 20 letters, numbers or dashes.' : undefined}>
          <Input className={inp} value={f.number} maxLength={20} onChange={(e) => { setCodeTaken(false); set('number', e.target.value.toUpperCase()) }} aria-invalid={codeTaken || codeBad ? true : undefined} />
        </Field>
        <L t="Trade name"><Input className={inp} value={f.tradeName} onChange={(e) => set('tradeName', e.target.value)} /></L>
        <div className="grid grid-cols-2 gap-3">
          <L t="NTN (tax / registration)"><Input className={inp} value={f.ntn} onChange={(e) => set('ntn', e.target.value)} /></L>
          <L t="STRN (tax / registration)"><Input className={inp} value={f.strn} onChange={(e) => set('strn', e.target.value)} /></L>
        </div>
        <L t="Billing address"><Input className={inp} value={f.address} onChange={(e) => set('address', e.target.value)} /></L>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <L t="Contact person"><Input className={inp} value={f.contactName} onChange={(e) => set('contactName', e.target.value)} /></L>
          <L t="Contact phone"><Input className={inp} value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></L>
          <L t="Contact email (statements go here)"><Input type="email" className={inp} value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} /></L>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <L t="Credit limit (PKR)"><RupeeField className={inp} label="Credit limit (PKR)" value={f.limit} onChange={(v) => set('limit', v)} invalid={toPaisa(f.limit) <= 0 && f.legalName.trim().length >= 2} /></L>
          <L t="Payment terms">
            <Select className={inp} value={termsPreset} onChange={(e) => { const v = e.target.value as typeof termsPreset; setTermsPreset(v); if (v !== 'custom') set('termsDays', v) }}>
              <option value="0">Immediate</option><option value="7">7 days</option><option value="15">15 days</option>
              <option value="30">30 days</option><option value="custom">Custom</option>
            </Select>
            {termsPreset === 'custom' && (
              <NumberField className={`${inp} mt-2`} min={0} max={180} value={f.termsDays === '' ? null : Number(f.termsDays)} onValueChange={(n) => set('termsDays', n == null ? '' : String(n))} />
            )}
          </L>
          <L t="Overdue grace (days)"><NumberField className={inp} min={0} max={365} value={f.graceDays === '' ? null : Number(f.graceDays)} onValueChange={(n) => set('graceDays', n == null ? '' : String(n))} /></L>
        </div>
        <L t="Brands this client may be billed at">
          <Select className={inp} value="" onChange={(e) => { const v = e.target.value; if (v && !brandIds.includes(v)) setBrandIds([...brandIds, v]) }}>
            <option value="">{brandIds.length ? 'Add another brand…' : 'Add a brand…'}</option>
            {brands.filter((b) => !brandIds.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </L>
        {brandIds.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {brandIds.map((id) => (
              <button key={id} type="button" onClick={() => setBrandIds(brandIds.filter((x) => x !== id))}
                className="rounded-full px-3 py-1 text-xs font-bold text-white/80"
                style={{ background: 'color-mix(in srgb, var(--erp-success) 14%, transparent)' }}>
                {brands.find((b) => b.id === id)?.name ?? id} <FIcon name="x" size={12} />
              </button>
            ))}
          </div>
        )}
        <CheckLabel className="flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" checked={f.requiresReference} onChange={(e) => set('requiresReference', e.target.checked)} />
          Every bill needs a reference (PO number or who signed)
        </CheckLabel>
        <L t="Linked receivable account"><Input className={inp} value="1110 Customer receivable" readOnly disabled /></L>
        <L t="Notes"><Textarea className={inp} rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></L>
        <p className="text-xs text-s-muted">
          The CEO approves every new client, unless the CEO is the one creating it. A client cannot be billed until it is approved.
        </p>
      </div>
      <Err msg={err} />
      <div className="flex gap-2 mt-5">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Create account'}
        </Button>
        <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
      </div>
      </DialogForm>
    </Modal>
  )
}

// ─── Bulk statements ─────────────────────────────────────────────────────────

function BulkDialog({ periodTo, month, onClose, onDone }: { periodTo: string; month: string; onClose: () => void; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<BulkResult | null>(null)
  const issue = useMutation({
    mutationFn: () => api.post<BulkResult>('/accounting/customer-accounts/statements/issue', { periodTo }),
    onSuccess: (r) => { setResult(r); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  return (
    <Modal title={`Issue ${month} statements`} onClose={onClose}>
      {!result ? (
        <DialogForm busy={issue.isPending} onSubmit={() => { setErr(null); issue.mutate() }} missing={null}>
          <p className="text-sm text-white/70">
            Bills every client in the active company for charges up to <b>{periodTo}</b>. Clients with nothing to bill are skipped.
            A statement is not a tax invoice and posts nothing to the books.
          </p>
          <Err msg={err} />
          <div className="flex gap-2 mt-5">
            <Button type="submit" disabled={issue.isPending}>
              {issue.isPending ? 'Issuing…' : `Issue ${month} statements`}
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </DialogForm>
      ) : (
        <>
          <p className="text-sm font-black text-white/90">Created {result.created.length} · Skipped {result.skipped.length}</p>
          {result.created.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-white/80">
              {result.created.map((c) => (
                <li key={c.number} className="flex justify-between gap-3">
                  <Link href={`/accounting/receivables/clients/${c.accountId}`} className="underline">{c.accountNumber}</Link>
                  <span>{c.number}</span><span>{fmtPkrWhole(c.totalCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-white/60">
              {result.skipped.map((s) => <li key={s.accountId}>{s.accountNumber}: {s.message}</li>)}
            </ul>
          )}
          <Button type="button" onClick={onClose} className="mt-5">Done</Button>
        </>
      )}
    </Modal>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OnAccountClientsPage() {
  const qc = useQueryClient()
  const company = useActiveCompany()
  const [pendingOnly, setPendingOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<'' | AccountType>('')
  const [creating, setCreating] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { periodTo, month } = previousMonthEnd()

  const params = new URLSearchParams()
  if (pendingOnly) params.set('pending', '1')
  if (overdueOnly) params.set('overdue', '1')
  if (q.trim()) params.set('q', q.trim())
  const list = useQuery<{ items: ClientRow[] }>({
    queryKey: ['oa-clients', params.toString()],
    queryFn: () => api.get(`/accounting/customer-accounts?${params.toString()}`),
  })
  const till = useQuery<{ companies: TillStatus[] }>({
    queryKey: ['till-clearing-status'],
    queryFn: () => api.get('/accounting/till-clearing/status'),
  })
  // The cut-over is the ACTIVE company's: show its status.
  const status = till.data?.companies.find((c) => c.tenantId === company?.id) ?? (till.data?.companies.length === 1 ? till.data.companies[0] : undefined)
  const needsCutover = !!status && !status.cutoverAt
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['oa-clients'] }); void qc.invalidateQueries({ queryKey: ['till-clearing-status'] }) }

  const items = (list.data?.items ?? []).filter((r) => !typeFilter || (r.accountType ?? 'company') === typeFilter)
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 md:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/accounting/receivables" className="text-xs text-s-muted hover:text-white/70">← Receivables</Link>
        <div className="flex flex-wrap items-start justify-between gap-4 mt-2">
          <div>
            <p className="text-xs uppercase tracking-wider font-bold text-success">Receivables</p>
            <h1 className="text-2xl font-black text-white/90">City Ledger accounts</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">Accounts billed on credit: record settlements, follow outstanding bills and review each account's history. QR cards are taken at the till.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setBulk(true)} className="rounded-xl px-4 py-2.5 text-sm font-black text-white/90 border border-white/15 hover:bg-white/5">Issue {month} statements</button>
            <Button type="submit" onClick={() => setCreating(true)}>+ New account</Button>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-7 py-6 max-w-6xl mx-auto space-y-5">
        {notice && (
          <div role="status" className="flex items-start justify-between gap-3 rounded-2xl p-4 text-sm"
            style={{ background: 'color-mix(in srgb, var(--erp-success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-success) 35%, transparent)' }}>
            <span className="text-white/85">{notice}</span>
            <LinkButton tone="muted" size="md" type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0"><FIcon name="x" size={14} /></LinkButton>
          </div>
        )}
        {needsCutover && status && <CutoverPanel status={status} onDone={refresh} />}

        <div className="flex flex-wrap items-center gap-2">
          <Input className={`${inp} max-w-xs`} placeholder="Search name, account code or NTN" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="s-input w-auto" aria-label="Account type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as '' | AccountType)}>
            <option value="">All account types</option>
            {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          {([['Pending', pendingOnly, setPendingOnly], ['Overdue', overdueOnly, setOverdueOnly]] as const).map(([label, on, setOn]) => (
            <button key={label} onClick={() => setOn(!on)} aria-pressed={on}
              className="rounded-full px-3 py-1.5 text-xs font-bold"
              style={on
                ? { background: 'color-mix(in srgb, var(--erp-success) 18%, transparent)', color: 'rgb(var(--fg-rgb) / 0.95)' }
                : { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>
              {label}
            </button>
          ))}
        </div>

        {list.isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {list.isError && <p role="alert" className="text-sm font-bold" style={{ color: 'var(--erp-danger)' }}>{errText(list.error)}</p>}
        {!list.isLoading && !list.isError && items.length === 0 && (
          <CompactEmptyState message={pendingOnly || overdueOnly || q || typeFilter ? 'No accounts match these filters.' : 'No City Ledger accounts yet.'} />
        )}

        <div className="space-y-3">
          {items.map((r) => {
            const pct = r.creditLimitCents > 0 ? Math.min(100, Math.round((r.exposureCents / r.creditLimitCents) * 100)) : 0
            const s = STATUS[r.status]
            return (
              <Link key={r.id} href={`/accounting/receivables/clients/${r.id}`} className="block rounded-2xl p-4 hover:bg-white/[0.04]" style={card}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-white/50">{r.number}</span>
                  <span className="text-base font-black text-white/90">{r.legalName}</span>
                  <span className="rounded-full px-2 py-0.5 text-xs font-black"
                    style={{ background: 'color-mix(in srgb, var(--erp-primary) 10%, transparent)', color: 'var(--erp-primary)' }}>
                    {r.accountTypeLabel ?? 'Company'}
                  </span>
                  <span className="rounded-full px-2 py-0.5 text-xs font-black uppercase"
                    style={{ background: `color-mix(in srgb, ${s.color} 16%, transparent)`, color: s.color }}>{s.label}</span>
                  {r.pending === 'limit_increase' && (
                    <span className="rounded-full px-2 py-0.5 text-xs font-black uppercase"
                      style={{ background: 'color-mix(in srgb, var(--erp-warning) 16%, transparent)', color: 'var(--erp-warning)' }}>
                      Limit increase waiting
                    </span>
                  )}
                  {r.overdue && (
                    <span className="rounded-full px-2 py-0.5 text-xs font-black uppercase"
                      style={{ background: 'color-mix(in srgb, var(--erp-danger) 16%, transparent)', color: 'var(--erp-danger)' }}>
                      Overdue · {r.overdue.number}
                    </span>
                  )}
                  {(r.creditCents ?? 0) > 0 && (
                    <span className="rounded-full px-2 py-0.5 text-xs font-black uppercase"
                      style={{ background: 'color-mix(in srgb, var(--erp-warning) 16%, transparent)', color: 'var(--erp-warning)' }}>
                      In credit · {fmtPkrWhole(r.creditCents ?? 0)}
                    </span>
                  )}
                  {r.companyName && <span className="ml-auto text-xs text-s-muted">{r.companyName}</span>}
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                  <div><p className="text-xs uppercase tracking-wider text-white/40 font-bold">Account type</p><p className="font-black text-white/90">{r.accountTypeLabel ?? 'Company'}</p></div>
                  <div><p className="text-xs uppercase tracking-wider text-white/40 font-bold">Credit limit</p><p className="font-black text-white/90">{fmtPkrWhole(r.creditLimitCents)}</p></div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-white/40 font-bold">Outstanding</p>
                    <p className="font-black text-white/90">{fmtPkrWhole(r.exposureCents)}</p>
                    <div className="mt-1 h-1.5 rounded-full" style={{ background: 'rgb(var(--fg-rgb) / 0.08)' }}>
                      <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--erp-danger)' : 'var(--erp-success)' }} />
                    </div>
                  </div>
                  <div><p className="text-xs uppercase tracking-wider text-white/40 font-bold">Available</p><p className="font-black text-white/90">{fmtPkrWhole(r.availableCents)}</p></div>
                  <div><p className="text-xs uppercase tracking-wider text-white/40 font-bold">Unbilled</p><p className="font-black text-white/90">{fmtPkrWhole(r.unbilledCents)}</p></div>
                </div>
              </Link>
            )
          })}
        </div>
      </div>

      {creating && (
        <NewClientDialog
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); setNotice('Client saved.'); refresh() }}
        />
      )}
      {bulk && <BulkDialog periodTo={periodTo} month={month} onClose={() => setBulk(false)} onDone={refresh} />}
    </div>
  )
}
