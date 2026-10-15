'use client'
// Head office → Books: the recharge (6990) and per-company charges accounts,
// the cost pool, the CA confirmation (tax answer required) and the recharge
// switch. Any change to accounts, pool or links clears the confirmation and
// switches recharge off (server rule).

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Select } from '../../../../components/ui/Select'
import {
  headOfficeApi, monthLabel, monthRange, addMonthsTo, currentMonthPkt, WARNING_BOX_STYLE,
  type BooksView, type CostPool, type HeadOfficeDetail,
} from '../../../../lib/headOfficeApi'
import { api } from '../../../../lib/api'
import { Modal, errText } from './CompaniesTab'

interface ChartAccount { id: string; tenantId: string; code: string; name: string; type: string; isActive: boolean; controlledBy?: string | null }

/** Every chart the CEO belongs to, in one read (portfolio header); each picker filters its own company. */
function useChart() {
  return useQuery({
    queryKey: ['ho-chart-all'],
    queryFn: () => api.getAcrossTenants<ChartAccount[]>('/setup/chart-of-accounts'),
  })
}

function AccountPicker({ tenantId, types, value, onPick, disabled }: { tenantId: string; types: string[]; value: string; onPick: (id: string) => void; disabled?: boolean }) {
  const { data } = useChart()
  const rows = (data ?? []).filter((a) => a.tenantId === tenantId && a.isActive && !a.controlledBy && types.includes(a.type))
  return (
    <Select className="s-select w-full" value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)}>
      <option value="">Pick an account…</option>
      {rows.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
    </Select>
  )
}

