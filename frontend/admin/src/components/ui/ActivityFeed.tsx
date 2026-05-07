'use client'

// Mixed timeline widget: journal entries + audit log mutations + completed
// orders, sorted by timestamp. Drop-in card for the main admin dashboard.

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'

interface FeedItem {
  kind: 'journal' | 'audit' | 'order'
  ts: string
  payload: any
}

function relTime(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (d < 60)        return 'just now'
  if (d < 3600)      return `${Math.floor(d / 60)}m ago`
  if (d < 86400)     return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const ICON: Record<string, string> = {
  journal: '📒',
  audit:   '🔐',
  order:   '🍽️',
}

export function ActivityFeed({ limit = 20 }: { limit?: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['activity-feed', limit],
    queryFn: () => api.get<{ feed: FeedItem[] }>(`/accounting/activity-feed?limit=${limit}`),
    refetchInterval: 30_000,
  })

  return (
    <div className="s-card overflow-hidden">
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between">
        <h2 className="text-sm font-bold text-s-text">Recent activity</h2>
        <span className="text-[11px] text-s-dim">live</span>
      </div>
      <div className="divide-y divide-s-border">
        {isLoading && (
          <div className="px-4 py-6 text-center text-xs text-s-muted">Loading…</div>
        )}
        {!isLoading && (data?.feed ?? []).length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-s-muted">No activity yet today.</div>
        )}
        {(data?.feed ?? []).map((item, i) => (
          <FeedRow key={`${item.kind}-${i}`} item={item} />
        ))}
      </div>
    </div>
  )
}

function FeedRow({ item }: { item: FeedItem }) {
  const ts = relTime(item.ts)

  if (item.kind === 'order') {
    const o = item.payload as { id: string; status: string; totalCents: number; concept: { name: string; slug: string } }
    return (
      <Link href={`/orders/${o.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-s-bg-soft transition-colors">
        <span className="text-lg">{ICON.order}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-s-text">
            <span className="font-semibold">{o.concept.name}</span> order {o.status}
            <span className="text-s-muted"> · {fmtPkrShort(o.totalCents)}</span>
          </p>
          <p className="text-[11px] text-s-dim font-mono">#{o.id.slice(0, 8)} · {ts}</p>
        </div>
      </Link>
    )
  }

  if (item.kind === 'journal') {
    const j = item.payload as { id: string; reference: string | null; description: string; postedBy: string | null }
    return (
      <Link href={`/accounting/ledger?id=${j.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-s-bg-soft transition-colors">
        <span className="text-lg">{ICON.journal}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-s-text truncate">{j.description}</p>
          <p className="text-[11px] text-s-dim font-mono">
            {j.reference ?? `#${j.id.slice(0, 8)}`} · by {j.postedBy ?? 'system'} · {ts}
          </p>
        </div>
      </Link>
    )
  }

  if (item.kind === 'audit') {
    const a = item.payload as { id: string; action: string; entity: string; entityId: string | null; userEmail: string | null }
    return (
      <Link href={`/accounting/audit-log?action=${encodeURIComponent(a.action)}`} className="flex items-start gap-3 px-4 py-3 hover:bg-s-bg-soft transition-colors">
        <span className="text-lg">{ICON.audit}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-s-text">
            <span className="font-mono bg-s-bg-soft border border-s-border rounded px-1.5 py-0.5 mr-1">{a.action}</span>
            on {a.entity}{a.entityId ? ` #${a.entityId.slice(0, 8)}` : ''}
          </p>
          <p className="text-[11px] text-s-dim">by {a.userEmail ?? 'system'} · {ts}</p>
        </div>
      </Link>
    )
  }

  return null
}
