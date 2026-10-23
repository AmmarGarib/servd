'use client'
// The till's offline orders (owner, 2026-10-23: "offline orders must never vanish").
//
// A pill at the top of the till — "N orders waiting to sync" — and a panel that
// lists every order kept on this device (lib/offline-queue.ts): time, items, the
// till's last total, who rang it and, for a refused one, the server's reason,
// with Resend and Discard. The page replays the queue with the signed-in session
// on load, when the connection comes back, when the service worker asks, and
// every 30 s while anything waits. Discard needs a manager signed in on this
// till (there is no server PIN check for a local entry; nothing is recorded on
// the server — the order never reached it).

import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CloudOff, RefreshCw, TriangleAlert, Trash2 } from 'lucide-react'
import {
  discardQueued, getQueuedOrders, listenForReplayRequests, QUEUE_CHANGED_EVENT, replayOne, replayQueue, requestSync,
  type OfflineOrder,
} from '../../lib/offline-queue'
import { fmtPkr } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { usePosStore } from '../../store/pos'
import { useConfirm } from '../ui/ConfirmDialog'
import { useIsManager } from './managerRole'
import { FlowDialog, ErrorLine, ghostBtn, primaryBtn } from './flow/ui'

/** Keeps the queue in view and replays it. Returns what the till shows. */
export function useOfflineQueue() {
  const qc = useQueryClient()
  const [entries, setEntries] = useState<OfflineOrder[]>([])
  const [online, setOnline] = useState(true)
  const [synced, setSynced] = useState(0)
  const [storeError, setStoreError] = useState(false)
  const userId = useAuthStore((s) => s.user?.id ?? null)

  const reload = useCallback(() => {
    getQueuedOrders().then((e) => { setEntries(e); setStoreError(false) }).catch(() => setStoreError(true))
  }, [])

  const replay = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const r = await replayQueue().catch(() => ({ sent: 0, refused: 0 }))
    if (r.sent > 0) {
      setSynced(r.sent)
      void qc.invalidateQueries({ queryKey: ['pos'] })
    }
    reload()
  }, [qc, reload])

  useEffect(() => {
    setOnline(navigator.onLine)
    reload()
    void replay()
    const up = () => { setOnline(true); void replay() }
    const down = () => { setOnline(false); requestSync() }
    const vis = () => { if (document.visibilityState === 'visible') void replay() }
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    window.addEventListener(QUEUE_CHANGED_EVENT, reload)
    document.addEventListener('visibilitychange', vis)
    const unsub = listenForReplayRequests(() => void replay())
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      window.removeEventListener(QUEUE_CHANGED_EVENT, reload)
      document.removeEventListener('visibilitychange', vis)
      unsub()
    }
  }, [reload, replay])

  // A different login signed in on this till: replay what is theirs.
  useEffect(() => { if (userId) void replay() }, [userId, replay])

  // While anything waits, try again every 30 s (navigator.onLine can claim online without a connection).
  const waiting = entries.filter((e) => e.state !== 'refused').length
  useEffect(() => {
    if (waiting === 0) return
    requestSync()
    const t = setInterval(() => void replay(), 30_000)
    return () => clearInterval(t)
  }, [waiting, replay])

  useEffect(() => { if (!synced) return; const t = setTimeout(() => setSynced(0), 5000); return () => clearTimeout(t) }, [synced])

  return { entries, waiting, refused: entries.length - waiting, online, synced, storeError, replay, reload }
}

