'use client'
// Shift corrections — fix a mistake on a closed shift (void a bill, cancel an open ticket).
// Finance lists the fixes and sends ONE set to the CEO; nothing changes until the CEO approves.
// Contract: CLAUDE.md "Shift corrections", backend/src/modules/shiftCorrections/.
import { Button } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { Suspense, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api } from '../../../lib/api'
import { CorrectionDetail } from '../../../components/finance/shiftCorrections/CorrectionDetail'
import { NewCorrection } from '../../../components/finance/shiftCorrections/NewCorrection'
import { type CorrectionSet, type SetStatus, STATUS_BADGE, STATUS_LABEL, fmtDateTime, fmtDay } from '../../../components/finance/shiftCorrections/types'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'

const FILTERS: Array<{ key: SetStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'submitted', label: 'Waiting for CEO' },
  { key: 'applied', label: 'Applied' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'failed', label: 'Failed' },
]

export default function ShiftCorrectionsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-s-muted">Loading…</div>}>
      <ShiftCorrections />
    </Suspense>
  )
}

function ShiftCorrections() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const id = sp.get('id')
  const [status, setStatus] = useState<SetStatus | 'all'>('all')
  const [creating, setCreating] = useState(false)

  const open = (setId: string | null) => router.replace(setId ? `${pathname}?id=${encodeURIComponent(setId)}` : pathname)

  const list = useQuery({
    queryKey: ['shift-corrections', 'list', status],
    queryFn: () => api.get<{ items: CorrectionSet[] }>(`/pos/shift-corrections${status === 'all' ? '' : `?status=${status}`}`),
    enabled: !id && !creating,
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4">
        <p className="text-xs font-medium text-success">Books</p>
        <h1 className="text-xl font-bold text-s-text">Shift corrections</h1>
        <p className="text-xs text-s-muted mt-0.5">Fix a mistake on a closed shift. Finance lists the fixes and sends them to the CEO. Nothing changes until the CEO approves.</p>
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        {id ? (
          <CorrectionDetail key={id} id={id} onBack={() => open(null)} />
        ) : creating ? (
          <NewCorrection onCancel={() => setCreating(false)} onCreated={(s) => { setCreating(false); open(s.id) }} />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" aria-pressed={status === f.key} onClick={() => setStatus(f.key)}
                    className={`rounded-full border px-3 py-1 text-xs ${status === f.key ? 'border-success bg-success/10 text-success font-semibold' : 'border-s-border text-s-muted'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              <Button type="button"  onClick={() => setCreating(true)}>New correction</Button>
            </div>

            {list.isLoading && <p className="text-xs text-s-muted">Loading…</p>}
            {list.error && <p role="alert" className="text-xs text-s-red">{(list.error as Error).message}</p>}
            {list.data && list.data.items.length === 0 && <CompactEmptyState message={`No corrections${status === 'all' ? ' yet' : ' with this status'}.`} />}
            <ul className="space-y-2">
              {(list.data?.items ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => open(c.id)} className="s-card w-full text-left p-3 sm:p-4 space-y-1 hover:border-primary">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-s-text">{c.shift?.cashierName ?? 'Shift'}{c.shift?.locationName ? ` · ${c.shift.locationName}` : ''} · {fmtDay(c.businessDay)}</span>
                      <span className={STATUS_BADGE[c.status]}>{STATUS_LABEL[c.status]}</span>
                    </span>
                    <span className="block text-xs text-s-muted">
                      {c.items.length} {c.items.length === 1 ? 'fix' : 'fixes'} · sent by {c.requestedBy.name ?? 'unknown'} on {fmtDateTime(c.createdAt)}
                    </span>
                    <span className="block text-xs text-s-text truncate">{c.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
