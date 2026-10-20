'use client'
// Spend from a box: either expense lines (a category each — the server books
// Dr the category's account / Cr 1011 Petty cash) or a supplier bill paid in
// cash (recorded as that bill's payment, so it is never expensed twice), with
// receipt photos. Kitchen food, drinks and packaging bought with cash are
// stock, not expenses (the server refuses them here); equipment goes through
// CapEx.

import { useState } from 'react'
import { PaymentClassificationFields, EMPTY_PAYMENT_CLASSIFICATION, paymentClassificationBody, paymentClassificationError, type PaymentClassificationValue } from '@/components/finance/PaymentClassificationFields'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { SpendLinesEditor, emptyLine, lineBody, linesReady, type SpendLine } from '../../../components/finance/SpendLinesEditor'
import { ReceiptUploader, type UploadedReceipt } from '../../../components/finance/ReceiptUploader'
import { Choice, ErrorBanner, Field, Footer, Modal, fieldCls, firstMissing, focusField, pkr, primaryBtn, useSubmitOnce, type Box } from './ui'
import { Select } from '@/components/ui/Select'

interface OpenBill { id: string; billNumber: string; status: string; totalCents: number; whtCents: number; paidCents: number; creditedCents?: number; supplier: { name: string } }

export function SpendModal({ box, isKeeper, onClose, onSaved }: { box: Box; isKeeper: boolean; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<'expense' | 'bill'>('expense')
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [lines, setLines] = useState<SpendLine[]>([emptyLine()])
  const [receipts, setReceipts] = useState<UploadedReceipt[]>([])
  const [supplierBillId, setSupplierBillId] = useState('')
  // Internal payment classification (2026-10-20): required, a reporting label only.
  const [cls, setCls] = useState<PaymentClassificationValue>(EMPTY_PAYMENT_CLASSIFICATION)
  const { data: bills = [] } = useQuery<OpenBill[]>({
    queryKey: ['procurement-bills-open'],
    queryFn: () => api.get('/procurement/bills'),
    // Not everyone who records a spend reads the payables; without them only
    // expense spends are offered (no 403 toast).
    retry: false, meta: { background: true },
  })
  const openBills = bills.filter((b) => b.status === 'open' || b.status === 'partially_paid')

  // One line follows the spend's amount and reason until the user splits it.
  const setAmount = (v: number) => {
    setAmountCents(v)
    if (lines.length === 1) setLines([{ ...lines[0]!, amountCents: v }])
  }
  const setWhat = (v: string) => {
    if (lines.length === 1 && (!lines[0]!.description || lines[0]!.description === reason)) setLines([{ ...lines[0]!, description: v }])
    setReason(v)
  }

  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/movements', {
      boxId: box.id, type: 'spend', amountCents, reason: reason.trim(),
      vendorName: vendorName.trim() || null,
      ...(mode === 'bill' ? { supplierBillId } : { lines: lines.map(lineBody) }),
      ...(receipts.length > 0 && { receiptIds: receipts.map((r) => r.id) }),
      ...paymentClassificationBody(cls),
    }),
    onSuccess: () => onSaved(),
    onError: (e) => {
      // Equipment: a keeper may say a line is not equipment, with a reason
      // (the server allows finance and the CEO only, and says so otherwise).
      if (isKeeper && e instanceof ApiError && e.code === 'USE_CAPEX') {
        setLines((ls) => ls.map((l) => (l.notEquipment === undefined ? { ...l, notEquipment: false } : l)))
      }
    },
  })

  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'sp-amount': amountCents <= 0 ? 'Enter an amount above zero.' : amountCents > box.floatCents ? `More than the ${pkr(box.floatCents)} in the box.` : '',
    'sp-reason': reason.trim() ? '' : 'Say what the money was for.',
    ...(mode === 'bill'
      ? { 'sp-bill': supplierBillId ? '' : 'Pick the supplier bill.' }
      : { 'sp-lines': linesReady(lines, amountCents) ? '' : 'Every line needs a category, and the lines must add up to the amount.' }),
    'sp-cls': paymentClassificationError(cls) ?? '',
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad === 'sp-lines' ? 'sp-reason' : bad); return false }
    save.mutate()
    return true
  })

  return <Modal title={`Spend from ${box.name}`} onClose={onClose} dirty={!save.isPending && (amountCents > 0 || !!reason.trim() || receipts.length > 0)}>
    <form onSubmit={submit} className="space-y-3" noValidate>
    {openBills.length > 0 && (
      <Choice<'expense' | 'bill'> value={mode} onChange={setMode} options={[
        { value: 'expense', label: 'Expense' },
        { value: 'bill', label: 'Pays a supplier bill' },
      ]} />
    )}
    <Field label="Amount (PKR) *" error={shown('sp-amount')}>
      <MoneyInput id="sp-amount" value={amountCents} onChange={setAmount} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] mt-1" style={{ color: amountCents > box.floatCents ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
        {amountCents > box.floatCents ? `More than the ${pkr(box.floatCents)} in the box` : `In the box now: ${pkr(box.floatCents)}`}
      </p>
    </Field>
    <Field label="What for *" error={shown('sp-reason')}>
      <input id="sp-reason" value={reason} onChange={(e) => setWhat(e.target.value)} maxLength={200} placeholder="Printer paper and pens" className={fieldCls} />
    </Field>
    <Field label="Vendor">
      <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} maxLength={120} placeholder="Optional" className={fieldCls} />
    </Field>
    {mode === 'expense' ? (
      <Field label="Booked to *" error={shown('sp-lines')}>
        <SpendLinesEditor lines={lines} onChange={setLines} totalCents={amountCents} canPickAccount={isKeeper} tenantId={box.tenantId} fieldClassName={fieldCls} />
        <p className="text-[10px] text-white/35 mt-1">Kitchen food, drinks and packaging are stock — book them through a supplier receipt, not here.</p>
      </Field>
    ) : (
      <Field label="Supplier bill *" error={shown('sp-bill')}>
        <Select id="sp-bill" value={supplierBillId} onChange={(e) => setSupplierBillId(e.target.value)} className={fieldCls}>
          <option value="">— pick the bill —</option>
          {openBills.map((b) => (
            <option key={b.id} value={b.id}>{b.supplier.name} · {b.billNumber} · {pkr(b.totalCents - (b.whtCents ?? 0) - b.paidCents - (b.creditedCents ?? 0))} due</option>
          ))}
        </Select>
        <p className="text-[10px] text-white/35 mt-1">Recorded as a cash payment against the bill, so it is not expensed twice.</p>
      </Field>
    )}
    <ReceiptUploader
      uploadPath="/trustops/petty-cash/receipts"
      extraBody={{ boxId: box.id }}
      filePath={(id) => `/trustops/petty-cash/receipts/${id}`}
      receipts={receipts}
      onChange={setReceipts}
      max={5}
    />
    <p className="text-[10px] text-white/35">A receipt photo is required above your company&apos;s photo threshold (PKR 500 unless changed).</p>
    <div id="sp-cls">
      <PaymentClassificationFields value={cls} onChange={setCls} compact />
      {shown('sp-cls') && <p className="text-[11px] mt-1" style={{ color: 'var(--erp-danger)' }}>{shown('sp-cls')}</p>}
    </div>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={
      <button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Record spend'}</button>
    } />
    </form>
  </Modal>
}
