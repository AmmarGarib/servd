'use client'
// CEO approvals inbox — recipes a manager submitted for production, awaiting
// the CEO's (admin role) sign-off. Approve flips the recipe to live in place;
// reject sends it back to iteration with an optional note. The API also gates
// these actions to the admin/CEO role, so this page degrades gracefully if a
// non-CEO somehow lands here.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../../lib/api'
import { usePermissions } from '../../../../hooks/useCan'

interface PendingRecipe {
  id: string
  kind: 'plate' | 'component'
  name: string
  brand: string | null
  submittedById: string | null
  submittedAt: string | null
}

export default function RecipeApprovalsPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isCeo = me?.role === 'admin'

  const { data: pending = [], isLoading, isError } = useQuery<PendingRecipe[]>({
    queryKey: ['recipes', 'pending-approval'],
    queryFn: () => api.get('/recipes/pending-approval'),
    enabled: isCeo,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['recipes', 'pending-approval'] })
    void qc.invalidateQueries({ queryKey: ['recipes'] })
  }
  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/recipes/${id}/approve`, {}),
    onSuccess: invalidate,
  })
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/recipes/${id}/reject`, { reason }),
    onSuccess: invalidate,
  })

  const busy = approve.isPending || reject.isPending

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-4xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/accounting/recipes" className="hover:text-s-text">← Recipes</Link>
          </div>
          <h1 className="text-2xl font-black">Recipe approvals</h1>
          <p className="text-sm text-s-muted mt-1">
            Recipes submitted for production, waiting on your sign-off.
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6">
        {!isCeo ? (
          <div className="rounded-xl border border-s-border bg-s-surface p-6 text-sm text-s-muted">
            Only the CEO account can approve recipes for production.
          </div>
        ) : isLoading ? (
          <p className="text-sm text-s-muted">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-s-muted">Couldn't load pending recipes.</p>
        ) : pending.length === 0 ? (
          <div className="rounded-xl border border-s-border bg-s-surface p-6 text-sm text-s-muted">
            Nothing waiting for approval. 🎉
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="rounded-xl border border-s-border bg-s-surface p-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                      style={{ background: 'rgba(99,102,241,0.15)', color: '#A5B4FC' }}>
                      {r.kind === 'component' ? 'Sub recipe' : 'Plate'}
                    </span>
                    <Link href={`/accounting/recipes/${r.id}`} className="font-semibold text-s-text text-sm truncate hover:text-s-teal">
                      {r.name}
                    </Link>
                  </div>
                  <p className="text-[11px] text-s-dim mt-0.5">
                    {r.brand ?? 'Cross-brand'}
                    {r.submittedAt && ` · submitted ${new Date(r.submittedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" disabled={busy}
                    onClick={() => {
                      const reason = window.prompt('Reason for sending this recipe back (optional):') ?? ''
                      reject.mutate({ id: r.id, reason })
                    }}
                    className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold hover:bg-s-bg disabled:opacity-50">
                    Reject
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => approve.mutate(r.id)}
                    className="rounded-lg bg-s-teal text-black px-3 py-1.5 text-xs font-black hover:opacity-90 disabled:opacity-50">
                    Approve → Production
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(approve.isError || reject.isError) && (
          <p className="mt-3 text-xs text-red-400">
            {(approve.error as Error)?.message ?? (reject.error as Error)?.message}
          </p>
        )}
      </main>
    </div>
  )
}
