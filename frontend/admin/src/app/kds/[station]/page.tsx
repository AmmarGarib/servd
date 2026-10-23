'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react'
import { FulfilmentIcon } from '../../../components/kds/FulfilmentIcon'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../../lib/api'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { getSocket } from '../../../lib/socket'
import { useKdsStore } from '../../../store/kds'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'
import { useLineActions, LineStateBadge, HoldButton, RecallStrip } from '../../../components/kds/LineActions'
import { orderRef } from '../../../lib/orderRef'

// Recipe payload — matches /recipes/by-item/:menuItemId.
// Used by the per-card expand panel to show free-text + per-step
// instructions in the operator's chosen language with an optional photo.
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
 * Per-station KDS — only what THIS station needs to cook right now.
 *
 * Two data sources unioned by /expo/station/:id/queue:
 *
 *   1. Step-level tickets: items whose recipe has steps configured. Each
 *      card is one step (e.g. "Sear steak" on Grill, "Boil rice" on Rice).
 *      Bumping fires the cascade — downstream steps appear on their station
 *      automatically.
 *
 *   2. Legacy items: menu items that don't have recipe steps yet still flow
 *      through the old per-item routing. Bumping uses the existing item
 *      status endpoint. As recipes get their steps, items naturally migrate.
 *      A legacy line can be put on Hold (it stays here, marked HELD, until
 *      Resume); a recalled line comes back marked REMAKE and its Bump starts
 *      and finishes the remake. Bumped lines can be recalled from the
 *      "Recently bumped" strip (BOH-04).
 */

type FulfilmentType = 'dine_in' | 'takeout' | 'delivery'

// Loud per-card badge so the line cook sees plate-vs-package at a glance.
// Colours are kds-* tokens (green / amber / violet), never hex.
const FULFILMENT_META: Record<FulfilmentType, { label: string; short: string; text: string; badge: string; card: string }> = {
  dine_in:  { label: 'Dine-in',  short: 'PLATE',    text: 'text-kds-green',      badge: 'bg-kds-green/10 border-kds-green/30',           card: 'border-kds-green/35' },
  takeout:  { label: 'Takeout',  short: 'PACK',     text: 'text-kds-amber',      badge: 'bg-kds-amber/10 border-kds-amber/30',           card: 'border-kds-amber/35' },
  delivery: { label: 'Delivery', short: 'PACK+LBL', text: 'text-source-manual',  badge: 'bg-source-manual/10 border-source-manual/30',   card: 'border-source-manual/35' },
}

interface StepTicket {
  stepId:    string
  itemId:    string
  menuItemId: string | null   // null for custom-typed items; recipe lookup skipped
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    'preparing' | 'waiting'
  firedAt:   string | null
  instruction:      string
  instructionUrdu:  string | null
  phase:            string
  estimatedSeconds: number
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface LegacyTicket {
  itemId:    string
  menuItemId: string | null
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    string
  firedAt:   string | null
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface QueuePayload {
  steps:  StepTicket[]
  legacy: LegacyTicket[]
}

export default function StationKdsPage() {
  const { station } = useParams<{ station: string }>()
  const qc = useQueryClient()
  // Subscribe to socket events for live cascade updates.
  useKdsSocket({ stationId: station, role: 'kitchen' })

  // ── Display mode (global, persisted by useKdsStore) ──────────────────
  // - lang  = 'en' | 'ur'  → swaps instruction text + recipe steps to Urdu
  // - showImages           → renders MenuItem.imageUrl in the expanded panel
  //                          when on; pure-text otherwise (older iPad screens)
  // The toggles live in KdsHeader only (one set of controls).
  const lang        = useKdsStore((s) => s.lang)
  const showImages  = useKdsStore((s) => s.showImages)
  const isUrdu      = lang === 'ur'

  // The station's real name (same list the KDS home reads).
  const { data: myStations } = useQuery<{ stations: Array<{ id: string; name: string; concept: { name: string } }> }>({
    queryKey: ['kds-my-stations'],
    queryFn:  () => api.get('/kds/my-stations'),
    staleTime: 30_000,
  })
  const stationName = myStations?.stations.find((s) => s.id === station)?.name

  // ONE interval ticks every elapsed-time label once a second.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Which card is currently expanded for full instructions. Only one card can
  // be open at a time so the cook can focus.
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<QueuePayload>({
    queryKey: ['station-queue', station],
    queryFn:  () => api.get<QueuePayload>(`/expo/station/${station}/queue?states=all`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })

  const bumpStep = useMutation({
    mutationFn: (stepId: string) => api.post(`/expo/steps/${stepId}/bump`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['station-queue', station] }),
  })

  const bumpLegacy = useMutation({
    mutationFn: (itemId: string) => api.patch(`/order-items/${itemId}/status`, { status: 'bumped' }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['station-queue', station] })
      qc.invalidateQueries({ queryKey: ['station-recent-bumped', station] })
    },
  })
  const lineActions = useLineActions(station)

