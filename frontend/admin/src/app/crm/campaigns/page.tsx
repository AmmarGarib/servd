'use client'
// THE campaign composer. The /crm page used to carry a second one (no brand
// picker, no audience count, "opted-in" wording under an opt-out model, SMS);
// it is gone and its message preview lives here now.
//
// Audience = reachable customers of the active company (unsubscribed and this
// company's banned customers excluded) ∩ the brands picked ∩ the segment
// picked. The number shown comes from the same server-side filter the send
// uses. Channels are email and WhatsApp (owner decision 17 — no SMS).
//
// The one exception is the `waitlist` audience: the servd-wide new-brand
// waitlist (/crm/waitlist). It is not limited to this company's customers, so
// the brand picker does not apply; the server counts and sends it as
// segment=waitlist (opted-out and unsubscribed members excluded).
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'

type Channel = 'email' | 'whatsapp'

interface Campaign {
  id: string
  name: string
  channel: Channel | 'sms'
  status: 'draft' | 'scheduled' | 'sending' | 'sent'
  body: string
  subject: string | null
  sentAt: string | null
  createdAt: string
  segment: { slug: string; name: string | null } | null
  conceptIds?: string[]
  recipientCount?: number | null
}

interface Segment { slug: string; name: string; description: string | null; memberCount: number }
interface Concept { id: string; name: string }

const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none w-full'

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-s-muted/20 text-s-muted',
  scheduled: 'bg-s-blue/20 text-s-blue',
  sending: 'bg-s-blue/20 text-s-blue',
  sent: 'bg-primary/20 text-primary-ink',
}

// Special audience: the servd-level new-brand waitlist (not a nightly segment).
const WAITLIST = 'waitlist'
const WAITLIST_LABEL = 'New-brand waitlist'

const CHANNEL_LABEL: Record<string, string> = { email: 'Email', whatsapp: 'WhatsApp', sms: 'WhatsApp' }

