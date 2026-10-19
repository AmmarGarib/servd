'use client'
// One cash voucher (2026-10-15 flow): where it is (Requested → Finance → CEO →
// Paid → Documents → Verified & booked), the actions this login may take (the
// server's capability flags), paying it, the supporting documents, what was
// spent, finance's verification, the printed voucher (+ PDF / Excel after
// approval) and the audit history.

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { useMyTenants } from '../../../components/ui/TenantPicker'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, CV_ROOT, accountWords, errorWords, fmtDate, fmtDateTime, stageOf, useCategories, useHistory,
  usePaySources, usePettyBoxes, useStaffNames, useVoucher, type CashVoucher, type HistoryRow,
} from './data'
import { PrintPortal, VoucherSheet } from './VoucherPrint'
import { VoucherForm } from './VoucherForm'
import { SettlePanel, Thumbs } from './SettlePanel'
import { DocumentsPanel, ResolveByJournalPanel, VerifyPanel } from './DocsPanel'
import { ErrorBanner, StatusBadge, dangerOutlineBtn, fieldCls, primaryBtn, secondaryBtn } from './ui'
import { Select } from '@/components/ui/Select'
import { useConfirm } from '../../../components/ui/ConfirmDialog'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

type Act = 'confirm-received' | 'confirm-received-on-behalf' | 'send-back' | 'finance-approve' | 'approve' | 'return' | 'resubmit' | 'reject' | 'cancel'
const ACT_DONE: Record<Act, string> = {
  'confirm-received': 'Cash received confirmed — finance can now verify the documents.',
  'confirm-received-on-behalf': 'Cash received recorded on the holder\'s behalf — the documents can now be checked.',
  'send-back': 'Sent back — the requester attaches the missing documents.',
  'finance-approve': 'Approved by finance — now waiting for the CEO.',
  approve: 'Approved — the cashier can pay it.',
  return: 'Returned for correction.',
  resubmit: 'Resubmitted.',
  reject: 'Voucher rejected.',
  cancel: 'Voucher cancelled.',
}
const NOTE_ACTS = { 'send-back': 'What is wrong with the documents? (the requester sees this and attaches what is missing)', return: 'Why is it returned? (the requester sees this and corrects it)', reject: 'Why is it rejected? (the requester sees this)', cancel: 'Why is it cancelled?' } as const
type NoteAct = keyof typeof NOTE_ACTS
const NOTE_BTN: Record<NoteAct, string> = { 'send-back': 'Send back to the requester', return: 'Return for correction', reject: 'Reject voucher', cancel: 'Cancel voucher' }
const APPROVED_ON = ['approved', 'disbursed', 'settled', 'posted', 'converted']

