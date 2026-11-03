'use client'
// Pieces shared by a tracker record (manager side) and My progress (the person's own page).
import { OUTCOME_LABEL, STAGE_LABEL, fmtDay, type Card } from '../board/data'
import { RECOMMENDATION_LABEL, onTimeRate, type CheckIn, type Review, type Stats } from './data'

export function StatsRow({ stats }: { stats: Stats }) {
  const items: Array<[string, string | number, string]> = [
    ['On-time rate', onTimeRate(stats), 'text-success'],
    ['On time', stats.onTime, 'text-success'],
    ['Late', stats.late, stats.late ? 'text-s-red' : 'text-s-text'],
    ['Open', stats.open, 'text-s-text'],
    ['Revisions', stats.revisions, 'text-s-text'],
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([l, v, c]) => (
        <div key={l} className="rounded-xl border border-s-border bg-s-surface p-3">
          <p className="text-xs text-s-muted">{l}</p>
          <p className={`text-xl font-black ${c}`}>{v}</p>
        </div>
      ))}
    </div>
  )
}

export function CardsList({ cards, linkable }: { cards: Card[]; linkable: boolean }) {
  if (cards.length === 0) return <p className="text-sm text-s-muted">No cards yet.</p>
  return (
    <ul className="divide-y divide-s-border rounded-xl border border-s-border bg-s-surface">
      {cards.map((c) => {
        const tone = c.outcome === 'on_time' ? 'text-success' : c.outcome === 'open' ? 'text-s-muted' : 'text-s-red'
        const title = <span className="font-semibold">{c.title}</span>
        return (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1 basis-48 break-words">
              {linkable ? <a href={`/marketing/board?board=${c.boardId}&card=${c.id}`} className="hover:underline">{title}</a> : title}
              <span className="ml-2 text-xs text-s-muted">{c.board?.name}</span>
            </span>
            <span className="text-xs text-s-muted">{STAGE_LABEL[c.stage]}</span>
            <span className="text-xs text-s-muted">due {fmtDay(c.deadline)}</span>
            {c.revisionCount > 0 && <span className="text-xs text-s-muted">{c.revisionCount} rev.</span>}
            <span className={`text-xs font-bold ${tone}`}>{OUTCOME_LABEL[c.outcome]}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function NotesList({ notes }: { notes: CheckIn[] }) {
  if (notes.length === 0) return <p className="text-sm text-s-muted">No weekly notes yet.</p>
  return (
    <ol className="space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="rounded-lg bg-s-elevated px-3 py-2">
          <p className="text-xs text-s-muted">Week of {fmtDay(`${n.weekStart.slice(0, 10)}T12:00:00Z`)}{n.authorName ? ` · ${n.authorName}` : ''}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{n.note}</p>
        </li>
      ))}
    </ol>
  )
}

export function ReviewCard({ r, children }: { r: Review; children?: React.ReactNode }) {
  const month = new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('en-PK', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <article className="rounded-xl border border-s-border bg-s-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-bold">{month}</h4>
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${r.recommendation === 'end' ? 'bg-s-red/15 text-s-red' : 'bg-accent/20 text-success'}`}>{RECOMMENDATION_LABEL[r.recommendation]}</span>
        <span className="text-xs text-s-muted">{r.sharedAt ? `Shared ${fmtDay(r.sharedAt)}` : 'Not shared yet'}</span>
        <span className="ml-auto">{children}</span>
      </div>
      <p className="mt-2 text-xs font-semibold text-s-muted">Strengths</p>
      <p className="whitespace-pre-wrap break-words text-sm">{r.strengths}</p>
      <p className="mt-2 text-xs font-semibold text-s-muted">Areas to improve</p>
      <p className="whitespace-pre-wrap break-words text-sm">{r.improvements}</p>
    </article>
  )
}
