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
//     Equipment (owner, 2026-10-19): the account picker also offers the
//     company's fixed-asset classes — booked to CapEx advances at payment, the
//     CEO approves the capitalisation, then it depreciates monthly (an outlet
//     is picked when there is no brand: shared equipment). "To pay from":
//     cash, a bank, or credit from a supplier (finance's pay books a supplier
//     bill instead of handing cash over).
//     Official / Unofficial / Unclassified (+ tax status) is picked here too
//     (owner, 2026-10-20) — a payee voucher is raised by finance or the CEO
//     only; it prefills the pay step. A cash request is classified at pay,
//     after the approvals.
//   • Edit — the same fields on an existing voucher (after it is returned, or
//     while it still waits for finance); the detail page then resubmits.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { api } from '../../../lib/api'
import { pStr, pNum, type Prefill } from '../../../lib/trashPrefill'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, CV_ROOT, dateInput, errorWords, todayKarachi, useCategories, usePettyBoxes, useRaiseOptions, type CashVoucher,
} from './data'
import { ErrorBanner, Field, Footer, Modal, dateBounds, fieldCls, firstMissing, focusField, primaryBtn, useSubmitOnce } from './ui'
import { Select } from '@/components/ui/Select'
import {
  EMPTY_PAYMENT_CLASSIFICATION, PaymentClassificationFields, paymentClassificationBody, paymentClassificationError,
  type PaymentClassificationValue,
} from '@/components/finance/PaymentClassificationFields'

