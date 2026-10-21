'use client'
// One payroll month. Inputs are editable while it is a draft; approval must be
// by someone other than the preparer; locking makes it final and is what
// counts loan installments as recovered.

import { useParams, useRouter } from 'next/navigation'
import { PaymentClassificationFields, ClassificationChip, EMPTY_PAYMENT_CLASSIFICATION, paymentClassificationBody, paymentClassificationError, type PaymentClassificationValue, type PaymentClassification } from '@/components/finance/PaymentClassificationFields'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../../lib/api'
import { card, btn, btnGhost, btnDanger, inp, rs, human, day, localDate, STATUS_COLOR } from '../../../../lib/hr'
import { HrShell, Modal, Stat, useHrAccess } from '../../../../components/hr/HrShell'
import { BankAccountSelect } from '../../../../components/finance/BankAccountSelect'
import { NumberField } from '@/components/ui/NumberField'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { OvertimePicker, otAvailableOf, otSummary } from '../../../../components/hr/OvertimePicker'

interface Line { kind: 'earning' | 'deduction' | 'employer'; code: string; label: string; amountCents: number }
/** How the salary was worked out (backend hr/logic.ts PayBasis, owner HR-1):
 *  monthly gross ÷ days in month × paid days. Absent on payslips from before. */
interface PayBasis { daysInMonth: number; employedDays: number; absentDays: number; unpaidLeaveDays: number; paidDays: number; dailyRateCents: number; monthlyGrossCents: number }
const basisOf = (s: Slip): PayBasis | null => {
  const b = s.inputs['payBasis'] as PayBasis | undefined
  return b && typeof b.paidDays === 'number' && typeof b.daysInMonth === 'number' ? b : null
}
interface Slip {
  id: string; employeeId: string
  employee: { fullName: string; employeeCode: string; bankName: string | null; iban: string | null; paymentMethod: string | null; eobiNo: string | null }
  inputs: Record<string, number | boolean | string[] | unknown>
  lines: Line[]; grossCents: number; earningsCents: number; deductionsCents: number; eobiEmployeeCents: number; eobiEmployerCents: number; netCents: number
}
/** How a run was paid (backend hr/ledger.ts postPayrollPayment → totals.payment). */
interface RunPayment {
  paidOn: string
  bank: { code: string | null; bankAccountId: string | null; cents: number; staff: number }
  cash: { code: string; cents: number; staff: number }
}
interface Detail { run: { id: string; tenantId: string; period: string; status: string; paidAt: string | null; paymentClassification?: PaymentClassification | null; createdById: string | null; preparedByIds: string[]; totals: Record<string, number | string[] | RunPayment> }; payslips: Slip[] }

/** Cash staff are paid from the safe; bank and cheque staff from the bank —
 *  by the method snapshotted when the month was calculated. */
const isCashSlip = (s: Slip) => (typeof s.inputs['paymentMethod'] === 'string' ? s.inputs['paymentMethod'] : s.employee.paymentMethod) === 'cash'
const splitLine = (bankCents: number, bankStaff: number, cashCents: number, cashStaff: number) =>
  `Bank ${rs(bankCents)} / ${bankStaff} staff · Cash ${rs(cashCents)} / ${cashStaff} staff`

/** The Overtime column: what is added, and what is available but not added. */
function otCell(s: Slip): string {
  const sel = (s.inputs['otRecordIds'] as string[] | undefined) ?? []
  const left = otSummary(otAvailableOf(s.inputs['otAvailable']), sel)
  const paid = Number(s.inputs['otCents'] ?? 0)
  const parts = [paid > 0 ? `${rs(paid)} added` : '', left.count > 0 ? `${Math.round(left.hours * 100) / 100} h available` : '']
  return parts.filter(Boolean).join(' · ') || '—'
}

