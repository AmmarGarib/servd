'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Check, Minus, Play, Plus, Timer, TriangleAlert, X } from 'lucide-react'
import { FulfilmentIcon } from '../../../components/kds/FulfilmentIcon'
import { api, ApiError } from '../../../lib/api'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { getSocket } from '../../../lib/socket'
import { useKdsStore } from '../../../store/kds'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'
import { useLineActions, LineStateBadge, HoldButton, RecallStrip } from '../../../components/kds/LineActions'

// Recipe payload — matches /recipes/by-item/:menuItemId.
// Used by the order pop-up to show the dish's full recipe for a line with no
// recipe steps of its own.
interface RecipeData {
  steps:        string | null   // free-text English
  stepsUrdu:    string | null   // free-text Urdu
  notes:        string | null
  servings:     number
  laborMinutes: number
  ingredients:  Array<{ id: string; name: string; quantity: number; unit: string }>
  recipeSteps?: Array<{
    id: string; phase: string; ordinal: number
    instruction: string; instructionUrdu: string | null
    estimatedSeconds: number
    stationName: string | null
  }>
  menuItem?: { name: string; imageUrl: string | null }
}

/**
 * Station screen (owner B12, 2026-10-26) — the cook's tablet.
 *
 * "Their screen should probs show them 4-6 orders at a time. They can either
 * key in to order button to get quick popup of instructions or complete order
 * from memory and press tick … start timer … multiple timers … Timer going
 * off should just make the order card blink red.. no noise."
 *
 * Reads GET /expo/station/:id/board (modules/expo/kitchenBoard.ts): at most
 * the station's `visibleCards` (4–6) ORDER cards, oldest first; the rest wait
 * in a queue the cook does not see (only a count). On a card:
 *   • tap the card → the order pop-up: each dish's step instructions (English
 *     and Urdu), timers per dish, Hold / Resume for a line;
 *   • Start → startedAt (the expo is alerted when a shown card is not started
 *     within a minute);
 *   • the tick → every dish of the order at this station is done; a recipe
 *     step's next station gets the order (the cascade).
 * Timers live on the server (started at + duration): a refresh or another
 * tablet shows them. A finished timer makes its card blink red. No sound.
 */

type FulfilmentType = 'dine_in' | 'takeout' | 'delivery'

const FULFILMENT_META: Record<FulfilmentType, { short: string; text: string; badge: string; card: string }> = {
  dine_in:  { short: 'PLATE',    text: 'text-kds-green',     badge: 'bg-kds-green/10 border-kds-green/30',         card: 'border-kds-green/35' },
  takeout:  { short: 'PACK',     text: 'text-kds-amber',     badge: 'bg-kds-amber/10 border-kds-amber/30',         card: 'border-kds-amber/35' },
  delivery: { short: 'PACK+LBL', text: 'text-source-manual', badge: 'bg-source-manual/10 border-source-manual/30', card: 'border-source-manual/35' },
}
const CHANNEL_LABEL: Record<string, string> = { pos: 'Till', servd: 'Online', whatsapp: 'WhatsApp', manual: 'Phone', reservation: 'Booking' }

interface BoardEntry {
  kind: 'step' | 'line'
  id: string
  itemId: string
  menuItemId: string | null
  itemName: string
  qty: number
  notes: string | null
  modifiers: string[]
  status: string
  firedAt: string | null
  startedAt: string | null
  instruction: string | null
  instructionUrdu: string | null
  estimatedSeconds: number | null
}
interface BoardCard {
  order: {
    id: string; ref: string; brand: string; channel: string; fulfilmentType: FulfilmentType
    tableLabel: string | null; customerName: string | null; placedAt: string
  }
  firedAt: string
  started: boolean
  held: boolean
  unstarted: boolean
  entries: BoardEntry[]
}
interface KitchenTimer {
  id: string; orderId: string; orderItemId: string; orderItemStepId: string | null
  label: string; durationSeconds: number; startedAt: string; endsAt: string
}
interface Board {
  station: { id: string; name: string; brand: string; visibleCards: number }
  visible: BoardCard[]
  queuedCount: number
  onDeck: Array<{ stepId: string; itemName: string; qty: number; instruction: string; order: { id: string; ref: string } }>
  timers: KitchenTimer[]
  serverNow: string
}

