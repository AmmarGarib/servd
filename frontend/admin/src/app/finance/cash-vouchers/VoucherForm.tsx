'use client'
// New voucher / edit a draft. Saving makes (or updates) a DRAFT only — no
// signature, no cash. The cash box decides the cashier (its custodian) and
// the company: a box's voucher is that box's company's.

import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { formatBrandName } from '../../../lib/brandName'
import { useMyTenants } from '../../../components/ui/TenantPicker'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CATEGORY_SUGGESTIONS, CV_BASE, dateInput, errorWords, todayKarachi, useBrands, usePettyBoxes, useStaffNames,
  type CashVoucher,
} from './data'
import { ErrorBanner, Field, Footer, Modal, fieldCls, primaryBtn } from './ui'

/** "2,50,000" / "250000.5" → paisa; NaN when it is not a positive amount. */
function toCents(s: string): number {
  const n = Number(s.replace(/[,\s]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return NaN
  return Math.round(n * 100)
}

export function VoucherForm({ voucher, onClose, onSaved }: {
  /** Editing this draft; omitted = a new voucher. */
  voucher?: CashVoucher
  onClose: () => void
  onSaved: (v: CashVoucher) => void
}) {
  const editing = !!voucher
  const { data: boxes = [], isLoading: boxesLoading, error: boxesError } = usePettyBoxes()
  const { data: brands = [] } = useBrands()
  const { data: staff = [] } = useStaffNames()
  const { data: tenants = [] } = useMyTenants()

  const [payeeName, setPayeeName] = useState(voucher?.payeeName ?? '')
  const [amount, setAmount] = useState(voucher ? String(voucher.amountCents / 100) : '')
  const [purpose, setPurpose] = useState(voucher?.purpose ?? '')
  const [category, setCategory] = useState(voucher?.category ?? '')
  const [conceptId, setConceptId] = useState(voucher?.conceptId ?? '')
  const [department, setDepartment] = useState(voucher?.department ?? '')
  const [voucherDate, setVoucherDate] = useState(voucher ? dateInput(voucher.voucherDate) : todayKarachi())
  const [boxId, setBoxId] = useState(voucher?.boxId ?? '')

  const activeBoxes = boxes.filter((b) => b.isActive || b.id === voucher?.boxId)
  const box = boxes.find((b) => b.id === boxId) ?? null
  const multiCompany = new Set(activeBoxes.map((b) => b.tenantId)).size > 1
  const companyOf = (tenantId: string | null) => tenants.find((t) => t.id === tenantId)?.name

  // Suggestions: the usual categories plus whatever the boxes' spends used.
  const categories = useMemo(() => {
    const seen = new Set(CATEGORY_SUGGESTIONS)
    for (const b of boxes) for (const m of b.movements ?? []) if (m.category) seen.add(m.category)
    return Array.from(seen)
  }, [boxes])

  const cents = toCents(amount)
  const payeeUserId = staff.find((u) => u.name.trim().toLowerCase() === payeeName.trim().toLowerCase())?.id ?? null
  const ready = !!payeeName.trim() && Number.isFinite(cents) && !!purpose.trim() && !!boxId

  const save = useMutation({
    mutationFn: () => {
      const body = {
        voucherDate,
        payeeName: payeeName.trim(),
        payeeUserId,
        purpose: purpose.trim(),
        category: category.trim() || null,
        conceptId: conceptId || null,
        department: department.trim() || null,
        amountCents: cents,
        // On an edit the box is sent only when it changed: the API re-checks a
        // sent box (open, this company's), and an unchanged one needs no check.
        ...(!editing || boxId !== voucher!.boxId ? { boxId } : {}),
      }
      // The write belongs to the box's company — so the "All companies" view
      // never asks which company (the same pin the approvals inbox uses).
      const tenantId = (editing ? voucher!.tenantId : box?.tenantId) ?? undefined
      const extra = tenantId ? { tenantId } : undefined
      return editing
        ? api.patch<CashVoucher>(`${CV_BASE}/${voucher!.id}`, body, extra)
        : api.post<CashVoucher>(CV_BASE, body, extra)
    },
    meta: { inlineErrors: true },
    onSuccess: (v) => onSaved(v),
  })

  return (
    <Modal title={editing ? `Edit ${voucher!.number}` : 'New cash voucher'} onClose={onClose} wide>
      <p className="text-xs text-white/50">
        Saving makes a draft. Nothing reaches cash until the HOD and the director have signed, the cashier has paid
        against the printed voucher, and its signed photo is uploaded.
      </p>

      <Field label="Pay to *" hint={payeeUserId ? 'Matches a servd login.' : undefined}>
        <input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} list="cv-payees"
          placeholder="Who receives the cash" className={fieldCls} autoFocus />
        <datalist id="cv-payees">{staff.map((u) => <option key={u.id} value={u.name} />)}</datalist>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Amount (PKR) *">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="25,000" className={fieldCls} />
        </Field>
        <Field label="Date *">
          <input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} className={fieldCls} />
        </Field>
      </div>
      {Number.isFinite(cents) && (
        <p className="-mt-1 text-[11px] text-white/55">
          PKR {formatPkr(cents)} — {amountInWords(cents)}
        </p>
      )}

      <Field label="Purpose *">
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2}
          placeholder="What the cash is for" className={fieldCls} />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Category">
          <input value={category} onChange={(e) => setCategory(e.target.value)} list="cv-categories" placeholder="supplies · courier" className={fieldCls} />
          <datalist id="cv-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Department">
          <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Optional" className={fieldCls} />
        </Field>
      </div>

      <Field label="Brand">
        <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
          <option value="">— no brand (company-wide) —</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{formatBrandName(b.name)}</option>)}
        </select>
      </Field>

      <Field label="Paid from (cash box) *"
        hint={box
          ? <>Cashier: <span className="font-bold text-white/75">{box.custodianName ?? '—'}</span> · the box holds PKR {formatPkr(box.floatCents)}{Number.isFinite(cents) && cents > box.floatCents && <span className="text-s-amber font-bold"> — not enough for this voucher; top it up before paying</span>}</>
          : 'The box the cashier pays from. Its custodian is the cashier who signs the paper.'}>
        <select value={boxId} onChange={(e) => setBoxId(e.target.value)} className={fieldCls}>
          <option value="">{boxesLoading ? 'Loading boxes…' : '— pick a cash box —'}</option>
          {activeBoxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}{b.custodianName ? ` — ${b.custodianName}` : ''}{multiCompany && companyOf(b.tenantId) ? ` · ${companyOf(b.tenantId)}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {!boxesLoading && activeBoxes.length === 0 && (
        <p className="text-xs text-s-amber">
          {boxesError ? 'The cash boxes could not be read with this login.' : 'No cash box yet.'} Add one on Finance → Petty cash first.
        </p>
      )}

      {save.error && <ErrorBanner message={errorWords(save.error, 'save')} />}
      <Footer onCancel={onClose} primary={
        <button onClick={() => save.mutate()} disabled={save.isPending || !ready} className={primaryBtn}>
          {save.isPending ? 'Saving…' : editing ? 'Save draft' : 'Save as draft'}
        </button>
      } />
    </Modal>
  )
}
