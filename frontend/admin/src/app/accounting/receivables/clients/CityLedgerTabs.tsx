'use client'
// City Ledger account tabs: Outstanding bills (+ record a settlement),
// Settlements (+ receipt, reverse) and Transaction history.
//
// API: /accounting/customer-accounts/:id/{bills,settlements,history} and
// /accounting/customer-accounts/settlements/:sid/{reverse,receipt}. UI only:
// every rule is the server's; its error codes are shown in words.

import { Button, Dialog, Field, Input, SidePanel, Textarea } from '@/components/finance/ui'
import { useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../../lib/api'
import { fmtPkrWhole } from '../../../../lib/money'
import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'
import {
  PaymentReceivedFields, RupeeField, receiptFieldsValid, receiptMethodLabel, rupeesToPaisa, paisaToRupees,
  PAYMENT_REFERENCE_ERROR_TEXT,
} from '../../../../components/finance/PaymentReceivedFields'

type BillStatus = 'open' | 'partial' | 'settled' | 'overdue' | 'refunded' | 'on_statement'
interface OpenBill {
  chargeId: string; orderId: string; orderRef: string; conceptId: string | null; brand: string | null
  chargedAt: string; dueDate: string | null; reference: string | null
  amountCents: number; taxCents: number; refundedCents: number; settledCents: number; owedCents: number
  status: BillStatus; booked: boolean; statementNumber: string | null
}
interface SettlementRow {
  id: string; number: string; amountCents: number; method: string; methodLabel: string; reference: string | null
  receivedAt: string; channel: 'till' | 'back_office'; moneyAccountCode: string | null; note: string | null
  createdByName: string | null; reversedAt: string | null; reversedReason: string | null; voucher: string | null
  allocations: Array<{ chargeId: string; amountCents: number; orderRef: string }>
}
type HistoryType = 'bill' | 'refund' | 'settlement' | 'settlement_reversed' | 'statement_payment' | 'statement_payment_reversed' | 'write_off'
interface HistoryRow {
  at: string; type: HistoryType; reference: string | null; orderRef: string | null
  debitCents: number; creditCents: number; balanceCents: number; voucher: string | null; status: string | null; createdBy: string | null
}

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 's-input w-full'
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong — try again')

const ERROR_WORDS: Record<string, string> = {
  OVER_ALLOCATED: 'An amount is more than the bill still owes. Refresh and check the amounts.',
  BILL_ALREADY_SETTLED: 'One of the bills is already settled. Refresh the list.',
  BILL_NOT_BOOKED: 'One of the bills is not in the books yet (its drawer is still open).',
  BILL_ON_STATEMENT: 'One of the bills is on a statement — pay it on the statement (Receivables).',
  BANK_ACCOUNT_REQUIRED: 'Choose the bank account the money was received into.',
  ALREADY_REVERSED: 'This settlement is already reversed.',
  SETTLED_BILL_ON_STATEMENT: 'A bill it paid has since gone onto a statement, so it cannot be reversed here.',
  DRAWER_CLOSED_USE_JOURNAL: 'The till drawer is closed — correct this with a journal entry.',
  ...PAYMENT_REFERENCE_ERROR_TEXT,
}
const apiError = (e: unknown) => (e instanceof ApiError && ERROR_WORDS[e.code]) || errText(e)

const STATUS_CHIP: Record<BillStatus, { label: string; color: string }> = {
  open: { label: 'Open', color: 'var(--erp-primary)' },
  partial: { label: 'Partially settled', color: 'var(--erp-warning)' },
  overdue: { label: 'Overdue', color: 'var(--erp-danger)' },
  settled: { label: 'Settled', color: 'var(--erp-success)' },
  refunded: { label: 'Refunded', color: 'rgb(var(--fg-rgb) / 0.5)' },
  on_statement: { label: 'On a statement', color: 'rgb(var(--fg-rgb) / 0.5)' },
}
const HISTORY_WORDS: Record<HistoryType, string> = {
  bill: 'Bill charged', refund: 'Refund', settlement: 'Settlement received', settlement_reversed: 'Settlement reversed',
  statement_payment: 'Statement payment', statement_payment_reversed: 'Statement payment reversed', write_off: 'Write-off',
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-black whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>{label}</span>
  )
}
const Th = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <th className={`py-2 pr-3 text-xs uppercase tracking-wider font-bold text-white/40 ${right ? 'text-right' : 'text-left'}`}>{children}</th>
)
const Td = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <td className={`py-2 pr-3 text-sm text-white/85 ${right ? 'text-right' : ''}`}>{children}</td>
)
const Err = ({ msg }: { msg: string | null }) =>
  msg ? <p role="alert" className="mt-3 text-sm font-bold" style={{ color: 'var(--erp-danger)' }}>{msg}</p> : null
