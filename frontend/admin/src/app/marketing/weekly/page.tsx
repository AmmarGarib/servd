'use client'
// Marketing → Published vs slipped (owner, 2026-11-03): each board's Karachi week (Mon–Sun) — what was published
// (on time or late), what slipped (deadline passed, not published by it) and what is still open. Exported through
// the one report renderer; the same figures go to the marketing lead and the CEO as a Monday bell notice.
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { Input } from '@/components/finance/ui'
import { fmtDay } from '../board/data'

type Status = 'published_on_time' | 'published_late' | 'slipped' | 'open'
interface WeeklyCard { id: string; title: string; type: string; stage: string | null; owner: string | null; deadline: string; publishedAt: string | null; status: Status }
interface WeeklyBoard { id: string; name: string; kind: string; published: number; publishedOnTime: number; slipped: number; open: number; cards: WeeklyCard[] }
interface Weekly { monday: string; sunday: string; boards: WeeklyBoard[]; totals: { published: number; publishedOnTime: number; slipped: number; open: number } }

const STATUS: Record<Status, { label: string; cls: string }> = {
  published_on_time: { label: 'Published on time', cls: 'text-success' },
  published_late:    { label: 'Published late', cls: 'text-s-amber' },
  slipped:           { label: 'Slipped', cls: 'text-s-red' },
  open:              { label: 'Still open', cls: 'text-s-muted' },
}

const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export default function WeeklyPage() {
  return <Suspense fallback={null}><WeeklyInner /></Suspense>
}

function WeeklyInner() {
  const params = useSearchParams()
  const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
  const [weekOf, setWeekOf] = useState(params.get('weekOf') ?? today)
  const { data, isLoading } = useQuery<Weekly>({ queryKey: ['mkb', 'weekly', weekOf], queryFn: () => api.get(`/marketing-board/report/weekly?weekOf=${weekOf}`) })

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-success">Marketing</p>
          <h1 className="text-xl font-black">Published vs slipped</h1>
          {data && <p className="text-sm text-s-muted">Week of {fmtDay(`${data.monday}T12:00:00Z`)} – {fmtDay(`${data.sunday}T12:00:00Z`)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="Previous week" onClick={() => setWeekOf(shift(data?.monday ?? weekOf, -7))} className="s-btn-secondary flex h-11 w-11 items-center justify-center"><ChevronLeft size={18} aria-hidden="true" /></button>
          <Input type="date" value={weekOf} onChange={(e) => e.target.value && setWeekOf(e.target.value)} className="w-auto" aria-label="Any day of the week" />
          <button type="button" aria-label="Next week" onClick={() => setWeekOf(shift(data?.monday ?? weekOf, 7))} className="s-btn-secondary flex h-11 w-11 items-center justify-center"><ChevronRight size={18} aria-hidden="true" /></button>
          <ExportMenu path={`/marketing-board/report/weekly?weekOf=${weekOf}`} filename={`marketing-published-vs-slipped-${data?.monday ?? weekOf}`} />
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Published', data.totals.published, 'text-success'], ['On time', data.totals.publishedOnTime, 'text-success'], ['Slipped', data.totals.slipped, 'text-s-red'], ['Still open', data.totals.open, 'text-s-text']].map(([l, v, c]) => (
            <div key={l as string} className="rounded-xl border border-s-border bg-s-surface p-3">
              <p className="text-xs text-s-muted">{l}</p>
              <p className={`text-2xl font-black ${c}`}>{v}</p>
            </div>
          ))}
        </div>
      )}

      {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {data && data.boards.length === 0 && <CompactEmptyState message="No boards in view." />}
      {data?.boards.map((b) => (
        <section key={b.id} className="rounded-xl border border-s-border bg-s-surface">
          <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-s-border px-4 py-3">
            <h2 className="font-bold">{b.name}</h2>
            {b.kind === 'platform' && <span className="text-xs text-s-muted">Platform</span>}
            <span className="ml-auto text-sm"><span className="font-bold text-success">{b.published}</span> published ({b.publishedOnTime} on time) · <span className="font-bold text-s-red">{b.slipped}</span> slipped · {b.open} open</span>
          </header>
          {b.cards.length === 0 ? (
            <p className="px-4 py-3 text-sm text-s-muted">Nothing due or published this week.</p>
          ) : (
            <ul className="divide-y divide-s-border">
              {b.cards.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <a href={`/marketing/board?board=${b.id}&card=${c.id}`} className="min-w-0 flex-1 basis-48 break-words font-semibold hover:underline">{c.title}</a>
                  <span className="text-xs text-s-muted">{c.owner ?? 'No owner'}</span>
                  <span className="text-xs text-s-muted">due {fmtDay(c.deadline)}</span>
                  <span className={`text-xs font-bold ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
