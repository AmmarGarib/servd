'use client'
// Bad-debt write-offs on Receivables (G12 / H15) — the dialogs and helpers the
// receivables page uses. UI only: every figure, rule and permission is the
// server's (backend modules/receivables/writeOffs.ts).
//
//   WriteOffDialog          ask to write off (part of) what an invoice still
//                           owes: amount (default: the balance), a reason of
//                           10-500 characters and 1-5 evidence files (photos
//                           are compressed here, a PDF goes up as it is).
//                           POST /accounting/receivables/write-offs. The CEO
//                           approves every write-off; a request the CEO raises
//                           applies at once (the answer comes back 'approved').
//   WriteOffDecisionDialog  Approve / Reject / Cancel a request:
//                           POST .../write-offs/:id/approve | reject | cancel.
//                           Whether the caller may is the row's canApprove /
//                           canReject / canCancel flag — no role list here.
//   RecoveryDialog          money received later on an approved write-off:
//                           POST .../write-offs/:id/recover (amount, date and
//                           the shared PaymentReceivedFields: Cash / Card /
//                           Bank transfer / Bank deposit / Cheque, a payment
//                           reference # required for every method, the bank
//                           for a bank-type method). A reference used before
//                           is shown as a warning after it is saved.
//   EvidenceFiles           the evidence files of a write-off, opened with the
//                           session (the API serves them only to a login that
//                           may see them).
//   receivablesErrorMessage every code the receivables routes answer, in words.
//
// Approving books Dr 6160 Bad Debts / Cr 1110 Customer Receivables, tax
// included, in the invoice's company, dated the day it is approved. A recovery
// books Dr 1110 / Cr 6160 and the money into the bank or cash it went to.
//
// Money is typed in RUPEES and sent as paisa. Colours come from the ERP
// tokens only. Works at phone width.

import { Button, Field, Input, LinkButton, Textarea } from '@/components/finance/ui'
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkrWhole, todayPktIso } from '../../lib/money'
import { fetchEvidenceUrl, kb, prepareReceiptFile } from '../../lib/photoPrep'
import {
  DialogForm, PAYMENT_REFERENCE_ERROR_TEXT, PaymentReceivedFields, ReferenceUsedBeforeNotice, RupeeField as RupeeFieldBase, isBankMethod, receiptFieldsValid,
  type PaymentRefUse,
} from './PaymentReceivedFields'
import { checkReceiptFile } from './ReceiptUploader'
import { Modal as SharedModal } from '../ui/Modal'
import { FIcon } from './ui/icons'

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type WriteOffStatus = 'requested' | 'approved' | 'rejected' | 'cancelled'

/** One write-off as GET /accounting/receivables/write-offs returns it (file bytes never included). */
export interface WriteOffRow {
  id: string
  tenantId: string
  invoiceId: string
  status: WriteOffStatus
  amountCents: number
  recoveredCents: number
  /** What a recovery may still bring in (0 unless approved). */
  recoverableCents: number
  reason: string
  requestedAt: string
  decidedAt: string | null
  decisionNote: string | null
  invoiceNumber: string | null
  customerName: string | null
  conceptName: string | null
  requestedByName: string | null
  decidedByName: string | null
  invoice: { id: string; number: string; balanceCents: number; totalCents: number; writtenOffCents: number } | null
  attachments: Array<{ id: string; fileName: string; mime: string; sizeBytes: number }>
  /** What the CALLER may do with it — server flags, never a local role list. */
  canApprove: boolean
  canReject: boolean
  canCancel: boolean
  canRecover: boolean
}

/** The invoice a write-off is asked on. */
export interface WriteOffInvoice {
  id: string
  tenantId: string
  number: string
  customerName: string
  totalCents: number
  balanceCents: number
  /** 'statement' = an on-account client's statement (server field). */
  kind?: string
  /** Set when the invoice is raised against an on-account client: ANY approved
   *  write-off on it suspends that client (not only a statement's). */
  customerAccountId?: string | null
}

