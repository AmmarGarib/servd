'use client'
// One payroll month. Inputs are editable while it is a draft; HR sends it to
// finance, finance enters the income tax and passes it to the CEO or returns
// it to HR (owner, 2026-10-30: "HR sends to finance, then CEO"); approval must
// be by someone other than the preparer; locking makes it final and is what
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
import { Select } from '@/components/ui/Select'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { OvertimePicker, otAvailableOf, otSummary } from '../../../../components/hr/OvertimePicker'
import { NavIcon } from '../../../../components/ui/NavIcon'
import { SalaryBreakupView, breakupHtml, type SalaryBreakup } from '../../../../components/hr/SalaryBreakup'

interface Line { kind: 'earning' | 'deduction' | 'employer'; code: string; label: string; amountCents: number; posting?: 'recovery' | 'deduction'; note?: string | null }
/** A company's deduction type (backend hr/logic.ts DeductionType; owner, 2026-10-30). */
interface DeductionType { key: string; label: string; posting: 'recovery' | 'deduction'; active: boolean }
/** A deduction HR added to a payslip by type (inputs.deductionItems). */
interface DeductionItem { id?: string; typeKey: string; label: string; posting: 'recovery' | 'deduction'; amountCents: number; note?: string | null }
const deductionItemsOf = (s: Slip): DeductionItem[] => (Array.isArray(s.inputs['deductionItems']) ? s.inputs['deductionItems'] as DeductionItem[] : [])
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
  breakup: SalaryBreakup
  inputs: Record<string, number | boolean | string[] | unknown>
  lines: Line[]; grossCents: number; earningsCents: number; deductionsCents: number; eobiEmployeeCents: number; eobiEmployerCents: number; netCents: number
}
/** How a run was paid (backend hr/ledger.ts postPayrollPayment → totals.payment). */
interface RunPayment {
  paidOn: string
  bank: { code: string | null; bankAccountId: string | null; cents: number; staff: number }
  cash: { code: string; cents: number; staff: number }
}
interface Detail {
  run: {
    id: string; tenantId: string; period: string; status: string; paidAt: string | null; paymentClassification?: PaymentClassification | null
    createdById: string | null; preparedByIds: string[]; sentToFinanceById?: string | null
    financeNote?: string | null; financeReturnNote?: string | null; financeReturnedAt?: string | null
    totals: Record<string, number | string[] | RunPayment>
  }
  payslips: Slip[]
  deductionTypes?: DeductionType[]
}

