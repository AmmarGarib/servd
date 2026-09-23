'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'

interface Campaign {
  id: string
  name: string
  channel: 'email' | 'sms' | 'whatsapp'
  status: 'draft' | 'scheduled' | 'sent'
  body: string
  subject: string | null
  scheduledAt: string | null
  sentAt: string | null
  createdAt: string
  segment: { name: string } | null
  conceptIds?: string[]
  recipientCount?: number | null
}

interface Segment { id: string; name: string }
interface Concept { id: string; name: string }

const inp = 'rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none w-full'

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-kds-subtext/20 text-kds-subtext',
  scheduled: 'bg-kds-blue/20 text-kds-blue',
  sent: 'bg-kds-green/20 text-kds-green',
}

const CHANNEL_ICONS: Record<string, string> = { email: '✉', sms: '💬', whatsapp: '📱' }

export default function CampaignsPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '', channel: 'sms' as 'email' | 'sms' | 'whatsapp',
    subject: '', body: '', segmentId: '', scheduledAt: '',
  })
  // Empty = every brand. Campaigns reach everyone we hold contact details for
  // unless they unsubscribed; brands narrow that down when you want them to.
  const [brandIds, setBrandIds] = useState<string[]>([])

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<Campaign[]>('/crm/campaigns'),
  })

  const { data: segments = [] } = useQuery({
    queryKey: ['segments'],
    queryFn: () => api.get<Segment[]>('/crm/segments'),
  })

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })
  const conceptName = (id: string) => concepts.find((c) => c.id === id)?.name ?? 'brand'

  // The number shown is the number the send will use — same filter server-side.
  const { data: audience } = useQuery({
    queryKey: ['campaign-audience', brandIds.join(','), form.segmentId, form.channel],
    queryFn: () => api.get<{ total: number; optedOut: number }>(
      `/crm/campaigns/audience?channel=${form.channel}` +
      (brandIds.length ? `&conceptIds=${brandIds.join(',')}` : '') +
      (form.segmentId ? `&segmentId=${form.segmentId}` : ''),
    ),
    enabled: showForm,
  })

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/crm/campaigns', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['campaigns'] })
      setShowForm(false)
      setForm({ name: '', channel: 'sms', subject: '', body: '', segmentId: '', scheduledAt: '' })
      setBrandIds([])
    },
  })

  const send = useMutation({
    mutationFn: (id: string) => api.post(`/crm/campaigns/${id}/send`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaigns'] }),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    create.mutate({
      name: form.name,
      channel: form.channel,
      subject: form.subject || undefined,
      body: form.body,
      segmentId: form.segmentId || null,
      conceptIds: brandIds,
      scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
    })
  }

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/crm" className="text-kds-subtext text-sm hover:text-kds-text">← CRM</Link>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Campaigns</h1>
          <p className="text-sm text-kds-subtext">Email, SMS and WhatsApp broadcasts</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-xl bg-kds-green text-black text-sm font-bold px-4 py-2 hover:opacity-90">
          + New campaign
        </button>
      </header>

      <div className="p-6 max-w-4xl mx-auto">
        {showForm && (
          <form onSubmit={submit} className="rounded-xl border border-kds-green bg-kds-card p-5 mb-6 space-y-4">
            <p className="font-bold text-kds-text">New campaign</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Campaign name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ramadan Special" required className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Channel *</label>
                <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })} className={inp}>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
              {form.channel === 'email' && (
                <div className="col-span-2">
                  <label className="text-xs text-kds-subtext mb-1 block">Subject *</label>
                  <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="Special offer just for you 🎉" className={inp} />
                </div>
              )}
              <div className="col-span-2">
                <label className="text-xs text-kds-subtext mb-1 block">Message body *</label>
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                  placeholder="Hi {name}, here's your exclusive offer…" required rows={3}
                  className={`${inp} resize-none`} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-kds-subtext mb-1 block">Brands</label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setBrandIds([])}
                    className={`rounded-full px-3 py-1 text-xs font-bold border ${brandIds.length === 0 ? 'bg-kds-green text-black border-kds-green' : 'border-kds-border text-kds-subtext'}`}>
                    All brands
                  </button>
                  {concepts.map((c) => {
                    const on = brandIds.includes(c.id)
                    return (
                      <button type="button" key={c.id}
                        onClick={() => setBrandIds(on ? brandIds.filter((x) => x !== c.id) : [...brandIds, c.id])}
                        className={`rounded-full px-3 py-1 text-xs font-bold border ${on ? 'bg-kds-green text-black border-kds-green' : 'border-kds-border text-kds-subtext'}`}>
                        {c.name}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-kds-subtext mt-2">
                  {audience
                    ? <>Reaches <strong className="text-kds-text">{audience.total.toLocaleString()}</strong> customer{audience.total === 1 ? '' : 's'} with {form.channel === 'email' ? 'an email' : 'a phone number'}
                        {audience.optedOut > 0 && <> · {audience.optedOut.toLocaleString()} unsubscribed and excluded</>}</>
                    : 'Counting…'}
                  {' '}Every message carries an unsubscribe link.
                </p>
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Segment (optional)</label>
                <select value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })} className={inp}>
                  <option value="">Everyone in the brands above</option>
                  {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Schedule for (optional)</label>
                <input type="datetime-local" value={form.scheduledAt}
                  onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} className={inp} />
              </div>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={create.isPending}
                className="rounded-xl bg-kds-green text-black text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {create.isPending ? 'Saving…' : 'Save as draft'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="rounded-xl border border-kds-border text-kds-subtext text-sm px-4 py-2 hover:border-kds-text">
                Cancel
              </button>
            </div>
          </form>
        )}

        {isLoading ? (
          <p className="text-kds-subtext text-sm">Loading…</p>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-3">📣</p>
            <p className="font-semibold text-kds-text">No campaigns yet</p>
            <p className="text-sm text-kds-subtext mt-1">Create a broadcast to reach your customers</p>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border border-kds-border bg-kds-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-lg">{CHANNEL_ICONS[c.channel]}</span>
                      <p className="font-bold text-kds-text">{c.name}</p>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_COLORS[c.status] ?? ''}`}>
                        {c.status}
                      </span>
                      <span className="rounded bg-kds-bg border border-kds-border px-2 py-0.5 text-xs text-kds-subtext">
                        {c.conceptIds && c.conceptIds.length > 0 ? c.conceptIds.map(conceptName).join(', ') : 'All brands'}
                      </span>
                      {c.segment && (
                        <span className="rounded bg-kds-bg border border-kds-border px-2 py-0.5 text-xs text-kds-subtext">
                          {c.segment.name}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-kds-subtext mt-1 truncate">{c.body}</p>
                    <p className="text-xs text-kds-subtext/60 mt-1">
                      Created {formatDistanceToNowStrict(new Date(c.createdAt))} ago
                      {c.sentAt && ` · Sent ${formatDistanceToNowStrict(new Date(c.sentAt))} ago`}
                      {c.sentAt && c.recipientCount != null && ` to ${c.recipientCount.toLocaleString()}`}
                      {c.scheduledAt && c.status === 'scheduled' && ` · Scheduled for ${new Date(c.scheduledAt).toLocaleString()}`}
                    </p>
                  </div>
                  {c.status !== 'sent' && (
                    <button
                      onClick={() => { if (confirm(`Send "${c.name}" now to all recipients?`)) send.mutate(c.id) }}
                      disabled={send.isPending}
                      className="rounded-xl bg-kds-green text-black text-xs font-bold px-3 py-1.5 hover:opacity-90 disabled:opacity-50 shrink-0">
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
