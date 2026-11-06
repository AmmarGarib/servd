'use client'
// The employee's self-evaluation form — the 7 sections of the owner's Word form.
// Contract: backend/src/modules/hr/performance.ts.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from '../../../../../lib/api'
import { btn, btnGhost, day } from '../../../../../lib/hr'
import { HrShell, Stat } from '../../../../../components/hr/HrShell'
import { useConfirm } from '../../../../../components/ui/ConfirmDialog'
import {
  Field, PerfSection, RatingPicker, RATING_BANDS, RATING_LABELS, ScoreBanner, StatusChip, areaMissing, bpOf, cleanSelf, emptySelf, errMsg,
  inputCls, pctOf, ratingText, selfAreaRating, textareaCls, weightedScore, type PerfView, type SelfData,
} from '../../../../../components/hr/performance/shared'

export default function MyEvaluationPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: view, error, isLoading } = useQuery({ queryKey: ['perf-eval', id], queryFn: () => api.get<PerfView>(`/hr/performance/evaluations/${id}`), retry: false })
  const [self, setSelf] = useState<SelfData | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [overallInvalid, setOverallInvalid] = useState(false)
  const [busy, setBusy] = useState<'save' | 'submit' | 'pdf' | 'ack' | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { if (view && self === null) setSelf(emptySelf(view.self)) }, [view, self])

  const live = useMemo(() => {
    if (!view || !self) return null
    const per = view.areas.map((a) => ({ a, rating: selfAreaRating(a.key, view.questions, self) }))
    return { per, score: weightedScore(view.areas, (k) => per.find((p) => p.a.key === k)?.rating ?? null) }
  }, [view, self])

  // Mutations before any early return (React's hook order).
  const sync = (v: PerfView) => { qc.setQueryData(['perf-eval', id], v); void qc.invalidateQueries({ queryKey: ['perf-mine'] }) }
  const save = useMutation({
    mutationFn: () => api.put<PerfView>(`/hr/performance/evaluations/${id}/self`, { self: cleanSelf(self!) }),
    onSuccess: (v) => { sync(v); setMsg('Draft saved.'); toast.success('Draft saved') },
    onError: (e: Error) => setMsg(e.message),
    onSettled: () => setBusy(null),
  })
  const submit = useMutation({
    mutationFn: () => api.post<PerfView>(`/hr/performance/evaluations/${id}/submit`, { self: cleanSelf(self!) }),
    onSuccess: (v) => { sync(v); setMissing([]); setOverallInvalid(false); setSelf(emptySelf(v.self)); toast.success('Evaluation submitted to your manager') },
    onError: (e: Error) => {
      setMsg(e.message)
      if (e instanceof ApiError && e.code === 'RATINGS_MISSING') {
        const d = e.details as { missing?: string[]; missingKeys?: string[] } | undefined
        setMissing(d?.missingKeys ?? (view?.areas ?? []).filter((a) => (d?.missing ?? []).includes(a.label)).map((a) => a.key))
        document.getElementById('perf-self-rating')?.scrollIntoView({ behavior: 'smooth' })
      }
      if (e instanceof ApiError && (e.code === 'OVERALL_MISSING' || e.code === 'OVERALL_WHY_MISSING')) setOverallInvalid(true)
    },
    onSettled: () => setBusy(null),
  })
  const ack = useMutation({
    mutationFn: () => api.post<PerfView>(`/hr/performance/evaluations/${id}/acknowledge`, {}),
    onSuccess: (v) => { sync(v); toast.success('Acknowledged') },
    onError: (e: Error) => setMsg(e.message),
    onSettled: () => setBusy(null),
  })

  if (error) return <HrShell title="Self-evaluation"><div className="rounded-2xl p-8 text-center s-card"><p className="text-sm text-white/70" role="alert">{errMsg(error)}</p><Link href="/hr/me" className="text-sm text-primary-ink underline mt-3 inline-block">Back to My HR</Link></div></HrShell>
  if (isLoading || !view || !self || !live) return <HrShell title="Self-evaluation"><p className="text-sm text-white/50" role="status">Loading your evaluation…</p></HrShell>

  const editable = view.can.editSelf
  const p = view.profile
  const patch = (fn: (s: SelfData) => SelfData) => { setSelf((s) => (s ? fn(s) : s)); setMsg('') }
  const setArea = (key: string, v: Partial<NonNullable<SelfData['areas'][string]>>) => patch((s) => ({ ...s, areas: { ...s.areas, [key]: { ...s.areas[key], ...v } } }))
  const setAnswer = (key: string, qid: string, v: { rating?: number | null; answer?: string | null }) =>
    patch((s) => ({ ...s, areas: { ...s.areas, [key]: { ...s.areas[key], answers: { ...s.areas[key]?.answers, [qid]: { ...s.areas[key]?.answers?.[qid], ...v } } } } }))
  const setAch = (i: number, v: Partial<SelfData['achievements'][number]>) => patch((s) => ({ ...s, achievements: s.achievements.map((a, j) => (j === i ? { ...a, ...v } : a)) }))

  async function onSubmit() {
    const ok = await confirm({ title: 'Submit your self-evaluation?', body: 'It goes to your reporting manager. You cannot change it unless your manager returns it for revision.', confirmLabel: 'Submit', cancelLabel: 'Keep editing' })
    if (!ok) return
    setBusy('submit'); setMsg(''); submit.mutate()
  }
  async function pdf() {
    setBusy('pdf'); setMsg('')
    try { await api.download(`/hr/performance/evaluations/${id}/report?format=pdf`, `evaluation-${p.employeeCode}.pdf`) } catch (e) { setMsg(errMsg(e)) } finally { setBusy(null) }
  }

  const mgr = view.manager
  const finalized = view.status === 'finalized'
  return (
    <HrShell title="My Performance Evaluation" subtitle={view.cycle ? `${view.cycle.name} · ${day(view.cycle.periodFrom)} – ${day(view.cycle.periodTo)}` : undefined}
      actions={<><Link href="/hr/me" className={btnGhost}>Back</Link><button className={btnGhost} disabled={busy === 'pdf'} onClick={() => void pdf()}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button></>}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-center gap-2"><StatusChip status={view.status} label={view.statusLabel} />{view.dueDate && <span className="text-xs text-white/60">Due {day(view.dueDate)}</span>}</div>

        {view.status === 'returned' && view.returnNote && (
          <div className="rounded-2xl p-4" role="alert" style={{ border: '1px solid var(--erp-danger)', background: 'rgb(var(--fg-rgb) / 0.03)' }}>
            <p className="text-sm font-black" style={{ color: 'var(--erp-danger)' }}>Your manager returned this for revision</p>
            <p className="text-sm text-white/85 mt-1 whitespace-pre-wrap">{view.returnNote}</p>
            <p className="text-xs text-white/55 mt-2">Update your answers and submit again.</p>
          </div>
        )}
        {finalized && mgr && <ScoreBanner self={view.scores.selfScore} manager={view.scores.managerScore} final={view.scores.finalScore} selfWeightBp={view.selfWeightBp} categoryLabel={view.scores.categoryLabel} categoryKey={view.scores.category} />}
        {!editable && !finalized && <p className="text-sm text-white/65">This evaluation is with your manager. You can read it here; it opens again only if it is returned for revision.</p>}

        {/* 1 */}
        <PerfSection n={1} title="Employee profile">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Employee" value={p.fullName} /><Stat label="Employee ID" value={p.employeeCode} />
            <Stat label="Department" value={p.department ?? '—'} /><Stat label="Designation" value={p.designation ?? '—'} />
            <Stat label="Branch" value={p.branch ?? '—'} /><Stat label="Reporting manager" value={p.reportingManager ?? '—'} />
            <Stat label="Joined" value={day(p.joiningDate)} /><Stat label="Employment type" value={p.employmentType ?? '—'} />
            <Stat label="Review period" value={view.cycle ? `${day(view.cycle.periodFrom)} – ${day(view.cycle.periodTo)}` : '—'} />
            <Stat label="Submission date" value={day(view.dates.submittedAt)} />
            <Stat label="Assigned" value={day(view.dates.assignedAt)} /><Stat label="Due" value={day(view.dueDate)} />
          </div>
        </PerfSection>

        {/* 2 */}
        <div id="perf-self-rating">
          <PerfSection n={2} title="Self-rating by performance area" hint="Rate every question from 1 (Unsatisfactory) to 5 (Exceptional).">
            {view.areas.map((a, i) => {
              const qs = view.questions[a.key] ?? []
              const d = self.areas[a.key]
              const bad = missing.includes(a.key) || (missing.length > 0 && areaMissing(a.key, view.questions, self))
              const r = live.per[i]?.rating ?? null
              const ma = mgr?.areas?.[a.key]
              return (
                <div key={a.key} className="rounded-xl p-3 sm:p-4 space-y-3" style={{ border: `1px solid ${bad ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.08)'}` }}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-black text-white/90">{a.label} <span className="text-white/55 font-bold">· {bpOf(a.weightBp)}</span></h3>
                    <p className="text-xs text-white/65">Area rating <b className="text-white/90">{ratingText(r)}</b> / 5 · scores <b className="text-white/90">{pctOf(r == null ? 0 : (r / 5) * a.weightBp)}</b> of {bpOf(a.weightBp)}</p>
                  </div>
                  {bad && <p className="text-xs" role="alert" style={{ color: 'var(--erp-danger)' }}>Rate every question in this area.</p>}
                  {qs.length === 0 ? (
                    <RatingPicker label={`${a.label} rating`} value={d?.rating} disabled={!editable} invalid={bad} onChange={(v) => setArea(a.key, { rating: v })} />
                  ) : qs.map((q, qi) => {
                    const ans = d?.answers?.[q.id]
                    return (
                      <div key={q.id} className="space-y-2">
                        <p className="text-sm text-white/85"><span className="text-white/50 font-bold mr-1">{qi + 1}.</span>{q.text}</p>
                        <RatingPicker label={`${a.label} question ${qi + 1}`} value={ans?.rating} disabled={!editable} invalid={bad && !ans?.rating} onChange={(v) => setAnswer(a.key, q.id, { rating: v })} />
                        <textarea className={textareaCls} rows={2} disabled={!editable} placeholder="Your answer (optional)" aria-label={`Answer to: ${q.text}`} value={ans?.answer ?? ''} onChange={(e) => setAnswer(a.key, q.id, { answer: e.target.value })} />
                      </div>
                    )
                  })}
                  <div className="grid md:grid-cols-2 gap-3">
                    <Field label="Comments"><textarea className={textareaCls} rows={2} disabled={!editable} value={d?.comment ?? ''} onChange={(e) => setArea(a.key, { comment: e.target.value })} /></Field>
                    <Field label="Example / evidence"><textarea className={textareaCls} rows={2} disabled={!editable} value={d?.evidence ?? ''} onChange={(e) => setArea(a.key, { evidence: e.target.value })} /></Field>
                  </div>
                  {finalized && ma && (
                    <div className="rounded-lg p-3 text-sm" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)' }}>
                      <p className="font-black text-white/90">Manager: {ma.rating ?? '—'} / 5 {ma.agree && <span className="ml-2 text-xs font-bold" style={{ color: ma.agree === 'agree' ? 'var(--erp-success)' : 'var(--erp-danger)' }}>{ma.agree === 'agree' ? 'Agrees with your rating' : 'Disagrees with your rating'}</span>}</p>
                      {ma.comment && <p className="text-white/80 mt-1 whitespace-pre-wrap">{ma.comment}</p>}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.14)' }} role="status">
              <span className="text-sm font-bold text-white/85">Your weighted self-score so far</span>
              <span className="text-xl font-black text-success">{pctOf(live.score)}</span>
            </div>
          </PerfSection>
        </div>

        {/* 3 */}
        <PerfSection n={3} title="Overall self-assessment">
          <div role="radiogroup" aria-label="Overall self-rating" className="grid gap-2 sm:grid-cols-5">
            {[5, 4, 3, 2, 1].map((n) => {
              const on = self.overallRating === n
              return (
                <button key={n} type="button" role="radio" aria-checked={on} aria-pressed={on} disabled={!editable} onClick={() => patch((s) => ({ ...s, overallRating: n }))}
                  className={`rounded-xl border p-3 text-left min-h-[56px] disabled:cursor-default ${on ? 'bg-primary text-primary-on border-transparent' : 'text-white/80 hover:text-white'}`}
                  style={on ? undefined : { borderColor: overallInvalid && !self.overallRating ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.15)', opacity: editable ? 1 : 0.6 }}>
                  <span className="block text-base font-black">{n} · {RATING_LABELS[n]}</span>
                  <span className="block text-[11px] opacity-80">{RATING_BANDS[n]}</span>
                </button>
              )
            })}
          </div>
          <Field label="Why did you choose this rating?"><textarea className={textareaCls} rows={3} disabled={!editable} value={self.overallWhy ?? ''} aria-invalid={overallInvalid && !self.overallWhy?.trim()} onChange={(e) => patch((s) => ({ ...s, overallWhy: e.target.value }))} /></Field>
          <p className="text-sm text-white/75">Auto-calculated self score: <b className="text-white/90">{pctOf(live.score)}</b></p>
        </PerfSection>

        {/* 4 */}
        <PerfSection n={4} title="Key achievements" hint="Up to three things you are proud of in this period.">
          {self.achievements.map((a, i) => (
            <div key={i} className="grid md:grid-cols-3 gap-3 rounded-xl p-3" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
              <Field label={`Achievement ${i + 1}`}><textarea className={textareaCls} rows={2} disabled={!editable} value={a.achievement ?? ''} onChange={(e) => setAch(i, { achievement: e.target.value })} /></Field>
              <Field label="Result / impact"><textarea className={textareaCls} rows={2} disabled={!editable} value={a.impact ?? ''} onChange={(e) => setAch(i, { impact: e.target.value })} /></Field>
              <Field label="Supporting evidence"><textarea className={textareaCls} rows={2} disabled={!editable} value={a.evidence ?? ''} onChange={(e) => setAch(i, { evidence: e.target.value })} /></Field>
            </div>
          ))}
        </PerfSection>

        {/* 5 */}
        <PerfSection n={5} title="Strengths & development">
          <Field label="What are my strongest skills or qualities?"><textarea className={textareaCls} rows={3} disabled={!editable} value={self.strengths ?? ''} onChange={(e) => patch((s) => ({ ...s, strengths: e.target.value }))} /></Field>
          <Field label="What do I need to improve?"><textarea className={textareaCls} rows={3} disabled={!editable} value={self.improve ?? ''} onChange={(e) => patch((s) => ({ ...s, improve: e.target.value }))} /></Field>
        </PerfSection>

        {/* 6 */}
        <PerfSection n={6} title="Development, goals & support">
          {([
            ['develop', 'Skills I want to develop'], ['training', 'Training I would like'], ['goals', 'My goals for the next period'],
            ['support', 'Support I need from my manager or the company'], ['challenges', 'Challenges I faced'], ['other', 'Anything else I want to share'],
          ] as const).map(([k, label]) => (
            <Field key={k} label={label}><textarea className={textareaCls} rows={2} disabled={!editable} value={self[k] ?? ''} onChange={(e) => patch((s) => ({ ...s, [k]: e.target.value }))} /></Field>
          ))}
        </PerfSection>

        {/* 7 */}
        <PerfSection n={7} title="Acknowledgement & sign-off">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Submitted" value={day(view.dates.submittedAt)} />
            <Stat label="Manager review" value={day(view.dates.managerStartedAt)} />
            <Stat label="Final approval" value={day(view.dates.finalizedAt)} />
            <Stat label="You acknowledged" value={day(view.dates.employeeAckAt)} />
          </div>
          {view.can.acknowledge && (
            <div>
              <p className="text-sm text-white/75 mb-2">I have read my final evaluation and acknowledge the result.</p>
              <button className={btn} disabled={busy === 'ack'} onClick={() => { setBusy('ack'); ack.mutate() }}>{busy === 'ack' ? 'Saving…' : 'I acknowledge'}</button>
            </div>
          )}
          {finalized && view.dates.employeeAckAt && <p className="text-sm text-success font-bold">You acknowledged this result on {day(view.dates.employeeAckAt)}.</p>}
        </PerfSection>

        {editable && (
          <div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 flex flex-wrap items-center gap-2" style={{ background: 'var(--bg)' }}>
            <button className={btnGhost} disabled={busy !== null} onClick={() => { setBusy('save'); setMsg(''); save.mutate() }}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
            <button className={btn} disabled={busy !== null} onClick={() => void onSubmit()}>{busy === 'submit' ? 'Submitting…' : 'Submit'}</button>
            {msg && <span className="text-xs text-white/75" role="status">{msg}</span>}
          </div>
        )}
        {!editable && msg && <p className="text-xs text-white/75" role="alert">{msg}</p>}
      </div>
    </HrShell>
  )
}
