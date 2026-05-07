'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'

function fmt(cents: number) { return `PKR ${(cents / 100).toLocaleString()}` }

interface Customer {
  id: string; name: string; phone: string | null; email: string | null
  totalSpentCents: number; lastOrderAt: string | null; createdAt: string
  walletBalance: number; isBlacklisted: boolean; blacklistReason: string | null
  loyaltyAccount: { pointsBalance: number; tier: string | null } | null
  _count: { orders: number }
}

interface SmartSegment { key: string; label: string; desc: string; count: number }
interface SmartSegmentsResp {
  summary: { totalCustomers: number; repeatRate: number; avgOrderValueCents: number }
  segments: SmartSegment[]
}

type Tab = 'customers' | 'segments' | 'campaigns'

export default function CRMPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('customers')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [blacklistModal, setBlacklistModal] = useState<{ id: string; name: string; current: boolean } | null>(null)
  const [blacklistReason, setBlacklistReason] = useState('')
  const [walletModal, setWalletModal] = useState<{ id: string; name: string } | null>(null)
  const [walletAmount, setWalletAmount] = useState('')
  const [activeSegmentKey, setActiveSegmentKey] = useState<string | null>(null)

  const { data: customersResp, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () => api.get<{ data: Customer[]; cursor: string | null; hasMore: boolean }>(`/crm/customers?search=${encodeURIComponent(search)}&limit=50`),
  })
  const customers = customersResp?.data ?? []

  const { data: customerDetail } = useQuery({
    queryKey: ['customer-detail', selectedId],
    queryFn: () => api.get<Customer & {
      orders: { id: string; totalCents: number; status: string; placedAt: string; concept: { name: string }; items: { name: string; quantity: number }[] }[]
      loyaltyAccount: { pointsBalance: number; tier: string | null; transactions: { id: string; type: string; points: number; createdAt: string }[] } | null
    }>(`/crm/customers/${selectedId}`),
    enabled: !!selectedId,
  })

  const { data: smartData } = useQuery({
    queryKey: ['smart-segments'],
    queryFn: () => api.get<SmartSegmentsResp>('/crm/smart-segments'),
    enabled: tab === 'segments',
  })

  const { data: segmentCustomers = [] } = useQuery({
    queryKey: ['smart-segment-customers', activeSegmentKey],
    queryFn: () => api.get<Customer[]>(`/crm/smart-segments/${activeSegmentKey}?limit=100`),
    enabled: !!activeSegmentKey,
  })

  const blacklist = useMutation({
    mutationFn: ({ id, isBlacklisted, reason }: { id: string; isBlacklisted: boolean; reason?: string }) =>
      api.patch(`/crm/customers/${id}/blacklist`, { isBlacklisted, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] })
      void qc.invalidateQueries({ queryKey: ['customer-detail', selectedId] })
      setBlacklistModal(null)
      setBlacklistReason('')
    },
  })

  const topupWallet = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      api.post('/wallet/topup', { customerId: id, amountCents: amount, note: 'Manual top-up by staff' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer-detail', selectedId] })
      setWalletModal(null)
      setWalletAmount('')
    },
  })

  const selected = customers.find((c) => c.id === selectedId) ?? null

  const TIER_COLORS: Record<string, string> = {
    bronze: 'text-orange-400 bg-orange-900/30',
    silver: 'text-kds-subtext bg-kds-card',
    gold:   'text-kds-amber bg-kds-amber/20',
  }

  const SEGMENT_COLORS: Record<string, string> = {
    new: 'text-kds-blue bg-kds-blue/10',
    vip: 'text-kds-amber bg-kds-amber/10',
    repeat: 'text-kds-green bg-kds-green/10',
    zero: 'text-kds-subtext bg-kds-bg',
    dormant: 'text-kds-red bg-kds-red/10',
    frequent: 'text-purple-400 bg-purple-900/20',
    cart_abandoners: 'text-orange-400 bg-orange-900/20',
    one_time: 'text-kds-subtext bg-kds-card',
  }

  const inp = 'rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none w-full'

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4">
        <h1 className="text-2xl font-black text-kds-text mt-0.5">Customers / CRM</h1>
        <p className="text-sm text-kds-subtext">Customer profiles, smart segments, loyalty and campaigns</p>
      </header>

      {/* Blacklist modal */}
      {blacklistModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <p className="font-bold text-kds-text">
              {blacklistModal.current ? 'Remove from blacklist' : 'Blacklist customer'}
            </p>
            <p className="text-sm text-kds-subtext">{blacklistModal.name}</p>
            {!blacklistModal.current && (
              <input value={blacklistReason} onChange={(e) => setBlacklistReason(e.target.value)}
                placeholder="Reason (optional)" className={inp} />
            )}
            <div className="flex gap-3">
              <button
                onClick={() => blacklist.mutate({ id: blacklistModal.id, isBlacklisted: !blacklistModal.current, ...(blacklistReason ? { reason: blacklistReason } : {}) })}
                disabled={blacklist.isPending}
                className={`flex-1 rounded-xl text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50 ${
                  blacklistModal.current ? 'bg-kds-green text-black' : 'bg-kds-red text-white'
                }`}>
                {blacklist.isPending ? '…' : blacklistModal.current ? 'Unblacklist' : 'Blacklist'}
              </button>
              <button onClick={() => { setBlacklistModal(null); setBlacklistReason('') }}
                className="flex-1 rounded-xl border border-kds-border text-kds-subtext text-sm py-2 hover:border-kds-text">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wallet top-up modal */}
      {walletModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <p className="font-bold text-kds-text">Wallet top-up</p>
            <p className="text-sm text-kds-subtext">{walletModal.name}</p>
            <div>
              <label className="text-xs text-kds-subtext mb-1 block">Amount (PKR)</label>
              <input type="number" min="1" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)}
                placeholder="500" className={inp} />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => topupWallet.mutate({ id: walletModal.id, amount: Math.round(parseFloat(walletAmount) * 100) })}
                disabled={!walletAmount || topupWallet.isPending}
                className="flex-1 rounded-xl bg-kds-green text-black text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50">
                {topupWallet.isPending ? 'Crediting…' : 'Credit wallet'}
              </button>
              <button onClick={() => { setWalletModal(null); setWalletAmount('') }}
                className="flex-1 rounded-xl border border-kds-border text-kds-subtext text-sm py-2 hover:border-kds-text">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-[calc(100vh-81px)]">
        {/* ── Left sidebar ── */}
        <aside className="w-72 shrink-0 border-r border-kds-border flex flex-col">
          <div className="p-3 border-b border-kds-border">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedId(null) }}
              placeholder="Search name, phone, email…"
              className="w-full rounded-xl bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none" />
          </div>

          <div className="flex gap-1 px-3 pt-3 pb-2">
            {(['customers', 'segments', 'campaigns'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  tab === t ? 'bg-kds-green text-black' : 'bg-kds-card text-kds-subtext hover:text-kds-text'
                }`}>
                {t === 'segments' ? 'Segments' : t === 'campaigns' ? 'Campaigns' : 'Customers'}
              </button>
            ))}
          </div>

          {tab === 'customers' && (
            <div className="flex-1 overflow-y-auto">
              {isLoading && <p className="px-4 py-3 text-xs text-kds-subtext">Loading…</p>}
              {!isLoading && customers.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-kds-subtext">No customers found</p>
              )}
              {customers.map((c) => (
                <button key={c.id} onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left border-b border-kds-border/40 transition-colors ${
                    selectedId === c.id ? 'bg-kds-card border-l-2 border-l-kds-green' : 'hover:bg-kds-card/50'
                  }`}>
                  <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-xs font-black ${
                    c.isBlacklisted ? 'bg-kds-red/20 text-kds-red' : 'bg-kds-border text-kds-subtext'
                  }`}>
                    {c.isBlacklisted ? '⛔' : (c.name[0]?.toUpperCase() ?? '?')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-kds-text truncate">{c.name}</p>
                    <p className="text-xs text-kds-subtext truncate">{c.phone ?? c.email ?? 'No contact'}</p>
                    <p className="text-xs text-kds-subtext">{c._count.orders} orders · {fmt(c.totalSpentCents)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {tab === 'segments' && (
            <div className="flex-1 overflow-y-auto">
              {(smartData?.segments ?? []).map((seg) => (
                <button key={seg.key}
                  onClick={() => setActiveSegmentKey(activeSegmentKey === seg.key ? null : seg.key)}
                  className={`w-full flex items-center justify-between px-4 py-3 border-b border-kds-border/40 text-left transition-colors ${
                    activeSegmentKey === seg.key ? 'bg-kds-card border-l-2 border-l-kds-green' : 'hover:bg-kds-card/50'
                  }`}>
                  <div>
                    <p className="text-sm font-semibold text-kds-text">{seg.label}</p>
                    <p className="text-xs text-kds-subtext">{seg.desc}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold shrink-0 ${SEGMENT_COLORS[seg.key] ?? 'text-kds-subtext bg-kds-card'}`}>
                    {seg.count}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tab === 'campaigns' && (
            <div className="flex-1 overflow-y-auto p-4">
              <Link href="/crm/campaigns"
                className="block rounded-xl border border-kds-border bg-kds-card p-3 text-sm text-center text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
                Open Campaigns →
              </Link>
            </div>
          )}

          {tab === 'customers' && (
            <div className="border-t border-kds-border px-4 py-3">
              <p className="text-xs text-kds-subtext">{customers.length} customer{customers.length !== 1 ? 's' : ''} shown</p>
            </div>
          )}
          {tab === 'segments' && smartData && (
            <div className="border-t border-kds-border px-4 py-3 space-y-1">
              <p className="text-xs text-kds-subtext">Repeat rate: <span className="text-kds-text font-bold">{smartData.summary.repeatRate}%</span></p>
              <p className="text-xs text-kds-subtext">Avg order: <span className="text-kds-text font-bold">{fmt(smartData.summary.avgOrderValueCents)}</span></p>
            </div>
          )}
        </aside>

        {/* ── Right panel ── */}
        <div className="flex-1 overflow-y-auto">
          {/* Segment customer list */}
          {tab === 'segments' && activeSegmentKey && (
            <div className="p-6">
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-4">
                {smartData?.segments.find((s) => s.key === activeSegmentKey)?.label ?? activeSegmentKey}
              </p>
              {segmentCustomers.length === 0 ? (
                <p className="text-sm text-kds-subtext">No customers in this segment</p>
              ) : (
                <div className="rounded-xl border border-kds-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-kds-card border-b border-kds-border">
                      <tr>
                        {['Name', 'Phone', 'Email', 'Spent', 'Last order', 'Wallet'].map((h) => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-bold text-kds-subtext uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-kds-border">
                      {segmentCustomers.map((c) => (
                        <tr key={c.id} className="hover:bg-kds-card/40">
                          <td className="px-4 py-3 font-semibold text-kds-text">{c.name}</td>
                          <td className="px-4 py-3 text-kds-subtext text-xs">{c.phone ?? '—'}</td>
                          <td className="px-4 py-3 text-kds-subtext text-xs">{c.email ?? '—'}</td>
                          <td className="px-4 py-3 text-kds-green font-bold">{fmt(c.totalSpentCents ?? 0)}</td>
                          <td className="px-4 py-3 text-kds-subtext text-xs">
                            {c.lastOrderAt ? formatDistanceToNowStrict(new Date(c.lastOrderAt)) + ' ago' : '—'}
                          </td>
                          <td className="px-4 py-3 text-kds-subtext text-xs">{fmt(c.walletBalance ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'segments' && !activeSegmentKey && smartData && (
            <div className="p-6">
              <div className="grid grid-cols-2 gap-4 max-w-2xl">
                <div className="col-span-2 rounded-xl border border-kds-border bg-kds-card p-5">
                  <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-4">Summary</p>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center">
                      <p className="text-3xl font-black text-kds-text">{smartData.summary.totalCustomers}</p>
                      <p className="text-xs text-kds-subtext mt-1">Total customers</p>
                    </div>
                    <div className="text-center">
                      <p className="text-3xl font-black text-kds-green">{smartData.summary.repeatRate}%</p>
                      <p className="text-xs text-kds-subtext mt-1">Repeat rate</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-black text-kds-amber">{fmt(smartData.summary.avgOrderValueCents)}</p>
                      <p className="text-xs text-kds-subtext mt-1">Avg order value</p>
                    </div>
                  </div>
                </div>
                {smartData.segments.map((seg) => (
                  <button key={seg.key}
                    onClick={() => setActiveSegmentKey(seg.key)}
                    className="rounded-xl border border-kds-border bg-kds-card p-4 text-left hover:border-kds-green transition-colors">
                    <p className={`text-2xl font-black ${SEGMENT_COLORS[seg.key]?.split(' ')[0] ?? 'text-kds-text'}`}>{seg.count}</p>
                    <p className="text-sm font-semibold text-kds-text mt-1">{seg.label}</p>
                    <p className="text-xs text-kds-subtext mt-0.5">{seg.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Customer detail */}
          {tab === 'customers' && selected && customerDetail && (
            <div className="p-6">
              <div className="max-w-2xl space-y-5">
                {/* Profile card */}
                <div className="rounded-xl border border-kds-border bg-kds-card p-5">
                  <div className="flex items-start gap-4">
                    <div className={`h-14 w-14 rounded-full flex items-center justify-center text-2xl font-black shrink-0 ${
                      customerDetail.isBlacklisted ? 'bg-kds-red/20 text-kds-red' : 'bg-kds-border text-kds-text'
                    }`}>
                      {customerDetail.isBlacklisted ? '⛔' : (customerDetail.name[0]?.toUpperCase() ?? '?')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xl font-black text-kds-text">{customerDetail.name}</p>
                        {customerDetail.isBlacklisted && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-kds-red/20 text-kds-red">Blacklisted</span>
                        )}
                      </div>
                      {customerDetail.blacklistReason && (
                        <p className="text-xs text-kds-red mt-0.5">Reason: {customerDetail.blacklistReason}</p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-1">
                        {customerDetail.phone && <span className="text-sm text-kds-subtext">📞 {customerDetail.phone}</span>}
                        {customerDetail.email && <span className="text-sm text-kds-subtext">✉ {customerDetail.email}</span>}
                      </div>
                      <p className="text-xs text-kds-subtext mt-1">
                        Member since {new Date(customerDetail.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-kds-border">
                    <div className="text-center">
                      <p className="text-2xl font-black text-kds-text">{customerDetail.orders.length}</p>
                      <p className="text-xs text-kds-subtext mt-0.5">Orders</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-black text-kds-green">{fmt(customerDetail.totalSpentCents)}</p>
                      <p className="text-xs text-kds-subtext mt-0.5">Spent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-black text-kds-amber">
                        {customerDetail.loyaltyAccount?.pointsBalance ?? '—'}
                      </p>
                      <p className="text-xs text-kds-subtext mt-0.5">Loyalty pts</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-black text-kds-blue">{fmt(customerDetail.walletBalance)}</p>
                      <p className="text-xs text-kds-subtext mt-0.5">Wallet</p>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-4 pt-4 border-t border-kds-border">
                    <button
                      onClick={() => setWalletModal({ id: customerDetail.id, name: customerDetail.name })}
                      className="rounded-lg bg-kds-blue/20 text-kds-blue text-xs font-bold px-3 py-1.5 hover:bg-kds-blue/30 transition-colors">
                      + Top up wallet
                    </button>
                    <button
                      onClick={() => setBlacklistModal({ id: customerDetail.id, name: customerDetail.name, current: customerDetail.isBlacklisted })}
                      className={`rounded-lg text-xs font-bold px-3 py-1.5 transition-colors ${
                        customerDetail.isBlacklisted
                          ? 'bg-kds-green/20 text-kds-green hover:bg-kds-green/30'
                          : 'bg-kds-red/20 text-kds-red hover:bg-kds-red/30'
                      }`}>
                      {customerDetail.isBlacklisted ? 'Remove blacklist' : '⛔ Blacklist'}
                    </button>
                  </div>
                </div>

                {/* Loyalty */}
                {customerDetail.loyaltyAccount && (
                  <div className="rounded-xl border border-kds-border bg-kds-card p-4">
                    <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">Loyalty account</p>
                    <div className="flex items-center gap-4">
                      <div>
                        <p className="text-2xl font-black text-kds-amber">{customerDetail.loyaltyAccount.pointsBalance}</p>
                        <p className="text-xs text-kds-subtext">points</p>
                      </div>
                      {customerDetail.loyaltyAccount.tier && (
                        <span className={`text-sm font-bold px-3 py-1 rounded-full capitalize ${TIER_COLORS[customerDetail.loyaltyAccount.tier] ?? ''}`}>
                          {customerDetail.loyaltyAccount.tier}
                        </span>
                      )}
                    </div>
                    {customerDetail.loyaltyAccount.transactions.length > 0 && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-kds-subtext mb-1">Recent transactions</p>
                        {customerDetail.loyaltyAccount.transactions.slice(0, 5).map((tx) => (
                          <div key={tx.id} className="flex items-center justify-between text-xs">
                            <span className="text-kds-subtext capitalize">{tx.type}</span>
                            <span className={tx.points >= 0 ? 'text-kds-green font-bold' : 'text-kds-red font-bold'}>
                              {tx.points >= 0 ? '+' : ''}{tx.points} pts
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Order history */}
                <div className="rounded-xl border border-kds-border overflow-hidden">
                  <div className="px-4 py-3 bg-kds-card border-b border-kds-border">
                    <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest">Order history</p>
                  </div>
                  {customerDetail.orders.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-kds-subtext">No orders yet</p>
                  ) : (
                    <div className="divide-y divide-kds-border">
                      {customerDetail.orders.map((order) => (
                        <div key={order.id} className="px-4 py-3 hover:bg-kds-card/40 transition-colors">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-mono text-xs text-kds-subtext">#{order.id.slice(-6).toUpperCase()}</p>
                                <span className="text-xs text-kds-subtext">{order.concept.name}</span>
                              </div>
                              <p className="text-xs text-kds-subtext mt-1">
                                {order.items.slice(0, 2).map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                                {order.items.length > 2 && ` +${order.items.length - 2} more`}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-bold text-kds-green">{fmt(order.totalCents)}</p>
                              <p className="text-xs text-kds-subtext mt-0.5">
                                {formatDistanceToNowStrict(new Date(order.placedAt))} ago
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'customers' && !selected && (
            <div className="flex-1 flex items-center justify-center h-full text-kds-subtext">
              <div className="text-center">
                <p className="text-5xl mb-3">👥</p>
                <p className="font-semibold text-kds-text">Select a customer</p>
                <p className="text-sm mt-1">Click any name in the list to view their profile</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
