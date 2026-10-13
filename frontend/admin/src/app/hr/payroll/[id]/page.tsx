'use client'
// One payroll month. Inputs are editable while it is a draft; approval must be
// by someone other than the preparer; locking makes it final and is what
// counts loan installments as recovered.

import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card, btn, btnGhost, inp, rs, human, day, localDate, STATUS_COLOR } from '../../../../lib/hr'
import { HrShell, Modal, Stat, useHrAccess } from '../../../../components/hr/HrShell'
import { BankAccountSelect } from '../../../../components/finance/BankAccountSelect'

interface Line { kind: 'earning' | 'deduction' | 'employer'; code: string; label: string; amountCents: number }
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
interface Detail { run: { id: string; tenantId: string; period: string; status: string; paidAt: string | null; createdById: string | null; preparedByIds: string[]; totals: Record<string, number | string[] | RunPayment> }; payslips: Slip[] }

/** Cash staff are paid from the safe; bank and cheque staff from the bank —
 *  by the method snapshotted when the month was calculated. */
const isCashSlip = (s: Slip) => (typeof s.inputs['paymentMethod'] === 'string' ? s.inputs['paymentMethod'] : s.employee.paymentMethod) === 'cash'
const splitLine = (bankCents: number, bankStaff: number, cashCents: number, cashStaff: number) =>
  `Bank ${rs(bankCents)} / ${bankStaff} staff · Cash ${rs(cashCents)} / ${cashStaff} staff`

