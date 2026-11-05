'use client'
// Bank reconciliation workspace: one bank, one period. Shows the statement the
// server builds (backend reconciliation/brs.ts) both ways — bank → books and
// books → bank — and every tool to clear what is left: book an entry from a
// bank line, match it to a book entry, mark it under review, record an error.
// Draft → Submitted (finance) → Approved and locked (CEO). Approved is read-only.

import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, LinkButton, Textarea } from '@/components/finance/ui'
import { DialogForm } from '@/components/finance/PaymentReceivedFields'
import { AdjustForm, IgnoreForm, ManualMatch } from '@/components/finance/bankRecon/BankLineForms'
import {
  BRS, StatusChip, errText, fmtDay, fmtStamp, periodLabel, useBrsRights,
  type AdjItem, type BankItem, type BookItem, type BrsDetail,
} from '@/components/finance/bankRecon/brsShared'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../../lib/money'

// ── small parts ──────────────────────────────────────────────────────────────

const money = (c: number | null | undefined) => (c == null ? '—' : fmtPkr(c))
const TH = 'px-3 py-2 font-semibold text-left whitespace-nowrap'
const TD = 'px-3 py-2.5 align-top text-xs'
const AMT = 'px-3 py-2.5 align-top text-right font-mono text-xs whitespace-nowrap'

