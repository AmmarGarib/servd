// React Query hooks for the rider API. One query key per resource so the
// layout (shift + active-job sync) and the screens share a single fetch.

import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { sessionStore, useSessionStore } from '../store/session'
import { isOnShift, type Job, type Rider } from './types'

export const qk = {
  me:   ['rider', 'me'] as const,
  jobs: ['rider', 'jobs'] as const,
  job:  (orderId: string) => ['rider', 'job', orderId] as const,
}

const JOBS_POLL_MS = 15_000

export function useMe() {
  const token = useSessionStore(s => s.token)
  return useQuery({
    queryKey: qk.me,
    enabled: !!token,
    queryFn: async () => {
      const d = await api.get<{ rider: Rider }>('/rider/me')
      // Keep the cached profile (shown before the first fetch lands) fresh.
      void sessionStore.getState().setRider(d.rider)
      return d
    },
    refetchInterval: 60_000,
  })
}

/** On shift per the server; falls back to the profile saved at sign-in. */
export function useOnShift(): boolean {
  const me = useMe()
  const cached = useSessionStore(s => s.rider?.status)
  return isOnShift(me.data?.rider.status ?? cached)
}

export function useJobs() {
  const token = useSessionStore(s => s.token)
  const onShift = useOnShift()
  return useQuery({
    queryKey: qk.jobs,
    enabled: !!token,
    queryFn: () => api.get<{ jobs: Job[] }>('/rider/jobs'),
    // Poll while on shift so a new offer shows up without a pull. Off shift
    // the list only refreshes on pull / focus.
    refetchInterval: onShift ? JOBS_POLL_MS : false,
  })
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404
}

export function useJob(orderId: string, enabled = true) {
  const token = useSessionStore(s => s.token)
  return useQuery({
    queryKey: qk.job(orderId),
    enabled: enabled && !!token && !!orderId,
    queryFn: () => api.get<{ job: Job }>(`/rider/jobs/${encodeURIComponent(orderId)}`),
    // A job that is no longer this rider's (404) stays gone — stop polling it.
    refetchInterval: (query) => (isNotFound(query.state.error) ? false : JOBS_POLL_MS),
    retry: (count, err) => !isNotFound(err) && count < 2,
  })
}