/** The till's offline banner, the "waiting to sync" pill and the panel. */
export function OfflineQueueBar() {
  const q = useOfflineQueue()
  const [open, setOpen] = useState(false)

  return (
    <>
      {!q.online && (
        <div role="status" className="flex items-center gap-2 border-b border-kds-amber/40 bg-kds-amber/15 px-3 py-2">
          <CloudOff size={16} aria-hidden="true" className="shrink-0 text-kds-amber" />
          <span className="flex-1 text-sm font-semibold text-kds-amber">
            No internet. New orders are kept on this till and sent when the connection is back. Payments, Keenu, No Charge and adding items to a sent ticket need the internet — they are not sent.
          </span>
        </div>
      )}
      {q.storeError && (
        <div role="alert" className="flex items-center gap-2 border-b border-kds-red bg-kds-red/20 px-3 py-2">
          <TriangleAlert size={16} aria-hidden="true" className="shrink-0 text-kds-red" />
          <span className="text-sm font-semibold text-kds-red">This till cannot read its offline orders. Do not clear the browser data — call a manager.</span>
        </div>
      )}
      {q.entries.length > 0 && (
        <div className={`flex items-center gap-2 border-b px-3 py-2 ${q.refused > 0 ? 'border-kds-red bg-kds-red/20' : 'border-kds-amber/40 bg-kds-amber/15'}`}>
          {q.refused > 0
            ? <TriangleAlert size={16} aria-hidden="true" className="shrink-0 text-kds-red" />
            : <RefreshCw size={16} aria-hidden="true" className="shrink-0 text-kds-amber" />}
          <span className={`flex-1 text-sm font-semibold ${q.refused > 0 ? 'text-kds-red' : 'text-kds-amber'}`}>
            {q.waiting > 0 && `${q.waiting} order${q.waiting !== 1 ? 's' : ''} waiting to sync — not in the kitchen yet`}
            {q.waiting > 0 && q.refused > 0 && ' · '}
            {q.refused > 0 && `${q.refused} order${q.refused !== 1 ? 's' : ''} refused by the server — needs you`}
          </span>
          <button type="button" onClick={() => setOpen(true)}
            className="min-h-11 shrink-0 rounded-lg border border-kds-border bg-kds-card px-4 text-sm font-bold text-kds-text hover:border-kds-green">
            Show
          </button>
        </div>
      )}
      {q.synced > 0 && (
        <div role="status" className="flex items-center gap-2 border-b border-kds-green/30 bg-kds-green/15 px-3 py-2">
          <CircleCheck size={16} aria-hidden="true" className="text-kds-green" />
          <span className="text-sm font-semibold text-kds-green">{q.synced} offline order{q.synced !== 1 ? 's' : ''} sent to the kitchen</span>
        </div>
      )}
      {open && <OfflineQueuePanel entries={q.entries} online={q.online} onReplay={q.replay} onClose={() => setOpen(false)} />}
    </>
  )
}

