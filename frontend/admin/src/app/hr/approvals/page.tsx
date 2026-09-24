'use client'
// Manager / HOD portal — spec §29. Requests waiting on YOU, and your team.
// Open to every staff login: the server only lists what this person may act on.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, day, human, type HrFormat, type HrRecord, type WorkflowStep } from '../../../lib/hr'
import { HrShell, Modal, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { RecordDetail } from '../../../components/hr/RecordDetail'

type Pending = HrRecord & { sectionTitle: string; step: WorkflowStep; format: HrFormat }
interface Team { me: { id: string; fullName: string } | null; team: Array<{ id: string; fullName: string; employeeCode: string; status: string; employmentType: string; probationEnd: string | null }> }

export default function ApprovalsPage() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<Pending | null>(null)
  const { data: pending = [] } = useQuery({ queryKey: ['hr-approvals'], queryFn: () => api.get<Pending[]>('/hr/approvals'), refetchInterval: 60_000 })
  const { data: team } = useQuery({ queryKey: ['hr-team'], queryFn: () => api.get<Team>('/hr/team') })
  // The request's own company's names — the inbox spans every company.
  const { data: lookups } = useHrLookups(open?.tenantId)
  const { data: org } = useHrOrg(open?.tenantId)
  return (
    <HrShell title="Approvals" subtitle="Leave, overtime, attendance corrections and everything else waiting on you.">
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 rounded-2xl overflow-hidden" style={card}>
          {pending.length === 0 && <p className="p-10 text-center text-sm text-white/40">Nothing is waiting on you.</p>}
          {pending.map((r) => (
            <button key={r.id} onClick={() => setOpen(r)} className="w-full text-left px-4 py-3 border-t border-white/[0.05] first:border-t-0 hover:bg-white/[0.03]">
              <div className="flex items-center gap-3">
                <span className="text-sm font-bold text-white/90">{r.sectionTitle}</span>
                <span className="text-sm text-white/65">{r.employee?.fullName ?? r.label}</span>
                <span className="ml-auto text-[11px] text-amber-400">{r.step.label}</span>
              </div>
              <p className="text-[11px] text-white/40 mt-0.5">{r.label} · raised {day(r.createdAt)}</p>
            </button>
          ))}
        </div>
        <div className="rounded-2xl p-4" style={card}>
          <p className="text-sm font-black text-white/85 mb-3">My team</p>
          {!team?.me && <p className="text-xs text-white/40">Your login isn&rsquo;t linked to an employee record, so no team is shown. HR can link it from the employee&rsquo;s profile.</p>}
          {team?.me && team.team.length === 0 && <p className="text-xs text-white/40">Nobody reports to you.</p>}
          {team?.team.map((m) => (
            <div key={m.id} className="flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0">
              <span className="text-white/80">{m.fullName}</span>
              <span className="text-[11px] text-white/45">{human(m.employmentType)}{m.probationEnd && m.employmentType === 'probation' ? ` · probation to ${day(m.probationEnd)}` : ''}</span>
            </div>
          ))}
        </div>
      </div>
      {open && (
        <Modal title={`${open.sectionTitle} — ${open.employee?.fullName ?? ''}`} wide onClose={() => setOpen(null)}>
          <RecordDetail record={open} format={open.format} lookups={lookups} org={org} admin={false}
            onChanged={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['hr-approvals'] }) }} />
        </Modal>
      )}
    </HrShell>
  )
}
