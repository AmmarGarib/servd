'use client'
// The reporting manager's review of an employee's self-evaluation (HR sees it read-only and may reopen).

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from '../../../../../lib/api'
import { btn, btnGhost, card, day } from '../../../../../lib/hr'
import { HrShell, Stat } from '../../../../../components/hr/HrShell'
import { askReason, useConfirm } from '../../../../../components/ui/ConfirmDialog'
import { QuestionsEditor, trimPrompts } from '../../../../../components/hr/performance/QuestionsEditor'
import {
  Field, PerfSection, RatingPicker, RATING_LABELS, ScoreBanner, StatusChip, bpOf, categoryOf, emptyManager, emptySelf, errMsg, finalOf, inputCls,
  pctOf, ratingText, selfAreaRating, textareaCls, weightedScore, type ManagerData, type PerfView, type PromptMap,
} from '../../../../../components/hr/performance/shared'

function AgreeToggle({ value, onChange, disabled, label }: { value?: 'agree' | 'disagree' | null; onChange: (v: 'agree' | 'disagree') => void; disabled?: boolean; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg overflow-hidden border border-white/15">
      {(['agree', 'disagree'] as const).map((v) => {
        const on = value === v
        return (
          <button key={v} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(v)} className="min-h-[44px] px-4 text-sm font-bold disabled:cursor-default"
            style={on ? { background: v === 'agree' ? 'var(--erp-success)' : 'var(--erp-danger)', color: 'var(--bg)' } : { color: 'rgb(var(--fg-rgb) / 0.7)', opacity: disabled ? 0.6 : 1 }}>
            {v === 'agree' ? 'Agree' : 'Disagree'}
          </button>
        )
      })}
    </div>
  )
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: view, error, isLoading } = useQuery({ queryKey: ['perf-eval', id], queryFn: () => api.get<PerfView>(`/hr/performance/evaluations/${id}`), retry: false })
  const [mgr, setMgr] = useState<ManagerData | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [editQ, setEditQ] = useState(false)
  useEffect(() => { if (view && mgr === null) setMgr(emptyManager(view.manager)) }, [view, mgr])

  const live = useMemo(() => {
    if (!view || !mgr) return null
    const selfScore = view.scores.selfScore ?? weightedScore(view.areas, (k) => selfAreaRating(k, view.questions, emptySelf(view.self)))
    const managerScore = weightedScore(view.areas, (k) => mgr.areas[k]?.rating ?? null)
    const final = finalOf(selfScore, managerScore, view.selfWeightBp)
    return { selfScore, managerScore, final, cat: categoryOf(final) }
  }, [view, mgr])

  if (error) return <HrShell title="Review evaluation"><div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/70" role="alert">{errMsg(error)}</p><Link href="/hr/me/team-evaluations" className="text-sm text-primary-ink underline mt-3 inline-block">Back to team evaluations</Link></div></HrShell>
  if (isLoading || !view || !mgr || !live) return <HrShell title="Review evaluation"><p className="text-sm text-white/50" role="status">Loading…</p></HrShell>

  const self = emptySelf(view.self)
  const canReview = view.can.review
  const isHr = view.roles.includes('hr')
  const finalized = view.status === 'finalized'
  const p = view.profile
  const sync = (v: PerfView) => { qc.setQueryData(['perf-eval', id], v); void qc.invalidateQueries({ queryKey: ['perf-team'] }) }
  const patch = (fn: (m: ManagerData) => ManagerData) => { setMgr((m) => (m ? fn(m) : m)); setMsg('') }
  const setArea = (key: string, v: Partial<ManagerData['areas'][string]>) => patch((m) => ({ ...m, areas: { ...m.areas, [key]: { ...m.areas[key], ...v } } }))
  const fail = (e: Error) => {
    setMsg(e.message)
    if (e instanceof ApiError && e.code === 'RATINGS_MISSING') {
      const labels = (e.details as { missing?: string[] } | undefined)?.missing ?? []
      setMissing(view.areas.filter((a) => labels.includes(a.label)).map((a) => a.key))
    }
  }
  const run = async (name: string, fn: () => Promise<PerfView>, ok: string) => {
    setBusy(name); setMsg('')
    try { const v = await fn(); sync(v); setMissing([]); if (v.manager) setMgr(emptyManager(v.manager)); toast.success(ok) } catch (e) { fail(e as Error) } finally { setBusy(null) }
  }
  const base = `/hr/performance/evaluations/${id}`

  async function onApprove() {
    const ok = await confirm({ title: 'Approve & finalize?', body: `Final score ${pctOf(live!.final)} · ${live!.cat.label}. The result is shared with ${p.fullName} and you can no longer change it (HR can reopen it).`, confirmLabel: 'Approve & Finalize', cancelLabel: 'Keep reviewing' })
    if (ok) void run('approve', () => api.post<PerfView>(`${base}/approve`, { manager: mgr }), 'Evaluation finalized')
  }
  async function onReturn() {
    const note = await askReason({ title: 'Return for revision', body: `Tell ${p.fullName} what to revise.`, label: 'Note to the employee', minLength: 10, confirmLabel: 'Return' })
    if (note) void run('return', () => api.post<PerfView>(`${base}/return`, { note, manager: mgr }), 'Returned to the employee')
  }
  async function onReopen() {
    const reason = await askReason({ title: 'Reopen this evaluation', body: 'It goes back to the manager for assessment. The old result is kept in its history.', label: 'Reason', minLength: 10, confirmLabel: 'Reopen' })
    if (reason) void run('reopen', () => api.post<PerfView>(`/hr/performance/admin/evaluations/${id}/reopen`, { reason }), 'Evaluation reopened')
  }

  return (
    <HrShell title={`Review — ${p.fullName}`} subtitle={view.cycle ? `${view.cycle.name} · ${day(view.cycle.periodFrom)} – ${day(view.cycle.periodTo)}` : undefined}
      actions={<><Link href={isHr && !view.roles.includes('manager') ? '/hr/performance' : '/hr/me/team-evaluations'} className={btnGhost}>Back</Link>
        <button className={btnGhost} disabled={busy === 'pdf'} onClick={() => { setBusy('pdf'); api.download(`${base}/report?format=pdf`, `evaluation-${p.employeeCode}.pdf`).catch((e) => setMsg(errMsg(e))).finally(() => setBusy(null)) }}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button></>}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-center gap-2"><StatusChip status={view.status} label={view.statusLabel} />{view.dueDate && <span className="text-xs text-white/60">Due {day(view.dueDate)}</span>}{view.returnCount > 0 && <span className="text-xs text-white/60">Returned {view.returnCount}×</span>}</div>
        {isHr && !view.roles.includes('manager') && <p className="text-sm text-white/70">You are viewing this as HR. It is read-only{view.can.reopen ? ' — you can reopen a finalized evaluation.' : '.'}</p>}

        <PerfSection n={1} title="Employee">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Employee" value={`${p.fullName} (${p.employeeCode})`} /><Stat label="Designation" value={p.designation ?? '—'} />
            <Stat label="Department" value={p.department ?? '—'} /><Stat label="Branch" value={p.branch ?? '—'} />
            <Stat label="Joined" value={day(p.joiningDate)} /><Stat label="Submitted" value={day(view.dates.submittedAt)} />
            <Stat label="Finalized" value={day(view.dates.finalizedAt)} /><Stat label="Acknowledged" value={day(view.dates.employeeAckAt)} />
          </div>
        </PerfSection>

        {view.can.editQuestions && (
          <div className="rounded-2xl p-4" style={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-sm font-black text-white/90">Questions</p><p className="text-xs text-white/60">{view.status === 'pending_employee' ? 'The employee has not started yet.' : 'The employee is working on it.'} You can change the questions until they submit.</p></div>
              <button className={btnGhost} onClick={() => setEditQ((v) => !v)}>{editQ ? 'Close editor' : 'Edit questions'}</button>
            </div>
            {editQ && <QuestionsPanel view={view} onSaved={(v) => { sync(v); setEditQ(false); toast.success('Questions updated') }} />}
          </div>
        )}
        {view.status === 'returned' && view.returnNote && <div className="rounded-2xl p-4 text-sm" style={{ border: '1px solid var(--erp-warning)' }}><b>Returned to the employee:</b> <span className="whitespace-pre-wrap">{view.returnNote}</span></div>}
        {['pending_employee', 'draft', 'returned'].includes(view.status) && !view.can.editQuestions && <p className="text-sm text-white/65">Waiting for {p.fullName} to submit.</p>}

        <ScoreBanner self={live.selfScore} manager={live.managerScore} final={live.final} selfWeightBp={view.selfWeightBp} categoryLabel={live.cat.label} categoryKey={live.cat.key} provisional={!finalized} />

        <PerfSection n={2} title="Assessment by performance area" hint="The employee's answers on the left; your independent rating on the right.">
          {view.areas.map((a, i) => {
            const qs = view.questions[a.key] ?? []
            const d = self.areas[a.key]
            const sr = selfAreaRating(a.key, view.questions, self)
            const m = mgr.areas[a.key]
            const bad = missing.includes(a.key) || (missing.length > 0 && !m?.rating)
            return (
              <div key={a.key} className="rounded-xl p-3 sm:p-4" style={{ border: `1px solid ${bad ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.08)'}` }}>
                <h3 className="text-sm font-black text-white/90 mb-3">{i + 1}. {a.label} <span className="text-white/55 font-bold">· {bpOf(a.weightBp)}</span></h3>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-3 min-w-0">
                    <p className="text-[11px] font-black uppercase tracking-wider text-white/55">Employee</p>
                    {qs.length === 0 ? <p className="text-sm text-white/80">Area rating: <b>{d?.rating ?? '—'}</b></p> : qs.map((q) => {
                      const ans = d?.answers?.[q.id]
                      return (
                        <div key={q.id} className="text-sm">
                          <p className="text-white/70">{q.text}</p>
                          <p className="text-white/90 font-bold">{ans?.rating ? `${ans.rating} — ${RATING_LABELS[ans.rating]}` : 'Not rated'}</p>
                          {ans?.answer && <p className="text-white/80 whitespace-pre-wrap">{ans.answer}</p>}
                        </div>
                      )
                    })}
                    {d?.comment && <p className="text-sm text-white/80"><b className="text-white/60">Comments: </b><span className="whitespace-pre-wrap">{d.comment}</span></p>}
                    {d?.evidence && <p className="text-sm text-white/80"><b className="text-white/60">Evidence: </b><span className="whitespace-pre-wrap">{d.evidence}</span></p>}
                    <p className="text-sm font-black text-primary-ink">Employee rating {ratingText(sr)} / 5</p>
                  </div>
                  <div className="space-y-3 min-w-0 md:border-l md:pl-4" style={{ borderColor: 'rgb(var(--fg-rgb) / 0.08)' }}>
                    <p className="text-[11px] font-black uppercase tracking-wider text-white/55">Your assessment</p>
                    <RatingPicker label={`Your rating for ${a.label}`} value={m?.rating} disabled={!canReview} invalid={bad && !m?.rating} onChange={(v) => setArea(a.key, { rating: v })} />
                    <AgreeToggle label={`Do you agree with the employee on ${a.label}`} value={m?.agree} disabled={!canReview} onChange={(v) => setArea(a.key, { agree: v })} />
                    <textarea className={textareaCls} rows={2} disabled={!canReview} placeholder="Your comment" aria-label={`Comment on ${a.label}`} value={m?.comment ?? ''} onChange={(e) => setArea(a.key, { comment: e.target.value })} />
                  </div>
                </div>
              </div>
            )
          })}
        </PerfSection>

        <PerfSection n={3} title="Overall assessment">
          <div className="rounded-xl p-3 text-sm" style={{ background: 'rgb(var(--fg-rgb) / 0.04)' }}>
            <p className="text-white/70">Employee&rsquo;s overall self-rating</p>
            <p className="font-black text-white/90">{self.overallRating ? `${self.overallRating} — ${RATING_LABELS[self.overallRating]}` : '—'}</p>
            {self.overallWhy && <p className="text-white/80 mt-1 whitespace-pre-wrap">{self.overallWhy}</p>}
          </div>
          <Field label="Your overall assessment"><textarea className={textareaCls} rows={3} disabled={!canReview} value={mgr.overall ?? ''} onChange={(e) => patch((m) => ({ ...m, overall: e.target.value }))} /></Field>
          <div><p className="text-xs font-bold text-white/70 mb-1">Do you agree with the employee&rsquo;s overall self-rating?</p><AgreeToggle label="Agree with overall self-rating" value={mgr.agreeOverall} disabled={!canReview} onChange={(v) => patch((m) => ({ ...m, agreeOverall: v }))} /></div>
          <Field label="Performance gaps"><textarea className={textareaCls} rows={2} disabled={!canReview} value={mgr.gaps ?? ''} onChange={(e) => patch((m) => ({ ...m, gaps: e.target.value }))} /></Field>
          <Field label="Recommended training"><textarea className={textareaCls} rows={2} disabled={!canReview} value={mgr.training ?? ''} onChange={(e) => patch((m) => ({ ...m, training: e.target.value }))} /></Field>
        </PerfSection>

        <PerfSection n={4} title="Employee's other answers">
          {self.achievements.some((x) => x.achievement || x.impact || x.evidence) && (
            <div className="space-y-2">{self.achievements.filter((x) => x.achievement || x.impact || x.evidence).map((x, i) => (
              <div key={i} className="text-sm rounded-lg p-3" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                <p className="font-bold text-white/90">{i + 1}. {x.achievement}</p>
                {x.impact && <p className="text-white/75">Impact: {x.impact}</p>}{x.evidence && <p className="text-white/75">Evidence: {x.evidence}</p>}
              </div>))}</div>
          )}
          {([['strengths', 'Strongest skills'], ['improve', 'Needs to improve'], ['develop', 'Wants to develop'], ['training', 'Training wanted'], ['goals', 'Goals'], ['support', 'Support needed'], ['challenges', 'Challenges'], ['other', 'Other']] as const)
            .filter(([k]) => self[k]).map(([k, label]) => <p key={k} className="text-sm text-white/80"><b className="text-white/60">{label}: </b><span className="whitespace-pre-wrap">{self[k]}</span></p>)}
        </PerfSection>

        <div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 flex flex-wrap items-center gap-2" style={{ background: 'var(--bg)' }}>
          {canReview && <>
            <button className={btnGhost} disabled={busy !== null} onClick={() => void run('save', () => api.put<PerfView>(`${base}/manager`, { manager: mgr }), 'Draft saved')}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
            <button className={btnGhost} disabled={busy !== null} onClick={() => void onReturn()}>Return for revision</button>
            <button className={btn} disabled={busy !== null} onClick={() => void onApprove()}>{busy === 'approve' ? 'Finalizing…' : 'Approve & Finalize'}</button>
          </>}
          {view.can.reopen && <button className={btnGhost} disabled={busy !== null} onClick={() => void onReopen()}>Reopen</button>}
          {msg && <span className="text-xs text-white/75" role="alert">{msg}</span>}
        </div>
      </div>
    </HrShell>
  )
}

function QuestionsPanel({ view, onSaved }: { view: PerfView; onSaved: (v: PerfView) => void }) {
  const [val, setVal] = useState<PromptMap>(() => Object.fromEntries(view.areas.map((a) => [a.key, (view.questions[a.key] ?? []).map((q) => q.text)])))
  const [due, setDue] = useState(view.dueDate ? view.dueDate.slice(0, 10) : '')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.put<PerfView>(`/hr/performance/evaluations/${view.id}/questions`, { questions: trimPrompts(val), dueDate: due || null }),
    onSuccess: onSaved, onError: (e: Error) => setErr(e.message),
  })
  return (
    <div className="mt-4 space-y-3">
      <div className="max-w-xs"><Field label="Due date"><input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} /></Field></div>
      <QuestionsEditor areas={view.areas} value={val} onChange={setVal} />
      {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
      <button className={btn} disabled={save.isPending} onClick={() => { setErr(''); save.mutate() }}>{save.isPending ? 'Saving…' : 'Save questions'}</button>
    </div>
  )
}
