'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Menu, Receipt, ScanBarcode, Search, ShoppingCart, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Category, MenuItem, ModifierGroup } from '../../../lib/api'
import { ApiError } from '../../../lib/api'
import { fmtPkr, fmtPkrWhole } from '../../../lib/money'
import { orderRef } from '../../../lib/orderRef'
import { useAuthStore } from '../../../store/auth'
import { usePosStore } from '../../../store/pos'
import { useConfirm } from '../../ui/ConfirmDialog'
import { PosCart } from '../PosCart'
import { VoidLineDialog } from '../VoidLineDialog'
import { useIsManager } from '../managerRole'
import {
  billFor, paidCentsOf, preBillErrorMessage, printPreBill, useOpenTickets, type TillBrand, type TillOrder, tableName } from '../tillApi'
import { CancelTicketDialog } from './CancelTicketDialog'
import { DiscountDialog } from './DiscountDialog'
import { ModifierModal } from './ModifierModal'
import {
  addItemsToTicket, flowErrorMessage, isOfflinePlaceholder, payServd, saveTicket, searchMenu, useCartTotals, type SearchItem,
} from './flowApi'
import { FlowDialog, ghostBtn, primaryBtn } from './ui'
import { newIdempotencyKey } from '../tillApi'

type Purpose = 'settle' | 'print' | 'comp' | 'quick'

/** Arrow / Home / End move between the tabs of a tablist. */
function tabKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i < 0 || tabs.length === 0) return
  e.preventDefault()
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[n]!.focus(); tabs[n]!.click()
}

