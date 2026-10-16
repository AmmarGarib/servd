'use client'
// The bell's data (owner, 2026-10-16). Server: GET /notifications/inbox,
// /unread-count, POST /:id/read, /read-all (backend modules/notifications/
// inboxRoutes.ts). Everything lives under NOTIFS_KEY so one invalidation
// (the socket ping, a mutation, a company switch) refreshes all of it.

import { useEffect } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { onNotificationNew } from './socket'

export const NOTIFS_KEY = ['notifications'] as const

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical'

export interface NotificationItem {
  id: string
  kind: string
  severity: NotificationSeverity
  title: string
  body: string | null
  link: string | null
  /** Set by the API: the link's page reads the ACTIVE company, so switch first. */
  switchCompany: boolean
  tenantId: string | null
  companyName: string | null
  createdAt: string
  readAt: string | null
}

interface InboxPage { items: NotificationItem[]; nextCursor: string | null; unread: number }

export type CompanyFilter = 'all' | 'active'

/** GET /notifications/unread-count — the badge. */
export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: [...NOTIFS_KEY, 'unread-count'],
    queryFn: async () => (await api.get<{ unread: number }>('/notifications/unread-count')).unread,
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

/** GET /notifications/inbox, paged by cursor. */
export function useInbox(opts: { unread?: boolean; company?: CompanyFilter; limit?: number; enabled?: boolean } = {}) {
  const { unread = false, company = 'all', limit = 30, enabled = true } = opts
  return useInfiniteQuery({
    queryKey: [...NOTIFS_KEY, 'inbox', { unread, company, limit }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(limit), company })
      if (unread) q.set('unread', '1')
      if (pageParam) q.set('cursor', pageParam)
      return api.get<InboxPage>(`/notifications/inbox?${q.toString()}`)
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 15_000,
  })
}

/** Mark one row read. Optimistic: the dot and the badge drop at once. */
export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/notifications/${id}/read`, {}),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: NOTIFS_KEY })
      const now = new Date().toISOString()
      qc.setQueriesData<{ pages: InboxPage[]; pageParams: unknown[] } | undefined>({ queryKey: [...NOTIFS_KEY, 'inbox'] }, (d) =>
        d && { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: now } : i)) })) })
      qc.setQueryData<number>([...NOTIFS_KEY, 'unread-count'], (n) => (typeof n === 'number' ? Math.max(0, n - 1) : n))
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: NOTIFS_KEY }) },
  })
}

/** Mark everything up to now read (the server ignores rows that arrive later). */
export function useMarkAllRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ updated: number }>('/notifications/read-all', { before: new Date().toISOString() }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: NOTIFS_KEY })
      const now = new Date().toISOString()
      qc.setQueriesData<{ pages: InboxPage[]; pageParams: unknown[] } | undefined>({ queryKey: [...NOTIFS_KEY, 'inbox'] }, (d) =>
        d && { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.readAt ? i : { ...i, readAt: now })) })) })
      qc.setQueryData<number>([...NOTIFS_KEY, 'unread-count'], 0)
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: NOTIFS_KEY }) },
  })
}

/** Live: a 'notification:new' ping (id + kind only) makes everything refetch. */
export function useNotificationSocket(enabled = true) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    return onNotificationNew(() => { void qc.invalidateQueries({ queryKey: NOTIFS_KEY }) })
  }, [enabled, qc])
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Severity accent as a token (never a hard-coded colour). */
export function severityColor(s: NotificationSeverity): string {
  if (s === 'success') return 'var(--erp-success)'
  if (s === 'critical') return 'var(--erp-danger)'
  if (s === 'warning') return 'var(--erp-warning)'
  return 'var(--erp-primary)'
}