function OfflineQueuePanel({ entries, online, onReplay, onClose }: {
  entries: OfflineOrder[]
  online: boolean
  onReplay: () => Promise<void>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const isManager = useIsManager()
  const me = useAuthStore((s) => s.user?.id ?? null)
  const shiftId = usePosStore((s) => s.shiftId)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function resend(e: OfflineOrder) {
    setBusy(e.localId); setMsg(null)
    try {
      const r = await replayOne(e, { shiftId })
      if (r === 'sent') { setMsg({ ok: true, text: 'Sent to the kitchen.' }); void qc.invalidateQueries({ queryKey: ['pos'] }) }
      else if (r === 'offline') setMsg({ ok: false, text: 'No internet — not sent. It stays on this till.' })
      else setMsg({ ok: false, text: 'Not sent — the reason is on the order. It stays on this till.' })
    } finally { setBusy(null) }
  }

  async function discard(e: OfflineOrder) {
    if (!isManager) return
    const ok = await confirm({
      title: 'Discard this order?',
      body: 'It never reached the server, so it is not in the kitchen, the bill or the books. Discarding removes it from this till for good. Make sure the guest was not served it or that it was rung again.',
      confirmLabel: 'Discard', cancelLabel: 'Keep it', danger: true,
    })
    if (!ok) return
    setBusy(e.localId); setMsg(null)
    try { await discardQueued(e.localId); setMsg({ ok: true, text: 'Discarded.' }) }
    catch { setMsg({ ok: false, text: 'Could not discard — try again.' }) }
    finally { setBusy(null) }
  }

  return (
    <FlowDialog title="Orders kept on this till" subtitle="Not in the kitchen until they are sent" onClose={onClose} width="max-w-2xl">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!online || busy !== null} onClick={() => { setBusy('all'); setMsg(null); void onReplay().finally(() => setBusy(null)) }} className={primaryBtn}>
            <span className="inline-flex items-center gap-2"><RefreshCw size={16} aria-hidden="true" /> Send waiting orders now</span>
          </button>
          {!online && <span className="text-sm font-semibold text-kds-amber">No internet — they will be sent when it is back.</span>}
        </div>
        {msg && (msg.ok ? <p role="status" className="text-sm font-semibold text-kds-green">{msg.text}</p> : <ErrorLine text={msg.text} />)}
        {entries.length === 0 && <p className="text-sm text-kds-subtext">Nothing waiting. Every order has reached the server.</p>}
        <ul className="space-y-3">
          {entries.map((e) => {
            const s = e.summary
            const refused = e.state === 'refused'
            const other = !!e.userId && e.userId !== me
            const items = s?.items ?? itemsFromBody(e.body)
            return (
              <li key={e.localId} className={`rounded-xl border p-4 ${refused ? 'border-kds-red' : 'border-kds-border'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-kds-text">
                      {new Date(e.queuedAt).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Karachi' })}
                      {s?.label ? ` · ${s.label}` : ''}{s?.brandName ? ` · ${s.brandName}` : ''}
                    </p>
                    <p className="text-xs text-kds-subtext">
                      Rung by {e.userName ?? 'an earlier login'}{other ? ' — sent by itself only when they sign in here' : ''}
                    </p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-black uppercase ${refused ? 'bg-kds-red text-white' : 'bg-kds-amber text-kds-bg'}`}>
                    {refused ? 'Refused' : 'Waiting'}
                  </span>
                </div>
                <ul className="mt-2 text-sm text-kds-text">
                  {items.map((i, n) => <li key={n}>{i.quantity} × {i.name}</li>)}
                </ul>
                <p className="mt-1 text-sm text-kds-subtext">
                  {s?.totalCents != null
                    ? <>Total (cash, as last priced): <span className="font-bold text-kds-text">{fmtPkr(s.totalCents)}</span></>
                    : s ? <>Items at menu price: <span className="font-bold text-kds-text">{fmtPkr(s.itemsCents)}</span> (before discount and tax)</> : null}
                </p>
                {e.error && (
                  <p className={`mt-2 text-sm font-semibold ${refused ? 'text-kds-red' : 'text-kds-amber'}`}>
                    {refused ? 'Server said: ' : 'Last try: '}{e.error.message}{e.error.code ? ` (${e.error.code})` : ''}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={!online || busy !== null} onClick={() => void resend(e)} className={ghostBtn}>
                    <span className="inline-flex items-center gap-2"><RefreshCw size={16} aria-hidden="true" /> {busy === e.localId ? 'Sending…' : 'Resend'}</span>
                  </button>
                  <button type="button" disabled={!isManager || busy !== null} onClick={() => void discard(e)}
                    title={isManager ? undefined : 'Only a manager signed in on this till can discard'}
                    className="min-h-11 rounded-xl border border-kds-red px-4 py-3 font-semibold text-kds-red hover:bg-kds-red/10 disabled:cursor-not-allowed disabled:opacity-30">
                    <span className="inline-flex items-center gap-2"><Trash2 size={16} aria-hidden="true" /> Discard</span>
                  </button>
                </div>
                {!isManager && <p className="mt-1 text-xs text-kds-subtext">Discard needs a manager signed in on this till.</p>}
              </li>
            )
          })}
        </ul>
      </div>
    </FlowDialog>
  )
}

/** Entries stored by the old service worker carry no summary: read the lines from the body. */
function itemsFromBody(body: Record<string, unknown>): Array<{ name: string; quantity: number }> {
  const items = Array.isArray(body['items']) ? body['items'] as Array<{ name?: unknown; quantity?: unknown }> : []
  return items.map((i) => ({ name: typeof i.name === 'string' ? i.name : 'An item', quantity: typeof i.quantity === 'number' ? i.quantity : 1 }))
}
