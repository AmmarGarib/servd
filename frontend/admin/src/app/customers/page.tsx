'use client'

// Customer 360 — searchable list of every customer with lifetime stats:
// total spend, order count, last seen, loyalty tier, preferred brand.
// Sortable by recency / spend / frequency.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'

interface Customer {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  totalSpendCents: number | null
  totalOrders: number | null
  lastOrderAt: string | null
  isBlacklisted: boolean
  loyaltyAccount: { pointsBalance: number; tier: string } | null
  preferredConcept: { name: string; slug: string } | null
  _count?: { orders: number }
}

type SortKey = 'lastSeen' | 'spend' | 'orders'

export default function CustomersPage() {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('lastSeen')

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () => api.get<{ data: Customer[] }>(
      `/crm/customers?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    ),
  })

  const customers = useMemo(() => {
    const list = [...(data?.data ?? [])]
    list.sort((a, b) => {
      if (sort === 'lastSeen') {
        const at = a.lastOrderAt ? new Date(a.lastOrderAt).getTime() : 0
        const bt = b.lastOrderAt ? new Date(b.lastOrderAt).getTime() : 0
        return bt - at
      }
      if (sort === 'spend')  return (b.totalSpendCents ?? 0) - (a.totalSpendCents ?? 0)
      if (sort === 'orders') return (b._count?.orders ?? b.totalOrders ?? 0) - (a._count?.orders ?? a.totalOrders ?? 0)
      return 0
    })
    return list
  }, [data, sort])

  const stats = useMemo(() => {
    const list = customers
    const total = list.length
    const lifetimeRevenue = list.reduce((s, c) => s + (c.totalSpendCents ?? 0), 0)
    const totalOrders = list.reduce((s, c) => s + (c._count?.orders ?? c.totalOrders ?? 0), 0)
    const avgLtv = total > 0 ? Math.round(lifetimeRevenue / total) : 0
    const avgFreq = total > 0 ? totalOrders / total : 0
    const goldTier = list.filter((c) => c.loyaltyAccount?.tier === 'gold').length
    return { total, lifetimeRevenue, avgLtv, avgFreq, goldTier }
  }, [customers])

  function daysSince(iso: string | null): string {
    if (!iso) return '—'
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
    if (d === 0) return 'today'
    if (d === 1) return 'yesterday'
    if (d < 7)   return `${d}d ago`
    if (d < 30)  return `${Math.floor(d / 7)}w ago`
    if (d < 365) return `${Math.floor(d / 30)}mo ago`
    return `${Math.floor(d / 365)}y ago`
  }

  const tierBadge: Record<string, string> = {
    bronze: 'bg-orange-100 text-orange-700',
    silver: 'bg-gray-100 text-gray-700',
    gold:   'bg-yellow-100 text-yellow-700',
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-s-muted">CRM</p>
          <h1 className="text-xl font-bold text-s-text">Customers</h1>
        </div>
        <input
          type="search"
          placeholder="Search name, email, phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-s-card border border-s-border rounded px-3 py-1.5 text-sm text-s-text w-72 max-w-full"
        />
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-4">
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="s-card p-4"><p className="text-xs text-s-muted">Customers</p><p className="text-xl font-bold text-s-text">{stats.total}</p></div>
          <div className="s-card p-4"><p className="text-xs text-s-muted">Lifetime revenue</p><p className="text-xl font-bold text-s-text">{fmtPkrShort(stats.lifetimeRevenue)}</p></div>
          <div className="s-card p-4"><p className="text-xs text-s-muted">Avg LTV</p><p className="text-xl font-bold text-s-text">{fmtPkrShort(stats.avgLtv)}</p></div>
          <div className="s-card p-4"><p className="text-xs text-s-muted">Gold tier</p><p className="text-xl font-bold text-s-text">{stats.goldTier}</p></div>
        </div>

        {/* Sort tabs */}
        <div className="flex gap-2">
          {([
            { key: 'lastSeen' as const, label: 'Recent' },
            { key: 'spend'    as const, label: 'Top spenders' },
            { key: 'orders'   as const, label: 'Most frequent' },
          ]).map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                sort === s.key ? 'bg-black text-white border-black' : 'bg-white border-s-border text-s-text hover:bg-s-bg-soft'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="s-card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-s-bg-soft text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Tier</th>
                <th className="px-4 py-2 text-left">Preferred</th>
                <th className="px-4 py-2 text-right">Orders</th>
                <th className="px-4 py-2 text-right">LTV</th>
                <th className="px-4 py-2 text-left">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">Loading…</td></tr>
              )}
              {!isLoading && customers.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">No customers match.</td></tr>
              )}
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-s-border hover:bg-s-bg-soft">
                  <td className="px-4 py-2">
                    <Link href={`/crm/${c.id}`} className="hover:underline">
                      <p className="text-s-text">{c.name ?? '—'}</p>
                      <p className="text-[11px] text-s-dim">{c.email ?? c.phone ?? c.id.slice(0, 8)}</p>
                    </Link>
                    {c.isBlacklisted && <span className="ml-2 text-[10px] uppercase font-bold text-s-red">blocked</span>}
                  </td>
                  <td className="px-4 py-2">
                    {c.loyaltyAccount ? (
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${tierBadge[c.loyaltyAccount.tier] ?? 'bg-s-bg-soft'}`}>
                        {c.loyaltyAccount.tier} · {c.loyaltyAccount.pointsBalance}
                      </span>
                    ) : (
                      <span className="text-[11px] text-s-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-s-text">{c.preferredConcept?.name ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-text">{c._count?.orders ?? c.totalOrders ?? 0}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkrShort(c.totalSpendCents ?? 0)}</td>
                  <td className="px-4 py-2 text-xs text-s-muted">{daysSince(c.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  )
}
