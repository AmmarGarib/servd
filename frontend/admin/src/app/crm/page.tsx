'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'
import { fmtPkrWhole } from '../../lib/money'

// THE customer list (the /customers page is a redirect here). Segments live on
// /crm/segments and campaigns on /crm/campaigns — this page used to carry its
// own copy of both (live-counted "smart segments" and a second composer).
//
// Blocking a customer raises a ban for the ACTIVE company (POST /crm/bans —
// owner decision 15: it applies at that company's brands only) and unblocking
// lifts it; the old isBlacklisted toggle is gone.

interface ActiveBan { id: string; reason: string; bannedAt: string }

interface Customer {
  id: string; name: string; phone: string | null; email: string | null
  totalSpentCents: number; lastOrderAt: string | null; createdAt: string
  walletBalance: number
  activeBan: ActiveBan | null
  loyaltyAccount: { pointsBalance: number; tier: string | null } | null
  // The brand this customer most often orders from. Drives the chip in the
  // CRM list so the operator knows which company they're talking to.
  preferredConcept: { name: string; slug: string } | null
  _count: { orders: number }
}

export default function CRMPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [banModal, setBanModal] = useState<{ id: string; name: string; ban: ActiveBan | null } | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState<string | null>(null)
  const [walletModal, setWalletModal] = useState<{ id: string; name: string } | null>(null)
  const [walletAmount, setWalletAmount] = useState('')

  // Deep link: /crm?customer=<id> opens that customer's detail pane. There is
  // no /crm/:id page — orders, complaints and the old /customers list link
  // here (D11). Read once on mount (window, not useSearchParams, so the page
  // needs no Suspense boundary).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('customer')
    if (id) setSelectedId(id)
  }, [])

  const { data: customersResp, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () => api.get<{ data: Customer[]; cursor: string | null; hasMore: boolean }>(`/crm/customers?search=${encodeURIComponent(search)}&limit=50`),
  })
  const customers = customersResp?.data ?? []

  const { data: customerDetail } = useQuery({
    queryKey: ['customer-detail', selectedId],
    queryFn: () => api.get<Customer & {
      orders: { id: string; totalCents: number; status: string; placedAt: string; concept: { name: string }; items: { name: string; quantity: number }[] }[]
      loyaltyAccount: { pointsBalance: number; tier: string | null; transactions: { id: string; type: string; pointsDelta: number; createdAt: string }[] } | null
    }>(`/crm/customers/${selectedId}`),
    enabled: !!selectedId,
  })

  // Block = raise a ban at the active company; unblock = lift that ban.
  const toggleBan = useMutation({
    mutationFn: ({ id, ban, reason }: { id: string; ban: ActiveBan | null; reason: string }) =>
      ban
        ? api.post(`/crm/bans/${ban.id}/lift`, { reason })
        : api.post('/crm/bans', { customerId: id, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] })
      void qc.invalidateQueries({ queryKey: ['customer-detail', selectedId] })
      setBanModal(null)
      setBanReason('')
      setBanError(null)
    },
    onError: (e: Error) => setBanError(e.message),
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

  // A deep-linked customer may not be in the first page of the list; the
  // detail fetch alone is enough to open the pane.
  const selected = customers.find((c) => c.id === selectedId) ?? customerDetail ?? null

  const TIER_COLORS: Record<string, string> = {
    bronze: 'text-orange-400 bg-orange-900/30',
    silver: 'text-kds-subtext bg-kds-card',
    gold:   'text-kds-amber bg-kds-amber/20',
  }

  const inp = 'rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none w-full'

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-kds-text mt-0.5">Customers / CRM</h1>
            <p className="text-sm text-kds-subtext">Customer profiles, loyalty, wallet and blocking</p>
          </div>
          <div className="flex gap-2">
            <Link href="/crm/segments" className="rounded-xl border border-kds-border text-kds-text text-sm font-semibold px-3 py-1.5 hover:border-kds-green">Segments</Link>
            <Link href="/crm/campaigns" className="rounded-xl border border-kds-border text-kds-text text-sm font-semibold px-3 py-1.5 hover:border-kds-green">Campaigns</Link>
            <Link href="/crm/naughty-list" className="rounded-xl border border-kds-border text-kds-text text-sm font-semibold px-3 py-1.5 hover:border-kds-green">Naughty list</Link>
          </div>
        </div>
      </header>

      {/* Block / unblock modal — raises or lifts this company's ban */}
      {banModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <p className="font-bold text-kds-text">
              {banModal.ban ? 'Unblock customer' : 'Block customer'}
            </p>
            <p className="text-sm text-kds-subtext">{banModal.name}</p>
            <p className="text-xs text-kds-subtext">
              {banModal.ban
                ? `Blocked: ${banModal.ban.reason}. Unblocking lifts this company's ban; the record stays on the naughty list.`
                : "They won't be able to order or book at this company's brands, and won't receive its campaigns. Other companies are not affected."}
            </p>
            <input value={banReason} onChange={(e) => setBanReason(e.target.value)}
              placeholder={banModal.ban ? 'Why unblock? (required)' : 'Reason (required)'} className={inp} />
            {banError && <p className="text-xs text-kds-red">{banError}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => toggleBan.mutate({ id: banModal.id, ban: banModal.ban, reason: banReason.trim() })}
                disabled={toggleBan.isPending || banReason.trim().length < 3}
                className={`flex-1 rounded-xl text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50 ${
                  banModal.ban ? 'bg-kds-green text-black' : 'bg-kds-red text-white'
                }`}>
                {toggleBan.isPending ? '…' : banModal.ban ? 'Unblock' : 'Block'}
              </button>
              <button onClick={() => { setBanModal(null); setBanReason(''); setBanError(null) }}
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
                    c.activeBan ? 'bg-kds-red/20 text-kds-red' : 'bg-kds-border text-kds-subtext'
                  }`}>
                    {c.activeBan ? '⛔' : (c.name[0]?.toUpperCase() ?? '?')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <p className="text-sm font-semibold text-kds-text truncate">{c.name}</p>
                      {/* Brand chip — so the CRM operator knows which
                          company this customer typically belongs to before
                          they pick up the conversation. Hidden when there's
                          no preferred concept yet (one-off / guest checkout). */}
                      {c.preferredConcept && (
                        <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: 'rgba(99,102,241,0.15)', color: '#A5B4FC' }}>
                          {c.preferredConcept.name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-kds-subtext truncate">{c.phone ?? c.email ?? 'No contact'}</p>
                    <p className="text-xs text-kds-subtext">{c._count.orders} orders · {fmtPkrWhole(c.totalSpentCents)}</p>
                  </div>
                </button>
              ))}
          </div>

          <div className="border-t border-kds-border px-4 py-3">
            <p className="text-xs text-kds-subtext">{customers.length} customer{customers.length !== 1 ? 's' : ''} shown</p>
          </div>
        </aside>

        {/* ── Right panel ── */}
        <div className="flex-1 overflow-y-auto">
          {/* Customer detail */}
          {selected && customerDetail && (
            <div className="p-6">
              <div className="max-w-2xl mx-auto space-y-5">
                {/* Profile card */}
                <div className="rounded-xl border border-kds-border bg-kds-card p-5">
                  <div className="flex items-start gap-4">
                    <div className={`h-14 w-14 rounded-full flex items-center justify-center text-2xl font-black shrink-0 ${
                      customerDetail.activeBan ? 'bg-kds-red/20 text-kds-red' : 'bg-kds-border text-kds-text'
                    }`}>
                      {customerDetail.activeBan ? '⛔' : (customerDetail.name[0]?.toUpperCase() ?? '?')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xl font-black text-kds-text">{customerDetail.name}</p>
                        {customerDetail.activeBan && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-kds-red/20 text-kds-red">Blocked</span>
                        )}
                      </div>
                      {customerDetail.activeBan && (
                        <p className="text-xs text-kds-red mt-0.5">Reason: {customerDetail.activeBan.reason}</p>
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
                      <p className="text-lg font-black text-kds-green">{fmtPkrWhole(customerDetail.totalSpentCents)}</p>
                      <p className="text-xs text-kds-subtext mt-0.5">Spent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-black text-kds-amber">
                        {customerDetail.loyaltyAccount?.pointsBalance ?? '—'}
                      </p>
                      <p className="text-xs text-kds-subtext mt-0.5">Loyalty pts</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-black text-kds-blue">{fmtPkrWhole(customerDetail.walletBalance)}</p>
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
                      onClick={() => setBanModal({ id: customerDetail.id, name: customerDetail.name, ban: customerDetail.activeBan })}
                      className={`rounded-lg text-xs font-bold px-3 py-1.5 transition-colors ${
                        customerDetail.activeBan
                          ? 'bg-kds-green/20 text-kds-green hover:bg-kds-green/30'
                          : 'bg-kds-red/20 text-kds-red hover:bg-kds-red/30'
                      }`}>
                      {customerDetail.activeBan ? 'Unblock' : '⛔ Block'}
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
                            <span className={tx.pointsDelta >= 0 ? 'text-kds-green font-bold' : 'text-kds-red font-bold'}>
                              {tx.pointsDelta >= 0 ? '+' : ''}{tx.pointsDelta} pts
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
                              <p className="text-sm font-bold text-kds-green">{fmtPkrWhole(order.totalCents)}</p>
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

          {!selected && (
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