/** The run's status in plain words. */
const RUN_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', finance_review: 'With finance', finance_checked: 'Waiting for the CEO', approved: 'Approved', locked: 'Locked',
}
/** The income tax on a payslip: the deduction line (finance's figure once it entered one). */
const taxOf = (s: Slip) => s.lines.filter((l) => l.code === 'tax').reduce((a, l) => a + l.amountCents, 0)
// How the run table and the payslip read (owner, 2026-10-31: "Allowances and all → Total Amount → deduction on
// attendance → gross → Other deductions → Net"): the server's ONE breakup (backend hr/payslipBreakup.ts), also
// used by the register and the employee's own payslip. Display only — the payslip's lines and net are unchanged.
const totalSalaryOf = (s: Slip) => s.breakup.totalSalaryCents
const basicOf = (s: Slip) => s.breakup.basicCents
const allowanceBreakdown = (s: Slip) => s.breakup.allowances
/** Every allowance name on the run, in the order they first appear — one table column each (owner, 2026-10-31). */
const allowanceColumns = (slips: Slip[]): string[] => Array.from(new Set(slips.flatMap((s) => s.breakup.allowances.map((a) => a.name))))
const allowanceCents = (s: Slip, name: string) => s.breakup.allowances.filter((a) => a.name === name).reduce((a, x) => a + x.cents, 0)
const attendanceDeductionOf = (s: Slip) => s.breakup.attendanceDeductionCents
const grossOf = (s: Slip) => s.breakup.grossCents
const otherDeductionsOf = (s: Slip) => s.breakup.otherDeductionsCents
const attendanceBreakdown = (s: Slip): string => {
  const k = s.breakup
  const b = k.basis
  const parts = [
    b ? `Per-day rate ${rs(b.dailyRateCents)} · paid ${b.paidDays} of ${b.daysInMonth} days (absent ${b.absentDays}, unpaid leave ${b.unpaidLeaveDays}, employed ${b.employedDays})` : '',
    k.daysNotPaidCents !== 0 ? `Days not paid: ${rs(k.daysNotPaidCents)}` : '',
    k.lateCents !== 0 ? `Late coming: ${rs(k.lateCents)}` : '',
  ]
  return parts.filter(Boolean).join('\n') || 'No attendance deduction'
}
const deductionBreakdown = (s: Slip) => s.breakup.otherDeductions

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
  ['deductionAdjustmentsCents', 'Other deductions (no type)', true], ['loanInstallmentsCents', 'Loan installment', true],
]

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [err, setErr] = useState('')
  const { userId, role, isHrAdmin, isPayrollApprover, isPayrollPayer, isFinanceReviewer } = useHrAccess()
  const [returning, setReturning] = useState(false)
  const [taxSlipId, setTaxSlipId] = useState<string | null>(null)
  const confirm = useConfirm()
  const { data, error: loadErr, isLoading } = useQuery({ queryKey: ['hr-payroll', id], queryFn: () => api.get<Detail>(`/hr/payroll/runs/${id}`) })
  const act = useMutation({
    mutationFn: (what: 'recalculate' | 'approve' | 'reopen' | 'lock' | 'delete' | 'send-to-finance' | 'finance-pass') =>
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
  const ask = async (what: 'approve' | 'lock' | 'delete' | 'send-to-finance' | 'finance-pass') => {
    if (!run) return
    const facts = `${run.period} · ${t['employees'] ?? 0} employees · net pay ${rs(t['netCents'])}.`
    const ok = await confirm(
      what === 'send-to-finance' ? { title: `Send payroll for ${run.period} to finance?`, body: `${facts} Finance checks it and enters the income tax. You cannot edit it while finance has it; finance can send it back to you.`, confirmLabel: 'Send to finance' }
      : what === 'finance-pass' ? { title: `Pass payroll for ${run.period} to the CEO?`, body: `${facts} Check the income tax on each payslip first. The CEO then approves it.`, confirmLabel: 'Pass to CEO' }
      : what === 'lock' ? { title: `Lock payroll for ${run.period}?`, body: `${facts} It is posted to the books and cannot be undone.`, confirmLabel: 'Lock payroll', danger: true }
      : what === 'approve' ? { title: `Approve payroll for ${run.period}?`, body: `${facts} After approval it can be reopened until it is locked.`, confirmLabel: 'Approve' }
      : { title: `Delete the draft payroll for ${run.period}?`, body: `${facts} The calculation is discarded; you can calculate the month again.`, confirmLabel: 'Delete draft', danger: true })
    if (ok) act.mutate(what)
  }
  const prepared = !!run && !!userId && (run.createdById === userId || (run.preparedByIds ?? []).includes(userId) || run.sentToFinanceById === userId)
  const canApprove = isPayrollApprover && (!prepared || role === 'admin')
  const canReview = isFinanceReviewer && (!prepared || role === 'admin')
  // Finance enters the tax while it has the run; the CEO may also on a draft.
  const canSetTax = !!run && isFinanceReviewer && (run.status === 'finance_review' || (run.status === 'draft' && role === 'admin'))
  const banner = !run ? null
    : run.status === 'finance_review' ? { tone: 'var(--erp-warning)', text: 'With finance for review — finance checks it and enters the income tax, then passes it to the CEO or returns it to HR.' }
    : run.status === 'finance_checked' ? { tone: 'var(--erp-primary)', text: `Checked by finance — waiting for the CEO.${run.financeNote ? ` Finance's note: ${run.financeNote}` : ''}` }
    : run.status === 'draft' && run.financeReturnNote ? { tone: 'var(--erp-danger)', text: `Returned by finance: ${run.financeReturnNote}` }
    : null
  const taxSlip = data?.payslips.find((p) => p.id === taxSlipId) ?? null

  return (
    <HrShell title={run ? `Payroll ${run.period}` : 'Payroll'}
      actions={run && <span className="text-xs font-black uppercase tracking-wider self-center" style={{ color: STATUS_COLOR[run.status] ?? 'var(--erp-warning)' }}>{RUN_STATUS_LABEL[run.status] ?? human(run.status)}</span>}>
      {isLoading && <p className="text-sm text-white/40" role="status">Loading payroll…</p>}
      {loadErr && <p className="text-sm text-s-red" role="alert">{(loadErr as Error).message}</p>}
      {run && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-9 gap-3">
            <Stat label="Employees" value={t['employees'] ?? 0} />
            <Stat label="Total salary" value={rs((data?.payslips ?? []).reduce((a, s) => a + totalSalaryOf(s), 0))} />
            <Stat label="Attendance deduction" value={rs((data?.payslips ?? []).reduce((a, s) => a + attendanceDeductionOf(s), 0))} />
            <Stat label="Gross" value={rs((data?.payslips ?? []).reduce((a, s) => a + grossOf(s), 0))} />
            <Stat label="Income tax" value={rs((data?.payslips ?? []).reduce((a, s) => a + taxOf(s), 0))} />
            <Stat label="Other deductions" value={rs((data?.payslips ?? []).reduce((a, s) => a + otherDeductionsOf(s), 0))} />
            <Stat label="Net pay" value={rs(t['netCents'])} tone="good" />
            <Stat label="EOBI employee" value={rs(t['eobiEmployeeCents'])} />
            <Stat label="EOBI employer" value={rs(t['eobiEmployerCents'])} />
          </div>
          {banner && (
            <div role="status" className="rounded-xl p-3 text-sm text-white/85 break-words" style={{ background: `color-mix(in srgb, ${banner.tone} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${banner.tone} 30%, transparent)` }}>
              {banner.text}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded-xl p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
              {warnings.map((w) => <p key={w} className="text-s-amber"><NavIcon name="warn" size={13} className="mr-1 inline" />{w}</p>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {run.status === 'draft' && <>
              {isHrAdmin && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate('recalculate')}>Recalculate from records</button>}
              {isHrAdmin && otLeft.count > 0 && <button className={btnGhost} disabled={addAllOt.isPending} onClick={() => addAllOt.mutate()}>{addAllOt.isPending ? 'Adding…' : `Add all available overtime (${Math.round(otLeft.hours * 100) / 100} h, ${rs(otLeft.cents)})`}</button>}
              {isHrAdmin && <button className={btn} disabled={act.isPending} onClick={() => void ask('send-to-finance')}>Send to finance</button>}
              {isHrAdmin && <button className={`${btnDanger} ml-2 !text-xs [@media(pointer:coarse)]:min-h-[44px]`} disabled={act.isPending} onClick={() => void ask("delete")}>Delete draft</button>}
            </>}
            {run.status === 'finance_review' && canReview && <>
              <button className={btn} disabled={act.isPending} onClick={() => void ask('finance-pass')}>Pass to CEO</button>
              <button className={btnGhost} disabled={act.isPending} onClick={() => { setErr(''); setReturning(true) }}>Return to HR</button>
            </>}
            {run.status === 'finance_checked' && canApprove && (
              <button className={btn} disabled={act.isPending} onClick={() => void ask('approve')}>Approve</button>
            )}
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
          {run.status === 'draft' && <p className="text-[11px] text-white/40">When it is ready, send it to finance: finance enters the income tax and passes it to the CEO, or returns it to you with a note. Approval must come from someone other than whoever created, recalculated, edited or sent it (the CEO excepted){isPayrollApprover ? '' : ', and from the CEO, a co-owner or management'}.</p>}
          {canSetTax && <p className="text-[11px] text-white/40">Tap a payslip&rsquo;s income tax to enter the figure for this month. It replaces the employee&rsquo;s usual monthly tax on this payslip only and stays if the payroll is returned and recalculated.</p>}

          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {['Employee', 'Basic', ...(allowanceColumns(data!.payslips).length ? allowanceColumns(data!.payslips) : ['Allowances']), 'Total salary', 'Paid days', 'Attendance deduction', 'Overtime', 'Gross', 'Income tax', 'Other deductions', 'EOBI (1%)', 'Net', ''].map((h, i, all) => <th key={`${h}-${i}`} className={`px-4 py-3 font-bold whitespace-nowrap${i === 0 ? ' sticky left-0 z-[1] bg-s-surface' : ''}${i === all.length - 1 ? ' pr-6' : ''}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data!.payslips.map((s) => {
                  const w = (s.inputs['warnings'] as string[] | undefined) ?? []
                  return (
                    <tr key={s.id} className="border-t border-white/[0.05]">
                      <td className="px-4 py-3 sticky left-0 z-[1] bg-s-surface min-w-[9rem]"><p className="font-bold text-white/85">{s.employee.fullName}</p><p className="text-[11px] text-white/40">{s.employee.employeeCode}{s.inputs['edited'] ? ' · edited' : ''}</p></td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">{basicOf(s) > 0 ? rs(basicOf(s)) : '—'}</td>
                      {allowanceColumns(data!.payslips).length
                        ? allowanceColumns(data!.payslips).map((name) => <td key={name} className="px-4 py-3 text-white/70 whitespace-nowrap">{allowanceCents(s, name) ? rs(allowanceCents(s, name)) : '—'}</td>)
                        : <td className="px-4 py-3 text-white/70 whitespace-nowrap">—</td>}
                      <td className="px-4 py-3 text-white/85 font-bold whitespace-nowrap">{rs(totalSalaryOf(s))}</td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">{basisOf(s) ? `${basisOf(s)!.paidDays} of ${basisOf(s)!.daysInMonth}` : '—'}</td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap" title={attendanceBreakdown(s)}>{attendanceDeductionOf(s) ? rs(attendanceDeductionOf(s)) : '—'}</td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">{otCell(s)}</td>
                      <td className="px-4 py-3 text-white/85 font-bold whitespace-nowrap">{rs(grossOf(s))}</td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap">
                        {canSetTax
                          ? <button type="button" className="font-bold text-primary-ink underline decoration-dotted underline-offset-2 [@media(pointer:coarse)]:min-h-[44px]" onClick={() => { setErr(''); setTaxSlipId(s.id) }} aria-label={`Income tax for ${s.employee.fullName}: ${rs(taxOf(s))} — change`}>{rs(taxOf(s))}</button>
                          : rs(taxOf(s))}
                        {typeof s.inputs['taxOverrideCents'] === 'number' && <span className="ml-1 text-[10px] text-white/40">set by finance</span>}
                      </td>
                      <td className="px-4 py-3 text-white/70 whitespace-nowrap" title={deductionBreakdown(s).map((b) => `${b.label}: ${rs(b.cents)}`).join('\n') || 'No other deductions'}>
                        {rs(otherDeductionsOf(s))}
                        {deductionItemsOf(s).length > 0 && <p className="text-[10px] text-white/40 max-w-[12rem] truncate">{deductionItemsOf(s).map((d) => d.label).join(' · ')}</p>}
                      </td>
                      <td className="px-4 py-3 text-white/70">{rs(s.eobiEmployeeCents)}</td>
                      <td className="px-4 py-3 font-black" style={{ color: s.netCents < 0 ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.9)' }}>{rs(s.netCents)}{w.length > 0 && <span className="ml-1 text-s-amber" title={w.join('\n')}><NavIcon name="warn" size={13} className="inline" /></span>}</td>
                      <td className="pl-4 pr-6 py-3 text-right"><button className="text-xs font-bold text-primary-ink" onClick={() => setEditingId(s.id)}>{run.status === 'draft' ? 'Payslip / edit' : 'Payslip'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && run && <SlipModal key={`${editing.id}:${((editing.inputs['otRecordIds'] as string[] | undefined) ?? []).join(',')}:${Number(editing.inputs['otCents'] ?? 0)}`} slip={editing} period={run.period} draft={run.status === 'draft'} types={data?.deductionTypes ?? []} onClose={() => setEditingId(null)} />}
      {returning && run && <ReturnModal runId={run.id} period={run.period} onClose={() => setReturning(false)} />}
      {taxSlip && run && <TaxModal slip={taxSlip} period={run.period} onClose={() => setTaxSlipId(null)} />}
      {paying && run && data && <PayRunModal runId={run.id} tenantId={run.tenantId} period={run.period} slips={data.payslips} onClose={() => setPaying(false)} />}
    </HrShell>
  )
}

/** Finance sends the payroll back to HR with what needs correcting (≥10 characters). */
function ReturnModal({ runId, period, onClose }: { runId: string; period: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const short = note.trim().length < 10
  const send = useMutation({
    mutationFn: () => api.post(`/hr/payroll/runs/${runId}/finance-return`, { note: note.trim() }),
    onSuccess: () => { void qc.invalidateQueries(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Return payroll ${period} to HR`} onClose={onClose} dirty={note.trim().length > 0}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!short && !send.isPending) send.mutate() }}>
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1">What HR needs to correct</span>
          <textarea className={`${inp} min-h-[96px]`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} aria-invalid={!!err || undefined} />
        </label>
        <p className="text-[11px] text-white/60">At least 10 characters. HR sees this note on the payroll and in the bell, edits the payroll and sends it again.</p>
        {short && note.trim().length > 0 && <p className="text-xs text-s-amber">Write a little more — {10 - note.trim().length} more character{10 - note.trim().length === 1 ? '' : 's'} needed.</p>}
        {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn} disabled={short || send.isPending}>{send.isPending ? 'Sending…' : 'Return to HR'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

/** Finance enters one payslip's income tax for the month (owner, 2026-10-30: "Finance will put tax figures"). */
function TaxModal({ slip, period, onClose }: { slip: Slip; period: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [rupees, setRupees] = useState<number | null>(taxOf(slip) / 100)
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.put(`/hr/payroll/payslips/${slip.id}/tax`, { taxCents: Math.round((rupees ?? 0) * 100) }),
    onSuccess: () => { void qc.invalidateQueries(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Income tax — ${slip.employee.fullName}, ${period}`} onClose={onClose} dirty={rupees !== taxOf(slip) / 100}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (rupees != null && !save.isPending) save.mutate() }}>
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1">Income tax this month (Rs)</span>
          <NumberField className={inp} decimals={2} min={0} value={rupees} onValueChange={setRupees} aria-invalid={rupees == null || undefined} />
        </label>
        <p className="text-[11px] text-white/40">Now {rs(taxOf(slip))}. The net pay and the run totals are worked out again. Type 0 for no tax.</p>
        {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn} disabled={rupees == null || save.isPending}>{save.isPending ? 'Saving…' : 'Save tax'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
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

function SlipModal({ slip, period, draft, types, onClose }: { slip: Slip; period: string; draft: boolean; types: DeductionType[]; onClose: () => void }) {
  const qc = useQueryClient()
  const initial = Object.fromEntries(INPUTS.map(([k]) => [k, Number(slip.inputs[k] ?? 0)])) as Record<string, number>
  const basis = basisOf(slip)
  // null = the box was emptied. It is never turned into 0 behind the user's back.
  const [vals, setVals] = useState<Record<string, number | null>>(initial)
  const [err, setErr] = useState('')
  // Deductions by type (owner, 2026-10-30): HR picks a type, an amount and an optional note; several lines allowed.
  const initialItems = deductionItemsOf(slip)
  const [items, setItems] = useState<DeductionItem[]>(initialItems)
  const activeTypes = types.filter((t) => t.active)
  const [newType, setNewType] = useState(activeTypes[0]?.key ?? '')
  const [newAmount, setNewAmount] = useState<number | null>(null)
  const [newNote, setNewNote] = useState('')
  const itemsKey = (xs: DeductionItem[]) => JSON.stringify(xs.map((d) => [d.id ?? null, d.typeKey, d.amountCents, d.note ?? '']))
  const itemsChanged = itemsKey(items) !== itemsKey(initialItems)
  const addItem = () => {
    const t = activeTypes.find((x) => x.key === newType)
    if (!t) { setErr('Pick a deduction type.'); return }
    if (newAmount == null || newAmount <= 0) { setErr('Type the deduction amount.'); return }
    setErr('')
    setItems([...items, { typeKey: t.key, label: t.label, posting: t.posting, amountCents: Math.round(newAmount * 100), note: newNote.trim() || null }])
    setNewAmount(null); setNewNote('')
  }
  const changed = Object.entries(vals).filter(([k, v]) => v !== initial[k])
  const emptied = INPUTS.filter(([k]) => vals[k] == null)
  // Only what was changed: new OT hours are priced at the OT rate unless the
  // amount was changed too, and an untouched loan total keeps its split.
  const save = useMutation({
    mutationFn: () => api.patch(`/hr/payroll/payslips/${slip.id}`, {
      ...Object.fromEntries(changed),
      ...(itemsChanged && { deductionItems: items.map((d) => ({ id: d.id ?? null, typeKey: d.typeKey, amountCents: d.amountCents, note: d.note ?? null })) }),
    }),
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
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<h2>Payslip — ${period}</h2><p><strong>${esc(slip.employee.fullName)}</strong> (${esc(slip.employee.employeeCode)})</p>
      ${breakupHtml(slip.breakup)}
      <p style="font-size:12px;color:#666">Employer contributions: ${esc(slip.lines.filter((l) => l.kind === 'employer').map((l) => `${l.label} ${rs(l.amountCents)}`).join(', ') || 'none')}</p>`
    const w = window.open('', '_blank'); if (!w) return
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title><style>body{font-family:system-ui;max-width:600px;margin:40px auto;color:#111}table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid #eee}</style></head><body>${html.replace(/<(?!\/?(h2|h4|p|strong|table|tr|td|span|br)\b)/g, '&lt;')}</body></html>`)
    w.document.close(); setTimeout(() => w.print(), 300)
  }
  return (
    <Modal title={`${slip.employee.fullName} — ${period}`} wide onClose={onClose} dirty={draft && (changed.length > 0 || itemsChanged)}>
      <form onSubmit={submit} noValidate className="grid md:grid-cols-2 gap-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Payslip</p>
          <SalaryBreakupView breakup={slip.breakup} />
          {slip.lines.some((l) => l.kind === 'employer' && l.amountCents !== 0) && (
            <p className="text-[11px] text-white/45 mt-2">Employer pays on top: {slip.lines.filter((l) => l.kind === 'employer' && l.amountCents !== 0).map((l) => `${l.label} ${rs(l.amountCents)}`).join(' · ')}</p>
          )}
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
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mt-4 mb-2">Deductions by type</p>
          {items.length === 0 && <p className="text-xs text-white/40">None added.</p>}
          <ul className="space-y-1">
            {items.map((d, i) => (
              <li key={`${d.id ?? 'new'}-${i}`} className="flex items-center gap-2 text-sm py-1 border-b border-white/[0.04]">
                <span className="min-w-0 flex-1 break-words text-white/80">
                  {d.typeKey === 'late' ? `${d.label} (added by HR)` : d.label}
                  <span className="text-[10px] text-white/40"> · {d.posting === 'recovery' ? 'recovered from loans / advances' : 'deducted from pay'}</span>
                  {d.note ? <span className="block text-[11px] text-white/45">{d.note}</span> : null}
                </span>
                <span className="text-white/85 whitespace-nowrap">−{rs(d.amountCents)}</span>
                {draft && <button type="button" className="text-xs font-bold text-s-red [@media(pointer:coarse)]:min-h-[44px] px-1" aria-label={`Remove ${d.label} ${rs(d.amountCents)}`} onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove</button>}
              </li>
            ))}
          </ul>
          {draft && (activeTypes.length === 0
            ? <p className="text-xs text-white/40 mt-2">No deduction types are switched on — add them in HR → Settings.</p>
            : (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <label className="text-[11px] text-white/50">Type
                  <Select className={`${inp} mt-1`} value={newType} onChange={(e) => setNewType(e.target.value)}>
                    {activeTypes.map((t) => <option key={t.key} value={t.key}>{t.label}{t.key === 'late' ? ' (extra, on top of lates)' : ''}</option>)}
                  </Select>
                </label>
                <label className="text-[11px] text-white/50">Amount
                  <NumberField className={`${inp} mt-1`} decimals={2} min={0} value={newAmount} onValueChange={(n) => setNewAmount(n)} />
                </label>
                <label className="text-[11px] text-white/50 col-span-2">Note (optional)
                  <input className={`${inp} mt-1`} maxLength={200} value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                </label>
                <button type="button" className={`${btnGhost} col-span-2 justify-self-start`} onClick={addItem}>Add deduction</button>
              </div>
            ))}
          {draft && <p className="text-[11px] text-white/40 mt-1">Advances and loans are recovered from the employee&rsquo;s open loans / advances. A &ldquo;Late coming&rdquo; deduction here is an extra amount on top of the lates the payroll works out itself.</p>}
          {err && <p className="text-xs text-s-red mt-2" role="alert">{err}</p>}
          {draft && <button type="submit" className={`${btn} mt-3`} disabled={save.isPending || (changed.length === 0 && !itemsChanged)}>{save.isPending ? 'Recalculating…' : 'Recalculate this payslip'}</button>}
          <p className="text-xs text-white/55 mt-2">Changing the OT hours prices the OT amount at the employee&rsquo;s OT rate; change the amount too to set it by hand. Prefilled from attendance, approved leave, adjustments and loans; overtime is paid only when you add it above. “Recalculate from records” on the run replaces any edits — except deductions added by type, added overtime and finance&rsquo;s tax.</p>
        </div>
      </form>
    </Modal>
  )
}
