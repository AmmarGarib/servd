'use client'
// "Remove ingredients not in a recipe" — the CEO's clean-up on the Sourcing
// sheet (owner, 2026-10-16). Preview → Confirm → result. API:
// GET/POST /inventory/unused-cleanup (backend modules/inventory/unusedCleanup.ts).
// Everything moved goes to the Trash and can be restored there; ingredients
// holding stock or with purchase history are skipped and listed with why.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { Modal } from '@/components/ui/Modal'
import { stockErrorText } from '../../lib/stockUi'

interface Row { id: string; name: string; unit: string; category: string | null }
interface SkippedRow extends Row { reasons: string[] }
interface Preview { company: { id: string; name: string } | null; toMove: Row[]; skipped: SkippedRow[]; counts: { total: number; inUse: number; toMove: number; skipped: number } }
interface Applied { moved: Row[]; skipped: SkippedRow[]; counts: { requested: number; moved: number; skipped: number } }

function SkippedList({ rows }: { rows: SkippedRow[] }) {
  if (!rows.length) return null
  return (
    <ul className="divide-y divide-s-border rounded-lg border border-s-border max-h-56 overflow-y-auto">
      {rows.map((r) => (
        <li key={r.id} className="px-3 py-2 text-sm">
          <span className="font-semibold text-s-text">{r.name}</span>
          <span className="block text-xs text-s-muted">{r.reasons.join(' · ')}</span>
        </li>
      ))}
    </ul>
  )
}

export function UnusedCleanupModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<Applied | null>(null)
  const preview = useQuery<Preview>({
    queryKey: ['inventory', 'unused-cleanup'],
    queryFn: () => api.get<Preview>('/inventory/unused-cleanup'),
    staleTime: 0,
  })
  const apply = useMutation({
    mutationFn: (itemIds: string[]) => api.post<Applied>('/inventory/unused-cleanup', { itemIds }),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['inventory'] }) },
  })

  const p = preview.data
  const companyName = p?.company?.name ?? 'This company'
  const footer = result ? (
    <div className="flex justify-end">
      <button onClick={onClose} className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm">Done</button>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
      <button
        disabled={!p || p.toMove.length === 0 || apply.isPending}
        onClick={() => p && apply.mutate(p.toMove.map((r) => r.id))}
        className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
        {apply.isPending ? 'Moving…' : `Move ${p?.toMove.length ?? 0} to the Trash`}
      </button>
    </div>
  )

  return (
    <Modal title="Remove ingredients not in a recipe" wide onClose={onClose} dismissible={!apply.isPending} footer={footer}>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-s-text">
            <span className="font-bold text-success">{result.counts.moved} moved to the Trash</span>
            {result.counts.skipped > 0 && <> · {result.counts.skipped} skipped</>}
          </p>
          <p className="text-sm text-s-muted">
            Changed your mind? Every one can be put back from the{' '}
            <Link href="/trash?type=inventory_item" className="text-primary-ink hover:underline">Trash</Link>{' '}
            (Restore).
          </p>
          {result.skipped.length > 0 && (
            <>
              <p className="text-xs font-bold uppercase tracking-wide text-s-muted">Skipped</p>
              <SkippedList rows={result.skipped} />
            </>
          )}
        </div>
      ) : preview.isLoading ? (
        <p className="text-sm text-s-muted">Checking every ingredient of your current company…</p>
      ) : preview.isError || !p ? (
        <p role="alert" className="text-sm text-s-red">{stockErrorText(preview.error)}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-s-muted">
            {companyName}: {p.counts.total} ingredients, {p.counts.inUse} in a recipe. Ingredients that are in no recipe
            (dish, sub-recipe, add-on or packaging) move to the Trash, where they can be restored. Ingredients that hold
            stock or have purchase history stay on the sheet.
          </p>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-s-muted mb-1">
              Will move to the Trash ({p.toMove.length})
            </p>
            {p.toMove.length === 0 ? (
              <p className="text-sm text-s-muted">Nothing to remove — every ingredient is in a recipe, holds stock or has been bought.</p>
            ) : (
              <ul className="divide-y divide-s-border rounded-lg border border-s-border max-h-56 overflow-y-auto">
                {p.toMove.map((r) => (
                  <li key={r.id} className="px-3 py-1.5 text-sm text-s-text flex justify-between gap-3">
                    <span>{r.name}</span><span className="text-xs text-s-muted">{r.unit}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {p.skipped.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-s-muted mb-1">
                Skipped — not in a recipe, but kept ({p.skipped.length})
              </p>
              <SkippedList rows={p.skipped} />
            </div>
          )}
          {apply.isError && <p role="alert" className="text-sm text-s-red">{stockErrorText(apply.error)}</p>}
        </div>
      )}
    </Modal>
  )
}