export function VoucherDetail({ id }: { id: string }) {
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: v, isLoading, error } = useVoucher(id)
  const { data: tenants = [] } = useMyTenants()
  const { data: cats } = useCategories()
  const categories = cats?.categories ?? []
  // A cash keeper reads every box; anyone else gets 403 there (silently).
  const { isSuccess: isKeeper } = usePettyBoxes()
  const [editing, setEditing] = useState(false)
  const [noteFor, setNoteFor] = useState<NoteAct | null>(null)
  const [note, setNote] = useState('')
  const [onBehalfReason, setOnBehalfReason] = useState('')
  const [exportErr, setExportErr] = useState<string | null>(null)

  function refresh() {
    void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })     // the inbox and its badge
    void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
  }

  const act = useMutation({
    mutationFn: ({ kind, body }: { kind: Act; body: Record<string, unknown> }) =>
      // Pinned to the voucher's company, so the "All companies" view never asks.
      api.post<CashVoucher>(`${CV_BASE}/${id}/${kind}`, body, v?.tenantId ? { tenantId: v.tenantId } : undefined),
    meta: { inlineErrors: true },
    onSuccess: (_r, { kind }) => { toast.success(ACT_DONE[kind]); setNoteFor(null); setNote(''); setOnBehalfReason(''); refresh() },
  })

  if (isLoading) return <p className="px-7 py-10 text-sm text-white/40">Loading…</p>
  if (error || !v) {
    return (
      <div className="px-7 py-10">
        <ErrorBanner message={error ? errorWords(error) : 'This voucher was not found.'} />
        <Link href="/finance/cash-vouchers" className="inline-block mt-4 text-sm font-bold text-primary-ink hover:underline">← All cash vouchers</Link>
      </div>
    )
  }

  const companyName = v.companyName ?? tenants.find((t) => t.id === v.tenantId)?.name ?? ''
  const categoryLabel = accountWords(v, categories)
  const expense = v.kind === 'expense'
  const holder = expense ? v.payeeName : (v.holderName ?? v.payeeName)
  const run = (kind: Act, body: Record<string, unknown> = {}) => { act.reset(); act.mutate({ kind, body }) }
  const stage = stageOf(v)
  const paid = v.status === 'disbursed' || v.status === 'settled' || v.status === 'converted' || v.status === 'posted'
  const newFlow = !!v.expenseOnVerify
  const approved = APPROVED_ON.includes(v.status)
  const waitingFinance = v.status === 'submitted' || v.status === 'draft'
  const waitingCeo = v.status === 'finance_approved' || v.status === 'hod_signed'
  const discount = v.discountCents ?? 0

  async function exportAs(ext: 'pdf' | 'xlsx') {
    setExportErr(null)
    try { await api.download(`${CV_BASE}/${v!.id}/export.${ext}`, `${v!.number}.${ext}`) } catch (e) { setExportErr(errorWords(e)) }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <PrintPortal v={v} companyName={companyName} categoryLabel={categoryLabel} />

      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance/cash-vouchers" className="text-xs text-white/40 hover:text-white/70">← Cash vouchers</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">{expense ? 'Payee voucher' : 'Cash request'}</p>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-black text-white/90 mono">{v.number}</h1>
              <StatusBadge stage={stage} />
              {v.overdue && <span className="s-badge-red">Documents overdue</span>}
            </div>
            <p className="text-sm text-white/55 mt-1">
              {expense ? 'Pay' : 'For'} <span className="font-bold text-white/80">{holder}</span> · {v.purpose}
            </p>
          </div>
          <div className="text-right">
            <p className="metric-label">{discount > 0 ? 'Total payable' : 'Amount'}</p>
            <p className="metric-value-xl text-white/90">PKR {formatPkr(v.amountCents)}</p>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-4">
        <Steps v={v} />

        {v.status === 'returned' && (
          <div className="rounded-2xl p-4 border" style={{ background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', borderColor: 'var(--erp-warning)' }}>
            <p className="text-sm font-black text-white/90">
              Returned for correction{v.returnedByName ? ` by ${v.returnedByName}` : ''}{v.returnedAt ? ` · ${fmtDateTime(v.returnedAt)}` : ''}
              {(v.returnCount ?? 0) > 1 ? ` (${v.returnCount} times)` : ''}
            </p>
            {v.returnNote && <p className="text-sm text-white/80 mt-1 whitespace-pre-wrap">{v.returnNote}</p>}
            <p className="text-xs text-white/55 mt-1">Edit the voucher to fix it, then resubmit.</p>
          </div>
        )}

        {v.sentBack && (
          <div className="rounded-2xl p-4 border" style={{ background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', borderColor: 'var(--erp-warning)' }}>
            <p className="text-sm font-black text-white/90">
              Finance sent it back{v.returnedByName ? ` (${v.returnedByName})` : ''}{v.returnedAt ? ` · ${fmtDateTime(v.returnedAt)}` : ''}
            </p>
            {v.sentBackNote && <p className="text-sm text-white/80 mt-1 whitespace-pre-wrap">{v.sentBackNote}</p>}
            <p className="text-xs text-white/55 mt-1">Attach the missing or corrected documents below — the voucher closes again once they are in.</p>
          </div>
        )}
        {v.closed && (
          <div className="rounded-2xl p-4 border" style={{ background: 'color-mix(in srgb, var(--erp-success) 10%, transparent)', borderColor: 'var(--erp-success)' }}>
            <p className="text-sm font-black text-success">
              Closed — books {v.booksState === 'booked' ? 'booked' : 'pending'}
            </p>
            <p className="text-xs text-white/60 mt-1">
              {v.bookedAtPay
                ? (v.status === 'posted'
                  ? 'The supporting documents are attached under this voucher and finance has checked them. The expense was booked in one entry when finance paid it.'
                  : 'The supporting documents are attached under this voucher — nothing more is needed from the requester. The expense was booked in one entry when finance paid it; finance checks the documents, which books nothing more. If something is missing it is sent back.')
                : v.booksState === 'booked'
                  ? 'The supporting documents are attached and finance has checked them; the expense is booked.'
                  : 'The supporting documents are attached — nothing more is needed from the requester. Finance checks them and books the expense; if something is missing it is sent back.'}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="rounded-2xl p-4 space-y-3" style={card}>
          <div className="flex flex-wrap items-center gap-2">
            {v.canFinanceApprove && <span className="text-xs font-bold text-white/60">Finance approval is below.</span>}
            {v.canApprove && (
              <button disabled={act.isPending} className={primaryBtn}
                onClick={async () => { if (await confirm({ title: `Approve ${v.number}?`, body: `PKR ${formatPkr(v.amountCents)} for ${holder}. The cashier may then pay it.`, confirmLabel: 'Approve' })) run('approve', { amountCents: v.amountCents }) }}>
                Approve (CEO)
              </button>
            )}
            {v.status === 'returned' && (v.canResubmit ?? v.canEdit) && (
              <button disabled={act.isPending} className={primaryBtn} onClick={() => run('resubmit')}>Resubmit</button>
            )}
            {v.canSendBack && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'send-back' ? null : 'send-back') }} disabled={act.isPending} className={secondaryBtn}>
                Send back for documents
              </button>
            )}
            {v.canReturn && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'return' ? null : 'return') }} disabled={act.isPending} className={secondaryBtn}>Return for correction</button>
            )}
            {v.canReject && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'reject' ? null : 'reject') }} disabled={act.isPending} className={dangerOutlineBtn}>Reject</button>
            )}
            {(v.canEdit || v.canEditCategory) && (
              <button onClick={() => setEditing(true)} className={secondaryBtn}>{v.canEdit ? 'Edit' : 'Change category'}</button>
            )}
            {(v.canExport ?? true) && (
              <>
                <button onClick={() => window.print()} className={secondaryBtn}>Print</button>
                <button onClick={() => void exportAs('pdf')} className={secondaryBtn}>Download PDF</button>
                <button onClick={() => void exportAs('xlsx')} className={secondaryBtn}>Download Excel</button>
              </>
            )}
            {v.canCancel && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'cancel' ? null : 'cancel') }} disabled={act.isPending}
                className={`${dangerOutlineBtn} sm:ml-auto`}>
                Cancel voucher
              </button>
            )}
          </div>

          {waitingFinance && !v.canFinanceApprove && <p className="text-xs text-white/50">Waiting for finance to approve it.</p>}
          {waitingCeo && !v.canApprove && <p className="text-xs text-white/50">Approved by finance{v.financeApprovedByName ? ` (${v.financeApprovedByName})` : ''} — waiting for the CEO. Do not pay until it is approved.</p>}
          {v.status === 'approved' && !v.canPay && <p className="text-xs text-white/50">Approved — the cashier who holds the cash box pays it.</p>}
          {!approved && <p className="text-xs text-white/40">Printed or downloaded before the CEO approves, the voucher is stamped NOT APPROVED — for reference only.</p>}

          {noteFor && (
            <div className="rounded-xl p-3" style={{ background: 'var(--elevated)' }}>
              <label className="text-[11px] font-bold text-white/60">{NOTE_ACTS[noteFor]}</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              <div className="mt-2 flex gap-2">
                <button disabled={act.isPending || note.trim().length < 3} onClick={() => run(noteFor, { note: note.trim() })}
                  className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50 bg-s-red text-bone">
                  {act.isPending ? 'Saving…' : NOTE_BTN[noteFor]}
                </button>
                <button onClick={() => { setNoteFor(null); setNote('') }} className="text-xs font-bold text-white/50 px-2">Keep it</button>
              </div>
            </div>
          )}

          {act.error && <ErrorBanner message={errorWords(act.error)} />}
          {exportErr && <ErrorBanner message={exportErr} />}
        </div>

        {v.canFinanceApprove && <FinanceApprovePanel v={v} onDone={refresh} />}
        {v.canConfirmReceived && (
          <div className="rounded-2xl p-5 space-y-2" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
            <p className="text-sm font-black text-white/90">Did you receive the cash?</p>
            <p className="text-xs text-white/55">Confirming puts your name in the Received by box. Finance can verify the documents after that.</p>
            <button disabled={act.isPending} className={primaryBtn}
              onClick={async () => { if (await confirm({ title: `Cash received for ${v.number}?`, body: `Confirm you received PKR ${formatPkr(v.amountCents)} in cash.`, confirmLabel: 'Cash received' })) run('confirm-received') }}>
              {act.isPending ? 'Saving…' : 'Cash received'}
            </button>
          </div>
        )}
        {v.status === 'disbursed' && newFlow && v.kind !== 'expense' && !v.cashReceivedAt && !v.canConfirmReceived && (
          <p className="rounded-2xl p-4 text-xs font-bold text-white/70" style={card}>
            Waiting for {v.receiverName ?? holder} to confirm cash received — finance verifies the documents after that.
          </p>
        )}
        {v.canConfirmReceivedOnBehalf && (
          <div className="rounded-2xl p-5 space-y-2" style={card}>
            <p className="text-sm font-black text-white/90">Record cash received for {v.receiverName ?? holder}</p>
            <p className="text-xs text-white/55">Use this only when the holder cannot confirm (for example they have left). Your name goes in the Received by box and the reason is kept in the history.</p>
            <textarea value={onBehalfReason} onChange={(e) => setOnBehalfReason(e.target.value)} rows={2} maxLength={500}
              placeholder="Why the holder cannot confirm (at least 10 characters)" className={fieldCls} />
            <button disabled={act.isPending || onBehalfReason.trim().length < 10} className={secondaryBtn}
              onClick={async () => {
                if (await confirm({ title: `Record cash received for ${v.number}?`, body: `This records that PKR ${formatPkr(v.amountCents)} reached the holder, on their behalf.`, confirmLabel: 'Record it' })) {
                  run('confirm-received-on-behalf', { reason: onBehalfReason.trim() })
                }
              }}>
              {act.isPending ? 'Saving…' : 'Record cash received on their behalf'}
            </button>
          </div>
        )}
        {v.canNameHolder && <NameHolder v={v} onDone={refresh} />}
        {v.canPay && <PayPanel v={v} onDone={refresh} />}

        {/* After payment */}
        {/* Supporting documents travel with the voucher: listed and downloadable for everyone who can open it. */}
        {(paid || (v.status === 'approved' && v.canUpload)) && (newFlow || (v.documents?.length ?? 0) > 0 || v.canUpload) && <DocumentsPanel v={v} isKeeper={isKeeper} />}
        {v.status === 'disbursed' && newFlow && v.canVerify && <VerifyPanel v={v} isKeeper={isKeeper} />}
        {v.status === 'disbursed' && newFlow && v.canResolveByJournal && <ResolveByJournalPanel v={v} />}
        {paid && !newFlow && <SettlePanel v={v} isKeeper={isKeeper} />}
        {v.status === 'posted' && (
          <div className="rounded-2xl p-4 border" style={{ background: 'color-mix(in srgb, var(--erp-success) 10%, transparent)', borderColor: 'var(--erp-success)' }}>
            <p className="text-sm font-black text-success">
              {v.bookedAtPay ? 'Documents checked' : 'Documents verified & expense booked'}{v.docsVerifiedByName ?? v.postedByName ? ` by ${v.docsVerifiedByName ?? v.postedByName}` : ''}
              {v.postedAt ?? v.docsVerifiedAt ? ` · ${fmtDateTime(v.postedAt ?? v.docsVerifiedAt)}` : ''}
            </p>
            {v.bookedAtPay && <p className="text-xs text-white/60 mt-1">The expense was booked in one entry when finance paid it; the check booked nothing more.</p>}
          </div>
        )}

        {v.status === 'rejected' && (
          <div className="rounded-2xl p-4 bg-s-red-dim border border-s-red/30">
            <p className="text-sm font-black text-s-red">Rejected{v.rejectedByName ? ` by ${v.rejectedByName}` : ''}{v.rejectedAt ? ` · ${fmtDateTime(v.rejectedAt)}` : ''}</p>
            {v.rejectNote && <p className="text-sm text-white/75 mt-1">{v.rejectNote}</p>}
          </div>
        )}
        {v.status === 'cancelled' && (
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/75">Cancelled{v.cancelledByName ? ` by ${v.cancelledByName}` : ''}{v.cancelledAt ? ` · ${fmtDateTime(v.cancelledAt)}` : ''}</p>
            {v.cancelNote && <p className="text-sm text-white/60 mt-1">{v.cancelNote}</p>}
          </div>
        )}

        {/* Facts */}
        <div className="rounded-2xl p-5" style={card}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <Fact label={expense ? 'Payee' : 'Who takes the cash'} value={holder} />
            <Fact label="Date" value={fmtDate(v.voucherDate)} />
            {expense || discount > 0 ? (
              <>
                <Fact label="Amount" value={`PKR ${formatPkr(v.grossCents ?? v.amountCents + discount, { decimals: true })}`} />
                <Fact label="Discount" value={`PKR ${formatPkr(discount, { decimals: true })}`} />
                <Fact label="Total payable" value={`PKR ${formatPkr(v.amountCents, { decimals: true })}`} />
              </>
            ) : (
              <Fact label="Amount" value={`PKR ${formatPkr(v.amountCents, { decimals: true })}`} />
            )}
            <Fact label="In words" value={v.amountInWords || amountInWords(v.amountCents)} wide />
            <Fact label="Particulars" value={v.purpose} wide />
            <Fact label={v.assetClassId ? 'Booked to' : 'Expense account'} value={categoryLabel} />
            {v.assetClassId && <Fact label="Outlet" value={v.assetLocationName ?? (v.conceptName ? `— (brand ${v.conceptName})` : '—')} />}
            {v.capitalisation && (
              <Fact label="Capitalisation" value={v.capitalisation.status === 'posted' ? 'Approved by the CEO — on the fixed-asset register'
                : v.capitalisation.status === 'rejected' ? `Rejected by the CEO — the cost stays on CapEx advances (1340)${v.capitalisation.decisionNote ? `: ${v.capitalisation.decisionNote}` : ''}`
                : 'Waiting for the CEO'} />
            )}
            {expense && v.payFrom && (
              <Fact label="To pay from" value={v.payFrom === 'credit' ? `Credit — ${v.supplierName ?? 'supplier'}` : v.payFrom === 'bank' ? `Bank${v.payFromBankName ? ` — ${v.payFromBankName}` : ''}` : 'Cash'} />
            )}
            {v.supplierBill && (
              <Fact label="Supplier bill" value={`${v.supplierBill.billNumber} · ${v.supplierBill.status} · due ${fmtDate(v.supplierBill.dueDate)} — pay it in Supplier bills & payments`} />
            )}
            <Fact label="Paid from" value={v.paidFrom ?? v.boxName ?? '—'} />
            <Fact label="Paid by" value={v.paidByName ?? '—'} />
            <Fact label="Received by" value={v.cashReceivedAt ? `${v.receiverName ?? holder} · confirmed ${fmtDateTime(v.cashReceivedAt)}` : `${v.receiverName ?? holder} · not confirmed yet`} />
            {v.dueBy && <Fact label="Documents due by" value={fmtDate(v.dueBy)} />}
            <Fact label="Raised by" value={`${v.preparedByName ?? '—'} · ${fmtDateTime(v.createdAt)}`} />
            {companyName && <Fact label="Company" value={companyName} />}
          </dl>
        </div>

        {v.signedPhotos.length > 0 && (
          <div className="rounded-2xl p-4 space-y-2" style={card}>
            <p className="text-sm font-black text-white/80">The signed paper (old voucher flow)</p>
            <Thumbs requestId={v.id} files={v.signedPhotos} />
          </div>
        )}

        {/* The paper */}
        <div className="rounded-2xl p-4" style={card}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-black text-white/80">The voucher as it prints</p>
            <p className="text-[11px] text-white/40">A4</p>
          </div>
          <div className="overflow-x-auto pb-1">
            <VoucherSheet v={v} companyName={companyName} categoryLabel={categoryLabel} />
          </div>
        </div>

        <History id={v.id} />
      </div>

      {editing && (
        <VoucherForm voucher={v} isKeeper={isKeeper} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); toast.success('Saved.'); refresh() }} />
      )}
    </div>
  )
}

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-[11px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="text-white/85 font-semibold break-words">{value}</dd>
    </div>
  )
}

