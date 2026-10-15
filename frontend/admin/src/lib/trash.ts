'use client'
// Trash bin — client helpers (spec §2.6). The server registry
// (backend/src/modules/trash/registry.ts) is the ONE list of types: labels,
// module, kind and which actions a login may use all come from
// GET /trash/types and GET /trash. Nothing here keeps a second copy of it.
//
// Prefill: a "Recover as copy" of a transaction that cannot be re-created by
// the server is handed to the module's create form through
// sessionStorage['servd.prefill.<type>']. The form calls useTrashPrefill(type)
// once on mount; the value is read and cleared in the same step.

import { useEffect, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export type TrashKind = 'master' | 'transaction'
export type TrashState = 'in_trash' | 'restored' | 'purged' | 'archived'

export interface TrashTypeInfo {
  key: string
  label: string
  kind: TrashKind
  moduleId?: string
  /** Open entries in the active scope. */
  count: number
  canRestore?: boolean
  canCopy?: boolean
}

export interface TrashItem {
  type: string
  id: string
  kind: TrashKind
  title: string
  subtitle?: string | null
  tenantId: string | null
  companyName?: string | null
  brandName?: string | null
  /** When it was deleted / voided / cancelled. */
  at: string
  byName?: string | null
  reason?: string | null
  state: TrashState
  restoredAt?: string | null
  restoredByName?: string | null
  purgedAt?: string | null
  archivedAt?: string | null
  /** The transaction's own status label ("Cancelled", "Voided"…). */
  statusLabel?: string | null
  canRestore?: boolean
  canCopy?: boolean
  notCopyableReason?: string | null
  erasable?: boolean
  copies?: { count: number; lastByName?: string | null; lastAt?: string | null }
}

export interface TrashListPage { items: TrashItem[]; nextCursor?: string | null }

export interface TrashFilters {
  tab: 'all' | 'master' | 'transaction'
  type: string
  module: string
  state: TrashState
  from: string
  to: string
  q: string
}

export const EMPTY_FILTERS: TrashFilters = { tab: 'all', type: '', module: '', state: 'in_trash', from: '', to: '', q: '' }

export const TRASH_ROOT = 'trash'
export const TRASH_TYPES_KEY = [TRASH_ROOT, 'types'] as const

export function useTrashTypes() {
  return useQuery({
    queryKey: TRASH_TYPES_KEY,
    queryFn: async () => {
      const r = await api.get<{ types: TrashTypeInfo[] } | TrashTypeInfo[]>('/trash/types')
      return Array.isArray(r) ? r : (r.types ?? [])
    },
    staleTime: 60_000,
  })
}

function listQuery(f: TrashFilters, cursor?: string): string {
  const p = new URLSearchParams()
  if (f.tab !== 'all') p.set('kind', f.tab)
  if (f.type) p.set('type', f.type)
  if (f.module) p.set('module', f.module)
  p.set('state', f.state)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.q.trim()) p.set('q', f.q.trim())
  if (cursor) p.set('cursor', cursor)
  p.set('limit', '50')
  return p.toString()
}

export function useTrashList(filters: TrashFilters) {
  return useInfiniteQuery({
    queryKey: [TRASH_ROOT, 'list', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<TrashListPage>(`/trash?${listQuery(filters, pageParam)}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

export interface TrashDetailData {
  item: TrashItem
  /** Field preview of the snapshot / row, label → value. */
  preview?: Array<{ label: string; value: string }>
  parent?: { type: string; id: string; title: string; inTrash: boolean } | null
  references?: Array<{ label: string; count: number }>
  history?: Array<{ at: string; action: string; byName?: string | null; note?: string | null }>
  copyHistory?: Array<{ at: string; byName?: string | null; newId?: string | null; link?: string | null }>
}

export function useTrashDetail(type: string | null, id: string | null) {
  return useQuery({
    queryKey: [TRASH_ROOT, 'detail', type, id],
    enabled: !!type && !!id,
    queryFn: () => api.get<TrashDetailData>(`/trash/${encodeURIComponent(type!)}/${encodeURIComponent(id!)}`),
  })
}

/** Refetch the list, the type counts and any open detail. */
export function useRefreshTrash() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: [TRASH_ROOT] })
}

export interface RestoreResult { type: string; id: string; link?: string | null }

export function restoreFromTrash(
  type: string, id: string, opts: { rename?: Record<string, string>; unlink?: boolean; reason?: string } = {},
): Promise<RestoreResult> {
  return api.post<RestoreResult>(`/trash/${encodeURIComponent(type)}/${encodeURIComponent(id)}/restore`, opts)
}

export type CopyResult =
  | { mode: 'created'; id: string; link: string }
  | { mode: 'prefill'; link: string; payload: unknown }

export const PREFILL_PREFIX = 'servd.prefill.'

export async function copyFromTrash(type: string, id: string): Promise<CopyResult> {
  const r = await api.post<CopyResult>(`/trash/${encodeURIComponent(type)}/${encodeURIComponent(id)}/copy`, {})
  if (r.mode === 'prefill') {
    try { sessionStorage.setItem(PREFILL_PREFIX + type, JSON.stringify(r.payload ?? {})) } catch { /* private window: the form opens empty */ }
  }
  return r
}

export function purgeFromTrash(type: string, id: string, reason: string) {
  // api.delete carries no body, so the reason travels in the query string
  // (the Trash route reads `reason` from either; see the C1 hand-off note).
  return api.delete<void>(`/trash/${encodeURIComponent(type)}/${encodeURIComponent(id)}?reason=${encodeURIComponent(reason)}`)
}

export function archiveInTrash(type: string, id: string, undo = false) {
  return api.post<void>(`/trash/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${undo ? 'unarchive' : 'archive'}`, {})
}

/**
 * A create form calls this once on mount. Returns the payload a "Recover as
 * copy" left for this type (then clears it), or null. Stays null on the
 * server render, so the first paint matches.
 */
export function useTrashPrefill<T = Record<string, unknown>>(type: string): T | null {
  const [payload, setPayload] = useState<T | null>(null)
  useEffect(() => {
    try {
      const key = PREFILL_PREFIX + type
      const raw = sessionStorage.getItem(key)
      if (!raw) return
      sessionStorage.removeItem(key)
      setPayload(JSON.parse(raw) as T)
    } catch { /* storage blocked or bad JSON: no prefill */ }
  }, [type])
  return payload
}