const INPUTS: Array<[string, string, boolean]> = [
  ['absentDays', 'Absent days', false], ['unpaidLeaveDays', 'Unpaid leave days', false], ['lateCount', 'Lates', false],
  ['otHours', 'OT hours (prices the OT amount)', false], ['otCents', 'OT amount', true], ['earningAdjustmentsCents', 'Bonuses & allowances', true],
  ['deductionAdjustmentsCents', 'Other deductions', true], ['loanInstallmentsCents', 'Loan installment', true],
]

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Slip | null>(null)
  const [paying, setPaying] = useState(false)
  const [err, setErr] = useState('')
  const { userId, role, isPayrollApprover } = useHrAccess()
  const { data } = useQuery({ queryKey: ['hr-payroll', id], queryFn: () => api.get<Detail>(`/hr/payroll/runs/${id}`) })
  const act = useMutation({
    mutationFn: (what: 'recalculate' | 'approve' | 'reopen' | 'lock' | 'delete') =>
      what === 'delete' ? api.delete(`/hr/payroll/runs/${id}`)
      : api.post(`/hr/payroll/runs/${id}/${what}`, {}),
    onSuccess: (_r, what) => { setErr(''); if (what === 'delete') router.push('/hr/payroll'); else void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const run = data?.run
  const t = (run?.totals ?? {}) as Record<string, number>
  const warnings = (run?.totals?.['warnings'] as string[] | undefined) ?? []
  const payment = run?.totals?.['payment'] as RunPayment | undefined
  const dl = (kind: string) => { setErr(''); api.download(`/hr/payroll/runs/${id}/export.csv?kind=${kind}`, `payroll-${run?.period}-${kind}.csv`).catch((e: Error) => setErr(e.message)) }
  // The API's rules: only admin, owner or management approve, reopen and lock,
  // and nobody approves a payroll they created, recalculated or edited — the
  // CEO (admin) excepted.
  const prepared = !!run && !!userId && (run.createdById === userId || (run.preparedByIds ?? []).includes(userId))
  const canApprove = isPayrollApprover && (!prepared || role === 'admin')

  return (
    <HrShell title={run ? `Payroll ${run.period}` : 'Payroll'}
      actions={run && <span className="text-xs font-black uppercase tracking-wider self-center" style={{ color: STATUS_COLOR[run.status] ?? '#a15c00' }}>{human(run.status)}</span>}>
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
            <div className="rounded-xl p-3 text-sm" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)' }}>
              {warnings.map((w) => <p key={w} className="text-amber-700">⚠ {w}</p>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {run.status === 'draft' && <>
              <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate('recalculate')}>Recalculate from records</button>
              {canApprove && <button className={btn} disabled={act.isPending} onClick={() => act.mutate('approve')}>Approve</button>}
              <button className="text-xs text-white/35 hover:text-red-700 ml-2" onClick={() => { if (confirm('Delete this draft payroll?')) act.mutate('delete') }}>Delete draft</button>
            </>}
            {run.status === 'approved' && isPayrollApprover && <>
              <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate('reopen')}>Reopen</button>
              <button className={btn} disabled={act.isPending} onClick={() => { if (confirm('Lock payroll? It cannot be changed afterwards, and it is posted to the books.')) act.mutate('lock') }}>Lock</button>
            </>}
            {run.status === 'locked' && !run.paidAt && isPayrollApprover && (
              <button className={btn} onClick={() => { setErr(''); setPaying(true) }}>Mark paid</button>
            )}
            {run.paidAt && (
              <span className="text-xs text-success font-bold self-center">
                Paid {day(payment?.paidOn ?? run.paidAt)}{payment ? ` — ${splitLine(payment.bank.cents, payment.bank.staff, payment.cash.cents, payment.cash.staff)}` : ''}
              </span>
            )}
            <span className="ml-auto flex flex-wrap gap-2">
              <button className={btnGhost} onClick={() => dl('register')}>Payroll register</button>
              <button className={btnGhost} onClick={() => dl('bank')}>Bank transfer sheet</button>
              <button className={btnGhost} onClick={() => dl('eobi')}>EOBI report</button>
              <button className={btnGhost} onClick={() => dl('deductions')}>Deduction report</button>
            </span>
          </div>
          {err && <p className="text-xs text-red-700">{err}</p>}
          {run.status === 'draft' && <p className="text-[11px] text-white/40">Approval must come from someone other than whoever created, recalculated or edited it (the CEO excepted){isPayrollApprover ? '' : ', and from the CEO, a co-owner or management'}.</p>}

          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {['Employee', 'Gross', 'Earnings', 'Deductions', 'EOBI (1%)', 'Net', ''].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
              </tr></thead>
              <tbody>
                {data!.payslips.map((s) => {
                  const w = (s.inputs['warnings'] as string[] | undefined) ?? []
                  return (
                    <tr key={s.id} className="border-t border-white/[0.05]">
                      <td className="px-4 py-3"><p className="font-bold text-white/85">{s.employee.fullName}</p><p className="text-[11px] text-white/40">{s.employee.employeeCode}{s.inputs['edited'] ? ' · edited' : ''}</p></td>
                      <td className="px-4 py-3 text-white/70">{rs(s.grossCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.earningsCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.deductionsCents)}</td>
                      <td className="px-4 py-3 text-white/70">{rs(s.eobiEmployeeCents)}</td>
                      <td className="px-4 py-3 font-black" style={{ color: s.netCents < 0 ? '#b42318' : 'rgb(var(--fg-rgb) / 0.9)' }}>{rs(s.netCents)}{w.length > 0 && <span className="ml-1 text-amber-700" title={w.join('\n')}>⚠</span>}</td>
                      <td className="px-4 py-3 text-right"><button className="text-xs font-bold text-primary-ink" onClick={() => setEditing(s)}>{run.status === 'draft' ? 'Payslip / edit' : 'Payslip'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && run && <SlipModal slip={editing} period={run.period} draft={run.status === 'draft'} onClose={() => setEditing(null)} />}
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
  const cash = slips.filter(isCashSlip)
  const bank = slips.filter((s) => !isCashSlip(s))
  const sum = (xs: Slip[]) => xs.reduce((a, s) => a + Math.max(0, s.netCents), 0)
  const pay = useMutation({
    mutationFn: () => api.post(`/hr/payroll/runs/${runId}/paid`, {
      ...(bank.length > 0 && bankAccountId && { bankAccountId }),
      cashCode, paidOn,
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
        <p className="text-[11px] text-white/40">Clears Wages Payable for this month, dated the day the money left. A closed month is refused.</p>
        {err && <p className="text-xs text-red-700">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={btn} disabled={pay.isPending || !paidOn} onClick={() => pay.mutate()}>{pay.isPending ? 'Saving…' : 'Confirm payment'}</button>
          <button className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

function SlipModal({ slip, period, draft, onClose }: { slip: Slip; period: string; draft: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [vals, setVals] = useState<Record<string, number>>(Object.fromEntries(INPUTS.map(([k]) => [k, Number(slip.inputs[k] ?? 0)])))
  const [err, setErr] = useState('')
  // Only what was changed: new OT hours are priced at the OT rate unless the
  // amount was changed too, and an untouched loan total keeps its split.
  const save = useMutation({
    mutationFn: () => api.patch(`/hr/payroll/payslips/${slip.id}`, Object.fromEntries(Object.entries(vals).filter(([k, v]) => v !== Number(slip.inputs[k] ?? 0)))),
    onSuccess: () => { void qc.invalidateQueries(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const print = () => {
    const row = (l: Line) => `<tr><td>${l.label}</td><td style="text-align:right">${rs(l.amountCents)}</td></tr>`
    const html = `<h2>Payslip — ${period}</h2><p><strong>${slip.employee.fullName}</strong> (${slip.employee.employeeCode})</p>
      <h4>Earnings</h4><table>${slip.lines.filter((l) => l.kind === 'earning').map(row).join('')}</table>
      <h4>Deductions</h4><table>${slip.lines.filter((l) => l.kind === 'deduction').map(row).join('')}</table>
      <p><strong>Net pay: ${rs(slip.netCents)}</strong></p>
      <p style="font-size:12px;color:#666">Employer contributions: ${slip.lines.filter((l) => l.kind === 'employer').map((l) => `${l.label} ${rs(l.amountCents)}`).join(', ') || 'none'}</p>`
    const w = window.open('', '_blank'); if (!w) return
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title><style>body{font-family:system-ui;max-width:600px;margin:40px auto;color:#111}table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid #eee}</style></head><body>${html.replace(/<(?!\/?(h2|h4|p|strong|table|tr|td)\b)/g, '&lt;')}</body></html>`)
    w.document.close(); setTimeout(() => w.print(), 300)
  }
  return (
    <Modal title={`${slip.employee.fullName} — ${period}`} wide onClose={onClose}>
      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Payslip</p>
          {slip.lines.map((l) => (
            <div key={l.code + l.label} className="flex justify-between text-sm py-1 border-b border-white/[0.04]">
              <span style={{ color: l.kind === 'deduction' ? '#b42318' : l.kind === 'employer' ? 'rgb(var(--fg-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.8)' }}>{l.label}</span>
              <span className="text-white/85">{l.kind === 'deduction' ? '−' : ''}{rs(l.amountCents)}</span>
            </div>
          ))}
          <div className="flex justify-between text-base font-black pt-2"><span className="text-white/85">Net</span><span className="text-primary-ink">{rs(slip.netCents)}</span></div>
          <button className={`${btnGhost} mt-3`} onClick={print}>Print payslip</button>
        </div>
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Inputs {draft ? '(editable)' : ''}</p>
          <div className="grid grid-cols-2 gap-2">
            {INPUTS.map(([k, label, money]) => (
              <label key={k} className="text-[11px] text-white/50">{label}
                <input type="number" step="any" min={0} disabled={!draft} className={`${inp} mt-1`}
                  value={money ? vals[k]! / 100 : vals[k]}
                  onChange={(e) => setVals({ ...vals, [k]: money ? Math.round(Number(e.target.value) * 100) : Number(e.target.value) })} />
              </label>
            ))}
          </div>
          {err && <p className="text-xs text-red-700 mt-2">{err}</p>}
          {draft && <button className={`${btn} mt-3`} disabled={save.isPending} onClick={() => save.mutate()}>Recalculate this payslip</button>}
          <p className="text-[10px] text-white/35 mt-2">Changing the OT hours prices the OT amount at the employee&rsquo;s OT rate; change the amount too to set it by hand. Prefilled from attendance, approved leave, overtime, adjustments and loans. “Recalculate from records” on the run replaces any edits.</p>
        </div>
      </div>
    </Modal>
  )
}
