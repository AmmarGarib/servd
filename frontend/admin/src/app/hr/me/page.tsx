'use client'
// Employee self-service — spec §28. Your profile, leave balance, payslips, and
// requests. Everything here is about you only; the server fills in who.

import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { SalaryBreakupView, type SalaryBreakup } from '../../../components/hr/SalaryBreakup'
import { card, btn, btnGhost, rs, day, human, withLeaveDays, leaveFields, STATUS_COLOR, type HrFormat, type HrRecord } from '../../../lib/hr'
import { HrShell, Modal, Stat, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { FormRenderer, validate, focusFirstInvalid } from '../../../components/hr/FormRenderer'
import { useConfirm } from '@/components/ui/ConfirmDialog'

interface Me {
  tenantId: string
  profile: Record<string, string | null>
  leaveBalances: Array<{ leaveTypeId: string; name: string; paid: boolean; balance: number; taken: number; pending: number; entitlement: number }>
  records: HrRecord[]
  payslips: Array<{ id: string; period: string; netCents: number }>
  loans: Array<{ id: string; type: string | null; amountCents: number; outstandingCents: number }>
  canRequest: string[]
  /** The department a head of department raises manpower requisitions for (null = not an HOD). */
  hodDepartment?: string | null
}

const REQUEST_LABEL: Record<string, string> = {
  leave: 'Apply for leave', overtime: 'Submit overtime', attendance_correction: 'Correct attendance',
  shift_swap: 'Swap a shift', training_request: 'Request training', loan: 'Request an advance or loan', resignation: 'Resign',
  requisition: 'Manpower requisition',
}

export default function MyHrPage() {
  const { data: me, error, isLoading } = useQuery({ queryKey: ['hr-me'], queryFn: () => api.get<Me>('/hr/me'), retry: false })
  const [requesting, setRequesting] = useState<string | null>(null)
  const [slipId, setSlipId] = useState<string | null>(null)
  if (error) {
    return <HrShell title="My HR"><div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/70">{(error as Error).message}</p></div></HrShell>
  }
  const p = me?.profile
  return (
    <HrShell title="My HR" subtitle={p ? `${p['fullName']} · ${p['employeeCode']} · ${p['designation'] ?? ''}` : undefined}>
      {isLoading && <p className="text-sm text-white/40" role="status">Loading your HR record…</p>}
      {me && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Department" value={p!['department'] ?? '—'} />
            <Stat label="Branch" value={p!['branch'] ?? '—'} />
            <Stat label="Manager" value={p!['manager'] ?? '—'} />
            <Stat label="Joined" value={day(p!['joiningDate'])} />
          </div>

          <div>
            <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Requests</p>
            <div className="flex flex-wrap gap-2">
              {me.canRequest.filter((s) => s !== 'resignation').map((s) => <button key={s} className={btn} onClick={() => setRequesting(s)}>{REQUEST_LABEL[s] ?? human(s)}</button>)}
            </div>
          </div>

          {me.canRequest.includes('resignation') && (
            <div className="pt-4 border-t border-white/[0.07]">
              <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Leaving the company</p>
              <p className="text-xs text-white/55 mb-2 max-w-lg">Submitting a resignation starts your exit process and goes to your manager and HR. You will be asked to confirm.</p>
              <button className={btnGhost} onClick={() => setRequesting('resignation')}>{REQUEST_LABEL['resignation']}</button>
            </div>
          )}

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">Leave balance</p>
              {me.leaveBalances.length === 0 && <p className="text-xs text-white/40">No leave types set up yet.</p>}
              {me.leaveBalances.map((b) => (
                <div key={b.leaveTypeId} className="flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0">
                  <span className="text-white/75">{b.name}</span>
                  <span className="font-bold text-white/90">{b.paid ? `${b.balance} left` : `${b.taken} taken`}{b.pending ? <span className="text-[11px] text-s-amber"> ({b.pending} pending)</span> : null}</span>
                </div>
              ))}
            </div>
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">Payslips</p>
              {me.payslips.length === 0 && <p className="text-xs text-white/40">None yet — they appear once a month&rsquo;s payroll is locked.</p>}
              {me.payslips.map((s) => (
                <button key={s.id} onClick={() => setSlipId(s.id)} className="w-full flex justify-between text-sm py-2.5 border-t border-white/[0.05] first:border-t-0 hover:text-white">
                  <span className="text-white/75">{s.period}</span><span className="font-bold text-white/90">{rs(s.netCents)} <span aria-hidden="true" className="text-white/40">›</span></span>
                </button>
              ))}
            </div>
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">My requests</p>
              {me.records.length === 0 && <p className="text-xs text-white/40">Nothing yet.</p>}
              {me.records.slice(0, 20).map((r) => (
                <div key={r.id} className="flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0">
                  <span className="text-white/75">{human(r.section)} · {day(r.startDate ?? r.createdAt)}</span>
                  <span className="text-xs font-bold" style={{ color: STATUS_COLOR[r.status] }}>{human(r.status)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {requesting && me && <RequestForm section={requesting} tenantId={me.tenantId} department={me.hodDepartment ?? null} onClose={() => setRequesting(null)} />}
      {slipId && <MySlip id={slipId} onClose={() => setSlipId(null)} />}
    </HrShell>
  )
}

function RequestForm({ section, tenantId, department, onClose }: { section: string; tenantId: string; department: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: fmt } = useQuery({ queryKey: ['hr-me-form', section], queryFn: () => api.get<HrFormat>(`/hr/me/forms/${section}`) })
  // The request is filed in the employee's own company, so its leave types
  // and people come from there — not from whichever company the login has open.
  const { data: lookups } = useHrLookups(tenantId)
  const { data: org } = useHrOrg(tenantId)
  const confirm = useConfirm()
  const [value, setValue] = useState<Record<string, unknown>>({})
  const [err, setErr] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formRef = useRef<HTMLFormElement>(null)
  const save = useMutation({
    mutationFn: () => api.post(`/hr/me/records/${section}`, { data: value }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr-me'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const fields = fmt ? leaveFields(section, fmt.fields, value) : []
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!fmt || save.isPending) return
    const found = validate(fields, value)
    setErrors(found)
    if (Object.keys(found).length > 0) { setErr(''); focusFirstInvalid(formRef.current); return }
    setErr('')
    if (section === 'resignation') {
      const ok = await confirm({ title: 'Submit your resignation?', body: 'This starts your exit process and goes to your manager and HR. You cannot take it back from here.', confirmLabel: 'Submit resignation', cancelLabel: 'Go back', danger: true })
      if (!ok) return
    }
    save.mutate()
  }
  return (
    <Modal title={section === 'requisition' && department ? `Manpower requisition — ${department}` : REQUEST_LABEL[section] ?? human(section)} wide onClose={onClose} dirty={Object.keys(value).length > 0}>
      <form ref={formRef} onSubmit={(ev) => void submit(ev)} noValidate>
        {section === 'requisition' && department && (
          <p className="text-xs text-white/55 mb-3">For your department, {department}. It goes to HR, then management.</p>
        )}
        {fmt ? <FormRenderer fields={fields} value={value} errors={errors}
          onChange={(x) => { const nv = withLeaveDays(section, fmt.fields, value, x); setValue(nv); if (Object.keys(errors).length) setErrors(validate(leaveFields(section, fmt.fields, nv), nv)) }} ctx={{ lookups, org }} /> : <p className="text-sm text-white/40">Loading…</p>}
        <div className="flex flex-wrap items-center gap-2 mt-5">
          <button type="submit" className={btn} disabled={save.isPending || !fmt}>{save.isPending ? 'Sending…' : 'Submit'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
        {err && <p className="text-xs text-s-red mt-3" role="alert">{err}</p>}
        {fmt && fmt.workflow.length > 0 && <p className="text-xs text-white/50 mt-3">Goes to: {fmt.workflow.map((w) => w.label).join(' → ')}</p>}
      </form>
    </Modal>
  )
}

function MySlip({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: s, isLoading, error } = useQuery({ queryKey: ['hr-my-slip', id], queryFn: () => api.get<{ run: { period: string }; lines: Array<{ kind: string; label: string; amountCents: number }>; netCents: number; breakup?: SalaryBreakup }>(`/hr/me/payslips/${id}`) })
  return (
    <Modal title={s ? `Payslip ${s.run.period}` : 'Payslip'} onClose={onClose}>
      {/* Print only the slip: everything else on the page is hidden while printing. */}
      <style>{`@media print { body * { visibility: hidden !important } #hr-my-slip, #hr-my-slip * { visibility: visible !important } #hr-my-slip { position: fixed; left: 0; top: 0; width: 100%; padding: 24px; color: #000 } #hr-my-slip .no-print { display: none !important } }`}</style>
      <div id="hr-my-slip">
        {s && <p className="hidden print:block text-lg font-black mb-3">Payslip {s.run.period}</p>}
        {isLoading && <p className="text-sm text-white/40">Loading payslip…</p>}
        {error && <p className="text-sm text-s-red" role="alert">{(error as Error).message}</p>}
        {s?.breakup ? <SalaryBreakupView breakup={s.breakup} /> : (
          <>
            {s?.lines.filter((l) => l.kind !== 'employer').map((l) => (
              <div key={l.label} className="flex justify-between text-sm py-1 border-b border-white/[0.04]">
                <span style={{ color: l.kind === 'deduction' ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.8)' }}>{l.label}</span>
                <span className="text-white/85">{l.kind === 'deduction' ? '−' : ''}{rs(l.amountCents)}</span>
              </div>
            ))}
            {s && <div className="flex justify-between font-black pt-2"><span className="text-white/85">Net pay</span><span className="text-primary-ink">{rs(s.netCents)}</span></div>}
          </>
        )}
      </div>
      {s && <div className="no-print pt-2"><button type="button" className={btnGhost} onClick={() => window.print()}>Print payslip</button></div>}
    </Modal>
  )
}
