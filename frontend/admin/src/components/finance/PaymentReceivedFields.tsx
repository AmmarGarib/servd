'use client'

// Money received outside the till (owner, 2026-10-14): every back-office
// screen that records money coming IN — gift-card sales, wallet top-ups,
// invoice payments and write-off recoveries, asset-sale proceeds, CapEx
// deposit returns, inter-company settlements — uses THIS block: how it was
// paid, the payment reference # (required for EVERY method, cash included)
// and, for a bank-type method, which of the company's banks it landed in.
//
// The list and the rules copy backend/src/lib/bankAccounts.ts
// (RECEIPT_METHODS, RECEIPT_METHOD_LABEL, isBankMethod,
// assertPaymentReference) — keep the two in step. The server decides; this
// only asks for what it will check. A reference used before is a warning,
// never a block: show `referenceUsedBefore` from the API response with
// <ReferenceUsedBeforeNotice>. The till keeps its own tenders.

import { FieldLabel, Input } from '@/components/finance/ui'
import { useRef, useState } from 'react'
import { BankAccountSelect, FIELD_LABEL_CLASS } from './BankAccountSelect'
import { MoneyInput } from '../ui/MoneyInput'
import { fmtPkrWhole } from '../../lib/money'
import { useSubmitOnce } from '../../app/finance/cash-vouchers/ui'
import { Select } from '@/components/ui/Select'

// No card (owner, 2026-10-16): back-office receipts take bank transfer, bank
// deposit, cash or cheque only — card is the till's. Old 'card' rows still
// read (RECEIPT_METHOD_LABEL).
export const RECEIPT_METHODS = ['cash', 'bank_transfer', 'bank_deposit', 'cheque'] as const
export type ReceiptMethod = typeof RECEIPT_METHODS[number]

export const RECEIPT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  bank_deposit: 'Bank deposit',
  cheque: 'Cheque',
  bank: 'Bank transfer',
  online: 'Online payment',
  wallet: 'Mobile wallet',
}

const BANK_METHODS = new Set(['bank', 'bank_transfer', 'bank_deposit', 'cheque', 'wallet', 'online'])

export function receiptMethodLabel(method: string | null | undefined): string {
  const m = (method ?? '').trim()
  return RECEIPT_METHOD_LABEL[m] ?? m
}

/** True when the money lands in a bank account (the form shows "Received into"). */
export function isBankMethod(method: string | null | undefined): boolean {
  return BANK_METHODS.has((method ?? '').trim())
}

/** Every method needs a reference (owner, 2026-10-14). */
export function referenceRequired(_method: string | null | undefined): boolean {
  return true
}

const REF_PLACEHOLDER: Record<string, string> = {
  cash: 'Cash receipt / voucher no.',
  bank_transfer: 'Transfer / IBFT reference',
  bank_deposit: 'Deposit slip no.',
  cheque: 'Cheque no.',
}

/** Client-side check before sending (the server checks again). */
export function receiptFieldsValid(v: { method: string; reference: string }): boolean {
  return !!v.method && (!referenceRequired(v.method) || v.reference.trim().length > 0) && v.reference.trim().length <= 100
}

/** The words the API uses for a missing reference, for a page's error map. */
export const PAYMENT_REFERENCE_ERROR_TEXT: Record<string, string> = {
  PAYMENT_REFERENCE_REQUIRED: 'Enter the payment reference # — the receipt, slip, transfer or cheque number.',
  PAYMENT_REFERENCE_TOO_LONG: 'The payment reference # is at most 100 characters.',
  CARD_NOT_A_RECEIPT: 'Card is taken at the till only — record this as a bank transfer, bank deposit, cash or cheque.',
}

