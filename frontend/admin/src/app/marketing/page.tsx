'use client'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface PerformanceData {
  windowDays: number
  since: string
  campaigns: number
  promosCreated: number
  promoUsages: number
  contentEvents: number
  mediaUploads: number
  totalActions: number
}

interface ActivityRow {
  id: string
  action: string
  entity: string | null
  entityId: string | null
  userEmail: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

const ACTION_LABEL: Record<string, { emoji: string; label: string }> = {
  'campaign.create':         { emoji: '✉️', label: 'Drafted campaign' },
  'campaign.send':           { emoji: '📨', label: 'Sent campaign' },
  'campaign.update':         { emoji: '✏️', label: 'Edited campaign' },
  'promo.create':            { emoji: '🎟', label: 'Created promo' },
  'promo.update':            { emoji: '✏️', label: 'Updated promo' },
  'promo.deactivate':        { emoji: '🛑', label: 'Deactivated promo' },
  'discount.create':         { emoji: '🏷', label: 'Added discount' },
  'discount.update':         { emoji: '✏️', label: 'Updated discount' },
  'concept.update':          { emoji: '🏢', label: 'Edited brand' },
  'storefront.layout.update': { emoji: '🎨', label: 'Updated storefront' },
  'media.upload':            { emoji: '🖼', label: 'Uploaded media' },
  'content_event.create':    { emoji: '📅', label: 'Scheduled post' },
  'content_event.publish':   { emoji: '🚀', label: 'Published post' },
}

export default function MarketingWorkspacePage() {
  const { data: perf } = useQuery<PerformanceData>({
    queryKey: ['marketing-performance', 30],
    queryFn: () => api.get('/marketing/performance?days=30'),
  })
  const { data: activity = [] } = useQuery<ActivityRow[]>({
    queryKey: ['marketing-activity', 14],
    queryFn: () => api.get('/marketing/activity?days=14&limit=20'),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Marketing</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Marketing Workspace</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Everything an agency or in-house marketer needs in one place. Every action here gets logged so the brand owner can audit work and impact.
        </p>
      </header>

      <div className="px-7 py-7 max-w-[1200px] mx-auto space-y-7">
        {/* Last-30-day KPI strip */}
        {perf && (
          <section>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Last 30 days</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Kpi label="Campaigns sent"    value={perf.campaigns}     emoji="📨" color="#00D4B1" />
              <Kpi label="Promo codes"       value={perf.promosCreated} emoji="🎟" color="#6366F1" />
              <Kpi label="Promo redemptions" value={perf.promoUsages}   emoji="✅" color="#22C55E" />
              <Kpi label="Scheduled posts"   value={perf.contentEvents} emoji="📅" color="#F59E0B" />
              <Kpi label="Media uploads"     value={perf.mediaUploads}  emoji="🖼" color="#A855F7" />
              <Kpi label="Total actions"     value={perf.totalActions}  emoji="⚡" color="#FFFFFF" />
            </div>
          </section>
        )}

        {/* Tools grid */}
        <section>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Tools</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Tool href="/crm/campaigns"        emoji="✉️" title="Campaigns"        desc="Email / SMS / WhatsApp blasts to customer segments." color="#00D4B1" />
            <Tool href="/crm/segments"         emoji="🎯" title="Segments"         desc="Computed per company: VIPs, lapsed, first-timers, repeat." color="#6366F1" />
            <Tool href="/promos"               emoji="🎟" title="Promo codes"      desc="Create + retire promo codes; track redemptions." color="#22C55E" />
            <Tool href="/discounts"            emoji="🏷" title="Discounts"        desc="Time-limited section / category discounts." color="#F59E0B" />
            <Tool href="/calendar"             emoji="📅" title="Content calendar" desc="Schedule social posts; one-click Instagram / Meta publish." color="#EC4899" />
            <Tool href="/marketing/brands"     emoji="🏷" title="Brand editor"     desc="Logo, colour, tagline, banner, hours per brand." color="#0EA5E9" />
            <Tool href="/storefront"           emoji="🎨" title="Storefront"       desc="Library, page builder, pop-ups; the CEO approves every change." color="#F472B6" />
            <Tool href="/analytics"            emoji="📊" title="Analytics"        desc="Funnel, conversion, top items, search insights." color="#FCD34D" />
          </div>
        </section>

        {/* Recent activity */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">Recent activity (last 14 days)</p>
            <Link href="/marketing/activity" className="text-xs text-kds-green hover:underline">Full activity log →</Link>
          </div>

          <div className="rounded-2xl overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {activity.length === 0 ? (
              <div className="p-8 text-center text-white/45">
                <p className="text-3xl mb-2">📭</p>
                <p className="text-sm">No marketing activity in the last 14 days.</p>
                <p className="text-xs mt-1 text-white/30">Start a campaign or schedule a post to see it here.</p>
              </div>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {activity.map((row) => {
                  const meta = ACTION_LABEL[row.action] ?? { emoji: '•', label: row.action }
                  return (
                    <div key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-lg shrink-0">{meta.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white/85">
                          <span className="font-bold">{meta.label}</span>
                          {row.entity && <span className="text-white/45"> · {row.entity}</span>}
                        </p>
                        <p className="text-[10px] text-white/35">
                          {row.userEmail ?? 'system'} · {timeAgo(row.createdAt)}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function Kpi({ label, value, emoji, color }: { label: string; value: number; emoji: string; color: string }) {
  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="text-lg">{emoji}</div>
      <p className="text-2xl font-black mt-1.5" style={{ color }}>{value.toLocaleString()}</p>
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 mt-1">{label}</p>
    </div>
  )
}

function Tool({ href, emoji, title, desc, color }: { href: string; emoji: string; title: string; desc: string; color: string }) {
  return (
    <Link href={href}
      className="rounded-2xl p-5 transition-all hover:-translate-y-0.5 group"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-3xl">{emoji}</span>
        <span className="text-[10px] font-black uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color }}>
          Open →
        </span>
      </div>
      <p className="font-black text-white/90">{title}</p>
      <p className="text-xs text-white/45 mt-1 leading-relaxed">{desc}</p>
    </Link>
  )
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })
}
