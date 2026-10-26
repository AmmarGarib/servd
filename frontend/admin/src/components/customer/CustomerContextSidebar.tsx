'use client'

// CustomerContextSidebar — drop-in panel that shows everything staff need to
// know about a customer at a glance: lifetime value, no-show / complaint /
// review history, recent orders + reservations, open issues, manager notes.
//
// Usage:
//   <CustomerContextSidebar customerId={r.customerId} />
//
// Renders nothing if customerId is null (anonymous walk-in / guest order).
// Auto-refetches when the customerId changes; no manual cache work needed.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { NavIcon } from '../ui/NavIcon'
import { GuestTagsPanel } from './GuestTagsPanel'
import { MemberBarcode } from './MemberBarcode'

interface CustomerContext {
  id: string
  name: string
  email: string | null
  phone: string | null
  /** Internal member barcode + the servd name (owner, 2026-10-26). */
  memberCode?: string | null
  nickname?: string | null
  isBlacklisted: boolean
  blacklistReason: string | null
  birthdayMmDd: string | null
  firstOrderAt: string | null
  lastOrderAt: string | null
  lastVisitAt: string | null
  totalSpentCents: number
  walletBalance: number
  staffNotes: string | null
  noShowCount: number
  complaintCount: number
  reviewCount: number
  avgReviewRating: number | null
  lastNoShowAt: string | null
  lastComplaintAt: string | null
  lastReviewedAt: string | null
  strikeCount: number
  bannedAt: string | null
  loyaltyAccount: { tier: string; pointsBalance: number; lifetimePoints: number } | null
  preferredConcept: { name: string; slug: string } | null
  segments: string[]
  recent: {
    orders:         Array<{ id: string; status: string; totalCents: number; placedAt: string; source: string; concept: { name: string; slug: string } }>
    reservations:   Array<{ id: string; status: string; partySize: number; startTime: string; isVip: boolean; concept: { name: string; slug: string } }>
    openComplaints: Array<{ id: string; title: string; category: string; status: string; priority: string; createdAt: string; concept: { name: string } }>
    reviews:        Array<{ id: string; rating: number; comment: string | null; tags: string[]; createdAt: string; concept: { name: string } }>
    // Servd-wide (owner 2026-10-15): otherKitchen = recorded by another servd company, details withheld.
    strikes:        Array<{ id: string; kind: string; severity: number; reason: string | null; recordedAt: string; reversedAt: string | null; expiresAt: string | null; otherKitchen?: boolean }>
  }
}

interface Props {
  customerId: string | null | undefined
  /** Compact mode for tighter spaces (sidebars on small screens). */
  compact?: boolean
}

