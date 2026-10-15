'use client'
// The four Trash actions and their 409 handling, shared by the list row and
// the detail drawer so both behave the same.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ApiError } from '../../lib/api'
import { useConfirm } from '../ui/ConfirmDialog'
import {
  archiveInTrash, copyFromTrash, purgeFromTrash, restoreFromTrash, useRefreshTrash,
  type TrashItem,
} from '../../lib/trash'

export interface Clash { field: string; value: string; suggestion?: string; renamable: boolean }
export interface ClashState { item: TrashItem; clash: Clash; message: string }

const keyOf = (i: Pick<TrashItem, 'type' | 'id'>) => `${i.type}:${i.id}`

export function useTrashActions(opts: { onOpenParent?: (parent: { type: string; id: string }) => void } = {}) {
  const router = useRouter()
  const confirm = useConfirm()
  const refresh = useRefreshTrash()
  const [busy, setBusy] = useState<string | null>(null)
  const [clash, setClash] = useState<ClashState | null>(null)
  const [inUse, setInUse] = useState<{ item: TrashItem; refs: Array<{ label: string; count: number }> } | null>(null)

  async function run(item: TrashItem, fn: () => Promise<void>) {
    setBusy(keyOf(item))
    try { await fn() } finally { setBusy(null) }
  }

  async function restore(item: TrashItem, o: { rename?: Record<string, string>; unlink?: boolean } = {}) {
    await run(item, async () => {
      try {
        const r = await restoreFromTrash(item.type, item.id, o)
        toast.success(`${item.title} restored`, r.link ? { action: { label: 'Open', onClick: () => router.push(r.link!) } } : undefined)
        setClash(null)
        await refresh()
      } catch (e) {
        if (!(e instanceof ApiError)) { toast.error('Could not restore'); return }
        const d = (e.details ?? {}) as Record<string, any>
        if (e.code === 'TRASH_CLASH') {
          setClash({ item, clash: { field: d.field ?? '', value: d.value ?? '', suggestion: d.suggestion, renamable: !!d.renamable }, message: e.message })
        } else if (e.code === 'PARENT_IN_TRASH' && d.parent) {
          toast.error(e.message, {
            action: opts.onOpenParent ? { label: `Restore ${d.parent.title ?? 'it'} first`, onClick: () => opts.onOpenParent!(d.parent) } : undefined,
          })
        } else if (e.code === 'ALREADY_RESTORED') {
          toast.message('Already restored by someone else')
          await refresh()
        } else {
          toast.error(e.message)
        }
      }
    })
  }

  async function copy(item: TrashItem) {
    await run(item, async () => {
      try {
        const r = await copyFromTrash(item.type, item.id)
        if (r.mode === 'created') {
          toast.success('Draft created', { action: { label: 'Open', onClick: () => router.push(r.link) } })
          await refresh()
        } else {
          router.push(r.link)
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not copy')
      }
    })
  }

  async function purge(item: TrashItem) {
    const r = await confirm({
      title: `Delete "${item.title}" forever?`,
      body: 'This cannot be undone. Money, tax and stock records are never erased.',
      confirmLabel: 'Delete forever', danger: true,
      reason: { label: 'Why is it being erased?', minLength: 10 },
    })
    if (!r) return
    await run(item, async () => {
      try {
        await purgeFromTrash(item.type, item.id, r.reason ?? '')
        toast.success('Deleted forever')
        await refresh()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'IN_USE') {
          const refs = ((e.details as { references?: Array<{ label: string; count: number }> } | undefined)?.references) ?? []
          setInUse({ item, refs })
        } else toast.error(e instanceof ApiError ? e.message : 'Could not delete')
      }
    })
  }

  async function archive(item: TrashItem, undo = false) {
    await run(item, async () => {
      try {
        await archiveInTrash(item.type, item.id, undo)
        toast.success(undo ? 'Back in the list' : 'Archived')
        await refresh()
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not update')
      }
    })
  }

  return { busy, isBusy: (i: TrashItem) => busy === keyOf(i), restore, copy, purge, archive, clash, setClash, inUse, setInUse }
}
