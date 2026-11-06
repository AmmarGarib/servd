'use client'
// One intern / designer: their cards, on-time vs late, revisions, weekly notes (seen by them at once), monthly reviews
// (seen by them only once shared) and attendance read from HR for a chosen range.
import { use, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, LinkButton, Textarea, fieldCls } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import type { Card } from '../../board/data'
import { type CheckIn, type Review, type Stats, type Trackee } from '../data'
import { CardsList, NotesList, ReviewCard, StatsRow } from '../Parts'

interface Attendance { from: string; to: string; present: number; late: number; absent: number; halfDays: number; unpaidLeaveDays: number; records: number }
interface TrackeeRecord extends Trackee { cards: Card[]; stats: Stats; checkIns: CheckIn[]; reviews: Review[]; attendance: Attendance; warnings: string[] }

const pktToday = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
const daysBack = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

export default function TrackeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [range, setRange] = useState({ from: daysBack(pktToday(), 29), to: pktToday() })
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState<Review | 'new' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: rec, refetch, error } = useQuery<TrackeeRecord>({
    queryKey: ['mkt-tracker', id, range.from, range.to],
    queryFn: () => api.get(`/marketing-tracker/${id}?from=${range.from}&to=${range.to}`),
    retry: false,
  })

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null)
    try { await fn(); await refetch() } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong') } finally { setBusy(false) }
  }

  if (error) return <div className="p-6"><ErrorBanner message="This record is not available to you." /></div>
  if (!rec) return <p className="p-6 text-sm text-s-muted">Loading…</p>
  const a = rec.attendance
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:px-6">
      <div>
        <Link href="/marketing/tracker" className="text-xs font-semibold text-primary-ink hover:underline">Intern tracker</Link>
        <h1 className="mt-1 text-xl font-black">{rec.person.fullName}</h1>
        <p className="text-sm text-s-muted">{rec.roleLabel} · {rec.person.code} · from {rec.startDate.slice(0, 10)}{rec.endDate ? ` to ${rec.endDate.slice(0, 10)}` : ''}</p>
        {rec.warnings.map((w) => <p key={w} className="mt-1 text-sm font-semibold text-s-amber">{w}</p>)}
      </div>
      {err && <ErrorBanner message={err} />}

      <StatsRow stats={rec.stats} />

      <section className="space-y-2">
        <h2 className="font-bold">Cards</h2>
        <CardsList cards={rec.cards} linkable />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <h2 className="mr-auto font-bold">Attendance (from HR)</h2>
          <Input type="date" aria-label="From" className="w-auto" value={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
          <Input type="date" aria-label="To" className="w-auto" value={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[['Days present', a.present, 'text-success'], ['Late', a.late, a.late ? 'text-s-amber' : 'text-s-text'], ['Absent', a.absent, a.absent ? 'text-s-red' : 'text-s-text']].map(([l, v, c]) => (
            <div key={l as string} className="rounded-xl border border-s-border bg-s-surface p-3">
              <p className="text-xs text-s-muted">{l}</p>
              <p className={`text-xl font-black ${c}`}>{v}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-s-muted">Absent counts working days with no punch, as payroll does. Half days: {a.halfDays}. Unpaid leave: {a.unpaidLeaveDays}.</p>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">Weekly check-ins</h2>
        <p className="text-xs text-s-muted">{rec.person.fullName.split(' ')[0]} sees these notes as soon as you add them.</p>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="This week…" aria-label="New weekly note" maxLength={4000} />
        <Button variant="secondary" disabled={!note.trim() || busy} onClick={() => void run(async () => { await api.post(`/marketing-tracker/${id}/check-ins`, { note: note.trim() }); setNote('') })}>Add note</Button>
        <NotesList notes={rec.checkIns} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="mr-auto font-bold">Monthly reviews</h2>
          <Button size="sm" onClick={() => setReviewing('new')}>New review</Button>
        </div>
        <p className="text-xs text-s-muted">A review stays private until you share it.</p>
        {rec.reviews.length === 0 && <p className="text-sm text-s-muted">No reviews yet.</p>}
        {rec.reviews.map((r) => (
          <ReviewCard key={r.id} r={r}>
            <span className="flex gap-3">
              <LinkButton onClick={() => setReviewing(r)}>Edit</LinkButton>
              <LinkButton disabled={busy} onClick={() => void run(() => api.post(`/marketing-tracker/reviews/${r.id}/share`, { shared: !r.sharedAt }))}>{r.sharedAt ? 'Unshare' : 'Share'}</LinkButton>
            </span>
          </ReviewCard>
        ))}
      </section>

      {reviewing && <ReviewDialog trackeeId={id} review={reviewing === 'new' ? null : reviewing} onClose={() => setReviewing(null)} onSaved={() => { setReviewing(null); void refetch() }} />}
    </div>
  )
}

function ReviewDialog({ trackeeId, review, onClose, onSaved }: { trackeeId: string; review: Review | null; onClose: () => void; onSaved: () => void }) {
  const [month, setMonth] = useState(review?.month ?? new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 7))
  const [strengths, setStrengths] = useState(review?.strengths ?? '')
  const [improvements, setImprovements] = useState(review?.improvements ?? '')
  const [recommendation, setRec] = useState<Review['recommendation']>(review?.recommendation ?? 'keep')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true); setErr(null)
    try {
      if (review) await api.patch(`/marketing-tracker/reviews/${review.id}`, { strengths, improvements, recommendation })
      else await api.post(`/marketing-tracker/${trackeeId}/reviews`, { month, strengths, improvements, recommendation })
      onSaved()
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save the review') } finally { setBusy(false) }
  }
  return (
    <Dialog title={review ? 'Edit review' : 'New monthly review'} onClose={onClose} dirty={!!(strengths || improvements)}>
      <div className="space-y-3">
        {err && <ErrorBanner message={err} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Month"><Input type="month" value={month} disabled={!!review} onChange={(e) => setMonth(e.target.value)} /></Field>
          <Field label="Recommendation">
            <Select className={fieldCls} value={recommendation} onChange={(e) => setRec(e.target.value as Review['recommendation'])}>
              <option value="keep">Keep</option><option value="extend">Extend</option><option value="end">End</option>
            </Select>
          </Field>
        </div>
        <Field label="Strengths"><Textarea rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} maxLength={4000} /></Field>
        <Field label="Areas to improve"><Textarea rows={3} value={improvements} onChange={(e) => setImprovements(e.target.value)} maxLength={4000} /></Field>
      </div>
      <DialogFooter onCancel={onClose}><Button onClick={() => void save()} disabled={busy || !strengths.trim() || !improvements.trim()}>{busy ? 'Saving…' : 'Save'}</Button></DialogFooter>
    </Dialog>
  )
}
