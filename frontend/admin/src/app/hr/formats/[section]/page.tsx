'use client'
// Format editor — where the HR team's formats go in.
//
// Three ways in: edit fields one by one, paste a plain list of fields (one per
// line), or import JSON. Fields the section's calculations depend on are marked
// and can be relabelled but not removed; the server refuses anything that
// would silently break a calculation, and says why.

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card, btn, btnGhost, inp, human, day, FIELD_TYPES, RECORD_SLOTS, ROLE_LABEL, type HrField, type HrFormat, type WorkflowStep } from '../../../../lib/hr'
import { HrShell, Modal, useHrOrg } from '../../../../components/hr/HrShell'
import { FormRenderer } from '../../../../components/hr/FormRenderer'

interface FormInfo {
  section: { key: string; title: string; requires: string[]; effect: string | null }
  current: HrFormat
  default: HrFormat
  versions: Array<{ version: number; isActive: boolean; note: string | null; createdAt: string }>
}

const slug = (s: string) => {
  const parts = s.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean)
  const k = parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase())).join('')
  return /^[a-zA-Z]/.test(k) ? k : `f${k}`
}

/** "Blood group: select(A+, B+) *" → a field. Types default to text. */
function parseQuickLine(line: string): HrField | null {
  let t = line.trim()
  if (!t) return null
  const required = /\*\s*$/.test(t)
  t = t.replace(/\*\s*$/, '').trim()
  const m = t.match(/^(.+?)\s*:\s*([a-z]+)\s*(?:\((.*)\))?\s*$/i)
  const label = (m ? m[1]! : t).trim()
  let type = (m?.[2]?.toLowerCase() ?? 'text') as HrField['type']
  const aliases: Record<string, HrField['type']> = { yesno: 'boolean', checkbox: 'boolean', amount: 'money', rupees: 'money', choice: 'select', choices: 'multiselect', long: 'textarea', paragraph: 'textarea', mobile: 'phone', upload: 'file' }
  type = aliases[type] ?? type
  if (!FIELD_TYPES.includes(type)) type = 'text'
  const f: HrField = { key: slug(label), label, type, ...(required && { required: true }) }
  if ((type === 'select' || type === 'multiselect') && m?.[3]) f.options = m[3].split(',').map((o) => o.trim()).filter(Boolean)
  if ((type === 'orgunit' || type === 'record') && m?.[3]) f.ref = m[3].trim()
  return f
}

