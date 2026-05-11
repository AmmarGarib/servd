'use client'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getSocket } from '../lib/socket'

// Subscribes to reservation events and invalidates the relevant React Query
// caches so the UI refetches automatically. The backend joins staff sockets
// to the `reservations:all` room on connect, and clients can join a
// per-concept room via `reservations:join`.
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
    const socket = getSocket()

    if (conceptId) {
      socket.emit('reservations:join', { conceptId })
    }

    const handlers: Array<[string, (payload: unknown) => void]> = []
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
      socket.on(event, handler)
      handlers.push([event, handler])
    }

    return () => {
      for (const [event, handler] of handlers) {
        socket.off(event, handler)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptId, ...(queryKeys ?? []).flat().map(String)])
}
