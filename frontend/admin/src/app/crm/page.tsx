'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'
import { fmtPkrWhole } from '../../lib/money'
import { usePermissions } from '../../hooks/useCan'
import { orderRef } from '../../lib/orderRef'
import { useManagerRoles } from '../../lib/roles'
import { useActiveCompany, useMyCompanies } from '../../lib/connectorsApi'
import {
  PaymentReceivedFields, ReferenceUsedBeforeNotice, receiptFieldsValid, receiptMethodLabel, isBankMethod,
  PAYMENT_REFERENCE_ERROR_TEXT, type PaymentRefUse,
} from '../../components/finance/PaymentReceivedFields'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'

// THE customer list (the /customers page is a redirect here). Segments live on
// /crm/segments and campaigns on /crm/campaigns — this page used to carry its
// own copy of both (live-counted "smart segments" and a second composer).
//
// Blocking a customer raises a ban stamped with the ACTIVE company (POST
// /crm/bans). A ban is servd-wide (owner, 2026-10-15): it applies at every
// servd brand. Unblocking lifts this company's ban; a ban another servd kitchen
// raised shows anonymised (id null) and only that kitchen can lift it. The old
// isBlacklisted toggle is gone.

// The API's MANAGERS (served by GET /permissions/role-modules; lib/roles.ts). The marketing roles
// (marketing, brand_manager) read and work this page, but blocking a customer
// (POST /crm/bans, /crm/bans/:id/lift) and crediting a wallet (POST
// /wallet/topup) stay with managers — so those buttons show to managers only.
//
// A wallet top-up is either a goodwill credit (our cost, no money in, no
// reference) or one the customer paid for — a back-office receipt (owner,
// 2026-10-14): cash, bank transfer, bank deposit or cheque (no card) with its
// payment reference # (required on every method), through the shared
// <PaymentReceivedFields>. A reference used before is a notice, never a block.