/** Requested → Finance → CEO → Paid → Cash received → Documents → Verified & booked; done steps are green. */
function Steps({ v }: { v: CashVoucher }) {
  const paid = !!v.disbursedAt
  const docs = v.supportingCount ?? v.receiptCount ?? 0
  const legacy = !v.expenseOnVerify && paid
  const verifiedAt = v.postedAt ?? v.docsVerifiedAt ?? null
  type S = { title: string; who: string | null; when: string | null; state: 'done' | 'bad' | 'todo' }
  const financeAt = v.financeApprovedAt ?? v.hodSignedAt ?? null
  const financeBy = v.financeApprovedByName ?? v.hodSignedByName ?? null
  const rejectedBeforeCeo = v.status === 'rejected' && !v.directorSignedAt
  const steps: S[] = [
    { title: 'Requested', who: v.submittedByName ?? v.preparedByName ?? null, when: v.submittedAt ?? v.createdAt, state: 'done' },
    { title: 'Finance', who: financeBy, when: financeAt, state: financeAt ? 'done' : rejectedBeforeCeo && !financeAt ? 'bad' : v.status === 'returned' ? 'bad' : 'todo' },
    rejectedBeforeCeo && financeAt
      ? { title: 'CEO', who: v.rejectedByName ?? null, when: v.rejectedAt ?? null, state: 'bad' }
      : { title: 'CEO', who: v.directorSignedByName ?? null, when: v.directorSignedAt, state: v.directorSignedAt ? 'done' : 'todo' },
    { title: v.bookedAtPay ? 'Paid & booked' : 'Paid', who: v.paidByName ?? null, when: v.disbursedAt ?? null, state: paid ? 'done' : 'todo' },
    { title: 'Cash received', who: v.cashReceivedAt ? (v.cashReceivedByName ?? v.receiverName ?? null) : null, when: v.cashReceivedAt ?? null, state: v.cashReceivedAt ? 'done' : 'todo' },
    {
      title: v.closed ? 'Documents — closed' : 'Documents',
      who: v.sentBack ? 'Sent back by finance' : docs ? `${docs} file${docs === 1 ? '' : 's'}` : null,
      when: null,
      state: v.sentBack || v.overdue ? 'bad' : docs > 0 ? 'done' : 'todo',
    },
    {
      title: legacy ? (v.status === 'converted' ? 'Converted' : 'Settled') : v.bookedAtPay ? 'Documents checked' : 'Checked & booked',
      who: v.docsVerifiedByName ?? v.postedByName ?? null,
      when: verifiedAt ?? v.settledAt ?? null,
      state: v.status === 'posted' || v.status === 'settled' || v.status === 'converted' ? 'done' : 'todo',
    },
  ]
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-7 gap-2">
      {steps.map((s) => (
        <li key={s.title} className="rounded-xl p-3" style={card}>
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${s.state === 'done' ? 'bg-accent' : s.state === 'bad' ? 'bg-s-red' : 'border border-white/25'}`} />
            <span className={`text-xs font-black ${s.state === 'done' ? 'text-success' : s.state === 'bad' ? 'text-s-red' : 'text-white/45'}`}>{s.title}</span>
          </div>
          <p className="text-[11px] text-white/60 mt-1 truncate">{s.state === 'todo' ? 'Waiting' : (s.who ?? '—')}</p>
          {s.state !== 'todo' && s.when && <p className="text-[10px] text-white/40">{fmtDateTime(s.when)}</p>}
        </li>
      ))}
    </ol>
  )
}

/** Finance approves: may still fix the account and discount in the same call. */
function FinanceApprovePanel({ v, onDone }: { v: CashVoucher; onDone: () => void }) {
  const { data: cats } = useCategories()
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const [category, setCategory] = useState(v.category ?? '')
  const [discountCents, setDiscountCents] = useState(v.discountCents ?? 0)
  const gross = v.grossOrAmountCents ?? v.grossCents ?? v.amountCents + (v.discountCents ?? 0)
  const isCode = /^\d{4}$/.test(category)
  const changed = category !== (v.category ?? '') || discountCents !== (v.discountCents ?? 0)
  const asset = !!v.assetClassId
  const ok = (asset || !!category) && discountCents >= 0 && discountCents < gross
  const approve = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/finance-approve`, {
      ...(!asset && category !== (v.category ?? '') ? (isCode ? { accountCode: category } : { categoryKey: category }) : {}),
      ...(discountCents !== (v.discountCents ?? 0) && v.canEditDiscount !== false ? { discountCents } : {}),
    }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success('Approved by finance — now waiting for the CEO.'); onDone() },
  })
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Finance approval</p>
      <p className="text-xs text-white/55">Check the expense account and set a discount if there is one, then send it to the CEO.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="fa-category" className="text-xs text-white/55">{asset ? 'Booked to' : 'Expense account'}</label>
          <div className="mt-1">
            {asset ? (
              <p id="fa-category" className="text-sm text-white/80">{accountWords(v, categories)} — change it with Edit.</p>
            ) : <Select id="fa-category" value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
              {!categories.some((c) => c.key === category) && category && <option value={category}>{category}</option>}
              <option value="">— pick —</option>
              {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
            </Select>}
          </div>
        </div>
        <div>
          <label htmlFor="fa-discount" className="text-xs text-white/55">Discount (PKR)</label>
          <div className="mt-1"><MoneyInput id="fa-discount" value={discountCents} onChange={setDiscountCents} className={fieldCls} ariaLabel="Discount in rupees" /></div>
          <p className="text-[11px] text-white/45 mt-1">Total to pay PKR {formatPkr(Math.max(0, gross - discountCents))}</p>
        </div>
      </div>
      {approve.error && <ErrorBanner message={errorWords(approve.error)} />}
      <button disabled={!ok || approve.isPending} className={primaryBtn}
        onClick={() => { approve.reset(); approve.mutate() }}>
        {approve.isPending ? 'Approving…' : changed ? 'Save changes & approve' : 'Approve and send to the CEO'}
      </button>
    </div>
  )
}

