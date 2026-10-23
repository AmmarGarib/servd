'use client'
// The one bank-account picker for every money form that is not a till sale
// (supplier payments, receivable receipts, wallet top-ups, CapEx, OpEx, gift
// cards, tax payments, payroll, deposit drops). The server decides the
// account (backend lib/bankAccounts.ts moneyAccountCode): a named account
// must be a live, linked account of the document's company; with none named
// it uses the company's only bank, and refuses when the company has two or
// more (BANK_ACCOUNT_REQUIRED). This picker shows only that company's banks
// and marks the choice required when it has more than one.

import { FieldLabel } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Select } from '@/components/ui/Select'

/** The one label style of the finance forms (muted token, text-xs). */
export const FIELD_LABEL_CLASS = 'block text-xs text-s-muted mb-1'

export interface BankAccountOption {
  id: string
  name: string
  bankName?: string | null
  accountCode: string | null
  tenantId: string | null
  isActive?: boolean
}

/** The live, linked bank accounts the caller can see (Configuration → Bank accounts). */
export function useBankAccounts() {
  return useQuery<BankAccountOption[]>({
    queryKey: ['bank-accounts'],
    queryFn: () => api.get('/setup/bank-accounts'),
    staleTime: 60_000,
    retry: false,
    meta: { background: true },
  })
}

/** The banks of one company that can take a posting. */
export function banksOf(banks: BankAccountOption[], tenantId: string | null | undefined): BankAccountOption[] {
  return banks.filter((b) => b.accountCode && b.isActive !== false && (!tenantId || b.tenantId === tenantId))
}

export function BankAccountSelect({
  tenantId,
  value,
  onChange,
  id = 'bank-account',
  label = 'Bank account',
  className,
  labelClassName = FIELD_LABEL_CLASS,
}: {
  /** The company the money belongs to (the document's company). */
  tenantId: string | null | undefined
  value: string
  onChange: (bankAccountId: string) => void
  id?: string
  label?: string
  /** Class for the <Select> (the page's field style). */
  className?: string
  labelClassName?: string
}) {
  const { data = [], isLoading, isError } = useBankAccounts()
  const banks = banksOf(data, tenantId)
  const required = banks.length > 1

  return (
    <div>
      <FieldLabel htmlFor={id} className={labelClassName}>
        {label}{required ? ' *' : ''}
      </FieldLabel>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        disabled={isLoading || isError}
        required={required}
      >
        <option value="">
          {isError ? 'Bank accounts unavailable' : banks.length === 1 ? `${banks[0]!.name} (only bank)` : banks.length === 0 ? 'Operating account (1020)' : '— pick the bank —'}
        </option>
        {banks.map((b) => (
          <option key={b.id} value={b.id}>{b.name}{b.accountCode ? ` (${b.accountCode})` : ''}</option>
        ))}
      </Select>
    </div>
  )
}
