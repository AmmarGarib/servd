'use client'
// Petty cash — the cash boxes (Jamil sb's and the outlets'), on the books.
// Every rupee in a box sits on 1011 Petty cash: a top-up names where the cash
// came from (the Garibsons cashier by default, the safe, a bank account or a
// till drawer), a spend says what it was for (expense lines — kitchen food is
// stock and equipment is CapEx — or a supplier bill paid in cash), cash can go
// back out to Garibsons / the safe / a bank, a count books its difference to
// 8010 and a transfer between two boxes books nothing. The server books each
// one as it is saved (backend accounting/pettyCashPosting.ts); each movement
// shows Booked. The tie-out at the top checks the boxes against the books.
// Money is typed in rupees (MoneyInput) and sent in paisa.
//
// Managers and finance (with the books module) run every box. A box's
// custodian who is neither sees only the boxes they hold (GET
// /trustops/petty-cash/boxes?mine=1) and can top them up and spend from them.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { useAuthStore } from '../../../store/auth'
import { TopUpModal, SourcePicker, DEFAULT_SOURCE, sourceBody, sourceReady, type SourceValue } from './TopUpModal'
import { SpendModal } from './SpendModal'
import { ReturnModal } from './ReturnModal'
import { TieOutBanner } from './TieOutBanner'
import {
  ErrorBanner, Field, Footer, Modal, fieldCls, pinRefusal, pkr, primaryBtn, sourceLabel, TYPE_LABEL,
  type Box, type Movement,
  firstMissing, focusField, useSubmitOnce,
} from './ui'
import { Select } from '@/components/ui/Select'

interface User { id: string; name: string }

const LEDGER_BADGE: Record<Movement['ledger'], { cls: string; label: string }> = {
  booked: { cls: 's-badge-green', label: 'Booked' },
  not_booked: { cls: 's-badge-amber', label: 'Not booked' },
  no_entry: { cls: 's-badge-muted', label: 'No entry' },
}

