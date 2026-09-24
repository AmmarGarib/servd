'use client'
// Organization setup — spec §2. Departments and branches are shared with the
// rest of servd (branches are the company's locations); business units,
// sub-departments, designations, grades and cost centres are HR's own lists and
// feed every "pick one" field in the HR formats.

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btn, human, type OrgData } from '../../../lib/hr'
import { HrShell, useHrOrg } from '../../../components/hr/HrShell'

type Unit = OrgData['units'][number]

export default function HrOrgPage() {
  const { data: org, error } = useHrOrg()
  return (
    <HrShell title="Organization setup" subtitle="The lists every HR form picks from. Deactivating an entry hides it from new forms; past records keep it.">
      {error && <p className="text-sm text-red-400 mb-4">{(error as Error).message}</p>}
      {org && (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <DepartmentsPanel departments={org.departments} />
          <div className="rounded-2xl p-5" style={card}>
            <p className="text-sm font-black text-white/85">Branches</p>
            <p className="text-[11px] text-white/40 mt-0.5 mb-3">These are the company&apos;s locations. Add or edit them under <Link href="/configuration/locations" className="underline">Configuration → Locations</Link>.</p>
            {org.locations.length === 0 && <p className="text-xs text-white/40">No locations yet.</p>}
            <ul className="space-y-1">{org.locations.map((l) => <li key={l.id} className="text-sm text-white/75">{l.name}</li>)}</ul>
          </div>
          {org.kinds.map((k) => <UnitsPanel key={k} kind={k} units={org.units.filter((u) => u.kind === k)} />)}
        </div>
      )}
    </HrShell>
  )
}

function DepartmentsPanel({ departments }: { departments: OrgData['departments'] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: () => api.post('/hr/org/departments', { name }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['hr-org'] }) },
  })
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/85">Departments</p>
      <p className="text-[11px] text-white/40 mt-0.5 mb-3">Shared with the rest of servd.</p>
      <ul className="space-y-1 mb-3">{departments.map((d) => <li key={d.id} className="text-sm text-white/75">{d.name}</li>)}</ul>
      <AddRow value={name} onChange={setName} onAdd={() => add.mutate()} busy={add.isPending} placeholder="New department" />
      {add.error && <p className="text-xs text-red-400 mt-1">{(add.error as Error).message}</p>}
    </div>
  )
}

const KIND_TITLE: Record<string, string> = {
  business_unit: 'Business units', sub_department: 'Sub-departments', designation: 'Designations', grade: 'Grades', cost_center: 'Cost centres',
}

function UnitsPanel({ kind, units }: { kind: string; units: Unit[] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hr-org'] })
  const add = useMutation({
    mutationFn: () => api.post('/hr/org/units', { kind, name, ...(code && { code }) }),
    onSuccess: () => { setName(''); setCode(''); refresh() },
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/hr/org/units/${id}`, body),
    onSuccess: refresh,
  })
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/85 mb-3">{KIND_TITLE[kind] ?? human(kind)}</p>
      {units.length === 0 && <p className="text-xs text-white/40 mb-3">None yet.</p>}
      <ul className="space-y-1 mb-3">
        {units.map((u) => (
          <UnitRow key={u.id} u={u}
            onRename={(n) => patch.mutate({ id: u.id, body: { name: n } })}
            onToggle={() => patch.mutate({ id: u.id, body: { isActive: !u.isActive } })} />
        ))}
      </ul>
      <div className="flex gap-2">
        <input className={inp} placeholder={`New ${(KIND_TITLE[kind] ?? human(kind)).toLowerCase().replace(/s$/, '')}`} value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${inp} max-w-[90px]`} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className={btn} disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>Add</button>
      </div>
      {(add.error || patch.error) && <p className="text-xs text-red-400 mt-1">{((add.error || patch.error) as Error).message}</p>}
    </div>
  )
}

function UnitRow({ u, onRename, onToggle }: { u: Unit; onRename: (name: string) => void; onToggle: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(u.name)
  return (
    <li className="flex items-center gap-2 text-sm">
      {editing ? (
        <>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onRename(name.trim()); setEditing(false) } }} />
          <button className="text-xs text-kds-green font-bold" disabled={!name.trim()} onClick={() => { onRename(name.trim()); setEditing(false) }}>Save</button>
        </>
      ) : (
        <>
          <span className={`flex-1 ${u.isActive ? 'text-white/80' : 'text-white/30 line-through'}`}>{u.name}{u.code && <span className="text-white/35"> · {u.code}</span>}</span>
          <button className="text-[11px] text-white/40 hover:text-white" onClick={() => { setName(u.name); setEditing(true) }}>Rename</button>
          <button className="text-[11px] text-white/40 hover:text-white" onClick={onToggle}>{u.isActive ? 'Deactivate' : 'Reactivate'}</button>
        </>
      )}
    </li>
  )
}

function AddRow({ value, onChange, onAdd, busy, placeholder }: { value: string; onChange: (v: string) => void; onAdd: () => void; busy: boolean; placeholder: string }) {
  return (
    <div className="flex gap-2">
      <input className={inp} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onAdd() }} />
      <button className={btn} disabled={!value.trim() || busy} onClick={onAdd}>Add</button>
    </div>
  )
}