const smallBtn = 'rounded-lg px-3 py-1.5 text-xs font-black border border-white/15 hover:bg-white/5'
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const todayPkt = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)

async function openReceiptHtml(settlementId: string): Promise<void> {
  const blob = await api.fetchBlob(`/accounting/customer-accounts/settlements/${settlementId}/receipt`)
  const url = URL.createObjectURL(new Blob([await blob.text()], { type: 'text/html' }))
  if (!window.open(url, '_blank')) URL.revokeObjectURL(url)
}

export function CityLedgerTabs({ accountId, tenantId, canRecord, onChanged }: {
  accountId: string; tenantId: string; canRecord: boolean; onChanged: () => void
}) {
  const [tab, setTab] = useState<'bills' | 'settlements' | 'history'>('bills')
  const tabs = [['bills', 'Outstanding bills'], ['settlements', 'Settlements'], ['history', 'Transaction history']] as const
  return (
    <section>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/[0.08] mb-4">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className="px-4 py-2 text-sm font-black -mb-px"
            style={{
              color: tab === k ? 'rgb(var(--fg-rgb) / 0.95)' : 'rgb(var(--fg-rgb) / 0.5)',
              borderBottom: `2px solid ${tab === k ? 'var(--erp-success)' : 'transparent'}`,
            }}>{l}</button>
        ))}
      </div>
      {tab === 'bills' && <BillsTab accountId={accountId} tenantId={tenantId} canRecord={canRecord} onChanged={onChanged} />}
      {tab === 'settlements' && <SettlementsTab accountId={accountId} onChanged={onChanged} />}
      {tab === 'history' && <HistoryTab accountId={accountId} />}
    </section>
  )
}

// ─── Outstanding bills ───────────────────────────────────────────────────────