export default function PettyCashPage() {
  const qc = useQueryClient()
  const keeperList = useQuery<Box[]>({
    queryKey: ['petty-cash-boxes'],
    queryFn: () => api.get('/trustops/petty-cash/boxes'),
    retry: false, meta: { background: true },
  })
  // Not a cash keeper: the boxes I hold (no history, no other boxes).
  const notKeeper = keeperList.error instanceof ApiError && keeperList.error.status === 403
  const mineList = useQuery<Box[]>({
    queryKey: ['petty-cash-boxes', 'mine'],
    queryFn: async () => (await api.get<Omit<Box, 'movements'>[]>('/trustops/petty-cash/boxes?mine=1')).map((b) => ({ ...b, movements: [] })),
    enabled: notKeeper,
  })
  const isKeeper = !notKeeper
  const boxes: Box[] = (isKeeper ? keeperList.data : mineList.data) ?? []
  // The staff-account list is the managers' (and HR's). Finance works petty
  // cash without it: the box already carries its custodian's name, and the
  // picker below falls back to "me" — no 403 toast (meta.background).
  const me = useAuthStore((s) => s.user)
  const { data: staff } = useQuery<User[]>({
    queryKey: ['users'], queryFn: () => api.get('/auth/users'),
    retry: false, meta: { background: true }, enabled: isKeeper,
  })
  const users: User[] = staff ?? (me ? [{ id: me.id, name: me.name }] : [])
  const [creating, setCreating] = useState(false)
  const [spendFor, setSpendFor] = useState<Box | null>(null)
  const [topUpFor, setTopUpFor] = useState<Box | null>(null)
  const [returnFor, setReturnFor] = useState<Box | null>(null)
  const [reconcileFor, setReconcileFor] = useState<Box | null>(null)
  const [transferFrom, setTransferFrom] = useState<Box | null>(null)
  const [editing, setEditing] = useState<Box | null>(null)
  const [openBox, setOpenBox] = useState<string | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
    void qc.invalidateQueries({ queryKey: ['petty-cash-tie-out'] })
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Cash</p>
            <h1 className="text-2xl font-black text-white/90">Petty cash</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Cash boxes for small spend, on the books as 1011 Petty cash. Say where every top-up came from and what every spend was for — each one is booked as it is saved. Count the boxes monthly; a difference is booked and flagged.
            </p>
          </div>
          {isKeeper && <button onClick={() => setCreating(true)} className="s-btn-primary px-4 py-2.5">+ New box</button>}
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-3">
        {isKeeper && <TieOutBanner />}
        <Link href="/finance/cash-vouchers" className="s-card-hover flex items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="font-black text-white/90">Cash requests</p>
            <p className="text-xs text-white/45 mt-0.5">Cash handed to someone against a signed, approved request is paid from a box here and booked as an advance until the receipts come in.</p>
          </div>
          <span className="text-sm font-bold text-primary-ink shrink-0">Open →</span>
        </Link>
        {keeperList.error && !notKeeper && <ErrorBanner error={keeperList.error} />}
        {boxes.length === 0 && !keeperList.isLoading && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">{isKeeper ? 'No petty cash boxes' : 'You hold no petty cash box'}</p>
            <p className="text-sm text-white/45 mt-1">{isKeeper ? 'Add a box to start tracking small spend with a paper trail.' : 'A manager or finance assigns a box to its custodian.'}</p>
          </div>
        )}
        {boxes.map((b) => {
          const siblings = boxes.filter((o) => o.id !== b.id && o.tenantId === b.tenantId)
          const expanded = openBox === b.id
          const shown = expanded ? b.movements : b.movements.slice(0, 4)
          return (
            <div key={b.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-black text-white/90 break-words">{b.name}</h3>
                    <span className="s-badge-purple">{pkr(b.floatCents)}</span>
                  </div>
                  <p className="text-xs text-white/45 mt-1">
                    Custodian: {b.custodianName ?? users.find((u) => u.id === b.custodianId)?.name ?? (b.custodianId === me?.id ? 'you' : '—')} · Top-up limit {pkr(b.topUpLimitCents)}
                  </p>
                  {shown.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {shown.map((m) => <MovementRow key={m.id} m={m} />)}
                      {b.movements.length > 4 && (
                        <button onClick={() => setOpenBox(expanded ? null : b.id)} className="text-[11px] font-bold" style={{ color: 'var(--erp-primary)' }}>
                          {expanded ? 'Show fewer' : `Show the last ${b.movements.length}`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap sm:flex-col gap-1.5 shrink-0">
                  <button onClick={() => setSpendFor(b)} className="s-btn-primary px-3 py-1.5 text-xs">Spend</button>
                  <button onClick={() => setTopUpFor(b)} className="s-btn-secondary px-3 py-1.5 text-xs">Top up</button>
                  {isKeeper && <>
                    <button onClick={() => setReturnFor(b)} disabled={b.floatCents <= 0} className="s-btn-secondary px-3 py-1.5 text-xs">Return cash</button>
                    <button onClick={() => setTransferFrom(b)} disabled={siblings.length === 0}
                      title={siblings.length === 0 ? 'No other box of this company to move cash to' : undefined}
                      className="s-btn-secondary px-3 py-1.5 text-xs">Transfer</button>
                    <button onClick={() => setReconcileFor(b)} className="s-btn-secondary px-3 py-1.5 text-xs">Count</button>
                    <button onClick={() => setEditing(b)} className="s-btn-secondary px-3 py-1.5 text-xs">Edit</button>
                  </>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {creating && <CreateBoxModal users={users} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />}
      {spendFor && <SpendModal box={spendFor} isKeeper={isKeeper} onClose={() => setSpendFor(null)} onSaved={() => { setSpendFor(null); refresh() }} />}
      {topUpFor && <TopUpModal box={topUpFor} isKeeper={isKeeper} onClose={() => setTopUpFor(null)} onSaved={() => { setTopUpFor(null); refresh() }} />}
      {returnFor && <ReturnModal box={returnFor} onClose={() => setReturnFor(null)} onSaved={() => { setReturnFor(null); refresh() }} />}
      {transferFrom && <TransferModal from={transferFrom} boxes={boxes} onClose={() => setTransferFrom(null)} onSaved={() => { setTransferFrom(null); refresh() }} />}
      {editing && <EditBoxModal box={editing} users={users} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {reconcileFor && <ReconcileModal box={reconcileFor} onClose={() => setReconcileFor(null)} onSaved={() => { setReconcileFor(null); refresh(); void qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function MovementRow({ m }: { m: Movement }) {
  const badge = LEDGER_BADGE[m.ledger] ?? LEDGER_BADGE.not_booked
  const from = sourceLabel(m)
  return (
    <div className="text-xs">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-bold" style={{ color: m.amountCents >= 0 ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
          {m.amountCents >= 0 ? '+' : ''}{pkr(m.amountCents)}
        </span>
        <span className="text-white/40">{TYPE_LABEL[m.type] ?? m.type}</span>
        <span className="text-white/60 break-words min-w-0">{m.reason}</span>
        <span className={badge.cls} title={m.ledger === 'not_booked' ? 'From before petty cash was booked — the CEO books it from Reconciliation → Backfill' : undefined}>{badge.label}</span>
      </div>
      <div className="flex gap-2 flex-wrap text-white/35 mt-0.5">
        <span>{new Date(m.createdAt).toLocaleDateString()}</span>
        {from && <span>· {from}</span>}
        {m.lines.length > 0 && <span>· {m.lines.map((l) => `${l.accountCode} ${l.description}`).join(', ')}</span>}
        {m.attachments.length > 0 && <span>· {m.attachments.length} receipt{m.attachments.length === 1 ? '' : 's'}</span>}
      </div>
    </div>
  )
}

function CreateBoxModal({ users, onClose, onSaved }: { users: User[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [custodianId, setCustodianId] = useState('')
  const [floatCents, setFloatCents] = useState(100000)
  const [topUpLimitCents, setTopUpLimitCents] = useState(2000000)
  const [src, setSrc] = useState<SourceValue>(DEFAULT_SOURCE)
  const [managerOverridePin, setManagerOverridePin] = useState('')
  const overLimit = floatCents > topUpLimitCents
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/boxes', {
      name: name.trim(), custodianId, floatCents, topUpLimitCents,
      ...(floatCents > 0 && { openingSource: src.source, ...sourceBody(src) }),
      ...(overLimit && managerOverridePin && { managerOverridePin }),
    }),
    onSuccess: () => onSaved(),
  })
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'pb-name': name.trim() ? '' : 'Give the box a name.',
    'pb-custodian': custodianId ? '' : 'Pick who keeps the box.',
    'pb-source': floatCents > 0 && !sourceReady(src) ? 'Pick the open drawer.' : '',
    'pb-pin': overLimit && !managerOverridePin ? 'A manager PIN is needed above the limit.' : '',
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  return <Modal title="New petty cash box" onClose={onClose} dirty={!save.isPending && (!!name.trim() || !!custodianId)}>
    <form onSubmit={submit} className="space-y-3" noValidate>
    <Field label="Name *" error={shown('pb-name')}><input id="pb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Head office — Jamil sb" className={fieldCls} autoFocus /></Field>
    <Field label="Custodian *" error={shown('pb-custodian')}>
      <Select id="pb-custodian" value={custodianId} onChange={(e) => setCustodianId(e.target.value)} className={fieldCls}>
        <option value="">— pick a user —</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
    </Field>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Opening float (PKR)">
        <MoneyInput value={floatCents} onChange={setFloatCents} className={fieldCls} ariaLabel="Opening float in rupees" />
      </Field>
      <Field label="Top-up limit (PKR)">
        <MoneyInput value={topUpLimitCents} onChange={setTopUpLimitCents} className={fieldCls} ariaLabel="Top-up limit in rupees" />
      </Field>
    </div>
    {floatCents > 0 && (
      <Field label="Opening float comes from *" error={shown('pb-source')}>
        {/* A new box binds to the active company; the server refuses another company's bank (422). */}
        <SourcePicker value={src} onChange={setSrc} tenantId={null} boxId={null} allowTill={false} />
      </Field>
    )}
    {overLimit && (
      <Field label="Manager PIN *" error={shown('pb-pin')}>
        <input id="pb-pin" type="password" inputMode="numeric" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Opening float above the limit" className={fieldCls} />
      </Field>
    )}
    <p className="text-[10px] text-white/30">The opening float is the box&apos;s first top-up and is booked from the source you pick. To fill a new box from a till drawer, create it empty and top it up.</p>
    {save.error && <ErrorBanner error={pinRefusal(save.error) ?? save.error} />}
    <Footer onCancel={onClose} primary={<button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Create box'}</button>} />
    </form>
  </Modal>
}

function EditBoxModal({ box, users, onClose, onSaved }: { box: Box; users: User[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(box.name)
  const [custodianId, setCustodianId] = useState(box.custodianId)
  const [topUpLimitCents, setTopUpLimitCents] = useState(box.topUpLimitCents)
  const [managerOverridePin, setManagerOverridePin] = useState('')
  const raising = topUpLimitCents > box.topUpLimitCents
  // The current custodian stays pickable even when the staff list is not readable.
  const options = users.some((u) => u.id === box.custodianId)
    ? users
    : [{ id: box.custodianId, name: box.custodianName ?? 'Current custodian' }, ...users]
  const save = useMutation({
    mutationFn: () => api.patch(`/trustops/petty-cash/boxes/${box.id}`, {
      ...(name.trim() !== box.name && { name: name.trim() }),
      ...(custodianId !== box.custodianId && { custodianId }),
      ...(topUpLimitCents !== box.topUpLimitCents && { topUpLimitCents }),
      ...(raising && managerOverridePin && { managerOverridePin }),
    }),
    onSuccess: () => onSaved(),
  })
  const unchanged = name.trim() === box.name && custodianId === box.custodianId && topUpLimitCents === box.topUpLimitCents
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'eb-name': name.trim() ? '' : 'The box needs a name.',
    'eb-pin': raising && !managerOverridePin ? 'Raising the limit needs a manager PIN.' : '',
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    if (unchanged) { onClose(); return false }
    save.mutate()
    return true
  })
  return <Modal title={`Edit ${box.name}`} onClose={onClose} dirty={!save.isPending && !unchanged}>
    <form onSubmit={submit} className="space-y-3" noValidate>
    <Field label="Name *" error={shown('eb-name')}><input id="eb-name" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
    <Field label="Custodian *">
      <Select id="eb-custodian" value={custodianId} onChange={(e) => setCustodianId(e.target.value)} className={fieldCls}>
        {options.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
    </Field>
    <Field label="Top-up limit (PKR)">
      <MoneyInput value={topUpLimitCents} onChange={setTopUpLimitCents} className={fieldCls} ariaLabel="Top-up limit in rupees" />
      <p className="text-[10px] text-white/30 mt-1">Now {pkr(box.topUpLimitCents)}. A top-up above the limit needs a manager PIN.</p>
    </Field>
    {raising && (
      <Field label="Manager PIN *" error={shown('eb-pin')}>
        <input id="eb-pin" type="password" inputMode="numeric" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Raising the limit needs a manager" className={fieldCls} />
      </Field>
    )}
    {save.error && <ErrorBanner error={pinRefusal(save.error) ?? save.error} />}
    <Footer onCancel={onClose} primary={<button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Save'}</button>} />
    </form>
  </Modal>
}

function TransferModal({ from, boxes, onClose, onSaved }: { from: Box; boxes: Box[]; onClose: () => void; onSaved: () => void }) {
  // Only boxes of the same company: cash never moves between companies here.
  const targets = boxes.filter((b) => b.id !== from.id && b.tenantId === from.tenantId)
  const [toBoxId, setToBoxId] = useState(targets[0]?.id ?? '')
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/transfers', { fromBoxId: from.id, toBoxId, amountCents, reason: reason.trim() }),
    onSuccess: () => onSaved(),
  })
  const over = amountCents > from.floatCents
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'tr-to': toBoxId ? '' : 'There is no other box in this company to move cash to.',
    'tr-amount': amountCents <= 0 ? 'Enter an amount above zero.' : over ? `More than the ${pkr(from.floatCents)} in ${from.name}.` : '',
    'tr-reason': reason.trim() ? '' : 'Say why the cash is moving.',
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  return <Modal title={`Move cash from ${from.name}`} onClose={onClose} dirty={!save.isPending && (amountCents > 0 || !!reason.trim())}>
    <form onSubmit={submit} className="space-y-3" noValidate>
    <Field label="To box *" error={shown('tr-to')}>
      <Select id="tr-to" value={toBoxId} onChange={(e) => setToBoxId(e.target.value)} className={fieldCls}>
        {targets.map((b) => <option key={b.id} value={b.id}>{b.name} · {pkr(b.floatCents)}</option>)}
      </Select>
    </Field>
    <Field label="Amount (PKR) *" error={shown('tr-amount')}>
      <MoneyInput id="tr-amount" value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] mt-1" style={{ color: over ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
        {over ? `More than the ${pkr(from.floatCents)} in ${from.name}` : `In ${from.name} now: ${pkr(from.floatCents)}`}
      </p>
    </Field>
    <Field label="Reason *" error={shown('tr-reason')}>
      <input id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={160} placeholder="Weekend float for the kitchen box" className={fieldCls} />
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Moving…' : 'Move cash'}</button>} />
    </form>
  </Modal>
}

function ReconcileModal({ box, onClose, onSaved }: { box: Box; onClose: () => void; onSaved: () => void }) {
  const [counted, setCounted] = useState(box.floatCents)
  const [notes, setNotes] = useState('')
  const variance = counted - box.floatCents
  const save = useMutation({
    mutationFn: () => api.post(`/trustops/petty-cash/boxes/${box.id}/reconcile`, { countedCents: counted, notes: notes || undefined }),
    onSuccess: () => onSaved(),
  })
  const tone = Math.abs(variance) >= 20000 ? 'var(--erp-warning)' : 'var(--erp-success)'

  const submit = useSubmitOnce(save.isPending)(() => { save.mutate(); return true })
  return <Modal title={`Reconcile ${box.name}`} onClose={onClose} dirty={!save.isPending && (counted !== box.floatCents || !!notes.trim())}>
    <form onSubmit={submit} className="space-y-3">
    <div className="rounded-lg p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-xs text-white/55">System float</p>
      <p className="text-2xl font-black text-white/90">{pkr(box.floatCents)}</p>
    </div>
    <Field label="Physical count (PKR) *">
      <MoneyInput id="rc-counted" value={counted} onChange={setCounted} className={fieldCls} autoFocus ariaLabel="Counted cash in rupees" />
    </Field>
    {Math.abs(variance) > 0 && (
      <div className="rounded-lg p-3 text-sm font-bold" style={{ background: `color-mix(in srgb, ${tone} 10%, transparent)`, color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}>
        Variance: {variance > 0 ? '+' : ''}{pkr(variance)}
        {Math.abs(variance) >= 20000 && ' — will flag'}
      </div>
    )}
    <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything noteworthy" className={fieldCls} /></Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={<button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Save count'}</button>} />
    </form>
  </Modal>
}
