'use client'
// Split a booked expense / processed payroll into other companies (owner, 2026-11-07).
// Finance or the CEO posts it at once — no approval. The backend moves the chosen expense lines
// to the other companies as inter-company charges (due-to / due-from); the source company keeps the rest.
//   GET  /accounting/intercompany/splits/preview?sourceEntryId=|payrollRunId=
//   POST /accounting/intercompany/splits            GET /splits/:id      POST /splits/:id/reverse
// Also shows an existing split (pass `splitId`, or the preview's liveSplit) with "Reverse split".
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { MoneyInput } from '../ui/MoneyInput'
import { NumberField } from '../ui/NumberField'
import { Button, CheckLabel, Dialog, DialogFooter, ErrorBanner, Field, Input } from './ui'

export interface SplitShare {
  id: string; tenantId: string; companyName: string; percent: number | null; amountCents: number
  lines: Array<{ accountCode: string; amountCents: number }>
  transferId: string | null; transferStatus: string | null; receiverEntryId: string | null; sourceEntryIdOfShare: string | null
}
export interface SplitView {
  id: string; tenantId: string; companyName: string
  sourceKind: 'journal_entry' | 'payroll_run'; sourceEntryId: string | null; sourceReference: string | null; sourceVoucherNo: string | null
  payrollRunId: string | null; payrollPeriod: string | null
  mode: 'percent' | 'amount'; baseCents: number; splitCents: number; keptCents: number
  lines: Array<{ lineId: string; accountCode: string; accountName: string; conceptId: string | null; amountCents: number }> | null
  entryDate: string; memo: string; status: 'posted' | 'reversed'
  createdById: string | null; createdByName: string | null; createdAt: string
  reversedByName: string | null; reversedAt: string | null; reversalReason: string | null
  shares: SplitShare[]; canReverse: boolean
}
interface Preview {
  source: {
    kind: 'journal_entry' | 'payroll_run'; entryId: string | null; payrollRunId: string | null; payrollPeriod: string | null
    tenantId: string; companyName: string; reference: string | null; voucherNo: string | null; description: string | null
    entryDate: string; live: boolean
  } | null
  lines: Array<{ lineId: string; accountCode: string; accountName: string; conceptId: string | null; conceptName: string | null; amountCents: number }>
  baseCents: number
  companies: Array<{ id: string; name: string }>
  liveSplit: SplitView | null
  canSplit: boolean
  blocker: null | { code: string; message: string }
}

const BASE = '/accounting/intercompany/splits'
const day = (iso: string) => iso.slice(0, 10)

/** "Split to X, Y" for a live split (the entry panel's one-line note). */
export function splitToText(s: SplitView): string {
  return `Split to ${s.shares.map((x) => x.companyName).join(', ')}`
}

export function usePreviewQuery(opts: { sourceEntryId?: string; payrollRunId?: string; tenantId?: string | null; enabled?: boolean }) {
  const qs = opts.sourceEntryId ? `sourceEntryId=${encodeURIComponent(opts.sourceEntryId)}` : `payrollRunId=${encodeURIComponent(opts.payrollRunId ?? '')}`
  const headers = opts.tenantId ? { 'x-servd-active-tenant': opts.tenantId } : undefined
  return useQuery<Preview>({
    queryKey: ['cost-split', 'preview', opts.sourceEntryId ?? opts.payrollRunId, opts.tenantId ?? null],
    queryFn: () => api.get<Preview>(`${BASE}/preview?${qs}`, headers ? { headers } : undefined),
    enabled: opts.enabled ?? !!(opts.sourceEntryId || opts.payrollRunId),
    retry: false,
  })
}

