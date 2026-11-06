'use client'
// The reporting manager: assign self-evaluations to direct reports and follow them.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../../lib/api'
import { btn, btnGhost, btnDanger, card, day } from '../../../../lib/hr'
import { HrShell, Modal } from '../../../../components/hr/HrShell'
import { Select } from '../../../../components/ui/Select'
import { useConfirm } from '../../../../components/ui/ConfirmDialog'
import { QuestionsEditor, trimPrompts } from '../../../../components/hr/performance/QuestionsEditor'
import { Field, StatusChip, errMsg, inputCls, pctOf, usePerfCycles, type PerfCycle, type PromptMap, type TeamData } from '../../../../components/hr/performance/shared'

interface Template { id: string; name: string; questions: PromptMap; builtIn: boolean }
const WAITING = ['submitted', 'resubmitted', 'manager_in_progress']

export default function TeamEvaluationsPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: cy, isLoading: cyLoading, error: cyErr } = usePerfCycles()
  const open = useMemo(() => (cy?.cycles ?? []).filter((c) => c.status === 'open'), [cy])
  const [pick, setPick] = useState('')
  const cycle: PerfCycle | undefined = open.find((c) => c.id === pick) ?? open[0]
  const { data: team, isLoading, error } = useQuery({ queryKey: ['perf-team', cycle?.id ?? 'all'], queryFn: () => api.get<TeamData>(`/hr/performance/team${cycle ? `?cycleId=${cycle.id}` : ''}`), enabled: !cyLoading })
  const [sel, setSel] = useState<string[]>([])
  const [assigning, setAssigning] = useState(false)
  const [err, setErr] = useState('')

  const reports = (team?.reports ?? []).filter((r) => !cycle || r.tenantId === cycle.tenantId)
  const evByEmp = new Map((team?.evaluations ?? []).filter((e) => !cycle || e.cycleId === cycle.id).map((e) => [e.employeeId, e]))
  const unassigned = reports.filter((r) => !evByEmp.has(r.id))
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const cancel = useMutation({
    mutationFn: (id: string) => api.delete(`/hr/performance/evaluations/${id}`),
    onSuccess: () => { toast.success('Evaluation cancelled'); void qc.invalidateQueries({ queryKey: ['perf-team'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  async function onCancel(id: string, name: string) {
    const ok = await confirm({ title: `Cancel ${name}'s evaluation?`, body: 'It has not been submitted yet. You can assign it again later.', confirmLabel: 'Cancel evaluation', cancelLabel: 'Keep', danger: true })
    if (ok) cancel.mutate(id)
  }

  return (
    <HrShell title="Team evaluations" subtitle="Assign self-evaluations to your direct reports, then review and finalize them." actions={<Link href="/hr/me" className={btnGhost}>Back to My HR</Link>}>
      {(cyLoading || isLoading) && <p className="text-sm text-white/50" role="status">Loading your team…</p>}
      {(cyErr || error) && <p className="text-sm text-s-red" role="alert">{errMsg(cyErr ?? error)}</p>}
      {!cyLoading && cy && open.length === 0 && (
        <div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/75">There is no open evaluation cycle yet. HR opens one under HR → Performance.</p></div>
      )}
      {cycle && team && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-72">
              <Field label="Evaluation cycle">
                <Select className={inputCls} value={cycle.id} onChange={(e) => { setPick(e.target.value); setSel([]) }}>
                  {open.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            </div>
            <p className="text-xs text-white/60 pb-2">{day(cycle.periodFrom)} – {day(cycle.periodTo)}{cycle.dueDate ? ` · due ${day(cycle.dueDate)}` : ''}</p>
          </div>

          <div className="rounded-2xl p-4" style={card}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-sm font-black text-white/85">Your direct reports</p>
              <button className={btn} disabled={sel.length === 0} onClick={() => setAssigning(true)}>Assign evaluation{sel.length ? ` (${sel.length})` : ''}</button>
            </div>
            {reports.length === 0 && <p className="text-sm text-white/65">No one reports to you in this company, so there is nobody to assign. If that looks wrong, ask HR to check the reporting line.</p>}
            {unassigned.length > 1 && (
              <button className="text-xs font-bold text-primary-ink underline mb-2 min-h-[32px]" onClick={() => setSel(sel.length === unassigned.length ? [] : unassigned.map((r) => r.id))}>
                {sel.length === unassigned.length ? 'Clear selection' : `Select all ${unassigned.length} not assigned`}
              </button>
            )}
            <ul>
              {reports.map((r) => {
                const ev = evByEmp.get(r.id)
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2.5 border-t border-white/[0.05] first:border-t-0">
                    <input type="checkbox" className="h-5 w-5 shrink-0" disabled={!!ev} checked={sel.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-white/90 truncate">{r.name} <span className="text-white/50 font-normal">{r.code}</span></p>
                      <p className="text-xs text-white/55 truncate">{[r.designation, r.department].filter(Boolean).join(' · ') || '—'}</p>
                    </div>
                    {ev ? <Link href={`/hr/me/team-evaluations/${ev.id}`}><StatusChip status={ev.status} label={ev.statusLabel} /></Link> : <StatusChip status="not_assigned" label="Not assigned" />}
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/85 mb-3">My evaluations</p>
            {team.evaluations.length === 0 && <p className="text-sm text-white/65">You have not assigned any evaluations yet.</p>}
            <div className="space-y-1">
              {team.evaluations.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 border-t border-white/[0.05] first:border-t-0">
                  <Link href={`/hr/me/team-evaluations/${e.id}`} className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-bold text-white/90 truncate">{e.employee} <span className="text-white/50 font-normal">{e.code}</span></p>
                    <p className="text-xs text-white/55">{e.cycle}{e.dueDate ? ` · due ${day(e.dueDate)}` : ''}{e.finalScore != null ? ` · ${pctOf(e.finalScore)} ${e.categoryLabel ?? ''}` : ''}</p>
                  </Link>
                  <StatusChip status={e.status} label={e.statusLabel} />
                  {WAITING.includes(e.status) && <Link href={`/hr/me/team-evaluations/${e.id}`} className={btn}>Review</Link>}
                  {['pending_employee', 'draft'].includes(e.status) && <button className={`${btnDanger} px-3 py-2`} onClick={() => void onCancel(e.id, e.employee)}>Cancel</button>}
                </div>
              ))}
            </div>
            {err && <p className="text-xs text-s-red mt-2" role="alert">{err}</p>}
          </div>
        </div>
      )}
      {assigning && cycle && <AssignModal cycle={cycle} people={reports.filter((r) => sel.includes(r.id))} onClose={() => setAssigning(false)} onDone={() => { setSel([]); setAssigning(false); void qc.invalidateQueries({ queryKey: ['perf-team'] }) }} />}
    </HrShell>
  )
}

function AssignModal({ cycle, people, onClose, onDone }: { cycle: PerfCycle; people: TeamData['reports']; onClose: () => void; onDone: () => void }) {
  const { data: templates } = useQuery({ queryKey: ['perf-templates'], queryFn: () => api.get<Template[]>('/hr/performance/templates') })
  const [common, setCommon] = useState<PromptMap>({})
  const [loaded, setLoaded] = useState(false)
  const [templateId, setTemplateId] = useState('standard')
  const [per, setPer] = useState<Record<string, PromptMap>>({})
  const [editing, setEditing] = useState('all')
  const [due, setDue] = useState(cycle.dueDate ? cycle.dueDate.slice(0, 10) : '')
  const [tplName, setTplName] = useState('')
  const [err, setErr] = useState('')
  const [refused, setRefused] = useState<Array<{ employeeId: string; message: string }>>([])
  const [dirty, setDirty] = useState(false)
  const qc = useQueryClient()

  // The built-in template is the starting point once the list arrives.
  useEffect(() => { if (templates && !loaded) { setLoaded(true); setCommon(templates.find((t) => t.id === 'standard')?.questions ?? {}) } }, [templates, loaded])
  const value = editing === 'all' ? common : per[editing] ?? common
  const setValue = (v: PromptMap) => { setDirty(true); if (editing === 'all') setCommon(v); else setPer((p) => ({ ...p, [editing]: v })) }
  const onTemplate = (id: string) => { setTemplateId(id); const t = templates?.find((x) => x.id === id); if (t) { setCommon(t.questions); setPer({}); setEditing('all'); setDirty(true) } }

  const assign = useMutation({
    mutationFn: () => api.post<{ created: string[]; refused: Array<{ employeeId: string; code: string; message: string }> }>('/hr/performance/evaluations', {
      cycleId: cycle.id, dueDate: due || undefined,
      assignments: people.map((p) => ({ employeeId: p.id, questions: trimPrompts(per[p.id] ?? common) })),
    }),
    onSuccess: (r) => {
      if (r.created.length) toast.success(`${r.created.length} evaluation${r.created.length === 1 ? '' : 's'} assigned`)
      if (r.refused.length) { setRefused(r.refused); void qc.invalidateQueries({ queryKey: ['perf-team'] }) } else onDone()
    },
    onError: (e: Error) => setErr(e.message),
  })
  const saveTpl = useMutation({
    mutationFn: () => api.post('/hr/performance/templates', { name: tplName.trim(), questions: trimPrompts(common) }),
    onSuccess: () => { toast.success('Template saved'); setTplName(''); void qc.invalidateQueries({ queryKey: ['perf-templates'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Employee'

  return (
    <Modal title={`Assign evaluation — ${people.length} ${people.length === 1 ? 'person' : 'people'}`} wide onClose={onClose} dirty={dirty}>
      <div className="space-y-4">
        <p className="text-xs text-white/65">{people.map((p) => p.name).join(', ')} · {cycle.name}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Question template">
            <Select className={inputCls} value={templateId} onChange={(e) => onTemplate(e.target.value)}>
              {(templates ?? [{ id: 'standard', name: 'Standard (self-evaluation form)', questions: {}, builtIn: true }]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Due date"><input type="date" className={inputCls} value={due} onChange={(e) => { setDue(e.target.value); setDirty(true) }} /></Field>
        </div>
        {people.length > 1 && (
          <Field label="Editing questions for" hint="Questions you change under “Same questions for all selected” go to everyone who has no questions of their own.">
            <Select className={inputCls} value={editing} onChange={(e) => setEditing(e.target.value)}>
              <option value="all">Same questions for all selected</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{per[p.id] ? ' (custom)' : ''}</option>)}
            </Select>
          </Field>
        )}
        {editing !== 'all' && (
          <p className="text-xs text-white/70">Custom questions for <b>{nameOf(editing)}</b>. {per[editing] && <button className="underline text-primary-ink" onClick={() => setPer((p) => { const n = { ...p }; delete n[editing]; return n })}>Use the shared questions again</button>}</p>
        )}
        <QuestionsEditor areas={cycle.areas} value={value} onChange={setValue} />
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow basis-48"><Field label="Save these questions as my template"><input className={inputCls} placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} /></Field></div>
          <button className={btnGhost} disabled={tplName.trim().length < 2 || saveTpl.isPending} onClick={() => saveTpl.mutate()}>{saveTpl.isPending ? 'Saving…' : 'Save template'}</button>
        </div>
        {refused.length > 0 && (
          <div className="rounded-xl p-3" role="alert" style={{ border: '1px solid var(--erp-danger)' }}>
            <p className="text-sm font-black" style={{ color: 'var(--erp-danger)' }}>Some were not assigned</p>
            <ul className="text-xs text-white/80 mt-1 space-y-0.5">{refused.map((r) => <li key={r.employeeId}>{nameOf(r.employeeId)}: {r.message}</li>)}</ul>
            <button className={`${btnGhost} mt-2`} onClick={onDone}>Done</button>
          </div>
        )}
        {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={btn} disabled={assign.isPending || refused.length > 0} onClick={() => { setErr(''); assign.mutate() }}>{assign.isPending ? 'Assigning…' : 'Assign evaluation'}</button>
          <button className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}
