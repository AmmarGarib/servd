'use client'
// Finance → Bank reconciliation: the dashboard, the bank-wise status, every
// reconciliation (one bank, one period) and the reports. A reconciliation is
// prepared by finance, submitted, then approved and locked by the CEO; the
// workspace is [id]/page.tsx. API: /reconciliation/brs (backend brsRoutes.ts).

import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, LinkButton } from '@/components/finance/ui'
import { DialogForm } from '@/components/finance/PaymentReceivedFields'
import { useBankAccounts, banksOf } from '@/components/finance/BankAccountSelect'
import {
  BRS, StatusChip, STATUS_LABEL, fmtDay, periodLabel, financialYearOf, monthRange, quarterRange, errText, useBrsRights, useBrsList,
  type BankStatusRow, type PeriodKind,
} from '@/components/finance/bankRecon/brsShared'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { Select } from '@/components/ui/Select'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, startOfMonthPktIso, todayPktIso } from '../../../lib/money'

interface Dashboard {
  bankAccounts: number; pending: number; drafts: number; awaitingApproval: number; completed: number
  banksNeverReconciled: number; outstandingChequesCents: number; uncreditedDepositsCents: number; unreconciledDifferenceCents: number
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: 'good' | 'bad'; sub?: string }) {
  return (
    <div className="s-card p-3 min-w-0">
      <p className="text-xs text-s-muted">{label}</p>
      <p className={`mt-1 text-lg font-black tabular-nums break-words ${tone === 'bad' ? 'text-s-red' : tone === 'good' ? 'text-success' : 'text-s-text'}`}>{value}</p>
      {sub && <p className="text-xs text-s-muted mt-0.5">{sub}</p>}
    </div>
  )
}

// ── New reconciliation ───────────────────────────────────────────────────────