export function CostSplitDialog({ sourceEntryId, payrollRunId, splitId, tenantId, onDone, onClose }: {
  sourceEntryId?: string; payrollRunId?: string
  /** Open an existing split by id (the Cost splits tab). */
  splitId?: string
  /** Pin to the source's company when the page is in a portfolio view. */
  tenantId?: string | null
  onDone?: () => void; onClose: () => void
}) {
  const headers = tenantId ? { 'x-servd-active-tenant': tenantId } : undefined
  const preview = usePreviewQuery({ sourceEntryId, payrollRunId, tenantId, enabled: !splitId && !!(sourceEntryId || payrollRunId) })
  const one = useQuery<SplitView>({
    queryKey: ['cost-split', 'one', splitId],
    queryFn: () => api.get<SplitView>(`${BASE}/${splitId}`, headers ? { headers } : undefined),
    enabled: !!splitId,
  })
  const title = splitId || preview.data?.liveSplit ? 'Cost split' : 'Split this expense to other companies'
  return (
    <Dialog title={title} onClose={onClose} wide>
      {(splitId ? one.isLoading : preview.isLoading) && <p className="text-sm text-s-muted" role="status">Loading…</p>}
      {(splitId ? one.error : preview.error) && <ErrorBanner message={((splitId ? one.error : preview.error) as Error).message} />}
      {splitId && one.data && <SplitDetail split={one.data} tenantId={tenantId} onChanged={() => { void one.refetch(); onDone?.() }} onClose={onClose} />}
      {!splitId && preview.data && (
        preview.data.liveSplit
          ? <SplitDetail split={preview.data.liveSplit} tenantId={tenantId} onChanged={() => { void preview.refetch(); onDone?.() }} onClose={onClose} />
          : preview.data.blocker || !preview.data.source
            ? (
              <div className="space-y-3">
                <p className="text-sm text-s-text" role="status">{preview.data.blocker?.message ?? 'This cannot be split.'}</p>
                <DialogFooter onCancel={onClose}><span /></DialogFooter>
              </div>
            )
            : <SplitForm key={sourceEntryId ?? payrollRunId} preview={preview.data} sourceEntryId={sourceEntryId} payrollRunId={payrollRunId}
              tenantId={tenantId} onDone={onDone} onClose={onClose} />
      )}
    </Dialog>
  )
}

