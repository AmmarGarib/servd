'use client'
import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, ShoppingCart, TriangleAlert, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, menuApi, type Category, type MenuItem, type ModifierGroup, type Modifier } from '../../lib/api'
import { usePosStore } from '../../store/pos'
import { PosCart } from '../../components/pos/PosCart'
import { PaymentModal } from '../../components/pos/PaymentModal'
import { OpenTickets } from '../../components/pos/OpenTickets'
import { RaastAlerts } from '../../components/pos/RaastAlerts'
import { useIsManager } from '../../components/pos/managerRole'
import { useOpenTickets, type TillBrand, type TillOrder } from '../../components/pos/tillApi'
import { requestSync, listenForSync, getQueuedOrders } from '../../lib/offline-queue'
import Link from 'next/link'
import { useCurrentShift } from '../../hooks/useCurrentShift'
import { useDialog } from '../../components/ui/Modal'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { fmtPkrWhole } from '../../lib/money'
import { useTrashPrefill } from '../../lib/trash'
import { unwrapPrefill, pStr, pNum, pArr, pWarnings, type Prefill } from '../../lib/trashPrefill'

/** Arrow / Home / End move between the tabs of a tablist. `activate` also selects the tab
 *  (categories); brand tabs only move focus, because selecting one can clear the order. */
function tabListKeys(e: KeyboardEvent<HTMLElement>, activate: boolean) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i < 0 || tabs.length === 0) return
  e.preventDefault()
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[n]!.focus()
  if (activate) tabs[n]!.click()
}