export const WRITE_OFF_STATUS: Record<WriteOffStatus, { label: string; color: string }> = {
  requested: { label: 'Waiting for the CEO', color: 'var(--erp-warning)' },
  approved:  { label: 'Approved — written off', color: 'var(--erp-danger)' },
  rejected:  { label: 'Rejected', color: 'rgb(var(--fg-rgb) / 0.5)' },
  cancelled: { label: 'Cancelled', color: 'rgb(var(--fg-rgb) / 0.5)' },
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * Every refusal the receivables routes can answer, in plain words. Codes with
 * a figure read it from `error.details`; anything else falls back to the
 * server's own sentence (which is already plain English).
 */
export function receivablesErrorMessage(e: unknown, fallback = 'Something went wrong — try again'): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : fallback
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>
  const money = (k: string): string => fmtPkrWhole(typeof d[k] === 'number' ? (d[k] as number) : 0)
  switch (e.code) {
    case 'WRITE_OFF_OPEN':
      return 'A write-off of this invoice is already waiting for the CEO. Decide it, or cancel it, before asking for another.'
    case 'WRITE_OFF_EXCEEDS_BALANCE':
      return typeof d['balanceCents'] === 'number' && (d['balanceCents'] as number) > 0
        ? `That is more than the invoice still owes (${money('balanceCents')}). Lower the amount.`
        : 'Nothing is owed on this invoice any more, so there is nothing to write off.'
    case 'EVIDENCE_REQUIRED':
      return 'Attach the evidence that the debt cannot be collected (a letter, a collection or court note, the client’s closure). At least one file.'
    case 'BAD_FILE':
      return `An evidence file was refused: ${e.message}`
    case 'OVER_RECOVERY':
      return `That is more than is left to recover on this write-off (${money('leftCents')}).`
    case 'NO_OUTPUT_TAX':
      return 'This invoice charged no sales tax, so the client cannot have withheld any. Record income tax withheld instead.'
    case 'OVER_SALES_TAX_WITHHOLDING':
      return `That is more than the sales tax left on this invoice (${money('leftCents')}). Sales tax already withheld, and tax taken back by credit notes, are not available again.`
    case 'OVER_WITHHOLDING':
      return 'That is more than is still due on this invoice.'
    case 'PERIOD_LOCKED':
      return `The books are closed for that date, so nothing was saved. ${e.message}`
    case 'WRITE_OFF_NOT_PENDING':
      return 'Someone has already decided this write-off (or it was cancelled). Reload to see where it stands.'
    case 'WRITE_OFF_NOT_APPROVED':
      return 'Only an approved write-off can have a recovery recorded against it.'
    case 'INVOICE_VOID':
      return 'This invoice has been voided, so nothing can be recorded on it.'
    case 'NOT_AN_INVOICE':
      return 'This is a credit note. Record this against the invoice it credits.'
    case 'BAD_DATE':
      return e.message
    case 'BANK_ACCOUNT_REQUIRED':
      return 'This company has more than one bank account. Pick the one the money went into.'
    case 'BANK_ACCOUNT_NOT_IN_COMPANY':
      return 'That bank account belongs to another company. Pick one of this invoice’s company.'
    case 'BANK_ACCOUNT_ON_CASH':
      return 'A cash payment does not go into a bank account. Pick Bank deposit if the cash was paid into the bank.'
    case 'PAYMENT_REFERENCE_REQUIRED':
    case 'PAYMENT_REFERENCE_TOO_LONG':
      return PAYMENT_REFERENCE_ERROR_TEXT[e.code]!
    case 'ACCOUNT_CODE_TAKEN':
    case 'ACCOUNT_INACTIVE':
    case 'ACCOUNT_NOT_FOUND':
      return `${e.message} Nothing was saved.`
    case 'RECOVERY_MISMATCH':
      return 'This recovery no longer matches its write-off. Ask the accountant to check the write-off before reversing it.'
    case 'WITHHELD_ALREADY_SET_OFF':
      return `The sales tax withheld here was already set off in a sales-tax payment (${money('unusedCents')} is not yet used). Void or correct that sales-tax payment first.`
    case 'WRITTEN_OFF_FIRST':
      return `Part of this invoice was written off as a bad debt, so a credit note can only credit what was not written off (${money('leftCents')} left). Recover or reverse the write-off first.`
    case 'SELF_APPROVAL_BLOCKED':
      return 'You cannot approve a write-off you asked for. Have the CEO or a colleague decide it.'
    case 'VALIDATION_ERROR':
      return 'Something in the form is not valid — check the amount, the dates, the method and the reason (10 to 500 characters).'
  }
  if (e.status === 403) return 'You do not have permission to do this. Finance, management and the owner ask for write-offs; only the CEO approves them.'
  if (e.status === 413) return 'The files are too large to send together. Use fewer or smaller files.'
  return e.message || fallback
}

