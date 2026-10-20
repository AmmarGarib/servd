'use client'
// Finance → Payments register (owner, 2026-10-20: "Internal Payment
// Classification & Management Reporting").
//
// Every payment of the companies in view — vendor payments, salaries,
// advances, petty cash, cash vouchers, operating expenses, purchases, tax —
// with its INTERNAL classification (Official / Unofficial / Unclassified), the
// tax-deduction status and the reason for non-deduction. Filter chips give the
// separate Official and Unofficial reports and the combined (All) one; the
// tie-out shows the register's net equals the ledger's money out for the
// period.
//
// A REPORTING DIMENSION only: classifying never changes an entry, an account,
// the trial balance, a tax return or a statutory report (backend
// accounting/paymentsRegister.ts). Readers: CEO, owner, management, finance
// (module accounting). Changing a classification — one row (the panel) or
// many (the "Classify selected" bar) — is the CEO's or finance's with a reason.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { usePermissions } from '../../../hooks/useCan'
import { RecordFiles } from '@/components/files/RecordFiles'
import {
  CLASSIFICATION_LABEL, TAX_STATUS_LABEL, ClassificationChip,
  type PaymentClassification, type PaymentTaxStatus,
} from '@/components/finance/PaymentClassificationFields'
import { ExportMenu } from '@/components/ui/ExportMenu'

type Filter = PaymentClassification | 'all'

interface Row {
  journalEntryId: string
  tenantId: string
  companyName: string | null
  entryDate: string
  reference: string | null
  voucherNumber: string
  payee: string
  category: string
  categoryLabel: string
  narration: string
  method: string
  methodLabel: string
  grossCents: number
  whtCents: number
  netCents: number
  classification: PaymentClassification
  classified: boolean
  taxStatus: PaymentTaxStatus | null
  taxStatusSource: 'recorded' | 'derived' | 'none'
  nonDeductionReason: string | null
}
interface Totals { count: number; grossCents: number; whtCents: number; netCents: number }
interface Resp {
  from: string
  to: string
  multiCompany: boolean
  rows: Row[]
  totals: Record<Filter, Totals>
  tieOut: {
    moneyCreditsCents: number; salesAndTillCents: number; reversedCents: number; transfersAndReceiptsCents: number
    paymentsNetCents: number; registerNetCents: number; differenceCents: number; ties: boolean
  }
  categories: Record<string, string>
  methods: Record<string, string>
  /** Classification × method grid (dates, category and search applied; not the method / classification filters). */
  summary: {
    methods: Array<{ key: string; label: string }>
    rows: Array<{ classification: Filter; cells: Record<string, { count: number; netCents: number }>; total: { count: number; netCents: number } }>
  }
  note: string
}
interface Detail {
  payment: Row
  lines: Array<{ type: 'debit' | 'credit'; amountCents: number; memo: string | null; account: { code: string; name: string } }>
  history: Array<{ id: string; createdAt: string; userEmail: string | null; before: { classification?: string } | null; after: { classification?: string; taxStatus?: string | null } | null; metadata: { reason?: string | null; bulk?: boolean; actorRole?: string } | null }>
}

const CHIPS: Array<{ id: Filter; label: string }> = [
  { id: 'official', label: 'Official' },
  { id: 'unofficial', label: 'Unofficial' },
  { id: 'unclassified', label: 'Unclassified' },
  { id: 'all', label: 'All' },
]
const danger = 'var(--erp-danger)'
const fieldCls = 's-input !w-auto'
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric' })
const monthStartIso = () => `${todayPktIso().slice(0, 7)}-01`

function taxText(r: Row): string {
  if (!r.taxStatus) return 'Not recorded'
  return `${TAX_STATUS_LABEL[r.taxStatus]}${r.taxStatusSource === 'derived' ? ' (from books)' : ''}`
}