function NewReconciliation({ presetBankId, onClose }: { presetBankId?: string; onClose: () => void }) {
  const router = useRouter()
  const { data: all = [], isLoading } = useBankAccounts()
  const banks = banksOf(all, null)
  const [bankId, setBankId] = useState(presetBankId ?? '')
  const [kind, setKind] = useState<PeriodKind>('month')
  const today = todayPktIso()
  const [month, setMonth] = useState(today.slice(0, 7))
  const curFy = Number(financialYearOf(today).slice(0, 4))
  const [fy, setFy] = useState(curFy)
  const [quarter, setQuarter] = useState(1)
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to, setTo] = useState(today)
  const [hasClosing, setHasClosing] = useState(false)
  const [closing, setClosing] = useState(0)

  const range = kind === 'month' ? monthRange(month) : kind === 'quarter' ? quarterRange(fy, quarter) : { from, to }
  const bank = banks.find((b) => b.id === (bankId || banks[0]?.id))
  const picked = bank?.id ?? ''
  const fyLabel = range ? financialYearOf(range.from) : ''
  // Several reconciliations per period are allowed (owner, 2026-11-06): say so when this one reworks an approved period.
  const existing = useBrsList({ bankAccountId: picked || undefined }).data ?? []
  const overlaps = (r: { periodFrom: string; periodTo: string }) => !!range?.from && !!range?.to && r.periodFrom <= range.to && r.periodTo >= range.from
  const approvedHere = existing.find((r) => r.status === 'approved' && overlaps(r))
  const openHere = existing.filter((r) => (r.status === 'draft' || r.status === 'submitted') && overlaps(r)).length
  const missing = !picked ? 'Pick the bank account.'
    : !range || !range.from || !range.to ? 'Pick the period.'
    : range.from > range.to ? 'The period must start before it ends.'
    : null

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(`${BRS}/`, {
      bankAccountId: picked, periodFrom: range!.from, periodTo: range!.to, periodKind: kind,
      ...(hasClosing ? { bankClosingCents: closing } : {}),
    }),
    onSuccess: (r) => router.push(`/finance/bank-reconciliation/${r.id}`),
  })

  return (
    <Dialog title="New bank reconciliation" onClose={onClose}>
      <DialogForm busy={create.isPending} missing={missing} onSubmit={() => create.mutate()}>
        <div className="space-y-3">
          <Field label="Bank account" required>
            <Select value={picked} onChange={(e) => setBankId(e.target.value)} className="s-input w-full" disabled={isLoading}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.accountCode ? ` (${b.accountCode})` : ''}</option>)}
            </Select>
          </Field>
          {bank && (
            <p className="text-xs text-s-muted break-words">
              {bank.bankName ?? bank.name} · chart account {bank.accountCode}
            </p>
          )}
          <Field label="Period">
            <Select value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)} className="s-input w-full">
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="custom">Custom dates</option>
            </Select>
          </Field>
          {kind === 'month' && (
            <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} max={today.slice(0, 7)} /></Field>
          )}
          {kind === 'quarter' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Financial year">
                <Select value={String(fy)} onChange={(e) => setFy(Number(e.target.value))} className="s-input w-full">
                  {[curFy, curFy - 1, curFy - 2].map((y) => <option key={y} value={y}>{y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}
                </Select>
              </Field>
              <Field label="Quarter">
                <Select value={String(quarter)} onChange={(e) => setQuarter(Number(e.target.value))} className="s-input w-full">
                  <option value="1">Q1 · Jul – Sep</option>
                  <option value="2">Q2 · Oct – Dec</option>
                  <option value="3">Q3 · Jan – Mar</option>
                  <option value="4">Q4 · Apr – Jun</option>
                </Select>
              </Field>
            </div>
          )}
          {kind === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
          )}
          {range && range.from && range.to && (
            <p className="text-xs text-s-muted">
              {periodLabel(range.from, range.to)} · financial year {fyLabel} (1 July – 30 June)
            </p>
          )}
          {approvedHere && (
            <p className="rounded-lg border border-s-border bg-s-bg-soft px-3 py-2 text-xs text-s-text">
              {periodLabel(approvedHere.periodFrom, approvedHere.periodTo)} is already approved. A new one reworks it: the period opens for changes while it is worked, and once the CEO approves the new one it becomes the record — the old one is kept as “Replaced”.
            </p>
          )}
          {!approvedHere && openHere > 0 && (
            <p className="text-xs text-s-muted">{openHere} other reconciliation{openHere === 1 ? ' is' : 's are'} already being worked for this period.</p>
          )}
          <div>
            <label className="inline-flex items-center gap-2 text-sm text-s-text">
              <input type="checkbox" checked={hasClosing} onChange={(e) => setHasClosing(e.target.checked)} />
              I have the closing balance from the bank statement
            </label>
            {hasClosing && (
              <div className="mt-2">
                <Field label="Closing balance as per bank statement (PKR)">
                  <MoneyInput allowNegative value={closing} onChange={setClosing} className="s-input w-full" />
                </Field>
              </div>
            )}
            {!hasClosing && <p className="text-xs text-s-muted mt-1">You can enter it later inside the reconciliation.</p>}
          </div>
          {create.error && <ErrorBanner message={errText(create.error)} />}
        </div>
        <DialogFooter onCancel={onClose}>
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogForm>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BankReconciliationPage() {
  const qc = useQueryClient()
  const { canPrepare } = useBrsRights()
  const [dialog, setDialog] = useState<{ bankId?: string } | null>(null)
  const [bankFilter, setBankFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to, setTo] = useState(todayPktIso())
  const [exportErr, setExportErr] = useState<string | null>(null)

  const dash = useQuery<Dashboard>({ queryKey: ['brs-dashboard'], queryFn: () => api.get(`${BRS}/dashboard`) })
  const banks = useQuery<BankStatusRow[]>({ queryKey: ['brs-banks'], queryFn: () => api.get(`${BRS}/banks`) })
  const list = useBrsList({ bankAccountId: bankFilter, status: statusFilter })
  void qc

  const d = dash.data
  const bankRows = banks.data ?? []
  const bankOptions = useMemo(() => bankRows.map((b) => ({ id: b.bankAccountId, label: b.name })), [bankRows])
  const rangeQs = `from=${from}&to=${to}`

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/finance" className="text-xs text-s-muted hover:text-white/70">← Finance</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-success">Finance</p>
            <h1 className="text-2xl font-black text-white/90">Bank reconciliation</h1>
            <p className="mt-1 text-sm text-s-muted max-w-2xl">
              Reconcile each bank account against its statement, month by month. Finance prepares and submits; the CEO approves and locks the period.
            </p>
          </div>
          {canPrepare && <Button onClick={() => setDialog({})}>New reconciliation</Button>}
        </div>
      </header>

      <div className="px-4 py-5 sm:px-7 space-y-6">
        {/* Dashboard */}
        <section aria-label="Summary">
          {dash.error && <ErrorBanner message={errText(dash.error)} />}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Total bank accounts" value={d ? String(d.bankAccounts) : '…'} sub={d && d.banksNeverReconciled > 0 ? `${d.banksNeverReconciled} never reconciled` : undefined} />
            <Tile label="Pending" value={d ? String(d.pending) : '…'} sub={d ? `${d.drafts} in draft` : undefined} />
            <Tile label="Awaiting approval" value={d ? String(d.awaitingApproval) : '…'} />
            <Tile label="Completed" value={d ? String(d.completed) : '…'} tone="good" />
            <Tile label="Outstanding cheques" value={d ? fmtPkr(d.outstandingChequesCents) : '…'} />
            <Tile label="Uncredited deposits" value={d ? fmtPkr(d.uncreditedDepositsCents) : '…'} />
            <Tile label="Unreconciled differences" value={d ? fmtPkr(d.unreconciledDifferenceCents) : '…'}
              tone={d ? (d.unreconciledDifferenceCents === 0 ? 'good' : 'bad') : undefined} />
          </div>
        </section>

        {/* Bank-wise status */}
        <section className="s-card overflow-hidden">
          <div className="px-4 py-3 border-b border-s-border flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-s-text">Bank-wise reconciliation status</h2>
            <ExportMenu path={`${BRS}/banks`} filename="bank-wise-reconciliation-status" className="s-btn-secondary text-sm px-3 py-1.5" onError={setExportErr} />
          </div>
          {exportErr && <div className="px-4 pt-3"><ErrorBanner message={exportErr} /></div>}
          {banks.error ? <p className="p-6 text-sm text-s-red">{errText(banks.error)}</p>
            : banks.isLoading ? <p className="p-6 text-sm text-s-muted">Loading…</p>
            : bankRows.length === 0 ? <CompactEmptyState message="No bank accounts yet — add one in Configuration → Bank accounts." />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-s-muted border-b border-s-border">
                      <th className="px-3 py-2 font-semibold">Bank account</th>
                      <th className="px-3 py-2 font-semibold">Account no.</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Last approved to</th>
                      <th className="px-3 py-2 font-semibold text-right">Outstanding cheques</th>
                      <th className="px-3 py-2 font-semibold text-right">Uncredited deposits</th>
                      <th className="px-3 py-2 font-semibold">Open</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {bankRows.map((b) => (
                      <tr key={b.bankAccountId} className="border-b border-s-border align-top">
                        <td className="px-3 py-2.5 min-w-[11rem]">
                          <span className="font-semibold text-s-text break-words">{b.name}</span>
                          <span className="block text-xs text-s-muted break-words">{[b.companyName, b.bankName].filter(Boolean).join(' · ')}{!b.isActive && ' · inactive'}</span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-s-muted whitespace-nowrap">{b.accountNumber ?? '—'}</td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                          {b.lastApprovedPeriodTo ? fmtDay(b.lastApprovedPeriodTo) : <span className="s-badge-amber">Never reconciled</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{b.outstandingChequesCents == null ? '—' : fmtPkr(b.outstandingChequesCents)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{b.uncreditedDepositsCents == null ? '—' : fmtPkr(b.uncreditedDepositsCents)}</td>
                        <td className="px-3 py-2.5 text-xs">
                          {b.open ? <span className="inline-flex flex-wrap items-center gap-2"><StatusChip status={b.open.status} /><span className="text-s-muted whitespace-nowrap">{periodLabel(b.open.periodFrom, b.open.periodTo)}</span></span> : <span className="text-s-muted">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {b.open
                            ? <Link href={`/finance/bank-reconciliation/${b.open.id}`} className="s-btn-secondary text-xs px-3 py-1.5">Open</Link>
                            : canPrepare && b.isActive && <LinkButton size="md" onClick={() => setDialog({ bankId: b.bankAccountId })}>Start reconciliation</LinkButton>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>

        {/* Reconciliations */}
        <section className="s-card overflow-hidden">
          <div className="px-4 py-3 border-b border-s-border flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-s-text mr-auto">Reconciliations</h2>
            <Select value={bankFilter} onChange={(e) => setBankFilter(e.target.value)} className="s-input w-auto" aria-label="Bank">
              <option value="">All banks</option>
              {bankOptions.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </Select>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="s-input w-auto" aria-label="Status">
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          {list.error ? <p className="p-6 text-sm text-s-red">{errText(list.error)}</p>
            : list.isLoading ? <p className="p-6 text-sm text-s-muted">Loading…</p>
            : (list.data ?? []).length === 0 ? <CompactEmptyState message="No reconciliations match." />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-s-muted border-b border-s-border">
                      <th className="px-3 py-2 font-semibold">Bank account</th>
                      <th className="px-3 py-2 font-semibold">Period</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold text-right">Books closing</th>
                      <th className="px-3 py-2 font-semibold text-right">Bank closing</th>
                      <th className="px-3 py-2 font-semibold text-right">Difference</th>
                      <th className="px-3 py-2 font-semibold">Prepared by</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {(list.data ?? []).map((r) => {
                      const diff = r.totals?.differenceCents
                      return (
                        <tr key={r.id} className="border-b border-s-border align-top">
                          <td className="px-3 py-2.5 min-w-[10rem]"><span className="font-semibold text-s-text break-words">{r.bank.name}</span>
                            <span className="block text-xs text-s-muted font-mono">{r.bank.accountNumber ?? r.accountCode}</span></td>
                          <td className="px-3 py-2.5 text-xs whitespace-nowrap">{periodLabel(r.periodFrom, r.periodTo)}<span className="block text-s-muted">FY {financialYearOf(r.periodFrom)}</span></td>
                          <td className="px-3 py-2.5"><StatusChip status={r.status} />{r.returnNote && <span className="block text-xs text-s-red mt-1">Returned</span>}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{r.bookClosingCents == null ? '—' : fmtPkr(r.bookClosingCents)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{r.bankClosingCents == null ? '—' : fmtPkr(r.bankClosingCents)}</td>
                          <td className={`px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap ${diff == null ? 'text-s-muted' : diff === 0 ? 'text-success' : 'text-s-red'}`}>{diff == null ? '—' : fmtPkr(diff)}</td>
                          <td className="px-3 py-2.5 text-xs text-s-muted">{r.preparedBy ?? '—'}</td>
                          <td className="px-3 py-2.5 text-right"><Link href={`/finance/bank-reconciliation/${r.id}`} className="s-btn-secondary text-xs px-3 py-1.5">Open</Link></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>

        {/* Reports */}
        <section className="s-card p-4 space-y-3">
          <h2 className="text-sm font-bold text-s-text">Reports</h2>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="s-input w-auto" /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="s-input w-auto" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-s-border p-3">
              <p className="text-sm font-semibold text-s-text">Monthly bank reconciliation summary</p>
              <p className="text-xs text-s-muted mt-0.5 mb-2">Every bank, month by month, for the dates above.</p>
              <ExportMenu path={`${BRS}/reports/monthly?${rangeQs}`} filename={`monthly-bank-reconciliation-${from}-${to}`} onError={setExportErr} disabled={!from || !to || from > to} />
            </div>
            <div className="rounded-lg border border-s-border p-3">
              <p className="text-sm font-semibold text-s-text">Bank charges and tax deduction</p>
              <p className="text-xs text-s-muted mt-0.5 mb-2">Charges and taxes the bank took, booked in the period{bankFilter ? ' (selected bank)' : ''}.</p>
              <ExportMenu path={`${BRS}/reports/charges?${rangeQs}${bankFilter ? `&bankAccountId=${bankFilter}` : ''}`} filename={`bank-charges-and-taxes-${from}-${to}`} onError={setExportErr} disabled={!from || !to || from > to} />
            </div>
            <div className="rounded-lg border border-s-border p-3">
              <p className="text-sm font-semibold text-s-text">Bank-wise reconciliation status</p>
              <p className="text-xs text-s-muted mt-0.5 mb-2">Last approved period and open items per bank.</p>
              <ExportMenu path={`${BRS}/banks`} filename="bank-wise-reconciliation-status" onError={setExportErr} />
            </div>
          </div>
        </section>
      </div>

      {dialog && <NewReconciliation presetBankId={dialog.bankId} onClose={() => setDialog(null)} />}
    </div>
  )
}