interface ActiveBan { id: string | null; reason: string; bannedAt: string; otherKitchen?: boolean }

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
  const managerRoles = useManagerRoles()
  const isManager = managerRoles.has(me?.role ?? '')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [banModal, setBanModal] = useState<{ id: string; name: string; ban: ActiveBan | null; elsewhere?: boolean } | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState<string | null>(null)
  const [walletModal, setWalletModal] = useState<{ id: string; name: string } | null>(null)
  const [walletAmount, setWalletAmount] = useState('')
  // goodwill = the company's own credit (booked as Marketing & Promo);
  // paid = the customer paid for it (ONL-R2-01) — how, and its reference #.
  const [walletKind, setWalletKind] = useState<'goodwill' | 'paid'>('goodwill')
  const [walletMethod, setWalletMethod] = useState('cash')
  const [walletRef, setWalletRef] = useState('')
  // A bank-type top-up names the company's bank it landed in (the server
  // books it there — lib/bankAccounts.ts moneyAccountCode).
  const [walletBank, setWalletBank] = useState('')
  // The last paid top-up's reference was used before (a warning — it is saved).
  const [walletNotice, setWalletNotice] = useState<{ customerId: string; uses: PaymentRefUse[] } | null>(null)
  // The company the top-up belongs to — picked here (not by the "All
  // companies" guard) so the bank list and the write agree.
  const [walletCompany, setWalletCompany] = useState('')
  const [walletError, setWalletError] = useState<string | null>(null)
  const activeCompany = useActiveCompany()
  const myCompanies = useMyCompanies()
  const walletTenantId = walletCompany || activeCompany?.id || ''

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

  const resetWallet = () => {
    setWalletModal(null)
    setWalletAmount('')
    setWalletKind('goodwill')
    setWalletMethod('cash')
    setWalletRef('')
    setWalletBank('')
    setWalletError(null)
  }
  const topupWallet = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      api.post<{ referenceUsedBefore?: PaymentRefUse[] }>('/wallet/topup', walletKind === 'goodwill'
        ? { customerId: id, amountCents: amount, kind: 'goodwill', description: 'Goodwill credit by staff' }
        : {
            customerId: id, amountCents: amount, kind: 'paid', tender: walletMethod, paymentRef: walletRef.trim(),
            description: `Paid top-up (${receiptMethodLabel(walletMethod).toLowerCase()})`,
            ...(isBankMethod(walletMethod) && walletBank ? { bankAccountId: walletBank } : {}),
          }, walletTenantId ? { tenantId: walletTenantId } : undefined),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['customer-detail', selectedId] })
      void qc.invalidateQueries({ queryKey: ['customers'] })
      setWalletNotice(r.referenceUsedBefore?.length ? { customerId: v.id, uses: r.referenceUsedBefore } : null)
      resetWallet()
    },
    onError: (e: Error & { code?: string }) => setWalletError((e.code && PAYMENT_REFERENCE_ERROR_TEXT[e.code]) || e.message),
  })
  const walletAmountOk = Number(walletAmount) > 0
  const walletPaymentOk = walletKind === 'goodwill' || receiptFieldsValid({ method: walletMethod, reference: walletRef })

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
        <Modal title={banModal.ban ? 'Unblock customer' : 'Block customer'}
          dirty={banReason.trim().length > 0}
          onClose={() => { setBanModal(null); setBanReason(''); setBanError(null) }}>
          <form className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (!toggleBan.isPending && banReason.trim().length >= 3) toggleBan.mutate({ id: banModal.id, ban: banModal.ban, reason: banReason.trim() }) }}>
            <p className="text-sm text-s-muted">{banModal.name}</p>
            <p className="text-xs text-s-muted">
              {banModal.ban
                ? `Blocked: ${banModal.ban.reason}. Unblocking lifts this company's ban; the record stays on the naughty list.`
                : banModal.elsewhere
                  ? 'Already blocked across servd by another servd kitchen (only that kitchen can lift it). Blocking here adds this company\'s own ban, which stays if theirs is lifted.'
                  : "They won't be able to order or book at any servd brand, and won't receive campaigns."}
            </p>
            <input value={banReason} onChange={(e) => setBanReason(e.target.value)} autoFocus name="ban-reason" autoComplete="off"
              aria-label={banModal.ban ? 'Why unblock? (required)' : 'Reason (required)'}
              placeholder={banModal.ban ? 'Why unblock? (required)' : 'Reason (required)'} className={inp} />
            {banError && <p role="alert" className="text-xs text-s-red">{banError}</p>}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={toggleBan.isPending || banReason.trim().length < 3}
                className={`flex-1 rounded-xl text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50 ${
                  banModal.ban ? 'bg-primary text-primary-on' : 'bg-s-red text-[#fff]'
                }`}>
                {toggleBan.isPending ? '…' : banModal.ban ? 'Unblock' : 'Block'}
              </button>
              <button type="button" onClick={() => { setBanModal(null); setBanReason(''); setBanError(null) }}
                className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Wallet top-up modal */}
      {walletModal && (
        <Modal title="Wallet top-up" onClose={resetWallet} dirty={walletAmount.trim() !== '' || walletRef.trim() !== ''}>
          <form className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (walletAmountOk && walletPaymentOk && !topupWallet.isPending) topupWallet.mutate({ id: walletModal.id, amount: Math.round(parseFloat(walletAmount) * 100) }) }}>
            <p className="text-sm text-s-muted">{walletModal.name}</p>
            <div>
              <label htmlFor="wallet-amount" className="text-xs text-s-muted mb-1 block">Amount (PKR)</label>
              <input id="wallet-amount" type="number" min="1" inputMode="decimal" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)}
                autoFocus placeholder="500" className={inp} />
            </div>
            <div>
              <label htmlFor="wallet-kind" className="text-xs text-s-muted mb-1 block">What is it?</label>
              <Select id="wallet-kind" value={walletKind}
                onChange={(e) => { const k = e.target.value as typeof walletKind; setWalletKind(k); if (k === 'goodwill') { setWalletRef(''); setWalletBank('') } }}
                className={inp}>
                <option value="goodwill">Goodwill credit (our cost)</option>
                <option value="paid">Customer paid</option>
              </Select>
              <p className="text-xs text-s-muted mt-1">
                Credited to the customer&apos;s wallet at the company below, and spendable only at its brands.
              </p>
            </div>
            {myCompanies.length > 1 && (
              <div>
                <label htmlFor="wallet-company" className="text-xs text-s-muted mb-1 block">Company</label>
                <Select id="wallet-company" value={walletTenantId} onChange={(e) => { setWalletCompany(e.target.value); setWalletBank('') }} className={inp}>
                  {myCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
            )}
            {walletKind === 'paid' && (
              <PaymentReceivedFields
                tenantId={walletTenantId}
                method={walletMethod} onMethod={setWalletMethod}
                reference={walletRef} onReference={setWalletRef}
                bankAccountId={walletBank} onBank={setWalletBank}
                idPrefix="wallet"
                selectClassName={inp}
                inputClassName={inp}
                labelClassName="text-xs text-s-muted mb-1 block"
              />
            )}
            {walletError && <p role="alert" className="text-xs text-s-red">{walletError}</p>}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!walletAmountOk || !walletPaymentOk || topupWallet.isPending}
                className="flex-1 rounded-xl bg-primary text-primary-on text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50">
                {topupWallet.isPending ? 'Crediting…' : 'Credit wallet'}
              </button>
              <button type="button" onClick={resetWallet}
                className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="flex h-[calc(100vh-81px)]">
        {/* ── Left sidebar ── */}
        <aside className="w-72 shrink-0 border-r border-s-border flex flex-col">
          <div className="p-3 border-b border-s-border">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedId(null) }}
              placeholder="Search name, phone, email…"
              type="search" name="customer-search" aria-label="Search customers" autoComplete="off" autoCapitalize="none" spellCheck={false}
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
                          style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>
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
                      onClick={() => setBanModal({
                        id: customerDetail.id, name: customerDetail.name,
                        ban: customerDetail.activeBan?.id ? customerDetail.activeBan : null,
                        elsewhere: !!customerDetail.activeBan && !customerDetail.activeBan.id,
                      })}
                      className={`rounded-lg text-xs font-bold px-3 py-1.5 transition-colors ${
                        customerDetail.activeBan?.id
                          ? 'bg-primary/20 text-primary-ink hover:bg-primary/30'
                          : 'bg-s-red/20 text-s-red hover:bg-s-red/30'
                      }`}>
                      {customerDetail.activeBan?.id ? 'Unblock' : 'Block'}
                    </button>
                  </div>
                  )}
                  {isManager && walletNotice && walletNotice.customerId === customerDetail.id && (
                    <div className="mt-3 space-y-1">
                      <ReferenceUsedBeforeNotice uses={walletNotice.uses} />
                      <button onClick={() => setWalletNotice(null)} className="text-xs text-s-muted hover:text-s-text">Dismiss</button>
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
                            <span className={tx.pointsDelta >= 0 ? 'text-success font-bold' : 'text-s-red font-bold'}>
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
                                <p className="font-mono text-xs text-s-muted">#{orderRef(order.id)}</p>
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
