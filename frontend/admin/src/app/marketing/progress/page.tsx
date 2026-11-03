'use client'
// My progress (owner, 2026-11-03): an intern's / designer's own page — their cards, their weekly notes and only the
// monthly reviews that were shared with them. The API returns the caller's own record and nothing else.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import type { Card } from '../board/data'
import type { CheckIn, Review, Stats } from '../tracker/data'
import { CardsList, NotesList, ReviewCard, StatsRow } from '../tracker/Parts'

interface Mine { id: string; roleLabel: string; startDate: string; endDate: string | null; active: boolean; cards: Card[]; stats: Stats; checkIns: CheckIn[]; reviews: Review[] }

export default function MyProgressPage() {
  const { data, isLoading, error } = useQuery<{ records: Mine[] }>({ queryKey: ['mkt-progress'], queryFn: () => api.get('/marketing-progress/me'), retry: false })
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-5 sm:px-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-success">Marketing</p>
        <h1 className="text-xl font-black">My progress</h1>
      </div>
      {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {(error || (data && data.records.length === 0)) && (
        <CompactEmptyState message="No progress record yet." detail="Your marketing lead starts one when you join the team." />
      )}
      {data?.records.map((r) => (
        <div key={r.id} className="space-y-5">
          <p className="text-sm text-s-muted">{r.roleLabel} · since {r.startDate.slice(0, 10)}{r.endDate ? ` until ${r.endDate.slice(0, 10)}` : ''}</p>
          <StatsRow stats={r.stats} />
          <section className="space-y-2">
            <h2 className="font-bold">My cards</h2>
            <CardsList cards={r.cards} linkable />
          </section>
          <section className="space-y-2">
            <h2 className="font-bold">Weekly notes</h2>
            <NotesList notes={r.checkIns} />
          </section>
          <section className="space-y-2">
            <h2 className="font-bold">Monthly reviews</h2>
            {r.reviews.length === 0 && <p className="text-sm text-s-muted">No reviews shared with you yet.</p>}
            {r.reviews.map((rv) => <ReviewCard key={rv.id} r={rv} />)}
          </section>
        </div>
      ))}
    </div>
  )
}
