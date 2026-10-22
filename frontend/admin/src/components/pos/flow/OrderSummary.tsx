'use client'
// Order Summary (owner, 2026-10-22: "This is how order summary should look
// like for settled, Running and Void orders"). One brand, one day: All /
// Running / Settled / Voided with counts, an order-type filter and search
// (GET /pos/orders/summary). Pick one order, then act on it — every button
// calls the till's EXISTING route, whose own guard decides:
//   Recall          running → the settle screen; settled / voided → the bill
//   Reprint Receipt the full & final bill marked DUPLICATE (settled)
//   Reprint KOT     the KOT (pre-bill) of a running ticket — a new print row
//   Void            running → cancel (manager); settled → credit note (manager;
//                   a bill of an earlier day is the CEO's, with a reason)
//   Split           running → the settle screen on Split
//   Change Owner    running → the ticket's waiter (Order information)
//   Download PDF    the list as shown

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns2, Download, ExternalLink, Menu, Printer, RefreshCw, Search, Trash2, UserRound } from 'lucide-react'
import { api, ApiError } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { fmtPkr } from '../../../lib/money'
import { useIsManager } from '../managerRole'
import { fetchPrintableHtml, fetchReceiptHtml, printHtml, printPreBill, type TillOrder } from '../tillApi'
import { CancelTicketDialog } from './CancelTicketDialog'
import { flowErrorMessage } from './flowApi'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls } from './ui'
import { Select } from '../../ui/Select'

type Tab = 'all' | 'running' | 'settled' | 'voided'
type OrderType = 'all' | 'dine_in' | 'takeout' | 'delivery' | 'no_charge'
interface Row {
  id: string; orderNo: string; placedAt: string; time: string; receiptNo: string | null; table: string | null
  type: Exclude<OrderType, 'all'>; guest: string | null; user: string | null; waiter: string | null
  status: Exclude<Tab, 'all'>; orderStatus: string; amountCents: number; compCents: number
}
interface SummaryView { date: string; counts: Record<Tab, number>; rows: Row[] }

const TYPE_LABEL: Record<Row['type'], string> = { dine_in: 'Dine In', takeout: 'Takeaway', delivery: 'Delivery', no_charge: 'No Charge' }
const STATUS_LABEL: Record<Row['status'], string> = { running: 'Running', settled: 'Settled', voided: 'Voided' }
const TABS: Array<[Tab, string]> = [['all', 'All'], ['running', 'Running'], ['settled', 'Settled'], ['voided', 'Voided']]
const karachiToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)