export function PaymentReceivedFields({
  tenantId,
  method,
  onMethod,
  reference,
  onReference,
  bankAccountId,
  onBank,
  methods = RECEIPT_METHODS,
  methodLabel = 'Paid by',
  bankLabel = 'Received into',
  idPrefix = 'pay',
  selectClassName = 's-select',
  inputClassName = 's-input',
  labelClassName = FIELD_LABEL_CLASS,
  hint,
}: {
  /** The company the money belongs to (the document's company). */
  tenantId: string | null | undefined
  method: string
  onMethod: (method: string) => void
  reference: string
  onReference: (reference: string) => void
  bankAccountId: string
  onBank: (bankAccountId: string) => void
  /** Limit the methods offered (default: all of RECEIPT_METHODS). */
  methods?: readonly string[]
  methodLabel?: string
  bankLabel?: string
  idPrefix?: string
  selectClassName?: string
  inputClassName?: string
  labelClassName?: string
  /** Optional line under the method (e.g. "back-office cash only"). */
  hint?: React.ReactNode
}) {
  const required = referenceRequired(method)
  return (
    <div className="space-y-2">
      <div>
        <FieldLabel htmlFor={`${idPrefix}-method`} className={labelClassName}>{methodLabel}</FieldLabel>
        <Select
          id={`${idPrefix}-method`}
          value={method}
          onChange={(e) => {
            const next = e.target.value
            onMethod(next)
            if (!isBankMethod(next)) onBank('')
          }}
          className={selectClassName}
        >
          {methods.map((m) => (
            <option key={m} value={m}>{receiptMethodLabel(m)}</option>
          ))}
        </Select>
      </div>
      {hint}
      <div>
        <FieldLabel htmlFor={`${idPrefix}-ref`} className={labelClassName}>Cheque / bank reference #{required ? ' *' : ''}</FieldLabel>
        <Input
          id={`${idPrefix}-ref`}
          value={reference}
          onChange={(e) => onReference(e.target.value)}
          maxLength={100}
          required={required}
          placeholder={REF_PLACEHOLDER[method] ?? 'Reference no.'}
          className={inputClassName}
          autoComplete="off"
        />
      </div>
      {isBankMethod(method) && (
        <BankAccountSelect id={`${idPrefix}-bank`} tenantId={tenantId} value={bankAccountId} onChange={onBank} label={bankLabel} className={selectClassName} labelClassName={labelClassName} />
      )}
    </div>
  )
}

export interface PaymentRefUse { kind: string; id: string; label: string; at: string }

/** "This reference was also used on …" — a warning only; the payment was saved. */
export function ReferenceUsedBeforeNotice({ uses }: { uses: PaymentRefUse[] | null | undefined }) {
  if (!uses || uses.length === 0) return null
  return (
    <div role="status" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--erp-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)' }}>
      <p className="font-semibold">Saved. This payment reference # was used before:</p>
      <ul className="mt-1 list-disc pl-4">
        {uses.map((u) => <li key={`${u.kind}:${u.id}`}>{u.label}</li>)}
      </ul>
      <p className="mt-1 text-s-muted">That can be right (one transfer paying several invoices). If not, correct the entry.</p>
    </div>
  )
}

// ─── Dialog helpers shared by the money dialogs (receivables, write-offs, …) ──

/** Rupees typed (a string) → paisa, exactly as the dialogs always sent it. */
export const rupeesToPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
export const paisaToRupees = (paisa: number) => String(paisa / 100)

/**
 * A PKR amount held as a rupee string — what these dialogs keep in state and
 * send (via rupeesToPaisa, unchanged) — typed with the comma-grouped
 * MoneyInput. Large amounts get a grouped preview line under the field.
 */
export function RupeeField({ id, value, onChange, label, invalid, className = 's-input', allowNegative }: {
  id?: string; value: string; onChange: (v: string) => void; label: string; invalid?: boolean; className?: string; allowNegative?: boolean
}) {
  const cents = rupeesToPaisa(value)
  return (
    <>
      <MoneyInput id={id} ariaLabel={label} value={cents} allowNegative={allowNegative} onChange={(c) => onChange(c === 0 ? '' : paisaToRupees(c))}
        className={className} aria-invalid={invalid ? true : undefined} />
      {Math.abs(cents) >= 10_000_000 && <span className="block text-xs text-s-muted mt-1" aria-live="polite">{fmtPkrWhole(cents)}</span>}
    </>
  )
}

/**
 * A dialog's <form>: Enter submits, the primary stays enabled, a double submit is
 * ignored, and pressing it with something missing says what (role=alert) and
 * focuses the first invalid field. `missing` is the message while something
 * required is empty, else null.
 */
export function DialogForm({ onSubmit, missing, busy, children }: { onSubmit: () => void; missing: string | null; busy: boolean; children: React.ReactNode }) {
  const [tried, setTried] = useState(false)
  const ref = useRef<HTMLFormElement>(null)
  const handler = useSubmitOnce(busy)(() => {
    if (missing) {
      setTried(true)
      const f = ref.current
      const el = f?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? f?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea')
      el?.focus()
      return false
    }
    setTried(false)
    onSubmit()
    return true
  })
  return (
    <form ref={ref} onSubmit={handler} noValidate>
      {children}
      {tried && missing && <p role="alert" className="text-xs font-bold mt-3" style={{ color: 'var(--erp-danger)' }}>{missing}</p>}
    </form>
  )
}
