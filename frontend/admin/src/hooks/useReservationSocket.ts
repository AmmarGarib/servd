'use client'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRealtime } from '../lib/realtime'

// Subscribes to reservation events and invalidates the relevant React Query
// caches so the UI refetches automatically. Live updates arrive over
// whichever transport the backend hands out (Supabase broadcast or
// socket.io — see lib/realtime.ts); joining a concept's reservation room is
// just asking `getRealtime` for that conceptId's topics.
//
// Usage:
//   const queryKeys = [['kitchen-tracker'], ['reservations']]
//   useReservationSocket({ conceptId, queryKeys })
//
// Pass any number of query-key prefixes — every event invalidates all of
// them. Cheap because React Query refetches lazily.

export type ReservationEvent =
  | 'reservation:created'
  | 'reservation:updated'
  | 'reservation:cancelled'
  | 'reservation:seated'
  | 'reservation:no-show'
  | 'reservation:confirmed'
  | 'reservation:waitlist-promoted'

const EVENTS: ReservationEvent[] = [
  'reservation:created',
  'reservation:updated',
  'reservation:cancelled',
  'reservation:seated',
  'reservation:no-show',
  'reservation:confirmed',
  'reservation:waitlist-promoted',
]

interface Options {
  conceptId?: string
  queryKeys?: ReadonlyArray<readonly unknown[]>
  onEvent?: (event: ReservationEvent, payload: unknown) => void
}

export function useReservationSocket({ conceptId, queryKeys, onEvent }: Options = {}) {
  const qc = useQueryClient()

  useEffect(() => {
    // Passing conceptId through is what used to be a separate
    // `reservations:join` emit — the realtime token endpoint now grants the
    // concept's reservation topics up front, based on the same conceptId.
    const realtime = getRealtime({ conceptId })

    const unsubs: Array<() => void> = []
    for (const event of EVENTS) {
      const handler = (payload: unknown) => {
        // Refetch all caller-supplied queries on any reservation event.
        // We don't try to merge incremental updates locally — the data
        // shapes vary too much per page. A single refetch keeps everything
        // honest with negligible cost.
        for (const key of queryKeys ?? []) {
          qc.invalidateQueries({ queryKey: key as unknown[] })
        }
        onEvent?.(event, payload)
      }
      unsubs.push(realtime.on(event, handler))
    }

    return () => {
      for (const unsub of unsubs) unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptId, ...(queryKeys ?? []).flat().map(String)])
}
