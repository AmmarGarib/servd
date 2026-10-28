'use client'
// Small shared parts of the Journals screens: status badge, the sub-account
// picker for one account, and the account search + drop-down.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { Select } from '@/components/ui/Select'
import { Button, Input } from '@/components/finance/ui'
import type { ChartAccount, EntryStatus, SubAccount } from './journalTypes'

const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' })

/** Entry status in plain words (owner, 2026-10-28: "make the reversal entries easy to understand in ledger"):
 *  a cancelled entry names the entry that cancelled it, a cancelling entry names the one it cancels. */
export function StatusBadge({ status, reversedBy, reverses }: {
  status: EntryStatus
  reversedBy?: { entryDate: string; voucherNo?: string | null } | null
  reverses?: { entryDate?: string; voucherNo?: string | null; description?: string } | null
}) {
  if (status === 'reversed') {
    return <span className="s-badge-amber shrink-0">{reversedBy ? `Cancelled by ${reversedBy.voucherNo ?? 'a later entry'} on ${shortDay(reversedBy.entryDate)}` : 'Cancelled'}</span>
  }
  if (status === 'reversal') {
    const what = reverses?.voucherNo ?? (reverses?.description ? `“${readableDescription(reverses.description)}”` : 'an earlier entry')
    return <span className="s-badge-muted shrink-0">{`Cancels ${what}${reverses?.entryDate ? ` of ${shortDay(reverses.entryDate)}` : ''}`}</span>
  }
  if (status === 'change_pending') return <span className="s-badge-amber shrink-0">Awaiting CEO</span>
  return null
}

/** Active sub-accounts of one account; renders nothing when it has none. */
export function useSubAccounts(accountId: string, tenantId?: string | null) {
  return useQuery<SubAccount[]>({
    queryKey: ['sub-accounts', accountId, 'active', tenantId ?? ''],
    queryFn: () => api.get(`/setup/chart-of-accounts/${accountId}/sub-accounts?active=1`),
    enabled: !!accountId,
    staleTime: 60_000,
  })
}

export function SubAccountSelect({ accountId, value, onChange, label, disabled, compact }: {
  accountId: string; value: string; onChange: (id: string) => void; label: string; disabled?: boolean; compact?: boolean
}) {
  const { data = [] } = useSubAccounts(accountId)
  if (!accountId || data.length === 0) return null
  return (
    <Select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className={`s-select py-1.5 ${compact ? 'w-auto max-w-full text-xs' : 'mt-1 text-xs'}`}>
      <option value="">No sub-account</option>
      {data.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
    </Select>
  )
}

/** Search box + button + drop-down over the chart (GET /setup/chart-of-accounts?q=&active=1). */
export function AccountPicker({ value, onPick, valueKey = 'id', selected }: {
  value: string; onPick: (a: ChartAccount | null) => void; valueKey?: 'id' | 'code'
  /** The account already picked, kept in the list even when a new search drops it. */
  selected?: ChartAccount | null
}) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const { data: found = [], isFetching } = useQuery<ChartAccount[]>({
    queryKey: ['chart-search', q],
    queryFn: () => api.get(`/setup/chart-of-accounts?active=1${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  })
  const data = selected && !found.some((a) => a.id === selected.id) ? [selected, ...found] : found
  const multi = new Set(data.map((a) => a.tenantId)).size > 1
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()) }}>
        <Input aria-label="Search accounts" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search code or name"
          className="w-auto px-2 py-1 text-sm max-w-[11rem]" />
        <Button type="submit" variant="secondary" size="sm">Search</Button>
      </form>
      <Select aria-label="Account" value={value}
        onChange={(e) => onPick(data.find((a) => a[valueKey] === e.target.value) ?? null)}
        className="s-select py-1 text-sm w-auto max-w-[16rem]">
        <option value="">{isFetching ? 'Loading…' : `— pick an account (${data.length}) —`}</option>
        {data.map((a) => <option key={a.id} value={a[valueKey]}>{a.code} — {a.name}{multi && a.companyName ? ` · ${a.companyName}` : ''}</option>)}
      </Select>
    </div>
  )
}

/** Ledger descriptions of system reversals carry the original's internal source key
 *  ("Reversal of manual:<uuid>: …"); show people "Reversal of the original entry: …". */
export function readableDescription(d: string | null | undefined): string {
  return (d ?? '').replace(/([a-z_]+(?:\.[a-z_]+)*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@\d+)?/gi, 'the original entry')
}
