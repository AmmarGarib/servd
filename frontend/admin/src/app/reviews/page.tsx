'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ReachOutModal } from '../../components/crm/ReachOutModal'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'
import { useBrandFilter } from '../../store/brandFilter'
import { orderRef } from '../../lib/orderRef'

interface Review {
  id: string
  orderId: string
  conceptId: string
  customerId: string | null
  rating: number
  comment: string | null
  source: string
  createdAt: string
  order: {
    id: string; source: string; customerName: string | null; placedAt: string
    customer?: { id: string; name: string; email: string | null; phone: string | null } | null
  } | null
  concept: {
    name: string; slug: string; tenantId?: string | null
    tenant?: { id: string; name: string; slug: string } | null
  }
}

interface ReviewsResponse {
  reviews: Review[]
  average: number | null
  total: number
}

interface Concept { id: string; name: string }

const STARS = [1, 2, 3, 4, 5]

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="text-sm">
      {STARS.map((s) => (
        <span key={s} className={s <= rating ? 'text-yellow-700' : 'text-s-border'}>★</span>
      ))}
    </span>
  )
}

export default function ReviewsPage() {
  const qc = useQueryClient()
  const { data: tenants = [] } = useMyTenants()
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [ratingFilter, setRatingFilter] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [manualForm, setManualForm] = useState({ conceptId: '', rating: 5, comment: '', source: 'manual' })
  const [reachingOut, setReachingOut] = useState<Review | null>(null)

  // Brand list from GET /concepts?view=picker (every staff role, the active
  // brands of its own companies, id + name) — plain /concepts is managers /
  // till only and 403'd for the roles that hold this page (R2-UI-04).
  // Shares the shell BrandPicker's cache key and shape.
  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['reviews', conceptId, ratingFilter],
    queryFn: () => api.get<ReviewsResponse>(
      `/reviews?${new URLSearchParams({
        ...(conceptId && { conceptId }),
        ...(ratingFilter && { rating: ratingFilter }),
        limit: '100',
      }).toString()}`
    ),
  })

  const manualMutation = useMutation({
    mutationFn: (body: typeof manualForm) => api.post('/reviews/manual', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reviews'] })
      setShowManual(false)
      setManualForm({ conceptId: '', rating: 5, comment: '', source: 'manual' })
    },
  })

  const reviews = data?.reviews ?? []
  const ratingDist = STARS.map((s) => ({
    stars: s,
    count: reviews.filter((r) => r.rating === s).length,
  })).reverse()

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-1">Order Reviews</h1>
        </div>
        <button onClick={() => setShowManual(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Log manual review
        </button>
      </header>

      {/* Manual review form */}
      {showManual && (
        <div className="mb-6 rounded-xl border border-primary bg-s-surface p-4 space-y-3 max-w-lg">
          <h3 className="font-bold text-s-text">Log Manual Review</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-s-muted">Concept</label>
              <select value={manualForm.conceptId} onChange={(e) => setManualForm({ ...manualForm, conceptId: e.target.value })}
                className={inp}>
                <option value="">Select…</option>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Rating</label>
              <select value={manualForm.rating} onChange={(e) => setManualForm({ ...manualForm, rating: Number(e.target.value) })}
                className={inp}>
                {STARS.map((s) => <option key={s} value={s}>{s} star{s > 1 ? 's' : ''}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-s-muted">Comment (optional)</label>
              <textarea value={manualForm.comment} rows={2}
                onChange={(e) => setManualForm({ ...manualForm, comment: e.target.value })}
                className={`${inp} resize-none`} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => manualMutation.mutate(manualForm)} disabled={!manualForm.conceptId || manualMutation.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {manualMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setShowManual(false)} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="rounded-xl border border-s-border bg-s-surface p-4">
          <p className="text-xs text-s-muted">Total reviews</p>
          <p className="text-3xl font-black text-s-text">{data?.total ?? '—'}</p>
        </div>
        <div className="rounded-xl border border-s-border bg-s-surface p-4">
          <p className="text-xs text-s-muted">Average rating</p>
          <p className="text-3xl font-black text-s-amber">{data?.average ?? '—'}</p>
          {data?.average && <StarRating rating={Math.round(data.average)} />}
        </div>
        <div className="rounded-xl border border-s-border bg-s-surface p-4 col-span-2">
          <p className="text-xs text-s-muted mb-2">Distribution</p>
          <div className="space-y-1">
            {ratingDist.map(({ stars, count }) => (
              <div key={stars} className="flex items-center gap-2">
                <span className="text-xs text-s-muted w-4">{stars}★</span>
                <div className="flex-1 h-2 rounded-full bg-s-border overflow-hidden">
                  <div className="h-full rounded-full bg-yellow-400 transition-all"
                    style={{ width: reviews.length ? `${(count / reviews.length) * 100}%` : '0%' }} />
                </div>
                <span className="text-xs text-s-muted w-6 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={`${inp} w-auto`}>
          <option value="">All concepts</option>
          {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)} className={`${inp} w-auto`}>
          <option value="">All ratings</option>
          {STARS.map((s) => <option key={s} value={s}>{s} star{s > 1 ? 's' : ''}</option>)}
        </select>
      </div>

      {/* Reviews list */}
      <div className="rounded-xl border border-s-border overflow-hidden">
        {isLoading && <p className="px-4 py-6 text-center text-s-muted">Loading…</p>}
        {!isLoading && reviews.length === 0 && (
          <p className="px-4 py-10 text-center text-s-muted">No reviews yet</p>
        )}
        {reviews.map((r) => (
          <div key={r.id} className="flex items-start gap-4 px-4 py-4 border-b border-s-border last:border-0">
            {/* Rating circle */}
            <div className={`h-12 w-12 rounded-full shrink-0 flex items-center justify-center text-xl font-black
              ${r.rating >= 4 ? 'bg-primary/20 text-primary-ink' : r.rating === 3 ? 'bg-s-amber/20 text-s-amber' : 'bg-s-red/20 text-s-red'}`}>
              {r.rating}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <StarRating rating={r.rating} />
                <span className="text-xs text-s-muted">·</span>
                <span className="text-xs font-medium text-s-text">{r.concept.name}</span>
                <TenantChip tenant={r.concept.tenant} tenantId={r.concept.tenantId} tenants={tenants} />
                {r.order?.customerName && (
                  <>
                    <span className="text-xs text-s-muted">·</span>
                    <span className="text-xs text-s-muted">{r.order.customerName}</span>
                  </>
                )}
                <span className="text-xs text-s-muted ml-auto">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
              {r.comment && <p className="text-sm text-s-text mt-1">{r.comment}</p>}
              <div className="flex gap-3 mt-1 items-center">
                <span className="text-xs text-s-muted capitalize">{r.source}</span>
                {r.order && (
                  <span className="text-xs text-s-muted">Order {orderRef(r.order.id)}</span>
                )}
                {/* Reach-out CTA: low-rating reviews are the most valuable to follow up on,
                    so the button only appears for ≤3-star reviews with a reachable customer.
                    Higher ratings are positive signals — no chase needed. */}
                {r.rating <= 3 && r.order?.customer && (r.order.customer.email || r.order.customer.phone) && (
                  <button onClick={() => setReachingOut(r)}
                    className="ml-auto rounded-lg border border-blue-400 text-blue-700 px-2.5 py-0.5 text-[11px] hover:bg-blue-400/10 transition-colors">
                    💬 Reach out
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {reachingOut && reachingOut.order?.customer && (
        <ReachOutModal
          context={{
            source: 'review',
            sourceRefId: reachingOut.id,
            contextTitle: `${reachingOut.rating}★ review`,
            contextSubtitle: reachingOut.comment ? `"${reachingOut.comment.slice(0, 60)}${reachingOut.comment.length > 60 ? '…' : ''}"` : undefined,
            conceptName: reachingOut.concept.name,
            customer: reachingOut.order.customer,
          }}
          onClose={() => setReachingOut(null)}
          onSent={() => {
            setReachingOut(null)
            void qc.invalidateQueries({ queryKey: ['reviews'] })
          }}
        />
      )}
    </div>
  )
}

const inp = 'rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'