function ConfirmDialog({ hoId, books, detail, onClose, onDone }: { hoId: string; books: BooksView; detail: HeadOfficeDetail; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [tax, setTax] = useState('')
  const [ticks, setTicks] = useState({ names: false, pool: false, split: false })
  const split = detail.currentSplit
  const save = useMutation({
    mutationFn: () => headOfficeApi.confirmBooks(hoId, { note: note.trim(), taxAnswer: tax.trim() }),
    onSuccess: () => { toast.success('Accounts confirmed'); onDone() },
    onError: (e) => toast.error(errText(e)),
  })
  const ready = ticks.names && ticks.pool && ticks.split && note.trim().length >= 10 && tax.trim().length >= 10
  const Check = ({ k, children }: { k: keyof typeof ticks; children: React.ReactNode }) => (
    <label className="flex items-start gap-2 text-xs text-white/75">
      <input type="checkbox" className="mt-0.5" checked={ticks[k]} onChange={(e) => setTicks((s) => ({ ...s, [k]: e.target.checked }))} />
      <span>{children}</span>
    </label>
  )
  return (
    <Modal title="Confirm the accounts with your CA" onClose={onClose}>
      <p className="text-xs text-white/55 mb-3">Tick each line once your CA has seen it.</p>
      <div className="space-y-2">
        <Check k="names">
          Names and codes: recharge account <b>{books.rechargeAccount ? `${books.rechargeAccount.code} ${books.rechargeAccount.name}` : 'none'}</b>
          {books.links.map((l) => <span key={l.linkId} className="block text-white/55">{l.companyName}: {l.chargesAccount ? `${l.chargesAccount.code} ${l.chargesAccount.name}` : 'none'}</span>)}
        </Check>
        <Check k="pool">
          Cost pool: {books.costPool.include.map((r) => `${r.from}–${r.to}`).join(', ') || 'no ranges'}
          {books.costPool.includeCodes.length > 0 && `, plus ${books.costPool.includeCodes.join(', ')}`}
          {books.costPool.excludeCodes.length > 0 && `, minus ${books.costPool.excludeCodes.join(', ')}`}
        </Check>
        <Check k="split">
          % table: {split ? split.lines.map((l) => `${detail.links.find((x) => x.companyTenantId === l.companyTenantId)?.companyName ?? 'Company'} ${(l.shareBps / 100).toFixed(2)}%`).join(', ') : 'no split yet'}
        </Check>
      </div>
      <label className="block text-xs font-bold text-white/60 mt-4 mb-1">What the CA confirmed</label>
      <textarea className="s-input w-full" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="At least 10 characters" />
      <label className="block text-xs font-bold text-white/60 mt-3 mb-1">The CA&rsquo;s tax answer (required)</label>
      <textarea className="s-input w-full" rows={2} value={tax} onChange={(e) => setTax(e.target.value)} placeholder="How is the monthly charge taxed? At least 10 characters" />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="s-btn-secondary text-xs" onClick={onClose}>Cancel</button>
        <button type="button" className="s-btn-primary text-xs" disabled={!ready || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Confirming…' : 'Confirm'}</button>
      </div>
    </Modal>
  )
}

function PoolEditor({ hoId, pool, onDone }: { hoId: string; pool: CostPool; onDone: () => void }) {
  const [ranges, setRanges] = useState(pool.include.map((r) => ({ from: String(r.from), to: String(r.to) })))
  const [inc, setInc] = useState(pool.includeCodes.join(', '))
  const [exc, setExc] = useState(pool.excludeCodes.join(', '))
  const codes = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
  const save = useMutation({
    mutationFn: () => headOfficeApi.savePool(hoId, {
      include: ranges.map((r) => ({ from: Number(r.from), to: Number(r.to) })),
      includeCodes: codes(inc), excludeCodes: codes(exc),
    }),
    onSuccess: () => { toast.success('Cost pool saved. Confirm with your CA again.'); onDone() },
    onError: (e) => toast.error(errText(e)),
  })
  return (
    <div className="space-y-2">
      {ranges.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-xs text-white/60">
          <input className="s-input w-24" inputMode="numeric" value={r.from} aria-label="From code" onChange={(e) => setRanges((s) => s.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} />
          to
          <input className="s-input w-24" inputMode="numeric" value={r.to} aria-label="To code" onChange={(e) => setRanges((s) => s.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} />
          <button type="button" className="s-btn-ghost text-xs" onClick={() => setRanges((s) => s.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className="s-btn-secondary text-xs" onClick={() => setRanges((s) => [...s, { from: '5000', to: '6999' }])}>Add a range</button>
      <label className="block text-xs font-bold text-white/60 mt-2">Also include codes</label>
      <input className="s-input w-full" value={inc} onChange={(e) => setInc(e.target.value)} placeholder="e.g. 7010, 7020" />
      <label className="block text-xs font-bold text-white/60">Leave out codes</label>
      <input className="s-input w-full" value={exc} onChange={(e) => setExc(e.target.value)} placeholder="e.g. 6990" />
      <button type="button" className="s-btn-primary text-xs" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save pool'}</button>
    </div>
  )
}

export default function BooksTab({ hoId, detail, reload }: { hoId: string; detail: HeadOfficeDetail; reload: () => void }) {
  const books = detail.books
  const [confirming, setConfirming] = useState(false)
  const [rechargeAcc, setRechargeAcc] = useState('')
  const [charges, setCharges] = useState<Record<string, string>>({})
  const [from, setFrom] = useState(books?.rechargeFromPeriod ?? addMonthsTo(currentMonthPkt(), 1))
  const [lockRule, setLockRule] = useState(books?.requireLockedPayroll ?? true)
  const map = useMutation({
    mutationFn: () => headOfficeApi.mapAccounts(hoId, {
      ...(rechargeAcc ? { rechargeAccountId: rechargeAcc } : {}),
      charges: Object.entries(charges).filter(([, v]) => v).map(([companyTenantId, accountId]) => ({ companyTenantId, accountId })),
    }),
    onSuccess: () => { toast.success('Accounts saved. Confirm with your CA again.'); setRechargeAcc(''); setCharges({}); reload() },
    onError: (e) => toast.error(errText(e)),
  })
  const sw = useMutation({
    mutationFn: (enabled: boolean) => headOfficeApi.setRecharge(hoId, { enabled, fromPeriod: from, requireLockedPayroll: lockRule }),
    onSuccess: (_r, enabled) => { toast.success(enabled ? 'Recharge is on' : 'Recharge is off'); reload() },
    onError: (e) => toast.error(errText(e)),
  })
  if (!books) return <p className="text-sm text-white/50">This head office has no books yet.</p>
  const dirty = !!rechargeAcc || Object.values(charges).some(Boolean)
  const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        {books.confirmed
          ? <span className="s-badge-purple">Confirmed with the CA {books.accountsConfirmedAt ? new Date(books.accountsConfirmedAt).toLocaleDateString('en-GB') : ''}</span>
          : <span className="s-badge-amber">Confirm with your CA</span>}
        {books.rechargeEnabled ? <span className="s-badge-green">Recharge on from {monthLabel(books.rechargeFromPeriod)}</span> : <span className="s-badge-muted">Recharge off</span>}
        <button type="button" className="s-btn-primary text-xs ml-auto" onClick={() => setConfirming(true)}>{books.confirmed ? 'Confirm again' : 'Confirm with the CA'}</button>
      </div>
      {books.warnings.length > 0 && (
        <ul className="rounded-xl p-3 text-xs space-y-1" style={WARNING_BOX_STYLE}>
          {books.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      <section className="rounded-2xl p-4" style={card}>
        <h3 className="text-sm font-black text-white/85">Accounts</h3>
        <p className="text-[11px] text-white/45 mb-3">Changing an account switches recharge off until the CA confirms again.</p>
        <label className="block text-xs font-bold text-white/60 mb-1">Head office: costs recharged (credits)</label>
        <p className="text-xs text-white/60 mb-1">Now: {books.rechargeAccount ? `${books.rechargeAccount.code} ${books.rechargeAccount.name}` : 'none'}</p>
        <AccountPicker tenantId={books.tenantId} types={['expense', 'revenue']} value={rechargeAcc} onPick={setRechargeAcc} />
        <div className="mt-4 space-y-3">
          {books.links.map((l) => (
            <div key={l.linkId}>
              <label className="block text-xs font-bold text-white/60 mb-1">{l.companyName}: head office charges (expense)</label>
              <p className="text-xs text-white/60 mb-1">Now: {l.chargesAccount ? `${l.chargesAccount.code} ${l.chargesAccount.name}` : 'none'}</p>
              <AccountPicker tenantId={l.companyTenantId} types={['expense']} value={charges[l.companyTenantId] ?? ''} onPick={(id) => setCharges((s) => ({ ...s, [l.companyTenantId]: id }))} />
            </div>
          ))}
        </div>
        <button type="button" className="s-btn-primary text-xs mt-3" disabled={!dirty || map.isPending} onClick={() => map.mutate()}>{map.isPending ? 'Saving…' : 'Save accounts'}</button>
      </section>

      <section className="rounded-2xl p-4" style={card}>
        <h3 className="text-sm font-black text-white/85">Cost pool</h3>
        <p className="text-[11px] text-white/45 mb-3">The head office accounts whose month&rsquo;s total is shared between the companies.</p>
        <PoolEditor key={JSON.stringify(books.costPool)} hoId={hoId} pool={books.costPool} onDone={reload} />
      </section>

      <section className="rounded-2xl p-4" style={card}>
        <h3 className="text-sm font-black text-white/85">Recharge switch</h3>
        <p className="text-[11px] text-white/45 mb-3">Off until the accounts are confirmed. Nothing is charged before the first month.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs font-bold text-white/60">First month</label>
          <div className="w-40">
            <Select className="s-select w-full" value={from} onChange={(e) => setFrom(e.target.value)}>
              {monthRange(addMonthsTo(currentMonthPkt(), -6), 20).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
          </div>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs text-white/75">
          <input type="checkbox" className="mt-0.5" checked={lockRule} onChange={(e) => setLockRule(e.target.checked)} />
          <span>Charge a month only after its payroll is locked</span>
        </label>
        <div className="mt-3 flex gap-2">
          {books.rechargeEnabled
            ? <>
              <button type="button" className="s-btn-secondary text-xs" disabled={sw.isPending} onClick={() => sw.mutate(true)}>Save first month and rule</button>
              <button type="button" className="s-btn-danger text-xs" disabled={sw.isPending} onClick={() => sw.mutate(false)}>Switch recharge off</button>
            </>
            : <button type="button" className="s-btn-primary text-xs" disabled={!books.confirmed || sw.isPending} onClick={() => sw.mutate(true)}>Switch recharge on</button>}
        </div>
        {!books.confirmed && !books.rechargeEnabled && <p className="mt-2 text-[11px] text-white/45">Confirm the accounts with your CA first.</p>}
      </section>
      {confirming && <ConfirmDialog hoId={hoId} books={books} detail={detail} onClose={() => setConfirming(false)} onDone={() => { setConfirming(false); reload() }} />}
    </div>
  )
}
