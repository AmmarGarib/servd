'use client'
// Request cash (any login) / New payee voucher (finance) / edit a returned or
// waiting voucher.
//
//   • Request cash — particulars, amount, expense category.
//     Saving creates the voucher and sends it to FINANCE at once.
//   • New payee voucher — finance raises a voucher for an outside payee: payee,
//     date, particulars, expense account, amount, discount (total = amount −
//     discount, with the words live), sent to the CEO
//     (default) or to finance.
//   • Edit — the same fields on an existing voucher (after it is returned, or
//     while it still waits for finance); the detail page then resubmits.

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, dateInput, errorWords, todayKarachi, useCategories, usePettyBoxes, type CashVoucher,
} from './data'
import { ErrorBanner, Field, Footer, Modal, dateBounds, fieldCls, firstMissing, focusField, primaryBtn, useSubmitOnce } from './ui'
import { Select } from '@/components/ui/Select'

export function VoucherForm({ mode = 'request', voucher, isKeeper, onClose, onSaved }: {
  /** 'request' = ask for cash; 'expense' = finance raises a payee voucher. Ignored when editing (the voucher's own kind). */
  mode?: 'request' | 'expense'
  /** Editing this voucher; omitted = a new one. */
  voucher?: CashVoucher
  /** The server says this login runs petty cash / finance. */
  isKeeper: boolean
  onClose: () => void
  onSaved: (v: CashVoucher) => void
}) {
  const editing = !!voucher
  const expense = editing ? voucher!.kind === 'expense' : mode === 'expense'
  const { data: cats } = useCategories()
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const { data: chart = [] } = useQuery<Array<{ code: string; name: string; isActive: boolean; tenantId: string | null }>>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
    enabled: isKeeper,
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  // Finance may also pick the cash box on a voucher it edits — kept from the old form.
  usePettyBoxes()

  const startGross = voucher ? (voucher.grossCents ?? voucher.amountCents + (voucher.discountCents ?? 0)) : 0
  const [grossCents, setGrossCents] = useState(startGross)
  const [discountCents, setDiscountCents] = useState(voucher?.discountCents ?? 0)
  const [purpose, setPurpose] = useState(voucher?.purpose ?? '')
  const [category, setCategory] = useState(voucher?.category ?? '')
  const [voucherDate, setVoucherDate] = useState(voucher ? dateInput(voucher.voucherDate) : todayKarachi())
  const [payeeName, setPayeeName] = useState(expense ? (voucher?.payeeName ?? '') : '')
  const [sendTo, setSendTo] = useState<'ceo' | 'finance'>('ceo')

  const tenantId = voucher?.tenantId ?? null
  const expenseAccounts = chart.filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!tenantId || a.tenantId === tenantId))
  const isCode = /^\d{4}$/.test(category)
  const totalCents = Math.max(0, grossCents - discountCents)
  const discountOk = discountCents >= 0 && discountCents < grossCents
  const bounds = dateBounds()
  const [tried, setTried] = useState(false)
  // Message per field ('' = fine). Save stays enabled: pressing it with
  // something missing shows these and focuses the first.
  const errs: Record<string, string> = {
    ...(expense ? { 'cv-payee': payeeName.trim() ? '' : 'Enter who is being paid.' } : {}),
    'cv-amount': grossCents > 0 ? '' : 'Enter an amount above zero.',
    'cv-date': !voucherDate ? 'Pick a date.'
      : voucherDate < bounds.min || voucherDate > bounds.max ? `Pick a date between ${bounds.min} and ${bounds.max}.`
      : !expense && !editing && voucherDate < todayKarachi() ? 'Needed-on date cannot be in the past.' : '',
    ...(expense ? { 'cv-discount': discountOk ? '' : 'The discount must be less than the amount.' } : {}),
    'cv-purpose': purpose.trim() ? '' : (expense ? 'Describe the particulars.' : 'Say what the cash is for.'),
    'cv-category': category ? '' : (expense ? 'Pick an expense account.' : 'Pick an expense category.'),
  }
  const shown = (k: string) => (tried ? errs[k] : '')

  const save = useMutation({
    mutationFn: () => {
      const cat = isCode ? { categoryKey: null, accountCode: category } : { categoryKey: category, accountCode: null }
      const body: Record<string, unknown> = {
        voucherDate,
        purpose: purpose.trim(),
        ...cat,
        ...(expense
          ? { payeeName: payeeName.trim(), grossCents, discountCents, ...(editing ? {} : { kind: 'expense', sendTo }) }
          : { amountCents: grossCents }),
      }
      const extra = tenantId ? { tenantId } : undefined
      return editing
        ? api.patch<CashVoucher>(`${CV_BASE}/${voucher!.id}`, body, extra)
        : api.post<CashVoucher>(CV_BASE, body)
    },
    meta: { inlineErrors: true },
    onSuccess: (v) => onSaved(v),
  })

  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.reset(); save.mutate()
    return true
  })
  const title = editing ? `Edit ${voucher!.number}` : expense ? 'New payee voucher' : 'Request cash'
  return (
    <Modal title={title} onClose={onClose} wide dirty={!save.isPending && (purpose !== (voucher?.purpose ?? '') || grossCents !== startGross || (expense && payeeName !== (voucher?.payeeName ?? '')))}>
      <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-xs text-white/50">
        {expense
          ? (sendTo === 'ceo' || editing
            ? 'Finance prepares it, so it goes straight to the CEO for approval. After approval the cashier pays the payee.'
            : 'It goes to finance — another finance login approves it before the CEO.')
          : editing
            ? 'Fix what was returned, then resubmit it from the voucher page.'
            : 'Saving creates the voucher and sends it to finance now. Then the CEO approves, the cashier pays you, and you upload the supporting documents.'}
      </p>

      {expense && (
        <Field label="Payee *" hint="The vendor or person being paid." error={shown('cv-payee')}>
          <input id="cv-payee" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} maxLength={120} className={fieldCls} autoFocus />
        </Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label={expense ? 'Amount (PKR) *' : 'Amount needed (PKR) *'} error={shown('cv-amount')}>
          <MoneyInput id="cv-amount" value={grossCents} onChange={setGrossCents} className={fieldCls} autoFocus={!expense} ariaLabel="Amount in rupees" />
        </Field>
        <Field label={expense ? 'Date *' : 'Needed on *'} error={shown('cv-date')}>
          <input id="cv-date" type="date" min={!expense && !editing ? todayKarachi() : bounds.min} max={bounds.max} value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} className={fieldCls} />
        </Field>
      </div>

      {expense && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Discount (PKR)" error={shown('cv-discount')}>
            <MoneyInput id="cv-discount" value={discountCents} onChange={setDiscountCents} className={fieldCls} ariaLabel="Discount in rupees" />
          </Field>
          <Field label="Total to pay (PKR)">
            <div className={`${fieldCls} font-black tabular-nums`} aria-live="polite">{formatPkr(totalCents, { decimals: true })}</div>
          </Field>
        </div>
      )}
      {totalCents > 0 && (
        <p className="-mt-1 text-[11px] text-white/55">PKR {formatPkr(totalCents)} — {amountInWords(totalCents)}</p>
      )}

      <Field label={expense ? 'Particulars *' : 'What is it for? *'} error={shown('cv-purpose')}>
        <textarea id="cv-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={500}
          placeholder={expense ? 'e.g. Generator repair — invoice 1042' : 'e.g. Cleaning supplies for the outlet'} className={fieldCls} />
      </Field>

      <Field label={expense ? 'Expense account *' : 'Expense category *'}
        hint="The expense is booked here when finance verifies the documents." error={shown('cv-category')}>
        <Select id="cv-category" value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
          <option value="">— pick {expense ? 'an account' : 'a category'} —</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
          {isKeeper && expenseAccounts.length > 0 && (
            <optgroup label="Another expense account">
              {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </optgroup>
          )}
        </Select>
      </Field>

      {expense && !editing && (
        <Field label="Send to">
          <Select value={sendTo} onChange={(e) => setSendTo(e.target.value as 'ceo' | 'finance')} className={fieldCls}>
            <option value="ceo">The CEO (finance has prepared it)</option>
            <option value="finance">Finance — another finance login approves first</option>
          </Select>
        </Field>
      )}

      {save.error && <ErrorBanner message={errorWords(save.error)} />}
      <Footer onCancel={onClose} primary={
        <button type="submit" disabled={save.isPending} className={primaryBtn}>
          {save.isPending ? 'Saving…'
            : editing ? 'Save'
              : expense ? (sendTo === 'ceo' ? 'Send to the CEO' : 'Send to finance')
                : 'Send to finance'}
        </button>
      } />
      </form>
    </Modal>
  )
}