function MessagePreview({ channel, subject, body, name }: { channel: Channel; subject: string; body: string; name: string }) {
  if (channel === 'email') {
    return (
      <div className="rounded-xl border border-s-border bg-s-bg overflow-hidden text-sm">
        <div className="bg-s-surface border-b border-s-border px-4 py-3">
          <p className="text-xs text-s-muted">Subject: <span className="font-semibold text-s-text">{subject || '(no subject)'}</span></p>
        </div>
        <div className="px-4 py-4 whitespace-pre-wrap text-s-text leading-relaxed min-h-[80px]">
          {body || <span className="text-s-muted italic">Message body will appear here</span>}
        </div>
        <p className="px-4 pb-3 text-[10px] text-s-muted">An unsubscribe link is added to every email.</p>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-s-border bg-s-bg p-4">
      <p className="text-xs font-semibold text-s-text mb-2">{name || 'Campaign'} · WhatsApp</p>
      <div className="bg-[#25d366]/10 border border-[#25d366]/20 rounded-xl rounded-tl-none px-3 py-2 text-sm text-s-text whitespace-pre-wrap leading-relaxed min-h-[60px]">
        {body || <span className="text-s-muted italic">Message body will appear here</span>}
        {'\n\n'}<span className="text-s-muted text-xs">Stop these messages: (link)</span>
      </div>
    </div>
  )
}

const EMPTY = { name: '', channel: 'whatsapp' as Channel, subject: '', body: '', segment: '' }

export default function CampaignsPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  // Empty = every brand of the active company.
  const [brandIds, setBrandIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Deep links: /crm/campaigns?segment=<slug> (from /crm/segments) and
  // /crm/campaigns?audience=waitlist (from /crm/waitlist).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search)
    const seg = qs.get('audience') === WAITLIST ? WAITLIST : qs.get('segment')
    if (seg) { setForm((f) => ({ ...f, segment: seg })); setShowForm(true) }
  }, [])
  const isWaitlist = form.segment === WAITLIST

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<Campaign[]>('/crm/campaigns'),
  })

  const { data: segments = [] } = useQuery({
    queryKey: ['behavioral-segments'],
    queryFn: () => api.get<Segment[]>('/crm/behavioral-segments'),
  })

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })
  const conceptName = (id: string) => concepts.find((c) => c.id === id)?.name ?? 'brand'

  // The number shown is the number the send will use — same filter server-side.
  const { data: audience } = useQuery({
    queryKey: ['campaign-audience', isWaitlist ? '' : brandIds.join(','), form.segment, form.channel],
    queryFn: () => api.get<{ total: number; optedOut: number }>(
      `/crm/campaigns/audience?channel=${form.channel}` +
      (brandIds.length && !isWaitlist ? `&conceptIds=${brandIds.join(',')}` : '') +
      (form.segment ? `&segment=${encodeURIComponent(form.segment)}` : ''),
    ),
    enabled: showForm,
  })

  // Live size of the waitlist audience for the option label, same endpoint.
  const { data: waitlistAudience } = useQuery({
    queryKey: ['campaign-audience', '', WAITLIST, form.channel],
    queryFn: () => api.get<{ total: number; optedOut: number }>(`/crm/campaigns/audience?channel=${form.channel}&segment=${WAITLIST}`),
    enabled: showForm,
  })

  const reset = () => {
    setShowForm(false)
    setForm(EMPTY)
    setBrandIds([])
    setError(null)
  }

  const create = useMutation({
    mutationFn: async (sendNow: boolean) => {
      const c = await api.post<Campaign>('/crm/campaigns', {
        name: form.name,
        channel: form.channel,
        subject: form.channel === 'email' ? form.subject : undefined,
        body: form.body,
        segment: form.segment || null,
        conceptIds: isWaitlist ? [] : brandIds,
      })
      if (sendNow) await api.post(`/crm/campaigns/${c.id}/send`, {})
      return c
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['campaigns'] }); reset() },
    onError: (e: Error) => setError(e.message),
  })

  const send = useMutation({
    mutationFn: (id: string) => api.post(`/crm/campaigns/${id}/send`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaigns'] }),
    onError: (e: Error) => alert(e.message),
  })

  const canSave = !!form.name && !!form.body && (form.channel !== 'email' || !!form.subject)
  const segName = (slug: string) => slug === WAITLIST ? WAITLIST_LABEL : segments.find((s) => s.slug === slug)?.name ?? slug

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/crm" className="text-s-muted text-sm hover:text-s-text">← CRM</Link>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Campaigns</h1>
          <p className="text-sm text-s-muted">Email and WhatsApp broadcasts to a segment of your customers</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90">
          + New campaign
        </button>
      </header>

      <div className="p-6 max-w-5xl mx-auto">
        {showForm && (
          <form onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(false) }}
            className="rounded-xl border border-primary bg-s-surface p-5 mb-6">
            <p className="font-bold text-s-text mb-4">New campaign</p>
            {error && <p className="mb-3 rounded-lg bg-s-red/10 border border-s-red/30 px-3 py-2 text-sm text-s-red">{error}</p>}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 grid grid-cols-2 gap-4 content-start">
                <div>
                  <label className="text-xs text-s-muted mb-1 block">Campaign name *</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Ramadan special" required className={inp} />
                </div>
                <div>
                  <label className="text-xs text-s-muted mb-1 block">Channel *</label>
                  <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })} className={inp}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </div>
                {form.channel === 'email' && (
                  <div className="col-span-2">
                    <label className="text-xs text-s-muted mb-1 block">Subject *</label>
                    <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}
                      placeholder="Something new on the menu" className={inp} />
                  </div>
                )}
                <div className="col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-s-muted">Message *</label>
                    <span className="text-xs text-s-muted">{form.body.length}/2000</span>
                  </div>
                  <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value.slice(0, 2000) })}
                    placeholder="Write your message…" required rows={5}
                    className={`${inp} resize-y`} />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-s-muted mb-1 block">Segment</label>
                  <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} className={inp}>
                    <option value="">Everyone reachable in the brands below</option>
                    {segments.map((s) => (
                      <option key={s.slug} value={s.slug}>{s.name} — {s.memberCount.toLocaleString()}</option>
                    ))}
                    <option value={WAITLIST}>
                      {WAITLIST_LABEL} (all of servd){waitlistAudience ? ` — ${waitlistAudience.total.toLocaleString()}` : ''}
                    </option>
                  </select>
                  <p className="text-xs text-s-muted mt-1">
                    {isWaitlist
                      ? <>Everyone who joined the <Link href="/crm/waitlist" className="underline">new-brand waitlist</Link> and hasn&apos;t unsubscribed — across all of servd, not only this company&apos;s customers.</>
                      : <>Segments are computed nightly per company — see <Link href="/crm/segments" className="underline">Segments</Link>.</>}
                  </p>
                </div>
                <div className="col-span-2">
                  {!isWaitlist && <>
                  <label className="text-xs text-s-muted mb-1 block">Brands</label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setBrandIds([])}
                      className={`rounded-full px-3 py-1 text-xs font-bold border ${brandIds.length === 0 ? 'bg-primary text-primary-on border-primary' : 'border-s-border text-s-muted'}`}>
                      All brands
                    </button>
                    {concepts.map((c) => {
                      const on = brandIds.includes(c.id)
                      return (
                        <button type="button" key={c.id}
                          onClick={() => setBrandIds(on ? brandIds.filter((x) => x !== c.id) : [...brandIds, c.id])}
                          className={`rounded-full px-3 py-1 text-xs font-bold border ${on ? 'bg-primary text-primary-on border-primary' : 'border-s-border text-s-muted'}`}>
                          {c.name}
                        </button>
                      )
                    })}
                  </div>
                  </>}
                  <p className="text-xs text-s-muted mt-2">
                    {audience
                      ? <>Reaches <strong className="text-s-text">{audience.total.toLocaleString()}</strong> {isWaitlist ? 'waitlist member' : 'customer'}{audience.total === 1 ? '' : 's'} with {form.channel === 'email' ? 'an email' : 'a phone number'}
                          {audience.optedOut > 0 && <> · {audience.optedOut.toLocaleString()} unsubscribed and excluded</>}</>
                      : 'Counting…'}
                    {' '}Every message carries an unsubscribe link.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wide">Preview</p>
                <MessagePreview channel={form.channel} subject={form.subject} body={form.body} name={form.name} />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button type="submit" disabled={create.isPending || !canSave}
                className="rounded-xl border border-s-border text-s-text text-sm font-bold px-4 py-2 hover:border-s-border-strong disabled:opacity-50">
                {create.isPending ? 'Saving…' : 'Save as draft'}
              </button>
              <button type="button" disabled={create.isPending || !canSave}
                onClick={() => {
                  if (confirm(`Send "${form.name}" now to ${audience?.total.toLocaleString() ?? 'all'} customers?`)) { setError(null); create.mutate(true) }
                }}
                className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                Save and send now
              </button>
              <button type="button" onClick={reset}
                className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </form>
        )}

        {isLoading ? (
          <p className="text-s-muted text-sm">Loading…</p>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-16">
            <p className="font-semibold text-s-text">No campaigns yet</p>
            <p className="text-sm text-s-muted mt-1">Create a broadcast to reach your customers</p>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border border-s-border bg-s-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded bg-s-bg border border-s-border px-2 py-0.5 text-xs text-s-muted">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                      <p className="font-bold text-s-text">{c.name}</p>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_COLORS[c.status] ?? ''}`}>
                        {c.status}
                      </span>
                      <span className="rounded bg-s-bg border border-s-border px-2 py-0.5 text-xs text-s-muted">
                        {c.segment?.slug === WAITLIST ? 'All of servd' : c.conceptIds && c.conceptIds.length > 0 ? c.conceptIds.map(conceptName).join(', ') : 'All brands'}
                      </span>
                      {c.segment && (
                        <span className="rounded bg-s-bg border border-s-border px-2 py-0.5 text-xs text-s-muted">
                          {c.segment.slug === 'legacy' ? c.segment.name : segName(c.segment.slug)}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-s-muted mt-1 truncate">{c.body}</p>
                    <p className="text-xs text-s-muted/60 mt-1">
                      Created {formatDistanceToNowStrict(new Date(c.createdAt))} ago
                      {c.sentAt && ` · Sent ${formatDistanceToNowStrict(new Date(c.sentAt))} ago`}
                      {c.sentAt && c.recipientCount != null && ` to ${c.recipientCount.toLocaleString()}`}
                    </p>
                  </div>
                  {c.status !== 'sent' && c.segment?.slug !== 'legacy' && (
                    <button
                      onClick={() => { if (confirm(`Send "${c.name}" now to all recipients?`)) send.mutate(c.id) }}
                      disabled={send.isPending}
                      className="rounded-xl bg-primary text-primary-on text-xs font-bold px-3 py-1.5 hover:opacity-90 disabled:opacity-50 shrink-0">
                      {send.isPending ? 'Sending…' : 'Send now'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