function Section({ letter, title, hint, total, count, open, onToggle, children }: {
  letter?: string; title: string; hint?: string; total?: number; count?: number; open: boolean; onToggle: () => void; children: ReactNode
}) {
  return (
    <section className="s-card overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-left border-b border-s-border bg-s-bg-soft">
        <span aria-hidden className="text-xs text-s-muted w-3">{open ? '▾' : '▸'}</span>
        <span className="text-sm font-bold text-s-text">{letter && <span className="text-success mr-1.5">{letter}</span>}{title}</span>
        {count != null && <span className="text-xs text-s-muted">{count} item{count === 1 ? '' : 's'}</span>}
        {total != null && <span className="ml-auto font-mono text-sm font-bold text-s-text whitespace-nowrap">{fmtPkr(total)}</span>}
      </button>
      {open && (
        <div>
          {hint && <p className="px-4 pt-3 text-xs text-s-muted">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  )
}

function Chips({ underReview, note, clearedOn, recordedOn }: { underReview: boolean; note?: string | null; clearedOn?: string | null; recordedOn?: string | null }) {
  return (
    <>
      {underReview && <span className="s-badge-amber ml-1.5">Under review</span>}
      {clearedOn && <span className="s-badge-blue ml-1.5 whitespace-nowrap">Cleared later on {fmtDay(clearedOn)}</span>}
      {recordedOn && <span className="s-badge-blue ml-1.5 whitespace-nowrap">Booked later on {fmtDay(recordedOn)}</span>}
      {underReview && note && <span className="block text-s-muted mt-0.5 break-words">{note}</span>}
    </>
  )
}

function EqRow({ label, cents, op, strong, tone }: { label: string; cents: number | null; op?: '+' | '−' | '±' | '='; strong?: boolean; tone?: 'good' | 'bad' }) {
  return (
    <div className={`flex items-baseline gap-2 py-1.5 ${strong ? 'border-t border-s-border font-bold' : ''}`}>
      <span className="w-4 text-center text-s-muted shrink-0">{op ?? ''}</span>
      <span className={`flex-1 min-w-0 text-sm break-words ${strong ? 'text-s-text' : 'text-s-muted'}`}>{label}</span>
      <span className={`font-mono text-sm whitespace-nowrap tabular-nums ${tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-s-red' : 'text-s-text'}`}>{money(cents)}</span>
    </div>
  )
}

/** One reason / note, then a callback; used by every workflow button. */
function ReasonDialog({ title, label, minLen, submitLabel, intro, onSubmit, onClose }: {
  title: string; label: string; minLen: number; submitLabel: string; intro?: string
  onSubmit: (text: string) => Promise<unknown>; onClose: () => void
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const run = useMutation({ mutationFn: () => onSubmit(text.trim()), onSuccess: onClose, onError: (e) => setErr(errText(e)) })
  const missing = text.trim().length < minLen ? `${label}: at least ${minLen} characters.` : null
  return (
    <Dialog title={title} onClose={onClose} dirty={text.length > 0}>
      <DialogForm busy={run.isPending} missing={missing} onSubmit={() => { setErr(null); run.mutate() }}>
        {intro && <p className="text-sm text-s-muted mb-3">{intro}</p>}
        <Field label={label} required>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={500} aria-invalid={missing ? true : undefined} />
        </Field>
        {err && <div className="mt-3"><ErrorBanner message={err} /></div>}
        <DialogFooter onCancel={onClose}>
          <Button type="submit" disabled={run.isPending}>{run.isPending ? 'Saving…' : submitLabel}</Button>
        </DialogFooter>
      </DialogForm>
    </Dialog>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

type Tool =
  | { kind: 'book'; item: BankItem; debit: boolean }
  | { kind: 'match'; item: BankItem; debit: boolean }
  | { kind: 'ignore'; item: BankItem }
  | { kind: 'flag'; item: BookItem }
  | { kind: 'cleared'; item: BookItem }
  | { kind: 'matchBank'; item: BookItem; deposit: boolean }
  | { kind: 'clearManual'; item: BookItem; deposit: boolean }
  | { kind: 'addAdj' }
  | { kind: 'removeAdj'; adj: AdjItem }
  | { kind: 'cancel' } | { kind: 'return' } | { kind: 'reopen' }

export default function BankReconciliationWorkspace() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { canPrepare, canApprove, canReopen } = useBrsRights()
  const [tool, setTool] = useState<Tool | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({ B: true, C: true, D: true, E: true, F: true })
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [exportErr, setExportErr] = useState<string | null>(null)

  const q = useQuery<BrsDetail>({ queryKey: ['brs', id], queryFn: () => api.get(`${BRS}/${id}`) })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['brs', id] })
    void qc.invalidateQueries({ queryKey: ['brs-suggestions', id] })
    void qc.invalidateQueries({ queryKey: ['brs-list'] })
    void qc.invalidateQueries({ queryKey: ['brs-banks'] })
    void qc.invalidateQueries({ queryKey: ['brs-dashboard'] })
  }
  const post = (path: string, body: unknown = {}) => api.post(`${BRS}/${id}${path}`, body)

  const rec = q.data?.reconciliation
  const st = q.data?.statement
  const status = rec?.status
  const editable = status === 'draft' && canPrepare

  // Closing balance as per bank (draft only).
  const [closingDraft, setClosingDraft] = useState<number | undefined>(undefined)
  useEffect(() => setClosingDraft(undefined), [st?.bankClosingCents])
  const saveClosing = useMutation({
    mutationFn: (v: number | null) => api.patch(`${BRS}/${id}`, { bankClosingCents: v }),
    onSuccess: () => { setActionErr(null); refresh() },
    onError: (e) => setActionErr(errText(e)),
  })

  const submit = useMutation({
    mutationFn: () => post('/submit'),
    onSuccess: () => { setActionErr(null); refresh() },
    onError: (e) => setActionErr(errText(e)),
  })
  const approve = useMutation({
    mutationFn: () => post('/approve'),
    onSuccess: () => { setActionErr(null); refresh() },
    onError: (e) => setActionErr(errText(e)),
  })
  const review = useMutation({
    mutationFn: (b: { statementLineId?: string; journalLineId?: string; underReview: boolean; note?: string }) => post('/review', b),
    onSuccess: () => { setActionErr(null); refresh() },
    onError: (e) => setActionErr(errText(e)),
  })
  const undoManual = useMutation({
    mutationFn: (journalLineId: string) => post('/cleared-manual', { journalLineId, cleared: false }),
    onSuccess: () => { setActionErr(null); refresh() },
    onError: (e) => setActionErr(errText(e)),
  })

  async function printPdf() {
    setExportErr(null)
    const w = window.open('', '_blank')
    try {
      const blob = await api.fetchBlob(`${BRS}/${id}/report?kind=statement&format=pdf`)
      const url = URL.createObjectURL(blob)
      if (w) w.location.href = url
      else await api.download(`${BRS}/${id}/report?kind=statement&format=pdf`, 'bank-reconciliation-statement.pdf')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      w?.close()
      setExportErr(errText(e))
    }
  }

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const close = () => setTool(null)

  if (q.isLoading) return <div className="p-8 text-sm text-s-muted">Loading…</div>
  if (q.error || !rec || !st) {
    return (
      <div className="p-6 sm:p-8 space-y-3">
        <Link href="/finance/bank-reconciliation" className="text-xs text-s-muted hover:text-white/70">← Bank reconciliation</Link>
        <ErrorBanner message={q.error ? errText(q.error) : 'Reconciliation not found.'} />
      </div>
    )
  }

  const t = st.totals
  const A = st.bankClosingCents
  const closingShown = closingDraft ?? A ?? 0
  const otherAdjM2 = t.expectedBankCents - (st.book.closingCents - t.depositsCents + t.chequesCents + t.bankCreditsCents - t.bankDebitsCents)
  const m2Diff = A == null ? null : A - t.expectedBankCents
  const balanced = t.differenceCents === 0
  const filename = `bank-reconciliation-${st.bank.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${st.periodTo}`
  const reportPath = (kind: string) => `${BRS}/${id}/report?kind=${kind}`

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/finance/bank-reconciliation" className="text-xs text-s-muted hover:text-white/70">← Bank reconciliation</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-success">Finance</p>
            <h1 className="text-2xl font-black text-white/90 break-words">Bank reconciliation · {st.bank.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip status={rec.status} />
              <span className="text-sm text-s-muted">{periodLabel(st.periodFrom, st.periodTo)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu path={reportPath('statement')} filename={filename} label="Statement" onError={setExportErr} />
            <ExportMenu path={reportPath('cheques')} filename={`${filename}-outstanding-cheques`} label="Outstanding cheques" onError={setExportErr} />
            <ExportMenu path={reportPath('deposits')} filename={`${filename}-uncredited-deposits`} label="Uncredited deposits" onError={setExportErr} />
            <ExportMenu path={reportPath('unmatched')} filename={`${filename}-unmatched`} label="Unmatched bank transactions" onError={setExportErr} />
            <button type="button" className="s-btn-secondary text-sm" onClick={() => void printPdf()}>Print</button>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-sm">
          {[
            ['Bank', st.bank.bankName ?? st.bank.name],
            ['Account number', st.bank.accountNumber ?? '—'],
            ['Chart account', `${st.bank.accountCode}${st.bank.accountName ? ` · ${st.bank.accountName}` : ''}`],
            ['Financial year', st.financialYear],
            ['Prepared by', rec.preparedBy ? `${rec.preparedBy}${rec.preparedAt ? ` · ${fmtStamp(rec.preparedAt)}` : ''}` : '—'],
            ['Submitted by', rec.submittedBy ? `${rec.submittedBy}${rec.submittedAt ? ` · ${fmtStamp(rec.submittedAt)}` : ''}` : '—'],
            ['Approved by', rec.status === 'approved' && rec.approvedBy ? `${rec.approvedBy}${rec.approvedAt ? ` · ${fmtStamp(rec.approvedAt)}` : ''}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-xs text-s-muted">{k}</dt><dd className="text-s-text break-words">{v}</dd></div>
          ))}
        </dl>
      </header>

      <div className="px-4 py-5 sm:px-7 space-y-5">
        {exportErr && <ErrorBanner message={exportErr} />}
        {actionErr && <ErrorBanner message={actionErr} />}
        {rec.returnNote && rec.status === 'draft' && (
          <div role="alert" className="rounded-lg border border-s-red/40 bg-s-red-dim px-4 py-3 text-sm text-s-text">
            <p className="font-bold">Returned{rec.returnedBy ? ` by ${rec.returnedBy}` : ''}</p>
            <p className="break-words">{rec.returnNote}</p>
          </div>
        )}
        {q.data!.changedSinceApproval && (
          <div role="alert" className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-4 py-3 text-sm text-s-text">
            <p className="font-bold">The books changed after this was approved.</p>
            <p>The figures below are the approved ones.{q.data!.live ? ` Today the difference would be ${money(q.data!.live.differenceCents)}.` : ''} Reopen it to bring it up to date.</p>
          </div>
        )}
        {status === 'approved' && (
          <div className="rounded-lg border border-s-border px-4 py-3 text-sm text-s-text" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.12)' }}>
            Approved and locked. Nothing in this period can be changed{rec.reopenCount > 0 ? ` (reopened ${rec.reopenCount} time${rec.reopenCount === 1 ? '' : 's'} before)` : ''}.
          </div>
        )}
        {status === 'submitted' && <div className="rounded-lg border border-s-border px-4 py-3 text-sm text-s-text bg-s-bg-soft">Submitted — waiting for the CEO to approve or return it.</div>}
        {rec.reopenReason && status !== 'approved' && <p className="text-xs text-s-muted">Reopened: {rec.reopenReason}</p>}

        {/* Workflow */}
        <div className="flex flex-wrap items-center gap-2">
          {status === 'draft' && canPrepare && (
            <>
              <Button disabled={submit.isPending} onClick={async () => {
                if (await confirm({ title: 'Submit for approval?', body: 'The CEO will review this reconciliation. You cannot change it while it waits.', confirmLabel: 'Submit' })) submit.mutate()
              }}>{submit.isPending ? 'Submitting…' : 'Submit for approval'}</Button>
              <Button variant="danger" onClick={() => setTool({ kind: 'cancel' })}>Cancel draft</Button>
            </>
          )}
          {status === 'submitted' && canApprove && (
            <>
              <Button disabled={approve.isPending} onClick={async () => {
                if (await confirm({ title: 'Approve and lock this period?', body: 'Matching, adjustments and entries dated in this period for this bank are locked until it is reopened.', confirmLabel: 'Approve & lock' })) approve.mutate()
              }}>{approve.isPending ? 'Approving…' : 'Approve & lock'}</Button>
              <Button variant="secondary" onClick={() => setTool({ kind: 'return' })}>Return</Button>
            </>
          )}
          {status === 'approved' && canReopen && <Button variant="secondary" onClick={() => setTool({ kind: 'reopen' })}>Reopen</Button>}
        </div>

        {/* Balances strip */}
        <section aria-label="Balances" className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ['Opening balance as per books', st.book.openingCents],
            ['Receipts', st.book.receiptsCents],
            ['Payments', st.book.paymentsCents],
            ['Closing balance as per books', st.book.closingCents],
          ].map(([l, c]) => (
            <div key={l as string} className="s-card p-3 min-w-0">
              <p className="text-xs text-s-muted">{l}</p>
              <p className="mt-1 text-base font-black font-mono tabular-nums text-s-text break-words">{fmtPkr(c as number)}</p>
              <p className="text-xs text-s-muted">from the general ledger</p>
            </div>
          ))}
          <div className="s-card p-3 min-w-0 col-span-2 lg:col-span-1">
            <p className="text-xs text-s-muted">Closing balance as per bank statement</p>
            {editable ? (
              <div className="mt-1 space-y-2">
                <MoneyInput allowNegative value={closingShown} onChange={setClosingDraft} ariaLabel="Closing balance as per bank statement" className="s-input w-full" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={closingDraft === undefined || saveClosing.isPending} onClick={() => saveClosing.mutate(closingDraft ?? 0)}>
                    {saveClosing.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  {A != null && <Button size="sm" variant="secondary" disabled={saveClosing.isPending} onClick={() => saveClosing.mutate(null)}>Clear</Button>}
                </div>
                {A == null && closingDraft === undefined && <p className="text-xs text-s-amber">Not entered yet.</p>}
              </div>
            ) : (
              <p className="mt-1 text-base font-black font-mono tabular-nums text-s-text">{money(A)}</p>
            )}
          </div>
        </section>

        {/* Summary */}
        <section className="s-card p-4" aria-label="Reconciliation summary">
          <h2 className="text-sm font-bold text-s-text mb-3">Reconciliation summary</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Method 1 · Bank to books</p>
              <EqRow label="Balance as per bank statement (A)" cents={A} />
              <EqRow op="+" label="Deposits not yet credited by the bank (B)" cents={t.depositsCents} />
              <EqRow op="−" label="Cheques issued but not presented (C)" cents={t.chequesCents} />
              <EqRow op="±" label="Bank-side adjustments (F)" cents={t.bankAdjustmentsCents} />
              <EqRow op="=" strong label="Adjusted balance as per bank" cents={t.adjustedBankCents} />
              <div className="h-3" />
              <EqRow label="Balance as per books" cents={st.book.closingCents} />
              <EqRow op="+" label="Bank credits not in books (D)" cents={t.bankCreditsCents} />
              <EqRow op="−" label="Bank debits not in books (E)" cents={t.bankDebitsCents} />
              <EqRow op="±" label="Book-side adjustments (F)" cents={t.bookAdjustmentsCents} />
              <EqRow op="=" strong label="Adjusted balance as per books" cents={t.adjustedBookCents} />
              <div className="mt-2 rounded-lg px-3 py-2 flex items-baseline gap-2"
                style={{ background: t.differenceCents == null ? 'var(--elevated)' : balanced ? 'rgb(var(--erp-accent-rgb) / 0.15)' : 'var(--erp-danger-dim, rgb(180 35 24 / 0.1))' }}>
                <span className="flex-1 text-sm font-bold text-s-text">Unreconciled difference</span>
                <span className={`font-mono text-base font-black whitespace-nowrap ${t.differenceCents == null ? 'text-s-muted' : balanced ? 'text-success' : 'text-s-red'}`}>
                  {t.differenceCents == null ? 'Enter the bank closing balance' : fmtPkr(t.differenceCents)}
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Method 2 · Books to bank (check)</p>
              <EqRow label="Closing balance as per books" cents={st.book.closingCents} />
              <EqRow op="−" label="Deposits not yet credited (B)" cents={t.depositsCents} />
              <EqRow op="+" label="Cheques not presented (C)" cents={t.chequesCents} />
              <EqRow op="+" label="Bank credits not in books (D)" cents={t.bankCreditsCents} />
              <EqRow op="−" label="Bank debits not in books (E)" cents={t.bankDebitsCents} />
              <EqRow op="±" label="Adjustments (F)" cents={otherAdjM2} />
              <EqRow op="=" strong label="Balance the bank statement should show" cents={t.expectedBankCents} />
              <EqRow label="Closing balance as per bank statement" cents={A} />
              <EqRow strong label="Difference" cents={m2Diff} tone={m2Diff == null ? undefined : m2Diff === 0 ? 'good' : 'bad'} />
              <p className="text-xs text-s-muted mt-3">
                {t.matchedCount} line{t.matchedCount === 1 ? '' : 's'} matched · {t.underReviewCount} under review
                {st.firstReconciliation && ' · first reconciliation of this bank'}
              </p>
            </div>
          </div>
        </section>

        {/* Sections */}
        <Section letter="B" title="Deposits not yet credited by the bank" total={t.depositsCents} count={st.deposits.length}
          open={!!open.B} onToggle={() => toggle('B')}>
          <BookTable items={st.deposits} kind="deposit" st={st} editable={editable} busy={review.isPending}
            onFlag={(i) => setTool({ kind: 'flag', item: i })} onUnflag={(i) => review.mutate({ journalLineId: i.journalLineId, underReview: false })}
            onCleared={(i) => setTool({ kind: 'cleared', item: i })} onMatchBank={(i) => setTool({ kind: 'matchBank', item: i, deposit: true })} onClearManual={(i) => setTool({ kind: 'clearManual', item: i, deposit: true })} />
        </Section>

        <Section letter="C" title="Cheques issued but not presented" total={t.chequesCents} count={st.cheques.length}
          open={!!open.C} onToggle={() => toggle('C')}>
          <BookTable items={st.cheques} kind="cheque" st={st} editable={editable} busy={review.isPending}
            onFlag={(i) => setTool({ kind: 'flag', item: i })} onUnflag={(i) => review.mutate({ journalLineId: i.journalLineId, underReview: false })}
            onCleared={(i) => setTool({ kind: 'cleared', item: i })} onMatchBank={(i) => setTool({ kind: 'matchBank', item: i, deposit: false })} onClearManual={(i) => setTool({ kind: 'clearManual', item: i, deposit: false })} />
        </Section>

        <Section letter="D" title="Amounts credited by the bank, not in the books" total={t.bankCreditsCents} count={st.bankCredits.length}
          hint="Interest, direct deposits and transfers in that the books do not have yet. “Book entry” posts the voucher to the ledger at once."
          open={!!open.D} onToggle={() => toggle('D')}>
          <BankTable items={st.bankCredits} editable={editable} busy={review.isPending}
            onBook={(i) => setTool({ kind: 'book', item: i, debit: false })} onMatch={(i) => setTool({ kind: 'match', item: i, debit: false })}
            onIgnore={(i) => setTool({ kind: 'ignore', item: i })}
            onReview={(i, on) => review.mutate({ statementLineId: i.statementLineId, underReview: on })} />
        </Section>

        <Section letter="E" title="Amounts debited by the bank, not in the books" total={t.bankDebitsCents} count={st.bankDebits.length}
          hint="Typical: bank charges (6080), withholding tax deducted by the bank, cheque return charges. “Book entry” posts the voucher to the ledger at once."
          open={!!open.E} onToggle={() => toggle('E')}>
          <BankTable items={st.bankDebits} editable={editable} busy={review.isPending}
            onBook={(i) => setTool({ kind: 'book', item: i, debit: true })} onMatch={(i) => setTool({ kind: 'match', item: i, debit: true })}
            onIgnore={(i) => setTool({ kind: 'ignore', item: i })}
            onReview={(i, on) => review.mutate({ statementLineId: i.statementLineId, underReview: on })} />
        </Section>

        {(st.manuallyCleared?.length ?? 0) > 0 && (
          <Section title="Cleared by manual entry this period" total={(st.manuallyCleared ?? []).reduce((x, i) => x + i.amountCents, 0)} count={st.manuallyCleared!.length}
            hint="Cheques and deposits marked cleared by the bank by hand (no statement line). They are not outstanding; nothing was posted to the ledger."
            open={!!open.M} onToggle={() => toggle('M')}>
            <ManuallyClearedTable items={st.manuallyCleared!} editable={editable} busy={undoManual.isPending}
              onUndo={async (i) => {
                const ok = await confirm({ title: 'Undo "cleared by bank"?', body: `${i.voucherNo ?? ''} ${i.description} goes back to the outstanding list.`, confirmLabel: 'Undo' })
                if (ok) undoManual.mutate(i.journalLineId)
              }} />
          </Section>
        )}

        <Section letter="F" title="Other adjustments and errors" count={st.adjustments.length}
          hint="Errors by the bank or in the books, duplicates and wrong amounts. These change the reconciliation only — nothing is posted to the ledger."
          open={!!open.F} onToggle={() => toggle('F')}>
          {st.adjustments.length === 0 ? <CompactEmptyState message="No adjustments." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-s-muted border-b border-s-border">
                  <th className={TH}>Date</th><th className={TH}>Side</th><th className={TH}>Kind</th><th className={TH}>Reference</th><th className={TH}>Narration</th><th className={`${TH} text-right`}>Amount</th><th className="px-3 py-2" />
                </tr></thead>
                <tbody>
                  {st.adjustments.map((a) => (
                    <tr key={a.id} className="border-b border-s-border">
                      <td className={`${TD} whitespace-nowrap`}>{fmtDay(a.createdAt)}</td>
                      <td className={TD}>{a.side === 'bank' ? 'Bank' : 'Books'}</td>
                      <td className={TD}>{a.kindLabel}</td>
                      <td className={`${TD} break-words`}>{a.reference}</td>
                      <td className={`${TD} min-w-[12rem] break-words`}>{a.narration}</td>
                      <td className={AMT}>{fmtPkr(a.amountCents)}</td>
                      <td className={`${TD} text-right`}>{editable && <LinkButton tone="muted" size="md" onClick={() => setTool({ kind: 'removeAdj', adj: a })}>Remove</LinkButton>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {editable && <div className="p-3"><LinkButton size="md" onClick={() => setTool({ kind: 'addAdj' })}>+ Add adjustment</LinkButton></div>}
        </Section>

        {editable && <Suggestions id={id} onDone={refresh} />}
        {!!rec && status !== 'approved' && canPrepare && <ImportPanel rec={rec} bankName={st.bank.name} periodTo={st.periodTo} bankClosing={A} onDone={refresh} />}

        {/* History */}
        <section className="s-card p-4">
          <h2 className="text-sm font-bold text-s-text mb-2">History</h2>
          {q.data!.history.length === 0 ? <p className="text-sm text-s-muted">Nothing yet.</p> : (
            <ul className="space-y-1.5">
              {q.data!.history.map((h, i) => (
                <li key={i} className="text-sm flex flex-wrap gap-x-3">
                  <span className="text-s-muted whitespace-nowrap">{fmtStamp(h.at)}</span>
                  <span className="text-s-text font-semibold">{h.action.replace(/[._]/g, ' ')}</span>
                  <span className="text-s-muted">{h.by ?? ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Tools */}
      {tool?.kind === 'clearManual' && <ClearManualDialog id={id} item={tool.item} deposit={tool.deposit} periodTo={st.periodTo} onClose={close} onDone={refresh} />}
      {tool?.kind === 'matchBank' && (
        <MatchToBankLine recId={id} item={tool.item} deposit={tool.deposit} periodTo={st.periodTo} onDone={() => { close(); refresh() }} onClose={close} />
      )}
      {tool?.kind === 'book' && (
        <Dialog title="Book an entry from this bank line" onClose={close}>
          <p className="text-xs text-s-muted px-4 pt-2 break-words">{fmtDay(tool.item.date)} · {tool.item.description}{tool.item.reference ? ` · ${tool.item.reference}` : ''}</p>
          <AdjustForm line={{ id: tool.item.statementLineId, description: tool.item.description, amountCents: tool.debit ? -Math.abs(tool.item.amountCents) : Math.abs(tool.item.amountCents) }}
            raastAccount={false}
            hint={tool.debit ? 'For bank charges use 6080; for tax the bank withheld, use your withholding-tax account.' : undefined}
            onCancel={close} onDone={() => { close(); refresh() }} />
        </Dialog>
      )}
      {tool?.kind === 'match' && (
        <Dialog title="Match to a book entry" onClose={close}>
          <ManualMatch line={{ id: tool.item.statementLineId, description: tool.item.description, amountCents: tool.debit ? -Math.abs(tool.item.amountCents) : Math.abs(tool.item.amountCents) }}
            onCancel={close} onDone={() => { close(); refresh() }} />
        </Dialog>
      )}
      {tool?.kind === 'ignore' && <IgnoreDialog item={tool.item} onClose={close} onDone={refresh} />}
      {tool?.kind === 'flag' && (
        <ReasonDialog title="Mark under review" label="Why is it under review?" minLen={3} submitLabel="Mark under review"
          onSubmit={(note) => post('/review', { journalLineId: tool.item.journalLineId, underReview: true, note }).then(refresh)} onClose={close} />
      )}
      {tool?.kind === 'cleared' && <ClearedDialog id={id} item={tool.item} onClose={close} onDone={refresh} />}
      {tool?.kind === 'addAdj' && <AddAdjustment id={id} onClose={close} onDone={refresh} />}
      {tool?.kind === 'removeAdj' && (
        <ReasonDialog title="Remove adjustment" label="Reason" minLen={10} submitLabel="Remove"
          intro={`${tool.adj.kindLabel} · ${fmtPkr(tool.adj.amountCents)} · ${tool.adj.reference}`}
          onSubmit={(reason) => post(`/adjustments/${tool.adj.id}/remove`, { reason }).then(refresh)} onClose={close} />
      )}
      {tool?.kind === 'cancel' && (
        <ReasonDialog title="Cancel this draft" label="Reason" minLen={10} submitLabel="Cancel draft"
          intro="The draft is removed. Entries and statement lines are not touched."
          onSubmit={(reason) => post('/cancel', { reason }).then(() => router.push('/finance/bank-reconciliation'))} onClose={close} />
      )}
      {tool?.kind === 'return' && (
        <ReasonDialog title="Return to finance" label="What needs correcting?" minLen={10} submitLabel="Return"
          onSubmit={(note) => post('/return', { note }).then(refresh)} onClose={close} />
      )}
      {tool?.kind === 'reopen' && (
        <ReasonDialog title="Reopen this reconciliation" label="Reason" minLen={10} submitLabel="Reopen"
          intro="It goes back to draft and the period is unlocked until it is submitted and approved again."
          onSubmit={(reason) => post('/reopen', { reason }).then(refresh)} onClose={close} />
      )}
    </div>
  )
}

// ── tables ───────────────────────────────────────────────────────────────────

function BookTable({ items, kind, st, editable, busy, onFlag, onUnflag, onCleared, onMatchBank, onClearManual }: {
  items: BookItem[]; kind: 'deposit' | 'cheque'; st: BrsDetail['statement']; editable: boolean; busy: boolean
  onFlag: (i: BookItem) => void; onUnflag: (i: BookItem) => void; onCleared: (i: BookItem) => void; onMatchBank: (i: BookItem) => void
  onClearManual: (i: BookItem) => void
}) {
  if (items.length === 0) return <CompactEmptyState message={kind === 'deposit' ? 'No uncredited deposits.' : 'No unpresented cheques.'} />
  const dep = kind === 'deposit'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-s-muted border-b border-s-border">
          <th className={TH}>{dep ? 'Date' : 'Cheque date'}</th>
          <th className={TH}>{dep ? 'Receipt voucher' : 'Payment voucher'}</th>
          <th className={TH}>{dep ? 'Cheque / deposit ref' : 'Cheque no.'}</th>
          <th className={TH}>{dep ? 'Depositor' : 'Payee'}</th>
          <th className={TH}>Description</th>
          <th className={`${TH} text-right`}>Amount</th>
          <th className="px-3 py-2" />
        </tr></thead>
        <tbody>
          {items.map((i) => {
            const canClear = editable && st.firstReconciliation && i.date < st.periodFrom && !i.raast
            return (
              <tr key={i.journalLineId} className="border-b border-s-border">
                <td className={`${TD} whitespace-nowrap`}>{fmtDay(i.date)}</td>
                <td className={`${TD} font-mono whitespace-nowrap`}>{i.voucherNo ?? '—'}</td>
                <td className={`${TD} break-words`}>{i.chequeRef ?? '—'}</td>
                <td className={`${TD} break-words`}>{i.party ?? '—'}</td>
                <td className={`${TD} min-w-[12rem] break-words`}>{i.description}<Chips underReview={i.underReview} note={i.reviewNote} clearedOn={i.clearedOn} /></td>
                <td className={AMT}>{fmtPkr(i.amountCents)}</td>
                <td className={`${TD} text-right`}>
                  {editable && !i.raast && (
                    <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
                      <LinkButton size="md" onClick={() => onClearManual(i)} title="The bank has cleared it — enter the date and the bank's reference by hand (no statement needed)">{i.manualClear ? 'Edit clearing' : 'Cleared by bank'}</LinkButton>
                      <LinkButton tone="muted" size="md" onClick={() => onMatchBank(i)} title="Pair it with its line on an imported bank statement">Match to bank line</LinkButton>
                      {i.underReview
                        ? <LinkButton tone="muted" size="md" disabled={busy} onClick={() => onUnflag(i)}>Clear review</LinkButton>
                        : <LinkButton tone="muted" size="md" onClick={() => onFlag(i)}>Under review</LinkButton>}
                      {canClear && <LinkButton size="md" onClick={() => onCleared(i)} title="Cleared before this reconciliation — part of the opening bank balance">Cleared before</LinkButton>}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function BankTable({ items, editable, busy, onBook, onMatch, onIgnore, onReview }: {
  items: BankItem[]; editable: boolean; busy: boolean
  onBook: (i: BankItem) => void; onMatch: (i: BankItem) => void; onIgnore: (i: BankItem) => void; onReview: (i: BankItem, on: boolean) => void
}) {
  if (items.length === 0) return <CompactEmptyState message="Nothing here." />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-s-muted border-b border-s-border">
          <th className={TH}>Date</th><th className={TH}>Bank ref</th><th className={TH}>Description</th><th className={`${TH} text-right`}>Amount</th><th className="px-3 py-2" />
        </tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.statementLineId} className="border-b border-s-border">
              <td className={`${TD} whitespace-nowrap`}>{fmtDay(i.date)}</td>
              <td className={`${TD} break-words`}>{i.reference ?? '—'}</td>
              <td className={`${TD} min-w-[12rem] break-words`}>{i.description}<Chips underReview={i.underReview} recordedOn={i.recordedOn} />
                {i.matchStatus !== 'unmatched' && <span className="s-badge-muted ml-1.5">{i.matchStatus}</span>}</td>
              <td className={AMT}>{fmtPkr(i.amountCents)}</td>
              <td className={`${TD} text-right`}>
                {editable && (
                  <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
                    <LinkButton size="md" onClick={() => onBook(i)}>Book entry</LinkButton>
                    <LinkButton size="md" onClick={() => onMatch(i)}>Match to book entry</LinkButton>
                    <LinkButton tone="muted" size="md" disabled={busy} onClick={() => onReview(i, !i.underReview)}>{i.underReview ? 'Clear review' : 'Under review'}</LinkButton>
                    <LinkButton tone="muted" size="md" onClick={() => onIgnore(i)}>Ignore</LinkButton>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function IgnoreDialog({ item, onClose, onDone }: { item: BankItem; onClose: () => void; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const ignore = useMutation({
    mutationFn: (reason: string) => api.post(`/reconciliation/bank/lines/${item.statementLineId}/ignore`, { reason }),
    onSuccess: () => { onClose(); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  return (
    <Dialog title="Ignore this bank line" onClose={onClose}>
      <p className="text-xs text-s-muted px-4 pt-2 break-words">{fmtDay(item.date)} · {item.description} · {fmtPkr(item.amountCents)}</p>
      <IgnoreForm busy={ignore.isPending} onCancel={onClose} onSubmit={(r) => { setErr(null); ignore.mutate(r) }} />
      {err && <div className="px-4 pb-3"><ErrorBanner message={err} /></div>}
    </Dialog>
  )
}

function ClearedDialog({ id, item, onClose, onDone }: { id: string; item: BookItem; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: () => api.post(`${BRS}/${id}/cleared-prior`, { journalLineId: item.journalLineId, cleared: true, note: note.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) }),
    onSuccess: () => { onClose(); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  const missing = note.trim().length < 10 ? 'Add a note of at least 10 characters.' : null
  return (
    <Dialog title="Cleared before this reconciliation" onClose={onClose} dirty={!!note}>
      <DialogForm busy={run.isPending} missing={missing} onSubmit={() => { setErr(null); run.mutate() }}>
        <p className="text-sm text-s-muted mb-3 break-words">
          {fmtDay(item.date)} · {item.description} · {fmtPkr(item.amountCents)}. The bank already cleared this before the period began, so it is part of the opening bank balance and leaves this list.
        </p>
        <div className="space-y-3">
          <Field label="Note" required><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-invalid={missing ? true : undefined} /></Field>
          <Field label="Reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
        </div>
        {err && <div className="mt-3"><ErrorBanner message={err} /></div>}
        <DialogFooter onCancel={onClose}><Button type="submit" disabled={run.isPending}>{run.isPending ? 'Saving…' : 'Save'}</Button></DialogFooter>
      </DialogForm>
    </Dialog>
  )
}

const KINDS: Array<[string, string]> = [
  ['bank_error', 'Bank error'], ['book_error', 'Error in the books'], ['duplicate', 'Duplicate'], ['wrong_amount', 'Wrong amount'], ['other', 'Other'],
]

function AddAdjustment({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [side, setSide] = useState<'bank' | 'book'>('bank')
  const [kind, setKind] = useState('bank_error')
  const [amount, setAmount] = useState(0)
  const [narration, setNarration] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: () => api.post(`${BRS}/${id}/adjustments`, { side, kind, amountCents: amount, narration: narration.trim(), reference: reference.trim() }),
    onSuccess: () => { onClose(); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  const missing = amount === 0 ? 'Enter the amount (not zero).'
    : narration.trim().length < 10 ? 'The narration needs at least 10 characters.'
    : !reference.trim() ? 'Enter a reference.' : null
  return (
    <Dialog title="Add adjustment" onClose={onClose} dirty={!!narration || amount !== 0}>
      <DialogForm busy={run.isPending} missing={missing} onSubmit={() => { setErr(null); run.mutate() }}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Adjusts">
              <Select value={side} onChange={(e) => setSide(e.target.value as 'bank' | 'book')} className="s-input w-full">
                <option value="bank">Balance as per bank</option><option value="book">Balance as per books</option>
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)} className="s-input w-full">
                {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Amount (PKR)" hint="Positive adds to the adjusted balance of that side; use a minus sign to take away." required>
            <MoneyInput allowNegative value={amount} onChange={setAmount} className="s-input w-full" aria-invalid={amount === 0 ? true : undefined} />
          </Field>
          <Field label="Reference" required><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
          <Field label="Narration" required><Textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={500} /></Field>
        </div>
        {err && <div className="mt-3"><ErrorBanner message={err} /></div>}
        <DialogFooter onCancel={onClose}><Button type="submit" disabled={run.isPending}>{run.isPending ? 'Saving…' : 'Add'}</Button></DialogFooter>
      </DialogForm>
    </Dialog>
  )
}

// ── suggested matches ────────────────────────────────────────────────────────

interface Suggestion { statementLineId: string; journalLineId: string; reason: string; date: string; amountCents: number; description: string; book: string }

function Suggestions({ id, onDone }: { id: string; onDone: () => void }) {
  const [days, setDays] = useState(7)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{ matched: number; refused: Array<{ statementLineId: string; code: string; message: string }> } | null>(null)
  const q = useQuery<Suggestion[]>({ queryKey: ['brs-suggestions', id, days], queryFn: () => api.get(`${BRS}/${id}/suggestions?days=${days}`) })
  const rows = q.data ?? []
  const key = (s: Suggestion) => `${s.statementLineId}|${s.journalLineId}`
  useEffect(() => setPicked(new Set()), [q.data])
  const apply = useMutation({
    mutationFn: () => api.post<{ matched: number; refused: Array<{ statementLineId: string; code: string; message: string }> }>(`${BRS}/${id}/auto-match`, {
      pairs: rows.filter((s) => picked.has(key(s))).map((s) => ({ statementLineId: s.statementLineId, journalLineId: s.journalLineId })),
    }),
    onSuccess: (r) => { setResult(r); onDone() },
  })
  const all = rows.length > 0 && rows.every((s) => picked.has(key(s)))
  return (
    <section className="s-card overflow-hidden">
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-s-text mr-auto">Suggested matches</h2>
        <label className="text-xs text-s-muted inline-flex items-center gap-2">Dates within
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="s-input w-auto">
            {[3, 7, 15, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
          </Select>
        </label>
      </div>
      {q.error ? <p className="p-4 text-sm text-s-red">{errText(q.error)}</p>
        : q.isLoading ? <p className="p-4 text-sm text-s-muted">Looking…</p>
        : rows.length === 0 ? <CompactEmptyState message="No suggestions — the rest need a person." />
        : (
          <div>
            <label className="px-4 py-2 flex items-center gap-2 text-xs text-s-muted border-b border-s-border">
              <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map(key)))} /> Select all {rows.length}
            </label>
            <ul>
              {rows.map((s) => (
                <li key={key(s)} className="px-4 py-2.5 border-b border-s-border">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" className="mt-1" checked={picked.has(key(s))}
                      onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(key(s))) n.delete(key(s)); else n.add(key(s)); return n })} />
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="block text-s-text break-words">{fmtDay(s.date)} · {s.description}</span>
                      <span className="block text-s-muted break-words">Book: {s.book}</span>
                      <span className="block text-s-muted">{s.reason}</span>
                    </span>
                    <span className="font-mono text-xs whitespace-nowrap">{fmtPkr(s.amountCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="p-3 flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={picked.size === 0 || apply.isPending} onClick={() => { setResult(null); apply.mutate() }}>
                {apply.isPending ? 'Matching…' : `Apply selected (${picked.size})`}
              </Button>
              {apply.error && <span className="text-xs text-s-red">{errText(apply.error)}</span>}
            </div>
          </div>
        )}
      {result && (
        <div className="px-4 pb-3 text-xs space-y-1" role="status">
          <p className="text-success font-semibold">{result.matched} matched.</p>
          {result.refused.map((r) => <p key={r.statementLineId} className="text-s-red break-words">Not matched: {r.message}</p>)}
        </div>
      )}
    </section>
  )
}

// ── statement import ─────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function ImportPanel({ rec, bankName, periodTo, bankClosing, onDone }: { rec: BrsDetail['reconciliation']; bankName: string; periodTo: string; bankClosing: number | null; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(periodTo > todayPktIso() ? todayPktIso() : periodTo)
  const [opening, setOpening] = useState(0)
  const [closing, setClosing] = useState(bankClosing ?? 0)
  const [csv, setCsv] = useState('')
  const [xlsx, setXlsx] = useState<{ name: string; b64: string } | null>(null)
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [readErr, setReadErr] = useState<string | null>(null)

  async function pick(f: File | undefined) {
    setReadErr(null); setResult(null)
    if (!f) return
    try {
      if (/\.xlsx$/i.test(f.name)) { setXlsx({ name: f.name, b64: toBase64(await f.arrayBuffer()) }); setCsv(''); setFileName(f.name) }
      else if (/\.(csv|txt)$/i.test(f.name)) { setCsv(await f.text()); setXlsx(null); setFileName(f.name) }
      else setReadErr('Choose a .csv or .xlsx file.')
    } catch { setReadErr('That file could not be read.') }
  }

  const imp = useMutation({
    mutationFn: () => {
      const name = fileName || `${bankName}-${date}.csv`
      const fileUrl = xlsx
        ? (xlsx.b64.length < 3_000_000 ? `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsx.b64}` : `data:text/plain;base64,${btoa(name)}`)
        : `data:text/csv;base64,${btoa(unescape(encodeURIComponent(csv)))}`
      return api.post<Record<string, unknown>>('/reconciliation/bank/imports', {
        bankAccountId: rec.bankAccountId, statementDate: date, openingBalanceCents: opening, closingBalanceCents: closing,
        ...(xlsx ? { xlsxBase64: xlsx.b64 } : { csv }), filename: name, fileUrl,
      })
    },
    onSuccess: (r) => { setResult(r); onDone() },
  })
  const missing = !xlsx && !csv.trim() ? 'Choose the statement file (CSV or Excel) or paste the CSV.' : !date ? 'Pick the statement date.' : null
  const skipped = typeof result?.skippedDuplicates === 'number' ? (result.skippedDuplicates as number) : null

  return (
    <section className="s-card overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full px-4 py-3 flex items-center gap-3 text-left bg-s-bg-soft">
        <span aria-hidden className="text-xs text-s-muted w-3">{open ? '▾' : '▸'}</span>
        <span className="text-sm font-bold text-s-text">Import bank statement for {bankName}</span>
      </button>
      {open && (
        <div className="p-4 border-t border-s-border">
          <DialogForm busy={imp.isPending} missing={missing} onSubmit={() => { setResult(null); imp.mutate() }}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Statement date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={todayPktIso()} /></Field>
              <Field label="Opening balance (PKR)"><MoneyInput allowNegative value={opening} onChange={setOpening} className="s-input w-full" /></Field>
              <Field label="Closing balance (PKR)"><MoneyInput allowNegative value={closing} onChange={setClosing} className="s-input w-full" /></Field>
            </div>
            <div className="mt-3">
              <Field label="Statement file (CSV or Excel .xlsx)" hint="Columns: date, description, amount, reference. Lines already imported are skipped.">
                <input type="file" accept=".csv,.txt,.xlsx" onChange={(e) => void pick(e.target.files?.[0])} className="s-input w-full" />
              </Field>
              {readErr && <p role="alert" className="text-xs text-s-red mt-1">{readErr}</p>}
              {xlsx && <p className="text-xs text-success mt-1 break-words">Excel file ready: {xlsx.name}</p>}
            </div>
            {!xlsx && (
              <div className="mt-3">
                <Field label="Or paste the CSV">
                  <Textarea rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setFileName('') }} className="w-full font-mono" placeholder="date,description,amount,reference" />
                </Field>
              </div>
            )}
            {imp.error && <div className="mt-3"><ErrorBanner message={errText(imp.error)} /></div>}
            <div className="mt-3"><Button type="submit" disabled={imp.isPending}>{imp.isPending ? 'Importing…' : 'Import statement'}</Button></div>
          </DialogForm>
          {result && (
            <p role="status" className="text-sm text-success mt-3">
              Statement imported.{skipped != null && ` ${skipped} line${skipped === 1 ? '' : 's'} already imported before were skipped.`}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ── book side: "Match to bank line" (owner, 2026-11-05: "Give finance option to settle these type of issues") ──────
// A deposit / cheque the bank has already credited / paid stays outstanding until it is paired with its line on the
// imported statement. Lists this bank's unmatched lines of the same amount; matching uses the existing engine.
interface BankCandidate { statementLineId: string; date: string; description: string; reference: string | null; amountCents: number; inPeriod: boolean; gapDays: number }
function MatchToBankLine({ recId, item, deposit, periodTo, onDone, onClose }: { recId: string; item: BookItem; deposit: boolean; periodTo: string; onDone: () => void; onClose: () => void }) {
  const q = useQuery<BankCandidate[]>({ queryKey: ['brs-bank-lines', recId, item.journalLineId], queryFn: () => api.get(`${BRS}/${recId}/bank-lines?journalLineId=${encodeURIComponent(item.journalLineId)}`) })
  const m = useMutation({
    mutationFn: (statementLineId: string) => api.post<{ matched: number; refused: Array<{ message: string }> }>(`${BRS}/${recId}/auto-match`, { pairs: [{ statementLineId, journalLineId: item.journalLineId }] }),
    onSuccess: (r) => { if (r.matched > 0) onDone() },
  })
  const refused = m.data && m.data.matched === 0 ? m.data.refused[0]?.message ?? 'The match was refused.' : null
  return (
    <Dialog title="Match to bank line" onClose={onClose} wide>
      <div className="p-4 space-y-3">
        <p className="text-xs text-s-muted break-words">{fmtDay(item.date)} · {item.voucherNo ?? '—'} · {item.description} · <strong className="text-s-text">{fmtPkr(item.amountCents)}</strong></p>
        {q.isLoading ? <p className="text-sm text-s-muted">Loading…</p>
          : q.error ? <ErrorBanner message={(q.error as Error).message} />
          : (q.data ?? []).length === 0 ? (
            <CompactEmptyState message={`No unmatched ${deposit ? 'credit' : 'debit'} of ${fmtPkr(item.amountCents)} on this bank's imported statements. Import the statement that shows it (Import statement), then match it here.`} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-s-muted border-b border-s-border">
                  <th className={TH}>Bank date</th><th className={TH}>Bank ref</th><th className={TH}>Description</th><th className={`${TH} text-right`}>Amount</th><th className="px-3 py-2" />
                </tr></thead>
                <tbody>
                  {q.data!.map((c) => (
                    <tr key={c.statementLineId} className="border-b border-s-border">
                      <td className={`${TD} whitespace-nowrap`}>{fmtDay(c.date)}{!c.inPeriod && <span className="block text-[11px] text-s-muted">after {fmtDay(periodTo)} — clears next period</span>}</td>
                      <td className={`${TD} break-words`}>{c.reference ?? '—'}</td>
                      <td className={`${TD} min-w-[10rem] break-words`}>{c.description}</td>
                      <td className={AMT}>{fmtPkr(c.amountCents)}</td>
                      <td className={`${TD} text-right`}><Button size="sm" disabled={m.isPending} onClick={() => m.mutate(c.statementLineId)}>Match</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {refused && <ErrorBanner message={refused} />}
        {m.error && <ErrorBanner message={(m.error as Error).message} />}
      </div>
    </Dialog>
  )
}

// ── "Cleared by bank" by manual entry (owner, 2026-11-05: "Make it settle by manual entry instead of matching with bank
// statement"). A mark on the reconciliation, never a ledger entry: the clearing date, the bank's reference, a note.
function ClearManualDialog({ id, item, deposit, periodTo, onClose, onDone }: { id: string; item: BookItem; deposit: boolean; periodTo: string; onClose: () => void; onDone: () => void }) {
  const [clearedOn, setClearedOn] = useState(item.manualClear?.clearedOn ?? (todayPktIso() < periodTo ? todayPktIso() : periodTo))
  const [reference, setReference] = useState(item.manualClear?.reference ?? '')
  const [note, setNote] = useState(item.manualClear?.note ?? '')
  const [err, setErr] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: () => api.post(`${BRS}/${id}/cleared-manual`, { journalLineId: item.journalLineId, cleared: true, clearedOn, note: note.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) }),
    onSuccess: () => { onClose(); onDone() },
    onError: (e) => setErr(errText(e)),
  })
  const missing = !clearedOn ? 'Enter the date the bank cleared it.' : note.trim().length < 10 ? 'Add a note of at least 10 characters.' : null
  return (
    <Dialog title={deposit ? 'Deposit credited by the bank' : 'Cheque cleared by the bank'} onClose={onClose} dirty={!!note && !item.manualClear}>
      <DialogForm busy={run.isPending} missing={missing} onSubmit={() => { setErr(null); run.mutate() }}>
        <p className="text-sm text-s-muted mb-3 break-words">
          {fmtDay(item.date)} · {item.voucherNo ?? '—'} · {item.description} · <strong className="text-s-text">{fmtPkr(item.amountCents)}</strong>
        </p>
        <p className="text-xs text-s-muted mb-3">Nothing is posted — the entry is already in the books. Cleared on or before {fmtDay(periodTo)}, it leaves the outstanding list of this reconciliation.</p>
        <div className="space-y-3">
          <Field label={deposit ? 'Date credited by the bank' : 'Date the cheque cleared'} required>
            <Input type="date" value={clearedOn} min={item.date} max={todayPktIso()} onChange={(e) => setClearedOn(e.target.value)} />
          </Field>
          <Field label="Bank reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="e.g. the transaction no. on the bank statement" /></Field>
          <Field label="Note" required><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Seen on the UBL online statement" /></Field>
        </div>
        {err && <div className="mt-3"><ErrorBanner message={err} /></div>}
        <DialogFooter onCancel={onClose}><Button type="submit" disabled={run.isPending}>{run.isPending ? 'Saving…' : 'Mark cleared'}</Button></DialogFooter>
      </DialogForm>
    </Dialog>
  )
}

function ManuallyClearedTable({ items, editable, busy, onUndo }: {
  items: Array<BookItem & { kind: 'deposit' | 'cheque' }>; editable: boolean; busy: boolean; onUndo: (i: BookItem) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-s-muted border-b border-s-border">
          <th className={TH}>Date</th><th className={TH}>Voucher</th><th className={TH}>Kind</th><th className={TH}>Description</th>
          <th className={TH}>Cleared on</th><th className={TH}>Bank ref</th><th className={`${TH} text-right`}>Amount</th><th className="px-3 py-2" />
        </tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.journalLineId} className="border-b border-s-border">
              <td className={`${TD} whitespace-nowrap`}>{fmtDay(i.date)}</td>
              <td className={`${TD} font-mono whitespace-nowrap`}>{i.voucherNo ?? '—'}</td>
              <td className={TD}>{i.kind === 'deposit' ? 'Deposit' : 'Cheque'}</td>
              <td className={`${TD} min-w-[12rem] break-words`}>{i.description}{i.manualClear?.note && <span className="block text-[11px] text-s-muted">{i.manualClear.note}</span>}</td>
              <td className={`${TD} whitespace-nowrap`}>{i.manualClear ? fmtDay(i.manualClear.clearedOn) : '—'}</td>
              <td className={`${TD} break-words`}>{i.manualClear?.reference ?? '—'}</td>
              <td className={AMT}>{fmtPkr(i.amountCents)}</td>
              <td className={`${TD} text-right`}>{editable && <LinkButton tone="muted" size="md" disabled={busy} onClick={() => onUndo(i)}>Undo</LinkButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
