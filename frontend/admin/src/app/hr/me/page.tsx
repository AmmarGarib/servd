'use client'
// Employee self-service — spec §28. Your profile, leave balance, payslips, and
// requests. Everything here is about you only; the server fills in who.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, btn, btnGhost, rs, day, human, withLeaveDays, leaveFields, STATUS_COLOR, type HrFormat, type HrRecord } from '../../../lib/hr'
import { HrShell, Modal, Stat, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { FormRenderer } from '../../../components/hr/FormRenderer'

interface Me {
  tenantId: string
  profile: Record<string, string | null>
  leaveBalances: Array<{ leaveTypeId: string; name: string; paid: boolean; balance: number; taken: number; pending: number; entitlement: number }>
  records: HrRecord[]
  payslips: Array<{ id: string; period: string; netCents: number }>
  loans: Array<{ id: string; type: string | null; amountCents: number; outstandingCents: number }>
  canRequest: string[]
}

const REQUEST_LABEL: Record<string, string> = {
  leave: 'Apply for leave', overtime: 'Submit overtime', attendance_correction: 'Correct attendance',
  training_request: 'Request training', loan: 'Request an advance or loan', resignation: 'Resign',
}

export default function MyHrPage() {
  const { data: me, error } = useQuery({ queryKey: ['hr-me'], queryFn: () => api.get<Me>('/hr/me'), retry: false })
  const [requesting, setRequesting] = useState<string | null>(null)
  const [slipId, setSlipId] = useState<string | null>(null)
  if (error) {
    return <HrShell title="My HR"><div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/70">{(error as Error).message}</p></div></HrShell>
  }
  const p = me?.profile
  return (
    <HrShell title="My HR" subtitle={p ? `${p['fullName']} · ${p['employeeCode']} · ${p['designation'] ?? ''}` : undefined}>
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
              {me.canRequest.map((s) => <button key={s} className={s === 'resignation' ? btnGhost : btn} onClick={() => setRequesting(s)}>{REQUEST_LABEL[s] ?? human(s)}</button>)}
            </div>
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">Leave balance</p>
              {me.leaveBalances.length === 0 && <p className="text-xs text-white/40">No leave types set up yet.</p>}
              {me.leaveBalances.map((b) => (
                <div key={b.leaveTypeId} className="flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0">
                  <span className="text-white/75">{b.name}</span>
                  <span className="font-bold text-white/90">{b.paid ? `${b.balance} left` : `${b.taken} taken`}{b.pending ? <span className="text-[11px] text-amber-700"> ({b.pending} pending)</span> : null}</span>
                </div>
              ))}
            </div>
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">Payslips</p>
              {me.payslips.length === 0 && <p className="text-xs text-white/40">None yet — they appear once a month&rsquo;s payroll is locked.</p>}
              {me.payslips.map((s) => (
                <button key={s.id} onClick={() => setSlipId(s.id)} className="w-full flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0 hover:text-white">
                  <span className="text-white/75">{s.period}</span><span className="font-bold text-white/90">{rs(s.netCents)}</span>
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
      {requesting && me && <RequestForm section={requesting} tenantId={me.tenantId} onClose={() => setRequesting(null)} />}
      {slipId && <MySlip id={slipId} onClose={() => setSlipId(null)} />}
    </HrShell>
  )
}

function RequestForm({ section, tenantId, onClose }: { section: string; tenantId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: fmt } = useQuery({ queryKey: ['hr-me-form', section], queryFn: () => api.get<HrFormat>(`/hr/me/forms/${section}`) })
  // The request is filed in the employee's own company, so its leave types
  // and people come from there — not from whichever company the login has open.
  const { data: lookups } = useHrLookups(tenantId)
  const { data: org } = useHrOrg(tenantId)
  const [value, setValue] = useState<Record<string, unknown>>({})
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/hr/me/records/${section}`, { data: value }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr-me'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={REQUEST_LABEL[section] ?? human(section)} wide onClose={onClose}>
      {fmt ? <FormRenderer fields={leaveFields(section, fmt.fields, value)} value={value}
        onChange={(x) => setValue(withLeaveDays(section, fmt.fields, value, x))} ctx={{ lookups, org }} /> : <p className="text-sm text-white/40">Loading…</p>}
      {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button className={btn} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Sending…' : 'Submit'}</button>
        <button className={btnGhost} onClick={onClose}>Cancel</button>
      </div>
      {fmt && fmt.workflow.length > 0 && <p className="text-[11px] text-white/40 mt-3">Goes to: {fmt.workflow.map((w) => w.label).join(' → ')}</p>}
    </Modal>
  )
}

function MySlip({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: s } = useQuery({ queryKey: ['hr-my-slip', id], queryFn: () => api.get<{ run: { period: string }; lines: Array<{ kind: string; label: string; amountCents: number }>; netCents: number }>(`/hr/me/payslips/${id}`) })
  return (
    <Modal title={s ? `Payslip ${s.run.period}` : 'Payslip'} onClose={onClose}>
      {s?.lines.filter((l) => l.kind !== 'employer').map((l) => (
        <div key={l.label} className="flex justify-between text-sm py-1 border-b border-white/[0.04]">
          <span style={{ color: l.kind === 'deduction' ? '#b42318' : 'rgb(var(--fg-rgb) / 0.8)' }}>{l.label}</span>
          <span className="text-white/85">{l.kind === 'deduction' ? '−' : ''}{rs(l.amountCents)}</span>
        </div>
      ))}
      {s && <div className="flex justify-between font-black pt-2"><span className="text-white/85">Net pay</span><span className="text-primary-ink">{rs(s.netCents)}</span></div>}
    </Modal>
  )
}
