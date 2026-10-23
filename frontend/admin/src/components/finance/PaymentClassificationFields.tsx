'use client'
// Internal payment classification (owner, 2026-10-20) — the REQUIRED field on
// every payment form: Official / Unofficial / Unclassified (nothing picked by
// default), plus the tax-deduction status and the reason a tax was not
// deducted. A reporting label only: the server never changes a posting, an
// account, the trial balance or a tax return because of it
// (backend accounting/paymentsRegister.ts). Sent with the pay request as
// `classification`, `taxStatus`, `nonDeductionReason`.

import { Field, Input } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'

export type PaymentClassification = 'official' | 'unofficial' | 'unclassified'
export type PaymentTaxStatus = 'deducted' | 'not_deducted' | 'not_applicable'

export interface PaymentClassificationValue {
  classification: PaymentClassification | ''
  taxStatus: PaymentTaxStatus | ''
  nonDeductionReason: string
}

export const EMPTY_PAYMENT_CLASSIFICATION: PaymentClassificationValue = { classification: '', taxStatus: '', nonDeductionReason: '' }

export const CLASSIFICATION_LABEL: Record<PaymentClassification, string> = {
  official: 'Official', unofficial: 'Unofficial', unclassified: 'Unclassified',
}
export const TAX_STATUS_LABEL: Record<PaymentTaxStatus, string> = {
  deducted: 'Deducted', not_deducted: 'Not deducted', not_applicable: 'Not applicable',
}

/** null when the form may be sent; otherwise what is missing. */
export function paymentClassificationError(v: PaymentClassificationValue): string | null {
  if (!v.classification) return 'Pick a classification: Official, Unofficial or Unclassified'
  if (v.taxStatus === 'not_deducted' && v.nonDeductionReason.trim().length < 10) return 'Say why tax was not deducted (at least 10 characters)'
  return null
}

/** The body fields for the pay request (spread into it). */
export function paymentClassificationBody(v: PaymentClassificationValue): Record<string, string | null> {
  if (!v.classification) return {}
  return {
    classification: v.classification,
    taxStatus: v.taxStatus || null,
    nonDeductionReason: v.taxStatus === 'not_deducted' ? v.nonDeductionReason.trim() : null,
  }
}

/** A small chip for lists (vendor ledger, OpEx payments, payroll). */
export function ClassificationChip({ value }: { value: PaymentClassification | null | undefined }) {
  if (!value) return <span className="text-white/30">—</span>
  const tone = value === 'official'
    ? { background: 'color-mix(in srgb, var(--erp-success) 12%, transparent)', color: 'var(--erp-success)' }
    : value === 'unofficial'
      ? { background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary)' }
      : { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'var(--muted)' }
  return <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={tone}>{CLASSIFICATION_LABEL[value]}</span>
}

export function PaymentClassificationFields({ value, onChange, compact = false, optional = false }: {
  value: PaymentClassificationValue
  onChange: (v: PaymentClassificationValue) => void
  compact?: boolean
  /** Editing a posted entry: blank keeps the original's classification, so no required star. */
  optional?: boolean
}) {
  const set = (patch: Partial<PaymentClassificationValue>) => onChange({ ...value, ...patch })
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label=""><span>Classification{!optional && <> <span style={{ color: 'var(--erp-danger)' }}>*</span></>}</span>
          <Select
            required={!optional}
            value={value.classification}
            onChange={(e) => set({ classification: e.target.value as PaymentClassification | '' })}
            className="s-input"
            aria-label="Payment classification"
          >
            <option value="" disabled={!optional}>{optional ? 'Keep as it is' : 'Choose…'}</option>
            <option value="official">Official</option>
            <option value="unofficial">Unofficial</option>
            <option value="unclassified">Unclassified</option>
          </Select>
        </Field>
        <Field label=""><span>Tax deduction</span>
          <Select
            value={value.taxStatus}
            onChange={(e) => set({ taxStatus: e.target.value as PaymentTaxStatus | '' })}
            className="s-input"
            aria-label="Tax deduction status"
          >
            <option value="">Not recorded</option>
            <option value="deducted">Deducted</option>
            <option value="not_deducted">Not deducted</option>
            <option value="not_applicable">Not applicable</option>
          </Select>
        </Field>
      </div>
      {value.taxStatus === 'not_deducted' && (
        <Field label=""><span>Reason tax was not deducted <span style={{ color: 'var(--erp-danger)' }}>*</span></span>
          <Input
            value={value.nonDeductionReason}
            maxLength={500}
            placeholder="e.g. below the withholding threshold; exemption certificate on file"
            onChange={(e) => set({ nonDeductionReason: e.target.value })}
          />
        </Field>
      )}
      {!compact && (
        <p className="text-xs text-s-muted">
          Internal reporting label only — it changes no entry, account, tax return or statutory report.
        </p>
      )}
    </div>
  )
}
