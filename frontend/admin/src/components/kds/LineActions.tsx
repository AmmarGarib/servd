'use client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { api, ApiError } from '../../lib/api'
import { orderRef } from '../../lib/orderRef'

/**
 * Hold / resume / remake / recall for a station's line tickets (BOH-04).
 *
 * The one writer is PATCH /order-items/:id/status (kitchen state machine):
 *   pending | preparing → held      (Hold: paused, stays on the screen)
 *   held               → preparing  (Resume)
 *   bumped | ready     → recalled   (Recall: back on the station as a remake;
 *                                    a 'ready' order goes back to cooking and
 *                                    expo can't hand it off until re-bumped)
 *   recalled           → preparing → bumped  (Bump on a remake)
 *
 * The station queue (GET /expo/station/:id/queue?states=all — without
 * `states=all` held lines are left out, for the Bump-only tablet) lists held
 * and recalled lines with their status; a Bump on a held line is refused
 * (resume it first); the recall strip reads
 * GET /kds/stations/:id/recent-bumped, which only offers lines the server
 * will accept a recall for (the order hasn't ended, the food hasn't left).
 */

export type LineStatus = 'pending' | 'preparing' | 'held' | 'recalled' | string

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return (err as Error)?.message ?? 'Something went wrong'
}

export function useLineActions(stationId: string) {
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['station-queue', stationId] })
    qc.invalidateQueries({ queryKey: ['station-recent-bumped', stationId] })
    qc.invalidateQueries({ queryKey: ['kds-my-stations'] })
  }
  const setStatus = (itemId: string, status: string) => api.patch(`/order-items/${itemId}/status`, { status })

  const hold = useMutation({ mutationFn: (itemId: string) => setStatus(itemId, 'held'), onSuccess: refresh })
  const resume = useMutation({ mutationFn: (itemId: string) => setStatus(itemId, 'preparing'), onSuccess: refresh })
  const recall = useMutation({ mutationFn: (itemId: string) => setStatus(itemId, 'recalled'), onSuccess: refresh })
  // A remake is started and bumped in one tap: recalled → preparing → bumped.
  const bumpRemake = useMutation({
    mutationFn: async (itemId: string) => {
      await setStatus(itemId, 'preparing')
      return setStatus(itemId, 'bumped')
    },
    onSuccess: refresh,
  })
  const error = [hold, resume, recall, bumpRemake].map((m) => m.error).find(Boolean)
  return { hold, resume, recall, bumpRemake, error: error ? errorText(error) : null }
}

/** HELD / REMAKE marker on a line ticket; nothing for a normal line. */
export function LineStateBadge({ status, small = false }: { status: LineStatus; small?: boolean }) {
  if (status !== 'held' && status !== 'recalled') return null
  const held = status === 'held'
  return (
    <span className={`inline-flex items-center rounded-md border font-black uppercase tracking-[0.15em] ${
      small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
    } ${held ? 'border-kds-amber/50 bg-kds-amber/15 text-kds-amber' : 'border-kds-red/50 bg-kds-red/15 text-kds-red'}`}>
      {held ? 'Held' : 'Remake'}
    </span>
  )
}

/** Hold (or Resume) next to a legacy line's Bump. Step tickets are paused per step, not here. */
export function HoldButton({
  itemId, status, actions, small = false,
}: {
  itemId: string
  status: LineStatus
  actions: ReturnType<typeof useLineActions>
  small?: boolean
}) {
  if (status === 'recalled') return null
  const held = status === 'held'
  const m = held ? actions.resume : actions.hold
  const busy = m.isPending && m.variables === itemId
  return (
    <button
      type="button"
      onClick={() => m.mutate(itemId)}
      disabled={busy}
      className={`w-full rounded-xl border font-bold transition-colors disabled:opacity-40 ${
        small ? 'py-1.5 text-xs' : 'py-2.5 text-sm'
      } ${held
        ? 'border-kds-green/60 text-kds-green hover:bg-kds-green/10'
        : 'border-kds-border text-kds-subtext hover:border-kds-amber hover:text-kds-amber'}`}>
      {busy ? (held ? 'Resuming…' : 'Holding…') : (held ? 'Resume' : 'Hold')}
    </button>
  )
}

interface RecentBumped {
  itemId: string
  itemName: string
  qty: number
  status: string
  completedAt: string | null
  order: { id: string; status: string; customerName: string | null; tableLabel: string | null }
}

/** "Recently bumped" strip with a Recall button per line — the last 30 minutes. */
export function RecallStrip({ stationId, actions }: { stationId: string; actions: ReturnType<typeof useLineActions> }) {
  const { data } = useQuery<{ items: RecentBumped[] }>({
    queryKey: ['station-recent-bumped', stationId],
    queryFn: () => api.get<{ items: RecentBumped[] }>(`/kds/stations/${stationId}/recent-bumped`),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
  const items = data?.items ?? []
  if (items.length === 0) return null
  return (
    <section>
      <p className="text-[10px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-2">
        Recently bumped — recall for a remake ({items.length})
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const busy = actions.recall.isPending && actions.recall.variables === it.itemId
          return (
            <div key={it.itemId} className="flex items-center gap-2 rounded-lg border border-kds-border bg-kds-card px-2.5 py-1.5">
              <div className="min-w-0">
                <p className="text-xs font-bold text-kds-text truncate">
                  {it.qty > 1 && <span className="text-kds-amber mr-1">{it.qty}×</span>}
                  {it.itemName}
                </p>
                <p className="text-[10px] text-kds-subtext">
                  {it.order.tableLabel ?? it.order.customerName ?? 'Walk-in'} · #{orderRef(it.order.id)}
                  {it.completedAt && <> · {formatDistanceToNowStrict(new Date(it.completedAt))} ago</>}
                </p>
              </div>
              <button
                type="button"
                onClick={() => actions.recall.mutate(it.itemId)}
                disabled={busy}
                className="shrink-0 rounded-md border border-kds-red/60 px-2 py-1 text-[11px] font-black text-kds-red hover:bg-kds-red/10 disabled:opacity-40">
                {busy ? 'Recalling…' : 'Recall'}
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