const ACTION_WORDS: Record<string, string> = {
  create: 'Raised', submitted: 'Submitted to finance', update: 'Edited', finance_approve: 'Approved by finance', finance_approved: 'Approved by finance',
  approve: 'Approved by the CEO', approved: 'Approved by the CEO', return: 'Returned for correction', returned: 'Returned for correction',
  confirm_received: 'Cash received confirmed', resubmit: 'Resubmitted', reject: 'Rejected', rejected: 'Rejected', cancel: 'Cancelled', cancelled: 'Cancelled', pay: 'Cash paid',
  document_add: 'Document added', document_remove: 'Document removed', receipt_add: 'Receipt added', receipt_remove: 'Receipt removed',
  spend: 'Spend recorded', verify_docs: 'Documents verified & expense booked', export: 'Exported', settle: 'Receipts submitted',
  return_change: 'Change returned', send_back: 'Sent back by finance for documents', settlement_line_reclass: 'Line moved to another account', name_holder: 'Holder named',
}

function noteOf(r: HistoryRow): string | null {
  const a = (r.after ?? null) as Record<string, unknown> | null
  const n = a && typeof a === 'object' ? (a['note'] ?? a['returnNote'] ?? a['rejectNote'] ?? a['cancelNote']) : null
  return typeof n === 'string' && n ? n : null
}