// ─── Small shared pieces ─────────────────────────────────────────────────────

const inp = 's-input w-full'
/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const rupees = (paisa: number) => String(paisa / 100)
/** The PKT calendar day of a timestamp (the server dates in PKT). */
const pktDay = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10)


/** Thin wrapper over the shared Modal (Escape, focus trap, scroll lock, "Discard changes?" when `dirty`). */
function Modal({ title, children, onClose, dirty }: { title: string; children: React.ReactNode; onClose: () => void; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} dirty={dirty}>{children}</SharedModal>
}

const RupeeField = (p: Omit<React.ComponentProps<typeof RupeeFieldBase>, 'className'>) => <RupeeFieldBase {...p} className={inp} />

function Actions({ busy, label, busyLabel, onClose, danger }: {
  busy: boolean; label: string; busyLabel: string; onClose: () => void; danger?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-2 mt-5">
      <button
        type="submit"
        disabled={busy}
        className={`rounded-lg px-4 py-2 text-sm font-black disabled:opacity-50 ${danger ? 'bg-s-red text-bone' : 'bg-primary text-primary-on'}`}
      >
        {busy ? busyLabel : label}
      </button>
      <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Close</button>
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return <p role="alert" className="text-xs mt-3" style={{ color: 'var(--erp-danger)' }}>{text}</p>
}

// ─── Evidence picker (1-5 files) ─────────────────────────────────────────────

const MAX_FILES = 5

interface PickedFile {
  key: number
  fileName: string
  mime: 'image/jpeg' | 'application/pdf'
  base64: string
  bytes: number
  previewUrl: string
}

/** A photo is re-encoded as JPEG, so its name says so; a PDF keeps its own. */
function nameFor(original: string, mime: PickedFile['mime']): string {
  const base = original.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || 'evidence'
  return `${base.slice(0, 190)}.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`
}

function EvidencePicker({ files, onChange }: { files: PickedFile[]; onChange: (next: PickedFile[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Revoke the local previews when the dialog goes away.
  const live = useRef<PickedFile[]>([])
  live.current = files
  useEffect(() => () => { for (const f of live.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) }, [])

  async function add(list: FileList | null) {
    if (!list || list.length === 0) return
    setError(null)
    // Type and size are checked on select (the server takes photos and PDFs up to 3 MB).
    const picked = Array.from(list)
    const refused = picked.map(checkReceiptFile).filter((m): m is string => !!m)
    const okFiles = picked.filter((f) => !checkReceiptFile(f))
    if (refused.length > 0) setError(refused.join(' '))
    if (okFiles.length === 0) { if (input.current) input.current.value = ''; return }
    setBusy(true)
    let next = [...files]
    try {
      for (const file of okFiles) {
        if (next.length >= MAX_FILES) { setError(`At most ${MAX_FILES} files.`); break }
        setWorking(`Preparing ${file.name || 'photo'}…`)
        const p = await prepareReceiptFile(file)
        next = [...next, {
          key: ++counter.current, fileName: nameFor(file.name, p.mime), mime: p.mime, base64: p.base64, bytes: p.bytes, previewUrl: p.previewUrl,
        }]
        onChange(next)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be added.')
    } finally {
      setBusy(false)
      setWorking(null)
      if (input.current) input.current.value = ''
    }
  }

  function remove(f: PickedFile) {
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
    onChange(files.filter((x) => x.key !== f.key))
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-white/50">Evidence the debt cannot be collected *</span>
        <span className="text-xs text-s-muted">{files.length} of {MAX_FILES}</span>
      </div>
      <p className="text-xs text-s-muted mt-0.5">A letter, a collection or court note, proof the client has closed. Photos or PDFs, up to 3 MB each.</p>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.map((f) => (
            <li key={f.key} className="flex items-center gap-3 rounded-lg px-2 py-1.5" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
              {f.previewUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={f.previewUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-xs font-bold text-white/55" style={{ background: 'rgb(var(--fg-rgb) / 0.06)' }}>PDF</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-white/85">{f.fileName}</span>
                <span className="block text-xs text-s-muted">{kb(f.bytes)}</span>
              </span>
              <button type="button" onClick={() => remove(f)} aria-label={`Remove ${f.fileName}`}
                className="h-8 w-8 shrink-0 rounded-full text-sm" style={{ color: 'var(--erp-danger)' }}><FIcon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_FILES && (
        <button type="button" onClick={() => input.current?.click()} disabled={busy}
          className="mt-2 rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-50"
          style={{ border: '1px dashed rgb(var(--erp-primary-rgb) / 0.5)', color: 'var(--erp-primary)' }}>
          {busy ? 'Preparing…' : '+ Add a photo or PDF'}
        </button>
      )}
      <input ref={input} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => void add(e.target.files)} />
      {working && <p role="status" className="text-xs mt-2 text-white/70">{working}</p>}
      {error && <ErrorLine text={error} />}
    </div>
  )
}

// ─── Ask for a write-off ─────────────────────────────────────────────────────

export function WriteOffDialog({ invoice, onClose, onDone, prefill }: {
  invoice: WriteOffInvoice
  /** Recovered from the Trash: the amount (capped at the balance) and the reason. Evidence is attached again. */
  prefill?: { amountCents?: number; reason?: string } | null
  onClose: () => void
  /** Called with the saved write-off ('approved' when the CEO asked: applied at once). */
  onDone: (w: Pick<WriteOffRow, 'id' | 'status' | 'amountCents'>) => void
}) {
  const [amount, setAmount] = useState(rupees(
    prefill?.amountCents != null && prefill.amountCents > 0 ? Math.min(prefill.amountCents, invoice.balanceCents) : invoice.balanceCents,
  ))
  const [reason, setReason] = useState(prefill?.reason ?? '')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [err, setErr] = useState('')

  const cents = toPaisa(amount)
  const reasonLen = reason.trim().length
  const problem =
    cents <= 0 ? 'Enter the amount to write off.'
    : cents > invoice.balanceCents ? `That is more than the invoice still owes (${fmtPkrWhole(invoice.balanceCents)}).`
    : reasonLen < 10 ? 'Give the reason in at least 10 characters.'
    : reasonLen > 500 ? 'Keep the reason to 500 characters.'
    : files.length === 0 ? 'Attach at least one evidence file.'
    : null

  const go = useMutation({
    mutationFn: () => api.post<WriteOffRow>('/accounting/receivables/write-offs', {
      invoiceId: invoice.id,
      amountCents: cents,
      reason: reason.trim(),
      evidence: files.map((f) => ({ fileName: f.fileName, mime: f.mime, data: f.base64 })),
    }),
    onSuccess: (w) => onDone({ id: w.id, status: w.status, amountCents: w.amountCents }),
    onError: (e: Error) => setErr(receivablesErrorMessage(e)),
  })

  return (
    <Modal title={`Write off ${invoice.number}`} onClose={onClose} dirty={!go.isPending && (amount !== rupees(invoice.balanceCents) || !!reason.trim() || files.length > 0)}>
      <DialogForm busy={go.isPending} onSubmit={() => { setErr(''); go.mutate() }} missing={problem}>
      <p className="text-sm text-white/60">
        {invoice.customerName} still owes <strong className="text-white/90">{fmtPkrWhole(invoice.balanceCents)}</strong> of {fmtPkrWhole(invoice.totalCents)}.
        <strong className="text-white/90"> The CEO approves every write-off.</strong> Once approved, the amount (sales tax included) comes off what we are owed
        and is booked as a bad debt. The sales tax already declared on the invoice is not refunded.
      </p>
      {(invoice.customerAccountId || invoice.kind === 'statement') && (
        <p className="text-sm text-white/60 mt-2">
          {invoice.customerAccountId && <>This invoice is on an on-account client: once approved, <strong className="text-white/90">the client is suspended</strong>.</>}
          {invoice.kind === 'statement' && <>{invoice.customerAccountId ? ' ' : ''}It is a client statement, so the bad-debt expense is
          split by brand, in proportion to each brand&apos;s share of the bills on the statement.</>}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 mt-4">
        <Field label="Amount to write off (PKR)">
          <div className="flex gap-1">
            <div className="flex-1 min-w-0"><RupeeField label="Amount to write off (PKR)" value={amount} onChange={setAmount} invalid={cents <= 0 || cents > invoice.balanceCents} /></div>
            <button type="button" onClick={() => setAmount(rupees(invoice.balanceCents))}
              className="rounded-lg px-2 text-xs font-bold border border-white/10 text-white/60 whitespace-nowrap">All of it</button>
          </div>
        </Field>
        <Field label="Reason *">
          <Textarea className={`${inp} min-h-[84px]`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonLen < 10 ? true : undefined}
            placeholder="Client closed in March; two reminders and a legal notice went unanswered…" />
          <span className="block text-right text-xs text-s-muted">{reasonLen} / 500</span>
        </Field>
        <EvidencePicker files={files} onChange={setFiles} />
      </div>
      {err && <ErrorLine text={err} />}
      <Actions busy={go.isPending} label="Ask the CEO to approve" busyLabel="Sending…" onClose={onClose} />
      </DialogForm>
    </Modal>
  )
}

// ─── Approve / reject / cancel ───────────────────────────────────────────────

export type DecisionMode = 'approve' | 'reject' | 'cancel'

export function WriteOffDecisionDialog({ writeOff, mode, onClose, onDone }: {
  writeOff: WriteOffRow
  mode: DecisionMode
  onClose: () => void
  onDone: (mode: DecisionMode, w: WriteOffRow) => void
}) {
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const noteRequired = mode === 'reject'
  const go = useMutation({
    mutationFn: () => api.post<WriteOffRow>(`/accounting/receivables/write-offs/${writeOff.id}/${mode}`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: (w) => onDone(mode, w),
    onError: (e: Error) => setErr(receivablesErrorMessage(e)),
  })
  const what = `${fmtPkrWhole(writeOff.amountCents)} on ${writeOff.invoiceNumber ?? 'the invoice'}${writeOff.customerName ? ` — ${writeOff.customerName}` : ''}`
  const title = mode === 'approve' ? 'Approve write-off' : mode === 'reject' ? 'Reject write-off' : 'Cancel write-off request'
  return (
    <Modal title={title} onClose={onClose} dirty={!go.isPending && !!note.trim()}>
      <DialogForm busy={go.isPending} onSubmit={() => { setErr(''); go.mutate() }} missing={noteRequired && note.trim().length < 3 ? 'Add a note (3 to 500 characters).' : null}>
      <p className="text-sm text-white/60">
        {mode === 'approve' && <>Write off <strong className="text-white/90">{what}</strong> as a bad debt? It comes off what we are owed today (Dr 6160 Bad Debts / Cr 1110 Receivables, sales tax included) and cannot be undone — only a later recovery can bring money back.</>}
        {mode === 'reject' && <>Turn down the request to write off <strong className="text-white/90">{what}</strong>. The invoice stays owed and the requester sees your note.</>}
        {mode === 'cancel' && <>Withdraw the request to write off <strong className="text-white/90">{what}</strong>. The invoice stays owed.</>}
      </p>
      <p className="text-xs text-s-muted mt-2">Asked by {writeOff.requestedByName ?? 'staff'}: “{writeOff.reason}”</p>
      <div className="mt-4">
        <Field label={noteRequired ? 'Note * (3 to 500 characters)' : 'Note (optional)'}>
          <Input className={inp} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
            aria-invalid={noteRequired && note.trim().length < 3 ? true : undefined}
            placeholder={mode === 'reject' ? 'Why this cannot be written off yet' : ''} />
        </Field>
      </div>
      {err && <ErrorLine text={err} />}
      <Actions
        busy={go.isPending}
        label={mode === 'approve' ? 'Approve and write off' : mode === 'reject' ? 'Reject' : 'Cancel the request'}
        busyLabel="Saving…"
        onClose={onClose}
        danger={mode !== 'approve'}
      />
      </DialogForm>
    </Modal>
  )
}

// ─── Record a recovery ───────────────────────────────────────────────────────

export function RecoveryDialog({ writeOff, onClose, onDone }: {
  writeOff: WriteOffRow
  onClose: () => void
  onDone: (w: WriteOffRow, amountCents: number) => void
}) {
  const [amount, setAmount] = useState(rupees(writeOff.recoverableCents))
  const [date, setDate] = useState(todayPktIso())
  const [method, setMethod] = useState('bank_transfer')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState('')
  // Saved, but its reference was used before: shown before the dialog closes.
  const [saved, setSaved] = useState<{ writeOff: WriteOffRow; uses: PaymentRefUse[] } | null>(null)
  const earliest = writeOff.decidedAt ? pktDay(writeOff.decidedAt) : undefined
  const cents = toPaisa(amount)
  const problem =
    cents <= 0 ? 'Enter the amount received.'
    : cents > writeOff.recoverableCents ? `Only ${fmtPkrWhole(writeOff.recoverableCents)} is left to recover on this write-off.`
    : earliest && date < earliest ? 'A recovery cannot be dated before the write-off was approved.'
    : !receiptFieldsValid({ method, reference }) ? 'Enter the payment reference # (the receipt, slip, transfer or cheque number).'
    : null

  const go = useMutation({
    mutationFn: () => api.post<{ writeOff: WriteOffRow; referenceUsedBefore?: PaymentRefUse[] }>(`/accounting/receivables/write-offs/${writeOff.id}/recover`, {
      amountCents: cents,
      receivedAt: date,
      method,
      bankAccountId: isBankMethod(method) && bankAccountId ? bankAccountId : undefined,
      reference: reference.trim(),
    }),
    onSuccess: (r) => {
      if (r.referenceUsedBefore?.length) setSaved({ writeOff: r.writeOff, uses: r.referenceUsedBefore })
      else onDone(r.writeOff, cents)
    },
    onError: (e: Error) => setErr(receivablesErrorMessage(e)),
  })

  if (saved) {
    return (
      <Modal title="Recovery recorded" onClose={() => onDone(saved.writeOff, cents)}>
        <p className="text-sm text-white/70 mb-3">{fmtPkrWhole(cents)} recovered on {writeOff.invoiceNumber ?? 'the invoice'}. It is booked back against bad debts.</p>
        <ReferenceUsedBeforeNotice uses={saved.uses} />
        <div className="flex flex-wrap gap-2 mt-5">
          <Button type="button" onClick={() => onDone(saved.writeOff, cents)}>Done</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Money recovered on ${writeOff.invoiceNumber ?? 'a written-off invoice'}`} onClose={onClose} dirty={!go.isPending && (amount !== rupees(writeOff.recoverableCents) || !!reference.trim())}>
      <DialogForm busy={go.isPending} onSubmit={() => { setErr(''); go.mutate() }} missing={problem}>
      <p className="text-sm text-white/60">
        {writeOff.customerName ?? 'The client'} paid something we had written off. It goes into the bank or cash it arrived in and is booked back against bad debts.
        Written off <strong className="text-white/90">{fmtPkrWhole(writeOff.amountCents)}</strong>, recovered so far{' '}
        <strong className="text-white/90">{fmtPkrWhole(writeOff.recoveredCents)}</strong>, left to recover{' '}
        <strong className="text-white/90">{fmtPkrWhole(writeOff.recoverableCents)}</strong>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <Field label="Amount received (PKR)"><RupeeField label="Amount received (PKR)" value={amount} onChange={setAmount} invalid={cents <= 0 || cents > writeOff.recoverableCents} /></Field>
        <Field label="Received on"><Input type="date" className={inp} value={date} min={earliest ?? '2000-01-01'} max={todayPktIso()} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="sm:col-span-2">
          <PaymentReceivedFields
            tenantId={writeOff.tenantId}
            method={method} onMethod={setMethod}
            reference={reference} onReference={setReference}
            bankAccountId={bankAccountId} onBank={setBankAccountId}
            idPrefix="wo-recover"
            selectClassName={inp} inputClassName={inp}
            labelClassName="block text-xs font-bold text-white/50"
          />
        </div>
      </div>
      {err && <ErrorLine text={err} />}
      <Actions busy={go.isPending} label="Record recovery" busyLabel="Saving…" onClose={onClose} />
      </DialogForm>
    </Modal>
  )
}

// ─── Evidence files of a write-off ───────────────────────────────────────────

/** The write-off's evidence, each file opened in a new tab with the session attached. */
export function EvidenceFiles({ writeOff }: { writeOff: Pick<WriteOffRow, 'id' | 'attachments'> }) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  if (writeOff.attachments.length === 0) return null
  async function open(fileId: string) {
    setErr('')
    setBusy(fileId)
    try {
      const url = await fetchEvidenceUrl(`/accounting/receivables/write-offs/${writeOff.id}/evidence/${fileId}`)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 120_000)
    } catch (e) {
      setErr(receivablesErrorMessage(e, 'The file could not be opened.'))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-xs text-s-muted">Evidence:</span>
      {writeOff.attachments.map((a) => (
        <LinkButton key={a.id} type="button" onClick={() => void open(a.id)} disabled={busy === a.id}>
          {a.fileName} ({kb(a.sizeBytes)})
        </LinkButton>
      ))}
      {err && <span className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</span>}
    </div>
  )
}
