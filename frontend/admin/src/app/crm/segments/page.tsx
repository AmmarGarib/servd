'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Segment {
  id: string
  slug: string
  name: string
  description: string | null
  color: string
  emoji: string
  memberCount: number
  lastComputedAt: string | null
}

interface Member {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    totalSpentCents: number
    lastOrderAt: string | null
    walletBalance: number
    marketingOptIn: boolean
  }
  joinedAt: string
}

function fmt(cents: number) {
  return `PKR ${(cents / 100).toLocaleString('en-PK')}`
}

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const d = Math.floor(diff / 864e5)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  if (d < 30) return `${Math.floor(d / 7)}w ago`
  return `${Math.floor(d / 30)}mo ago`
}

export default function SegmentsPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Segment | null>(null)
  const [computing, setComputing] = useState(false)

  const { data: segments = [], isLoading } = useQuery<Segment[]>({
    queryKey: ['behavioral-segments'],
    queryFn: () => api.get('/crm/behavioral-segments'),
    refetchInterval: computing ? 3000 : false,
  })

  const { data: members = [], isLoading: membersLoading } = useQuery<Member[]>({
    queryKey: ['segment-members', selected?.slug],
    queryFn: () => api.get(`/crm/behavioral-segments/${selected!.slug}/members?limit=300`),
    enabled: !!selected,
  })

  async function recompute() {
    setComputing(true)
    try {
      await api.post('/crm/behavioral-segments/compute', {})
      setTimeout(() => {
        setComputing(false)
        qc.invalidateQueries({ queryKey: ['behavioral-segments'] })
        if (selected) qc.invalidateQueries({ queryKey: ['segment-members', selected.slug] })
      }, 8000)
    } catch { setComputing(false) }
  }

  const totalMembers = segments.reduce((s, g) => s + g.memberCount, 0)
  const lastRun = segments.reduce((latest, g) => {
    if (!g.lastComputedAt) return latest
    return !latest || g.lastComputedAt > latest ? g.lastComputedAt : latest
  }, null as string | null)

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
        <div>
          <Link href="/crm" className="text-xs text-neutral-400 hover:text-neutral-600 mb-1 inline-block">← CRM</Link>
          <h1 className="text-xl font-semibold text-neutral-900">Customer Segments</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {totalMembers.toLocaleString()} memberships across {segments.length} behavioral groups
            {lastRun && <> · last computed {timeAgo(lastRun)}</>}
          </p>
        </div>
        <button
          onClick={recompute}
          disabled={computing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {computing ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Computing…</>
          ) : (
            <><span>⟳</span> Recompute All</>
          )}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: segment grid */}
        <div className="w-80 flex-shrink-0 border-r border-neutral-200 overflow-y-auto p-4 space-y-2">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl bg-neutral-100 animate-pulse" />
              ))
            : segments.map((seg) => (
                <button
                  key={seg.slug}
                  onClick={() => setSelected(seg)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                    selected?.slug === seg.slug
                      ? 'border-green-500 bg-green-50 shadow-sm'
                      : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span className="text-lg">{seg.emoji}</span>
                      <span className="font-medium text-sm text-neutral-900">{seg.name}</span>
                    </span>
                    <span
                      className="text-lg font-bold tabular-nums"
                      style={{ color: seg.color }}
                    >
                      {seg.memberCount.toLocaleString()}
                    </span>
                  </div>
                  {seg.description && (
                    <p className="text-xs text-neutral-500 mt-0.5 ml-7 leading-tight">{seg.description}</p>
                  )}
                </button>
              ))}
        </div>

        {/* Right: member table */}
        <div className="flex-1 overflow-y-auto">
          {!selected ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-400 gap-3">
              <span className="text-5xl">👈</span>
              <p className="text-sm">Select a segment to see its members</p>
            </div>
          ) : (
            <div>
              {/* Segment header */}
              <div className="sticky top-0 bg-white border-b border-neutral-200 px-6 py-3 flex items-center justify-between z-10">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{selected.emoji}</span>
                  <div>
                    <h2 className="font-semibold text-neutral-900">{selected.name}</h2>
                    <p className="text-xs text-neutral-500">{selected.memberCount} members · computed {timeAgo(selected.lastComputedAt)}</p>
                  </div>
                </div>
                <a
                  href={`/crm/campaigns?segment=${selected.slug}`}
                  className="px-3 py-1.5 rounded-lg border border-neutral-200 text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  📣 Campaign
                </a>
              </div>

              {/* Table */}
              {membersLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-10 rounded bg-neutral-100 animate-pulse" />
                  ))}
                </div>
              ) : members.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-neutral-400 gap-2">
                  <span className="text-3xl">🌵</span>
                  <p className="text-sm">No members yet — run a recompute</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-[57px] bg-neutral-50 text-xs text-neutral-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-6 py-2 font-medium">Customer</th>
                      <th className="text-left px-4 py-2 font-medium">Contact</th>
                      <th className="text-right px-4 py-2 font-medium">Spent</th>
                      <th className="text-right px-4 py-2 font-medium">Last order</th>
                      <th className="text-center px-4 py-2 font-medium">Mktg</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {members.map(({ customer: c, joinedAt }) => (
                      <tr key={c.id} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-2.5">
                          <div className="font-medium text-neutral-900">{c.name}</div>
                          <div className="text-xs text-neutral-400">joined segment {timeAgo(joinedAt)}</div>
                        </td>
                        <td className="px-4 py-2.5 text-neutral-600">
                          <div>{c.phone ?? '—'}</div>
                          <div className="text-xs text-neutral-400">{c.email ?? ''}</div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-neutral-900">
                          {fmt(c.totalSpentCents)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-neutral-500">
                          {timeAgo(c.lastOrderAt)}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {c.marketingOptIn ? (
                            <span className="text-green-600 text-xs font-medium">✓ opt-in</span>
                          ) : (
                            <span className="text-neutral-300 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
