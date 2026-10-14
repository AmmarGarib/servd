'use client'
// Accounting → Inter-company (H30; backend modules/intercompany).
//
// Money between two group companies' books, posted in BOTH or neither:
//   Balances          what each company owes the other, from each company's own
//                     books — a difference between the two books is red;
//   Transfers         charges, settlements and netting: finance prepares, the
//                     CEO approves or rejects (and may reverse a posted one);
//   Shared fleet      the per-trip rate each provider charges a client, the
//                     trips per month and the monthly charge ("Charge now");
//   Tie-out & legacy  wallet / loyalty / gift-card liabilities against their
//                     subledgers, and the one-time write-off of the pre-launch
//                     cross-company residue (CEO, preview first).
//
// A settlement (owner, 2026-10-14) is paid by bank transfer, bank deposit (the
// paying company's cash paid into the receiving company's bank — only the
// receiving company's bank is asked for), cheque or cash, and always carries a
// payment reference #. A reference used before is a warning after saving.
// The bank pickers are built here, not with BankAccountSelect: that one reads
// the active company's banks only, and a settlement names a bank in each of
// two companies (read across both with the portfolio header).
//
// What the signed-in user may do comes from the server (GET /companies `can`,
// and each row's canApprove / canReverse / canDecide / canWriteOff) — this page
// keeps no role list. Every 403 / 404 / 409 / 422 message is shown as the API
// wrote it.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { banksOf, type BankAccountOption } from '../../../components/finance/BankAccountSelect'
import {
  PAYMENT_REFERENCE_ERROR_TEXT, ReferenceUsedBeforeNotice, receiptMethodLabel, type PaymentRefUse,
} from '../../../components/finance/PaymentReceivedFields'

// ─── API shapes ──────────────────────────────────────────────────────────────

interface Companies {
  activeTenantId: string | null
  companies: Array<{ id: string; name: string }>
  can: { prepare: boolean; decide: boolean }
}

interface Pair {
  a: { id: string; name: string | null }
  b: { id: string; name: string | null }
  memberOfBoth: boolean
  aDueFromB: number
  aDueToB: number
  bDueFromA: number | null
  bDueToA: number | null
  netOwedByA: number
  mismatchCents: number | null
}

type TransferKind = 'charge' | 'settlement' | 'netting'
type TransferStatus = 'submitted' | 'posted' | 'rejected' | 'reversed'

interface Transfer {
  id: string
  tenantId: string
  counterpartyTenantId: string
  debtorName: string | null
  creditorName: string | null
  kind: TransferKind
  source: string
  period: string | null
  amountCents: number
  entryDate: string
  memo: string
  status: TransferStatus
  debtorAccountCode: string | null
  creditorAccountCode: string | null
  conceptSplit: Array<{ conceptId: string; conceptName: string | null; cents: number }> | null
  method: string | null
  debtorBankName: string | null
  creditorBankName: string | null
  bankReference: string | null
  preparedByName: string | null
  preparedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  selfApproved: boolean
  reversedByName: string | null
  reversedAt: string | null
  reversalReason: string | null
  memberOfBoth: boolean
  canApprove: boolean
  canReverse: boolean
}

type FleetStatus = 'not_ended' | 'no_rate' | 'zero_rate' | 'no_trips' | 'charged' | 'due'
interface FleetAgreement {
  id: string
  isActive: boolean
  provider: { id: string; name: string | null }
  client: { id: string; name: string | null }
  memberOfBoth: boolean
  canDecide: boolean
  rates: Array<{ id: string; fromPeriod: string; ratePerTripCents: number; note: string | null; setByName: string | null; createdAt: string }>
  months: Array<{
    month: string; trips: number; ratePerTripCents: number | null; amountCents: number; status: FleetStatus; transferId: string | null
    byBrand: Array<{ conceptId: string; trips: number; conceptName: string | null }>
  }>
}

interface TieOutRow { code: string; label: string; ledgerCents: number; subledgerCents: number; differenceCents: number; asOf: string; note?: string }
interface LegacyDiff {
  code: '2050' | '2060'
  splitAt: string
  splitLabel: string
  ledgerCents: number
  subledgerCents: number
  differenceCents: number
  writtenOff: { entryId: string; entryDate: string } | null
}
interface TieOutCompany {
  tenantId: string
  name: string | null
  tieOut: { rows: TieOutRow[]; clean: boolean }
  legacy: LegacyDiff[]
  canWriteOff: boolean
}
interface WriteOffPreview extends LegacyDiff {
  lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; memo?: string }>
  evidence: {
    crossCompanyRedemptions: { count: number; points: number }
    walletCreditsBeforeSplit: { count: number; cents: number }
    walletSpendsBeforeSplit: { count: number; cents: number }
  }
  driftAfterSplitCents: number
  entryId?: string
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const TABS = [
  { key: 'balances', label: 'Balances' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'fleet', label: 'Shared fleet' },
  { key: 'tieout', label: 'Tie-out & legacy' },
] as const
type Tab = (typeof TABS)[number]['key']

