'use client'
// Trash — everything deleted, voided or cancelled, until the CEO empties it
// (owner request 2026-10-15). Masters (menu items, promos, logins…) are
// RESTORED; voided / cancelled transactions are recovered as a NEW COPY and
// the original stays as it was. Only the CEO deletes forever; money, tax and
// stock records are archived, never erased. The API lists per type: a login
// sees only the types its modules and role allow, for the company in view.

import { Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { EMPTY_FILTERS, useTrashList, useTrashTypes, type TrashFilters, type TrashItem, type TrashState } from '../../lib/trash'
import { TrashFilterBar } from '../../components/trash/TrashFilters'
import { TrashRow } from '../../components/trash/TrashRow'
import { TrashDetail } from '../../components/trash/TrashDetail'
import { ClashDialog, InUseDialog } from '../../components/trash/TrashDialogs'
import { useTrashActions } from '../../components/trash/useTrashActions'

export default function TrashPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <Trash />
    </Suspense>
  )
}

function Trash() {
  const params = useSearchParams()
  const isCeo = useAuthStore((s) => s.isRole('admin'))
  const [filters, setFilters] = useState<TrashFilters>(() => ({
    ...EMPTY_FILTERS,
    type: params?.get('type') ?? '',
    q: params?.get('q') ?? '',
    state: (params?.get('state') as TrashState | null) ?? 'in_trash',
  }))
  const [openKey, setOpenKey] = useState<{ type: string; id: string } | null>(() => {
    const t = params?.get('type'); const id = params?.get('id')
    return t && id ? { type: t, id } : null
  })
  const { data: types = [] } = useTrashTypes()
  const list = useTrashList(filters)
  const actions = useTrashActions({ onOpenParent: (p) => setOpenKey(p) })

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const typeLabel = (t: string) => types.find((x) => x.key === t)?.label ?? t.replace(/_/g, ' ')
  const showCompany = new Set(items.map((i) => i.tenantId)).size > 1
  const opened: TrashItem | null = openKey ? items.find((i) => i.type === openKey.type && i.id === openKey.id) ?? null : null

  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
      <p className="text-[11px] font-bold uppercase tracking-wider text-success">CEO</p>
      <h1 className="text-2xl sm:text-3xl font-black text-white/90">Trash</h1>
      <p className="text-sm text-white/50 mt-1 max-w-3xl">
        Deleted items wait here until the CEO deletes them forever. Restore an item to put it back, or recover a
        voided or cancelled transaction as a new copy &mdash; the original stays as it was. Money, tax and stock
        records are never erased.
      </p>

      <TrashFilterBar value={filters} onChange={setFilters} types={types} isCeo={isCeo} />

      <div className="mt-5">
        {list.isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {list.error && <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>Could not load the Trash: {(list.error as Error).message}</p>}
        {!list.isLoading && !list.error && items.length === 0 && (
          <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <p className="text-sm font-bold text-white/70">{types.length === 0 ? 'Nothing here is yours to recover.' : 'The Trash is empty.'}</p>
            <p className="text-xs text-white/40 mt-1">
              {types.length === 0 ? 'Your role and modules do not cover any Trash type.' : 'Nothing matches these filters.'}
            </p>
          </div>
        )}
        <ul className="space-y-3">
          {items.map((i) => (
            <TrashRow key={`${i.type}:${i.id}:${i.at}`} item={i} typeLabel={typeLabel(i.type)} showCompany={showCompany} isCeo={isCeo}
              busy={actions.isBusy(i)} onOpen={() => setOpenKey({ type: i.type, id: i.id })}
              onRestore={() => void actions.restore(i)} onCopy={() => void actions.copy(i)}
              onPurge={() => void actions.purge(i)} onArchive={(undo) => void actions.archive(i, undo)} />
          ))}
        </ul>
        {list.hasNextPage && (
          <div className="mt-4 text-center">
            <button className="s-btn-secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          </div>
        )}
      </div>

      {opened && (
        <TrashDetail item={opened} typeLabel={typeLabel(opened.type)} isCeo={isCeo} busy={actions.isBusy(opened)}
          onClose={() => setOpenKey(null)} onRestore={() => void actions.restore(opened)} onCopy={() => void actions.copy(opened)}
          onPurge={() => void actions.purge(opened)} onArchive={(undo) => void actions.archive(opened, undo)}
          onOpenParent={(p) => setOpenKey(p)} />
      )}
      {actions.clash && (
        <ClashDialog state={actions.clash} busy={actions.isBusy(actions.clash.item)} onClose={() => actions.setClash(null)}
          onRestore={(rename) => void actions.restore(actions.clash!.item, { rename })} />
      )}
      {actions.inUse && <InUseDialog item={actions.inUse.item} refs={actions.inUse.refs} onClose={() => actions.setInUse(null)} />}
    </div>
  )
}