export function OrderSummary({ conceptId, onMenu, onRecall, onChangeOwner }: {
  conceptId: string | null
  onMenu: () => void
  /** Open a running ticket on the settle screen (split = start on Split). */
  onRecall: (ticket: TillOrder, opts?: { split?: boolean }) => void
  /** Order information of a running ticket (its waiter). */
  onChangeOwner: (ticket: TillOrder) => void
}) {
  const qc = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const isManager = useIsManager()
  const [date, setDate] = useState(karachiToday())
  const [tab, setTab] = useState<Tab>('settled')
  const [type, setType] = useState<OrderType>('all')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<TillOrder | null>(null)
  const [creditNote, setCreditNote] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<{ row: Row; html: string } | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams({ conceptId: conceptId ?? '', date, tab, type })
    if (q.trim()) p.set('q', q.trim())
    return p.toString()
  }, [conceptId, date, tab, type, q])
  const list = useQuery({
    queryKey: ['pos', 'order-summary', query],
    queryFn: () => api.get<SummaryView>(`/pos/orders/summary?${query}`),
    enabled: !!conceptId,
    refetchInterval: 30_000,
  })
  const rows = list.data?.rows ?? []
  const row = rows.find((r) => r.id === picked) ?? null
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['pos'] }) }

  async function ticketOf(r: Row): Promise<TillOrder> { return api.get<TillOrder>(`/orders/${encodeURIComponent(r.id)}`) }
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setError(null)
    try { await fn() } catch (e) { setError(flowErrorMessage(e, `Could not ${label.toLowerCase()}`)) } finally { setBusy(null) }
  }

  const can = {
    recall: !!row,
    receipt: row?.status === 'settled' || row?.orderStatus === 'refunded',
    kot: row?.status === 'running',
    void: !!row && row.status !== 'voided' && (row.status === 'running' || isManager),
    split: row?.status === 'running',
    owner: row?.status === 'running',
  }

  const actions: Array<{ key: keyof typeof can; label: string; icon: React.ReactNode; onClick: () => void }> = [
    { key: 'recall', label: 'Recall', icon: <ExternalLink size={16} aria-hidden="true" />, onClick: () => row && void run('Recall', async () => {
      if (row.status === 'running') { onRecall(await ticketOf(row)); return }
      const html = row.orderStatus === 'completed' || row.orderStatus === 'refunded'
        ? await fetchReceiptHtml(row.id, token, { duplicate: true })
        : await fetchPrintableHtml(`/pos/receipt/${encodeURIComponent(row.id)}?duplicate=1`, token).catch(() => '<p style="font-family:sans-serif;padding:16px">This order was voided before a bill was issued.</p>')
      setViewing({ row, html })
    }) },
    { key: 'receipt', label: 'Reprint Receipt', icon: <Printer size={16} aria-hidden="true" />, onClick: () => row && void run('Reprint Receipt', () => printHtml(() => fetchReceiptHtml(row.id, token, { duplicate: true }))) },
    { key: 'kot', label: 'Reprint KOT', icon: <Printer size={16} aria-hidden="true" />, onClick: () => row && void run('Reprint KOT', () => printPreBill(row.id, 'cash', token)) },
    { key: 'void', label: 'Void', icon: <Trash2 size={16} aria-hidden="true" />, onClick: () => row && void run('Void', async () => {
      if (row.status === 'running') setCancelling(await ticketOf(row)); else setCreditNote(row)
    }) },
    { key: 'split', label: 'Split', icon: <Columns2 size={16} aria-hidden="true" />, onClick: () => row && void run('Split', async () => onRecall(await ticketOf(row), { split: true })) },
    { key: 'owner', label: 'Change Owner', icon: <UserRound size={16} aria-hidden="true" />, onClick: () => row && void run('Change Owner', async () => onChangeOwner(await ticketOf(row))) },
  ]

  async function downloadPdf() {
    await run('Download PDF', () => api.download(`/pos/orders/summary?${query}&format=pdf`, `order-summary-${date}.pdf`))
  }

  const tone = (s: Row['status']) => (s === 'settled' ? 'text-kds-green' : s === 'running' ? 'text-kds-amber' : 'text-kds-red')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">Order Summary</h1>
        <button type="button" onClick={() => void list.refetch()} aria-label="Refresh" className="ml-auto flex h-11 w-11 items-center justify-center rounded-lg text-kds-subtext hover:text-kds-text"><RefreshCw size={18} aria-hidden="true" className={list.isFetching ? 'animate-spin' : ''} /></button>
      </div>

      {/* Date · tabs · type · search */}
      <div className="flex flex-wrap items-stretch gap-2 border-b border-kds-border p-3">
        <label className="flex items-center"><span className="sr-only">Day</span>
          <input type="date" value={date} max={karachiToday()} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPicked(null) } }} className={`${inputCls} w-44`} /></label>
        <div role="tablist" aria-label="Order status" className="flex flex-1 min-w-[320px] rounded-lg border border-kds-border">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => { setTab(k); setPicked(null) }}
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 border-b-2 px-3 text-sm font-semibold ${tab === k ? 'border-kds-green text-kds-text' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
              {label}
              <span className={`rounded-full px-2 text-xs font-black ${k === 'running' ? 'bg-kds-amber text-black' : k === 'settled' ? 'bg-kds-green text-primary-on' : k === 'voided' ? 'bg-kds-red text-white' : 'bg-kds-border text-kds-text'}`}>{list.data?.counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="w-44">
          <Select aria-label="Order type" value={type} onChange={(e) => { setType(e.target.value as OrderType); setPicked(null) }} className={inputCls}>
            <option value="all">All</option>
            <option value="dine_in">Dine In</option>
            <option value="takeout">Takeaway</option>
            <option value="delivery">Delivery</option>
            <option value="no_charge">No Charge</option>
          </Select>
        </div>
        <label className="relative flex min-w-[200px] flex-1 items-center">
          <span className="sr-only">Search orders</span>
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 text-kds-subtext" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={`${inputCls} pl-9`} />
        </label>
      </div>

      {/* Actions on the picked order */}
      <div className="flex flex-wrap items-center gap-2 border-b border-kds-border px-3 py-2">
        <span className="mr-auto text-sm text-kds-subtext">{row ? `Order ${row.orderNo} selected` : '0 record(s) selected'}</span>
        {actions.map((a) => (
          <button key={a.key} type="button" onClick={a.onClick} disabled={!can[a.key] || !!busy}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-kds-border px-3 text-sm font-semibold text-kds-text hover:border-kds-green disabled:opacity-30">
            {a.icon}{busy === a.label ? `${a.label}…` : a.label}
          </button>
        ))}
        <button type="button" onClick={() => void downloadPdf()} disabled={!conceptId || !!busy}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-kds-border px-3 text-sm font-semibold text-kds-text hover:border-kds-green disabled:opacity-30">
          <Download size={16} aria-hidden="true" />{busy === 'Download PDF' ? 'Downloading…' : 'Download PDF'}
        </button>
      </div>
      {error && <div className="px-3 pt-2"><ErrorLine text={error} /></div>}

      {/* The list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!conceptId && <p className="p-4 text-sm text-kds-subtext">Pick a brand first.</p>}
        {list.isLoading && <p className="p-4 text-sm text-kds-subtext">Loading orders…</p>}
        {list.isError && <p role="alert" className="p-4 text-sm font-semibold text-kds-red">{flowErrorMessage(list.error)}</p>}
        {list.data && rows.length === 0 && <p className="p-4 text-sm text-kds-subtext">No orders here for {date}.</p>}
        {rows.length > 0 && (
          <table className="w-full min-w-[960px] text-sm">
            <thead className="sticky top-0 bg-kds-card">
              <tr className="text-left text-xs font-bold uppercase tracking-wider text-kds-subtext">
                <th className="w-10 px-3 py-3"><span className="sr-only">Select</span></th>
                <th className="px-3 py-3">Order</th><th className="px-3 py-3">Time</th><th className="px-3 py-3">Receipt No</th>
                <th className="px-3 py-3">R/T No</th><th className="px-3 py-3">Order Type</th><th className="px-3 py-3">Guest Name</th>
                <th className="px-3 py-3">User</th><th className="px-3 py-3">Status</th><th className="px-3 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setPicked(picked === r.id ? null : r.id)}
                  className={`cursor-pointer border-t border-kds-border ${picked === r.id ? 'bg-kds-green/10' : 'hover:bg-kds-border/40'}`}>
                  <td className="px-3 py-3"><input type="checkbox" aria-label={`Select order ${r.orderNo}`} className="h-4 w-4 accent-kds-green" checked={picked === r.id} onChange={() => setPicked(picked === r.id ? null : r.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="px-3 py-3 font-semibold text-kds-text">{r.orderNo}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-kds-text">{r.time}</td>
                  <td className="px-3 py-3 text-kds-text">{r.receiptNo ?? '—'}</td>
                  <td className="px-3 py-3 text-kds-text">{r.table ?? '-N/A-'}</td>
                  <td className="px-3 py-3 text-kds-text">{TYPE_LABEL[r.type]}</td>
                  <td className="max-w-[200px] truncate px-3 py-3 text-kds-text" title={r.guest ?? ''}>{r.guest ?? '—'}</td>
                  <td className="px-3 py-3 text-kds-text">{r.user ?? '—'}{r.waiter && r.waiter !== r.user && <span className="block text-xs text-kds-subtext">Waiter: {r.waiter}</span>}</td>
                  <td className={`px-3 py-3 text-xs font-bold ${tone(r.status)}`}>{r.orderStatus === 'refunded' ? 'Credit note' : STATUS_LABEL[r.status]}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`inline-block min-w-[110px] rounded-lg px-3 py-2 text-center font-bold ${r.status === 'settled' ? 'bg-kds-green/20 text-kds-green' : r.status === 'running' ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-red/20 text-kds-red'}`}>
                      {fmtPkr(r.type === 'no_charge' ? r.compCents : r.amountCents)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cancelling && <CancelTicketDialog ticket={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setPicked(null); refresh() }} />}
      {creditNote && <CreditNoteDialog row={creditNote} today={karachiToday()} onClose={() => setCreditNote(null)} onDone={() => { setCreditNote(null); setPicked(null); refresh() }} />}
      {viewing && (
        <FlowDialog title={`Order ${viewing.row.orderNo}`} subtitle={`${STATUS_LABEL[viewing.row.status]} · ${viewing.row.time}`} onClose={() => setViewing(null)} width="max-w-md">
          <iframe title={`Bill ${viewing.row.orderNo}`} srcDoc={viewing.html} sandbox="" className="h-[70dvh] w-full rounded-lg bg-white" />
        </FlowDialog>
      )}
    </div>
  )
}

/** Void a SETTLED bill = a credit note (sales return; the money is owed back on till clearing) —
 *  POST /invoices/orders/:id/credit-note, managers; a bill of an earlier day is the CEO's, with a reason. */
function CreditNoteDialog({ row, today, onClose, onDone }: { row: Row; today: string; onClose: () => void; onDone: () => void }) {
  const isCeo = useAuthStore((s) => s.isRole('admin'))
  const billDay = new Date(new Date(row.placedAt).getTime() + 5 * 3600_000).toISOString().slice(0, 10)
  const earlier = billDay < today
  const [reason, setReason] = useState('')
  const [backdated, setBackdated] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function go(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await api.post(`/invoices/orders/${encodeURIComponent(row.id)}/credit-note`, { reason: reason.trim(), ...(earlier && { backdatedReason: backdated.trim() }) })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CEO_ONLY_BACKDATED' ? 'This bill is from an earlier day — only the CEO can void it.' : flowErrorMessage(err, 'Could not void the bill'))
    } finally { setBusy(false) }
  }
  return (
    <FlowDialog title="Void this bill" subtitle={`Order ${row.orderNo} · ${fmtPkr(row.amountCents)}`} onClose={onClose} width="max-w-sm">
      <form onSubmit={go} className="space-y-4">
        <p className="text-sm text-kds-subtext">A settled bill is voided with a credit note: the sale is reversed, the money is owed back to the guest (pay it out from the till), and the fiscal void is filed.</p>
        {earlier && !isCeo && <p className="rounded-lg border border-kds-amber p-3 text-sm font-semibold text-kds-amber">This bill is from {billDay}. Only the CEO can void a bill of an earlier day.</p>}
        <div><label htmlFor="cn-reason" className={labelCls}>Reason (required)</label><input id="cn-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={inputCls} /></div>
        {earlier && isCeo && (
          <div><label htmlFor="cn-back" className={labelCls}>Why an earlier day (at least 10 characters)</label><input id="cn-back" value={backdated} onChange={(e) => setBackdated(e.target.value)} maxLength={300} className={inputCls} /></div>
        )}
        <ErrorLine text={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className={`${ghostBtn} flex-1`}>Keep it</button>
          <button type="submit" disabled={busy || !reason.trim() || (earlier && (!isCeo || backdated.trim().length < 10))}
            className="min-h-11 flex-1 rounded-xl bg-kds-red px-4 py-3 font-bold text-white disabled:opacity-30">{busy ? 'Voiding…' : 'Void bill'}</button>
        </div>
      </form>
    </FlowDialog>
  )
}
