'use client'
import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react'
import { ArrowRight, Check, TriangleAlert } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, menuApi, type Category, type MenuItem, type ModifierGroup, type Modifier } from '../../lib/api'
import { usePosStore } from '../../store/pos'
import { OpenTickets } from '../../components/pos/OpenTickets'
import { RaastAlerts } from '../../components/pos/RaastAlerts'
import { useIsManager } from '../../components/pos/managerRole'
import { useOpenTickets, type TillBrand, type TillOrder } from '../../components/pos/tillApi'
import { StartMenu, type StartAction } from '../../components/pos/flow/StartMenu'
import { TableBoard } from '../../components/pos/flow/TableBoard'
import { OrderInfoModal, EMPTY_GUEST, type OrderInfoValues } from '../../components/pos/flow/OrderInfoModal'
import { DeliveryForm } from '../../components/pos/flow/DeliveryForm'
import { OrderScreen } from '../../components/pos/flow/OrderScreen'
import { SettleScreen } from '../../components/pos/flow/SettleScreen'
import { NoChargeDialog } from '../../components/pos/flow/NoChargeDialog'
import { FlowDialog } from '../../components/pos/flow/ui'
import { orderRef } from '../../lib/orderRef'
import { OrderSummary } from '../../components/pos/flow/OrderSummary'
import { SalesReport } from '../../components/pos/flow/SalesReport'
import { getOrderInfo, flowErrorMessage, type BoardTable, type OrderInfoView } from '../../components/pos/flow/flowApi'
import { requestSync, listenForSync, getQueuedOrders } from '../../lib/offline-queue'
import Link from 'next/link'
import { useCurrentShift } from '../../hooks/useCurrentShift'
import { useDialog } from '../../components/ui/Modal'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { useTrashPrefill } from '../../lib/trash'
import { unwrapPrefill, pStr, pNum, pArr, pWarnings, type Prefill } from '../../lib/trashPrefill'

/** Arrow / Home / End move between the tabs of a tablist (brand tabs only move focus). */
function tabListKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i < 0 || tabs.length === 0) return
  e.preventDefault()
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[n]!.focus()
}

type View = 'home' | 'board' | 'delivery' | 'order' | 'summary' | 'sales_report'
type InfoModal =
  | { kind: 'new'; title: string; initial: OrderInfoValues }
  | { kind: 'ticket'; orderId: string; title: string; initial: OrderInfoValues }