  // Refresh the queue the moment a line is fired / moved for this station
  // (expo fire, "Fire course", the pacing worker, another screen's bump) —
  // not only on the next 5-second poll.
  useEffect(() => {
    const socket = getSocket()
    const refresh = (data?: { stationId?: string | null }) => {
      if (data?.stationId && data.stationId !== station) return
      qc.invalidateQueries({ queryKey: ['station-queue', station] })
    }
    socket.on('item:updated', refresh)
    socket.on('expo:fire', refresh)
    return () => {
      socket.off('item:updated', refresh)
      socket.off('expo:fire', refresh)
    }
  }, [station, qc])

  const steps = data?.steps ?? []
  const legacy = data?.legacy ?? []
  const total = steps.filter((s) => s.status === 'preparing').length + legacy.length
  const waitingCount = steps.filter((s) => s.status === 'waiting').length

  // Split into "ready to cook" (preparing/legacy) and "on deck" (waiting on deps)
  const cooking: Array<StepTicket | { __legacy: true } & LegacyTicket> = [
    ...steps.filter((s) => s.status === 'preparing'),
    ...legacy.map((l) => ({ __legacy: true as const, ...l })),
  ]
  const waiting = steps.filter((s) => s.status === 'waiting')

  return (
    <div className="erp-kitchen-dark flex h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <div className="shrink-0 px-4 pt-3 pb-1 flex items-center justify-between gap-3 flex-wrap">
        <Link href="/expo" className="min-h-11 text-sm text-kds-subtext hover:text-kds-text flex items-center gap-1.5 transition-colors">
          <ArrowLeft size={16} aria-hidden="true" /> Expo
        </Link>
        <div className="flex items-center gap-2">
          {waitingCount > 0 && (
            <span className="text-xs font-bold rounded-full px-2.5 py-1 bg-kds-blue/10 text-kds-blue">
              {waitingCount} on deck
            </span>
          )}
        </div>
      </div>
      <KdsHeader title={stationName ?? 'Station'} stationId={station} count={total} />

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Cooking right now */}
        <section>
          <p className="text-xs uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
            Cooking now ({cooking.length})
          </p>

          {isLoading && <p className="text-sm text-kds-subtext">Loading…</p>}