export default function PosPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null)
  // The payment step: the cart (ticket undefined) or an open ticket (FOH-20).
  const [payment, setPayment] = useState<{ ticket?: TillOrder } | null>(null)
  const [showTickets, setShowTickets] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [queuedCount, setQueuedCount] = useState(0)
  const [syncedCount, setSyncedCount] = useState(0)
  const [soldOutNote, setSoldOutNote] = useState<string | null>(null)
  const confirm = useConfirm()

  useEffect(() => {
    // Register SW
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }

    setIsOnline(navigator.onLine)
    const handleOnline = () => {
      setIsOnline(true)
      requestSync()
    }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Check initial queue size
    getQueuedOrders().then(orders => setQueuedCount(orders.length)).catch(() => {})

    // Listen for sync completion
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
  const addItem = usePosStore((s) => s.addItem)
  const storedConceptId = usePosStore((s) => s.conceptId)
  const shiftId = usePosStore((s) => s.shiftId)
  // The server, not this browser, says which drawer this user is on.
  useCurrentShift()
  const cartCount = usePosStore((s) => s.cart.reduce((n, i) => n + i.quantity, 0))

  // The brands this user may ring — the company's active brands, scoped by
  // the server (FOH-01: till roles read GET /concepts with narrow fields).
  const { data: concepts = [], isError: brandsFailed, isLoading: brandsLoading } = useQuery({
    queryKey: ['pos', 'brands'],
    queryFn: () => api.get<TillBrand[]>('/concepts'),
  })

  // The remembered brand only if it is still one of ours (another company's
  // brand left in this browser is ignored), else the first brand.
  const conceptId = (storedConceptId && concepts.some((c) => c.id === storedConceptId))
    ? storedConceptId
    : concepts[0]?.id ?? ''

  // UI-03: the brand shown is the brand rung — store the auto-selected one so
  // every screen of the till (cart, payment, waiter) works from the same id
  // without the cashier having to tap the tab first.
  useEffect(() => {
    if (conceptId && conceptId !== storedConceptId) usePosStore.getState().setConceptId(conceptId)
  }, [conceptId, storedConceptId])

  const openTickets = useOpenTickets(conceptId || null)
  const ticketCount = openTickets.data?.length ?? 0
  // Raast QR bank alerts (transfers no bill claimed on its own): managers
  // approve "Not a sale" / "Fix a typed reference" with their own session.
  const isManager = useIsManager()
  const refetchTickets = openTickets.refetch
  const onRaastBillPaid = useCallback(() => { void refetchTickets() }, [refetchTickets])

  const { data: categories = [], isLoading: menuLoading } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })

  // No tax maths on this page (FOH-02): the cart, the ring-up and the
  // payment step show and charge the bill the SERVER prices.
  const activeConcept = concepts.find((c) => c.id === conceptId)

  const currentCategory = categories.find((c) => c.id === selectedCategory) ?? categories[0]

  // "Recover as copy" from the Trash (types `order` and `order_item`): the
  // payload carries the brand, table, customer and lines of the original and
  // NOTHING money-side (no payments, discounts or numbers). The lines are
  // re-priced here from today's menu; a dish that is gone or sold out is
  // dropped with a note. The till has no add-to-ticket route, so a recovered
  // voided line goes into the cart as a new ring-up (it is never reapplied
  // to the old ticket).
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
    // order: lines in `items`/`lines`; order_item: the line itself or `item`/`items`.
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
      if (replace && tableId) usePosStore.getState().setTableId(tableId)
      const customerId = pStr(p, 'customerId')
      if (replace && customerId) usePosStore.getState().setCustomerId(customerId)
      for (const l of lines) {
        usePosStore.getState().addItem(l.item, l.mods)
        const added = usePosStore.getState().cart.at(-1)
        if (!added) continue
        if (l.qty > 1) usePosStore.getState().updateItemQty(added.id, l.qty)
        if (l.notes) usePosStore.getState().updateItemNotes(added.id, l.notes)
      }
      if (dropped.length > 0) setSoldOutNote(`Recovered with changes: ${dropped.join('; ')}`)
      else if (lines.length > 0) setSoldOutNote('Recovered from Trash. Check the prices, then ring it up.')
    })()
  }, [pendingPrefill, concepts, conceptId, menuLoading, categories, confirm])

  useEffect(() => {
    if (!soldOutNote) return
    const t = setTimeout(() => setSoldOutNote(null), 3000)
    return () => clearTimeout(t)
  }, [soldOutNote])

  function handleItemTap(item: MenuItem) {
    if (!item.isAvailable) { setSoldOutNote(`${item.name} is sold out`); return }
    // ANY modifier group opens the sheet — optional extras are sold too.
    // Add to order works with zero picks when every group is optional.
    const hasModifiers = item.modifierGroups?.some((g: ModifierGroup) => g.isRequired || (g.modifiers?.length ?? 0) > 0)
    if (hasModifiers) {
      setModifierItem(item)
    } else {
      addItem(item, [])
    }
  }

  return (
    <div className="erp-kitchen-dark flex h-screen h-dvh overflow-hidden bg-kds-bg">

      {/* Mobile cart drawer (mounted only while open: one cart in the DOM at a time) */}
      {cartOpen && (
        <CartDrawer onClose={() => setCartOpen(false)}>
          <PosCart conceptId={conceptId || null} onClose={() => setCartOpen(false)}
            onCheckout={() => { setCartOpen(false); setPayment({}) }} />
        </CartDrawer>
      )}

      {/* Mobile cart FAB */}
      {cartCount > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed bottom-5 right-5 z-40 lg:hidden flex items-center gap-2 rounded-2xl px-5 py-3 font-bold text-sm text-primary-on shadow-lg active:scale-95 transition-transform"
          style={{ background: 'var(--erp-primary)', boxShadow: '0 4px 20px rgb(var(--erp-primary-rgb) / 0.4)' }}>
          <ShoppingCart size={18} aria-hidden="true" />
          <span>{cartCount} item{cartCount !== 1 ? 's' : ''}</span>
        </button>
      )}

      {/* Left — menu browser */}
      <div className="flex flex-1 flex-col">
        {/* Offline banner */}
        {!isOnline && (
          <div className="flex items-center gap-2 bg-kds-amber/15 border-b border-kds-amber/40 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-kds-amber shrink-0 animate-pulse" />
            <span className="text-sm font-semibold text-kds-amber flex-1">Offline — orders will be queued and synced when connection returns</span>
            {queuedCount > 0 && <span className="text-xs text-kds-amber font-bold">{queuedCount} queued</span>}
          </div>
        )}
        {/* Sync success banner */}
        {syncedCount > 0 && (
          <div className="flex items-center gap-2 bg-kds-green/15 border-b border-kds-green/30 px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-kds-green"><Check size={16} aria-hidden="true" /> {syncedCount} offline order{syncedCount !== 1 ? 's' : ''} synced</span>
          </div>
        )}
        {/* Shift warning banner */}
        {!shiftId && (
          <div className="flex items-center justify-between bg-kds-red/20 border-b border-kds-red px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-kds-red"><TriangleAlert size={16} aria-hidden="true" /> No shift open — payments will be blocked</span>
            <Link href="/pos/shift" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-kds-red px-4 text-sm font-bold text-white hover:opacity-90">
              Open Shift <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        )}

        {/* Brand selector */}
        <div className="flex min-h-12 items-center gap-2 overflow-x-auto border-b border-kds-border bg-kds-card px-3 scrollbar-hide">
          <Link href="/w" className="mr-2 inline-flex min-h-11 shrink-0 items-center gap-1 text-sm text-kds-subtext hover:text-kds-text"><ArrowLeft size={16} aria-hidden="true" /> Back</Link>
          <span className="text-sm text-kds-subtext shrink-0">Brand:</span>
          {brandsFailed && <span className="text-sm font-semibold text-kds-red">Could not load your brands — reload, or ask a manager</span>}
          {!brandsFailed && !brandsLoading && concepts.length === 0 && <span className="text-sm text-kds-subtext">No brands in your company yet</span>}
          <div role="tablist" aria-label="Brand" onKeyDown={(e) => tabListKeys(e, false)} className="flex shrink-0 items-center gap-2">
            {concepts.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={c.id === conceptId}
                tabIndex={c.id === conceptId ? 0 : -1}
                onClick={async () => {
                  const st = usePosStore.getState()
                  // Another brand's dishes can't go on this brand's ticket (the
                  // server refuses them): switching brand starts a fresh order.
                  if (c.id !== conceptId && st.cart.length > 0) {
                    const ok = await confirm({
                      title: 'Switch brand?',
                      body: 'Switching brand clears the current order.',
                      confirmLabel: 'Switch and clear', cancelLabel: 'Keep order', danger: true,
                    })
                    if (!ok) return
                    st.clearCart()
                  }
                  st.setConceptId(c.id)
                  setSelectedCategory(null)
                }}
                className={`min-h-11 shrink-0 rounded-lg px-4 py-1 text-sm font-semibold ${
                  c.id === conceptId
                    ? 'bg-kds-green text-primary-on'
                    : 'text-kds-subtext hover:text-kds-text'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
          {/* Raast QR: bank transfers no bill claimed on its own (shown only when there are some) */}
          <div className="ml-auto flex shrink-0 items-center">
            <RaastAlerts
              shiftId={shiftId}
              brand={activeConcept}
              tickets={openTickets.data ?? []}
              isManager={isManager}
              onBillPaid={onRaastBillPaid}
            />
          </div>
          {/* FOH-20: tables a waiter sent, paid here in one go */}
          <button
            onClick={() => setShowTickets(true)}
            disabled={!conceptId}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-kds-border px-3 py-1 text-sm font-semibold text-kds-text hover:border-kds-green disabled:opacity-30"
          >
            Open tickets
            {ticketCount > 0 && (
              <span className="rounded-full bg-kds-amber px-2 text-xs font-black text-black">{ticketCount}</span>
            )}
          </button>
        </div>

        {/* Category tabs */}
        <div role="tablist" aria-label="Menu category" onKeyDown={(e) => tabListKeys(e, true)}
          className="flex gap-1 overflow-x-auto border-b border-kds-border bg-kds-card px-3 py-2 scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat.id}
              role="tab"
              aria-selected={cat.id === (selectedCategory ?? categories[0]?.id)}
              tabIndex={cat.id === (selectedCategory ?? categories[0]?.id) ? 0 : -1}
              onClick={() => setSelectedCategory(cat.id)}
              className={`min-h-11 shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                cat.id === (selectedCategory ?? categories[0]?.id)
                  ? 'bg-kds-green text-primary-on'
                  : 'text-kds-subtext hover:bg-kds-border hover:text-kds-text'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Menu items grid */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
            {menuLoading && !!conceptId && Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton min-h-[80px]" aria-hidden
                style={{
                  backgroundColor: 'rgb(var(--fg-rgb) / 0.06)',
                  backgroundImage: 'linear-gradient(90deg, rgb(var(--fg-rgb) / 0.06) 25%, rgb(var(--fg-rgb) / 0.12) 50%, rgb(var(--fg-rgb) / 0.06) 75%)',
                  backgroundSize: '200% 100%',
                }} />
            ))}
            {currentCategory?.items.map((item) => (
              <button
                key={item.id}
                onClick={() => handleItemTap(item)}
                aria-disabled={!item.isAvailable}
                className={`flex min-h-[80px] flex-col items-start rounded-lg border p-3 text-left transition-all active:scale-95 ${
                  item.isAvailable
                    ? 'border-kds-border bg-kds-card hover:border-kds-green'
                    : 'border-kds-border bg-kds-border/30 opacity-40'
                }`}
              >
                {item.imageUrl && (
                  <img src={item.imageUrl} alt={item.name} className="mb-2 h-12 w-full rounded object-cover" />
                )}
                <span className="font-semibold text-kds-text leading-tight">{item.name}</span>
                <span className="mt-auto pt-1 text-sm text-kds-green font-bold">
                  PKR {(item.priceCents / 100).toFixed(0)}
                </span>
                {!item.isAvailable && (
                  <span className="mt-1 text-xs font-bold text-kds-red">86'd</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right — cart side-rail (landscape tablet / desktop only; portrait uses the drawer) */}
      <div className="hidden lg:flex w-80 flex-col border-l border-kds-border bg-kds-card">
        <PosCart conceptId={conceptId || null} onCheckout={() => setPayment({})} />
      </div>

      {soldOutNote && (
        <div role="status" className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-xl border border-kds-amber bg-kds-card px-4 py-3 text-sm font-semibold text-kds-amber shadow-lg">
          {soldOutNote}
        </div>
      )}

      {/* Modifier modal */}
      {modifierItem && (
        <ModifierModal
          item={modifierItem}
          onConfirm={(mods) => { addItem(modifierItem, mods); setModifierItem(null) }}
          onClose={() => setModifierItem(null)}
        />
      )}

      {/* Open tickets */}
      {showTickets && (
        <OpenTickets
          brandName={activeConcept?.name}
          tickets={openTickets.data ?? []}
          loading={openTickets.isLoading}
          error={openTickets.error}
          onPick={(ticket) => { setShowTickets(false); setPayment({ ticket }) }}
          onClose={() => setShowTickets(false)}
        />
      )}

      {/* Payment — the cart, or an open ticket */}
      {payment && (
        <PaymentModal
          key={payment.ticket?.id ?? 'cart'}
          brand={payment.ticket ? concepts.find((c) => c.id === payment.ticket!.conceptId) : activeConcept}
          ticket={payment.ticket}
          onClose={() => { setPayment(null); void openTickets.refetch() }}
        />
      )}
    </div>
  )
}

// ─── Mobile cart drawer ─────────────────────────────────────────────────────
// Mounted only while open, so the page holds one cart at a time. PosCart draws
// the header (and the close button when it is given onClose).

function CartDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useDialog(panelRef, { onClose })
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    // The drawer is the phone layout; on a wide screen the side rail takes over.
    const mq = window.matchMedia('(min-width: 1024px)')
    const wide = () => { if (mq.matches) onClose() }
    mq.addEventListener('change', wide)
    return () => { cancelAnimationFrame(raf); mq.removeEventListener('change', wide) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Current order"
        className={`fixed inset-x-0 bottom-0 z-50 flex flex-col bg-kds-card outline-none transition-transform duration-300 motion-reduce:transition-none lg:hidden ${shown ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ maxHeight: '85dvh', borderTop: '1px solid rgb(var(--fg-rgb) / 0.08)', borderRadius: '16px 16px 0 0', overscrollBehavior: 'contain' }}>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  )
}

// ─── Modifier Modal ─────────────────────────────────────────────────────────

function ModifierModal({
  item,
  onConfirm,
  onClose,
}: {
  item: MenuItem
  onConfirm: (mods: Modifier[]) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose })
  // F14: track selections per-group so we can enforce minSelect/maxSelect.
  // A flat selected set wasn't enough to tell "0 from required group" apart
  // from "5 from a max-3 group" — the new structure makes both visible.
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, Set<string>>>({})

  function toggle(groupId: string, modId: string, maxSelect: number) {
    setSelectedByGroup((prev) => {
      const current = new Set(prev[groupId] ?? [])
      if (current.has(modId)) {
        current.delete(modId)
      } else {
        // If adding would exceed maxSelect, drop the oldest pick first so
        // single-select groups (max=1) behave like radio buttons naturally.
        if (current.size >= maxSelect && maxSelect > 0) {
          if (maxSelect === 1) current.clear()
          else {
            const oldest = current.values().next().value
            if (oldest) current.delete(oldest)
          }
        }
        current.add(modId)
      }
      return { ...prev, [groupId]: current }
    })
  }

  // A REQUIRED group needs at least minSelect (1 if unset) picks; an optional
  // group needs none, so Add to order works with zero picks. Compute a friendly
  // message and a disabled state for the confirm button.
  const groupErrors: Record<string, string | null> = {}
  let canConfirm = true
  for (const g of item.modifierGroups ?? []) {
    const picked = selectedByGroup[g.id]?.size ?? 0
    const min = g.isRequired ? Math.max(g.minSelect ?? 0, 1) : 0
    const max = g.maxSelect ?? Infinity
    if (picked < min) {
      groupErrors[g.id] = min === 1 ? 'Please choose 1' : `Please choose at least ${min}`
      canConfirm = false
    } else if (picked > max) {
      groupErrors[g.id] = `Choose at most ${max}`
      canConfirm = false
    } else {
      groupErrors[g.id] = null
    }
  }

  const allMods = item.modifierGroups.flatMap((g: ModifierGroup) => g.modifiers)
  const pickedIds = new Set<string>()
  for (const set of Object.values(selectedByGroup)) for (const id of set) pickedIds.add(id)
  const pickedMods = allMods.filter((m: Modifier) => pickedIds.has(m.id))
  // The same figure the cart shows: unit price + each picked modifier's delta.
  const runningTotalCents = item.priceCents + pickedMods.reduce((s: number, m: Modifier) => s + m.priceDeltaCents, 0)

  function confirm() {
    if (!canConfirm) return
    onConfirm(pickedMods)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="modifier-modal-title"
        className="flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-2xl bg-kds-card outline-none sm:rounded-2xl"
        style={{ overscrollBehavior: 'contain' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-kds-border pl-5 pr-1">
          <h2 id="modifier-modal-title" className="py-3 text-lg font-bold text-kds-text">{item.name} — Options</h2>
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4" style={{ overscrollBehavior: 'contain' }}>
          {item.modifierGroups.map((group: ModifierGroup) => {
            const picked = selectedByGroup[group.id]
            const max = group.maxSelect ?? Infinity
            const err = groupErrors[group.id]
            return (
              <div key={group.id} className="mb-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-kds-subtext">
                    {group.name}
                    {group.isRequired && <span className="ml-1 text-kds-red">*</span>}
                  </p>
                  {(group.minSelect > 0 || group.maxSelect < 99) && (
                    <p className="text-[10px] uppercase tracking-wider text-kds-subtext">
                      {group.minSelect === group.maxSelect
                        ? `pick ${group.minSelect}`
                        : `${group.minSelect}–${group.maxSelect}`}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {group.modifiers.map((mod: Modifier) => {
                    const isOn = picked?.has(mod.id) ?? false
                    return (
                      <button
                        key={mod.id}
                        type="button"
                        aria-pressed={isOn}
                        onClick={() => toggle(group.id, mod.id, max)}
                        className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          isOn
                            ? 'border-kds-green bg-kds-green/20 text-kds-green'
                            : 'border-kds-border text-kds-text hover:border-kds-subtext'
                        }`}
                      >
                        <span>{mod.name}</span>
                        {mod.priceDeltaCents !== 0 && (
                          <span className="ml-1 text-kds-subtext">
                            +{fmtPkrWhole(mod.priceDeltaCents)}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {err && (
                  <p className="mt-1 text-xs font-semibold text-kds-amber">{err}</p>
                )}
              </div>
            )
          })}
        </div>

        <div className="sticky bottom-0 flex shrink-0 gap-3 border-t border-kds-border bg-kds-card px-5 py-3">
          <button type="button" onClick={onClose} className="kds-btn-ghost flex-1 min-h-11 py-3">
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={!canConfirm}
            className="kds-btn-primary flex-1 py-3 disabled:cursor-not-allowed disabled:opacity-40">
            Add to order · {fmtPkrWhole(runningTotalCents)}
          </button>
        </div>
      </div>
    </div>
  )
}
