'use client'
// City Ledger settlement (on-account clients): the cashier takes cash / bank
// transfer against a client's outstanding till bills (those not yet on a
// statement). One settlement = one POST /pos/city-ledger/settlements with an
// idempotency key made once per confirmation attempt and reused on a retry.
// Card and Raast are never taken here; statement bills are paid in Receivables.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Landmark, Menu, Printer, RefreshCw, Search } from 'lucide-react'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { usePosStore } from '../../../store/pos'
import { fetchPrintableHtml, printHtml } from '../tillApi'
import { flowErrorMessage } from './flowApi'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'
import { CompactEmptyState } from '../../ui/CompactEmptyState'

interface Account {
  id: string; number: string; legalName: string; tradeName: string | null; accountType: string; accountTypeLabel: string
  creditLimitCents: number; owedCents: number; availableCents: number; creditCents: number
  overdue: { number: string; dueDate: string; balanceCents: number } | null
}
interface Bill {
  chargeId: string; orderId: string; orderRef: string; conceptId: string; brand: string; chargedAt: string
  dueDate: string | null; reference: string | null; amountCents: number; taxCents: number; refundedCents: number
  settledCents: number; owedCents: number; status: string; booked: boolean; statementNumber: string | null
}
interface SettlementResult { settlement: { id: string; number: string; amountCents: number }; replayed: boolean; owedCents: number }
type Method = 'cash' | 'bank_transfer'
type StatusFilter = 'all' | 'open' | 'partial' | 'overdue'

const STATUS_LABEL: Record<string, string> = { open: 'Open', partial: 'Partially settled', overdue: 'Overdue' }
const STATUS_FILTERS: Array<[StatusFilter, string]> = [['all', 'All'], ['open', 'Open'], ['partial', 'Partially settled'], ['overdue', 'Overdue']]
const karachiDay = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)
const accountName = (a: Account) => a.tradeName || a.legalName