          {!isLoading && cooking.length === 0 && (
            <div className="rounded-2xl p-12 text-center border border-kds-border bg-kds-card/40">
              <Check size={36} aria-hidden="true" className="mx-auto mb-2 text-kds-green" />
              <p className="text-base font-bold text-kds-text">All clear</p>
              <p className="text-xs text-kds-subtext mt-1">New tickets will appear here when expo fires.</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {cooking.map((t) => {
              const isLegacy = '__legacy' in t
              const id = isLegacy ? t.itemId : t.stepId
              const lineStatus = isLegacy ? t.status : 'preparing'
              const isHeld = lineStatus === 'held'
              const isRemake = lineStatus === 'recalled'
              const onBump = () => isLegacy
                ? (isRemake ? lineActions.bumpRemake.mutate(t.itemId) : bumpLegacy.mutate(t.itemId))
                : bumpStep.mutate(t.stepId)
              const pending = isLegacy
                ? (bumpLegacy.isPending && bumpLegacy.variables === t.itemId)
                  || (lineActions.bumpRemake.isPending && lineActions.bumpRemake.variables === t.itemId)
                : bumpStep.isPending && bumpStep.variables === t.stepId
              const elapsed = t.firedAt
                ? formatDistanceToNowStrict(new Date(t.firedAt), { addSuffix: false })
                : 'just now'
              const eta = !isLegacy ? (t as StepTicket).estimatedSeconds : 0
              const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
              const expanded = expandedId === id
              const stepInstruction = !isLegacy
                ? (isUrdu && (t as StepTicket).instructionUrdu
                    ? (t as StepTicket).instructionUrdu
                    : (t as StepTicket).instruction)
                : null
              return (
                <div key={id} className={`rounded-2xl relative overflow-hidden border-2 bg-kds-card ${fm.card}`}
                  dir={isUrdu ? 'rtl' : 'ltr'}>
                  {/* Card body — clickable, toggles the instruction panel.
                      The Bump button is outside this surface so it doesn't
                      accidentally trigger an expand. */}
                  <button
                    onClick={() => setExpandedId(expanded ? null : id)}
                    className="w-full text-left p-4 cursor-pointer hover:bg-white/[0.02] transition-colors">
                    {/* Loud fulfilment badge — first thing the cook sees */}
                    <div className={`absolute -top-2 left-3 px-2 py-0.5 rounded-md text-xs font-black uppercase tracking-[0.15em] border bg-kds-card ${fm.badge} ${fm.text}`}>
                      <FulfilmentIcon type={t.order.fulfilmentType} size={12} /> {fm.short}
                      {t.order.tableLabel && <span className="ml-1 opacity-80">· {t.order.tableLabel}</span>}
                    </div>
                    <div className="flex items-center justify-between mb-2 mt-1 text-xs uppercase tracking-wider font-bold">
                      <span className="text-kds-subtext">{t.order.concept.name} · {t.order.source}</span>
                      <span className="text-kds-amber">{elapsed}</span>
                    </div>
                    <LineStateBadge status={lineStatus} />
                    <p className={`text-lg font-black text-kds-text leading-tight mb-1 ${isHeld ? 'opacity-60' : ''}`}>
                      {t.qty > 1 && <span className="text-kds-amber mr-1">{t.qty}×</span>}
                      {t.itemName}
                    </p>
                    {stepInstruction && (
                      <p className="text-sm font-semibold mt-2 leading-snug text-kds-green">
                        <ArrowRight size={14} aria-hidden="true" className="inline-block align-[-2px] mr-0.5" />{stepInstruction}
                      </p>
                    )}
                    {t.itemNotes && (
                      <p className="text-xs italic mt-1.5 text-kds-amber">
                        <TriangleAlert size={12} aria-hidden="true" className="inline-block align-[-1px] mr-1" />{t.itemNotes}
                      </p>
                    )}
                    <p className="text-xs text-kds-subtext mt-2">
                      {t.order.customerName ?? (isUrdu ? 'مہمان' : 'Walk-in')} · #{orderRef(t.order.id)}
                    </p>
                    {eta > 0 && (
                      <p className="text-xs text-kds-subtext mt-1">
                        {isUrdu ? 'ہدف' : 'Target'}: {Math.round(eta)}s
                      </p>
                    )}
                    <p className="text-xs text-kds-subtext/60 mt-2 italic">
                      {expanded ? <ChevronUp size={12} aria-hidden="true" className="inline-block align-[-2px] mr-0.5" /> : <ChevronDown size={12} aria-hidden="true" className="inline-block align-[-2px] mr-0.5" />}
                      {expanded ? (isUrdu ? 'بند کریں' : 'Hide instructions') : (isUrdu ? 'ہدایات' : 'Tap for full instructions')}
                    </p>
                  </button>

                  {/* Expanded instruction panel — recipe steps in chosen
                      language, item image when showImages is on. Recipe is
                      fetched on first expand. */}
                  {expanded && (
                    <StationInstructionPanel
                      menuItemId={t.menuItemId}
                      itemName={t.itemName}
                      isUrdu={isUrdu}
                      showImages={showImages}
                    />
                  )}

                  {/* Bump — always visible at the bottom, never inside the
                      clickable expand surface. */}
                  <div className="p-4 pt-0 space-y-2">
                    {/* A held line resumes before it can be bumped. */}
                    {!isHeld && (
                      <button onClick={onBump} disabled={pending}
                        className="w-full min-h-11 rounded-xl py-3 text-base font-black transition-all disabled:opacity-40 bg-kds-green text-primary-on inline-flex items-center justify-center gap-2">
                        {pending ? (isUrdu ? 'مکمل ہو رہا ہے…' : 'Bumping…') : (<><Check size={18} aria-hidden="true" />{isUrdu ? 'مکمل' : (isRemake ? 'Bump remake' : 'Bump')}</>)}
                      </button>
                    )}
                    {isLegacy && <HoldButton itemId={t.itemId} status={lineStatus} actions={lineActions} />}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {lineActions.error && (
          <p className="rounded-lg border border-kds-red/50 bg-kds-red/10 px-3 py-2 text-sm font-semibold text-kds-red">
            {lineActions.error}
          </p>
        )}

        {/* Bumped in the last 30 minutes — Recall sends one back as a remake. */}
        <RecallStrip stationId={station} actions={lineActions} />

        {/* Waiting (step deps not yet clear) */}
        {waiting.length > 0 && (
          <section>
            <p className="text-xs uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
              On deck — waiting on prior steps ({waiting.length})
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {waiting.map((t) => {
                const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
                return (
                  <div key={t.stepId} className="rounded-2xl p-4 opacity-50 border border-dashed border-kds-border bg-kds-card/40">
                    <p className={`text-xs uppercase tracking-wider font-bold mb-2 ${fm.text}`}>
                      <FulfilmentIcon type={t.order.fulfilmentType} size={11} /> {fm.short} · {t.order.concept.name} · waiting
                    </p>
                    <p className="text-base font-bold text-kds-text/70 leading-tight">
                      {t.qty > 1 && <span className="text-kds-subtext mr-1">{t.qty}×</span>}
                      {t.itemName}
                    </p>
                    <p className="text-sm font-semibold mt-2 text-kds-subtext italic">
                      {t.instruction}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Footer total */}
        <p className="text-center text-xs text-kds-subtext pt-2">
          {total} active · auto-refreshes every 5s
        </p>
      </div>
    </div>
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
