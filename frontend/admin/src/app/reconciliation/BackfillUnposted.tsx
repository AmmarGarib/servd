'use client'
// Closed shifts that never reached the books (owner decision 6): POST
// /reconciliation/backfill-unposted. Admin only. Preview first (dry run),
// then post — a shift whose month is still open posts into its own month; a
// shift in a closed month posts into the CURRENT open month with a memo naming
// its original close date. A locked month is never reopened for it.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

interface Row { shiftId: string; closedAt: string | null; outcome: string; detail: string }
interface Result { dryRun: boolean; rows: Row[]; summary: Record<string, number> }

const LABEL: Record<string, string> = {
  would_post: 'Will post in its own month',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  unbalanced: 'Does not balance — for the accountant',
  shift_has_no_company: 'No company — cannot post',
  no_postable_activity: 'Nothing to post',
  already_posted: 'Already on the books',
  error: 'Error',
}

export function BackfillUnposted() {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [result, setResult] = useState<Result | null>(null)
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Result>('/reconciliation/backfill-unposted', { dryRun }),
    onSuccess: setResult,
  })
  if (!isAdmin) return null
  const postable = (result?.rows ?? []).filter((r) => r.outcome.startsWith('would_post')).length
  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Shifts that never reached the books</h2>
          <p className="text-xs text-s-muted">Closed drawers with no ledger entry. A shift in a closed month posts into the current month with a note; closed months are never reopened.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="s-btn-secondary text-xs">Preview</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending || !result?.dryRun || postable === 0} className="s-btn-primary text-xs">
            Post {postable > 0 ? postable : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{(run.error as Error).message}</p>}
      {result && (
        result.rows.length === 0
          ? <p className="text-xs text-s-muted">Every closed shift is on the books.</p>
          : (
            <table className="w-full text-xs">
              <thead className="text-s-muted"><tr><th className="text-left py-1">Shift</th><th className="text-left py-1">Closed</th><th className="text-left py-1">Outcome</th></tr></thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.shiftId} className="border-t border-s-border">
                    <td className="py-1 font-mono">{r.shiftId.slice(0, 8)}</td>
                    <td className="py-1">{r.closedAt ? new Date(r.closedAt).toLocaleString() : '—'}</td>
                    <td className="py-1" title={r.detail}>{LABEL[r.outcome] ?? r.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
    </div>
  )
}
