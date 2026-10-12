'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'
import { fmtPkrWhole } from '../../lib/money'
import { usePermissions } from '../../hooks/useCan'

// THE customer list (the /customers page is a redirect here). Segments live on
// /crm/segments and campaigns on /crm/campaigns — this page used to carry its
// own copy of both (live-counted "smart segments" and a second composer).
//
// Blocking a customer raises a ban for the ACTIVE company (POST /crm/bans —
// owner decision 15: it applies at that company's brands only) and unblocking
// lifts it; the old isBlacklisted toggle is gone.

// The API's MANAGERS (backend modules/auth/middleware.ts). The marketing roles
// (marketing, brand_manager) read and work this page, but blocking a customer
// (POST /crm/bans, /crm/bans/:id/lift) and crediting a wallet (POST
// /wallet/topup) stay with managers — so those buttons show to managers only.
const MANAGER_ROLES = new Set(['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager'])

interface ActiveBan { id: string; reason: string; bannedAt: string }

interface Customer {
  id: string; name: string; phone: string | null; email: string | null
  totalSpentCents: number; lastOrderAt: string | null; createdAt: string
  // One servd-wide balance — the API sends it to managers only (null otherwise).
  walletBalance: number | null
  activeBan: ActiveBan | null
  loyaltyAccount: { pointsBalance: number; tier: string | null } | null
  // The brand this customer most often orders from. Drives the chip in the
  // CRM list so the operator knows which company they're talking to.
  preferredConcept: { name: string; slug: string } | null
  _count: { orders: number }
}