const INPUTS: Array<[string, string, boolean]> = [
  ['absentDays', 'Absent days', false], ['unpaidLeaveDays', 'Unpaid leave days', false], ['lateCount', 'Lates', false],
  ['otHours', 'OT hours (prices the OT amount)', false], ['otCents', 'OT amount', true], ['earningAdjustmentsCents', 'Bonuses & allowances', true],
  ['deductionAdjustmentsCents', 'Other deductions', true], ['loanInstallmentsCents', 'Loan installment', true],
]

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [err, setErr] = useState('')
  const { userId, role, isPayrollApprover, isPayrollPayer } = useHrAccess()
  const confirm = useConfirm()
  const { data, error: loadErr, isLoading } = useQuery({ queryKey: ['hr-payroll', id], queryFn: () => api.get<Detail>(`/hr/payroll/runs/${id}`) })
  const act = useMutation({
    mutationFn: (what: 'recalculate' | 'approve' | 'reopen' | 'lock' | 'delete') =>
      what === 'delete' ? deleteWithUndo(`/hr/payroll/runs/${id}`, { trashType: 'hr_payroll_run', id, onRestored: () => void qc.invalidateQueries() })
      : api.post(`/hr/payroll/runs/${id}/${what}`, {}),
    onSuccess: (_r, what) => { setErr(''); if (what === 'delete') router.push('/hr/payroll'); else void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  // Overtime is opt-in (owner, 2026-10-21): "Add all available overtime" adds
  // every payslip's approved, unpaid OT in one go.
  const addAllOt = useMutation({
    mutationFn: () => api.post<{ updated: number; otCents: number }>(`/hr/payroll/runs/${id}/overtime`, { all: true }),
    onSuccess: (r) => { setErr(''); setOtMsg(r.updated ? `Overtime added on ${r.updated} payslip${r.updated === 1 ? '' : 's'} (${rs(r.otCents)}).` : 'No overtime was available to add.'); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const [otMsg, setOtMsg] = useState('')
  const run = data?.run
  const editing = data?.payslips.find((p) => p.id === editingId) ?? null
  const otLeft = (data?.payslips ?? []).reduce((acc, s) => {
    const o = otSummary(otAvailableOf(s.inputs['otAvailable']), (s.inputs['otRecordIds'] as string[] | undefined) ?? [])
    return { hours: acc.hours + o.hours, cents: acc.cents + o.cents, count: acc.count + o.count }
  }, { hours: 0, cents: 0, count: 0 })
  const t = (run?.totals ?? {}) as Record<string, number>
  const warnings = (run?.totals?.['warnings'] as string[] | undefined) ?? []
  const payment = run?.totals?.['payment'] as RunPayment | undefined
  // Each sheet as CSV / Excel / PDF (the bank file's CSV is unchanged).
  const dl = (kind: string, label: string) => (
    <ExportMenu className={btnGhost} label={label} path={`/hr/payroll/runs/${id}/export.csv?kind=${kind}`} filename={`payroll-${run?.period}-${kind}`} onError={(m) => setErr(m)} />
  )
  // The API's rules: only admin, owner or management approve, reopen and lock,
  // and nobody approves a payroll they created, recalculated or edited — the
  // CEO (admin) excepted.
  const ask = async (what: 'approve' | 'lock' | 'delete') => {
    if (!run) return
    const facts = `${run.period} · ${t['employees'] ?? 0} employees · net pay ${rs(t['netCents'])}.`
    const ok = await confirm(
      what === 'lock' ? { title: `Lock payroll for ${run.period}?`, body: `${facts} It is posted to the books and cannot be undone.`, confirmLabel: 'Lock payroll', danger: true }
      : what === 'approve' ? { title: `Approve payroll for ${run.period}?`, body: `${facts} After approval it can be reopened until it is locked.`, confirmLabel: 'Approve' }
      : { title: `Delete the draft payroll for ${run.period}?`, body: `${facts} The calculation is discarded; you can calculate the month again.`, confirmLabel: 'Delete draft', danger: true })
    if (ok) act.mutate(what)
  }
  const prepared = !!run && !!userId && (run.createdById === userId || (run.preparedByIds ?? []).includes(userId))
  const canApprove = isPayrollApprover && (!prepared || role === 'admin')

  return (
    <HrShell title={run ? `Payroll ${run.period}` : 'Payroll'}
      actions={run && <span className="text-xs font-black uppercase tracking-wider self-center" style={{ color: STATUS_COLOR[run.status] ?? 'var(--erp-warning)' }}>{human(run.status)}</span>}>
      {isLoading && <p className="text-sm text-white/40" role="status">Loading payroll…</p>}
      {loadErr && <p className="text-sm text-s-red" role="alert">{(loadErr as Error).message}</p>}
      {run && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Employees" value={t['employees'] ?? 0} />
            <Stat label="Gross" value={rs(t['grossCents'])} />
            <Stat label="Deductions" value={rs(t['deductionsCents'])} />
            <Stat label="Net pay" value={rs(t['netCents'])} tone="good" />
            <Stat label="EOBI employee" value={rs(t['eobiEmployeeCents'])} />
            <Stat label="EOBI employer" value={rs(t['eobiEmployerCents'])} />
          </div>
          {warnings.length > 0 && (
            <div className="rounded-xl p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
              {warnings.map((w) => <p key={w} className="text-s-amber">⚠ {w}</p>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {run.status === 'draft' && <>
              <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate('recalculate')}>Recalculate from records</button>
              {otLeft.count > 0 && <button className={btnGhost} disabled={addAllOt.isPending} onClick={() => addAllOt.mutate()}>{addAllOt.isPending ? 'Adding…' : `Add all available overtime (${Math.round(otLeft.hours * 100) / 100} h, ${rs(otLeft.cents)})`}</button>}
              {canApprove && <button className={btn} disabled={act.isPending} onClick={() => void ask('approve')}>Approve</button>}
              <button className={`${btnDanger} ml-2 !text-xs [@media(pointer:coarse)]:min-h-[44px]`} disabled={act.isPending} onClick={() => void ask("delete")}>Delete draft</button>
            </>}
            {run.status === 'approved' && isPayrollApprover && <>
              <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate('reopen')}>Reopen</button>
              <button className={btn} disabled={act.isPending} onClick={() => void ask('lock')}>Lock</button>
            </>}
            {run.status === 'locked' && !run.paidAt && isPayrollPayer && (
              <button className={btn} onClick={() => { setErr(''); setPaying(true) }}>Mark paid</button>
            )}
            {run.paidAt && (
              <span className="text-xs text-success font-bold self-center">
                Paid {day(payment?.paidOn ?? run.paidAt)}{payment ? ` — ${splitLine(payment.bank.cents, payment.bank.staff, payment.cash.cents, payment.cash.staff)}` : ''}
              </span>
            )}
            {run.paidAt && run.paymentClassification && <span className="self-center"><ClassificationChip value={run.paymentClassification} /></span>}
            <span className="ml-auto flex flex-wrap gap-2">
              {dl('register', 'Payroll register')}
              {dl('bank', 'Bank transfer sheet')}
              {dl('eobi', 'EOBI report')}
              {dl('deductions', 'Deduction report')}
            </span>
          </div>
          {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
          {otMsg && <p className="text-xs text-success" role="status">{otMsg}</p>}
          {run.status === 'draft' && <p className="text-[11px] text-white/40">Approved overtime is paid only when you add it to a payslip — overtime not added stays available for a later payroll or the full &amp; final.</p>}
          {run.status === 'draft' && <p className="text-[11px] text-white/40">Approval must come from someone other than whoever created, recalculated or edited it (the CEO excepted){isPayrollApprover ? '' : ', and from the CEO, a co-owner or management'}.</p>}

          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {['Employee', 'Paid days', 'Per-day rate', 'Overtime', 'Gross', 'Earnings', 'Deductions', 'EOBI (1%)', 'Net', ''].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
              </tr></thead>
              <tbody>
                {data!.payslips.map((s) => {
                  const w = (s.inputs['warnings'] as string[] | undefined) ?? []
                  return (
                    <tr key={s.id} className="border-t border-white/[0.05]">
                      <td className="px-4 py-3"><p className="font-bold text-white/85">{s.employee.fullName}</p><p className="text-[11px] text-white/40">{s.employee.employeeCode}{s.inputs['edited'] ? ' · edited' : ''}</p></td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">{basisOf(s) ? `${basisOf(s)!.paidDays} of ${basisOf(s)!.daysInMonth}` : '—'}</td>
                      <td className="px-4 py-3 text-white/70">{basisOf(s) ? rs(basisOf(s)!.dailyRateCents) : '—'}</td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">{otCell(s)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.grossCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.earningsCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.deductionsCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.eobiEmployeeCents)}</td>
                      <td className="px-4 py-3 font-black" style={{ color: s.netCents < 0 ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.9)' }}>{rs(s.netCents)}{w.length > 0 && <span className="ml-1 text-s-amber" title={w.join('\n')}>⚠</span>}</td>
                      <td className="px-4 py-3 text-right"><button className="text-xs font-bold text-primary-ink" onClick={() => setEditingId(s.id)}>{run.status === 'draft' ? 'Payslip / edit' : 'Payslip'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && run && <SlipModal key={`${editing.id}:${((editing.inputs['otRecordIds'] as string[] | undefined) ?? []).join(',')}:${Number(editing.inputs['otCents'] ?? 0)}`} slip={editing} period={run.period} draft={run.status === 'draft'} onClose={() => setEditingId(null)} />}
      {paying && run && data && <PayRunModal runId={run.id} tenantId={run.tenantId} period={run.period} slips={data.payslips} onClose={() => setPaying(false)} />}
    </HrShell>
  )
}

/** One "Mark paid": cash staff from the safe (or the POS drawer), bank and
 *  cheque staff from the bank picked, on the day it was paid. The server
 *  pays exactly what the lock accrued (backend hr/ledger.ts). */
function PayRunModal({ runId, tenantId, period, slips, onClose }: { runId: string; tenantId: string; period: string; slips: Slip[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [bankAccountId, setBankAccountId] = useState('')
  const cashCode = '1010' as const
  const [paidOn, setPaidOn] = useState(localDate())
  const [err, setErr] = useState('')
  // Internal payment classification (2026-10-20): required, a reporting label only.
  const [cls, setCls] = useState<PaymentClassificationValue>(EMPTY_PAYMENT_CLASSIFICATION)
  const clsError = paymentClassificationError(cls)
  const cash = slips.filter(isCashSlip)
  const bank = slips.filter((s) => !isCashSlip(s))
  const sum = (xs: Slip[]) => xs.reduce((a, s) => a + Math.max(0, s.netCents), 0)
  const pay = useMutation({
    mutationFn: () => api.post(`/hr/payroll/runs/${runId}/paid`, {
      ...(bank.length > 0 && bankAccountId && { bankAccountId }),
      cashCode, paidOn,
      ...paymentClassificationBody(cls),
    }),
    onSuccess: () => { void qc.invalidateQueries(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Pay wages — ${period}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm font-bold text-white/85">{splitLine(sum(bank), bank.length, sum(cash), cash.length)}</p>
        {bank.length > 0 && (
          <BankAccountSelect id={`pay-bank-${runId}`} label="Bank and cheque staff paid from" tenantId={tenantId} value={bankAccountId} onChange={setBankAccountId} className={inp} />
        )}
        {cash.length > 0 && (
          <p className="text-xs text-white/55">
            Cash staff are paid from the safe (1010). Take wages out of a till drawer as a drop to the safe first — paying straight from a drawer would show as a shortage at its close.
          </p>
        )}
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1">Paid on</span>
          <input type="date" className={inp} value={paidOn} max={localDate()} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
        <PaymentClassificationFields value={cls} onChange={setCls} compact />
        <p className="text-[11px] text-white/40">Clears Wages Payable for this month, dated the day the money left. A closed month is refused.</p>
        {err && <p className="text-xs text-s-red">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={btn} disabled={pay.isPending || !paidOn || !!clsError} title={clsError ?? undefined} onClick={() => pay.mutate()}>{pay.isPending ? 'Saving…' : 'Confirm payment'}</button>
          <button className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

function SlipModal({ slip, period, draft, onClose }: { slip: Slip; period: string; draft: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const initial = Object.fromEntries(INPUTS.map(([k]) => [k, Number(slip.inputs[k] ?? 0)])) as Record<string, number>
  const basis = basisOf(slip)
  // null = the box was emptied. It is never turned into 0 behind the user's back.
  const [vals, setVals] = useState<Record<string, number | null>>(initial)
  const [err, setErr] = useState('')
  const changed = Object.entries(vals).filter(([k, v]) => v !== initial[k])
  const emptied = INPUTS.filter(([k]) => vals[k] == null)
  // Only what was changed: new OT hours are priced at the OT rate unless the
  // amount was changed too, and an untouched loan total keeps its split.
  const save = useMutation({
    mutationFn: () => api.patch(`/hr/payroll/payslips/${slip.id}`, Object.fromEntries(changed)),
    onSuccess: () => { void qc.invalidateQueries(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  // Overtime is added by HR (owner, 2026-10-21) — never on its own.
  const setOt = useMutation({
    mutationFn: (recordIds: string[]) => api.post(`/hr/payroll/payslips/${slip.id}/overtime`, { recordIds }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const otAvailable = otAvailableOf(slip.inputs['otAvailable'])
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!draft || save.isPending) return
    if (emptied.length > 0) { setErr(`Fill in ${emptied.map(([, l]) => l).join(', ')} — type 0 if there is none.`); return }
    setErr('')
    save.mutate()
  }
  const print = () => {
    const row = (l: Line) => `<tr><td>${l.label}</td><td style="text-align:right">${rs(l.amountCents)}</td></tr>`
    const html = `<h2>Payslip — ${period}</h2><p><strong>${slip.employee.fullName}</strong> (${slip.employee.employeeCode})</p>${basis ? `<p>Salary = ${rs(basis.monthlyGrossCents)} ÷ ${basis.daysInMonth} days × ${basis.paidDays} paid days (per-day rate ${rs(basis.dailyRateCents)})</p>` : ''}
      <h4>Earnings</h4><table>${slip.lines.filter((l) => l.kind === 'earning').map(row).join('')}</table>
      <h4>Deductions</h4><table>${slip.lines.filter((l) => l.kind === 'deduction').map(row).join('')}</table>
      <p><strong>Net pay: ${rs(slip.netCents)}</strong></p>
      <p style="font-size:12px;color:#666">Employer contributions: ${slip.lines.filter((l) => l.kind === 'employer').map((l) => `${l.label} ${rs(l.amountCents)}`).join(', ') || 'none'}</p>`
    const w = window.open('', '_blank'); if (!w) return
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title><style>body{font-family:system-ui;max-width:600px;margin:40px auto;color:#111}table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid #eee}</style></head><body>${html.replace(/<(?!\/?(h2|h4|p|strong|table|tr|td)\b)/g, '&lt;')}</body></html>`)
    w.document.close(); setTimeout(() => w.print(), 300)
  }
  return (
    <Modal title={`${slip.employee.fullName} — ${period}`} wide onClose={onClose} dirty={draft && changed.length > 0}>
      <form onSubmit={submit} noValidate className="grid md:grid-cols-2 gap-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Payslip</p>
          {basis && (
            <div className="rounded-xl p-3 mb-3 text-xs text-white/70 space-y-0.5" style={{ background: 'rgb(var(--fg-rgb) / 0.04)' }}>
              <p className="font-bold text-white/85">Salary = {rs(basis.monthlyGrossCents)} ÷ {basis.daysInMonth} days × {basis.paidDays} paid days</p>
              <p>Per-day rate {rs(basis.dailyRateCents)} · days in month {basis.daysInMonth} · employed {basis.employedDays} · absent {basis.absentDays} · unpaid leave {basis.unpaidLeaveDays}</p>
              <p className="text-white/45">Weekly offs, holidays and paid leave are paid days.</p>
            </div>
          )}
          {slip.lines.map((l) => (
            <div key={l.code + l.label} className="flex justify-between text-sm py-1 border-b border-white/[0.04]">
              <span style={{ color: l.kind === 'deduction' ? 'var(--erp-danger)' : l.kind === 'employer' ? 'rgb(var(--fg-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.8)' }}>{l.label}</span>
              <span className="text-white/85">{l.kind === 'deduction' ? '−' : ''}{rs(l.amountCents)}</span>
            </div>
          ))}
          <div className="flex justify-between text-base font-black pt-2"><span className="text-white/85">Net</span><span className="text-primary-ink">{rs(slip.netCents)}</span></div>
          <button type="button" className={`${btnGhost} mt-3`} onClick={print}>Print payslip</button>
        </div>
        <div>
          <div className="mb-3">
            <OvertimePicker available={otAvailable} selected={(slip.inputs['otRecordIds'] as string[] | undefined) ?? []} editable={draft} pending={setOt.isPending} onSave={(ids) => setOt.mutate(ids)} />
          </div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Inputs {draft ? '(editable)' : ''}</p>
          <div className="grid grid-cols-2 gap-2">
            {INPUTS.map(([k, label, money]) => (
              <label key={k} className="text-[11px] text-white/50">{label}
                <NumberField disabled={!draft} className={`${inp} mt-1`} decimals={2} min={0}
                  aria-invalid={vals[k] == null || undefined}
                  value={vals[k] == null ? null : money ? vals[k]! / 100 : vals[k]}
                  onValueChange={(n) => setVals({ ...vals, [k]: n == null ? null : money ? Math.round(n * 100) : n })} />
              </label>
            ))}
          </div>
          {err && <p className="text-xs text-s-red mt-2" role="alert">{err}</p>}
          {draft && <button type="submit" className={`${btn} mt-3`} disabled={save.isPending || changed.length === 0}>{save.isPending ? 'Recalculating…' : 'Recalculate this payslip'}</button>}
          <p className="text-xs text-white/55 mt-2">Changing the OT hours prices the OT amount at the employee&rsquo;s OT rate; change the amount too to set it by hand. Prefilled from attendance, approved leave, adjustments and loans; overtime is paid only when you add it above. “Recalculate from records” on the run replaces any edits.</p>
        </div>
      </form>
    </Modal>
  )
}