export function CustomerContextSidebar({ customerId, compact = false }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<CustomerContext>({
    queryKey: ['customer-context', customerId],
    queryFn: () => api.get<CustomerContext>(`/crm/customers/${customerId}/context`),
    enabled: !!customerId,
  })
  const [notesEdit, setNotesEdit] = useState<string | null>(null)
  useEffect(() => { setNotesEdit(null) }, [customerId])

  const saveNotes = useMutation({
    mutationFn: (staffNotes: string) =>
      api.patch(`/crm/customers/${customerId}/notes`, { staffNotes: staffNotes.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer-context', customerId] }),
  })

  if (!customerId) {
    return (
      <div className="rounded-xl border border-white/[0.05] p-4 text-xs text-white/40">
        Walk-in / guest order — no customer profile linked.
      </div>
    )
  }
  if (isLoading || !data) {
    return <div className="rounded-xl border border-white/[0.05] p-4 text-xs text-white/35">Loading customer context…</div>
  }

  const lifetime = (data.totalSpentCents / 100).toFixed(0)
  const isVip = data.totalSpentCents >= 5_000_000   // PKR 50k+
  const isRisky = data.noShowCount >= 2 || data.complaintCount >= 3
  const isBanned = data.bannedAt != null
  const isStriking = data.strikeCount > 0 && !isBanned
  const lastVisitAgo = data.lastVisitAt ? humanAgo(data.lastVisitAt) : 'never'
  const isLapsed = data.lastVisitAt
    ? (Date.now() - new Date(data.lastVisitAt).getTime()) > 60 * 86_400_000
    : false

  return (
    <div className={`flex flex-col gap-3 ${compact ? 'text-xs' : 'text-sm'}`}>
      {/* ── Identity + lifetime ────────────────────────────────────────── */}
      <div className="rounded-xl p-4 border" style={{
        background: 'rgb(var(--fg-rgb) / 0.025)',
        borderColor: data.isBlacklisted ? 'color-mix(in srgb, var(--erp-danger) 45%, transparent)' : 'rgb(var(--fg-rgb) / 0.06)',
      }}>
        <div className="flex items-center justify-between gap-2">
          <div className="font-bold text-white/90 truncate">{data.name}</div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isBanned && <Badge color="rose" label="BANNED" />}
            {isStriking && <Badge color="rose" label={`${data.strikeCount}/3 strikes`} />}
            {isVip && <Badge color="amber" label="VIP" />}
            {isRisky && !isBanned && !isStriking && <Badge color="rose" label="Risk" />}
            {data.isBlacklisted && !isBanned && <Badge color="rose" label="Blacklisted" />}
            {isLapsed && <Badge color="slate" label="Lapsed" />}
          </div>
        </div>
        <div className="text-[11px] text-white/45 mt-0.5">
          {data.phone && <>{data.phone}</>}
          {data.phone && data.email && ' · '}
          {data.email && <span className="truncate">{data.email}</span>}
        </div>
        {data.nickname && <div className="text-[11px] font-bold text-primary-ink mt-0.5">@{data.nickname}</div>}
        {data.memberCode && (
          <div className="mt-2"><MemberBarcode code={data.memberCode} name={data.name} compact /></div>
        )}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <Stat label="Lifetime"  value={`Rs. ${lifetime}`} />
          <Stat label="Last visit" value={lastVisitAgo} />
          <Stat label="Loyalty" value={
            data.loyaltyAccount
              ? `${data.loyaltyAccount.pointsBalance.toLocaleString()} pts · ${data.loyaltyAccount.tier}`
              : '—'} />
        </div>
        {data.preferredConcept && (
          <div className="text-[10px] text-white/40 mt-2">
            Prefers <span className="text-white/65 font-bold">{data.preferredConcept.name}</span>
          </div>
        )}
      </div>

      <GuestTagsPanel customerId={customerId} />

      {/* ── Risk + flag bar ────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-1.5">
        <Counter label="No-shows"  count={data.noShowCount}    accent={data.noShowCount >= 2 ? 'rose' : 'mute'} lastAt={data.lastNoShowAt} />
        <Counter label="Complaints" count={data.complaintCount} accent={data.complaintCount >= 1 ? 'amber' : 'mute'} lastAt={data.lastComplaintAt} />
        <Counter
          label="Reviews"
          count={data.reviewCount}
          accent={data.avgReviewRating != null && data.avgReviewRating <= 2.5 ? 'rose' : 'mute'}
          subtitle={data.avgReviewRating != null ? `${data.avgReviewRating.toFixed(1)} avg` : null} />
      </div>

      {/* ── Open complaints (always front-and-center if any) ──────────── */}
      {data.recent.openComplaints.length > 0 && (
        <div className="rounded-xl p-3 border border-rose-500/30" style={{ background: 'color-mix(in srgb, var(--erp-danger) 6%, transparent)' }}>
          <div className="text-[10px] font-bold uppercase tracking-wider text-rose-700 mb-1.5">
            <NavIcon name="warn" size={11} className="mr-1 inline" />{data.recent.openComplaints.length} unresolved issue{data.recent.openComplaints.length === 1 ? '' : 's'}
          </div>
          {data.recent.openComplaints.map((c) => (
            <div key={c.id} className="text-[11px] text-white/70 mb-0.5">
              <span className="font-bold">{c.title}</span>
              <span className="text-white/40"> · {c.category} · {c.priority}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Manager notes (editable inline) ────────────────────────────── */}
      <div className="rounded-xl p-3 border border-white/[0.06]" style={{ background: 'rgb(var(--fg-rgb) / 0.02)' }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-white/40">Staff notes</div>
          {notesEdit === null ? (
            <button
              onClick={() => setNotesEdit(data.staffNotes ?? '')}
              className="text-[10px] text-white/50 hover:text-white/85">
              {data.staffNotes ? 'edit' : '+ add'}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { saveNotes.mutate(notesEdit); setNotesEdit(null) }}
                disabled={saveNotes.isPending}
                className="text-[10px] font-bold text-primary-ink hover:opacity-80">save</button>
              <button onClick={() => setNotesEdit(null)} className="text-[10px] text-white/40 hover:text-white/70">cancel</button>
            </div>
          )}
        </div>
        {notesEdit !== null ? (
          <textarea
            value={notesEdit}
            onChange={(e) => setNotesEdit(e.target.value)}
            rows={3}
            placeholder='e.g. "Allergy: shellfish · always orders at the bar · big tipper"'
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] p-2 text-xs text-white/85 focus:border-primary focus:outline-none" />
        ) : (
          <div className="text-[11px] text-white/65 italic">
            {data.staffNotes || 'No notes yet — add allergies, preferences, anything the team should know.'}
          </div>
        )}
      </div>

      {/* ── Segments ──────────────────────────────────────────────────── */}
      {data.segments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.segments.slice(0, 6).map((s) => (
            <span key={s} className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{
              background: 'rgb(var(--ink-rgb) / 0.12)', color: 'var(--erp-primary-ink)',
            }}>{s}</span>
          ))}
        </div>
      )}

      {/* ── Naughty list — strikes + ban context ───────────────────────── */}
      {(isBanned || data.strikeCount > 0) && data.recent.strikes.length > 0 && (
        <div className="rounded-xl p-3 border" style={{
          background: isBanned ? 'color-mix(in srgb, var(--erp-danger) 8%, transparent)' : 'color-mix(in srgb, var(--erp-warning) 6%, transparent)',
          borderColor: isBanned ? 'color-mix(in srgb, var(--erp-danger) 35%, transparent)' : 'color-mix(in srgb, var(--erp-warning) 25%, transparent)',
        }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: isBanned ? 'var(--erp-danger)' : 'var(--erp-warning)' }}>
              {isBanned ? 'Banned across servd' : `Strikes across servd (${data.strikeCount}/3)`}
            </div>
            <a href="/crm/naughty-list"
              className="text-[10px] text-white/45 hover:text-white/85">manage →</a>
          </div>
          <div className="space-y-1">
            {data.recent.strikes.slice(0, 3).map((s) => (
              <div key={s.id} className="text-[11px] flex items-center justify-between gap-2"
                style={{ opacity: s.reversedAt ? 0.5 : 1 }}>
                <span className="text-white/80 truncate">
                  {s.kind.replace(/_/g, ' ')}
                  {s.severity > 1 && <span className="ml-1 text-rose-700">×{s.severity}</span>}
                  {s.otherKitchen && <span className="ml-1 text-white/45">· another servd kitchen</span>}
                </span>
                <span className="text-white/40 whitespace-nowrap">{humanAgo(s.recordedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent visits (orders + reservations interleaved by time) ──── */}
      <RecentTimeline data={data} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-wider text-white/35">{label}</div>
      <div className="text-xs font-bold text-white/85 mt-0.5 truncate">{value}</div>
    </div>
  )
}

function Counter({ label, count, accent, subtitle, lastAt }: {
  label: string; count: number;
  accent: 'rose' | 'amber' | 'mute';
  subtitle?: string | null;
  lastAt?: string | null;
}) {
  const colors = {
    rose:  { bg: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)',  border: 'color-mix(in srgb, var(--erp-danger) 25%, transparent)',  text: 'var(--erp-danger)' },
    amber: { bg: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)', border: 'color-mix(in srgb, var(--erp-warning) 25%, transparent)', text: 'var(--erp-warning)' },
    mute:  { bg: 'rgb(var(--fg-rgb) / 0.025)', border: 'rgb(var(--fg-rgb) / 0.06)', text: 'rgb(var(--fg-rgb) / 0.55)' },
  }[accent]
  return (
    <div className="rounded-lg p-2 text-center" style={{ background: colors.bg, border: `1px solid ${colors.border}` }}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-base font-black mt-0.5" style={{ color: count > 0 ? colors.text : 'rgb(var(--fg-rgb) / 0.4)' }}>
        {count}
      </div>
      {subtitle && <div className="text-[9px] text-white/45">{subtitle}</div>}
      {lastAt && count > 0 && <div className="text-[9px] text-white/35">last {humanAgo(lastAt)}</div>}
    </div>
  )
}

function Badge({ color, label }: { color: 'amber' | 'rose' | 'slate' | 'green'; label: string }) {
  const tint = (v: string) => `color-mix(in srgb, ${v} 15%, transparent)`
  const styles = {
    amber: { bg: tint('var(--erp-warning)'), text: 'var(--erp-warning)' },
    rose:  { bg: tint('var(--erp-danger)'),  text: 'var(--erp-danger)' },
    slate: { bg: tint('var(--muted)'),       text: 'var(--muted)' },
    green: { bg: tint('var(--erp-accent)'),  text: 'var(--erp-success)' },
  }[color]
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: styles.bg, color: styles.text }}>
      {label}
    </span>
  )
}

function RecentTimeline({ data }: { data: CustomerContext }) {
  // Merge orders + reservations into one chronological feed.
  type Event = { kind: 'order' | 'reservation'; at: Date; label: string; meta: string }
  const events: Event[] = [
    ...data.recent.orders.map((o): Event => ({
      kind: 'order',
      at: new Date(o.placedAt),
      label: `${o.concept.name} · Rs. ${(o.totalCents / 100).toFixed(0)}`,
      meta: `${o.status} · ${o.source}`,
    })),
    ...data.recent.reservations.map((r): Event => ({
      kind: 'reservation',
      at: new Date(r.startTime),
      label: `${r.concept.name} · party of ${r.partySize}`,
      meta: r.status,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 8)

  if (events.length === 0) return null
  return (
    <div className="rounded-xl p-3 border border-white/[0.06]" style={{ background: 'rgb(var(--fg-rgb) / 0.02)' }}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-2">Recent</div>
      <div className="space-y-1.5">
        {events.map((e, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-[10px] mt-0.5 shrink-0">
              <NavIcon name={e.kind === 'order' ? 'bag' : 'utensils'} size={12} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-white/80 truncate">{e.label}</div>
              <div className="text-[9px] text-white/35">
                {humanAgo(e.at.toISOString())} · {e.meta}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Compact "3d ago" / "2h ago" / "just now" formatting.
function humanAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000)            return 'just now'
  if (ms < 3_600_000)         return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000)        return `${Math.floor(ms / 3_600_000)}h ago`
  if (ms < 30 * 86_400_000)   return `${Math.floor(ms / 86_400_000)}d ago`
  if (ms < 365 * 86_400_000)  return `${Math.floor(ms / (30 * 86_400_000))}mo ago`
  return `${Math.floor(ms / (365 * 86_400_000))}y ago`
}