export default function CRMPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isManager = MANAGER_ROLES.has(me?.role ?? '')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [banModal, setBanModal] = useState<{ id: string; name: string; ban: ActiveBan | null } | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState<string | null>(null)
  const [walletModal, setWalletModal] = useState<{ id: string; name: string } | null>(null)
  const [walletAmount, setWalletAmount] = useState('')
  // goodwill = the company's own credit (booked as Marketing & Promo);
  // cash / card / bank = the customer paid for it at that tender (ONL-R2-01).
  const [walletKind, setWalletKind] = useState<'goodwill' | 'cash' | 'card' | 'bank'>('goodwill')
  const [walletError, setWalletError] = useState<string | null>(null)

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
      api.post('/wallet/topup', walletKind === 'goodwill'
        ? { customerId: id, amountCents: amount, kind: 'goodwill', description: 'Goodwill credit by staff' }
        : { customerId: id, amountCents: amount, kind: 'paid', tender: walletKind, description: `Paid top-up (${walletKind})` }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer-detail', selectedId] })
      void qc.invalidateQueries({ queryKey: ['customers'] })
      setWalletModal(null)
      setWalletAmount('')
      setWalletKind('goodwill')
      setWalletError(null)
    },
    onError: (e: Error) => setWalletError(e.message),
  })

  // A deep-linked customer may not be in the first page of the list; the
  // detail fetch alone is enough to open the pane.
  const selected = customers.find((c) => c.id === selectedId) ?? customerDetail ?? null

  const TIER_COLORS: Record<string, string> = {
    bronze: 'text-orange-700 bg-orange-900/30',
    silver: 'text-s-muted bg-s-surface',
    gold:   'text-s-amber bg-s-amber/20',
  }

  const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none w-full'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-s-text mt-0.5">Customers / CRM</h1>
            <p className="text-sm text-s-muted">Customer profiles, loyalty, wallet and blocking</p>
          </div>
          <div className="flex gap-2">
            <Link href="/crm/segments" className="rounded-xl border border-s-border text-s-text text-sm font-semibold px-3 py-1.5 hover:border-primary">Segments</Link>
            <Link href="/crm/campaigns" className="rounded-xl border border-s-border text-s-text text-sm font-semibold px-3 py-1.5 hover:border-primary">Campaigns</Link>
            <Link href="/crm/naughty-list" className="rounded-xl border border-s-border text-s-text text-sm font-semibold px-3 py-1.5 hover:border-primary">Naughty list</Link>
          </div>
        </div>
      </header>

      {/* Block / unblock modal — raises or lifts this company's ban */}
      {banModal && (
        <div className="fixed inset-0 bg-secondary/40 flex items-center justify-center z-50 p-4">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <p className="font-bold text-s-text">
              {banModal.ban ? 'Unblock customer' : 'Block customer'}
            </p>
            <p className="text-sm text-s-muted">{banModal.name}</p>
            <p className="text-xs text-s-muted">
              {banModal.ban
                ? `Blocked: ${banModal.ban.reason}. Unblocking lifts this company's ban; the record stays on the naughty list.`
                : "They won't be able to order or book at this company's brands, and won't receive its campaigns. Other companies are not affected."}
            </p>
            <input value={banReason} onChange={(e) => setBanReason(e.target.value)}
              placeholder={banModal.ban ? 'Why unblock? (required)' : 'Reason (required)'} className={inp} />
            {banError && <p className="text-xs text-s-red">{banError}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => toggleBan.mutate({ id: banModal.id, ban: banModal.ban, reason: banReason.trim() })}
                disabled={toggleBan.isPending || banReason.trim().length < 3}
                className={`flex-1 rounded-xl text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50 ${
                  banModal.ban ? 'bg-primary text-primary-on' : 'bg-s-red text-[#fff]'
                }`}>
                {toggleBan.isPending ? '…' : banModal.ban ? 'Unblock' : 'Block'}
              </button>
              <button onClick={() => { setBanModal(null); setBanReason(''); setBanError(null) }}
                className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wallet top-up modal */}
      {walletModal && (
        <div className="fixed inset-0 bg-secondary/40 flex items-center justify-center z-50 p-4">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <p className="font-bold text-s-text">Wallet top-up</p>
            <p className="text-sm text-s-muted">{walletModal.name}</p>
            <div>
              <label className="text-xs text-s-muted mb-1 block">Amount (PKR)</label>
              <input type="number" min="1" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)}
                placeholder="500" className={inp} />
            </div>
            <div>
              <label className="text-xs text-s-muted mb-1 block">What is it?</label>
              <select value={walletKind} onChange={(e) => setWalletKind(e.target.value as typeof walletKind)} className={inp}>
                <option value="goodwill">Goodwill credit (our cost)</option>
                <option value="cash">Customer paid — cash</option>
                <option value="card">Customer paid — card</option>
                <option value="bank">Customer paid — bank transfer</option>
              </select>
              <p className="text-xs text-s-muted mt-1">
                Credited to the customer&apos;s wallet at the company you are working in, and spendable only at its brands.
              </p>
            </div>
            {walletError && <p className="text-xs text-s-red">{walletError}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => topupWallet.mutate({ id: walletModal.id, amount: Math.round(parseFloat(walletAmount) * 100) })}
                disabled={!walletAmount || topupWallet.isPending}
                className="flex-1 rounded-xl bg-primary text-primary-on text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50">
                {topupWallet.isPending ? 'Crediting…' : 'Credit wallet'}
              </button>
              <button onClick={() => { setWalletModal(null); setWalletAmount(''); setWalletKind('goodwill'); setWalletError(null) }}
                className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-[calc(100vh-81px)]">
        {/* ── Left sidebar ── */}
        <aside className="w-72 shrink-0 border-r border-s-border flex flex-col">
          <div className="p-3 border-b border-s-border">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedId(null) }}
              placeholder="Search name, phone, email…"
              className="w-full rounded-xl bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none" />
          </div>

          <div className="flex-1 overflow-y-auto">
              {isLoading && <p className="px-4 py-3 text-xs text-s-muted">Loading…</p>}
              {!isLoading && customers.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-s-muted">No customers found</p>
              )}
              {customers.map((c) => (
                <button key={c.id} onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left border-b border-s-border/40 transition-colors ${
                    selectedId === c.id ? 'bg-s-surface border-l-2 border-l-primary' : 'hover:bg-s-elevated/50'
                  }`}>
                  <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-xs font-black ${
                    c.activeBan ? 'bg-s-red/20 text-s-red' : 'bg-s-border text-s-muted'
                  }`}>
                    {c.activeBan ? '⛔' : (c.name[0]?.toUpperCase() ?? '?')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <p className="text-sm font-semibold text-s-text truncate">{c.name}</p>
                      {/* Brand chip — so the CRM operator knows which
                          company this customer typically belongs to before
                          they pick up the conversation. Hidden when there's
                          no preferred concept yet (one-off / guest checkout). */}
                      {c.preferredConcept && (
                        <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: 'rgb(61 31 59 / 0.15)', color: '#6b2f68' }}>
                          {c.preferredConcept.name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-s-muted truncate">{c.phone ?? c.email ?? 'No contact'}</p>
                    <p className="text-xs text-s-muted">{c._count.orders} orders · {fmtPkrWhole(c.totalSpentCents)}</p>
                  </div>
                </button>
              ))}
          </div>

          <div className="border-t border-s-border px-4 py-3">
            <p className="text-xs text-s-muted">{customers.length} customer{customers.length !== 1 ? 's' : ''} shown</p>
          </div>
        </aside>

        {/* ── Right panel ── */}
        <div className="flex-1 overflow-y-auto">
          {/* Customer detail */}
          {selected && customerDetail && (
            <div className="p-6">
              <div className="max-w-2xl mx-auto space-y-5">
                {/* Profile card */}
                <div className="rounded-xl border border-s-border bg-s-surface p-5">
                  <div className="flex items-start gap-4">
                    <div className={`h-14 w-14 rounded-full flex items-center justify-center text-2xl font-black shrink-0 ${
                      customerDetail.activeBan ? 'bg-s-red/20 text-s-red' : 'bg-s-border text-s-text'
                    }`}>
                      {customerDetail.activeBan ? '⛔' : (customerDetail.name[0]?.toUpperCase() ?? '?')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xl font-black text-s-text">{customerDetail.name}</p>
                        {customerDetail.activeBan && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-s-red/20 text-s-red">Blocked</span>
                        )}
                      </div>
                      {customerDetail.activeBan && (
                        <p className="text-xs text-s-red mt-0.5">Reason: {customerDetail.activeBan.reason}</p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-1">
                        {customerDetail.phone && <span className="text-sm text-s-muted">📞 {customerDetail.phone}</span>}
                        {customerDetail.email && <span className="text-sm text-s-muted">✉ {customerDetail.email}</span>}
                      </div>
                      <p className="text-xs text-s-muted mt-1">
                        Member since {new Date(customerDetail.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-s-border">
                    <div className="text-center">
                      <p className="text-2xl font-black text-s-text">{customerDetail.orders.length}</p>
                      <p className="text-xs text-s-muted mt-0.5">Orders</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-black text-primary-ink">{fmtPkrWhole(customerDetail.totalSpentCents)}</p>
                      <p className="text-xs text-s-muted mt-0.5">Spent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-black text-s-amber">
                        {customerDetail.loyaltyAccount?.pointsBalance ?? '—'}
                      </p>
                      <p className="text-xs text-s-muted mt-0.5">Loyalty pts</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-black text-s-blue">{customerDetail.walletBalance == null ? '—' : fmtPkrWhole(customerDetail.walletBalance)}</p>
                      <p className="text-xs text-s-muted mt-0.5">Wallet</p>
                    </div>
                  </div>

                  {isManager && (
                  <div className="flex gap-2 mt-4 pt-4 border-t border-s-border">
                    <button
                      onClick={() => setWalletModal({ id: customerDetail.id, name: customerDetail.name })}
                      className="rounded-lg bg-s-blue/20 text-s-blue text-xs font-bold px-3 py-1.5 hover:bg-s-blue/30 transition-colors">
                      + Top up wallet
                    </button>
                    <button
                      onClick={() => setBanModal({ id: customerDetail.id, name: customerDetail.name, ban: customerDetail.activeBan })}
                      className={`rounded-lg text-xs font-bold px-3 py-1.5 transition-colors ${
                        customerDetail.activeBan
                          ? 'bg-primary/20 text-primary-ink hover:bg-primary/30'
                          : 'bg-s-red/20 text-s-red hover:bg-s-red/30'
                      }`}>
                      {customerDetail.activeBan ? 'Unblock' : '⛔ Block'}
                    </button>
                  </div>
                  )}
                </div>

                {/* Loyalty */}
                {customerDetail.loyaltyAccount && (
                  <div className="rounded-xl border border-s-border bg-s-surface p-4">
                    <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-3">Loyalty account</p>
                    <div className="flex items-center gap-4">
                      <div>
                        <p className="text-2xl font-black text-s-amber">{customerDetail.loyaltyAccount.pointsBalance}</p>
                        <p className="text-xs text-s-muted">points</p>
                      </div>
                      {customerDetail.loyaltyAccount.tier && (
                        <span className={`text-sm font-bold px-3 py-1 rounded-full capitalize ${TIER_COLORS[customerDetail.loyaltyAccount.tier] ?? ''}`}>
                          {customerDetail.loyaltyAccount.tier}
                        </span>
                      )}
                    </div>
                    {customerDetail.loyaltyAccount.transactions.length > 0 && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-s-muted mb-1">Recent transactions</p>
                        {customerDetail.loyaltyAccount.transactions.slice(0, 5).map((tx) => (
                          <div key={tx.id} className="flex items-center justify-between text-xs">
                            <span className="text-s-muted capitalize">{tx.type}</span>
                            <span className={tx.pointsDelta >= 0 ? 'text-primary-ink font-bold' : 'text-s-red font-bold'}>
                              {tx.pointsDelta >= 0 ? '+' : ''}{tx.pointsDelta} pts
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Order history */}
                <div className="rounded-xl border border-s-border overflow-hidden">
                  <div className="px-4 py-3 bg-s-surface border-b border-s-border">
                    <p className="text-xs font-bold text-s-muted uppercase tracking-widest">Order history</p>
                  </div>
                  {customerDetail.orders.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-s-muted">No orders yet</p>
                  ) : (
                    <div className="divide-y divide-s-border">
                      {customerDetail.orders.map((order) => (
                        <div key={order.id} className="px-4 py-3 hover:bg-s-elevated/40 transition-colors">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-mono text-xs text-s-muted">#{order.id.slice(-6).toUpperCase()}</p>
                                <span className="text-xs text-s-muted">{order.concept.name}</span>
                              </div>
                              <p className="text-xs text-s-muted mt-1">
                                {order.items.slice(0, 2).map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                                {order.items.length > 2 && ` +${order.items.length - 2} more`}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-bold text-primary-ink">{fmtPkrWhole(order.totalCents)}</p>
                              <p className="text-xs text-s-muted mt-0.5">
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
            <div className="flex-1 flex items-center justify-center h-full text-s-muted">
              <div className="text-center">
                <p className="text-5xl mb-3">👥</p>
                <p className="font-semibold text-s-text">Select a customer</p>
                <p className="text-sm mt-1">Click any name in the list to view their profile</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
