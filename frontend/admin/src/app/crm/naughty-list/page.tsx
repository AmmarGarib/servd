'use client'

// Naughty list — customers who've cost us money. Three views in one page:
//   ALL OFFENDERS — every customer with active strikes or a ban (default)
//   BANNED ONLY   — only the ones who've crossed the threshold
//   FILTERED BY KIND — drill into specific offense types
//
// Each row exposes: strike count, ban status, recent strikes,
// "Forgive a strike" / "Lift ban" actions.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { useManagerRoles } from '../../../lib/roles'
import { Select } from '@/components/ui/Select'

// The API's MANAGERS (served by GET /permissions/role-modules; lib/roles.ts). Forgiving a strike
// and lifting a ban stay with managers; the marketing roles (who hold the crm
// module) read this list but do not get those buttons.
function useIsManager(): boolean {
  const { data: me } = usePermissions()
  return useManagerRoles().has(me?.role ?? '')
}

interface Customer {
  id: string; name: string; email: string | null; phone: string | null
  strikeCount: number
  bannedAt: string | null
  totalSpentCents: number
  lastOrderAt: string | null
}

interface Strike {
  id: string
  kind: string
  severity: number
  reason: string | null
  recordedAt: string
  expiresAt: string | null
  reversedAt: string | null
  reversalReason: string | null
  /** Recorded by another servd company: details withheld. */
  otherKitchen?: boolean
}

interface Row {
  customer: Customer
  activeStrikes: number
  totalStrikes: number
  strikes: Strike[]
}

interface Ban {
  /** null when another servd kitchen raised it (shown anonymised). */
  id: string | null
  otherKitchen?: boolean
  customerId: string | null
  email: string | null
  phone: string | null
  reason: string
  bannedById: string | null
  bannedAt: string
  liftedAt: string | null
  liftReason: string | null
  expiresAt: string | null
  customer: { id: string; name: string; email: string | null; phone: string | null } | null
}

const KIND_OPTIONS = [
  { value: '',                     label: 'All offenses', emoji: '⚠️' },
  { value: 'reservation_no_show',  label: 'Reservation no-shows', emoji: '📅' },
  { value: 'cod_unpaid',           label: 'Cash on delivery — unpaid', emoji: '💸' },
  { value: 'cod_refused',          label: 'Refused at door', emoji: '🚫' },
  { value: 'chargeback',           label: 'Chargebacks', emoji: '↩️' },
  { value: 'other',                label: 'Other (manual)', emoji: '✏️' },
] as const

function fmtKind(k: string): string {
  return KIND_OPTIONS.find((o) => o.value === k)?.label ?? k
}

export default function NaughtyListPage() {
  const [tab, setTab] = useState<'offenders' | 'bans'>('offenders')
  const [bannedOnly, setBannedOnly] = useState(false)
  const [kindFilter, setKindFilter] = useState<string>('')

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/crm" className="text-xs text-white/40 hover:text-white/70">← CRM</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Naughty list</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Three strikes and you&rsquo;re out. Customers who no-show, refuse cash deliveries, or refuse food at the door rack up strikes.
          Strikes and bans are on the customer&rsquo;s servd account: strikes from every servd kitchen count together, and at 3 active strikes
          their email + phone get added to the ban list and they can&rsquo;t reserve or order at any servd brand until the kitchen that raised the ban lifts it.
          Another kitchen&rsquo;s strikes and bans show here as &ldquo;another servd kitchen&rdquo;; the Block button on a customer&rsquo;s CRM profile raises a ban too.
        </p>
      </header>

      <div className="px-7 py-5">
        {/* Tabs */}
        <div className="flex items-center gap-2 mb-4">
          <Tab active={tab === 'offenders'} onClick={() => setTab('offenders')}>Offenders</Tab>
          <Tab active={tab === 'bans'}      onClick={() => setTab('bans')}>Bans</Tab>
        </div>

        {tab === 'offenders' && (
          <>
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-white/65">
                <input type="checkbox" checked={bannedOnly} onChange={(e) => setBannedOnly(e.target.checked)}
                  className="accent-rose-500" />
                Banned only
              </label>
              <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}
                className="rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 text-xs text-white/85">
                {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.emoji} {o.label}</option>)}
              </Select>
            </div>
            <OffendersList bannedOnly={bannedOnly} kindFilter={kindFilter} />
          </>
        )}

        {tab === 'bans' && <BansList />}
      </div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-xs font-bold transition-all"
      style={active
        ? { background: 'rgba(244,63,94,0.15)', color: '#b42318', border: '1px solid rgba(244,63,94,0.4)' }
        : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.55)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
      {children}
    </button>
  )
}

// ─── Offenders list ─────────────────────────────────────────────────────────

