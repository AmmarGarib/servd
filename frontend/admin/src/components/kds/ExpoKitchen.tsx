'use client'
// Expo additions (owner B12, 2026-10-26): "expo will print a ticket/recipt
// thing and on sticker printer … option to print multiple stickers in case of
// multiple bags … a counter with how many tickets are backed up … if an order
// card is sitting on screen for 1 minute without being started, expo needs an
// alert." Reads GET /expo/kitchen-status and /expo/label-settings and prints
// GET /expo/orders/:id/print (modules/expo/kitchenBoard.ts). Silent: no sound.
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Minus, Plus, Printer, Ruler, TriangleAlert } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { AnchoredMenu } from '../ui/AnchoredMenu'
import { fetchPrintableHtml, fetchReceiptHtml, printHtml } from '../pos/tillApi'

export interface KitchenStatus {
  backlog: { tickets: number; queuedCards: number }
  stations: Array<{ id: string; name: string; brand: string; visibleCards: number; visible: number; queued: number }>
  unstarted: Array<{ stationId: string; stationName: string; brand: string; orderId: string; ref: string; waitingSeconds: number }>
  alertAfterSeconds: number
}

export function useKitchenStatus() {
  return useQuery<KitchenStatus>({
    queryKey: ['expo', 'kitchen-status'],
    queryFn: () => api.get<KitchenStatus>('/expo/kitchen-status'),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** "Backed up" — orders not on any cook's screen yet. */
export function BacklogStat({ status }: { status: KitchenStatus | undefined }) {
  const n = status?.backlog.tickets ?? 0
  const hot = n > 0
  return (
    <div className={`rounded-xl px-3 py-2 text-center min-w-[80px] ${hot ? 'bg-kds-red/15 text-kds-red' : 'bg-white/5 text-kds-subtext'}`}
      title={status ? `${status.backlog.queuedCards} card(s) waiting behind the cooks' screens` : undefined}>
      <p className="text-xs uppercase tracking-wider font-black">Backed up</p>
      <p className="text-xl font-black leading-none mt-0.5 tabular-nums">{n}</p>
    </div>
  )
}

/** Silent alert: cards on a cook's screen 60 s+ without being started. */
export function UnstartedAlert({ status }: { status: KitchenStatus | undefined }) {
  const list = status?.unstarted ?? []
  if (list.length === 0) return null
  return (
    <div role="alert" className="mx-4 sm:mx-6 mt-3 rounded-xl border-2 border-kds-red bg-kds-red/15 px-4 py-3 animate-pulse">
      <p className="text-sm font-black text-kds-red flex items-center gap-2">
        <TriangleAlert size={16} aria-hidden="true" />
        {list.length === 1 ? '1 order is' : `${list.length} orders are`} on a cook&apos;s screen and not started
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {list.map((u) => (
          <li key={`${u.stationId}:${u.orderId}`}>
            <Link href={`/kds/${u.stationId}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-kds-card px-2.5 text-xs font-bold text-kds-text">
              {u.stationName} · #{u.ref} · {mmss(u.waitingSeconds)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Per-station visible / queued counts for the sidebar. */
export function stationQueueOf(status: KitchenStatus | undefined, stationId: string) {
  return status?.stations.find((s) => s.id === stationId) ?? null
}

interface LabelSettings { widthMm: number; heightMm: number; presets: Array<{ key: string; widthMm: number; heightMm: number; name: string }> }

/** The sticker printer's label size (per company; managers and the expediter set it). */
export function StickerSizeMenu() {
  const qc = useQueryClient()
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [w, setW] = useState('')
  const [h, setH] = useState('')
  const { data } = useQuery<LabelSettings>({ queryKey: ['expo', 'label-settings'], queryFn: () => api.get<LabelSettings>('/expo/label-settings'), staleTime: 60_000 })
  const save = useMutation({
    mutationFn: (v: { widthMm: number; heightMm: number }) => api.put('/expo/label-settings', v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['expo', 'label-settings'] }); setOpen(false) },
  })
  const err = save.error ? (save.error instanceof ApiError && save.error.status === 403 ? 'Only a manager or the expediter can change this.' : (save.error as Error).message) : null
  return (
    <>
      <button ref={btn} type="button" onClick={() => { setOpen((o) => !o); setW(String(data?.widthMm ?? 58)); setH(String(data?.heightMm ?? 40)) }}
        className="min-h-11 rounded-xl bg-white/5 px-3 text-xs font-bold text-kds-subtext inline-flex items-center gap-1.5 hover:text-kds-text">
        <Ruler size={14} aria-hidden="true" /> Sticker {data ? `${data.widthMm}×${data.heightMm} mm` : 'size'}
      </button>
      <AnchoredMenu anchor={btn} open={open} onClose={() => setOpen(false)} align="end" minWidth={240} role="dialog"
        className="erp-kitchen-dark !bg-kds-card !border-kds-border text-kds-text p-3">
        <p className="text-xs font-black uppercase tracking-wider text-kds-subtext mb-2">Sticker size</p>
        <div className="space-y-1">
          {data?.presets.map((p) => (
            <button key={p.key} type="button" disabled={save.isPending} onClick={() => save.mutate({ widthMm: p.widthMm, heightMm: p.heightMm })}
              className={`w-full min-h-10 rounded-lg px-3 text-left text-sm font-semibold ${data.widthMm === p.widthMm && data.heightMm === p.heightMm ? 'bg-kds-green/20 text-kds-green' : 'hover:bg-white/5'}`}>
              {p.name}
            </button>
          ))}
        </div>
        <p className="text-xs text-kds-subtext mt-3 mb-1">Other size (mm)</p>
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); save.mutate({ widthMm: Number(w), heightMm: Number(h) }) }}>
          <input aria-label="Width in mm" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
            className="w-16 min-h-10 rounded-lg border border-kds-border bg-kds-bg px-2 text-sm text-kds-text" />
          <span className="text-kds-subtext">×</span>
          <input aria-label="Height in mm" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
            className="w-16 min-h-10 rounded-lg border border-kds-border bg-kds-bg px-2 text-sm text-kds-text" />
          <button type="submit" disabled={save.isPending} className="min-h-10 rounded-lg bg-kds-green px-3 text-sm font-black text-primary-on disabled:opacity-40">Save</button>
        </form>
        {err && <p className="mt-2 text-xs text-kds-red">{err}</p>}
      </AnchoredMenu>
    </>
  )
}

/** Ready-card printing: N bag stickers, the kitchen ticket, and the receipt of a paid order. */
export function ReadyPrintControls({ orderId, paid }: { orderId: string; paid: boolean }) {
  const token = useAuthStore((s) => s.token)
  const [bags, setBags] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const run = (load: () => Promise<string>) => {
    setError(null)
    printHtml(load).catch((e: unknown) => setError(e instanceof ApiError && e.status === 403 ? 'You cannot print the receipt — the till can.' : (e as Error).message))
  }
  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-xl bg-white/5" aria-label="Number of bags">
          <button type="button" onClick={() => setBags((b) => Math.max(1, b - 1))} aria-label="One bag less" disabled={bags <= 1}
            className="min-h-11 min-w-11 inline-flex items-center justify-center text-kds-text disabled:opacity-30"><Minus size={16} aria-hidden="true" /></button>
          <span className="w-8 text-center text-base font-black tabular-nums text-kds-text">{bags}</span>
          <button type="button" onClick={() => setBags((b) => Math.min(20, b + 1))} aria-label="One bag more" disabled={bags >= 20}
            className="min-h-11 min-w-11 inline-flex items-center justify-center text-kds-text disabled:opacity-30"><Plus size={16} aria-hidden="true" /></button>
        </div>
        <button type="button" onClick={() => run(() => fetchPrintableHtml(`/expo/orders/${encodeURIComponent(orderId)}/print?kind=sticker&bags=${bags}`, token))}
          className="flex-1 min-h-11 rounded-xl bg-white/10 px-3 text-sm font-black text-kds-text inline-flex items-center justify-center gap-1.5">
          <Printer size={16} aria-hidden="true" /> {bags === 1 ? 'Print sticker' : `Print ${bags} stickers`}
        </button>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => run(() => fetchPrintableHtml(`/expo/orders/${encodeURIComponent(orderId)}/print?kind=ticket`, token))}
          className="flex-1 min-h-11 rounded-xl bg-white/5 px-3 text-xs font-bold text-kds-subtext inline-flex items-center justify-center gap-1.5 hover:text-kds-text">
          <Printer size={14} aria-hidden="true" /> Ticket
        </button>
        {paid && (
          <button type="button" onClick={() => run(() => fetchReceiptHtml(orderId, token, { duplicate: true }))}
            className="flex-1 min-h-11 rounded-xl bg-white/5 px-3 text-xs font-bold text-kds-subtext inline-flex items-center justify-center gap-1.5 hover:text-kds-text">
            <Printer size={14} aria-hidden="true" /> Receipt
          </button>
        )}
      </div>
      {error && <p className="text-xs text-kds-red">{error}</p>}
    </div>
  )
}