const KIND_LABEL: Record<TransferKind, string> = { charge: 'Charge', settlement: 'Settlement', netting: 'Netting' }
/** How a settlement is paid — the API's SETTLEMENT_METHODS (receipt methods without card). */
const SETTLEMENT_METHODS = ['bank_transfer', 'bank_deposit', 'cheque', 'cash'] as const
type SettlementMethod = (typeof SETTLEMENT_METHODS)[number]
/** Which company names a bank: the payer for a transfer or cheque, the receiver for those and for a deposit. */
const payerUsesBank = (m: SettlementMethod) => m === 'bank_transfer' || m === 'cheque'
const payeeUsesBank = (m: SettlementMethod) => m !== 'cash'
const STATUS_BADGE: Record<TransferStatus, { cls: string; label: string }> = {
  submitted: { cls: 's-badge-amber', label: 'Waiting for the CEO' },
  posted: { cls: 's-badge-green', label: 'Posted' },
  rejected: { cls: 's-badge-muted', label: 'Rejected' },
  reversed: { cls: 's-badge-muted', label: 'Reversed' },
}
const FLEET_BADGE: Record<FleetStatus, { cls: string; label: string }> = {
  charged: { cls: 's-badge-green', label: 'Charged' },
  due: { cls: 's-badge-amber', label: 'Not charged yet' },
  no_rate: { cls: 's-badge-red', label: 'No rate set' },
  zero_rate: { cls: 's-badge-muted', label: 'Rate 0 — not charged' },
  no_trips: { cls: 's-badge-muted', label: 'No trips' },
  not_ended: { cls: 's-badge-muted', label: 'Month not over' },
}

const danger = 'var(--erp-danger)'
const fieldCls = 's-input'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return (err.code && PAYMENT_REFERENCE_ERROR_TEXT[err.code]) || err.message
  return (err as Error)?.message ?? 'Something went wrong'
}

type Msg = { ok: boolean; text: string; uses?: PaymentRefUse[] }

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function dateLabel(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric' })
}

function pktMonth(offset = 0): string {
  const p = new Date(Date.now() + 5 * 3600_000)
  const d = new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth() + offset, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function Money({ cents, tone }: { cents: number | null; tone?: 'auto' | 'plain' }) {
  if (cents === null) return <span className="text-white/35">—</span>
  const style = tone === 'auto' && cents !== 0 ? { color: danger } : undefined
  return <span className="tabular-nums" style={style}>{fmtPkr(cents)}</span>
}

function Notice({ msg, onClose }: { msg: Msg | null; onClose: () => void }) {
  if (!msg) return null
  return (
    <div role={msg.ok ? 'status' : 'alert'} className="s-card space-y-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <span className={msg.ok ? 'text-success' : ''} style={msg.ok ? undefined : { color: danger }}>{msg.text}</span>
        <button type="button" onClick={onClose} className="text-xs text-white/40 hover:text-white/70" aria-label="Dismiss">Close</button>
      </div>
      <ReferenceUsedBeforeNotice uses={msg.uses} />
    </div>
  )
}

// ─── The page ────────────────────────────────────────────────────────────────

export default function IntercompanyPage() {
  const [tab, setTab] = useState<Tab>('balances')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [settlePrefill, setSettlePrefill] = useState<{ debtor: string; creditor: string; cents: number } | null>(null)

  // ?tab=… deep links (the close checklist links here).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && TABS.some((x) => x.key === t)) setTab(t as Tab)
  }, [])
  const pick = (t: Tab) => {
    setTab(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState(null, '', url.toString())
  }

  const companies = useQuery({ queryKey: ['ic', 'companies'], queryFn: () => api.get<Companies>('/accounting/intercompany/companies') })
  const can = companies.data?.can ?? { prepare: false, decide: false }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/accounting" className="text-xs text-white/40 hover:text-white/70">← Accounting</Link>
        <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-success">Group companies</p>
        <h1 className="text-2xl font-black text-white/90">Inter-company</h1>
        <p className="mt-1 max-w-3xl text-sm text-white/45">
          What the group companies owe each other. Every transfer posts in both companies&apos; books at once, under the same reference, so the
          two sides always agree. Finance prepares a transfer; the CEO approves it. Balances are settled monthly.
        </p>
        <p className="mt-3 max-w-3xl rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
          The All-companies balance sheet adds the companies together as they are: each &apos;Due from&apos; and &apos;Due to&apos; shows gross. There are no
          consolidation eliminations yet, so the group&apos;s own debts to itself are not netted out there.
        </p>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 px-4 py-5 sm:px-7">
        <div role="tablist" aria-label="Inter-company sections" className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--border)' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => pick(t.key)}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.key ? 'text-white/90' : 'border-transparent text-white/45 hover:text-white/75'}`}
              style={tab === t.key ? { borderColor: 'var(--erp-accent)' } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>

        <Notice msg={msg} onClose={() => setMsg(null)} />

        {companies.isError && <p className="text-sm" style={{ color: danger }}>{errMessage(companies.error)}</p>}

        {tab === 'balances' && (
          <BalancesTab
            canPrepare={can.prepare}
            onSettle={(p) => { setSettlePrefill(p); pick('transfers') }}
          />
        )}
        {tab === 'transfers' && (
          <TransfersTab companies={companies.data ?? null} prefill={settlePrefill} clearPrefill={() => setSettlePrefill(null)} setMsg={setMsg} />
        )}
        {tab === 'fleet' && <FleetTab canDecide={can.decide} setMsg={setMsg} />}
        {tab === 'tieout' && <TieOutTab setMsg={setMsg} />}
      </div>
    </div>
  )
}

// ─── Balances ────────────────────────────────────────────────────────────────

