'use client'
// Request cash / edit a request. Saving makes (or updates) a request waiting
// for its HOD — no signature, no cash. The category is the expense the cash is
// booked to when it is paid (H3: expensed at payment; receipts kept for the
// file). Finance or a manager may also name someone else as the holder, pick
// an explicit 6xxx account and the cash box; everyone else asks for
// themselves and the cashier picks the box when paying.

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { formatBrandName } from '../../../lib/brandName'
import { useAuthStore } from '../../../store/auth'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, dateInput, errorWords, todayKarachi, useBrands, useCategories, usePettyBoxes, useStaffNames,
  type CashVoucher,
} from './data'
import { ErrorBanner, Field, Footer, Modal, fieldCls, primaryBtn } from './ui'

export function VoucherForm({ voucher, isKeeper, onClose, onSaved }: {
  /** Editing this request; omitted = a new one. */
  voucher?: CashVoucher
  /** The server says this login runs petty cash (finance / the manager tiers). */
  isKeeper: boolean
  onClose: () => void
  onSaved: (v: CashVoucher) => void
}) {
  const editing = !!voucher
  const me = useAuthStore((s) => s.user)
  // Once the HOD has signed, finance may still change the category and the box — nothing else.
  const categoryOnly = editing && voucher!.status !== 'draft'
  const { data: cats } = useCategories()
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const { data: brands = [] } = useBrands()
  const { data: boxes = [] } = usePettyBoxes()
  const { data: staff = [] } = useStaffNames()
  const { data: chart = [] } = useQuery<Array<{ code: string; name: string; isActive: boolean; tenantId: string | null }>>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
    enabled: isKeeper,
    retry: false, meta: { background: true }, staleTime: 300_000,
  })

  const [amountCents, setAmountCents] = useState(voucher?.amountCents ?? 0)
  const [purpose, setPurpose] = useState(voucher?.purpose ?? '')
  const [category, setCategory] = useState(voucher?.category ?? '')
  const [conceptId, setConceptId] = useState(voucher?.conceptId ?? '')
  const [department, setDepartment] = useState(voucher?.department ?? '')
  const [voucherDate, setVoucherDate] = useState(voucher ? dateInput(voucher.voucherDate) : todayKarachi())
  const [holderUserId, setHolderUserId] = useState(voucher?.payeeUserId ?? me?.id ?? '')
  const [payeeName, setPayeeName] = useState(voucher?.payeeName ?? '')
  const [boxId, setBoxId] = useState(voucher?.boxId ?? '')

  const tenantId = voucher?.tenantId ?? null
  const companyBoxes = boxes.filter((b) => b.isActive && (!tenantId || b.tenantId === tenantId))
  const companyBrands = brands.filter((b) => !tenantId || !b.tenantId || b.tenantId === tenantId)
  const expenseAccounts = chart.filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!tenantId || a.tenantId === tenantId))
  const isCode = /^\d{4}$/.test(category)
  const ready = amountCents > 0 && !!purpose.trim() && !!category

  const save = useMutation({
    mutationFn: () => {
      const cat = isCode ? { categoryKey: null, accountCode: category } : { categoryKey: category, accountCode: null }
      const body: Record<string, unknown> = categoryOnly
        ? { ...cat, ...(isKeeper && boxId !== (voucher!.boxId ?? '') ? { boxId: boxId || null } : {}) }
        : {
          voucherDate,
          purpose: purpose.trim(),
          ...cat,
          conceptId: conceptId || null,
          department: department.trim() || null,
          amountCents,
          ...(isKeeper && holderUserId && holderUserId !== voucher?.payeeUserId ? { holderUserId } : {}),
          ...(payeeName.trim() && payeeName.trim() !== voucher?.payeeName ? { payeeName: payeeName.trim() } : {}),
          ...(isKeeper && (!editing || boxId !== (voucher!.boxId ?? '')) && boxId ? { boxId } : {}),
        }
      // An edit is pinned to the request's company, so the "All companies" view never asks.
      const extra = tenantId ? { tenantId } : undefined
      return editing
        ? api.patch<CashVoucher>(`${CV_BASE}/${voucher!.id}`, body, extra)
        : api.post<CashVoucher>(CV_BASE, body)
    },
    meta: { inlineErrors: true },
    onSuccess: (v) => onSaved(v),
  })

  return (
    <Modal title={editing ? (categoryOnly ? `Category of ${voucher!.number}` : `Edit ${voucher!.number}`) : 'Request cash'} onClose={onClose} wide>
      {!categoryOnly && (
        <p className="text-xs text-white/50">
          Saving sends it to your HOD. Nothing leaves a cash box until the HOD and the director have signed and the cashier pays it.
          Keep the receipts — you upload them here afterwards.
        </p>
      )}

      {!categoryOnly && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Amount (PKR) *">
              <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
            </Field>
            <Field label="Needed on *">
              <input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} className={fieldCls} />
            </Field>
          </div>
          {amountCents > 0 && (
            <p className="-mt-1 text-[11px] text-white/55">PKR {formatPkr(amountCents)} — {amountInWords(amountCents)}</p>
          )}
          <Field label="What is it for? *">
            <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={500}
              placeholder="e.g. Cleaning supplies for the outlet" className={fieldCls} />
          </Field>
        </>
      )}

      <Field label="Expense category *" hint="The cash is booked to this when it is paid. Receipts that show something else (stock, equipment, another category) move it there.">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
          <option value="">— pick a category —</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
          {isKeeper && expenseAccounts.length > 0 && (
            <optgroup label="Another expense account">
              {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </optgroup>
          )}
        </select>
      </Field>

      {!categoryOnly && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Brand">
              <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
                <option value="">— company-wide —</option>
                {companyBrands.map((b) => <option key={b.id} value={b.id}>{formatBrandName(b.name)}</option>)}
              </select>
            </Field>
            <Field label="Department">
              <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Optional" className={fieldCls} />
            </Field>
          </div>

          {isKeeper && staff.length > 0 ? (
            <Field label="Who takes the cash" hint="They bring the receipts back. Their HOD signs the request.">
              <select value={holderUserId} onChange={(e) => setHolderUserId(e.target.value)} className={fieldCls}>
                {me && <option value={me.id}>Me</option>}
                {staff.filter((u) => u.id !== me?.id && (!tenantId || !u.tenantId || u.tenantId === tenantId)).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-xs text-white/50">You take the cash and bring the receipts back.</p>
          )}
          <Field label="Name on the voucher" hint="Leave empty to print the holder's name.">
            <input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} maxLength={120} placeholder="Optional" className={fieldCls} />
          </Field>
        </>
      )}

      {isKeeper && (
        <Field label="Paid from (cash box)" hint="Optional — otherwise the cashier picks the box when paying.">
          <select value={boxId} onChange={(e) => setBoxId(e.target.value)} className={fieldCls}>
            <option value="">— the cashier picks —</option>
            {companyBoxes.map((b) => (
              <option key={b.id} value={b.id}>{b.name}{b.custodianName ? ` — ${b.custodianName}` : ''} · PKR {formatPkr(b.floatCents)}</option>
            ))}
          </select>
        </Field>
      )}

      {save.error && <ErrorBanner message={errorWords(save.error)} />}
      <Footer onCancel={onClose} primary={
        <button onClick={() => save.mutate()} disabled={save.isPending || !ready} className={primaryBtn}>
          {save.isPending ? 'Saving…' : editing ? 'Save' : 'Send to my HOD'}
        </button>
      } />
    </Modal>
  )
}