export default function FormatEditorPage() {
  const { section } = useParams<{ section: string }>()
  const qc = useQueryClient()
  const { data: org } = useHrOrg()
  const { data: info } = useQuery({ queryKey: ['hr-form', section], queryFn: () => api.get<FormInfo>(`/hr/forms/${section}`) })
  const [fields, setFields] = useState<HrField[]>([])
  const [workflow, setWorkflow] = useState<WorkflowStep[]>([])
  const [stages, setStages] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [dirty, setDirty] = useState(false)
  const [quick, setQuick] = useState('')
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState(false)

  const load = (f: HrFormat) => { setFields(f.fields); setWorkflow(f.workflow); setStages(f.stages.join(', ')); setDirty(false) }
  useEffect(() => { if (info) load(info.current) }, [info])

  const systemKeys = new Set(info?.default.fields.filter((f) => f.system).map((f) => f.key) ?? [])
  const requiredBinds = new Set(info?.section.requires ?? [])
  const isEmployees = section === 'employees'

  const touch = (next: HrField[]) => { setFields(next); setDirty(true); setOk('') }
  const upd = (i: number, patch: Partial<HrField>) => touch(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const move = (i: number, d: -1 | 1) => { const n = [...fields]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); touch(n) }

  const save = useMutation({
    mutationFn: () => api.put<HrFormat>(`/hr/forms/${section}`, {
      fields, workflow, ...(stages.trim() || info?.current.stages.length ? { stages: stages.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(note.trim() && { note: note.trim() }),
    }),
    onSuccess: (f) => { setErr(''); setOk(`Saved as version ${f.version}.`); setNote(''); void qc.invalidateQueries() },
    onError: (e: Error) => { setErr(e.message); setOk('') },
  })
  const activate = useMutation({
    mutationFn: (version: number) => api.post<HrFormat>(`/hr/forms/${section}/activate`, { version }),
    onSuccess: (f) => { load(f); setOk(version0(f)); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const version0 = (f: HrFormat) => (f.version === 0 ? 'Back on the built-in default.' : `Version ${f.version} is live again.`)

  const addQuick = () => {
    const parsed = quick.split('\n').map(parseQuickLine).filter(Boolean) as HrField[]
    const used = new Set(fields.map((f) => f.key))
    for (const p of parsed) { let k = p.key, n = 2; while (used.has(k)) k = `${p.key}${n++}`; p.key = k; used.add(k) }
    touch([...fields, ...parsed]); setQuick('')
  }
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ section, fields, workflow, stages: stages.split(',').map((s) => s.trim()).filter(Boolean) }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `hr-format-${section}.json`; a.click()
  }

  if (!info) return <HrShell title="Format"><p className="text-sm text-white/40">Loading…</p></HrShell>
  return (
    <HrShell title={`Format — ${info.section.title}`}
      subtitle={`Live: ${info.current.isDefault ? 'built-in default' : `version ${info.current.version}`}. ${info.section.effect ?? ''}`}
      actions={<>
        <button className={btnGhost} onClick={() => setPreview(true)}>Preview</button>
        <button className={btnGhost} onClick={() => setImporting(true)}>Import JSON</button>
        <button className={btnGhost} onClick={exportJson}>Export JSON</button>
        <button className={btn} disabled={save.isPending || !dirty} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save new version'}</button>
      </>}>
      {err && <div className="rounded-xl p-3 mb-4 text-sm text-red-300" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)' }}>{err.split(' · ').map((e) => <p key={e}>• {e}</p>)}</div>}
      {ok && <p className="text-sm text-kds-green mb-4">{ok}</p>}

      <div className="grid xl:grid-cols-[1fr_320px] gap-5">
        <div className="space-y-3">
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {['', 'Label', 'Key', 'Type', 'Req.', 'Options / points to', isEmployees ? 'Saved to' : 'Used by calculations as', 'Group', ''].map((h, i) => <th key={i} className="px-2 py-2 font-bold">{h}</th>)}
              </tr></thead>
              <tbody>
                {fields.map((f, i) => {
                  const sys = systemKeys.has(f.key)
                  const locked = sys || (f.bind && requiredBinds.has(f.bind))
                  return (
                    <tr key={i} className="border-t border-white/[0.05] align-top">
                      <td className="px-1 py-1.5 whitespace-nowrap">
                        <button disabled={i === 0} onClick={() => move(i, -1)} className="text-white/35 hover:text-white disabled:opacity-20 px-1" aria-label="Move up">↑</button>
                        <button disabled={i === fields.length - 1} onClick={() => move(i, 1)} className="text-white/35 hover:text-white disabled:opacity-20 px-1" aria-label="Move down">↓</button>
                      </td>
                      <td className="px-1 py-1.5 min-w-[160px]"><input className={inp} value={f.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Label" /></td>
                      <td className="px-1 py-1.5 min-w-[120px]"><input className={`${inp} font-mono`} value={f.key} disabled={sys} onChange={(e) => upd(i, { key: e.target.value })} aria-label="Key" /></td>
                      <td className="px-1 py-1.5">
                        {/* An org-list field must say which list; it starts on the first. */}
                        <select className={inp} value={f.type} disabled={sys} aria-label="Type"
                          onChange={(e) => { const type = e.target.value as HrField['type']; upd(i, { type, ...(type === 'orgunit' && !f.ref && org?.kinds[0] && { ref: org.kinds[0] }) }) }}>
                          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1.5 text-center"><input type="checkbox" checked={!!f.required} onChange={(e) => upd(i, { required: e.target.checked })} className="accent-[#00D4B1]" aria-label="Required" /></td>
                      <td className="px-1 py-1.5 min-w-[180px]">
                        {(f.type === 'select' || f.type === 'multiselect') && <OptionsInput options={f.options ?? []} onSet={(options) => upd(i, { options })} />}
                        {f.type === 'orgunit' && (
                          <select className={inp} value={f.ref ?? ''} onChange={(e) => upd(i, { ref: e.target.value || undefined })} aria-label="Org list">
                            {!f.ref && <option value="">Choose a list…</option>}
                            {(org?.kinds ?? []).map((k) => <option key={k} value={k}>{human(k)}</option>)}
                          </select>
                        )}
                        {f.type === 'record' && <input className={inp} placeholder="section key, e.g. leave_type" value={f.ref ?? ''} onChange={(e) => upd(i, { ref: e.target.value })} aria-label="Points to section" />}
                        {f.type === 'table' && <span className="text-white/40">{f.columns?.length ?? 0} columns (edit in JSON)</span>}
                      </td>
                      <td className="px-1 py-1.5 min-w-[140px]">
                        {isEmployees ? (
                          <span className="text-white/45">{f.bind ? f.bind.replace('employee.', 'column ') : 'extra details'}</span>
                        ) : (
                          <select className={inp} value={f.bind ?? ''} disabled={!!locked} onChange={(e) => upd(i, { bind: e.target.value || undefined })} aria-label="Binding">
                            <option value="">— not used —</option>
                            {RECORD_SLOTS.map((s) => <option key={s} value={s}>{s}{requiredBinds.has(s) ? ' (required)' : ''}</option>)}
                          </select>
                        )}
                        {sys && <p className="text-[10px] text-amber-400 mt-0.5">used by calculations</p>}
                      </td>
                      <td className="px-1 py-1.5 min-w-[110px]"><input className={inp} value={f.group ?? ''} onChange={(e) => upd(i, { group: e.target.value || undefined })} aria-label="Group" /></td>
                      <td className="px-1 py-1.5">
                        <button disabled={!!locked} onClick={() => touch(fields.filter((_, j) => j !== i))} className="text-white/35 hover:text-red-400 disabled:opacity-20 px-1" aria-label="Remove field" title={locked ? 'Needed by calculations — relabel instead' : 'Remove'}>✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <button onClick={() => touch([...fields, { key: `field${fields.length + 1}`, label: 'New field', type: 'text' }])} className="w-full text-left px-3 py-2 text-xs font-bold text-white/50 hover:text-white">+ Add a field</button>
          </div>

          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/85">Paste a field list</p>
            <p className="text-[11px] text-white/45 mt-1 mb-2">One field per line. Add a type after a colon, choices in brackets, and * for required. Examples:<br />
              <code className="text-white/60">Emergency contact</code> · <code className="text-white/60">Date of joining: date *</code> · <code className="text-white/60">Blood group: select(A+, A-, B+, O+)</code> · <code className="text-white/60">Allowance: money</code> · <code className="text-white/60">Has medical: yesno</code></p>
            <textarea className={inp} rows={5} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={'Field one\nField two: date *\nField three: select(a, b, c)'} />
            <button className={`${btnGhost} mt-2`} disabled={!quick.trim()} onClick={addQuick}>Add these fields</button>
          </div>
        </div>

        <div className="space-y-4">
          {!isEmployees && (
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-2">Approval steps</p>
              {workflow.length === 0 && <p className="text-xs text-white/40 mb-2">No approval — entries are final when saved.</p>}
              {workflow.map((w, i) => (
                <div key={i} className="flex gap-1 mb-1.5">
                  <input className={inp} value={w.label} onChange={(e) => { setWorkflow(workflow.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))); setDirty(true) }} aria-label="Step label" />
                  <select className={inp} value={w.role} onChange={(e) => { setWorkflow(workflow.map((x, j) => (j === i ? { ...x, role: e.target.value as WorkflowStep['role'] } : x))); setDirty(true) }} aria-label="Who approves">
                    {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <button onClick={() => { setWorkflow(workflow.filter((_, j) => j !== i)); setDirty(true) }} className="text-white/35 hover:text-red-400 px-1" aria-label="Remove step">✕</button>
                </div>
              ))}
              {workflow.length < 6 && <button className="text-xs font-bold text-white/50 hover:text-white" onClick={() => { setWorkflow([...workflow, { key: nextStepKey(workflow), label: 'HR approval', role: 'hr' }]); setDirty(true) }}>+ Add step</button>}
            </div>
          )}
          {(info.current.stages.length > 0 || stages) && (
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-2">Stages</p>
              <textarea className={inp} rows={3} value={stages} onChange={(e) => { setStages(e.target.value); setDirty(true) }} aria-label="Stages" />
              <p className="text-[10px] text-white/35 mt-1">Comma separated, in order.</p>
            </div>
          )}
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/85 mb-2">Save note</p>
            <input className={inp} placeholder="e.g. HR format from Hasan, Sept" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/85 mb-2">Versions</p>
            <button className="w-full text-left text-xs py-1 text-white/60 hover:text-white" onClick={() => activate.mutate(0)}>Built-in default {info.current.isDefault && <span className="text-kds-green">· live</span>}</button>
            {info.versions.map((v) => (
              <button key={v.version} className="w-full text-left text-xs py-1 text-white/60 hover:text-white" onClick={() => activate.mutate(v.version)}>
                v{v.version} · {day(v.createdAt)}{v.note ? ` · ${v.note}` : ''} {v.isActive && <span className="text-kds-green">· live</span>}
              </button>
            ))}
            <p className="text-[10px] text-white/35 mt-2">Click a version to make it live again.</p>
          </div>
          {info.section.requires.length > 0 && (
            <p className="text-[11px] text-white/40">This section&rsquo;s calculations need fields for: {info.section.requires.join(', ')}.</p>
          )}
        </div>
      </div>

      {importing && <ImportJson onClose={() => setImporting(false)} onLoad={(f, w, s) => { touch(f); if (w) setWorkflow(w); if (s) setStages(s.join(', ')); setImporting(false) }} />}
      {preview && (
        <Modal title="Preview" wide onClose={() => setPreview(false)}>
          <PreviewForm fields={fields} />
        </Modal>
      )}
    </HrShell>
  )
}

/** Approvals are matched to steps by key, so a new step never reuses one —
 *  not even after a step in the middle was removed. */
function nextStepKey(workflow: WorkflowStep[]): string {
  const used = new Set(workflow.map((w) => w.key))
  let n = workflow.length + 1
  while (used.has(`step${n}`)) n++
  return `step${n}`
}

const splitOptions = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean)

/** Choices as comma-separated text. What is typed stays as typed — a
 *  trailing comma or space is the start of the next choice, not noise — and
 *  the list is taken from it on every change; it is tidied on blur. */
function OptionsInput({ options, onSet }: { options: string[]; onSet: (o: string[]) => void }) {
  const [text, setText] = useState(options.join(', '))
  const [seen, setSeen] = useState(options.join('\n'))
  if (options.join('\n') !== seen) {
    setSeen(options.join('\n'))
    if (splitOptions(text).join('\n') !== options.join('\n')) setText(options.join(', '))
  }
  return <input className={inp} placeholder="comma, separated" value={text} aria-label="Options"
    onChange={(e) => { setText(e.target.value); onSet(splitOptions(e.target.value)) }}
    onBlur={() => setText(splitOptions(text).join(', '))} />
}

function PreviewForm({ fields }: { fields: HrField[] }) {
  const { data: org } = useHrOrg()
  const [v, setV] = useState<Record<string, unknown>>({})
  return <FormRenderer fields={fields} value={v} onChange={setV} ctx={{ org }} />
}

function ImportJson({ onClose, onLoad }: { onClose: () => void; onLoad: (f: HrField[], w?: WorkflowStep[], s?: string[]) => void }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const go = () => {
    try {
      const j = JSON.parse(text) as { fields?: HrField[]; workflow?: WorkflowStep[]; stages?: string[] } | HrField[]
      const fields = Array.isArray(j) ? j : j.fields
      if (!Array.isArray(fields) || !fields.every((f) => f && typeof f.label === 'string' && typeof f.type === 'string')) throw new Error('Expected a list of fields, each with a label and a type')
      onLoad(fields.map((f) => ({ ...f, key: f.key || slug(f.label) })), Array.isArray(j) ? undefined : j.workflow, Array.isArray(j) ? undefined : j.stages)
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="Import format (JSON)" wide onClose={onClose}>
      <p className="text-xs text-white/50 mb-2">Paste an exported format, or a list of fields. It replaces the fields in the editor; nothing is saved until you press “Save new version”.</p>
      <textarea className={`${inp} font-mono`} rows={14} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      <div className="flex gap-2 mt-3"><button className={btn} onClick={go}>Load into editor</button><button className={btnGhost} onClick={onClose}>Cancel</button></div>
    </Modal>
  )
}