function BalancesTab({ canPrepare, onSettle }: { canPrepare: boolean; onSettle: (p: { debtor: string; creditor: string; cents: number }) => void }) {
  const [asOf, setAsOf] = useState('')
  const q = useQuery({
    queryKey: ['ic', 'balances', asOf],
    queryFn: () => api.get<{ pairs: Pair[] }>(`/accounting/intercompany/balances${asOf ? `?asOf=${asOf}` : ''}`),
  })
  const pairs = q.data?.pairs ?? []
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className={labelCls}>As of (optional)</span>
          <input type="date" value={asOf} max={todayPktIso()} onChange={(e) => setAsOf(e.target.value)} className={fieldCls} />
        </label>
      </div>
      <div className="s-card overflow-hidden">
        {q.isError ? (
          <p className="p-6 text-center text-sm" style={{ color: danger }}>{errMessage(q.error)}</p>
        ) : q.isLoading ? (
          <p className="p-6 text-center text-sm text-white/40">Loading…</p>
        ) : pairs.length === 0 ? (
          <div className="p-8 text-center">
            <p className="font-bold text-white/85">No inter-company balances</p>
            <p className="mt-1 text-sm text-white/45">A pair of companies appears here after its first transfer or shared-fleet charge.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-white/40" style={{ borderBottom: '1px solid var(--border)' }}>
                  <th className="px-4 py-3 font-semibold">Companies</th>
                  <th className="px-3 py-3 text-right font-semibold">First company&apos;s books: owed to it</th>
                  <th className="px-3 py-3 text-right font-semibold">First company&apos;s books: it owes</th>
                  <th className="px-3 py-3 text-right font-semibold">Second company&apos;s books: owed to it</th>
                  <th className="px-3 py-3 text-right font-semibold">Second company&apos;s books: it owes</th>
                  <th className="px-3 py-3 text-right font-semibold">Net</th>
                  <th className="px-3 py-3 font-semibold">The two books</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => {
                  const owes = p.netOwedByA > 0 ? { debtor: p.a, creditor: p.b } : { debtor: p.b, creditor: p.a }
                  const net = Math.abs(p.netOwedByA)
                  return (
                    <tr key={`${p.a.id}:${p.b.id}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-white/85">{p.a.name} ↔ {p.b.name}</p>
                        {!p.memberOfBoth && <p className="text-xs text-white/40">You see only {p.a.name}&apos;s books — you are not a member of {p.b.name}.</p>}
                      </td>
                      <td className="px-3 py-3 text-right"><Money cents={p.aDueFromB} /></td>
                      <td className="px-3 py-3 text-right"><Money cents={p.aDueToB} /></td>
                      <td className="px-3 py-3 text-right"><Money cents={p.bDueFromA} /></td>
                      <td className="px-3 py-3 text-right"><Money cents={p.bDueToA} /></td>
                      <td className="px-3 py-3 text-right text-white/85">
                        {net === 0 ? <span className="text-success">Settled</span> : <span>{owes.debtor.name} owes {fmtPkr(net)}</span>}
                      </td>
                      <td className="px-3 py-3">
                        {p.mismatchCents === null ? <span className="s-badge-muted">Not visible</span>
                          : p.mismatchCents === 0 ? <span className="s-badge-green">Agree</span>
                          : <span className="s-badge-red">Differ by {fmtPkr(p.mismatchCents)}</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canPrepare && p.memberOfBoth && net > 0 && (
                          <button type="button" className="s-btn-secondary text-xs" onClick={() => onSettle({ debtor: owes.debtor.id, creditor: owes.creditor.id, cents: net })}>
                            Record settlement
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-xs text-white/40">
        Each inter-company posting moves both companies&apos; books together, so the two always agree. A red difference means one book holds an entry the
        other does not — look for a hand entry or a one-sided reversal.
      </p>
    </section>
  )
}

// ─── Transfers ───────────────────────────────────────────────────────────────

function TransfersTab({ companies, prefill, clearPrefill, setMsg }: {
  companies: Companies | null
  prefill: { debtor: string; creditor: string; cents: number } | null
  clearPrefill: () => void
  setMsg: (m: Msg | null) => void
}) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<'' | TransferStatus>('')
  const [showForm, setShowForm] = useState(false)
  useEffect(() => { if (prefill) setShowForm(true) }, [prefill])

  const list = useQuery({
    queryKey: ['ic', 'transfers', status],
    queryFn: () => api.get<{ items: Transfer[] }>(`/accounting/intercompany/transfers?limit=200${status ? `&status=${status}` : ''}`),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ic'] })

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="block">
          <span className={labelCls}>Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as '' | TransferStatus)} className="s-select">
            <option value="">All transfers</option>
            <option value="submitted">Waiting for the CEO</option>
            <option value="posted">Posted</option>
            <option value="rejected">Rejected</option>
            <option value="reversed">Reversed</option>
          </select>
        </label>
        {companies?.can.prepare && !showForm && (
          <button type="button" className="s-btn-primary text-sm" onClick={() => setShowForm(true)}>New transfer</button>
        )}
      </div>

      {showForm && companies && (
        <TransferForm
          companies={companies}
          prefill={prefill}
          onDone={(text, uses) => { setShowForm(false); clearPrefill(); setMsg({ ok: true, text, uses }); refresh() }}
          onCancel={() => { setShowForm(false); clearPrefill() }}
          onError={(text) => setMsg({ ok: false, text })}
        />
      )}

      {list.isError ? (
        <p className="s-card p-6 text-center text-sm" style={{ color: danger }}>{errMessage(list.error)}</p>
      ) : list.isLoading ? (
        <p className="s-card p-6 text-center text-sm text-white/40">Loading…</p>
      ) : (list.data?.items ?? []).length === 0 ? (
        <p className="s-card p-6 text-center text-sm text-white/45">No transfers {status ? 'with this status' : 'yet'}.</p>
      ) : (
        <ul className="space-y-2">
          {list.data!.items.map((t) => (
            <TransferRow key={t.id} t={t} onChanged={(text) => { setMsg({ ok: true, text }); refresh() }} onError={(text) => setMsg({ ok: false, text })} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TransferRow({ t, onChanged, onError }: { t: Transfer; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<'' | 'reject' | 'reverse'>('')
  const [text, setText] = useState('')
  const act = useMutation({
    mutationFn: (a: { path: string; body: Record<string, unknown> }) => api.post<Transfer>(`/accounting/intercompany/transfers/${t.id}/${a.path}`, a.body),
    onSuccess: (_r, a) => {
      setMode(''); setText('')
      onChanged(a.path === 'approve' ? 'Approved — posted in both companies\' books.' : a.path === 'reject' ? 'Rejected.' : 'Reversed in both companies\' books.')
    },
    onError: (err) => onError(errMessage(err)),
  })
  const badge = STATUS_BADGE[t.status]
  const fromSystem = t.source === 'fleet' ? 'Shared fleet (automatic)' : t.source === 'cod' ? 'Rider cash on delivery' : null
  return (
    <li className="s-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="s-badge-purple">{KIND_LABEL[t.kind]}</span>
            <span className={badge.cls}>{badge.label}</span>
            {t.selfApproved && <span className="s-badge-muted">Posted by the CEO directly</span>}
            {fromSystem && <span className="s-badge-muted">{fromSystem}</span>}
          </div>
          <p className="mt-2 font-semibold text-white/85">
            {t.kind === 'charge' ? `${t.creditorName} charges ${t.debtorName}` : t.kind === 'settlement' ? `${t.debtorName} pays ${t.creditorName}` : `${t.debtorName} and ${t.creditorName} net off`}
          </p>
          <p className="text-sm text-white/55">{t.memo}</p>
          <p className="mt-1 text-xs text-white/40">
            Dated {dateLabel(t.entryDate)} · prepared by {t.preparedByName ?? '—'}
            {t.decidedByName && <> · {t.status === 'rejected' ? 'rejected' : 'approved'} by {t.decidedByName}</>}
            {t.decisionNote && <> — “{t.decisionNote}”</>}
            {t.reversedByName && <> · reversed by {t.reversedByName}: {t.reversalReason}</>}
          </p>
          {t.kind === 'charge' && (
            <p className="text-xs text-white/40">
              {t.debtorName}: account {t.debtorAccountCode} · {t.creditorName}: account {t.creditorAccountCode}
              {t.conceptSplit && <> · {t.conceptSplit.map((s) => `${s.conceptName ?? 'brand'} ${fmtPkr(s.cents)}`).join(', ')}</>}
            </p>
          )}
          {t.kind === 'settlement' && (
            <p className="text-xs text-white/40">
              By {receiptMethodLabel(t.method).toLowerCase() || '—'}{t.debtorBankName ? ` from ${t.debtorBankName}` : ''}{t.creditorBankName ? ` into ${t.creditorBankName}` : ''}{t.bankReference ? ` · ref ${t.bankReference}` : ''}
            </p>
          )}
        </div>
        <p className="text-lg font-bold tabular-nums text-white/90">{fmtPkr(t.amountCents)}</p>
      </div>

      {(t.canApprove || t.canReverse) && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {t.canApprove && mode === '' && (
            <>
              <button type="button" className="s-btn-primary text-sm" disabled={act.isPending}
                onClick={() => { if (window.confirm('Approve and post this transfer in both companies\' books?')) act.mutate({ path: 'approve', body: {} }) }}>
                Approve
              </button>
              <button type="button" className="s-btn-secondary text-sm" onClick={() => setMode('reject')}>Reject</button>
            </>
          )}
          {t.canReverse && mode === '' && (
            <button type="button" className="s-btn-danger text-sm" onClick={() => setMode('reverse')}>Reverse</button>
          )}
          {mode !== '' && (
            <>
              <label className="block min-w-[14rem] flex-1">
                <span className={labelCls}>{mode === 'reject' ? 'Why is it rejected?' : 'Why is it reversed? (at least 10 characters)'}</span>
                <input value={text} onChange={(e) => setText(e.target.value)} className={fieldCls} />
              </label>
              <button
                type="button"
                className={mode === 'reject' ? 's-btn-secondary text-sm' : 's-btn-danger text-sm'}
                disabled={act.isPending || text.trim().length < (mode === 'reject' ? 3 : 10)}
                onClick={() => act.mutate(mode === 'reject' ? { path: 'reject', body: { note: text.trim() } } : { path: 'reverse', body: { reason: text.trim() } })}
              >
                {mode === 'reject' ? 'Reject transfer' : 'Reverse in both books'}
              </button>
              <button type="button" className="s-btn-ghost text-sm" onClick={() => { setMode(''); setText('') }}>Cancel</button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** One company's banks for a settlement (that company's own, read across both companies). */
function PairBankSelect({ id, label, banks, value, onChange }: {
  id: string; label: string; banks: BankAccountOption[]; value: string; onChange: (v: string) => void
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className={labelCls}>{label}{banks.length > 1 ? ' *' : ''}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="s-select" required={banks.length > 1}>
        <option value="">{banks.length === 1 ? `${banks[0]!.name} (only bank)` : banks.length === 0 ? 'Operating account (1020)' : '— pick the bank —'}</option>
        {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.accountCode ? ` (${b.accountCode})` : ''}</option>)}
      </select>
    </label>
  )
}

function TransferForm({ companies, prefill, onDone, onCancel, onError }: {
  companies: Companies
  prefill: { debtor: string; creditor: string; cents: number } | null
  onDone: (text: string, uses?: PaymentRefUse[]) => void
  onCancel: () => void
  onError: (text: string) => void
}) {
  const list = companies.companies
  const first = companies.activeTenantId ?? list[0]?.id ?? ''
  const [kind, setKind] = useState<TransferKind>(prefill ? 'settlement' : 'charge')
  const [debtor, setDebtor] = useState(prefill?.debtor ?? first)
  const [creditor, setCreditor] = useState(prefill?.creditor ?? (list.find((c) => c.id !== first)?.id ?? ''))
  const [amount, setAmount] = useState(prefill?.cents ?? 0)
  const [entryDate, setEntryDate] = useState(todayPktIso())
  const [memo, setMemo] = useState('')
  const [debtorCode, setDebtorCode] = useState('')
  const [creditorCode, setCreditorCode] = useState('6990')
  const [method, setMethod] = useState<SettlementMethod>('bank_transfer')
  const [debtorBank, setDebtorBank] = useState('')
  const [creditorBank, setCreditorBank] = useState('')
  const [bankRef, setBankRef] = useState('')
  const [postNow, setPostNow] = useState(false)

  // Both companies' banks (the caller belongs to both).
  const banks = useQuery({
    queryKey: ['ic', 'banks'],
    queryFn: () => api.getAcrossTenants<BankAccountOption[]>('/setup/bank-accounts'),
    enabled: kind === 'settlement',
    retry: false,
  })
  const debtorBanks = useMemo(() => banksOf(banks.data ?? [], debtor), [banks.data, debtor])
  const creditorBanks = useMemo(() => banksOf(banks.data ?? [], creditor), [banks.data, creditor])
  const nameOf = (id: string) => list.find((c) => c.id === id)?.name ?? 'company'

  const save = useMutation({
    mutationFn: () => api.post<Transfer & { referenceUsedBefore?: PaymentRefUse[] }>('/accounting/intercompany/transfers', {
      kind, debtorTenantId: debtor, creditorTenantId: creditor, amountCents: amount, entryDate, memo: memo.trim(),
      ...(kind === 'charge' && { debtorAccountCode: debtorCode.trim(), creditorAccountCode: creditorCode.trim() }),
      ...(kind === 'settlement' && {
        method, debtorBankAccountId: payerUsesBank(method) && debtorBank ? debtorBank : null,
        creditorBankAccountId: payeeUsesBank(method) && creditorBank ? creditorBank : null, bankReference: bankRef.trim(),
      }),
      ...(postNow && { postNow: true }),
    }),
    onSuccess: (t) => onDone(
      t.status === 'posted' ? 'Posted in both companies\' books.' : 'Submitted — it waits for the CEO in the approvals inbox.',
      t.referenceUsedBefore,
    ),
    onError: (err) => onError(errMessage(err)),
  })

  const words = kind === 'charge'
    ? { debtor: 'Company being charged', creditor: 'Company charging' }
    : kind === 'settlement' ? { debtor: 'Company paying', creditor: 'Company being paid' }
    : { debtor: 'First company', creditor: 'Second company' }
  const ready = debtor && creditor && debtor !== creditor && amount > 0 && memo.trim().length >= 3
    && (kind !== 'charge' || (debtorCode.trim() && creditorCode.trim()))
    && (kind !== 'settlement' || bankRef.trim().length > 0)

  return (
    <form className="s-card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate() }}>
      <h2 className="text-sm font-bold text-white/85">New inter-company transfer</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className={labelCls}>Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TransferKind)} className="s-select">
            <option value="charge">Charge — one company bore a cost for the other</option>
            <option value="settlement">Settlement — money paid between them</option>
            <option value="netting">Netting — offset what each owes the other</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>{words.debtor}</span>
          <select value={debtor} onChange={(e) => setDebtor(e.target.value)} className="s-select">
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>{words.creditor}</span>
          <select value={creditor} onChange={(e) => setCreditor(e.target.value)} className="s-select">
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Amount (PKR)</span>
          <MoneyInput value={amount} onChange={setAmount} className={fieldCls} ariaLabel="Amount in rupees" />
        </label>
        <label className="block">
          <span className={labelCls}>Date</span>
          <input type="date" value={entryDate} max={todayPktIso()} onChange={(e) => setEntryDate(e.target.value)} className={fieldCls} />
        </label>
        <label className="block">
          <span className={labelCls}>What it is for</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} placeholder="e.g. September shared office rent" className={fieldCls} />
        </label>
        {kind === 'charge' && (
          <>
            <label className="block">
              <span className={labelCls}>{nameOf(debtor)}: expense account</span>
              <input value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} inputMode="numeric" placeholder="e.g. 6010" className={fieldCls} />
            </label>
            <label className="block">
              <span className={labelCls}>{nameOf(creditor)}: recovery account</span>
              <input value={creditorCode} onChange={(e) => setCreditorCode(e.target.value)} inputMode="numeric" placeholder="6990" className={fieldCls} />
            </label>
          </>
        )}
        {kind === 'settlement' && (
          <>
            <label className="block" htmlFor="ic-method">
              <span className={labelCls}>Paid by</span>
              <select id="ic-method" value={method} onChange={(e) => setMethod(e.target.value as SettlementMethod)} className="s-select">
                {SETTLEMENT_METHODS.map((m) => <option key={m} value={m}>{receiptMethodLabel(m)}</option>)}
              </select>
            </label>
            <label className="block" htmlFor="ic-ref">
              <span className={labelCls}>Payment reference # *</span>
              <input id="ic-ref" value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={100} required autoComplete="off"
                placeholder={method === 'bank_deposit' ? 'Deposit slip no.' : method === 'cheque' ? 'Cheque no.' : method === 'cash' ? 'Cash receipt / voucher no.' : 'Transfer / IBFT reference'}
                className={fieldCls} />
            </label>
            {payerUsesBank(method) && (
              <PairBankSelect id="ic-debtor-bank" label={`${nameOf(debtor)}'s bank`} banks={debtorBanks} value={debtorBank} onChange={setDebtorBank} />
            )}
            {payeeUsesBank(method) && (
              <PairBankSelect id="ic-creditor-bank" label={`${nameOf(creditor)}'s bank${method === 'bank_deposit' ? ' (deposited into)' : ''}`} banks={creditorBanks} value={creditorBank} onChange={setCreditorBank} />
            )}
          </>
        )}
      </div>
      {kind === 'netting' && (
        <p className="text-xs text-white/45">Netting cancels what each company owes the other, up to the smaller of the two amounts. No money moves.</p>
      )}
      {kind === 'settlement' && method === 'bank_deposit' && (
        <p className="text-xs text-white/45">
          A bank deposit is {nameOf(debtor)}&apos;s cash paid into {nameOf(creditor)}&apos;s bank: it leaves {nameOf(debtor)}&apos;s cash and lands in the bank picked.
        </p>
      )}
      {companies.can.decide && (
        <label className="flex items-start gap-2 text-sm text-white/70">
          <input type="checkbox" className="mt-1" style={{ accentColor: 'var(--erp-accent)' }} checked={postNow} onChange={(e) => setPostNow(e.target.checked)} />
          <span>Post it now (you are approving it yourself — recorded as such)</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="s-btn-primary text-sm" disabled={!ready || save.isPending}>
          {save.isPending ? 'Saving…' : postNow ? 'Post in both books' : 'Submit for approval'}
        </button>
        <button type="button" className="s-btn-ghost text-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// ─── Shared fleet ────────────────────────────────────────────────────────────

function FleetTab({ canDecide, setMsg }: { canDecide: boolean; setMsg: (m: Msg | null) => void }) {
  const qc = useQueryClient()
  const [from, setFrom] = useState(pktMonth(-5))
  const [to, setTo] = useState(pktMonth(0))
  const q = useQuery({
    queryKey: ['ic', 'fleet', from, to],
    queryFn: () => api.get<{ agreements: FleetAgreement[] }>(`/accounting/intercompany/fleet?from=${from}&to=${to}`),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ic'] })
  const charge = useMutation({
    mutationFn: (body: { month?: string; agreementId?: string }) =>
      api.post<{ charged: number; results: Array<{ month: string; charged: boolean; error?: { message: string } }> }>('/accounting/intercompany/fleet/charge', body),
    onSuccess: (r) => {
      const failed = r.results.filter((x) => x.error)
      setMsg(failed.length > 0
        ? { ok: false, text: `${r.charged} month(s) charged; ${failed.length} refused — ${failed.map((f) => `${monthLabel(f.month)}: ${f.error!.message}`).join('; ')}` }
        : { ok: true, text: r.charged > 0 ? `${r.charged} month(s) charged in both companies' books.` : 'Nothing was waiting to be charged.' })
      refresh()
    },
    onError: (err) => setMsg({ ok: false, text: errMessage(err) }),
  })
  const agreements = q.data?.agreements ?? []
  return (
    <section className="space-y-3">
      <p className="max-w-3xl text-sm text-white/45">
        A company whose riders carry another company&apos;s orders charges it per trip, monthly: the client books the rider cost (6035) on each of its
        brands, the provider books the recovery (6990). The charge runs by itself every night for ended months once a rate is set.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className={labelCls}>From</span>
          <input type="month" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={fieldCls} />
        </label>
        <label className="block">
          <span className={labelCls}>To</span>
          <input type="month" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={fieldCls} />
        </label>
        {canDecide && (
          <button type="button" className="s-btn-primary text-sm" disabled={charge.isPending} onClick={() => charge.mutate({})}>
            {charge.isPending ? 'Charging…' : 'Charge now'}
          </button>
        )}
      </div>
      {q.isError ? (
        <p className="s-card p-6 text-center text-sm" style={{ color: danger }}>{errMessage(q.error)}</p>
      ) : q.isLoading ? (
        <p className="s-card p-6 text-center text-sm text-white/40">Loading…</p>
      ) : agreements.length === 0 ? (
        <p className="s-card p-6 text-center text-sm text-white/45">No shared-fleet agreements touch your companies (Riders → Fleet).</p>
      ) : (
        agreements.map((ag) => (
          <FleetCard key={ag.id} ag={ag} charging={charge.isPending} onCharge={(month) => charge.mutate({ month, agreementId: ag.id })} setMsg={setMsg} refresh={refresh} />
        ))
      )}
    </section>
  )
}

function FleetCard({ ag, charging, onCharge, setMsg, refresh }: {
  ag: FleetAgreement
  charging: boolean
  onCharge: (month: string) => void
  setMsg: (m: { ok: boolean; text: string } | null) => void
  refresh: () => void
}) {
  const [rate, setRate] = useState(0)
  const [fromPeriod, setFromPeriod] = useState(pktMonth(0))
  const [note, setNote] = useState('')
  const setIt = useMutation({
    mutationFn: () => api.put(`/accounting/intercompany/fleet/${ag.id}/rate`, { ratePerTripCents: rate, fromPeriod, note: note.trim() || null }),
    onSuccess: () => { setMsg({ ok: true, text: `Rate set from ${monthLabel(fromPeriod)}.` }); setNote(''); refresh() },
    onError: (err) => setMsg({ ok: false, text: errMessage(err) }),
  })
  const current = ag.rates[0] ?? null
  return (
    <div className="s-card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-white/85">{ag.provider.name}&apos;s riders → {ag.client.name}&apos;s orders</p>
          <p className="text-xs text-white/40">
            {current ? `Rate ${fmtPkr(current.ratePerTripCents)} per trip from ${monthLabel(current.fromPeriod)}` : 'No rate set yet — nothing is charged.'}
          </p>
        </div>
        <span className={ag.isActive ? 's-badge-green' : 's-badge-muted'}>{ag.isActive ? 'Agreement active' : 'Agreement ended'}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-white/40" style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="px-2 py-2 font-semibold">Month</th>
              <th className="px-2 py-2 text-right font-semibold">Trips</th>
              <th className="px-2 py-2 text-right font-semibold">Rate</th>
              <th className="px-2 py-2 text-right font-semibold">Charge</th>
              <th className="px-2 py-2 font-semibold">State</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {ag.months.map((m) => (
              <tr key={m.month} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-2 py-2 text-white/80">
                  {monthLabel(m.month)}
                  {m.byBrand.length > 1 && <p className="text-xs text-white/40">{m.byBrand.map((b) => `${b.conceptName ?? 'brand'} ${b.trips}`).join(' · ')}</p>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{m.trips}</td>
                <td className="px-2 py-2 text-right">{m.ratePerTripCents === null ? <span className="text-white/35">—</span> : fmtPkr(m.ratePerTripCents)}</td>
                <td className="px-2 py-2 text-right">{m.amountCents ? fmtPkr(m.amountCents) : <span className="text-white/35">—</span>}</td>
                <td className="px-2 py-2"><span className={FLEET_BADGE[m.status].cls}>{FLEET_BADGE[m.status].label}</span></td>
                <td className="px-2 py-2 text-right">
                  {ag.canDecide && m.status === 'due' && (
                    <button type="button" className="s-btn-secondary text-xs" disabled={charging} onClick={() => onCharge(m.month)}>Charge</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ag.rates.length > 0 && (
        <details className="text-xs text-white/55">
          <summary className="cursor-pointer text-white/45">Rate history</summary>
          <ul className="mt-2 space-y-1">
            {ag.rates.map((r) => (
              <li key={r.id}>From {monthLabel(r.fromPeriod)}: {fmtPkr(r.ratePerTripCents)} per trip — set by {r.setByName ?? '—'} on {dateLabel(r.createdAt)}{r.note ? ` (${r.note})` : ''}</li>
            ))}
          </ul>
        </details>
      )}

      {ag.canDecide ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setIt.mutate() }}>
          <label className="block">
            <span className={labelCls}>New rate per trip (PKR)</span>
            <MoneyInput value={rate} onChange={setRate} className={fieldCls} ariaLabel="Rate per trip in rupees" />
          </label>
          <label className="block">
            <span className={labelCls}>From month</span>
            <input type="month" value={fromPeriod} onChange={(e) => setFromPeriod(e.target.value)} className={fieldCls} />
          </label>
          <label className="block min-w-[12rem] flex-1">
            <span className={labelCls}>Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={fieldCls} />
          </label>
          <button type="submit" className="s-btn-secondary text-sm" disabled={setIt.isPending || !/^\d{4}-\d{2}$/.test(fromPeriod)}>Set rate</button>
        </form>
      ) : (
        <p className="text-xs text-white/40">Only the CEO, as a member of both companies, sets the rate and charges a month.</p>
      )}
    </div>
  )
}

// ─── Tie-out & legacy ────────────────────────────────────────────────────────

function TieOutTab({ setMsg }: { setMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const [asOf, setAsOf] = useState('')
  const q = useQuery({
    queryKey: ['ic', 'tieout', asOf],
    queryFn: () => api.get<{ companies: TieOutCompany[] }>(`/accounting/intercompany/tie-out${asOf ? `?asOf=${asOf}` : ''}`),
  })
  return (
    <section className="space-y-3">
      <p className="max-w-3xl text-sm text-white/45">
        Each liability against the record behind it: wallets (2050), loyalty points (2060) and gift cards (2080). Before wallets and loyalty went per company,
        value issued by one company could be spent at another; that pre-launch residue can be written off once inside each company. Anything that differs
        after the split is a real difference to find.
      </p>
      <label className="block w-fit">
        <span className={labelCls}>As of (optional)</span>
        <input type="date" value={asOf} max={todayPktIso()} onChange={(e) => setAsOf(e.target.value)} className={fieldCls} />
      </label>
      {q.isError ? (
        <p className="s-card p-6 text-center text-sm" style={{ color: danger }}>{errMessage(q.error)}</p>
      ) : q.isLoading ? (
        <p className="s-card p-6 text-center text-sm text-white/40">Loading…</p>
      ) : (
        (q.data?.companies ?? []).map((c) => <TieOutCard key={c.tenantId} c={c} setMsg={setMsg} />)
      )}
    </section>
  )
}

function TieOutCard({ c, setMsg }: { c: TieOutCompany; setMsg: (m: { ok: boolean; text: string } | null) => void }) {
  return (
    <div className="s-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white/85">{c.name}</p>
        {c.tieOut.clean ? <span className="s-badge-green">Ties out</span> : <span className="s-badge-red">Differences</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-white/40" style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="px-2 py-2 font-semibold">Account</th>
              <th className="px-2 py-2 text-right font-semibold">Ledger</th>
              <th className="px-2 py-2 text-right font-semibold">Record</th>
              <th className="px-2 py-2 text-right font-semibold">Difference</th>
            </tr>
          </thead>
          <tbody>
            {c.tieOut.rows.map((r) => (
              <tr key={r.code} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-2 py-2">
                  <span className="text-white/80">{r.code} {r.label}</span>
                  {r.note && <p className="text-xs text-white/40">{r.note}</p>}
                </td>
                <td className="px-2 py-2 text-right"><Money cents={r.ledgerCents} /></td>
                <td className="px-2 py-2 text-right"><Money cents={r.subledgerCents} /></td>
                <td className="px-2 py-2 text-right">{r.differenceCents === 0 ? <span className="text-success">Agrees</span> : <Money cents={r.differenceCents} tone="auto" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-wider text-white/45">Pre-launch residue (measured when the split went live)</p>
        {c.legacy.map((l) => <LegacyRow key={l.code} tenantId={c.tenantId} l={l} canWriteOff={c.canWriteOff} setMsg={setMsg} />)}
      </div>
    </div>
  )
}

function LegacyRow({ tenantId, l, canWriteOff, setMsg }: { tenantId: string; l: LegacyDiff; canWriteOff: boolean; setMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const qc = useQueryClient()
  const [preview, setPreview] = useState<WriteOffPreview | null>(null)
  const [reason, setReason] = useState('')
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<WriteOffPreview>('/accounting/intercompany/legacy-writeoff', { tenantId, code: l.code, dryRun, ...(dryRun ? {} : { reason: reason.trim() }) }),
    onSuccess: (r, dryRun) => {
      if (dryRun) { setPreview(r); return }
      setPreview(null); setReason('')
      setMsg({ ok: true, text: `The ${l.code} residue is written off (entry ${r.entryId?.slice(0, 8) ?? ''}).` })
      void qc.invalidateQueries({ queryKey: ['ic'] })
    },
    onError: (err) => setMsg({ ok: false, text: errMessage(err) }),
  })
  const label = l.code === '2050' ? 'Customer wallets (2050)' : 'Loyalty points (2060)'
  return (
    <div className="rounded-lg p-3" style={{ border: '1px solid var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm text-white/80">{label}</p>
          <p className="text-xs text-white/40">
            On {dateLabel(l.splitAt)} ({l.splitLabel}): ledger {fmtPkr(l.ledgerCents)}, record {fmtPkr(l.subledgerCents)}
          </p>
        </div>
        {l.writtenOff ? <span className="s-badge-green">Written off {dateLabel(l.writtenOff.entryDate)}</span>
          : l.differenceCents === 0 ? <span className="s-badge-green">Nothing to write off</span>
          : <span className="s-badge-amber">Residue {fmtPkr(Math.abs(l.differenceCents))}</span>}
      </div>
      {canWriteOff && !l.writtenOff && l.differenceCents !== 0 && !preview && (
        <button type="button" className="s-btn-secondary mt-2 text-xs" disabled={run.isPending} onClick={() => run.mutate(true)}>Preview write-off</button>
      )}
      {preview && (
        <div className="mt-3 space-y-2 text-sm">
          <ul className="space-y-1 text-xs text-white/70">
            {preview.lines.map((ln, i) => (
              <li key={i}>{ln.type === 'debit' ? 'Dr' : 'Cr'} {ln.accountCode} — {fmtPkr(ln.amountCents)}</li>
            ))}
          </ul>
          <p className="text-xs text-white/45">
            Evidence: {preview.evidence.crossCompanyRedemptions.count} loyalty redemption(s) spent at another company ·{' '}
            {preview.evidence.walletCreditsBeforeSplit.count} wallet top-up(s) before the split that never reached the ledger ({fmtPkr(preview.evidence.walletCreditsBeforeSplit.cents)}) ·{' '}
            {preview.evidence.walletSpendsBeforeSplit.count} wallet spend(s) before the split ({fmtPkr(preview.evidence.walletSpendsBeforeSplit.cents)}).
          </p>
          {preview.driftAfterSplitCents !== 0 && (
            <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>
              {fmtPkr(Math.abs(preview.driftAfterSplitCents))} of today&apos;s difference arose after the split — it is not written off and stays on the close checklist.
            </p>
          )}
          <label className="block">
            <span className={labelCls}>Why (at least 10 characters)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={fieldCls} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="s-btn-primary text-sm" disabled={run.isPending || reason.trim().length < 10}
              onClick={() => { if (window.confirm(`Write off ${fmtPkr(Math.abs(preview.differenceCents))} in ${label}? This posts once and cannot be repeated.`)) run.mutate(false) }}>
              Write off
            </button>
            <button type="button" className="s-btn-ghost text-sm" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