function SplitForm({ preview, sourceEntryId, payrollRunId, tenantId, onDone, onClose }: {
  preview: Preview; sourceEntryId?: string; payrollRunId?: string; tenantId?: string | null; onDone?: () => void; onClose: () => void
}) {
  const qc = useQueryClient()
  const src = preview.source!
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preview.lines.map((l) => l.lineId)))
  const [pct, setPct] = useState<Record<string, number | null>>({})
  const [amt, setAmt] = useState<Record<string, number>>({})
  const [date, setDate] = useState(day(src.entryDate))
  const [memo, setMemo] = useState('')
  const [done, setDone] = useState<SplitView | null>(null)
  const [err, setErr] = useState('')

  const base = useMemo(() => preview.lines.filter((l) => picked.has(l.lineId)).reduce((s, l) => s + l.amountCents, 0), [preview.lines, picked])
  const targets = preview.companies.filter((c) => c.id !== src.tenantId)

  const rows = targets.map((c) => {
    const p = pct[c.id] ?? 0
    const cents = mode === 'percent' ? Math.round((base * p) / 100) : (amt[c.id] ?? 0)
    return { c, p, cents }
  })
  const totalPct = rows.reduce((s, r) => s + r.p, 0)
  const splitCents = rows.reduce((s, r) => s + r.cents, 0)
  const kept = base - splitCents
  const over = mode === 'percent' ? totalPct > 100.0001 : splitCents > base
  const any = rows.some((r) => r.cents > 0)
  const problem = !picked.size ? 'Tick at least one line to split.'
    : over ? (mode === 'percent' ? `The shares add up to ${Math.round(totalPct * 100) / 100}% — they cannot be more than 100%.` : `The shares add up to ${fmtPkr(splitCents)}, more than the ${fmtPkr(base)} being split.`)
      : ''
  const ok = any && !problem && memo.trim().length >= 3

  const submit = useMutation({
    mutationFn: () => {
      const shares = rows.filter((r) => (mode === 'percent' ? r.p > 0 : r.cents > 0)).map((r) =>
        mode === 'percent' ? { tenantId: r.c.id, percent: r.p } : { tenantId: r.c.id, amountCents: r.cents })
      const body: Record<string, unknown> = { mode, shares, memo: memo.trim() }
      if (sourceEntryId) body['sourceEntryId'] = sourceEntryId
      else body['payrollRunId'] = payrollRunId
      if (picked.size !== preview.lines.length) body['lines'] = Array.from(picked)
      if (date && date !== day(src.entryDate)) body['entryDate'] = date
      return api.post<SplitView>(BASE, body, tenantId ? { tenantId } : undefined)
    },
    onSuccess: (r) => {
      setDone(r); setErr('')
      for (const k of ['cost-split', 'ic', 'journal-entry', 'journals', 'ledger', 'account-statement']) void qc.invalidateQueries({ queryKey: [k] })
      onDone?.()
    },
    onError: (x: Error) => setErr(x.message),
  })

  if (done) return <SplitDetail split={done} tenantId={tenantId} onChanged={() => onDone?.()} onClose={onClose} justPosted />

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const modeBtn = (m: 'percent' | 'amount', label: string) => (
    <button type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
      className={`px-3 py-1.5 text-sm font-semibold border-b-2 ${mode === m ? 'text-s-text' : 'border-transparent text-s-muted hover:text-s-text'}`}
      style={mode === m ? { borderColor: 'var(--erp-accent)' } : undefined}>{label}</button>
  )

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok && !submit.isPending) { setErr(''); submit.mutate() } }}>
      <div className="rounded-lg border border-s-border p-3 text-sm space-y-0.5">
        <p className="font-semibold text-s-text break-words">
          {src.kind === 'payroll_run' ? `Payroll ${src.payrollPeriod ?? ''}` : (src.voucherNo ?? (src.reference && !/^[a-z_.]+:/i.test(src.reference) ? src.reference : 'Journal entry'))}
          <span className="text-s-muted font-normal"> · {src.companyName} · {day(src.entryDate)}</span>
        </p>
        {src.description && <p className="text-xs text-s-muted break-words">{src.description}</p>}
        {/* A system key (manual:<id>, hr.payroll.accrual:<id>…) is never shown (owner, 2026-11-06) — only a typed reference. */}
        {src.reference && src.voucherNo && !/^[a-z_.]+:/i.test(src.reference) && <p className="text-xs text-s-muted break-all">{src.reference}</p>}
      </div>

      <section>
        <h3 className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Which expense lines</h3>
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-s-border">
          {preview.lines.map((l) => (
            <li key={l.lineId} className="px-3 py-2">
              <CheckLabel className="!items-start">
                <input type="checkbox" checked={picked.has(l.lineId)} onChange={() => toggle(l.lineId)} className="mt-0.5" />
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-mono text-s-muted mr-1">{l.accountCode}</span>{l.accountName}
                  {l.conceptName && <span className="block text-s-muted">Brand: {l.conceptName}</span>}
                </span>
                <span className="font-mono tabular-nums whitespace-nowrap">{fmtPkr(l.amountCents)}</span>
              </CheckLabel>
            </li>
          ))}
        </ul>
        <p className="text-sm mt-1.5 text-s-text">Being split: <span className="font-semibold tabular-nums">{fmtPkr(base)}</span></p>
      </section>

      <section className="space-y-2">
        <div role="radiogroup" aria-label="Split by" className="flex gap-1 border-b border-s-border">
          {modeBtn('percent', 'By percent')}{modeBtn('amount', 'By amount')}
        </div>
        {targets.length === 0 && <p className="text-sm text-s-muted">There is no other company to split to.</p>}
        {rows.map(({ c, cents }) => (
          <div key={c.id} className="grid grid-cols-1 sm:grid-cols-[1fr_11rem] gap-1 sm:gap-3 sm:items-center">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-s-text break-words">{c.name}</p>
              <p className="text-xs text-s-muted tabular-nums">
                {cents > 0 ? `Takes ${fmtPkr(cents)}${mode === 'amount' && base > 0 ? ` (${Math.round((cents / base) * 10000) / 100}%)` : ''}` : 'Not split to this company'}
              </p>
            </div>
            {mode === 'percent'
              ? <NumberField aria-label={`Percent for ${c.name}`} className="s-input" decimals={2} min={0} max={100} placeholder="% (blank = none)"
                value={pct[c.id] ?? null} onValueChange={(v) => setPct((m) => ({ ...m, [c.id]: v }))} />
              : <MoneyInput ariaLabel={`Amount for ${c.name}`} className="s-input" placeholder="PKR (blank = none)"
                value={amt[c.id] ?? 0} onChange={(v) => setAmt((m) => ({ ...m, [c.id]: v }))} />}
          </div>
        ))}
        <div className="rounded-lg border border-s-border p-3 text-sm space-y-0.5" aria-live="polite">
          <p className="flex justify-between gap-3"><span className="text-s-muted">Split to other companies</span><span className="font-semibold tabular-nums">{fmtPkr(splitCents)}</span></p>
          <p className="flex justify-between gap-3"><span className="text-s-muted">{src.companyName} keeps</span><span className="font-semibold tabular-nums text-success">{fmtPkr(Math.max(kept, 0))}</span></p>
          {problem && <p role="alert" className="text-xs text-s-red pt-1">{problem}</p>}
        </div>
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-3">
        <Field label="Date of the split" hint="Defaults to the date of the original.">
          <Input type="date" value={date} max={todayPktIso()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Note (what is being split and why)" hint="At least 3 characters.">
          <Input value={memo} maxLength={300} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </div>

      <p className="text-xs text-s-muted">
        This posts at once and needs no approval. The other companies are charged through inter-company due-to / due-from balances,
        and {src.companyName} keeps the rest. You can reverse it later.
      </p>
      {err && <ErrorBanner message={err} />}
      <DialogFooter onCancel={onClose}>
        <Button type="submit" disabled={!ok || submit.isPending}>{submit.isPending ? 'Posting…' : 'Split now'}</Button>
      </DialogFooter>
    </form>
  )
}

