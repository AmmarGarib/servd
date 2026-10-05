'use client'
// Employee master — spec §3. The add form is the Employee Master format.

import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '../../../lib/api'
import { card, btn, btnGhost, rs, day, human, STATUS_COLOR, type HrField } from '../../../lib/hr'
import { HrShell, Modal, useHrForm, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { FormRenderer } from '../../../components/hr/FormRenderer'

interface Row {
  id: string; employeeCode: string; fullName: string; phone: string | null; status: string; employmentType: string
  joiningDate: string | null; grossSalaryCents: number; department: string | null; designation: string | null; branch: string | null; manager: string | null; userId: string | null
}

export default function EmployeesPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('current')
  const [adding, setAdding] = useState(false)
  const [csvErr, setCsvErr] = useState('')
  const { data: rows = [], error } = useQuery({
    queryKey: ['hr-employees', q, status],
    queryFn: () => api.get<Row[]>(`/hr/employees?${new URLSearchParams({ ...(q && { q }), ...(status && { status }) })}`),
  })
  return (
    <HrShell title="Employees" subtitle="The central HR database. Everyone employed — with or without a servd login."
      actions={<>
        <button className={btnGhost} onClick={() => { setCsvErr(''); api.download('/hr/reports/employees.csv', 'hr-employee-master.csv').catch((e: Error) => setCsvErr(e.message)) }}>Export CSV</button>
        <button className={btn} onClick={() => setAdding(true)}>+ Add employee</button>
      </>}>
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, CNIC, phone"
          className="rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 w-72" aria-label="Search employees" />
        {[['current', 'Current'], ['', 'Everyone'], ['resigned', 'Resigned'], ['terminated', 'Terminated'], ['separated', 'Separated']].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k!)} className={`rounded-full px-3 py-1 text-xs font-bold border ${status === k ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/50'}`}>{l}</button>
        ))}
      </div>
      {error && <p className="text-sm text-red-700 mb-3">{(error as Error).message}</p>}
      {csvErr && <p className="text-sm text-red-700 mb-3">Export failed: {csvErr}</p>}
      <div className="rounded-2xl overflow-x-auto" style={card}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
            {['ID', 'Name', 'Designation', 'Department', 'Branch', 'Type', 'Joined', 'Gross', 'Status'].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-white/[0.05] hover:bg-white/[0.03]">
                <td className="px-4 py-3 text-white/50 font-mono text-xs">{e.employeeCode}</td>
                <td className="px-4 py-3"><Link href={`/hr/employees/${e.id}`} className="font-bold text-white/90 hover:underline">{e.fullName}</Link>{e.userId && <span className="ml-1 text-[10px] text-primary-ink" title="Has a servd login">●</span>}</td>
                <td className="px-4 py-3 text-white/65">{e.designation ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{e.branch ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{human(e.employmentType)}</td>
                <td className="px-4 py-3 text-white/65">{day(e.joiningDate)}</td>
                <td className="px-4 py-3 text-white/80">{rs(e.grossSalaryCents)}</td>
                <td className="px-4 py-3"><span className="text-xs font-bold" style={{ color: STATUS_COLOR[e.status] }}>{human(e.status)}</span></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-white/40">No employees match.</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && <AddEmployee onClose={() => setAdding(false)} />}
    </HrShell>
  )
}

function AddEmployee({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const router = useRouter()
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const { data: form } = useHrForm('employees')
  const fields = form?.current.fields ?? []
  // HR may rename any field's key, so the name and the defaults are found by
  // the column they fill, not by key.
  const [value, setValue] = useState<Record<string, unknown> | null>(null)
  const v = value ?? masterDefaults(fields)
  const nameKey = fields.find((f) => f.bind === 'employee.fullName')?.key
  const named = !!nameKey && typeof v[nameKey] === 'string' && !!(v[nameKey] as string).trim()
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/hr/employees', { data: v }),
    onSuccess: (e) => { void qc.invalidateQueries(); router.push(`/hr/employees/${e.id}`) },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title="Add employee" wide onClose={onClose}>
      {form ? <FormRenderer fields={fields} value={v} onChange={setValue} ctx={{ lookups, org }} /> : <p className="text-sm text-white/40">Loading format…</p>}
      {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button className={btn} disabled={save.isPending || !named} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add employee'}</button>
        <button className={btnGhost} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

const MASTER_DEFAULTS: Record<string, unknown> = { 'employee.status': 'active', 'employee.employmentType': 'probation' }
function masterDefaults(fields: HrField[]): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of fields) if (f.bind && f.bind in MASTER_DEFAULTS) v[f.key] = MASTER_DEFAULTS[f.bind]
  return v
}
