'use client'
// What an edit / cancel request changes: GET /accounting/journal-requests/:id/diff
// (date, description, reference, total before -> after, lines added / removed).
// Used by the Requests tab and the approvals inbox. Loads only when opened.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { LinkButton } from '@/components/finance/ui'

interface DiffLine { accountId?: string; accountCode?: string; accountName?: string; type: 'debit' | 'credit'; amountCents: number; memo?: string | null }
interface Diff {
  request: { id: string; kind: string }
  entry: { voucherNo: string | null; entryDate: string; description: string; operatorReference: string | null; totalCents: number; reversed?: boolean }
  proposed: { entryDate: string; description: string; operatorReference: string | null; totalCents: number } | null
  changes: {
    kind: string
    date: boolean
    description: boolean
    reference: boolean
    totalBeforeCents: number
    totalAfterCents: number | null
    linesAdded: DiffLine[]
    linesRemoved: DiffLine[]
  }
  stale: boolean
}

const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : '—')
const lineText = (l: DiffLine) =>
  `${l.accountCode ? `${l.accountCode} ` : ''}${l.accountName ?? ''} · ${l.type === 'debit' ? 'Dr' : 'Cr'} ${fmtPkr(l.amountCents)}${l.memo ? ` · ${l.memo}` : ''}`.trim()

function Change({ label, c, fmt = (v: string | null) => v ?? '—' }: { label: string; c?: { before: string | null; after: string | null } | null; fmt?: (v: string | null) => string }) {
  if (!c) return null
  return (
    <p className="text-xs text-s-text break-words">
      <span className="text-s-muted">{label}: </span>{fmt(c.before)} <span className="text-s-muted">→</span> <span className="font-semibold">{fmt(c.after)}</span>
    </p>
  )
}

export function JournalRequestDiff({ requestId, tenantId, startOpen }: { requestId: string; tenantId?: string | null; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!startOpen)
  const { data, isLoading, error } = useQuery<Diff>({
    queryKey: ['journal-request-diff', requestId],
    queryFn: () => api.get(`/accounting/journal-requests/${requestId}/diff`),
    enabled: open,
  })
  void tenantId
  return (
    <div className="space-y-1">
      <LinkButton tone="primary" type="button" onClick={() => setOpen((o) => !o)}>{open ? 'Hide what changes' : 'Show what changes'}</LinkButton>
      {open && isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {open && error && <p role="alert" className="text-xs text-s-red">{(error as Error).message}</p>}
      {open && data && (
        <div className="rounded-lg border border-s-border p-2 space-y-1">
          {data.stale && (
            <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--erp-warning)' }}>
              Stale — the entry changed after this was requested. Approving will be refused; send it back.
            </p>
          )}
          <p className="text-xs text-s-muted">Entry {data.entry.voucherNo ?? ''} · {day(data.entry.entryDate)} · {data.entry.description}</p>
          {data.changes.kind === 'reverse' ? (
            <p className="text-xs text-s-text">Cancel the entry: a reversing entry for {fmtPkr(data.entry.totalCents)} is posted.</p>
          ) : (
            <>
              {data.proposed && data.changes.date && <Change label="Date" c={{ before: data.entry.entryDate, after: data.proposed.entryDate }} fmt={day} />}
              {data.proposed && data.changes.description && <Change label="Description" c={{ before: data.entry.description, after: data.proposed.description }} />}
              {data.proposed && data.changes.reference && <Change label="Reference" c={{ before: data.entry.operatorReference, after: data.proposed.operatorReference }} />}
              <p className="text-xs text-s-text">
                <span className="text-s-muted">Total: </span>{fmtPkr(data.changes.totalBeforeCents)} <span className="text-s-muted">→</span>{' '}
                <span className="font-semibold">{data.changes.totalAfterCents === null ? '—' : fmtPkr(data.changes.totalAfterCents)}</span>
              </p>
              {data.changes.linesRemoved.length > 0 && (
                <ul className="text-xs">
                  {data.changes.linesRemoved.map((l, i) => <li key={i} className="break-words" style={{ color: 'var(--erp-danger)' }}>Removed: {lineText(l)}</li>)}
                </ul>
              )}
              {data.changes.linesAdded.length > 0 && (
                <ul className="text-xs">
                  {data.changes.linesAdded.map((l, i) => <li key={i} className="break-words text-success">Added: {lineText(l)}</li>)}
                </ul>
              )}
              {!data.changes.date && !data.changes.description && !data.changes.reference && data.changes.linesAdded.length === 0 && data.changes.linesRemoved.length === 0 && (
                <p className="text-xs text-s-muted">No line or text differences.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