const DEFAULT_LINE_TIMER = 120

/** mm:ss (negative = over by). */
function clock(seconds: number): string {
  const s = Math.abs(Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${seconds < 0 ? '+' : ''}${m}:${String(s % 60).padStart(2, '0')}`
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return (e as Error)?.message ?? 'Something went wrong'
}

export default function StationKdsPage() {
  const { station } = useParams<{ station: string }>()
  const qc = useQueryClient()
  useKdsSocket({ stationId: station, role: 'kitchen' })
  const lang = useKdsStore((s) => s.lang)
  const showImages = useKdsStore((s) => s.showImages)
  const isUrdu = lang === 'ur'

  // ONE interval ticks every age / countdown once a second.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const boardKey = ['station-queue', station, 'board']
  const { data, isLoading, isError, error } = useQuery<Board>({
    queryKey: boardKey,
    queryFn: () => api.get<Board>(`/expo/station/${station}/board`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
  // Server clock offset, so a timer reads the same on every tablet.
  const offsetMs = useMemo(() => (data ? new Date(data.serverNow).getTime() - Date.now() : 0), [data])
  const serverNow = nowMs + offsetMs

  const refresh = () => qc.invalidateQueries({ queryKey: ['station-queue', station] })
  const [actionError, setActionError] = useState<string | null>(null)
  const onErr = (e: unknown) => setActionError(errorText(e))
  const onOk = () => { setActionError(null); refresh() }

  const start = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/station/${station}/cards/${orderId}/start`, {}),
    onSuccess: onOk, onError: onErr,
  })
  const done = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/station/${station}/cards/${orderId}/done`, {}),
    onSuccess: () => { onOk(); qc.invalidateQueries({ queryKey: ['station-recent-bumped', station] }) },
    onError: onErr,
  })
  const startTimer = useMutation({
    mutationFn: (v: { entryId: string; durationSeconds: number; label?: string }) =>
      api.post('/expo/kitchen-timers', { stationId: station, ...v }),
    onSuccess: onOk, onError: onErr,
  })
  const adjustTimer = useMutation({
    mutationFn: (v: { id: string; addSeconds: number }) => api.patch(`/expo/kitchen-timers/${v.id}`, { addSeconds: v.addSeconds }),
    onSuccess: onOk, onError: onErr,
  })
  const stopTimer = useMutation({
    mutationFn: (id: string) => api.post(`/expo/kitchen-timers/${id}/stop`, {}),
    onSuccess: onOk, onError: onErr,
  })
  const lineActions = useLineActions(station)

  // Refresh the moment a line is fired / moved / timed for this station.
  useEffect(() => {
    const socket = getSocket()
    const onEvent = (d?: { stationId?: string | null }) => {
      if (d?.stationId && d.stationId !== station) return
      qc.invalidateQueries({ queryKey: ['station-queue', station] })
    }
    socket.on('item:updated', onEvent)
    socket.on('expo:fire', onEvent)
    return () => {
      socket.off('item:updated', onEvent)
      socket.off('expo:fire', onEvent)
    }
  }, [station, qc])

  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const cards = data?.visible ?? []
  const timers = data?.timers ?? []
  const openCard = cards.find((c) => c.order.id === openOrderId) ?? null
  // The card left the screen (done elsewhere) → close its pop-up.
  useEffect(() => { if (openOrderId && data && !openCard) setOpenOrderId(null) }, [openOrderId, data, openCard])

  const timersOf = (orderId: string) => timers.filter((t) => t.orderId === orderId)
  const remaining = (t: KitchenTimer) => (new Date(t.endsAt).getTime() - serverNow) / 1000
  const limit = data?.station.visibleCards ?? 5

  return (
    <div className="erp-kitchen-dark flex min-h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <div className="shrink-0 px-4 pt-3 pb-1 flex items-center justify-between gap-3 flex-wrap">
        <Link href="/expo" className="min-h-11 text-sm text-kds-subtext hover:text-kds-text flex items-center gap-1.5 transition-colors">
          <ArrowLeft size={16} aria-hidden="true" /> Expo
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {(data?.queuedCount ?? 0) > 0 && (
            <span className="text-xs font-bold rounded-full px-2.5 py-1 bg-kds-amber/15 text-kds-amber">
              {data!.queuedCount} more waiting
            </span>
          )}
          {(data?.onDeck.length ?? 0) > 0 && (
            <span className="text-xs font-bold rounded-full px-2.5 py-1 bg-kds-blue/10 text-kds-blue">
              {data!.onDeck.length} on deck
            </span>
          )}
        </div>
      </div>
      <KdsHeader title={data?.station.name ?? 'Station'} stationId={station} count={cards.length} />

      <div className="flex-1 p-3 sm:p-4 space-y-5">
        {(actionError || lineActions.error) && (
          <p role="alert" className="rounded-lg border border-kds-red/50 bg-kds-red/10 px-3 py-2 text-sm font-semibold text-kds-red">
            {actionError ?? lineActions.error}
          </p>
        )}
        {isError && (
          <p role="alert" className="rounded-lg border border-kds-red/50 bg-kds-red/10 px-3 py-2 text-sm font-semibold text-kds-red">
            Could not load this station: {errorText(error)}
          </p>
        )}
        {isLoading && <p className="text-sm text-kds-subtext">Loading…</p>}
        {!isLoading && !isError && cards.length === 0 && (
          <div className="rounded-2xl p-10 text-center border border-kds-border bg-kds-card/40">
            <Check size={36} aria-hidden="true" className="mx-auto mb-2 text-kds-green" />
            <p className="text-base font-bold text-kds-text">All clear</p>
            <p className="text-xs text-kds-subtext mt-1">New orders appear here when expo fires them.</p>
          </div>
        )}

        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => {
            const fm = FULFILMENT_META[c.order.fulfilmentType] ?? FULFILMENT_META.dine_in
            const cardTimers = timersOf(c.order.id)
            const rang = cardTimers.some((t) => remaining(t) <= 0)
            const ageSec = (serverNow - new Date(c.firedAt).getTime()) / 1000
            const busy = (done.isPending && done.variables === c.order.id) || (start.isPending && start.variables === c.order.id)
            return (
              <article key={c.order.id}
                className={`rounded-2xl relative flex flex-col border-2 bg-kds-card ${rang ? 'border-kds-red bg-kds-red/20 animate-pulse' : c.unstarted ? 'border-kds-amber' : fm.card}`}
                aria-label={`Order ${c.order.ref}${rang ? ', timer finished' : ''}`}>
                <button type="button" onClick={() => setOpenOrderId(c.order.id)}
                  className="w-full text-left p-3 sm:p-4 flex-1 hover:bg-white/[0.03] transition-colors rounded-t-2xl">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-2xl font-black text-kds-text leading-none tracking-wide">#{c.order.ref}</p>
                      <p className="text-xs text-kds-subtext mt-1 truncate">
                        {c.order.brand} · {CHANNEL_LABEL[c.order.channel] ?? c.order.channel}
                        {c.order.customerName ? ` · ${c.order.customerName}` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-lg font-black tabular-nums ${ageSec > 600 ? 'text-kds-red' : 'text-kds-amber'}`}>{clock(ageSec)}</p>
                      <span className={`inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-md text-[11px] font-black uppercase tracking-wider border ${fm.badge} ${fm.text}`}>
                        <FulfilmentIcon type={c.order.fulfilmentType} size={11} /> {fm.short}
                        {c.order.tableLabel && <span className="opacity-80">· {c.order.tableLabel}</span>}
                      </span>
                    </div>
                  </div>

                  <ul className="mt-3 space-y-2">
                    {c.entries.map((e) => (
                      <li key={e.id} className="leading-tight">
                        <LineStateBadge status={e.status} small />
                        <p className={`text-base font-black text-kds-text ${e.status === 'held' ? 'opacity-60' : ''}`}>
                          {e.qty > 1 && <span className="text-kds-amber mr-1">{e.qty}×</span>}{e.itemName}
                        </p>
                        {e.modifiers.length > 0 && <p className="text-xs text-kds-subtext">{e.modifiers.join(', ')}</p>}
                        {e.notes && (
                          <p className="text-xs italic text-kds-amber">
                            <TriangleAlert size={11} aria-hidden="true" className="inline-block align-[-1px] mr-1" />{e.notes}
                          </p>
                        )}
                        {e.instruction && (
                          <p className="text-xs font-semibold text-kds-green mt-0.5 line-clamp-2" dir={isUrdu && e.instructionUrdu ? 'rtl' : 'ltr'}>
                            {isUrdu && e.instructionUrdu ? e.instructionUrdu : e.instruction}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>

                  {cardTimers.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {cardTimers.map((t) => {
                        const r = remaining(t)
                        return (
                          <span key={t.id} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-black tabular-nums ${r <= 0 ? 'bg-kds-red text-kds-text' : 'bg-white/10 text-kds-text'}`}>
                            <Timer size={12} aria-hidden="true" />
                            <span className="max-w-[7rem] truncate font-semibold">{t.label}</span> {r <= 0 ? 'Done' : clock(r)}
                          </span>
                        )
                      })}
                    </div>
                  )}
                  {c.unstarted && !rang && <p className="mt-2 text-xs font-black uppercase tracking-wider text-kds-amber">Not started</p>}
                </button>

                <div className="p-3 sm:p-4 pt-0 flex gap-2">
                  {!c.started && !c.held && (
                    <button type="button" onClick={() => start.mutate(c.order.id)} disabled={busy}
                      className="flex-1 min-h-12 rounded-xl text-sm font-black bg-white/10 text-kds-text inline-flex items-center justify-center gap-1.5 disabled:opacity-40">
                      <Play size={16} aria-hidden="true" /> Start
                    </button>
                  )}
                  {!c.held && (
                    <button type="button" onClick={() => done.mutate(c.order.id)} disabled={busy}
                      aria-label={`Order ${c.order.ref} done`}
                      className="flex-1 min-h-12 rounded-xl text-base font-black bg-kds-green text-primary-on inline-flex items-center justify-center gap-1.5 disabled:opacity-40">
                      <Check size={20} aria-hidden="true" /> {busy && done.isPending ? 'Sending…' : 'Done'}
                    </button>
                  )}
                  {c.held && <p className="flex-1 text-center text-xs text-kds-subtext py-3">On hold — open the order to resume</p>}
                </div>
              </article>
            )
          })}
        </div>

        {(data?.queuedCount ?? 0) > 0 && (
          <p className="text-center text-sm font-semibold text-kds-subtext">
            {data!.queuedCount} more {data!.queuedCount === 1 ? 'order is' : 'orders are'} waiting — each appears when a card above is done.
          </p>
        )}

        <RecallStrip stationId={station} actions={lineActions} />

        {(data?.onDeck.length ?? 0) > 0 && (
          <section>
            <p className="text-xs uppercase tracking-[0.2em] font-black text-kds-subtext mb-2">
              On deck — waiting on another station ({data!.onDeck.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {data!.onDeck.map((d) => (
                <span key={d.stepId} className="rounded-xl border border-dashed border-kds-border bg-kds-card/40 px-3 py-2 text-sm text-kds-subtext">
                  #{d.order.ref} · {d.qty > 1 ? `${d.qty}× ` : ''}{d.itemName}
                </span>
              ))}
            </div>
          </section>
        )}

        <p className="text-center text-xs text-kds-subtext pt-1">
          Shows {limit} orders at a time · updates live
        </p>
      </div>

      {openCard && (
        <OrderPopup
          card={openCard}
          timers={timersOf(openCard.order.id)}
          remaining={remaining}
          isUrdu={isUrdu}
          showImages={showImages}
          onClose={() => setOpenOrderId(null)}
          onStart={() => start.mutate(openCard.order.id)}
          onDone={() => { done.mutate(openCard.order.id); setOpenOrderId(null) }}
          onStartTimer={(entryId, durationSeconds, label) => startTimer.mutate({ entryId, durationSeconds, label })}
          onAdjust={(id, addSeconds) => adjustTimer.mutate({ id, addSeconds })}
          onStop={(id) => stopTimer.mutate(id)}
          lineActions={lineActions}
          busy={start.isPending || done.isPending || startTimer.isPending}
        />
      )}
    </div>
  )
}

// ─── The order pop-up ───────────────────────────────────────────────────────
//
// Tap a card: every dish of the order at this station with its step
// instruction in English and Urdu, the recipe for a dish with no steps, and a
// timer per dish (default = the step's estimated time; − / + 30 s before
// starting; several may run at once).

function OrderPopup({
  card, timers, remaining, isUrdu, showImages, onClose, onStart, onDone, onStartTimer, onAdjust, onStop, lineActions, busy,
}: {
  card: BoardCard
  timers: KitchenTimer[]
  remaining: (t: KitchenTimer) => number
  isUrdu: boolean
  showImages: boolean
  onClose: () => void
  onStart: () => void
  onDone: () => void
  onStartTimer: (entryId: string, durationSeconds: number, label?: string) => void
  onAdjust: (id: string, addSeconds: number) => void
  onStop: (id: string) => void
  lineActions: ReturnType<typeof useLineActions>
  busy: boolean
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  // The page re-renders every second (the clocks): keep the latest onClose in
  // a ref so focus moves to Close once, on open — not on every tick.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.() }
  }, [])

  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Order ${card.order.ref}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-kds-border bg-kds-card text-kds-text">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-kds-border bg-kds-card px-4 py-3">
          <div className="min-w-0">
            <p className="text-2xl font-black leading-none">#{card.order.ref}</p>
            <p className="text-xs text-kds-subtext mt-1 truncate">
              {card.order.brand} · {CHANNEL_LABEL[card.order.channel] ?? card.order.channel}
              {card.order.tableLabel ? ` · Table ${card.order.tableLabel}` : ''}
              {card.order.customerName ? ` · ${card.order.customerName}` : ''}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
            className="min-h-11 min-w-11 rounded-xl bg-white/10 inline-flex items-center justify-center">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {card.entries.map((e) => (
            <EntryBlock key={e.id} entry={e} timers={timers.filter((t) => (e.kind === 'step' ? t.orderItemStepId === e.id : t.orderItemId === e.itemId && !t.orderItemStepId))}
              remaining={remaining} isUrdu={isUrdu} showImages={showImages}
              onStartTimer={onStartTimer} onAdjust={onAdjust} onStop={onStop} lineActions={lineActions} busy={busy} />
          ))}
        </div>

        <div className="sticky bottom-0 flex gap-2 border-t border-kds-border bg-kds-card p-3">
          {!card.started && !card.held && (
            <button type="button" onClick={onStart} disabled={busy}
              className="flex-1 min-h-12 rounded-xl text-sm font-black bg-white/10 inline-flex items-center justify-center gap-1.5 disabled:opacity-40">
              <Play size={16} aria-hidden="true" /> Start
            </button>
          )}
          {!card.held && (
            <button type="button" onClick={onDone} disabled={busy}
              className="flex-1 min-h-12 rounded-xl text-base font-black bg-kds-green text-primary-on inline-flex items-center justify-center gap-1.5 disabled:opacity-40">
              <Check size={20} aria-hidden="true" /> Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function EntryBlock({
  entry, timers, remaining, isUrdu, showImages, onStartTimer, onAdjust, onStop, lineActions, busy,
}: {
  entry: BoardEntry
  timers: KitchenTimer[]
  remaining: (t: KitchenTimer) => number
  isUrdu: boolean
  showImages: boolean
  onStartTimer: (entryId: string, durationSeconds: number, label?: string) => void
  onAdjust: (id: string, addSeconds: number) => void
  onStop: (id: string) => void
  lineActions: ReturnType<typeof useLineActions>
  busy: boolean
}) {
  const [seconds, setSeconds] = useState(entry.estimatedSeconds && entry.estimatedSeconds > 0 ? entry.estimatedSeconds : DEFAULT_LINE_TIMER)
  const [showRecipe, setShowRecipe] = useState(false)
  return (
    <section className="rounded-xl border border-kds-border bg-black/20 p-3">
      <LineStateBadge status={entry.status} small />
      <p className="text-lg font-black leading-tight">
        {entry.qty > 1 && <span className="text-kds-amber mr-1">{entry.qty}×</span>}{entry.itemName}
      </p>
      {entry.modifiers.length > 0 && <p className="text-sm text-kds-subtext">{entry.modifiers.join(', ')}</p>}
      {entry.notes && (
        <p className="text-sm italic text-kds-amber mt-0.5">
          <TriangleAlert size={13} aria-hidden="true" className="inline-block align-[-2px] mr-1" />{entry.notes}
        </p>
      )}
      {entry.instruction && (
        <div className="mt-2 space-y-1">
          <p className="text-base font-semibold text-kds-green">{entry.instruction}</p>
          {entry.instructionUrdu && <p className="text-base font-semibold text-kds-green" dir="rtl" lang="ur">{entry.instructionUrdu}</p>}
          {entry.estimatedSeconds ? <p className="text-xs text-kds-subtext">About {clock(entry.estimatedSeconds)}</p> : null}
        </div>
      )}

      {/* Timers on this dish */}
      {timers.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {timers.map((t) => {
            const r = remaining(t)
            return (
              <li key={t.id} className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 ${r <= 0 ? 'bg-kds-red/30 animate-pulse' : 'bg-white/5'}`}>
                <Timer size={14} aria-hidden="true" />
                <span className="text-sm font-semibold truncate max-w-[10rem]">{t.label}</span>
                <span className="text-lg font-black tabular-nums">{r <= 0 ? 'Done' : clock(r)}</span>
                <span className="ml-auto flex gap-1.5">
                  <button type="button" onClick={() => onAdjust(t.id, -30)} disabled={r <= 30} aria-label="30 seconds less"
                    className="min-h-10 min-w-10 rounded-lg bg-white/10 inline-flex items-center justify-center disabled:opacity-30"><Minus size={16} aria-hidden="true" /></button>
                  <button type="button" onClick={() => onAdjust(t.id, 30)} aria-label="30 seconds more"
                    className="min-h-10 min-w-10 rounded-lg bg-white/10 inline-flex items-center justify-center"><Plus size={16} aria-hidden="true" /></button>
                  <button type="button" onClick={() => onStop(t.id)}
                    className="min-h-10 rounded-lg bg-white/10 px-3 text-sm font-bold">Stop</button>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {/* New timer: default from the step's time, − / + 30 s */}
      {entry.status !== 'held' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setSeconds((s) => Math.max(30, s - 30))} aria-label="30 seconds less"
            className="min-h-11 min-w-11 rounded-lg bg-white/10 inline-flex items-center justify-center"><Minus size={16} aria-hidden="true" /></button>
          <span className="text-lg font-black tabular-nums w-16 text-center">{clock(seconds)}</span>
          <button type="button" onClick={() => setSeconds((s) => Math.min(4 * 3600, s + 30))} aria-label="30 seconds more"
            className="min-h-11 min-w-11 rounded-lg bg-white/10 inline-flex items-center justify-center"><Plus size={16} aria-hidden="true" /></button>
          <button type="button" onClick={() => onStartTimer(entry.id, seconds)} disabled={busy}
            className="min-h-11 rounded-lg bg-kds-blue/20 text-kds-text px-3 text-sm font-black inline-flex items-center gap-1.5 disabled:opacity-40">
            <Timer size={16} aria-hidden="true" /> Start timer
          </button>
        </div>
      )}

      {entry.kind === 'line' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <HoldButton itemId={entry.itemId} status={entry.status} actions={lineActions} small />
          <button type="button" onClick={() => setShowRecipe((v) => !v)} className="min-h-10 rounded-lg bg-white/10 px-3 text-sm font-bold">
            {showRecipe ? 'Hide recipe' : 'Recipe'}
          </button>
        </div>
      )}
      {showRecipe && entry.kind === 'line' && (
        <div className="mt-2 rounded-lg overflow-hidden">
          <StationInstructionPanel menuItemId={entry.menuItemId} itemName={entry.itemName} isUrdu={isUrdu} showImages={showImages} />
        </div>
      )}
    </section>
  )
}

// ─── StationInstructionPanel ───────────────────────────────────────────────
//
// Expanded body that appears when the cook taps a card. Fetches the recipe
// for the item's menu-item id and renders the full step list in the chosen
// language. When showImages is on, the menu item's photo is shown across the
// top for picture-mode kitchens. Cooks who can't read either language can
// still cook off the photo + recipe ingredient list.

function StationInstructionPanel({
  menuItemId, itemName, isUrdu, showImages,
}: {
  menuItemId: string | null
  itemName:   string
  isUrdu:     boolean
  showImages: boolean
}) {
  const { data, isLoading } = useQuery<RecipeData | null>({
    queryKey: ['recipe-by-item', menuItemId],
    queryFn:  () => menuItemId ? api.get<RecipeData | null>(`/recipes/by-item/${menuItemId}`) : Promise.resolve(null),
    enabled:  !!menuItemId,
    staleTime: 5 * 60_000,
  })

  if (!menuItemId) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'یہ ایک حسبِ ضرورت آرڈر ہے — کوئی ترکیب دستیاب نہیں۔' : 'Custom item — no recipe on file.'}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs text-kds-subtext animate-pulse">
          {isUrdu ? 'لوڈ ہو رہا ہے…' : 'Loading recipe…'}
        </p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'اس آئٹم کی ترکیب ابھی شامل نہیں کی گئی۔' : 'No recipe configured yet — add one in /accounting/recipes.'}
        </p>
      </div>
    )
  }

  // Prefer free-text recipe steps in the chosen language. If only the other
  // language is filled in, fall back to it so the cook gets *something*.
  const freeText = isUrdu
    ? (data.stepsUrdu || data.steps)
    : (data.steps || data.stepsUrdu)

  return (
    <div className="border-t border-white/[0.06] bg-black/30 p-4 space-y-3 text-sm"
      dir={isUrdu ? 'rtl' : 'ltr'}>
      {/* Photo — picture mode for kitchens that work off the photo */}
      {showImages && data.menuItem?.imageUrl && (
        <img
          src={data.menuItem.imageUrl}
          alt={itemName}
          className="w-full h-40 object-cover rounded-lg border border-white/[0.06]"
        />
      )}

      {/* Per-step recipe (structured) — preferred over free-text when present */}
      {data.recipeSteps && data.recipeSteps.length > 0 ? (
        <div>
          <p className="text-xs font-black uppercase tracking-wider text-kds-subtext mb-2">
            {isUrdu ? 'ترکیب' : 'Recipe steps'}
          </p>
          <ol className="space-y-1.5">
            {data.recipeSteps.map((s, idx) => {
              const text = isUrdu ? (s.instructionUrdu || s.instruction) : s.instruction
              return (
                <li key={s.id} className="flex items-start gap-2.5 text-kds-text leading-snug">
                  <span className="shrink-0 h-5 w-5 rounded-full bg-white/10 text-xs font-black flex items-center justify-center mt-0.5">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px]">{text}</p>
                    <p className="text-xs text-kds-subtext mt-0.5">
                      {s.stationName ?? '—'} · {s.estimatedSeconds}s
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      ) : freeText ? (
        <div>
          <p className="text-xs font-black uppercase tracking-wider text-kds-subtext mb-2">
            {isUrdu ? 'تیاری' : 'Method'}
          </p>
          <p className="text-[13px] text-kds-text whitespace-pre-wrap leading-snug">{freeText}</p>
        </div>
      ) : (
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'کوئی ہدایات نہیں — کک یاد سے بنائیں گے۔' : 'No instructions on file — cook from memory.'}
        </p>
      )}

      {/* Ingredients — handy for the cook to double-check mise en place */}
      {data.ingredients.length > 0 && (
        <div>
          <p className="text-xs font-black uppercase tracking-wider text-kds-subtext mb-1.5">
            {isUrdu ? 'اجزاء' : 'Ingredients'}
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {data.ingredients.map((ing) => (
              <div key={ing.id} className="flex items-baseline justify-between text-[12px]">
                <span className="text-kds-text/85 truncate pr-2">{ing.name}</span>
                <span className="text-kds-subtext shrink-0 font-mono">
                  {ing.quantity % 1 === 0 ? ing.quantity : ing.quantity.toFixed(2)} {ing.unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.notes && (
        <p className="text-xs italic text-kds-amber/80 border-t border-white/[0.04] pt-2">
          <TriangleAlert size={12} aria-hidden="true" className="inline-block align-[-1px] mr-1" />{data.notes}
        </p>
      )}
    </div>
  )
}