export function VoucherForm({ mode = 'request', voucher, isKeeper, onClose, onSaved, prefill }: {
  /** Recovered from the Trash: purpose, category / account, amounts and payee. The date, approvals and attachments start fresh. */
  prefill?: Prefill | null
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

  const pf = voucher ? null : (prefill ?? null)
  const startGross = voucher ? (voucher.grossCents ?? voucher.amountCents + (voucher.discountCents ?? 0)) : (pNum(pf, 'grossCents', 'amountCents') ?? 0)
  const [grossCents, setGrossCents] = useState(startGross)
  const [discountCents, setDiscountCents] = useState(voucher?.discountCents ?? (expense ? pNum(pf, 'discountCents') ?? 0 : 0))
  const [purpose, setPurpose] = useState(voucher?.purpose ?? pStr(pf, 'purpose') ?? '')
  // The account picker: a PAYOUT key, a 6xxx code, or 'asset:<classId>' (equipment, payee vouchers only).
  const [category, setCategory] = useState(voucher?.assetClassId ? `asset:${voucher.assetClassId}` : (voucher?.category ?? pStr(pf, 'category', 'categoryKey', 'accountCode') ?? ''))
  const [assetLocationId, setAssetLocationId] = useState(voucher?.assetLocationId ?? '')
  const [payFrom, setPayFrom] = useState<'cash' | 'bank' | 'credit'>(voucher?.payFrom ?? 'cash')
  const [payFromBankAccountId, setPayFromBankAccountId] = useState(voucher?.payFromBankAccountId ?? '')
  const [supplierId, setSupplierId] = useState(voucher?.supplierId ?? '')
  const [newSupplier, setNewSupplier] = useState('')
  const { data: opts } = useRaiseOptions(expense)
  const qc = useQueryClient()
  const [voucherDate, setVoucherDate] = useState(voucher ? dateInput(voucher.voucherDate) : todayKarachi())
  const [payeeName, setPayeeName] = useState(expense ? (voucher?.payeeName ?? pStr(pf, 'payeeName') ?? '') : '')
  const [sendTo, setSendTo] = useState<'ceo' | 'finance'>('ceo')
  const [cls, setCls] = useState<PaymentClassificationValue>(voucher?.classification
    ? { classification: voucher.classification, taxStatus: voucher.taxStatus ?? '', nonDeductionReason: voucher.nonDeductionReason ?? '' }
    : EMPTY_PAYMENT_CLASSIFICATION)

  const tenantId = voucher?.tenantId ?? null
  const expenseAccounts = chart.filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!tenantId || a.tenantId === tenantId))
  const isCode = /^\d{4}$/.test(category)
  const assetClassId = category.startsWith('asset:') ? category.slice(6) : ''
  const assetClass = opts?.classes.find((c) => c.id === assetClassId) ?? null
  // Shared equipment (no brand on the voucher) names its outlet.
  const needsOutlet = !!assetClassId && !voucher?.conceptId
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
    'cv-category': category ? '' : (expense ? 'Pick an expense account or a fixed asset.' : 'Pick an expense category.'),
    ...(needsOutlet ? { 'cv-outlet': assetLocationId ? '' : 'Pick the outlet the equipment is at.' } : {}),
    ...(expense && payFrom === 'credit' ? { 'cv-supplier': supplierId ? '' : 'Pick the supplier.' } : {}),
    ...(expense ? { 'cv-classification': paymentClassificationError(cls) ?? '' } : {}),
  }
  const shown = (k: string) => (tried ? errs[k] : '')

  const save = useMutation({
    mutationFn: () => {
      const cat = assetClassId
        ? { assetClassId, assetLocationId: assetLocationId || null }
        : isCode ? { categoryKey: null, accountCode: category } : { categoryKey: category, accountCode: null }
      const body: Record<string, unknown> = {
        voucherDate,
        purpose: purpose.trim(),
        ...cat,
        ...(expense
          ? {
            payeeName: payeeName.trim(), grossCents, discountCents, ...(editing ? {} : { kind: 'expense', sendTo }),
            payFrom,
            payFromBankAccountId: payFrom === 'bank' && payFromBankAccountId ? payFromBankAccountId : null,
            supplierId: payFrom === 'credit' ? supplierId : null,
            ...paymentClassificationBody(cls),
          }
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
  // "Add supplier" — the existing supplier route (POST /procurement/suppliers; the supplier master's own rule
  // decides who may add one — the server refuses anyone else and the message is shown).
  const addSupplier = useMutation({
    mutationFn: () => api.post<{ id: string; name: string }>('/procurement/suppliers', { name: newSupplier.trim() }),
    meta: { inlineErrors: true },
    onSuccess: (sup) => {
      setSupplierId(sup.id); setNewSupplier('')
      void qc.invalidateQueries({ queryKey: [CV_ROOT, 'raise-options'] })
    },
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
        hint={assetClassId ? undefined : 'The expense is booked here when finance pays it.'} error={shown('cv-category')}>
        <Select id="cv-category" value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
          <option value="">— pick {expense ? 'an account' : 'a category'} —</option>
          {expense ? (
            <optgroup label="Expense accounts">
              {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
              {isKeeper && expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </optgroup>
          ) : categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
          {!expense && isKeeper && expenseAccounts.length > 0 && (
            <optgroup label="Another expense account">
              {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </optgroup>
          )}
          {expense && (opts?.classes.length ?? 0) > 0 && (
            <optgroup label="Fixed assets (capitalised, then depreciated)">
              {opts!.classes.map((c) => <option key={c.id} value={`asset:${c.id}`}>Fixed asset — {c.label}</option>)}
            </optgroup>
          )}
        </Select>
      </Field>
      {assetClassId && (
        <p className="-mt-1 text-[11px] text-white/55">
          {assetClass?.label ?? 'Equipment'}: booked to CapEx advances at payment; the CEO approves the capitalisation, then it depreciates monthly.
        </p>
      )}
      {assetClassId && needsOutlet && (
        <Field label="Outlet *" hint="Where the equipment is. Not decided yet? Pick “General — to be assigned” and move it to its outlet later from the asset register." error={shown('cv-outlet')}>
          <Select id="cv-outlet" value={assetLocationId} onChange={(e) => setAssetLocationId(e.target.value)} className={fieldCls}>
            <option value="">— pick the outlet —</option>
            {(opts?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
      )}

      {expense && (
        <Field label="To pay from *" hint={payFrom === 'credit'
          ? 'No cash is handed over: when finance books it, a supplier bill is raised (paid later through Supplier payments).'
          : 'Finance may still pick another source when paying.'}>
          <Select id="cv-pay-from" value={payFrom} onChange={(e) => setPayFrom(e.target.value as 'cash' | 'bank' | 'credit')} className={fieldCls}>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="credit">Credit (supplier bill)</option>
          </Select>
        </Field>
      )}
      {expense && payFrom === 'bank' && (
        <BankAccountSelect tenantId={tenantId ?? opts?.tenantId ?? null} value={payFromBankAccountId} onChange={setPayFromBankAccountId}
          id="cv-bank" className={fieldCls} />
      )}
      {expense && payFrom === 'credit' && (
        <Field label="Supplier *" error={shown('cv-supplier')}>
          <Select id="cv-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fieldCls}>
            <option value="">— pick the supplier —</option>
            {voucher?.supplierId && !opts?.suppliers.some((x) => x.id === voucher.supplierId) && (
              <option value={voucher.supplierId}>{voucher.supplierName ?? 'Current supplier'}</option>
            )}
            {(opts?.suppliers ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <div className="mt-2 flex gap-2">
            <input value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} maxLength={120} placeholder="New supplier name"
              aria-label="New supplier name" className={fieldCls} />
            <button type="button" disabled={!newSupplier.trim() || addSupplier.isPending} className={primaryBtn}
              onClick={() => { addSupplier.reset(); addSupplier.mutate() }}>
              {addSupplier.isPending ? 'Adding…' : 'Add supplier'}
            </button>
          </div>
          {addSupplier.error && <ErrorBanner message={errorWords(addSupplier.error)} />}
        </Field>
      )}

      {expense && (
        <div id="cv-classification" tabIndex={-1}>
          <PaymentClassificationFields value={cls} onChange={setCls} />
          {shown('cv-classification') && <p className="mt-1 text-xs text-s-red">{shown('cv-classification')}</p>}
          <p className="mt-1 text-xs text-s-muted">Carried to the payment when finance pays it (it can still be changed there).</p>
        </div>
      )}

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