/** The voucher's audit trail, oldest first. */
function History({ id }: { id: string }) {
  const { data, isLoading } = useHistory(id)
  const rows: HistoryRow[] = Array.isArray(data) ? data : (data?.items ?? [])
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/80 mb-2">History</p>
      {isLoading && <p className="text-xs text-white/40">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-xs text-white/40">Nothing recorded yet.</p>}
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.id ?? i} className="text-xs flex flex-wrap gap-x-3">
            <span className="text-white/40 tabular-nums shrink-0">{fmtDateTime(r.at)}</span>
            <span className="font-bold text-white/80">{r.userName ?? '—'}</span>
            <span className="text-white/65">{ACTION_WORDS[r.action] ?? r.action.replace(/_/g, ' ')}{noteOf(r) ? ` — ${noteOf(r)}` : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Approved: whoever pays picks where the cash comes from and confirms it was handed over. One grouped picker
 * (owner, 2026-10-16): petty-cash boxes (the custodian's own; finance and managers every open box of the
 * company), cash on hand (the safe) and the company's bank accounts — those two for finance and the CEO only.
 * The server's GET /:id/pay-sources decides what is listed; POST /:id/pay re-checks it.
 */
function PayPanel({ v, onDone }: { v: CashVoucher; onDone: () => void }) {
  const confirm = useConfirm()
  const { data: src, isLoading } = usePaySources(v)
  const boxes = src?.boxes ?? []
  const banks = src?.banks ?? []
  // A payee voucher may also be booked on credit (2026-10-19): a supplier bill, no cash handed over.
  const creditOk = v.kind === 'expense' && !!v.supplierId
  const options: string[] = [
    ...boxes.map((b) => `box:${b.id}`),
    ...(src?.cashOnHand ? ['cash'] : []),
    ...banks.map((b) => `bank:${b.id}`),
    ...(creditOk ? ['credit'] : []),
  ]
  // "To pay from" chosen at raise prefills the pick (finance may change it).
  const planned = v.payFrom === 'credit' && creditOk ? 'credit'
    : v.payFrom === 'bank' && v.payFromBankAccountId && banks.some((b) => b.id === v.payFromBankAccountId) ? `bank:${v.payFromBankAccountId}`
    : v.payFrom === 'bank' && banks.length === 1 ? `bank:${banks[0]!.id}`
    : v.payFrom === 'cash' && src?.cashOnHand ? 'cash' : ''
  const preferred = planned || (v.boxId && boxes.some((b) => b.id === v.boxId) ? `box:${v.boxId}` : options.length === 1 ? options[0]! : '')
  const [pick, setPick] = useState('')
  const chosen = pick || preferred
  const box = chosen.startsWith('box:') ? boxes.find((b) => `box:${b.id}` === chosen) ?? null : null
  const bank = chosen.startsWith('bank:') ? banks.find((b) => `bank:${b.id}` === chosen) ?? null : null
  const credit = chosen === 'credit'
  const fromWords = box ? box.name : bank ? bank.name : chosen === 'cash' ? 'cash on hand' : credit ? `credit from ${v.supplierName ?? 'the supplier'}` : ''
  const holder = v.holderName ?? v.payeeName
  // The pay books the expense, so the server's equipment check runs here: a purpose that looks like equipment is
  // refused (USE_CAPEX) until finance says it is not equipment, with a reason (flagged for the CEO).
  const [notEquipment, setNotEquipment] = useState(false)
  const [notEquipmentReason, setNotEquipmentReason] = useState('')
  const pay = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/pay`,
      {
        ...(box ? { source: 'box', boxId: box.id } : bank ? { source: 'bank', bankAccountId: bank.id } : credit ? { source: 'credit' } : { source: 'cash_on_hand' }),
        ...(notEquipment && { notEquipment: true, notEquipmentReason: notEquipmentReason.trim() }),
      },
      { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success(`${v.number} is paid and booked — now waiting for the supporting documents.`); onDone() },
  })
  const short = !!box && box.floatCents < v.amountCents
  const nothing = !isLoading && options.length === 0
  const looksLikeEquipment = notEquipment || (pay.error instanceof ApiError && pay.error.code === 'USE_CAPEX')
  const overrideIncomplete = notEquipment && notEquipmentReason.trim().length < 10
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Pay {holder}</p>
      <p className="text-xs text-white/55">
        Hand PKR {formatPkr(v.amountCents)} to {holder} and confirm here. Paying books the expense now, in one entry
        (the voucher&rsquo;s expense account against where the cash comes from). The supporting documents are attached
        under this voucher afterwards and book nothing; any change or overspend is corrected with a manual journal.
      </p>
      <Select value={chosen} onChange={(e) => setPick(e.target.value)} className={fieldCls} aria-label="Pay from" disabled={isLoading || nothing}>
        {options.length !== 1 && <option value="">{isLoading ? 'Loading…' : '— pay from —'}</option>}
        {boxes.length > 0 && (
          <optgroup label="Petty cash boxes">
            {boxes.map((b) => (
              <option key={b.id} value={`box:${b.id}`}>
                {b.name} · PKR {formatPkr(b.floatCents)}{!b.mine && b.custodianName ? ` · held by ${b.custodianName}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {src?.cashOnHand && (
          <optgroup label="Cash on hand">
            <option value="cash">Cash on hand (safe)</option>
          </optgroup>
        )}
        {creditOk && (
          <optgroup label="On credit">
            <option value="credit">Credit — {v.supplierName ?? 'supplier'} (supplier bill)</option>
          </optgroup>
        )}
        {banks.length > 0 && (
          <optgroup label="Bank accounts">
            {banks.map((b) => (
              <option key={b.id} value={`bank:${b.id}`}>{b.name}{b.bankName && !b.name.includes(b.bankName) ? ` · ${b.bankName}` : ''}{b.accountCode ? ` · ${b.accountCode}` : ''}</option>
            ))}
          </optgroup>
        )}
      </Select>
      {nothing && (
        <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>
          Nothing to pay this from: you hold no open cash box of this company. Finance or the CEO can pay it from a box, cash on hand or a bank account.
        </p>
      )}
      {short && <p className="text-xs text-s-red font-bold">{box!.name} holds PKR {formatPkr(box!.floatCents)} — less than this voucher. Top it up first, or pay from another source.</p>}
      {pay.error && <ErrorBanner message={errorWords(pay.error)} />}
      {looksLikeEquipment && (
        <div className="space-y-2">
          <p className="text-xs text-white/60">
            Equipment goes on the register through CapEx (Finance → Project tracker → Quick buy), not a cash voucher. If this
            is not equipment, say why — it is booked to the voucher&rsquo;s expense account and flagged for the CEO.
          </p>
          <label className="flex items-center gap-2 text-xs font-bold text-white/80">
            <input type="checkbox" checked={notEquipment} onChange={(e) => setNotEquipment(e.target.checked)} />
            This is not equipment
          </label>
          {notEquipment && (
            <textarea value={notEquipmentReason} onChange={(e) => setNotEquipmentReason(e.target.value)} rows={2} maxLength={500}
              className={fieldCls} placeholder="Why this is not equipment (at least 10 characters)" aria-label="Why this is not equipment" />
          )}
        </div>
      )}
      <button disabled={pay.isPending || !chosen || overrideIncomplete} className={primaryBtn}
        onClick={async () => {
          const what = v.assetClassId ? 'booked to CapEx advances (the CEO then approves the capitalisation)' : 'booked as expense now'
          const ok = await confirm(credit
            ? { title: `Book ${v.number} on credit?`, body: `PKR ${formatPkr(v.amountCents)} is owed to ${v.supplierName ?? 'the supplier'} — ${v.assetClassId ? 'the CapEx line and its capitalisation request are raised' : 'a supplier bill is raised'}; no cash is handed over.`, confirmLabel: 'Book on credit' }
            : { title: `Cash handed to ${holder}?`, body: `PKR ${formatPkr(v.amountCents)} for ${v.number} is paid from ${fromWords} and ${what}.`, confirmLabel: 'Cash handed over' })
          if (ok) { pay.reset(); pay.mutate() }
        }}>
        {pay.isPending ? 'Paying…' : credit ? 'Book on credit' : `Cash handed to ${holder}`}
      </button>
    </div>
  )
}

/** A legacy paid voucher with nobody named: finance names who holds the cash. */
function NameHolder({ v, onDone }: { v: CashVoucher; onDone: () => void }) {
  const { data: staff = [] } = useStaffNames()
  const [who, setWho] = useState('')
  const save = useMutation({
    mutationFn: () => api.patch(`${CV_BASE}/${v.id}`, { holderUserId: who }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success('Holder named.'); onDone() },
  })
  return (
    <div className="rounded-2xl p-5 space-y-3 bg-s-red-dim border border-s-red/30">
      <p className="text-sm font-black text-s-red">Needs review — nobody is named as holding this cash</p>
      <p className="text-xs text-white/65">Paid under the old voucher flow. Name the person who took the cash; they then bring the receipts.</p>
      <Select value={who} onChange={(e) => setWho(e.target.value)} className={fieldCls} aria-label="Who took the cash">
        <option value="">— who took the cash —</option>
        {staff.filter((u) => !u.tenantId || u.tenantId === v.tenantId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
      {save.error && <ErrorBanner message={errorWords(save.error)} />}
      <button disabled={!who || save.isPending} onClick={() => save.mutate()} className={primaryBtn}>Name the holder</button>
    </div>
  )
}