export default function PaymentsRegisterPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const canClassify = me?.role === 'admin' || (me?.role === 'finance' && me.modules.includes('accounting'))

  const [filter, setFilter] = useState<Filter>('all')
  const [from, setFrom] = useState(monthStartIso)
  const [to, setTo] = useState(() => todayPktIso())
  const [category, setCategory] = useState('')
  const [method, setMethod] = useState('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [csvErr, setCsvErr] = useState('')

  const qs = useMemo(() => {
    const p = new URLSearchParams({ classification: filter, from, to })
    if (category) p.set('category', category)
    if (method) p.set('method', method)
    if (q.trim()) p.set('q', q.trim())
    return p.toString()
  }, [filter, from, to, category, method, q])

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ['payments-register', qs],
    queryFn: () => api.get(`/accounting/payments?${qs}`),
  })
  const rows = data?.rows ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: ['payments-register'] })

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.journalEntryId))
  const selectAll = () => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.journalEntryId)))


  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Management reporting</p>
            <h1 className="text-2xl font-black text-white/90">Payments register</h1>
            <p className="mt-1 max-w-2xl text-sm text-white/45">
              Every payment out of cash, petty cash and the banks, with its internal classification. The classification is a
              reporting label only — the ledger, trial balance, tax returns and statutory reports are exactly the same whatever it says.
            </p>
          </div>
          <ExportMenu path={`/accounting/payments/payments.csv?${qs}`} filename={`payments-${filter}-${from}-to-${to}`} onError={(m) => setCsvErr(m)} />
        </div>
        {csvErr && <p className="mt-2 text-sm" style={{ color: danger }}>{csvErr}</p>}
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-7">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Classification">
          {CHIPS.map((c) => {
            const on = filter === c.id
            const t = data?.totals[c.id]
            return (
              <button
                key={c.id}
                role="tab"
                aria-selected={on}
                onClick={() => { setFilter(c.id); setSelected(new Set()) }}
                className="rounded-full px-4 py-2 text-sm font-semibold"
                style={on
                  ? { background: 'color-mix(in srgb, var(--erp-success) 14%, transparent)', color: 'var(--erp-success)', border: '1px solid var(--erp-success)' }
                  : { background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
              >
                {c.label}{t ? ` · ${t.count}` : ''}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Field label="From"><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={fieldCls} /></Field>
          <Field label="To"><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={fieldCls} /></Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
              <option value="">All categories</option>
              {Object.entries(data?.categories ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)} className={fieldCls}>
              <option value="">All methods</option>
              {Object.entries(data?.methods ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Payee, voucher, narration" className="s-input" /></Field>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(['official', 'unofficial', 'unclassified', 'all'] as Filter[]).map((k) => (
            <Tile key={k} label={k === 'all' ? 'All payments' : CLASSIFICATION_LABEL[k]} t={data?.totals[k]} active={filter === k} />
          ))}
        </div>

        {data?.summary && (
          <SummaryGrid s={data.summary} exportPath={`/accounting/payments/payments.csv?${qs}&view=summary`} filename={`payments-summary-${from}-to-${to}`} onError={setCsvErr} />
        )}

        {data && <TieOut t={data.tieOut} />}

        {canClassify && selected.size > 0 && (
          <BulkBar ids={[...selected]} onDone={() => { setSelected(new Set()); refresh() }} />
        )}

        <div className="overflow-hidden rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {error ? (
            <p className="p-8 text-center text-sm" style={{ color: danger }}>{(error as Error).message}</p>
          ) : isLoading ? (
            <p className="p-8 text-center text-sm text-white/40">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-10 text-center text-sm text-white/45">No payments in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-white/40" style={{ borderBottom: '1px solid var(--border)' }}>
                    {canClassify && (
                      <th className="px-3 py-3">
                        {filter === 'unclassified' && (
                          <input type="checkbox" checked={allOnPage} onChange={selectAll} aria-label="Select all on this page" />
                        )}
                      </th>
                    )}
                    <th className="px-3 py-3 font-semibold">Voucher</th>
                    <th className="px-3 py-3 font-semibold">Date</th>
                    {data?.multiCompany && <th className="px-3 py-3 font-semibold">Company</th>}
                    <th className="px-3 py-3 font-semibold">Payee / employee</th>
                    <th className="px-3 py-3 font-semibold">Category</th>
                    <th className="px-3 py-3 font-semibold">Narration</th>
                    <th className="px-3 py-3 font-semibold">Method</th>
                    <th className="px-3 py-3 text-right font-semibold">Gross</th>
                    <th className="px-3 py-3 text-right font-semibold">WHT</th>
                    <th className="px-3 py-3 text-right font-semibold">Net</th>
                    <th className="px-3 py-3 font-semibold">Classification</th>
                    <th className="px-3 py-3 font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.journalEntryId} onClick={() => setOpenId(r.journalEntryId)} className="cursor-pointer hover:bg-white/[0.03]" style={{ borderBottom: '1px solid var(--border)' }}>
                      {canClassify && (
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(r.journalEntryId)} onChange={() => toggle(r.journalEntryId)} aria-label={`Select ${r.voucherNumber}`} />
                        </td>
                      )}
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-white/85">{r.voucherNumber}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-white/60">{fmtDate(r.entryDate)}</td>
                      {data?.multiCompany && <td className="px-3 py-2.5 text-white/60">{r.companyName ?? '—'}</td>}
                      <td className="px-3 py-2.5 text-white/85">{r.payee}</td>
                      <td className="px-3 py-2.5 text-white/65">{r.categoryLabel}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2.5 text-white/55" title={r.narration}>{r.narration}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-white/65">{r.methodLabel}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-white/75">{fmtPkr(r.grossCents)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-white/60">{r.whtCents ? fmtPkr(r.whtCents) : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-white/90">{fmtPkr(r.netCents)}</td>
                      <td className="px-3 py-2.5"><ClassificationChip value={r.classification} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-white/55" title={r.nonDeductionReason ?? undefined}>{taxText(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {data && <p className="text-xs text-white/40">{data.note}</p>}
      </div>

      {openId && <Panel id={openId} canClassify={canClassify} onClose={() => setOpenId(null)} onSaved={refresh} />}
    </div>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs text-white/50">{label}{children}</label>
}

function Tile({ label, t, active }: { label: string; t?: Totals; active: boolean }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: `1px solid ${active ? 'var(--erp-success)' : 'var(--border)'}` }}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-2xl font-black text-white/90">{fmtPkr(t?.netCents ?? 0)}</p>
      <p className="text-xs text-white/50">{t?.count ?? 0} payments · gross {fmtPkr(t?.grossCents ?? 0)} · WHT {fmtPkr(t?.whtCents ?? 0)}</p>
    </div>
  )
}

function TieOut({ t }: { t: Resp['tieOut'] }) {
  return (
    <div className="rounded-2xl p-4 text-sm" style={{ background: 'var(--surface)', border: `1px solid ${t.ties ? 'var(--border)' : danger}` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold text-white/85">Tie-out to the ledger (all payments in the period)</p>
        {t.ties
          ? <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ background: 'color-mix(in srgb, var(--erp-success) 12%, transparent)', color: 'var(--erp-success)' }}>Ties to ledger</span>
          : <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ background: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)', color: danger }}>Difference {fmtPkr(t.differenceCents)}</span>}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-white/55 sm:grid-cols-2">
        <span>Credits to cash, petty cash and banks: {fmtPkr(t.moneyCreditsCents)}</span>
        <span>less sales and till (out of scope): {fmtPkr(t.salesAndTillCents)}</span>
        <span>less reversed entries: {fmtPkr(t.reversedCents)}</span>
        <span>less transfers between money accounts and money back in: {fmtPkr(t.transfersAndReceiptsCents)}</span>
        <span className="font-semibold text-white/80">= payments in the ledger: {fmtPkr(t.paymentsNetCents)}</span>
        <span className="font-semibold text-white/80">Register (All): {fmtPkr(t.registerNetCents)}</span>
      </div>
    </div>
  )
}

function ClassifyInputs({ classification, setClassification, taxStatus, setTaxStatus, nonDeductionReason, setNonDeductionReason, showTax }: {
  classification: PaymentClassification | ''; setClassification: (v: PaymentClassification | '') => void
  taxStatus: PaymentTaxStatus | ''; setTaxStatus: (v: PaymentTaxStatus | '') => void
  nonDeductionReason: string; setNonDeductionReason: (v: string) => void
  showTax: boolean
}) {
  return (
    <>
      <Field label="Classification">
        <Select value={classification} onChange={(e) => setClassification(e.target.value as PaymentClassification | '')} className="s-input">
          <option value="" disabled>Choose…</option>
          <option value="official">Official</option>
          <option value="unofficial">Unofficial</option>
          <option value="unclassified">Unclassified</option>
        </Select>
      </Field>
      {showTax && (
        <Field label="Tax deduction">
          <Select value={taxStatus} onChange={(e) => setTaxStatus(e.target.value as PaymentTaxStatus | '')} className="s-input">
            <option value="">Not recorded</option>
            <option value="deducted">Deducted</option>
            <option value="not_deducted">Not deducted</option>
            <option value="not_applicable">Not applicable</option>
          </Select>
        </Field>
      )}
      {showTax && taxStatus === 'not_deducted' && (
        <Field label="Reason tax was not deducted">
          <input className="s-input" value={nonDeductionReason} maxLength={500} onChange={(e) => setNonDeductionReason(e.target.value)} />
        </Field>
      )}
    </>
  )
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const [classification, setClassification] = useState<PaymentClassification | ''>('')
  const [taxStatus, setTaxStatus] = useState<PaymentTaxStatus | ''>('')
  const [nonDeductionReason, setNonDeductionReason] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ready = !!classification && reason.trim().length >= 10 && (taxStatus !== 'not_deducted' || nonDeductionReason.trim().length >= 10)
  const send = async () => {
    setBusy(true); setErr('')
    try {
      await api.post('/accounting/payments/classify', {
        journalEntryIds: ids, classification, reason: reason.trim(),
        ...(taxStatus ? { taxStatus, nonDeductionReason: taxStatus === 'not_deducted' ? nonDeductionReason.trim() : null } : {}),
      })
      onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="sticky top-0 z-10 space-y-3 rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--erp-primary)' }}>
      <p className="text-sm font-bold text-white/85">Classify selected · {ids.length} payment{ids.length === 1 ? '' : 's'}</p>
      <div className="flex flex-wrap items-end gap-3">
        <ClassifyInputs
          classification={classification} setClassification={setClassification}
          taxStatus={taxStatus} setTaxStatus={setTaxStatus}
          nonDeductionReason={nonDeductionReason} setNonDeductionReason={setNonDeductionReason}
          showTax
        />
        <Field label="Reason (at least 10 characters)">
          <input className="s-input min-w-[16rem]" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button disabled={!ready || busy} onClick={send} className="s-btn-primary">{busy ? 'Saving…' : 'Classify selected'}</button>
      </div>
      {err && <p className="text-sm" style={{ color: danger }}>{err}</p>}
    </div>
  )
}

function Panel({ id, canClassify, onClose, onSaved }: { id: string; canClassify: boolean; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const { data, error } = useQuery<Detail>({ queryKey: ['payment', id], queryFn: () => api.get(`/accounting/payments/${id}`) })
  const p = data?.payment
  const [classification, setClassification] = useState<PaymentClassification | ''>('')
  const [taxStatus, setTaxStatus] = useState<PaymentTaxStatus | ''>('')
  const [nonDeductionReason, setNonDeductionReason] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  if (p && loadedFor !== p.journalEntryId) {
    setLoadedFor(p.journalEntryId)
    setClassification(p.classified ? p.classification : '')
    setTaxStatus(p.taxStatusSource === 'recorded' && p.taxStatus ? p.taxStatus : '')
    setNonDeductionReason(p.nonDeductionReason ?? '')
  }
  const needsReason = !!p?.classified
  const ready = !!classification && (!needsReason || reason.trim().length >= 10) && (taxStatus !== 'not_deducted' || nonDeductionReason.trim().length >= 10)
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await api.put(`/accounting/payments/${id}/classification`, {
        classification, taxStatus: taxStatus || null,
        nonDeductionReason: taxStatus === 'not_deducted' ? nonDeductionReason.trim() : null,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      setReason('')
      await qc.invalidateQueries({ queryKey: ['payment', id] })
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-secondary/40" onClick={onClose}>
      <aside className="h-full w-full max-w-md overflow-y-auto" style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)' }} onClick={(e) => e.stopPropagation()} aria-label="Payment">
        <div className="sticky top-0 flex items-center justify-between border-b px-5 py-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div>
            <h2 className="font-mono text-lg font-black text-white/90">{p?.voucherNumber ?? '…'}</h2>
            <p className="text-xs text-white/45">{p ? `${p.payee} · ${p.categoryLabel}` : ''}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-white/50 hover:text-white" aria-label="Close">Close</button>
        </div>
        {error ? <p className="p-5 text-sm" style={{ color: danger }}>{(error as Error).message}</p> : !p ? <p className="p-5 text-sm text-white/40">Loading…</p> : (
          <div className="space-y-5 p-5 text-sm">
            <section className="space-y-1">
              <KV k="Date" v={fmtDate(p.entryDate)} />
              <KV k="Method" v={p.methodLabel} />
              <KV k="Gross" v={fmtPkr(p.grossCents)} />
              <KV k="Withholding tax" v={fmtPkr(p.whtCents)} />
              <KV k="Net paid" v={fmtPkr(p.netCents)} />
              <KV k="Classification" v={<ClassificationChip value={p.classification} />} />
              <KV k="Tax deduction" v={taxText(p)} />
              {p.nonDeductionReason && <KV k="Reason not deducted" v={p.nonDeductionReason} />}
              <KV k="Narration" v={p.narration} />
              <KV k="Ledger reference" v={<span className="font-mono text-xs">{p.reference ?? '—'}</span>} />
            </section>

            <section>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-white/40">Ledger entry</h3>
              {(data?.lines ?? []).map((l, i) => (
                <div key={i} className="flex justify-between gap-2 text-xs">
                  <span className="text-white/65">{l.account.code} {l.account.name}</span>
                  <span className="text-white/80">{l.type === 'debit' ? 'Dr' : 'Cr'} {fmtPkr(l.amountCents)}</span>
                </div>
              ))}
            </section>

            {canClassify && (
              <section className="space-y-3 rounded-xl p-3" style={{ border: '1px solid var(--border)' }}>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-white/40">{p.classified ? 'Change classification' : 'Classify'}</h3>
                <ClassifyInputs
                  classification={classification} setClassification={setClassification}
                  taxStatus={taxStatus} setTaxStatus={setTaxStatus}
                  nonDeductionReason={nonDeductionReason} setNonDeductionReason={setNonDeductionReason}
                  showTax
                />
                {needsReason && (
                  <Field label="Reason for the change (at least 10 characters)">
                    <input className="s-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                )}
                <button disabled={!ready || busy} onClick={save} className="s-btn-primary">{busy ? 'Saving…' : 'Save'}</button>
                {err && <p className="text-sm" style={{ color: danger }}>{err}</p>}
              </section>
            )}

            <RecordFiles ownerType="payment" ownerId={p.journalEntryId} canUpload={canClassify} tenantId={p.tenantId} title="Supporting documents (tax status)" />

            <section>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-white/40">History</h3>
              {(data?.history ?? []).length === 0 ? <p className="text-xs text-white/40">Not changed since it was paid.</p> : data!.history.map((h) => (
                <div key={h.id} className="mb-2 text-xs text-white/60">
                  <p>
                    {new Date(h.createdAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} · {h.userEmail ?? 'unknown'}{h.metadata?.bulk ? ' · bulk' : ''}
                  </p>
                  <p className="text-white/80">
                    {CLASSIFICATION_LABEL[(h.before?.classification ?? 'unclassified') as PaymentClassification] ?? h.before?.classification} → {CLASSIFICATION_LABEL[(h.after?.classification ?? 'unclassified') as PaymentClassification] ?? h.after?.classification}
                  </p>
                  {h.metadata?.reason && <p className="italic">{h.metadata.reason}</p>}
                </div>
              ))}
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}

function KV({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/50">{k}</span>
      <span className="text-right text-white/85">{v}</span>
    </div>
  )
}

/** Net paid per classification × method (owner, 2026-10-20), with row and column totals. */
function SummaryGrid({ s, exportPath, filename, onError }: { s: Resp['summary']; exportPath: string; filename: string; onError: (m: string) => void }) {
  const label = (c: Filter) => (c === 'all' ? 'Total' : CLASSIFICATION_LABEL[c])
  return (
    <section className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white/85">Summary — by classification and method</h2>
          <p className="text-xs text-white/45">Net paid (after tax withheld) for the dates, category and search above.</p>
        </div>
        <ExportMenu path={exportPath} filename={filename} onError={onError} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-white/40">
              <th className="px-3 py-2 font-semibold">Classification</th>
              {s.methods.map((m) => <th key={m.key} className="px-3 py-2 text-right font-semibold">{m.label}</th>)}
              <th className="px-3 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => {
              const total = r.classification === 'all'
              return (
                <tr key={r.classification} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className={`px-3 py-2.5 ${total ? 'font-bold text-white/90' : 'text-white/75'}`}>
                    {total ? 'Total' : <ClassificationChip value={r.classification as PaymentClassification} />}
                    <span className="sr-only">{label(r.classification)}</span>
                  </td>
                  {s.methods.map((m) => {
                    const c = r.cells[m.key]!
                    return (
                      <td key={m.key} className={`whitespace-nowrap px-3 py-2.5 text-right ${total ? 'font-bold text-white/90' : 'text-white/75'}`}
                        title={`${c.count} payment${c.count === 1 ? '' : 's'}`}>
                        {c.netCents ? fmtPkr(c.netCents) : '—'}
                      </td>
                    )
                  })}
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-bold text-white/90" title={`${r.total.count} payments`}>{fmtPkr(r.total.netCents)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
