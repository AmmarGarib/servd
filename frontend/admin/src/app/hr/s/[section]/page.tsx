'use client'
// Any HR record section — leave, overtime, candidates, promotions, loans, …
// The list, the "new" form and the detail all come from the section's format,
// so a format saved by HR changes this page with no code change.

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card, btn, btnGhost, displayValue, human, STATUS_COLOR, type HrFormat, type HrRecord } from '../../../../lib/hr'
import { HrShell, Modal, useHrLookups, useHrOrg, useHrSections } from '../../../../components/hr/HrShell'
import { FormRenderer } from '../../../../components/hr/FormRenderer'
import { RecordDetail } from '../../../../components/hr/RecordDetail'

export default function HrSectionPage() {
  const { section } = useParams<{ section: string }>()
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const { data: sections } = useHrSections()
  const info = sections?.find((s) => s.key === section)
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const { data, error } = useQuery({
    queryKey: ['hr-records', section, status, stageFilter],
    queryFn: () => api.get<{ format: HrFormat; records: HrRecord[] }>(`/hr/records/${section}?${new URLSearchParams({ ...(status && { status }), ...(stageFilter && { stage: stageFilter }) })}`),
  })
  const fmt = data?.format
  const open = data?.records.find((r) => r.id === openId) ?? null
  // Show the first few meaningful columns of the format in the list.
  const cols = (fmt?.fields ?? []).filter((f) => f.bind !== 'employeeId' && !['table', 'textarea', 'file'].includes(f.type)).slice(0, 4)
  const lk = { employees: lookups?.employees, records: lookups?.records, org }

  return (
    <HrShell
      title={info?.title ?? human(section)}
      subtitle={[info ? `Spec §${info.specNo}.` : '', info?.effect ?? ''].filter(Boolean).join(' ')}
      actions={<>
        <button className={btnGhost} onClick={() => { void api.download(`/hr/records/${section}/export.csv`, `hr-${section}.csv`) }}>Export CSV</button>
        <Link href={`/hr/formats/${section}`} className={btnGhost}>Edit format</Link>
        <button className={btn} onClick={() => setCreating(true)}>+ New</button>
      </>}
    >
      {error && <p className="text-sm text-red-400 mb-4">{(error as Error).message}</p>}
      <div className="flex flex-wrap gap-2 mb-4">
        {['', 'draft', 'submitted', 'approved', 'rejected', 'cancelled'].map((s) => (
          <button key={s || 'all'} onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-bold border ${status === s ? 'bg-kds-green text-black border-kds-green' : 'border-white/10 text-white/50'}`}>
            {s ? human(s) : 'All'}
          </button>
        ))}
        {fmt && fmt.stages.length > 0 && (
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="rounded-full px-3 py-1 text-xs bg-white/[0.04] border border-white/10 text-white/70">
            <option value="">All stages</option>
            {fmt.stages.map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        )}
        {fmt && !fmt.isDefault && <span className="ml-auto text-[11px] text-kds-green self-center">Using HR format v{fmt.version}</span>}
      </div>

      {data && data.records.length === 0 && (
        <div className="rounded-2xl p-10 text-center" style={card}>
          <p className="font-bold text-white/85">Nothing here yet</p>
          <p className="text-sm text-white/45 mt-1">Add the first one with “+ New”.</p>
        </div>
      )}
      {data && data.records.length > 0 && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {fmt?.fields.some((f) => f.bind === 'employeeId') && <th className="px-4 py-3 font-bold">Employee</th>}
                {cols.map((c) => <th key={c.key} className="px-4 py-3 font-bold">{c.label}</th>)}
                {fmt && fmt.stages.length > 0 && <th className="px-4 py-3 font-bold">Stage</th>}
                <th className="px-4 py-3 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className="border-t border-white/[0.05] cursor-pointer hover:bg-white/[0.03]">
                  {fmt?.fields.some((f) => f.bind === 'employeeId') && <td className="px-4 py-3 text-white/85 font-bold">{r.employee?.fullName ?? '—'}</td>}
                  {cols.map((c) => <td key={c.key} className="px-4 py-3 text-white/70">{displayValue(c, r.data[c.key], lk)}</td>)}
                  {fmt && fmt.stages.length > 0 && <td className="px-4 py-3 text-white/60">{human(r.stage)}</td>}
                  <td className="px-4 py-3"><span className="text-xs font-bold" style={{ color: STATUS_COLOR[r.status] }}>{human(r.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && fmt && (
        <NewRecord section={section} format={fmt} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void qc.invalidateQueries() }} />
      )}
      {open && fmt && (
        <Modal title={open.label ?? info?.title ?? 'Record'} wide onClose={() => setOpenId(null)}>
          <RecordDetail record={open} format={fmt} lookups={lookups} org={org} admin onChanged={() => { void qc.invalidateQueries({ queryKey: ['hr-records', section] }) }} />
        </Modal>
      )}
    </HrShell>
  )
}

function NewRecord({ section, format, onClose, onSaved }: { section: string; format: HrFormat; onClose: () => void; onSaved: () => void }) {
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const [value, setValue] = useState<Record<string, unknown>>({})
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: (submit: boolean) => api.post(`/hr/records/${section}`, { data: value, submit }),
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  })
  const hasWorkflow = format.workflow.length > 0
  return (
    <Modal title={`New — ${format.title}`} wide onClose={onClose}>
      <FormRenderer fields={format.fields} value={value} onChange={setValue} ctx={{ lookups, org }} />
      {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button className={btn} disabled={save.isPending} onClick={() => save.mutate(true)}>{hasWorkflow ? 'Submit for approval' : 'Save'}</button>
        {hasWorkflow && <button className={btnGhost} disabled={save.isPending} onClick={() => save.mutate(false)}>Save as draft</button>}
        <button className={btnGhost} onClick={onClose}>Cancel</button>
      </div>
      {hasWorkflow && <p className="text-[11px] text-white/40 mt-3">Approval: {format.workflow.map((w) => w.label).join(' → ')}</p>}
    </Modal>
  )
}