// The till (owner's flow, 2026-10-20): start menu -> Dine In table board -> Order information ->
// order screen -> settle (close in servd / push to Keenu). Contract: backend/src/modules/pos/TILL_FLOW.md.
export default function PosPage() {
  const [view, setView] = useState<View>('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [showTickets, setShowTickets] = useState<false | 'settle' | 'nocharge'>(false)
  const [settle, setSettle] = useState<TillOrder | null>(null)
  const [settleOnSplit, setSettleOnSplit] = useState(false)
  const [noCharge, setNoCharge] = useState<TillOrder | null>(null)
  const [info, setInfo] = useState<InfoModal | null>(null)
  const [assignPick, setAssignPick] = useState<{ label: string; tickets: TillOrder[] } | null>(null)
  const [isOnline, setIsOnline] = useState(true)
  const [queuedCount, setQueuedCount] = useState(0)
  const [syncedCount, setSyncedCount] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const confirm = useConfirm()

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
    setIsOnline(navigator.onLine)
    const handleOnline = () => { setIsOnline(true); requestSync() }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    getQueuedOrders().then(orders => setQueuedCount(orders.length)).catch(() => {})
    const unsub = listenForSync((count) => {
      setSyncedCount(count)
      setQueuedCount(0)
      setTimeout(() => setSyncedCount(0), 4000)
    })
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      unsub()
    }
  }, [])

  const storedConceptId = usePosStore((s) => s.conceptId)
  const shiftId = usePosStore((s) => s.shiftId)
  const delivery = usePosStore((s) => s.delivery)
  // The server, not this browser, says which drawer this user is on.
  useCurrentShift()

  // The brands this user may ring — the company's active brands, scoped by the server (FOH-01).
  const { data: concepts = [], isError: brandsFailed, isLoading: brandsLoading } = useQuery({
    queryKey: ['pos', 'brands'],
    queryFn: () => api.get<TillBrand[]>('/concepts'),
  })
  // The remembered brand only if it is still one of ours, else the first brand.
  const conceptId = (storedConceptId && concepts.some((c) => c.id === storedConceptId))
    ? storedConceptId
    : concepts[0]?.id ?? ''
  // UI-03: the brand shown is the brand rung — store the auto-selected one.
  useEffect(() => {
    if (conceptId && conceptId !== storedConceptId) usePosStore.getState().setConceptId(conceptId)
  }, [conceptId, storedConceptId])

  const openTickets = useOpenTickets(conceptId || null)
  const ticketCount = openTickets.data?.length ?? 0
  // Raast QR bank alerts: managers approve with their own session.
  const isManager = useIsManager()
  const refetchTickets = openTickets.refetch
  const onRaastBillPaid = useCallback(() => { void refetchTickets() }, [refetchTickets])

  const { data: categories = [], isLoading: menuLoading } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })
  const activeConcept = concepts.find((c) => c.id === conceptId)

  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t) }, [note])

  // ── "Recover as copy" from the Trash (types `order` and `order_item`) ──────
  // The payload carries the brand, table, customer and lines of the original and NOTHING money-side.
  // Lines are re-priced from today's menu; a dish that is gone or sold out is dropped with a note.
  const orderPrefill = unwrapPrefill(useTrashPrefill('order'))
  const itemPrefill = unwrapPrefill(useTrashPrefill('order_item'))
  const [pendingPrefill, setPendingPrefill] = useState<{ p: Prefill; replace: boolean } | null>(null)
  useEffect(() => {
    if (orderPrefill) setPendingPrefill({ p: orderPrefill, replace: true })
    else if (itemPrefill) setPendingPrefill({ p: itemPrefill, replace: false })
  }, [orderPrefill, itemPrefill])
  useEffect(() => {
    if (!pendingPrefill || concepts.length === 0) return
    const { p, replace } = pendingPrefill
    const target = pStr(p, 'conceptId', 'brandId')
    if (target && concepts.some((c) => c.id === target) && target !== conceptId) {
      usePosStore.getState().setConceptId(target) // the menu reloads for that brand
      return
    }
    if (menuLoading || categories.length === 0) return
    setPendingPrefill(null)
    const menu = new Map<string, MenuItem>()
    for (const c of categories) for (const i of c.items ?? []) menu.set(i.id, i)
    let raw = pArr<Prefill>(p, 'items', 'lines')
    if (raw.length === 0) {
      const one = p.item && typeof p.item === 'object' ? (p.item as Prefill) : p
      if (pStr(one, 'menuItemId')) raw = [one]
    }
    const dropped: string[] = [...pWarnings(p)]
    const lines: Array<{ item: MenuItem; qty: number; notes: string; mods: Modifier[] }> = []
    for (const l of raw) {
      const id = pStr(l, 'menuItemId', 'itemId')
      const item = id ? menu.get(id) : undefined
      const label = pStr(l, 'name') ?? 'A dish'
      if (!item || !item.isAvailable) { dropped.push(`${label} is no longer on the menu`); continue }
      const wanted = new Set<string>([
        ...pArr<unknown>(l, 'modifierIds').filter((m): m is string => typeof m === 'string'),
        ...pArr<Prefill>(l, 'modifiers').map((m) => pStr(m, 'modifierId', 'id')).filter((m): m is string => !!m),
      ])
      const mods = (item.modifierGroups ?? []).flatMap((g: ModifierGroup) => g.modifiers ?? []).filter((m: Modifier) => wanted.has(m.id))
      lines.push({ item, qty: Math.max(1, Math.round(pNum(l, 'quantity', 'qty') ?? 1)), notes: pStr(l, 'notes') ?? '', mods })
    }
    void (async () => {
      const st = usePosStore.getState()
      if (replace && st.cart.length > 0) {
        const ok = await confirm({ title: 'Replace the current cart with the recovered order?', confirmLabel: 'Replace', danger: true })
        if (!ok) return
      }
      if (replace) st.clearCart()
      const tableId = pStr(p, 'tableId')
      if (replace && tableId) {
        usePosStore.getState().setTableId(tableId)
        usePosStore.getState().setFulfilment('dine_in')
        usePosStore.getState().setTableLabel(pStr(p, 'tableLabel') ?? null)
      }
      const customerId = pStr(p, 'customerId')
      if (replace && customerId) usePosStore.getState().setCustomerId(customerId)
      for (const l of lines) {
        usePosStore.getState().addItem(l.item, l.mods)
        const added = usePosStore.getState().cart.at(-1)
        if (!added) continue
        if (l.qty > 1) usePosStore.getState().updateItemQty(added.id, l.qty)
        if (l.notes) usePosStore.getState().updateItemNotes(added.id, l.notes)
      }
      if (lines.length > 0) setView('order')
      if (dropped.length > 0) setNote(`Recovered with changes: ${dropped.join('; ')}`)
      else if (lines.length > 0) setNote('Recovered from Trash. Check the prices, then send it.')
    })()
  }, [pendingPrefill, concepts, conceptId, menuLoading, categories, confirm])

  // ── Navigation ─────────────────────────────────────────────────────────────
  /** Back to the start of the flow (the board for dine-in, otherwise the start menu). */
  function exitOrder() {
    const dine = usePosStore.getState().fulfilment === 'dine_in'
    usePosStore.getState().clearCart()
    setView(dine ? 'board' : 'home')
  }

  async function discardCartOk(): Promise<boolean> {
    if (usePosStore.getState().cart.length === 0) return true
    const ok = await confirm({ title: 'Leave this order?', body: 'The items on the screen are cleared.', confirmLabel: 'Clear and continue', cancelLabel: 'Keep order', danger: true })
    if (ok) usePosStore.getState().clearCart()
    return !!ok
  }

  async function onStart(a: StartAction) {
    setMenuOpen(false)
    if (a === 'tickets') { setShowTickets('settle'); return }
    if (a === 'no_charge') { setShowTickets('nocharge'); return }
    if (!(await discardCartOk())) return
    const st = usePosStore.getState()
    if (a === 'summary') { st.clearCart(); setView('summary'); return }
    if (a === 'sales_report') { st.clearCart(); setView('sales_report'); return }
    st.clearCart()
    if (a === 'dine_in') { st.setFulfilment('dine_in'); setView('board') }
    else if (a === 'delivery') { st.setFulfilment('delivery'); setView('delivery') }
    else if (a === 'takeaway') { st.setFulfilment('takeout'); setView('order') }
  }

  // A vacant table: start a ticket — Order information first (held until the first Save).
  function onVacant(t: BoardTable) {
    const st = usePosStore.getState()
    st.clearCart()
    st.setFulfilment('dine_in')
    st.setTableId(t.id)
    st.setTableLabel(t.label)
    setInfo({ kind: 'new', title: `Table ${t.label}`, initial: { waiter: null, partySize: null, guest: null } })
  }

  // An occupied table: open its tickets (a later round is another ticket), or — in Waiter Assignment —
  // change the waiter / pax of its oldest ticket.
  async function onOccupied(t: BoardTable, assign: boolean) {
    const o = t.order
    if (assign && o) {
      // Several tickets on the table: the cashier picks which ticket's waiter / pax to change.
      const rows = (openTickets.data ?? []).filter((x) => t.openOrderIds.includes(x.id))
      if (t.openOrderIds.length > 1 && rows.length > 1) { setAssignPick({ label: t.label, tickets: rows }); return }
      await openTicketInfo(o.id, t.label)
      return
    }
    const st = usePosStore.getState()
    st.clearCart()
    st.setFulfilment('dine_in')
    st.setTableId(t.id)
    st.setTableLabel(t.label)
    if (o?.waiter) st.setWaiter({ id: o.waiter.id, code: o.waiter.code, name: o.waiter.name })
    if (o?.partySize) st.setPartySize(o.partySize)
    setView('order')
  }

  async function openTicketInfo(orderId: string, label: string) {
    try {
      const v = await getOrderInfo(orderId)
      setInfo({ kind: 'ticket', orderId, title: `Table ${label} · ${v.orderRef}`, initial: valuesFromInfo(v) })
    } catch (e) { setNote(flowErrorMessage(e, 'Could not load the order information')) }
  }

  function valuesFromInfo(v: OrderInfoView): OrderInfoValues {
    return {
      waiter: v.waiter,
      partySize: v.partySize,
      guest: v.guest ? { customerId: v.guest.id, name: v.guest.name, email: v.guest.email ?? '', mobile: v.guest.mobile ?? '', phone: v.guest.phone ?? '', registrationNo: v.guest.registrationNo ?? '' } : null,
    }
  }

  async function onTicketInfo(t: TillOrder) {
    try {
      const v = await getOrderInfo(t.id)
      setInfo({ kind: 'ticket', orderId: t.id, title: `${t.table?.label ? `Table ${t.table.label} · ` : ''}${v.orderRef}`, initial: valuesFromInfo(v) })
    } catch (e) { setNote(flowErrorMessage(e, 'Could not load the order information')) }
  }

  function onEditInfo() {
    const st = usePosStore.getState()
    if (st.fulfilment === 'delivery') { setView('delivery'); return }
    setInfo({
      kind: 'new',
      title: st.fulfilment === 'dine_in' ? `Table ${st.tableLabel ?? ''}` : 'Takeaway',
      initial: { waiter: st.waiter, partySize: st.partySize, guest: st.guest },
    })
  }

  function infoDone(v: OrderInfoValues) {
    if (!info) return
    if (info.kind === 'new') {
      const st = usePosStore.getState()
      st.setWaiter(v.waiter)
      st.setPartySize(v.partySize)
      st.setGuest(v.guest ?? null)
      st.setCustomerId(v.guest?.customerId ?? null)
      setView('order')
    } else {
      void openTickets.refetch()
      setNote('Order information saved')
    }
    setInfo(null)
  }
  function infoCancel() {
    // Cancelling the panel of a brand-new table before any order screen: back to the board.
    if (info?.kind === 'new' && view === 'board') usePosStore.getState().clearCart()
    setInfo(null)
  }

  /** A ticket was paid or comped: leave the order screen (the board shows what is still open). */
  function afterClosed(paid: boolean) {
    void openTickets.refetch()
    if (paid && view === 'order' && usePosStore.getState().cart.length === 0) exitOrder()
  }

  const showMenuPane = view === 'home'
  return (
    <div className="erp-kitchen-dark flex h-screen h-dvh flex-col overflow-hidden bg-kds-bg">
      {/* Banners */}
      {!isOnline && (
        <div className="flex items-center gap-2 border-b border-kds-amber/40 bg-kds-amber/15 px-3 py-2">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-kds-amber" />
          <span className="flex-1 text-sm font-semibold text-kds-amber">Offline — orders will be queued and synced when connection returns</span>
          {queuedCount > 0 && <span className="text-xs font-bold text-kds-amber">{queuedCount} queued</span>}
        </div>
      )}
      {syncedCount > 0 && (
        <div className="flex items-center gap-2 border-b border-kds-green/30 bg-kds-green/15 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-kds-green"><Check size={16} aria-hidden="true" /> {syncedCount} offline order{syncedCount !== 1 ? 's' : ''} synced</span>
        </div>
      )}
      {!shiftId && (
        <div className="flex items-center justify-between border-b border-kds-red bg-kds-red/20 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-kds-red"><TriangleAlert size={16} aria-hidden="true" /> No shift open — payments will be blocked</span>
          <Link href="/pos/shift" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-kds-red px-4 text-sm font-bold text-white hover:opacity-90">Open Shift <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      )}

      {/* Brand tabs, bank alerts, open tickets */}
      <div className="flex min-h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-kds-border bg-kds-card px-3 scrollbar-hide">
        <span className="shrink-0 text-sm text-kds-subtext">Brand:</span>
        {brandsFailed && <span className="text-sm font-semibold text-kds-red">Could not load your brands — reload, or ask a manager</span>}
        {!brandsFailed && !brandsLoading && concepts.length === 0 && <span className="text-sm text-kds-subtext">No brands in your company yet</span>}
        <div role="tablist" aria-label="Brand" onKeyDown={tabListKeys} className="flex shrink-0 items-center gap-2">
          {concepts.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === conceptId}
              tabIndex={c.id === conceptId ? 0 : -1}
              onClick={async () => {
                if (c.id === conceptId) return
                const st = usePosStore.getState()
                // Another brand's dishes and tables can't go on this ticket: switching brand starts afresh.
                if (st.cart.length > 0) {
                  const ok = await confirm({ title: 'Switch brand?', body: 'Switching brand clears the current order.', confirmLabel: 'Switch and clear', cancelLabel: 'Keep order', danger: true })
                  if (!ok) return
                }
                st.clearCart()
                st.setConceptId(c.id)
                setView('home')
              }}
              className={`min-h-11 shrink-0 rounded-lg px-4 py-1 text-sm font-semibold ${c.id === conceptId ? 'bg-kds-green text-primary-on' : 'text-kds-subtext hover:text-kds-text'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RaastAlerts shiftId={shiftId} brand={activeConcept} tickets={openTickets.data ?? []} isManager={isManager} onBillPaid={onRaastBillPaid} />
          <button type="button" onClick={() => setShowTickets('settle')} disabled={!conceptId}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-kds-border px-3 py-1 text-sm font-semibold text-kds-text hover:border-kds-green disabled:opacity-30">
            Open tickets
            {ticketCount > 0 && <span className="rounded-full bg-kds-amber px-2 text-xs font-black text-black">{ticketCount}</span>}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The start menu: always at the left of the start screen, a drawer everywhere else */}
        {showMenuPane && (
          <div className="w-full shrink-0 border-r border-kds-border lg:w-72">
            <StartMenu onPick={(a) => void onStart(a)} ticketCount={ticketCount} />
          </div>
        )}
        {view === 'home' && (
          <div className="hidden flex-1 items-center justify-center p-8 text-center lg:flex">
            <div>
              <p className="text-2xl font-bold text-kds-text">{activeConcept?.name ?? 'The till'}</p>
              <p className="mt-2 text-kds-subtext">Choose Dine In, Delivery or Takeaway from the menu to start an order.</p>
            </div>
          </div>
        )}

        {view === 'board' && conceptId && (
          <TableBoard conceptId={conceptId} onMenu={() => setMenuOpen(true)} onVacant={onVacant} onOccupied={(t, a) => void onOccupied(t, a)} />
        )}
        {view === 'delivery' && conceptId && (
          <DeliveryForm
            conceptId={conceptId}
            initial={delivery}
            onMenu={() => setMenuOpen(true)}
            onContinue={(d) => { usePosStore.getState().setDelivery(d); setView('order') }}
          />
        )}
        {view === 'order' && conceptId && (
          <OrderScreen
            conceptId={conceptId}
            brand={activeConcept}
            categories={categories}
            menuLoading={menuLoading}
            onMenu={() => setMenuOpen(true)}
            onExit={exitOrder}
            onEditInfo={onEditInfo}
            onTicketInfo={(t) => void onTicketInfo(t)}
            onSettle={setSettle}
            onNoCharge={setNoCharge}
          />
        )}
        {view === 'summary' && (
          <OrderSummary conceptId={conceptId || null} onMenu={() => setMenuOpen(true)}
            onRecall={(t, o) => { setSettleOnSplit(!!o?.split); setSettle(t) }}
            onChangeOwner={(t) => void onTicketInfo(t)} />
        )}
        {view === 'sales_report' && <SalesReport conceptId={conceptId || null} brandName={activeConcept?.name ?? null} onMenu={() => setMenuOpen(true)} />}
      </div>

      {note && (
        <div role="status" className="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-xl border border-kds-amber bg-kds-card px-4 py-3 text-sm font-semibold text-kds-amber shadow-lg">{note}</div>
      )}

      {menuOpen && <MenuDrawer onClose={() => setMenuOpen(false)}><StartMenu onPick={(a) => void onStart(a)} ticketCount={ticketCount} onClose={() => setMenuOpen(false)} /></MenuDrawer>}

      {info && conceptId && (
        <OrderInfoModal
          conceptId={conceptId}
          title={info.title}
          initial={info.initial}
          orderId={info.kind === 'ticket' ? info.orderId : undefined}
          onClose={infoCancel}
          onDone={infoDone}
        />
      )}

      {assignPick && (
        <FlowDialog title="Which ticket?" subtitle={`Table ${assignPick.label} has ${assignPick.tickets.length} open tickets`} onClose={() => setAssignPick(null)} width="max-w-sm">
          <ul className="space-y-2">
            {assignPick.tickets.map((t, i) => (
              <li key={t.id}>
                <button type="button" onClick={() => { const l = assignPick.label; setAssignPick(null); void openTicketInfo(t.id, l) }} className="flex min-h-14 w-full items-center justify-between rounded-lg border border-kds-border px-4 text-left hover:border-kds-green">
                  <span className="font-bold text-kds-text">Ticket {i + 1} · {orderRef(t.id)}<span className="block text-xs font-normal text-kds-subtext">Waiter: {t.waiter?.fullName ?? 'none'}{t.partySize ? ` · ${t.partySize} pax` : ''}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </FlowDialog>
      )}

      {showTickets && (
        <OpenTickets
          brandName={activeConcept?.name}
          tickets={openTickets.data ?? []}
          loading={openTickets.isLoading}
          error={openTickets.error}
          onPick={(ticket) => { const k = showTickets; setShowTickets(false); if (k === 'nocharge') setNoCharge(ticket); else setSettle(ticket) }}
          onClose={() => setShowTickets(false)}
        />
      )}

      {settle && (
        <SettleScreen
          key={settle.id}
          ticket={settle}
          brand={concepts.find((c) => c.id === settle.conceptId) ?? activeConcept}
          startOnSplit={settleOnSplit}
          onClose={(paid) => { setSettle(null); setSettleOnSplit(false); afterClosed(paid) }}
        />
      )}

      {noCharge && shiftId && (
        <NoChargeDialog ticket={noCharge} shiftId={shiftId} onClose={() => setNoCharge(null)} onDone={() => { setNoCharge(null); setNote('No Charge recorded'); afterClosed(true) }} />
      )}
      {noCharge && !shiftId && <NoShiftNotice onClose={() => setNoCharge(null)} />}
    </div>
  )
}

// ─── Start menu drawer (every screen but the start screen) ───────────────────

function MenuDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose })
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Till menu" className="erp-kitchen-dark fixed inset-y-0 left-0 z-50 w-80 max-w-[90vw] border-r border-kds-border bg-kds-card outline-none">{children}</div>
    </>
  )
}

function NoShiftNotice({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose })
  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="no-shift-title" className="w-full max-w-sm space-y-4 rounded-2xl bg-kds-card p-6 text-center outline-none">
        <TriangleAlert size={40} aria-hidden="true" className="mx-auto text-kds-amber" />
        <h2 id="no-shift-title" className="text-lg font-bold text-kds-text">No Shift Open</h2>
        <p className="text-sm text-kds-subtext">You need to open a shift before No Charge.</p>
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext">Cancel</button>
          <Link href="/pos/shift" className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-kds-green py-3 text-center font-bold text-primary-on">Open Shift</Link>
        </div>
      </div>
    </div>
  )
}
