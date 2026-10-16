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
import { useHeadOfficeMe } from '../../../hooks/useWorkspaces'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type Unit = OrgData['units'][number]

export default function HrOrgPage() {
  const { data: org, error, isLoading } = useHrOrg()
  return (
    <HrShell title="Organization setup" subtitle="The lists every HR form picks from. Deactivating an entry hides it from new forms; past records keep it.">
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-white/40" role="status">Loading…</p>}
      {org && (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <DepartmentsPanel departments={org.departments} archived={org.archivedDepartments ?? []} />
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

function DepartmentsPanel({ departments, archived }: { departments: OrgData['departments']; archived: NonNullable<OrgData['archivedDepartments']> }) {
  const qc = useQueryClient()
  const { headOfficeSetupApplied } = useHeadOfficeMe()
  const [name, setName] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hr-org'] })
  const add = useMutation({
    mutationFn: () => api.post('/hr/org/departments', { name }),
    onSuccess: () => { setName(''); refresh() },
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/hr/org/departments/${id}`, body),
    onSuccess: refresh,
  })
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/85">Departments</p>
      <p className="text-[11px] text-white/40 mt-0.5 mb-3">
        The one list of departments in servd — Workforce → Positions and every HR form read it. The name also picks the wages account payroll posts to.
      </p>
      <ul className="space-y-1 mb-3">
        {departments.map((d) => (
          <DepartmentRow key={d.id} d={d}
            onRename={(n) => patch.mutate({ id: d.id, body: { name: n } })}
            setupApplied={headOfficeSetupApplied}
            onHeadOffice={() => patch.mutate({ id: d.id, body: { isHeadOffice: !d.isHeadOffice } })}
            onArchive={() => patch.mutate({ id: d.id, body: { archived: true } })} />
        ))}
      </ul>
      <AddRow value={name} onChange={setName} onAdd={() => add.mutate()} busy={add.isPending} placeholder="New department" />
      {(add.error || patch.error) && <p className="text-xs text-s-red mt-1">{((add.error || patch.error) as Error).message}</p>}
      {archived.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/35 mb-1">Archived</p>
          <ul className="space-y-1">
            {archived.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-white/35 line-through">{d.name}</span>
                <button className={SMALL_BTN} onClick={() => patch.mutate({ id: d.id, body: { archived: false } })}>Bring back</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const SMALL_BTN = 'text-[11px] text-white/50 hover:text-white px-1.5 py-1.5 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-3'

function DepartmentRow({ d, onRename, onHeadOffice, onArchive, setupApplied = false }: { d: OrgData['departments'][number]; onRename: (name: string) => void; onHeadOffice: () => void; onArchive: () => void; setupApplied?: boolean }) {
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(d.name)
  const archive = async () => {
    const ok = await confirm({ title: `Archive "${d.name}"?`, body: 'It is hidden from new forms and positions; past records keep it. You can bring it back.', confirmLabel: 'Archive', danger: true })
    if (ok) onArchive()
  }
  return (
    <li className="flex items-center gap-2 text-sm">
      {editing ? (
        <>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) { onRename(name.trim()); setEditing(false) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setName(d.name); setEditing(false) }
            }} />
          <button className="text-xs text-primary-ink font-bold px-2 py-2 [@media(pointer:coarse)]:min-h-[44px]" disabled={!name.trim()} onClick={() => { onRename(name.trim()); setEditing(false) }}>Save</button>
          <button className={SMALL_BTN} onClick={() => { setName(d.name); setEditing(false) }}>Cancel</button>
        </>
      ) : (
        <>
          <span className="flex-1 text-white/80">{d.name}{d.isHeadOffice && !setupApplied && <span className="text-[10px] font-bold text-s-amber ml-2">HEAD OFFICE</span>}</span>
          <button className={SMALL_BTN} onClick={() => { setName(d.name); setEditing(true) }}>Rename</button>
          {!setupApplied && <button className={SMALL_BTN} onClick={onHeadOffice}>{d.isHeadOffice ? 'Not head office' : 'Head office'}</button>}
          <button className={SMALL_BTN} onClick={() => void archive()}>Archive</button>
        </>
      )}
    </li>
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
      {(add.error || patch.error) && <p className="text-xs text-s-red mt-1">{((add.error || patch.error) as Error).message}</p>}
    </div>
  )
}

function UnitRow({ u, onRename, onToggle }: { u: Unit; onRename: (name: string) => void; onToggle: () => void }) {
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(u.name)
  const toggle = async () => {
    if (u.isActive) {
      const ok = await confirm({ title: `Deactivate "${u.name}"?`, body: 'It is hidden from new forms; past records keep it. You can reactivate it.', confirmLabel: 'Deactivate', danger: true })
      if (!ok) return
    }
    onToggle()
  }
  return (
    <li className="flex items-center gap-2 text-sm">
      {editing ? (
        <>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) { onRename(name.trim()); setEditing(false) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setName(u.name); setEditing(false) }
            }} />
          <button className="text-xs text-primary-ink font-bold px-2 py-2 [@media(pointer:coarse)]:min-h-[44px]" disabled={!name.trim()} onClick={() => { onRename(name.trim()); setEditing(false) }}>Save</button>
          <button className={SMALL_BTN} onClick={() => { setName(u.name); setEditing(false) }}>Cancel</button>
        </>
      ) : (
        <>
          <span className={`flex-1 ${u.isActive ? 'text-white/80' : 'text-white/30 line-through'}`}>{u.name}{u.code && <span className="text-white/35"> · {u.code}</span>}</span>
          <button className={SMALL_BTN} onClick={() => { setName(u.name); setEditing(true) }}>Rename</button>
          <button className={SMALL_BTN} onClick={() => void toggle()}>{u.isActive ? 'Deactivate' : 'Reactivate'}</button>
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