// The order screen (owner's flow, step 4/5): search + Item Code/SKU, menu and category tabs, the item grid,
// the ticket on the right, Discount / No Charge bottom-left, Cancel / Print / Save / Settle bottom-right,
// and a Quick Pay bar with the total. Save creates the ticket and fires it (POST /pos/orders, TILL_FLOW §3).
export function OrderScreen({ conceptId, brand, categories, menuLoading, onMenu, onExit, onEditInfo, onTicketInfo, onSettle, onNoCharge }: {
  conceptId: string
  brand: TillBrand | undefined
  categories: Category[]
  menuLoading: boolean
  onMenu: () => void
  /** Leave the order screen (back to the table board / start). */
  onExit: () => void
  /** Edit the Order information (or the delivery details) held for the new ticket. */
  onEditInfo: () => void
  onTicketInfo: (t: TillOrder) => void
  onSettle: (t: TillOrder) => void
  onNoCharge: (t: TillOrder) => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const isManager = useIsManager()
  const cart = usePosStore((s) => s.cart)
  const fulfilment = usePosStore((s) => s.fulfilment)
  const tableId = usePosStore((s) => s.tableId)
  const tableLabel = usePosStore((s) => s.tableLabel)
  const waiter = usePosStore((s) => s.waiter)
  const partySize = usePosStore((s) => s.partySize)
  const delivery = usePosStore((s) => s.delivery)
  const discountCents = usePosStore((s) => s.discountCents)
  const shiftId = usePosStore((s) => s.shiftId)
  const addItem = usePosStore((s) => s.addItem)
  const count = cart.reduce((n, i) => n + i.quantity, 0)

  const [q, setQ] = useState('')
  const [code, setCode] = useState('')
  const [results, setResults] = useState<SearchItem[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null)
  const [showDiscount, setShowDiscount] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [sentIds, setSentIds] = useState<string[]>([])
  const [picker, setPicker] = useState<{ tickets: TillOrder[]; resolve: (t: TillOrder | null) => void } | null>(null)
  const [codAsk, setCodAsk] = useState<((v: boolean | null) => void) | null>(null)
  const [voidLine, setVoidLine] = useState<{ order: TillOrder; item: { id: string; name: string; quantity: number; lineCents: number } } | null>(null)
  const [cancelling, setCancelling] = useState<TillOrder | null>(null)
  const [preBillBusy, setPreBillBusy] = useState<string | null>(null)

  const totals = useCartTotals(conceptId)
  const cashTotal = totals.cash.data?.totalCents ?? null

  // Tickets already sent for this table (or sent from here this visit) — open and unpaid.
  const open = useOpenTickets(conceptId)
  const tickets = useMemo(
    () => (open.data ?? []).filter((t) => (fulfilment === 'dine_in' && tableId && t.tableId === tableId) || sentIds.includes(t.id)),
    [open.data, fulfilment, tableId, sentIds],
  )

  const menuItems = useMemo(() => {
    const m = new Map<string, MenuItem>()
    for (const c of categories) for (const i of c.items ?? []) m.set(i.id, i)
    return m
  }, [categories])
  const currentCategory = categories.find((c) => c.id === selectedCategory) ?? categories[0]

  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t) }, [note])

  // Live name search (debounced); the Item Code / SKU box searches on Enter.
  const searchSeq = useRef(0)
  useEffect(() => {
    const term = q.trim()
    if (!term) { setResults((r) => (code.trim() ? r : null)); return }
    const seq = ++searchSeq.current
    const t = setTimeout(() => {
      searchMenu(conceptId, term, selectedCategory).then((r) => { if (seq === searchSeq.current) setResults(r) }).catch((e) => { if (seq === searchSeq.current) setError(flowErrorMessage(e, 'Search failed')) })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, conceptId])

  function tap(item: MenuItem | undefined, fallbackName?: string) {
    if (!item) { setError(`${fallbackName ?? 'That item'} is not on the loaded menu. Reload the till.`); return }
    if (!item.isAvailable) { setNote(`${item.name} is sold out`); return }
    if (item.modifierGroups?.some((g: ModifierGroup) => g.isRequired || (g.modifiers?.length ?? 0) > 0)) setModifierItem(item)
    else addItem(item, [])
  }

  async function searchCode(e: React.FormEvent) {
    e.preventDefault()
    const c = code.trim()
    if (!c) return
    setSearchBusy(true); setError(null)
    try {
      const r = await searchMenu(conceptId, c)
      const exact = r.find((x) => x.itemCode?.toLowerCase() === c.toLowerCase())
      if (exact || r.length === 1) { tap(menuItems.get((exact ?? r[0]!).id), (exact ?? r[0]!).name); setCode(''); setResults(q.trim() ? results : null) }
      else if (r.length === 0) setError(`No item with the code or name "${c}".`)
      else setResults(r)
    } catch (err) { setError(flowErrorMessage(err, 'Search failed')) } finally { setSearchBusy(false) }
  }

  // ── Save: create the ticket and fire it ───────────────────────────────────
  async function doSave(): Promise<TillOrder | null> {
    const st = usePosStore.getState()
    if (st.cart.length === 0) return null
    if (st.fulfilment === 'dine_in' && !st.tableId) { setError('Pick a table first (Dine In).'); return null }
    if (st.fulfilment === 'delivery' && !st.delivery) { setError('Enter the delivery details first.'); return null }
    // Dine-in with a ticket already sent on this table: the items go on THAT ticket (owner, 2026-10-22).
    // Several open tickets → the cashier picks one. A discount belongs to a new ticket.
    if (st.fulfilment === 'dine_in' && tickets.length > 0 && st.discountCents === 0) {
      const target = tickets.length === 1 ? tickets[0]! : await pickTicket(tickets)
      if (!target) return null
      setBusy(true); setError(null)
      try {
        const r = await addItemsToTicket(target.id, { items: st.lines(), idempotencyKey: st.ensureCheckoutKey() })
        usePosStore.getState().clearLines()
        void qc.invalidateQueries({ queryKey: ['pos'] })
        setSentIds((ids) => (ids.includes(r.id) ? ids : [...ids, r.id]))
        return r
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null
        if (code !== 'BILL_IN_PAYMENT' && code !== 'ORDER_NOT_OPEN') { setError(flowErrorMessage(e, 'Could not add the items')); return null }
        const ok = await confirm({ title: 'Send as a new ticket?', body: `Payment has started on ${orderRef(target.id)}, so items cannot be added to it. Send these items as a new ticket on the table?`, confirmLabel: 'New ticket', cancelLabel: 'Go back' })
        if (!ok) return null
      } finally { setBusy(false) }
    }
    setBusy(true); setError(null)
    try {
      const r = await saveTicket({
        conceptId, idempotencyKey: st.ensureCheckoutKey(), shiftId: st.shiftId, tableId: st.tableId, fulfilment: st.fulfilment,
        waiter: st.waiter, partySize: st.partySize, guest: st.guest, customerId: st.guest?.customerId ?? st.customerId, delivery: st.delivery,
        discountCents: st.discountCents, discountReason: st.discountReason, discountPin: st.discountPin, items: st.lines(),
        brandName: brand?.name ?? null, totalCents: cashTotal,
      })
      // Lines go; the table, waiter and pax stay for the next round (added to this ticket while it is unpaid).
      usePosStore.getState().clearLines()
      void qc.invalidateQueries({ queryKey: ['pos'] })
      if (isOfflinePlaceholder(r)) { setNote('No internet. The order is kept on this till and goes to the kitchen when the connection is back. It is NOT in the kitchen yet — see "waiting to sync" at the top.'); return null }
      setSentIds((ids) => [...ids, r.id])
      return r
    } catch (e) {
      setError(flowErrorMessage(e, 'Could not send the order'))
      return null
    } finally { setBusy(false) }
  }

  async function onSave() {
    const t = await doSave()
    if (t) { setNote(`Sent to the kitchen · ${orderRef(t.id)}`); usePosStore.getState().clearCart(); onExit() }
  }

  function pickTicket(list: TillOrder[]): Promise<TillOrder | null> {
    return new Promise((resolve) => setPicker({ tickets: list, resolve }))
  }

  /** The ticket an action works on: the cart is saved first; otherwise the table's open ticket (the cashier picks if several). */
  async function ensureTicket(purpose: Purpose): Promise<TillOrder | null> {
    setError(null)
    if (cart.length > 0) {
      if (purpose === 'print' || purpose === 'comp') {
        const ok = await confirm({ title: 'Send the order to the kitchen first?', body: purpose === 'print' ? 'A KOT is printed for a saved ticket.' : 'No Charge applies to a saved ticket.', confirmLabel: 'Send and continue', cancelLabel: 'Go back' })
        if (!ok) return null
      }
      if (fulfilment === 'delivery' && (purpose === 'settle' || purpose === 'quick')) {
        const cod = await new Promise<boolean | null>((resolve) => setCodAsk(() => resolve))
        setCodAsk(null)
        if (cod == null) return null
        const d = usePosStore.getState().delivery
        if (d) usePosStore.getState().setDelivery({ ...d, cod })
        if (cod && purpose === 'quick') { setError('Cash on delivery: the rider collects it. Use Settle to send it to Dispatch.'); return null }
      }
      return doSave()
    }
    if (tickets.length === 0) { setError('Nothing here yet. Add items, or open a table that has a ticket.'); return null }
    return tickets.length === 1 ? tickets[0]! : pickTicket(tickets)
  }

  async function onSettleTap() { const t = await ensureTicket('settle'); if (t) onSettle(t) }
  async function onNoChargeTap() { const t = await ensureTicket('comp'); if (t) onNoCharge(t) }
  async function onPrintTap() {
    const t = await ensureTicket('print')
    if (t) await preBill(t)
  }
  async function preBill(t: TillOrder) {
    setPreBillBusy(t.id); setError(null)
    try { await printPreBill(t.id, 'cash', useAuthStore.getState().token); setNote(`KOT printed · ${orderRef(t.id)}`) }
    catch (e) { setError(preBillErrorMessage(e)) } finally { setPreBillBusy(null) }
  }

  // Quick Pay = close in servd with ONE cash tender for the whole bill (TILL_FLOW §6).
  async function onQuickPay() {
    if (!shiftId) { setError('Open a shift before taking payment.'); return }
    const t = await ensureTicket('quick')
    if (!t) return
    if (t.fulfilmentType === 'delivery' && (t.payments ?? []).some((p) => p.method === 'cash' && p.status === 'pending')) { setError('Cash on delivery: the rider collects it. Use Settle.'); return }
    try {
      const bill = await billFor(t, 'cash', brand)
      if (bill.kind === 'unavailable') { setError(bill.message); return }
      const due = bill.quote.dueCents
      if (due <= 0) { setError('Nothing is due on this bill.'); return }
      const ok = await confirm({ title: `Take ${fmtPkr(due)} in cash?`, body: `Quick Pay closes ${t.table?.label ? `table ${t.table.label}` : `order ${orderRef(t.id)}`} in servd with one exact cash payment.`, confirmLabel: 'Take cash', cancelLabel: 'Go back' })
      if (!ok) { onSettle(t); return }
      setBusy(true)
      const r = await payServd({ orderId: t.id, shiftId, idempotencyKey: newIdempotencyKey(), method: 'cash', amountCents: due, tenderedCents: due })
      void qc.invalidateQueries({ queryKey: ['pos'] })
      setNote(`Paid ${fmtPkr(due)} cash · ${orderRef(t.id)}${r.orderCompleted ? '' : ' · completes on delivery'}`)
      if (usePosStore.getState().cart.length === 0 && tickets.length <= 1) { usePosStore.getState().clearCart(); onExit() }
    } catch (e) { setError(flowErrorMessage(e, 'Quick Pay failed')) } finally { setBusy(false) }
  }

  function onCancel() {
    void (async () => {
      if (cart.length > 0) {
        const ok = await confirm({ title: 'Cancel this new order?', body: 'The items on the screen are cleared. Tickets already sent are not touched.', confirmLabel: 'Clear and leave', cancelLabel: 'Keep order', danger: true })
        if (!ok) return
      }
      usePosStore.getState().clearCart()
      onExit()
    })()
  }

  const dueOfTickets = tickets.reduce((s, t) => s + Math.max(0, t.totalCents - paidCentsOf(t)), 0)
  const quickTotal = cart.length > 0 ? cashTotal : tickets.length > 0 ? dueOfTickets : 0
  const anything = cart.length > 0 || tickets.length > 0

  const headline = fulfilment === 'dine_in'
    ? `${tableName(tableLabel ?? '—')}`
    : fulfilment === 'delivery' ? `Delivery${delivery?.name ? ` · ${delivery.name}` : ''}` : 'Takeaway'
  const sub = fulfilment === 'dine_in'
    ? [waiter?.name, partySize ? `${partySize} pax` : null].filter(Boolean).join(' · ') || 'No waiter or pax yet'
    : fulfilment === 'delivery' ? [delivery?.phone, delivery?.cod ? 'Cash on delivery' : 'Pay now'].filter(Boolean).join(' · ') : ''

  const gridItems = results
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Left — search, tabs, items */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
            <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search the menu</span>
              <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kds-subtext" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-h-11 w-full rounded-lg border border-kds-border bg-kds-bg pl-9 pr-3 text-base text-kds-text placeholder:text-kds-subtext focus:border-kds-green focus:outline-none" />
            </label>
            <form onSubmit={searchCode} className="relative w-40 shrink-0 sm:w-52">
              <label className="sr-only" htmlFor="os-code">Item Code or SKU</label>
              <ScanBarcode size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kds-subtext" />
              <input id="os-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={searchBusy} placeholder="Item Code/SKU" autoComplete="off" className="min-h-11 w-full rounded-lg border border-kds-border bg-kds-bg pl-9 pr-3 text-base text-kds-text placeholder:text-kds-subtext focus:border-kds-green focus:outline-none" />
            </form>
            <button type="button" onClick={() => setTicketOpen(true)} className="relative flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-kds-green px-3 font-bold text-primary-on lg:hidden">
              <ShoppingCart size={18} aria-hidden="true" /> {count + tickets.length > 0 ? count || tickets.length : ''}<span className="sr-only"> Ticket</span>
            </button>
          </div>

          {/* Menu tab (one menu per brand) and category tabs */}
          <div role="tablist" aria-label="Menu" className="flex gap-1 overflow-x-auto border-b border-kds-border bg-kds-card px-3 py-2 scrollbar-hide">
            <button role="tab" aria-selected className="min-h-11 shrink-0 rounded-lg bg-kds-green px-4 text-sm font-semibold text-primary-on">{brand?.name ?? 'Main Menu'}</button>
          </div>
          <div role="tablist" aria-label="Menu category" onKeyDown={tabKeys} className="flex gap-1 overflow-x-auto border-b border-kds-border bg-kds-card px-3 py-2 scrollbar-hide">
            {categories.map((cat) => {
              const on = cat.id === (selectedCategory ?? categories[0]?.id)
              return (
                <button key={cat.id} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => { setSelectedCategory(cat.id); setResults(null); setQ(''); setCode('') }}
                  className={`min-h-11 shrink-0 rounded-lg px-4 text-sm font-semibold ${on && !gridItems ? 'bg-kds-green text-primary-on' : 'border border-kds-border text-kds-subtext hover:text-kds-text'}`}>{cat.name}</button>
              )
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {gridItems && (
              <div className="mb-2 flex items-center justify-between text-sm text-kds-subtext">
                <span>{gridItems.length} result{gridItems.length !== 1 ? 's' : ''}</span>
                <button type="button" onClick={() => { setResults(null); setQ(''); setCode('') }} className="flex min-h-11 items-center gap-1 px-2 font-semibold text-kds-text"><X size={16} aria-hidden="true" /> Clear search</button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {menuLoading && Array.from({ length: 8 }, (_, i) => <div key={i} aria-hidden className="min-h-[88px] animate-pulse rounded-lg bg-kds-border/40" />)}
              {gridItems
                ? gridItems.map((r) => {
                    const item = menuItems.get(r.id)
                    return (
                      <button key={r.id} type="button" onClick={() => tap(item, r.name)} aria-disabled={!r.isAvailable}
                        className={`flex min-h-[88px] flex-col items-start rounded-lg border p-3 text-left active:scale-95 ${r.isAvailable ? 'border-kds-border bg-kds-card hover:border-kds-green' : 'border-kds-border bg-kds-border/30 opacity-40'}`}>
                        <span className="font-semibold leading-tight text-kds-text">{r.name}</span>
                        <span className="text-xs text-kds-subtext">{r.itemCode ? `${r.itemCode} · ` : ''}{r.categoryName}</span>
                        <span className="mt-auto pt-1 text-sm font-bold text-kds-green">{fmtPkrWhole(r.priceCents)}</span>
                      </button>
                    )
                  })
                : currentCategory?.items.map((item) => {
                    return (
                      <button key={item.id} type="button" onClick={() => tap(item)} aria-disabled={!item.isAvailable}
                        className={`flex min-h-[88px] flex-col items-start rounded-lg border p-3 text-left active:scale-95 ${item.isAvailable ? 'border-kds-border bg-kds-card hover:border-kds-green' : 'border-kds-border bg-kds-border/30 opacity-40'}`}>
                        {item.imageUrl && <img src={item.imageUrl} alt="" className="mb-2 h-12 w-full rounded object-cover" />}
                        <span className="font-semibold leading-tight text-kds-text">{item.name}</span>
                        {item.itemCode && <span className="text-xs text-kds-subtext">{item.itemCode}</span>}
                        <span className="mt-auto pt-1 text-sm font-bold text-kds-green">{fmtPkrWhole(item.priceCents)}</span>
                        {!item.isAvailable && <span className="mt-1 text-xs font-bold text-kds-red">86&apos;d</span>}
                      </button>
                    )
                  })}
            </div>
          </div>
        </div>

        {/* Right — the ticket */}
        {ticketOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setTicketOpen(false)} aria-hidden="true" />}
        <aside aria-label="Current ticket" className={`${ticketOpen ? 'flex' : 'hidden'} fixed inset-y-0 right-0 z-40 w-full max-w-md flex-col border-l border-kds-border bg-kds-card lg:static lg:z-auto lg:flex lg:w-[22rem] lg:max-w-none xl:w-96`}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-kds-border py-2 pl-3 pr-1">
            <div className="min-w-0">
              <h2 className="truncate font-bold text-kds-text">{headline}</h2>
              <p className="truncate text-xs text-kds-subtext">{sub}</p>
            </div>
            <div className="flex items-center">
              <button type="button" onClick={onEditInfo} className="min-h-11 px-3 text-sm font-semibold text-kds-green">{fulfilment === 'delivery' ? 'Edit' : 'Info'}</button>
              <button type="button" data-dialog-close onClick={() => setTicketOpen(false)} aria-label="Close ticket" className="flex h-11 w-11 items-center justify-center text-kds-subtext lg:hidden"><X size={20} aria-hidden="true" /></button>
            </div>
          </div>

          {tickets.length > 0 && (
            <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-kds-border">
              <p className="px-3 pt-2 text-[11px] font-bold uppercase tracking-wider text-kds-subtext">Sent to the kitchen</p>
              <ul className="divide-y divide-kds-border">
                {tickets.map((t) => {
                  const due = Math.max(0, t.totalCents - paidCentsOf(t))
                  const live = t.items.filter((i) => i.status !== 'voided')
                  return (
                    <li key={t.id} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-kds-text">Ticket {tickets.indexOf(t) + 1} · {orderRef(t.id)} <span className="font-normal text-kds-subtext">· {t.status}{t.waiter ? ` · ${t.waiter.fullName}` : ''}{t.cod ? ' · COD' : ''}</span></span>
                        <span className="text-sm font-bold text-kds-green">{fmtPkr(due)}</span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {live.map((i) => (
                          <li key={i.id} className="flex items-center justify-between gap-2 text-xs text-kds-subtext">
                            <span className="min-w-0 truncate">{i.quantity} × {i.name}</span>
                            <button type="button" onClick={() => setVoidLine({ order: t, item: { id: i.id, name: i.name, quantity: i.quantity, lineCents: i.unitPriceCents * i.quantity } })}
                              aria-label={`Void ${i.name}`} className="min-h-8 shrink-0 px-2 text-xs font-semibold text-kds-red underline">Void</button>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 grid grid-cols-4 gap-1">
                        <button type="button" onClick={() => onSettle(t)} className="min-h-11 rounded-lg bg-kds-green text-xs font-bold text-primary-on">Settle</button>
                        <button type="button" onClick={() => void preBill(t)} disabled={preBillBusy === t.id} className="min-h-11 rounded-lg border border-kds-border text-xs font-semibold text-kds-text disabled:opacity-40">KOT</button>
                        <button type="button" onClick={() => onTicketInfo(t)} className="min-h-11 rounded-lg border border-kds-border text-xs font-semibold text-kds-text">Info</button>
                        <button type="button" onClick={() => setCancelling(t)} className="min-h-11 rounded-lg border border-kds-border text-xs font-semibold text-kds-red">Cancel</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <p className="shrink-0 px-3 pt-2 text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
            {tickets.length > 0 && fulfilment === 'dine_in' ? `New round — ticket ${tickets.length + 1} on ${tableName(tableLabel ?? '')}` : 'New items'}
          </p>
          {tickets.length > 0 && fulfilment === 'dine_in' && <p className="shrink-0 px-3 pb-1 text-xs text-kds-subtext">Save adds these items to the ticket already sent on this table (pick one if there are several). Once payment has started, they go on a new ticket.</p>}
          <div className="min-h-0 flex-1"><PosCart conceptId={conceptId} /></div>

          <button type="button" onClick={() => void onQuickPay()} disabled={busy || !anything} aria-label={`Quick Pay, ${quickTotal != null ? fmtPkr(quickTotal) : ''}`}
            className="flex min-h-14 shrink-0 items-center justify-between bg-kds-border px-4 text-left font-bold text-kds-text disabled:opacity-40">
            <span className="flex items-center gap-2"><Receipt size={18} aria-hidden="true" /> Quick Pay</span>
            <span className="text-lg text-kds-green">{quickTotal != null ? fmtPkr(quickTotal) : '…'}</span>
          </button>
        </aside>
      </div>

      {(error || note) && (
        <p role={error ? 'alert' : 'status'} className={`border-t px-4 py-2 text-sm font-semibold ${error ? 'border-kds-red bg-kds-red/10 text-kds-red' : 'border-kds-green bg-kds-green/10 text-kds-green'}`}>{error ?? note}</p>
      )}

      {/* Bottom bar: Discount / No Charge, then Cancel / Print / Save / Settle */}
      <div className="flex shrink-0 items-center gap-2 border-t border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={() => setShowDiscount(true)} disabled={cart.length === 0} className={`${ghostBtn} px-3 text-sm`}>
          Discount{discountCents > 0 ? ` (${fmtPkrWhole(discountCents)})` : ''}
        </button>
        <button type="button" onClick={() => void onNoChargeTap()} disabled={busy || !anything} className={`${ghostBtn} px-3 text-sm`}>No Charge</button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onCancel} className={`${ghostBtn} px-3 text-sm`}>Cancel</button>
          <button type="button" onClick={() => void onPrintTap()} disabled={busy || !anything} className={`${ghostBtn} px-3 text-sm`}>Print</button>
          <button type="button" onClick={() => void onSave()} disabled={busy || cart.length === 0} className={`${ghostBtn} border-kds-green px-3 text-sm text-kds-green`}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => void onSettleTap()} disabled={busy || !anything} className={`${primaryBtn} px-4 text-sm`}>Settle</button>
        </div>
      </div>

      {modifierItem && <ModifierModal item={modifierItem} onConfirm={(mods) => { addItem(modifierItem, mods); setModifierItem(null) }} onClose={() => setModifierItem(null)} />}
      {showDiscount && <DiscountDialog onClose={() => setShowDiscount(false)} />}
      {cancelling && <CancelTicketDialog ticket={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setNote('Ticket cancelled') }} />}
      {voidLine && (
        <VoidLineDialog orderId={voidLine.order.id} item={voidLine.item} isManager={isManager} onClose={() => setVoidLine(null)}
          onVoided={() => { setVoidLine(null); void qc.invalidateQueries({ queryKey: ['pos'] }); setNote('Line voided') }} />
      )}
      {picker && (
        <FlowDialog title="Which ticket?" subtitle="This table has more than one open ticket" onClose={() => { picker.resolve(null); setPicker(null) }} width="max-w-sm">
          <ul className="space-y-2">
            {picker.tickets.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => { picker.resolve(t); setPicker(null) }} className="flex min-h-14 w-full items-center justify-between rounded-lg border border-kds-border px-4 text-left hover:border-kds-green">
                  <span className="font-bold text-kds-text">{orderRef(t.id)}<span className="block text-xs font-normal text-kds-subtext">{t.items.filter((i) => i.status !== 'voided').reduce((n, i) => n + i.quantity, 0)} items · {t.status}</span></span>
                  <span className="font-bold text-kds-green">{fmtPkr(Math.max(0, t.totalCents - paidCentsOf(t)))}</span>
                </button>
              </li>
            ))}
          </ul>
        </FlowDialog>
      )}
      {codAsk && (
        <FlowDialog title="How does the customer pay?" subtitle="Delivery" onClose={() => codAsk(null)} width="max-w-sm">
          <div className="grid gap-3">
            <button type="button" onClick={() => codAsk(false)} className={`${primaryBtn} py-4 text-lg`}>Pay now</button>
            <button type="button" onClick={() => codAsk(true)} className={`${ghostBtn} py-4 text-lg`}>Cash on delivery</button>
          </div>
        </FlowDialog>
      )}
    </div>
  )
}
