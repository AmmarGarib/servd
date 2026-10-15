'use client'
// Messages — the feedback inbox: contact-form messages from the storefront
// (/contact: name, reply phone / email, topic, optional kitchen) beside the
// one-tap NPS / CSAT / suggestion feedback. Same API (GET /feedback), read as
// the signed-in company only. The form never messages the sender; reply by the
// phone or email they gave.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useBrandFilter } from '../../../store/brandFilter'
import { Select } from '@/components/ui/Select'

interface FeedbackRow {
  id: string
  kind: 'nps' | 'csat' | 'open' | 'contact'
  score: number | null
  comment: string | null
  source: string
  createdAt: string
  contactName: string | null
  replyPhone: string | null
  replyEmail: string | null
  topic: string | null
  customer: { id: string; name: string; email: string | null; phone: string | null } | null
  concept: { name: string; slug: string } | null
}

interface Concept { id: string; name: string }

const TOPICS: Array<{ value: string; label: string }> = [
  { value: 'catering', label: 'Catering and events' },
  { value: 'complaint', label: 'Order problem' },
  { value: 'press', label: 'Press and media' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'other', label: 'Something else' },
]
const topicLabel = (t: string | null) => TOPICS.find((x) => x.value === t)?.label ?? t ?? ''
const KIND_LABEL: Record<FeedbackRow['kind'], string> = { contact: 'Contact message', nps: 'NPS', csat: 'Rating', open: 'Suggestion' }

export default function MessagesPage() {
  const [kind, setKind] = useState<string>('contact')
  const [topic, setTopic] = useState('')
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ['feedback-inbox', kind, topic, conceptId],
    queryFn: () => api.get<FeedbackRow[]>(
      `/feedback?${new URLSearchParams({
        ...(kind && { kind }),
        ...(kind === 'contact' && topic && { topic }),
        ...(conceptId && { conceptId }),
        limit: '200',
      }).toString()}`,
    ),
  })

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/reviews" className="text-xs font-semibold text-success hover:underline">← Reviews</Link>
          <h1 className="text-2xl font-black text-s-text mt-1">Messages</h1>
          <p className="text-sm text-s-muted mt-1">
            What guests send from the contact page and the feedback button. Reply by the phone or email they gave: nothing is sent to them automatically.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-3 mb-4">
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setTopic('') }} className={`${inp} w-auto`} aria-label="Type">
          <option value="contact">Contact messages</option>
          <option value="">All feedback</option>
          <option value="open">Suggestions</option>
          <option value="nps">NPS</option>
          <option value="csat">Ratings</option>
        </Select>
        {kind === 'contact' && (
          <Select value={topic} onChange={(e) => setTopic(e.target.value)} className={`${inp} w-auto`} aria-label="Topic">
            <option value="">All topics</option>
            {TOPICS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        )}
        <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={`${inp} w-auto`} aria-label="Brand">
          <option value="">All brands</option>
          {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>

      <div className="rounded-xl border border-s-border overflow-hidden">
        {isLoading && <p className="px-4 py-6 text-center text-s-muted">Loading…</p>}
        {isError && <p className="px-4 py-6 text-center text-s-red">Could not load messages.</p>}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="px-4 py-10 text-center text-s-muted">No messages yet</p>
        )}
        {rows.map((r) => {
          const who = r.contactName ?? r.customer?.name ?? 'Anonymous'
          const phone = r.replyPhone ?? r.customer?.phone ?? null
          const email = r.replyEmail ?? r.customer?.email ?? null
          return (
            <div key={r.id} className="px-4 py-4 border-b border-s-border last:border-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-s-text">{who}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.kind === 'contact' ? 's-badge-purple' : 'bg-s-border text-s-muted'}`}>
                  {KIND_LABEL[r.kind]}
                </span>
                {r.topic && <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold s-badge-green">{topicLabel(r.topic)}</span>}
                {r.score != null && <span className="text-xs text-s-muted">score {r.score}</span>}
                <span className="text-xs text-s-muted">·</span>
                <span className="text-xs text-s-text">{r.concept?.name ?? 'No brand'}</span>
                <span className="text-xs text-s-muted ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.comment && <p className="text-sm text-s-text mt-2 whitespace-pre-wrap">{r.comment}</p>}
              {(phone || email) && (
                <div className="flex flex-wrap gap-4 mt-2 text-xs">
                  {phone && <a href={`tel:${phone}`} className="text-primary hover:underline">Phone {phone}</a>}
                  {phone && r.kind === 'contact' && (
                    <a href={`https://wa.me/${phone.replace(/\D/g, '').replace(/^0/, '92')}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">WhatsApp</a>
                  )}
                  {email && <a href={`mailto:${email}`} className="text-primary hover:underline">{email}</a>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const inp = 'rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'
