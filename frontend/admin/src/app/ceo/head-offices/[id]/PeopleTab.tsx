'use client'
// Head office → People: the head office's employees, and the "Move people to
// head office" tool (preview, then apply) — POST /hr/head-office-transfers.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Select } from '../../../../components/ui/Select'
import { fmtPkr } from '../../../../lib/money'
import {
  headOfficeApi, monthLabel, addMonthsTo, currentMonthPkt, monthRange, WARNING_BOX_STYLE,
  type HeadOfficeDetail, type TransferBody, type TransferPreview,
} from '../../../../lib/headOfficeApi'
import { errText } from './CompaniesTab'

export default function PeopleTab({ hoId, detail, reload }: { hoId: string; detail: HeadOfficeDetail; reload: () => void }) {
  const emps = useQuery({ queryKey: ['ho-employees'], queryFn: headOfficeApi.employees })
  const liveIds = useMemo(() => new Set(detail.links.filter((l) => l.live).map((l) => l.companyTenantId)), [detail])
  const nameOf = new Map(detail.links.map((l) => [l.companyTenantId, l.companyName]))
  const hoStaff = (emps.data ?? []).filter((e) => e.tenantId === hoId)
  const candidates = (emps.data ?? []).filter((e) => liveIds.has(e.tenantId))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [month, setMonth] = useState(addMonthsTo(currentMonthPkt(), 1))
  const [keepJoining, setKeepJoining] = useState(true)
  const [keepMem, setKeepMem] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<TransferPreview | null>(null)

  const body = (): TransferBody => ({
    employeeIds: [...picked], headOfficeTenantId: hoId, effectiveDate: `${month}-01`,
    keepJoiningDate: keepJoining, keepCompanyMemberships: [...keepMem],
  })
  const prev = useMutation({ mutationFn: () => headOfficeApi.transferPreview(body()), onSuccess: setPreview, onError: (e) => toast.error(errText(e)) })
  const apply = useMutation({
    mutationFn: () => headOfficeApi.transfer(body()),
    onSuccess: (r) => { toast.success(`${r.moved.length} moved to the head office`); setPreview(null); setPicked(new Set()); void emps.refetch(); reload() },
    onError: (e) => toast.error(errText(e)),
  })
  const toggle = (id: string) => { setPreview(null); setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }) }
  const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-black text-white/85 mb-2">Head office employees</h3>
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="s-table">
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Login</th></tr></thead>
            <tbody>
              {emps.isLoading && <tr><td colSpan={4} className="text-white/45">Loading…</td></tr>}
              {!emps.isLoading && hoStaff.length === 0 && <tr><td colSpan={4} className="text-white/45">No employee is on the head office payroll yet.</td></tr>}
              {hoStaff.map((e) => (
                <tr key={e.id}><td>{e.employeeCode}</td><td className="font-semibold">{e.fullName}</td><td>{e.department ?? '—'}</td><td>{e.userId ? 'Has a login' : 'No login'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl p-4" style={card}>
        <h3 className="text-sm font-black text-white/85">Move people to head office</h3>
        <p className="text-[11px] text-white/45 mb-3">Pick people from the linked companies, choose the first month on the head office payroll and preview. Nothing changes until you apply.</p>
        <div className="max-h-64 overflow-y-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
          {candidates.length === 0 && <p className="p-3 text-xs text-white/45">No current employees in the linked companies.</p>}
          {candidates.map((e) => (
            <label key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm text-white/80 hover:bg-white/[0.04]">
              <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
              <span className="font-semibold">{e.fullName}</span>
              <span className="text-xs text-white/45">{e.employeeCode} · {nameOf.get(e.tenantId) ?? ''}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold text-white/60">On the head office payroll from</span>
          <div className="w-40">
            <Select className="s-select w-full" value={month} onChange={(e) => { setMonth(e.target.value); setPreview(null) }}>
              {monthRange(addMonthsTo(currentMonthPkt(), -1), 14).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-white/70">
            <input type="checkbox" checked={keepJoining} onChange={(e) => { setKeepJoining(e.target.checked); setPreview(null) }} /> Keep joining dates
          </label>
          <button type="button" className="s-btn-secondary text-xs ml-auto" disabled={picked.size === 0 || prev.isPending} onClick={() => prev.mutate()}>
            {prev.isPending ? 'Checking…' : `Preview (${picked.size})`}
          </button>
        </div>

        {preview && (
          <div className="mt-4 space-y-3">
            {preview.warnings.length > 0 && <ul className="rounded-xl p-3 text-xs space-y-1" style={WARNING_BOX_STYLE}>{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {preview.employees.map((e) => (
              <div key={e.employeeId} className="rounded-xl p-3" style={{ border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-white/85">{e.fullName}</span>
                  <span className="text-xs text-white/45">{e.employeeCode} · from {e.fromTenantName}</span>
                  {e.blockers.length === 0 ? <span className="s-badge-green">Can move</span> : <span className="s-badge-red">Blocked</span>}
                </div>
                {e.blockers.map((b) => <p key={b.code} className="text-xs text-red-600 mt-1">{b.message}</p>)}
                {e.warnings.map((w) => <p key={w} className="text-xs text-white/55 mt-1">{w}</p>)}
                <p className="text-[11px] text-white/50 mt-1">
                  Last day in the company {e.lastWorkingDay}
                  {e.department && ` · department ${e.department.name} (${e.department.match})`}
                  {e.designation && ` · ${e.designation.name} (${e.designation.match})`}
                  {e.suggestedAdjustmentCents > 0 && ` · leave carried ${fmtPkr(e.suggestedAdjustmentCents)}`}
                </p>
                {e.login && (
                  <div className="mt-1 text-[11px] text-white/60">
                    {e.login.keepMemberships.length + e.login.removeMemberships.length > 0 && (
                      <p>Also a direct member of {[...e.login.keepMemberships, ...e.login.removeMemberships].map((id) => nameOf.get(id) ?? 'another company').join(', ')}.</p>
                    )}
                    {e.login.removeMemberships.map((id) => (
                      <label key={id} className="flex items-center gap-2 mt-0.5">
                        <input type="checkbox" checked={keepMem.has(id)} onChange={(ev) => { setPreview(null); setKeepMem((s) => { const n = new Set(s); if (ev.target.checked) n.add(id); else n.delete(id); return n }) }} />
                        Keep their access to {nameOf.get(id) ?? 'that company'}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <p className="text-[11px] text-white/45">{preview.suggestedAdjustmentNote}</p>
            <div className="flex justify-end">
              <button type="button" className="s-btn-primary text-xs" disabled={!preview.ok || apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? 'Moving…' : `Move ${preview.employees.length} to ${preview.headOffice.name}`}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