function SplitDetail({ split, tenantId, onChanged, onClose, justPosted }: {
  split: SplitView; tenantId?: string | null; onChanged: () => void; onClose: () => void; justPosted?: boolean
}) {
  const qc = useQueryClient()
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [live, setLive] = useState(split)
  const reverse = useMutation({
    mutationFn: () => api.post<SplitView>(`${BASE}/${live.id}/reverse`, { reason: reason.trim() }, tenantId ? { tenantId } : undefined),
    onSuccess: (r) => {
      setLive(r); setReversing(false); setErr('')
      for (const k of ['cost-split', 'ic', 'journal-entry', 'journals', 'ledger', 'account-statement']) void qc.invalidateQueries({ queryKey: [k] })
      onChanged()
    },
    onError: (x: Error) => setErr(x.message),
  })
  const s = live
  return (
    <div className="space-y-4">
      {justPosted && <p role="status" className="text-sm text-success font-semibold">Split posted.</p>}
      <div className="rounded-lg border border-s-border p-3 text-sm space-y-0.5">
        <p className="font-semibold text-s-text break-words">
          {s.sourceKind === 'payroll_run' ? `Payroll ${s.payrollPeriod ?? ''}` : (s.sourceVoucherNo ?? (s.sourceReference && !/^[a-z_.]+:/i.test(s.sourceReference) ? s.sourceReference : 'Journal entry'))}
          <span className="text-s-muted font-normal"> · {s.companyName} · {day(s.entryDate)}</span>
          <span className={`ml-2 align-middle ${s.status === 'posted' ? 's-badge-green' : 's-badge-purple'}`}>{s.status === 'posted' ? 'Posted' : 'Reversed'}</span>
        </p>
        <p className="text-xs text-s-muted break-words">{s.memo}</p>
        <p className="text-xs text-s-muted">
          By {s.createdByName ?? '—'} on {day(s.createdAt)}
          {s.status === 'reversed' && <> · Reversed by {s.reversedByName ?? '—'}{s.reversedAt ? ` on ${day(s.reversedAt)}` : ''}{s.reversalReason ? ` — ${s.reversalReason}` : ''}</>}
        </p>
      </div>

      <ul className="divide-y divide-[var(--border)] rounded-lg border border-s-border">
        {s.shares.map((x) => (
          <li key={x.id} className="px-3 py-2 text-sm">
            <p className="flex justify-between gap-3">
              <span className="font-semibold text-s-text break-words min-w-0">{x.companyName}{x.percent != null && <span className="text-s-muted font-normal"> · {x.percent}%</span>}</span>
              <span className="font-mono tabular-nums whitespace-nowrap">{fmtPkr(x.amountCents)}</span>
            </p>
            {x.lines.length > 0 && <p className="text-xs text-s-muted break-words">{x.lines.map((l) => `${l.accountCode} ${fmtPkr(l.amountCents)}`).join(' · ')}</p>}
            {x.transferStatus && <p className="text-xs text-s-muted">Inter-company charge: {x.transferStatus}</p>}
          </li>
        ))}
        <li className="px-3 py-2 text-sm flex justify-between gap-3">
          <span className="text-s-muted">{s.companyName} keeps</span><span className="font-mono tabular-nums text-success">{fmtPkr(s.keptCents)}</span>
        </li>
        <li className="px-3 py-2 text-sm flex justify-between gap-3">
          <span className="text-s-muted">Total being split ({s.mode === 'percent' ? 'by percent' : 'by amount'})</span>
          <span className="font-mono tabular-nums">{fmtPkr(s.baseCents)}</span>
        </li>
      </ul>

      {err && <ErrorBanner message={err} />}
      {reversing ? (
        <div className="space-y-2 rounded-lg border border-s-border p-3">
          <Field label="Why is it being reversed? (at least 10 characters)">
            <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-xs text-s-muted">The charges to the other companies are cancelled and the cost goes back to {s.companyName}.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={reason.trim().length < 10 || reverse.isPending} onClick={() => { setErr(''); reverse.mutate() }}>
              {reverse.isPending ? 'Reversing…' : 'Yes, reverse this split'}
            </Button>
            <Button variant="ghost" onClick={() => setReversing(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 justify-between">
          {s.status === 'posted' && s.canReverse ? <Button variant="danger" onClick={() => { setErr(''); setReversing(true) }}>Reverse split</Button> : <span />}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      )}
    </div>
  )
}
