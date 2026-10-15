'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { Select } from '@/components/ui/Select'

interface MarketingUser {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
  lastActionAt: string | null
  lastAction: string | null
}

interface ActivityRow {
  id: string
  action: string
  entity: string | null
  entityId: string | null
  userId: string | null
  userEmail: string | null
  before: unknown
  after: unknown
  metadata: Record<string, unknown> | null
  createdAt: string
}

const ACTION_META: Record<string, { emoji: string; label: string; color: string }> = {
  'campaign.create':         { emoji: '✉️', label: 'Drafted campaign',       color: 'var(--erp-primary-ink)' },
  'campaign.send':           { emoji: '📨', label: 'Sent campaign',          color: '#3f7d20' },
  'campaign.update':         { emoji: '✏️', label: 'Edited campaign',        color: 'var(--muted)' },
  'promo.create':            { emoji: '🎟', label: 'Created promo',          color: 'var(--erp-secondary)' },
  'promo.update':            { emoji: '✏️', label: 'Updated promo',          color: 'var(--muted)' },
  'promo.deactivate':        { emoji: '🛑', label: 'Deactivated promo',      color: '#b42318' },
  'discount.create':         { emoji: '🏷', label: 'Added discount',         color: '#a15c00' },
  'discount.update':         { emoji: '✏️', label: 'Updated discount',       color: 'var(--muted)' },
  'concept.update':          { emoji: '🏢', label: 'Edited brand',           color: '#1d4ed8' },
  'storefront.layout.update': { emoji: '🎨', label: 'Updated storefront',    color: '#be185d' },
  'media.upload':            { emoji: '🖼', label: 'Uploaded media',         color: 'var(--erp-primary-ink)' },
  'content_event.create':    { emoji: '📅', label: 'Scheduled post',         color: '#F472B6' },
  'content_event.publish':   { emoji: '🚀', label: 'Published post',         color: '#3f7d20' },
}

export default function MarketingActivityPage() {
  const [days, setDays] = useState(30)
  const [userId, setUserId] = useState<string>('')

  const { data: team = [] } = useQuery<MarketingUser[]>({
    queryKey: ['marketing-team'],
    queryFn: () => api.get('/marketing/team'),
  })
  const { data: activity = [], isLoading } = useQuery<ActivityRow[]>({
    queryKey: ['marketing-activity-full', days, userId],
    queryFn: () => {
      const params = new URLSearchParams({ days: String(days), limit: '500' })
      if (userId) params.set('userId', userId)
      return api.get(`/marketing/activity?${params.toString()}`)
    },
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/w/marketing" className="hover:text-white/70">← Marketing</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">📋 Marketing Activity Log</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Every campaign, promo, brand edit, and creative upload — with the user, timestamp, and before/after diff. Use this to audit what your agency is producing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="rounded-lg px-3 py-2 text-xs"
              style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </Select>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}
              className="rounded-lg px-3 py-2 text-xs"
              style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
              <option value="">All users</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>{u.name} · {u.email}</option>
              ))}
            </Select>
          </div>
        </div>
      </header>

      <div className="px-7 py-7 max-w-[1200px] mx-auto space-y-6">
        {/* Marketing team snapshot */}
        <section>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Marketing team ({team.length})</p>
          {team.length === 0 ? (
            <div className="rounded-xl p-5 text-sm text-white/45"
              style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              No marketing-role users yet. Create one in <Link href="/workforce" className="text-primary-ink hover:underline">Workforce</Link> with role = <code>marketing</code>.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {team.map((u) => (
                <div key={u.id}
                  className="rounded-2xl p-4 cursor-pointer transition-colors"
                  style={{
                    background: userId === u.id ? 'rgb(var(--erp-primary-rgb) / 0.06)' : 'rgb(var(--fg-rgb) / 0.025)',
                    border: userId === u.id ? '1px solid rgb(var(--erp-primary-rgb) / 0.35)' : '1px solid rgb(var(--fg-rgb) / 0.06)',
                  }}
                  onClick={() => setUserId(userId === u.id ? '' : u.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-white/85 truncate">{u.name}</p>
                      <p className="text-xs text-white/45 truncate">{u.email}</p>
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 shrink-0">{u.role}</span>
                  </div>
                  <div className="text-[11px] text-white/45 mt-2">
                    {u.lastActionAt
                      ? <>Last active: {timeAgo(u.lastActionAt)}{u.lastAction && <span className="text-white/30"> · {u.lastAction}</span>}</>
                      : 'No activity yet'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Activity feed */}
        <section>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">
            Activity ({activity.length}{userId && ' for selected user'})
          </p>

          {isLoading && <p className="text-sm text-white/40">Loading…</p>}

          {!isLoading && activity.length === 0 && (
            <div className="rounded-2xl p-8 text-center"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <p className="text-3xl mb-2">📭</p>
              <p className="text-sm text-white/65">No activity in the selected window.</p>
            </div>
          )}

          <div className="rounded-2xl overflow-hidden"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="divide-y divide-white/[0.04]">
              {activity.map((row) => {
                const meta = ACTION_META[row.action] ?? { emoji: '•', label: row.action, color: 'var(--muted)' }
                return (
                  <details key={row.id} className="group">
                    <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-3 hover:bg-white/[0.015]">
                      <span className="text-xl shrink-0">{meta.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold" style={{ color: meta.color }}>{meta.label}</span>
                          {row.entity && (
                            <span className="text-xs text-white/45 font-mono">{row.entity}{row.entityId && ` · ${row.entityId.slice(0, 8)}`}</span>
                          )}
                        </div>
                        <p className="text-[11px] text-white/40 mt-0.5">
                          {row.userEmail ?? 'system'} · {new Date(row.createdAt).toLocaleString('en-PK')}
                        </p>
                      </div>
                      <span className="text-xs text-white/30 group-open:rotate-90 transition-transform">▶</span>
                    </summary>
                    <div className="px-4 pb-3 pt-1 ml-9 text-[11px]">
                      {row.metadata && Object.keys(row.metadata).length > 0 && (
                        <pre className="rounded-lg p-2.5 overflow-x-auto"
                          style={{ background: 'rgb(var(--fg-rgb) / 0.06)', color: 'rgb(var(--fg-rgb) / 0.7)' }}>
                          {JSON.stringify(row.metadata, null, 2)}
                        </pre>
                      )}
                      {(row.before != null || row.after != null) && (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-[10px] font-bold text-white/30 uppercase mb-1">Before</p>
                            <pre className="rounded-lg p-2 text-[10px] overflow-x-auto"
                              style={{ background: 'rgba(255,77,79,0.05)', color: 'rgb(var(--fg-rgb) / 0.6)', border: '1px solid rgba(255,77,79,0.15)' }}>
                              {row.before ? JSON.stringify(row.before, null, 2) : '—'}
                            </pre>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-white/30 uppercase mb-1">After</p>
                            <pre className="rounded-lg p-2 text-[10px] overflow-x-auto"
                              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.6)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.15)' }}>
                              {row.after ? JSON.stringify(row.after, null, 2) : '—'}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                )
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
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
