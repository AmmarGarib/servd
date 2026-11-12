'use client'
// Journals between companies (owner, 2026-11-12; backend accounting/mirrorDrafts.ts): another company booked a journal
// on an account linked to one of mine — its side waits here, pre-filled. "Open" loads it into New entry (editable)
// and Post books it; "Dismiss" needs a reason. No CEO approval — the CEO is told.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Input, LinkButton } from '@/components/finance/ui'

export interface MirrorDraftLine { accountId: string | null; accountCode: string | null; accountName: string | null; sourceAccountCode: string; type: 'debit' | 'credit'; amountCents: number; memo: string | null }
export interface MirrorDraft {
  id: string; tenantId: string; sourceTenantId: string; sourceVoucherNo: string | null; status: string
  voucherKind: string; entryDate: string; description: string; lines: MirrorDraftLine[]
  companyName: string | null; sourceCompanyName: string | null; mine: boolean; postedVoucherNo: string | null; note: string | null
}

export function MirrorDrafts({ onOpen, openId }: { onOpen: (d: MirrorDraft) => void; openId: string | null }) {
  const { data = [] } = useQuery<MirrorDraft[]>({
    queryKey: ['journal-drafts', 'pending'],
    queryFn: () => api.get<MirrorDraft[]>('/accounting/journal-drafts?status=pending'),
    staleTime: 30_000,
  })
  const mine = data.filter((d) => d.mine)
  if (mine.length === 0) return null
  return (
    <section className="s-card p-4 space-y-2" aria-label="From other companies">
      <h2 className="text-sm font-bold text-s-text">From other companies ({mine.length})</h2>
      <p className="text-[11px] text-s-muted">Another company booked these with you. Open one to check and post your side (you can change anything before posting), or dismiss it with a reason.</p>
      <ul className="divide-y divide-s-border/50">
        {mine.map((d) => <Row key={d.id} d={d} open={openId === d.id} onOpen={() => onOpen(d)} />)}
      </ul>
    </section>
  )
}

function Row({ d, open, onOpen }: { d: MirrorDraft; open: boolean; onOpen: () => void }) {
  const qc = useQueryClient()
  const [dismissing, setDismissing] = useState(false)
  const [note, setNote] = useState('')
  const dismiss = useMutation({
    mutationFn: () => api.post(`/accounting/journal-drafts/${d.id}/dismiss`, { note: note.trim() }, { tenantId: d.tenantId }),
    onSuccess: () => { setDismissing(false); void qc.invalidateQueries({ queryKey: ['journal-drafts'] }) },
  })
  const amount = d.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-s-muted whitespace-nowrap">{d.entryDate.slice(0, 10)}</span>
        <span className="text-sm text-s-text flex-1 min-w-[12rem] break-words">
          <span className="font-semibold">{d.voucherKind}</span> for {d.companyName ?? 'your company'} — {d.description}
        </span>
        <span className="font-mono text-sm whitespace-nowrap">{fmtPkr(amount)}</span>
        <LinkButton size="md" type="button" onClick={onOpen} disabled={open}>{open ? 'Open below' : 'Open'}</LinkButton>
        <LinkButton tone="muted" size="md" type="button" onClick={() => setDismissing((x) => !x)}>Dismiss</LinkButton>
      </div>
      <p className="text-[11px] text-s-muted">
        From {d.sourceCompanyName ?? 'another company'}{d.sourceVoucherNo ? ` · ${d.sourceVoucherNo}` : ''} ·{' '}
        {d.lines.map((l) => `${l.type === 'debit' ? 'Dr' : 'Cr'} ${l.accountCode ?? `(pick — theirs ${l.sourceAccountCode})`}`).join(' / ')}
      </p>
      {dismissing && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why it is not booked (at least 10 characters)" className="flex-1 min-w-[14rem]" />
          <LinkButton size="md" type="button" disabled={note.trim().length < 10 || dismiss.isPending} onClick={() => dismiss.mutate()}>{dismiss.isPending ? 'Saving…' : 'Dismiss it'}</LinkButton>
          {dismiss.error && <p role="alert" className="w-full text-xs text-s-red">{(dismiss.error as Error).message}</p>}
        </div>
      )}
    </li>
  )
}