function statusChip(s: string) {
  const cls = s === 'overdue' ? 'bg-kds-red/20 text-kds-red' : s === 'partial' ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-green/20 text-kds-green'
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${cls}`}>{STATUS_LABEL[s] ?? s}</span>
}

/** "1234.5" → paisa, or null when it is not a positive amount with at most 2 decimals. */
function parseCents(text: string): number | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const [r, p = ''] = t.split('.')
  const c = Number(r) * 100 + Number(p.padEnd(2, '0'))
  return Number.isSafeInteger(c) && c > 0 ? c : null
}
const centsText = (c: number) => (c / 100).toFixed(2)

export function CityLedgerSettle({ onMenu }: { onMenu: () => void }) {
  const qc = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const shiftId = usePosStore((s) => s.shiftId)
  const [q, setQ] = useState('')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [dueBefore, setDueBefore] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [method, setMethod] = useState<Method>('cash')
  const [reference, setReference] = useState('')
  // Bank transfer: the cashier saw the credit on the counter device (bank app / SMS) — the server requires it.
  const [transferSeen, setTransferSeen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<SettlementResult | null>(null)
  const [printErr, setPrintErr] = useState<string | null>(null)
  // One key per confirmation attempt; kept after a failure so a retry replays, dropped on success or when the allocation changes.
  const attempt = useRef<{ sig: string; key: string } | null>(null)

  const accounts = useQuery({
    queryKey: ['pos', 'city-ledger', 'accounts', q.trim()],
    queryFn: () => api.get<{ items: Account[] }>(`/pos/city-ledger/accounts?q=${encodeURIComponent(q.trim())}`),
  })
  const account = accounts.data?.items.find((a) => a.id === accountId) ?? null
  const billsQ = useQuery({
    queryKey: ['pos', 'city-ledger', 'bills', accountId],
    queryFn: () => api.get<{ items: Bill[]; owedCents: number }>(`/pos/city-ledger/accounts/${encodeURIComponent(accountId!)}/bills`),
    enabled: !!accountId,
  })

  useEffect(() => { setTicked({}); setAmounts({}); setError(null); setReference(''); attempt.current = null }, [accountId])

  const bills = useMemo(() => (billsQ.data?.items ?? []).filter((b) => {
    const day = karachiDay(b.chargedAt)
    if (from && day < from) return false
    if (to && day > to) return false
    if (dueBefore && !(b.dueDate && b.dueDate < dueBefore)) return false
    if (status !== 'all' && b.status !== status) return false
    return true
  }), [billsQ.data, from, to, dueBefore, status])

  const amountOf = (b: Bill) => amounts[b.chargeId] ?? centsText(b.owedCents)
  const rows = useMemo(() => (billsQ.data?.items ?? []).filter((b) => ticked[b.chargeId] && b.booked).map((b) => {
    const text = amounts[b.chargeId] ?? centsText(b.owedCents)
    const cents = parseCents(text)
    const err = cents == null ? 'Enter an amount above 0' : cents > b.owedCents ? `At most ${fmtPkr(b.owedCents)}` : null
    return { bill: b, cents, err }
  }), [billsQ.data, ticked, amounts])
  const total = rows.reduce((s, r) => s + (r.cents && !r.err ? r.cents : 0), 0)
  const anyInvalid = rows.some((r) => r.err)
  const needRef = method === 'bank_transfer' && (reference.trim() === '' || !transferSeen)
  const canConfirm = !!shiftId && !!account && rows.length > 0 && !anyInvalid && total > 0 && !needRef && !posting

  const visibleSettleable = bills.filter((b) => b.booked)
  const allTicked = visibleSettleable.length > 0 && visibleSettleable.every((b) => ticked[b.chargeId])
  function toggleAll() {
    setTicked((t) => { const n = { ...t }; for (const b of visibleSettleable) n[b.chargeId] = !allTicked; return n })
  }

  async function submit() {
    if (!canConfirm || !account || !shiftId) return
    const allocations = rows.map((r) => ({ chargeId: r.bill.chargeId, amountCents: r.cents! }))
    const sig = JSON.stringify([account.id, shiftId, method, method === 'bank_transfer' ? reference.trim() : '', allocations])
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: `cls-${crypto.randomUUID()}` }
    setPosting(true); setError(null)
    try {
      const res = await api.post<SettlementResult>('/pos/city-ledger/settlements', {
        accountId: account.id, shiftId, method,
        ...(method === 'bank_transfer' && { reference: reference.trim(), transferVerified: transferSeen }),
        allocations, idempotencyKey: attempt.current.key,
      })
      attempt.current = null
      setDone(res); setConfirming(false); setTicked({}); setAmounts({}); setReference('')
      void qc.invalidateQueries({ queryKey: ['pos', 'city-ledger'] })
    } catch (e) {
      setError(flowErrorMessage(e, 'Could not record the settlement — check the connection and try again'))
    } finally { setPosting(false) }
  }

  async function print(id: string) {
    setPrintErr(null)
    try { await printHtml(() => fetchPrintableHtml(`/pos/city-ledger/settlements/${encodeURIComponent(id)}/receipt`, token)) }
    catch (e) { setPrintErr(flowErrorMessage(e, 'Could not print the receipt')) }
  }

  const refresh = () => { void accounts.refetch(); if (accountId) void billsQ.refetch() }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">City Ledger</h1>
        <button type="button" onClick={refresh} aria-label="Refresh" className="ml-auto flex h-11 w-11 items-center justify-center rounded-lg text-kds-subtext hover:text-kds-text"><RefreshCw size={18} aria-hidden="true" className={accounts.isFetching || billsQ.isFetching ? 'animate-spin' : ''} /></button>
      </div>
      {!shiftId && <p role="alert" className="border-b border-kds-border px-3 py-2 text-sm font-semibold text-kds-amber">Open your drawer first. Settling is disabled until a drawer is open.</p>}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Accounts */}
        <aside className="flex max-h-[40dvh] w-full shrink-0 flex-col border-b border-kds-border md:max-h-none md:w-80 md:border-b-0 md:border-r">
          <div className="p-3">
            <label className="relative block">
              <span className="sr-only">Search accounts</span>
              <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kds-subtext" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts" className={`${inputCls} pl-9`} />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {accounts.isLoading && <p className="p-2 text-sm text-kds-subtext">Loading accounts…</p>}
            {accounts.isError && <p role="alert" className="p-2 text-sm font-semibold text-kds-red">{flowErrorMessage(accounts.error)}</p>}
            {accounts.data && accounts.data.items.length === 0 && <CompactEmptyState tone="dark" icon={<Landmark size={20} />} message="No accounts found" />}
            <ul className="space-y-1">
              {accounts.data?.items.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => { setAccountId(a.id); setDone(null) }} aria-pressed={a.id === accountId}
                    className={`w-full rounded-lg border px-3 py-2 text-left ${a.id === accountId ? 'border-kds-green bg-kds-green/10' : 'border-transparent hover:bg-kds-border/40'}`}>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-kds-text">{a.number} · {accountName(a)}</span>
                      {a.overdue && <span className="shrink-0 rounded-full bg-kds-red/20 px-2 py-0.5 text-xs font-bold text-kds-red">Overdue</span>}
                    </span>
                    <span className="block text-xs text-kds-subtext">{a.accountTypeLabel}</span>
                    <span className="mt-1 flex justify-between text-xs text-kds-text"><span>Owed {fmtPkr(a.owedCents)}</span><span className="text-kds-subtext">Available {fmtPkr(a.availableCents)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Bills */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!account ? (
            <div className="p-4"><CompactEmptyState tone="dark" icon={<Landmark size={20} />} message="Pick an account to see its outstanding bills" /></div>
          ) : (
            <>
              <div className="border-b border-kds-border px-3 py-2">
                <p className="text-base font-bold text-kds-text">{account.number} · {accountName(account)}</p>
                <p className="text-xs text-kds-subtext">Owed {fmtPkr(account.owedCents)} · Credit limit {fmtPkr(account.creditLimitCents)} · Available {fmtPkr(account.availableCents)}{account.creditCents > 0 ? ` · In credit ${fmtPkr(account.creditCents)}` : ''}</p>
              </div>
              {done && (
                <div role="status" className="m-3 rounded-lg border border-kds-green bg-kds-green/10 p-3">
                  <p className="font-bold text-kds-green">Settlement {done.settlement.number} recorded{done.replayed ? ' (already recorded)' : ''}</p>
                  <p className="text-sm text-kds-text">Received {fmtPkr(done.settlement.amountCents)}. New balance owed: {fmtPkr(done.owedCents)}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" onClick={() => void print(done.settlement.id)} className={`${ghostBtn} flex items-center gap-2`}><Printer size={16} aria-hidden="true" />Print receipt</button>
                    <ErrorLine text={printErr} />
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2 border-b border-kds-border p-3">
                <div><label htmlFor="cl-from" className={labelCls}>Billed from</label><input id="cl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} w-40`} /></div>
                <div><label htmlFor="cl-to" className={labelCls}>Billed to</label><input id="cl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} w-40`} /></div>
                <div><label htmlFor="cl-due" className={labelCls}>Due before</label><input id="cl-due" type="date" value={dueBefore} onChange={(e) => setDueBefore(e.target.value)} className={`${inputCls} w-40`} /></div>
                <div role="group" aria-label="Status" className="flex rounded-lg border border-kds-border">
                  {STATUS_FILTERS.map(([k, label]) => (
                    <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}
                      className={`min-h-11 border-b-2 px-3 text-sm font-semibold ${status === k ? 'border-kds-green text-kds-text' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {billsQ.isLoading && <p className="p-4 text-sm text-kds-subtext">Loading bills…</p>}
                {billsQ.isError && <p role="alert" className="p-4 text-sm font-semibold text-kds-red">{flowErrorMessage(billsQ.error)}</p>}
                {billsQ.data && bills.length === 0 && <div className="p-4"><CompactEmptyState tone="dark" icon={<Landmark size={20} />} message="No outstanding bills" detail="Nothing matches here that can be settled now." /></div>}
                {bills.length > 0 && (
                  <table className="w-full min-w-[920px] text-sm">
                    <thead className="sticky top-0 bg-kds-card">
                      <tr className="text-left text-xs font-bold uppercase tracking-wider text-kds-subtext">
                        <th className="w-10 px-3 py-3"><input type="checkbox" aria-label="Select all bills" className="h-4 w-4 accent-kds-green" checked={allTicked} onChange={toggleAll} /></th>
                        <th className="px-3 py-3">Bill</th><th className="px-3 py-3">Date</th><th className="px-3 py-3">Brand</th><th className="px-3 py-3">Due</th>
                        <th className="px-3 py-3">Status</th><th className="px-3 py-3 text-right">Amount</th><th className="px-3 py-3 text-right">Settled</th>
                        <th className="px-3 py-3 text-right">Still owed</th><th className="px-3 py-3 text-right">Pay now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bills.map((b) => {
                        const on = !!ticked[b.chargeId] && b.booked
                        const r = rows.find((x) => x.bill.chargeId === b.chargeId)
                        return (
                          <tr key={b.chargeId} className={`border-t border-kds-border ${on ? 'bg-kds-green/10' : ''} ${b.booked ? '' : 'opacity-60'}`}>
                            <td className="px-3 py-3"><input type="checkbox" aria-label={`Select bill ${b.orderRef}`} className="h-4 w-4 accent-kds-green" disabled={!b.booked} checked={on} onChange={() => setTicked((t) => ({ ...t, [b.chargeId]: !t[b.chargeId] }))} /></td>
                            <td className="px-3 py-3 font-semibold text-kds-text">{b.orderRef}{!b.booked && <span className="block text-xs font-normal text-kds-subtext">Not in the books yet</span>}</td>
                            <td className="whitespace-nowrap px-3 py-3 text-kds-text">{karachiDay(b.chargedAt)}</td>
                            <td className="px-3 py-3 text-kds-text">{b.brand}</td>
                            <td className="whitespace-nowrap px-3 py-3 text-kds-text">{b.dueDate ?? '—'}</td>
                            <td className="px-3 py-3">{statusChip(b.status)}</td>
                            <td className="px-3 py-3 text-right text-kds-text">{fmtPkr(b.amountCents)}</td>
                            <td className="px-3 py-3 text-right text-kds-subtext">{fmtPkr(b.settledCents)}</td>
                            <td className="px-3 py-3 text-right font-semibold text-kds-text">{fmtPkr(b.owedCents)}</td>
                            <td className="px-3 py-2 text-right">
                              {on ? (
                                <>
                                  <input inputMode="decimal" aria-label={`Pay now for bill ${b.orderRef}`} aria-invalid={!!r?.err} value={amountOf(b)}
                                    onChange={(e) => setAmounts((a) => ({ ...a, [b.chargeId]: e.target.value }))} className={`${inputCls} ml-auto w-32 text-right`} />
                                  {r?.err && <span role="alert" className="block text-xs font-semibold text-kds-red">{r.err}</span>}
                                </>
                              ) : <span className="text-kds-subtext">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              {/* Footer */}
              <div className="shrink-0 border-t border-kds-border bg-kds-card p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div role="group" aria-label="Payment method">
                    <span className={labelCls}>Payment method</span>
                    <div className="flex rounded-lg border border-kds-border">
                      {([['cash', 'Cash'], ['bank_transfer', 'Bank transfer']] as Array<[Method, string]>).map(([k, label]) => (
                        <button key={k} type="button" aria-pressed={method === k} onClick={() => setMethod(k)}
                          className={`min-h-11 px-4 text-sm font-semibold ${method === k ? 'bg-kds-green text-primary-on' : 'text-kds-text hover:bg-kds-border/40'}`}>{label}</button>
                      ))}
                    </div>
                  </div>
                  {method === 'bank_transfer' && (
                    <div className="min-w-[200px] flex-1"><label htmlFor="cl-ref" className={labelCls}>Reference (required)</label>
                      <input id="cl-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={inputCls} />
                      <label className="mt-2 flex items-center gap-2 text-sm text-kds-text">
                        <input type="checkbox" checked={transferSeen} onChange={(e) => setTransferSeen(e.target.checked)} />
                        I saw this transfer arrive on the counter device (bank app / SMS)
                      </label></div>
                  )}
                  <div className="ml-auto text-right">
                    <span className={labelCls}>Total to receive</span>
                    <span className="text-xl font-black text-kds-text">{fmtPkr(total)}</span>
                  </div>
                  <button type="button" disabled={!canConfirm} onClick={() => { setError(null); setConfirming(true) }} className={primaryBtn}>Confirm</button>
                </div>
                <p className="mt-2 text-xs text-kds-subtext">Card and Raast are not taken here. Bills already on a statement are paid in Receivables.</p>
              </div>
            </>
          )}
        </section>
      </div>

      {confirming && account && (
        <FlowDialog title="Record settlement" subtitle={`${account.number} · ${accountName(account)}`} onClose={() => { if (!posting) setConfirming(false) }} dismissible={!posting} width="max-w-lg">
          <ul className="divide-y divide-kds-border text-sm">
            {rows.map((r) => (
              <li key={r.bill.chargeId} className="flex justify-between py-2 text-kds-text"><span>{r.bill.orderRef} · {r.bill.brand}</span><span className="font-semibold">{fmtPkr(r.cents ?? 0)}</span></li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between text-base font-bold text-kds-text"><span>Total ({method === 'cash' ? 'Cash' : `Bank transfer · ${reference.trim()}`})</span><span>{fmtPkr(total)}</span></p>
          <div className="mt-3"><ErrorLine text={error} /></div>
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={posting} onClick={() => setConfirming(false)} className={`${ghostBtn} flex-1`}>Back</button>
            <button type="button" disabled={posting || !canConfirm} onClick={() => void submit()} className={`${primaryBtn} flex-1`}>{posting ? 'Recording…' : error ? 'Try again' : 'Record settlement'}</button>
          </div>
        </FlowDialog>
      )}
    </div>
  )
}