function OffendersList({ bannedOnly, kindFilter }: { bannedOnly: boolean; kindFilter: string }) {
  const params = new URLSearchParams()
  if (bannedOnly) params.set('bannedOnly', '1')
  if (kindFilter) params.set('kind', kindFilter)
  const qs = params.toString() ? `?${params.toString()}` : ''

  const { data, isLoading } = useQuery<Row[]>({
    queryKey: ['naughty', bannedOnly, kindFilter],
    queryFn: () => api.get<Row[]>(`/crm/naughty-list${qs}`),
    refetchInterval: 60_000,
  })

  if (isLoading) return <p className="text-sm text-white/40">Loading…</p>
  if (!data || data.length === 0) return <Empty msg="🌟 No offenders. Everyone's behaving today." />

  return (
    <div className="space-y-2">
      {data.map((row) => <OffenderRow key={row.customer.id} row={row} />)}
    </div>
  )
}

function OffenderRow({ row }: { row: Row }) {
  const [expanded, setExpanded] = useState(false)
  const { customer, activeStrikes, strikes } = row
  const isManager = useIsManager()
  const banned = !!customer.bannedAt

  return (
    <div className={`rounded-xl border ${banned ? 'border-rose-500/40' : activeStrikes >= 2 ? 'border-amber-500/40' : 'border-white/[0.08]'}`}
      style={{ background: banned ? 'rgba(244,63,94,0.06)' : 'rgb(var(--fg-rgb) / 0.02)' }}>
      <button onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white/90">{customer.name}</span>
            {banned && <Badge color="rose" label="🚫 BANNED" />}
            {!banned && activeStrikes >= 2 && <Badge color="amber" label="⚠ 1 strike from ban" />}
            <span className="text-[11px] font-mono text-white/35">
              {customer.phone ?? customer.email ?? '—'}
            </span>
          </div>
          <div className="text-[11px] text-white/45 mt-0.5">
            {activeStrikes} active strike{activeStrikes === 1 ? '' : 's'} · {row.totalStrikes} lifetime
            {customer.totalSpentCents > 0 && <> · Rs. {(customer.totalSpentCents / 100).toFixed(0)} lifetime spend</>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StrikeMeter active={activeStrikes} />
          <span className="text-white/30">{expanded ? '⌃' : '⌄'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-2">Recent strikes</p>
          {strikes.length === 0 && <p className="text-xs text-white/40">No strikes recorded.</p>}
          <div className="space-y-1.5">
            {strikes.map((s) => <StrikeLine key={s.id} strike={s} />)}
          </div>
          {banned && isManager && (
            <div className="mt-3 pt-3 border-t border-rose-500/15">
              <LiftBanForm customerId={customer.id} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StrikeMeter({ active }: { active: number }) {
  return (
    <div className="flex gap-1">
      {[1,2,3].map((n) => (
        <div key={n} className="w-2.5 h-2.5 rounded-full"
          style={{ background: n <= active ? '#f43f5e' : 'rgb(var(--fg-rgb) / 0.12)' }} />
      ))}
    </div>
  )
}

function StrikeLine({ strike }: { strike: Strike }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [showForgive, setShowForgive] = useState(false)
  const isReversed = !!strike.reversedAt
  const isExpired = !!strike.expiresAt && new Date(strike.expiresAt) <= new Date()
  const isManager = useIsManager()

  const reverse = useMutation({
    mutationFn: () => api.post(`/crm/strikes/${strike.id}/reverse`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['naughty'] }),
  })

  return (
    <div className={`text-xs ${isReversed || isExpired ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-bold text-white/85">{fmtKind(strike.kind)}</span>
          {strike.otherKitchen && <span className="ml-2 text-[10px] text-white/45">· another servd kitchen</span>}
          {strike.severity > 1 && (
            <span className="ml-1.5 text-[9px] font-bold px-1.5 rounded text-rose-700"
              style={{ background: 'rgba(244,63,94,0.15)' }}>×{strike.severity}</span>
          )}
          <span className="text-white/40 ml-2">{new Date(strike.recordedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          {isReversed && <span className="ml-2 text-[10px] text-primary-ink">↺ reversed</span>}
          {isExpired && !isReversed && <span className="ml-2 text-[10px] text-white/40">expired</span>}
        </div>
        {isManager && !isReversed && !isExpired && !strike.otherKitchen && (
          <button onClick={() => setShowForgive(!showForgive)}
            className="text-[10px] text-primary-ink hover:underline whitespace-nowrap">
            forgive
          </button>
        )}
      </div>
      {strike.reason && <p className="text-white/55 italic mt-0.5">{strike.reason}</p>}
      {isManager && showForgive && !isReversed && (
        <div className="mt-2 flex gap-2 items-center">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you forgiving this?"
            className="flex-1 rounded bg-white/[0.04] border border-white/[0.1] px-2 py-1 text-xs text-white/85" />
          <button onClick={() => reverse.mutate()} disabled={!reason.trim() || reverse.isPending}
            className="rounded bg-primary px-2 py-1 text-[10px] font-bold text-primary-on disabled:opacity-40">
            {reverse.isPending ? '…' : 'Forgive'}
          </button>
        </div>
      )}
    </div>
  )
}

function LiftBanForm({ customerId }: { customerId: string }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)

  // Look up the active ban id for this customer (reverse from naughty-list).
  const { data: bans } = useQuery<Ban[]>({
    queryKey: ['bans-active'],
    queryFn: () => api.get<Ban[]>('/crm/bans?activeOnly=1'),
    staleTime: 30_000,
  })
  const ban = bans?.find((b) => b.customerId === customerId && !b.liftedAt && !!b.id)
  const elsewhere = bans?.some((b) => b.customerId === customerId && !b.liftedAt && b.otherKitchen)

  const lift = useMutation({
    mutationFn: () => api.post(`/crm/bans/${ban!.id}/lift`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['naughty'] })
      qc.invalidateQueries({ queryKey: ['bans-active'] })
    },
  })

  if (!ban && elsewhere) return <p className="text-xs text-white/40">Blocked across servd by another servd kitchen &mdash; only that kitchen can lift it.</p>
  if (!ban) return <p className="text-xs text-white/40">Ban already lifted.</p>
  return (
    <div>
      <p className="text-[11px] text-rose-700 font-bold mb-2">Lift the ban</p>
      <p className="text-[10px] text-white/45 mb-2">{ban.reason}</p>
      {!confirm ? (
        <button onClick={() => setConfirm(true)}
          className="rounded bg-primary/15 border border-primary/30 px-3 py-1 text-[11px] font-bold text-primary-ink hover:bg-primary/25">
          Reinstate this customer →
        </button>
      ) : (
        <div className="flex gap-2 items-center">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for lifting (audit trail)"
            className="flex-1 rounded bg-white/[0.04] border border-white/[0.1] px-2 py-1 text-xs text-white/85" />
          <button onClick={() => lift.mutate()} disabled={!reason.trim() || lift.isPending}
            className="rounded bg-primary px-3 py-1 text-[11px] font-bold text-primary-on disabled:opacity-40">
            {lift.isPending ? '…' : 'Lift ban'}
          </button>
          <button onClick={() => setConfirm(false)} className="text-[10px] text-white/40">cancel</button>
        </div>
      )}
    </div>
  )
}

// ─── Bans tab ───────────────────────────────────────────────────────────────

function BansList() {
  const { data, isLoading } = useQuery<Ban[]>({
    queryKey: ['bans'],
    queryFn: () => api.get<Ban[]>('/crm/bans'),
  })

  if (isLoading) return <p className="text-sm text-white/40">Loading…</p>
  if (!data || data.length === 0) return <Empty msg="🌟 No bans. Operating clean." />

  const active = data.filter((b) => !b.liftedAt && (!b.expiresAt || new Date(b.expiresAt) > new Date()))
  const lifted = data.filter((b) => b.liftedAt || (b.expiresAt && new Date(b.expiresAt) <= new Date()))

  return (
    <div className="space-y-6">
      {active.length > 0 && (
        <section>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-rose-700 mb-2">Active ({active.length})</p>
          <div className="space-y-2">{active.map((b) => <BanRow key={b.id ?? `other-${b.customerId}-${b.bannedAt}`} ban={b} />)}</div>
        </section>
      )}
      {lifted.length > 0 && (
        <section>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/40 mb-2">Lifted / expired ({lifted.length})</p>
          <div className="space-y-2">{lifted.map((b) => <BanRow key={b.id ?? `other-${b.customerId}-${b.bannedAt}`} ban={b} />)}</div>
        </section>
      )}
    </div>
  )
}

function BanRow({ ban }: { ban: Ban }) {
  const isLifted = !!ban.liftedAt
  return (
    <div className="rounded-xl px-4 py-3 border"
      style={{
        background: isLifted ? 'rgb(var(--fg-rgb) / 0.02)' : 'rgba(244,63,94,0.06)',
        borderColor: isLifted ? 'rgb(var(--fg-rgb) / 0.08)' : 'rgba(244,63,94,0.3)',
        opacity: isLifted ? 0.7 : 1,
      }}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-white/90 truncate">
            {ban.customer?.name ?? ban.email ?? ban.phone ?? '—'}
          </p>
          <p className="text-[11px] text-white/45 mt-0.5">
            {ban.email && <span className="font-mono">{ban.email}</span>}
            {ban.email && ban.phone && ' · '}
            {ban.phone && <span className="font-mono">{ban.phone}</span>}
          </p>
          <p className="text-[11px] text-white/55 mt-1 italic">{ban.reason}</p>
          {isLifted && (
            <p className="text-[10px] text-primary-ink/80 mt-1">
              Lifted {new Date(ban.liftedAt!).toLocaleDateString('en-GB')} — {ban.liftReason}
            </p>
          )}
        </div>
        <div className="text-[10px] text-white/35 whitespace-nowrap">
          {new Date(ban.bannedAt).toLocaleDateString('en-GB')}
        </div>
      </div>
    </div>
  )
}

// ─── Bits ──────────────────────────────────────────────────────────────────

function Badge({ color, label }: { color: 'rose' | 'amber'; label: string }) {
  const styles = color === 'rose'
    ? { bg: 'rgba(244,63,94,0.15)', text: '#b42318' }
    : { bg: 'rgba(245,158,11,0.15)', text: '#a15c00' }
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
      style={{ background: styles.bg, color: styles.text }}>{label}</span>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 p-12 text-center text-sm text-white/40">
      {msg}
    </div>
  )
}