function BillsTab({ accountId, tenantId, canRecord, onChanged }: { accountId: string; tenantId: string; canRecord: boolean; onChanged: () => void }) {
  const qc = useQueryClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [picked, setPicked] = useState<Record<string, string>>({}) // chargeId → rupees typed
  const [panel, setPanel] = useState(false)
  // A bill refunded after it was paid owes BACK (owedCents < 0): finance pays it back (direction 'out').
  const [payBack, setPayBack] = useState<OpenBill | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const base = `/accounting/customer-accounts/${accountId}`
  const qs = new URLSearchParams({ open: '1' })
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const q = useQuery<{ items: OpenBill[]; owedCents: number }>({
    queryKey: ['oa-bills', accountId, qs.toString()],
    queryFn: () => api.get(`${base}/bills?${qs.toString()}`),
  })
  const all = q.data?.items ?? []
  const items = all.filter((b) => b.owedCents > 0)
  const owedBack = all.filter((b) => b.owedCents < 0)
  const payable = (b: OpenBill) => b.booked && b.owedCents > 0 && b.status !== 'on_statement' && b.status !== 'settled' && b.status !== 'refunded'
  const amountOf = (b: OpenBill) => rupeesToPaisa(picked[b.chargeId] ?? '')
  const amountBad = (b: OpenBill) => { const a = amountOf(b); return a <= 0 || a > b.owedCents }
  const chosen = items.filter((b) => b.chargeId in picked && payable(b))
  const totalCents = chosen.reduce((n, b) => n + amountOf(b), 0)
  const anyBad = chosen.some(amountBad)
  const toggle = (b: OpenBill) => setPicked((p) => {
    const n = { ...p }
    if (b.chargeId in n) delete n[b.chargeId]; else n[b.chargeId] = paisaToRupees(b.owedCents)
    return n
  })
  const selectable = items.filter(payable)
  const allOn = selectable.length > 0 && selectable.every((b) => b.chargeId in picked)

  return (
    <div className="space-y-3">
      {notice && <p role="status" className="text-sm font-bold text-success">{notice}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" className="s-input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" className="s-input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-white/60">Owed <b className="text-white/90">{fmtPkrWhole(q.data?.owedCents ?? 0)}</b></span>
          {canRecord && (
            <Button type="button" disabled={chosen.length === 0 || anyBad} onClick={() => setPanel(true)}>
              Record settlement{chosen.length ? ` (${fmtPkrWhole(totalCents)})` : ''}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-s-muted">Bills already on a statement are paid on the statement (Receivables).</p>

      {q.isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {q.isError && <Err msg={errText(q.error)} />}
      {!q.isLoading && !q.isError && items.length === 0 && <CompactEmptyState message="No outstanding bills." />}
      {items.length > 0 && (
        <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                <Th>
                  <input type="checkbox" aria-label="Select all payable bills" checked={allOn} disabled={!canRecord || selectable.length === 0}
                    onChange={() => setPicked(allOn ? {} : Object.fromEntries(selectable.map((b) => [b.chargeId, paisaToRupees(b.owedCents)])))} />
                </Th>
                <Th>Bill</Th><Th>Date</Th><Th>Due</Th><Th>Brand</Th><Th>Reference</Th><Th>Status</Th>
                <Th right>Amount</Th><Th right>Settled</Th><Th right>Owed</Th><Th right>Pay now</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const ok = payable(b) && canRecord
                const on = b.chargeId in picked
                const chip = !b.booked ? { label: 'Not in the books yet', color: 'var(--erp-warning)' } : STATUS_CHIP[b.status]
                return (
                  <tr key={b.chargeId} className="border-t border-white/[0.05]" style={{ opacity: ok || !payable(b) ? 1 : 0.7 }}>
                    <Td><input type="checkbox" aria-label={`Select bill ${b.orderRef}`} checked={on} disabled={!ok} onChange={() => toggle(b)} /></Td>
                    <Td><span className="font-mono">{b.orderRef}</span></Td>
                    <Td>{day(b.chargedAt)}</Td><Td>{day(b.dueDate)}</Td><Td>{b.brand ?? '—'}</Td><Td>{b.reference ?? '—'}</Td>
                    <Td>
                      <Chip label={chip.label} color={chip.color} />
                      {b.status === 'on_statement' && b.statementNumber && <span className="ml-2 text-xs text-s-muted">{b.statementNumber}</span>}
                    </Td>
                    <Td right>{fmtPkrWhole(b.amountCents)}</Td>
                    <Td right>{b.settledCents ? fmtPkrWhole(b.settledCents) : '—'}</Td>
                    <Td right>{fmtPkrWhole(b.owedCents)}</Td>
                    <Td right>
                      {on ? (
                        <div className="w-32 ml-auto">
                          <RupeeField className="s-input w-full text-right" label={`Pay now for ${b.orderRef}`} value={picked[b.chargeId] ?? ''}
                            invalid={amountBad(b)} onChange={(v) => setPicked((p) => ({ ...p, [b.chargeId]: v }))} />
                          {amountBad(b) && <span className="block text-xs mt-1" style={{ color: 'var(--erp-danger)' }}>1 to {fmtPkrWhole(b.owedCents)}</span>}
                        </div>
                      ) : '—'}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {owedBack.length > 0 && (
        <div className="rounded-2xl p-4 space-y-2" style={card}>
          <p className="text-sm font-bold">Owed back to the client</p>
          <p className="text-xs text-s-muted">These bills were refunded after they were paid — the client is owed the money back.</p>
          {owedBack.map((b) => (
            <div key={b.chargeId} className="flex items-center justify-between gap-3 text-sm">
              <span><span className="font-mono">{b.orderRef}</span> · {day(b.chargedAt)} · owed back <b>{fmtPkrWhole(-b.owedCents)}</b></span>
              {canRecord && <Button type="button" variant="ghost" onClick={() => setPayBack(b)}>Pay back</Button>}
            </div>
          ))}
        </div>
      )}
      {payBack && (
        <SettlePanel
          accountId={accountId} tenantId={tenantId} direction="out" bills={[{ bill: payBack, cents: -payBack.owedCents }]} totalCents={-payBack.owedCents}
          onClose={() => setPayBack(null)}
          onDone={(n) => {
            setPayBack(null); setNotice(`Pay-back ${n} recorded.`)
            void qc.invalidateQueries({ queryKey: ['oa-bills', accountId] })
            void qc.invalidateQueries({ queryKey: ['oa-settlements', accountId] })
            void qc.invalidateQueries({ queryKey: ['oa-history', accountId] })
            onChanged()
          }}
        />
      )}
      {panel && (
        <SettlePanel
          accountId={accountId} tenantId={tenantId} bills={chosen.map((b) => ({ bill: b, cents: amountOf(b) }))} totalCents={totalCents}
          onClose={() => setPanel(false)}
          onDone={(n) => {
            setPanel(false); setPicked({}); setNotice(`Settlement ${n} recorded.`)
            void qc.invalidateQueries({ queryKey: ['oa-bills', accountId] })
            void qc.invalidateQueries({ queryKey: ['oa-settlements', accountId] })
            void qc.invalidateQueries({ queryKey: ['oa-history', accountId] })
            onChanged()
          }}
        />
      )}
    </div>
  )
}

function SettlePanel({ accountId, tenantId, bills, totalCents, onClose, onDone, direction = 'in' }: {
  accountId: string; tenantId: string; bills: Array<{ bill: OpenBill; cents: number }>; totalCents: number; direction?: 'in' | 'out'
  onClose: () => void; onDone: (number: string) => void
}) {
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [bankId, setBankId] = useState('')
  const [receivedAt, setReceivedAt] = useState(todayPkt())
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const keyRef = useRef<string>(crypto.randomUUID())
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(receivedAt) && receivedAt <= todayPkt()
  const valid = receiptFieldsValid({ method, reference }) && dateOk && bills.length > 0
  const post = useMutation({
    mutationFn: () => api.post<{ settlement: { number: string }; replayed: boolean }>(`/accounting/customer-accounts/${accountId}/settlements`, {
      allocations: bills.map((x) => ({ chargeId: x.bill.chargeId, amountCents: x.cents })),
      method, reference: reference.trim(), ...(bankId ? { bankAccountId: bankId } : {}),
      receivedAt, ...(note.trim() ? { note: note.trim() } : {}), idempotencyKey: keyRef.current, direction,
    }),
    onSuccess: (r) => onDone(r.settlement.number),
    onError: (e) => {
      setErr(apiError(e)); setConfirm(false)
      // A refused attempt is a new attempt next time; a network failure keeps the key so a retry cannot double-post.
      if (e instanceof ApiError) keyRef.current = crypto.randomUUID()
    },
  })
  return (
    <SidePanel title={direction === 'out' ? 'Pay back to the client' : 'Record settlement'} subtitle={`${bills.length} bill${bills.length === 1 ? '' : 's'} · ${fmtPkrWhole(totalCents)}`} onClose={onClose} wide>
      <div className="p-5 space-y-4">
        {!confirm ? (
          <>
            <ul className="text-sm space-y-1">
              {bills.map(({ bill, cents }) => (
                <li key={bill.chargeId} className="flex justify-between gap-3 text-white/80">
                  <span className="font-mono">{bill.orderRef}</span><span>{fmtPkrWhole(cents)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 font-black text-white/95 border-t border-white/10 pt-1"><span>Total</span><span>{fmtPkrWhole(totalCents)}</span></li>
            </ul>
            <PaymentReceivedFields tenantId={tenantId} method={method} onMethod={setMethod} reference={reference} onReference={setReference}
              bankAccountId={bankId} onBank={setBankId} idPrefix="cl-settle" />
            <Field label="Received on" error={!dateOk ? 'Pick a date that is not in the future.' : undefined}>
              <Input type="date" className={inp} max={todayPkt()} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </Field>
            <Field label="Note (optional)"><Textarea className={inp} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Err msg={err} />
            <div className="flex gap-2">
              <Button type="button" disabled={!valid} onClick={() => { setErr(null); setConfirm(true) }}>Review</Button>
              <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-white/80">
              {direction === 'out' ? 'Pay back' : 'Record'} <b>{fmtPkrWhole(totalCents)}</b> {direction === 'out' ? 'paid' : 'received'} by {receiptMethodLabel(method).toLowerCase()} (ref. {reference.trim()}) on {receivedAt}
              {' '}against {bills.length} bill{bills.length === 1 ? '' : 's'}? This posts to the books.
            </p>
            <Err msg={err} />
            <div className="flex gap-2">
              <Button type="button" disabled={post.isPending} onClick={() => { setErr(null); post.mutate() }}>
                {post.isPending ? 'Posting…' : 'Confirm and post'}
              </Button>
              <Button variant="ghost" type="button" disabled={post.isPending} onClick={() => setConfirm(false)}>Back</Button>
            </div>
          </>
        )}
      </div>
    </SidePanel>
  )
}

// ─── Settlements ─────────────────────────────────────────────────────────────

function SettlementsTab({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const qc = useQueryClient()
  const [reversing, setReversing] = useState<SettlementRow | null>(null)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const q = useQuery<{ items: SettlementRow[] }>({
    queryKey: ['oa-settlements', accountId],
    queryFn: () => api.get(`/accounting/customer-accounts/${accountId}/settlements`),
  })
  const reverse = useMutation({
    mutationFn: (s: SettlementRow) => api.post(`/accounting/customer-accounts/settlements/${s.id}/reverse`, { reason: reason.trim() }),
    onSuccess: () => {
      setReversing(null); setReason(''); setNotice('Settlement reversed.')
      void qc.invalidateQueries({ queryKey: ['oa-settlements', accountId] })
      void qc.invalidateQueries({ queryKey: ['oa-bills', accountId] })
      void qc.invalidateQueries({ queryKey: ['oa-history', accountId] })
      onChanged()
    },
    onError: (e) => setErr(apiError(e)),
  })
  const items = q.data?.items ?? []
  return (
    <div className="space-y-3">
      {notice && <p role="status" className="text-sm font-bold text-success">{notice}</p>}
      {q.isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {q.isError && <Err msg={errText(q.error)} />}
      {!q.isLoading && !q.isError && items.length === 0 && <CompactEmptyState message="No settlements yet." />}
      {items.length > 0 && (
        <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
          <table className="w-full min-w-[860px]">
            <thead><tr><Th>Number</Th><Th>Received</Th><Th>Method</Th><Th>Reference</Th><Th>Channel</Th><Th>Bills</Th><Th right>Amount</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-white/[0.05]" style={{ opacity: s.reversedAt ? 0.65 : 1 }}>
                  <Td><span className="font-mono">{s.number}</span></Td>
                  <Td>{day(s.receivedAt)}</Td><Td>{s.methodLabel || receiptMethodLabel(s.method)}</Td><Td>{s.reference ?? '—'}</Td>
                  <Td>{s.channel === 'till' ? 'Till' : 'Back office'}</Td>
                  <Td><span className="font-mono text-xs">{s.allocations.map((a) => a.orderRef).join(', ') || '—'}</span></Td>
                  <Td right>{fmtPkrWhole(s.amountCents)}</Td>
                  <Td>{s.reversedAt ? <span title={s.reversedReason ?? undefined}><Chip label="Reversed" color="var(--erp-danger)" /></span> : <Chip label="Posted" color="var(--erp-success)" />}</Td>
                  <Td>
                    <span className="flex gap-2">
                      <button className={smallBtn} onClick={() => { openReceiptHtml(s.id).catch((e) => setNotice(errText(e))) }}>Print receipt</button>
                      {!s.reversedAt && <button className={smallBtn} style={{ color: 'var(--erp-danger)' }} onClick={() => { setErr(null); setReason(''); setReversing(s) }}>Reverse</button>}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reversing && (
        <Dialog title={`Reverse ${reversing.number}`} onClose={() => setReversing(null)}>
          <p className="text-sm text-white/70 mb-3">Puts {fmtPkrWhole(reversing.amountCents)} back on the bills it paid. The original entry stays on the books with its reversal.</p>
          <Field label="Why (at least 10 characters)"><Textarea className={inp} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Err msg={err} />
          <div className="flex gap-2 mt-5">
            <Button type="button" disabled={reverse.isPending || reason.trim().length < 10} onClick={() => { setErr(null); reverse.mutate(reversing) }}>
              {reverse.isPending ? 'Reversing…' : 'Reverse settlement'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setReversing(null)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ─── Transaction history ─────────────────────────────────────────────────────

function HistoryTab({ accountId }: { accountId: string }) {
  const q = useQuery<{ items: HistoryRow[]; balanceCents: number }>({
    queryKey: ['oa-history', accountId],
    queryFn: () => api.get(`/accounting/customer-accounts/${accountId}/history`),
  })
  const items = q.data?.items ?? []
  const sums = useMemo(() => items.reduce((a, r) => ({ d: a.d + r.debitCents, c: a.c + r.creditCents }), { d: 0, c: 0 }), [items])
  return (
    <div className="space-y-3">
      {q.isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {q.isError && <Err msg={errText(q.error)} />}
      {!q.isLoading && !q.isError && items.length === 0 && <CompactEmptyState message="No transactions yet." />}
      {items.length > 0 && (
        <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
          <table className="w-full min-w-[920px]">
            <thead><tr><Th>Date</Th><Th>Type</Th><Th>Reference</Th><Th>Bill no.</Th><Th right>Debit</Th><Th right>Credit</Th><Th right>Balance</Th><Th>Voucher</Th><Th>By</Th><Th>Status</Th></tr></thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={`${r.at}-${i}`} className="border-t border-white/[0.05]">
                  <Td>{day(r.at)}</Td><Td>{HISTORY_WORDS[r.type] ?? r.type}</Td><Td>{r.reference ?? '—'}</Td>
                  <Td><span className="font-mono">{r.orderRef ?? '—'}</span></Td>
                  <Td right>{r.debitCents ? fmtPkrWhole(r.debitCents) : '—'}</Td>
                  <Td right>{r.creditCents ? fmtPkrWhole(r.creditCents) : '—'}</Td>
                  <Td right>{fmtPkrWhole(r.balanceCents)}</Td>
                  <Td><span className="font-mono text-xs">{r.voucher ?? '—'}</span></Td>
                  <Td>{r.createdBy ?? '—'}</Td><Td>{r.status ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-white/15 font-black text-white/95">
                <Td>Balance</Td><Td /><Td /><Td />
                <Td right>{fmtPkrWhole(sums.d)}</Td><Td right>{fmtPkrWhole(sums.c)}</Td>
                <Td right>{fmtPkrWhole(q.data?.balanceCents ?? 0)}</Td><Td /><Td /><Td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
