'use client'
// One-click merge of two ledger accounts (owner, 2026-11-24; backend accounting/accountMerge.ts). The entries of the
// old account move to the account that is kept, exactly as posted; the old account is switched off. The CEO's merge
// applies at once; finance's goes to the CEO.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { Button, Dialog, DialogFooter, Field, Input } from '@/components/finance/ui'
import { useAuthStore } from '../../../store/auth'

interface Acc { id: string; code: string; name: string; type: string; isActive: boolean }
interface Preview {
  lineCount: number; entryCount: number; debitCents: number; creditCents: number; netCents: number
  firstDate: string | null; lastDate: string | null; subAccounts: number; blockers: { code: string; message: string }[]
}
interface MergeRow {
  id: string; status: string; reason: string; fromCode: string; fromName: string; intoCode: string; intoName: string
  lineCount: number; debitCents: number; creditCents: number; requestedByName: string | null; decidedByName: string | null
  decisionNote: string | null; blockedBy: string | null; canWithdraw: boolean; canUndo: boolean; createdAt: string
}
const KEY = ['account-merges']

export function MergeDialog({ account, accounts, onClose }: { account: Acc; accounts: Acc[]; onClose: () => void }) {
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [intoId, setIntoId] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const choices = accounts.filter((a) => a.type === account.type && a.id !== account.id && a.isActive)
  const { data: preview, isFetching } = useQuery<Preview>({
    queryKey: ['account-merge-preview', account.id, intoId],
    queryFn: () => api.get(`/accounting/account-merges/preview?fromAccountId=${account.id}&intoAccountId=${intoId}`),
    enabled: !!intoId,
  })
  const into = choices.find((a) => a.id === intoId)
  const merge = useMutation({
    mutationFn: () => api.post('/accounting/account-merges', { fromAccountId: account.id, intoAccountId: intoId, reason: reason.trim() }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ['chart-of-accounts'] }); onClose() },
    onError: (e: Error) => setError(e.message || 'The merge did not go through'),
  })
  const blocked = (preview?.blockers.length ?? 0) > 0
  return (
    <Dialog title={`Merge ${account.code} ${account.name}`} onClose={onClose} dirty={!!intoId || !!reason}>
      <div className="space-y-4">
        <p className="text-sm break-words" style={{ color: 'var(--muted)' }}>
          Every entry of <strong>{account.code} {account.name}</strong> moves to the account you pick — same date, narration, voucher number and amount.
          {' '}{account.code} ends empty and is switched off. Nothing new is posted.
        </p>
        <Field label="Move its entries to (the account you keep)" hint={choices.length === 0 ? `No other ${account.type} account is switched on.` : 'Only accounts of the same type are listed.'}>
          <Select value={intoId} onChange={(e) => { setIntoId(e.target.value); setError('') }} className="s-input w-full">
            <option value="">Pick an account…</option>
            {choices.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </Select>
        </Field>
        {intoId && isFetching && !preview && <p className="text-xs" style={{ color: 'var(--muted)' }}>Checking…</p>}
        {preview && into && (
          <div className="rounded-xl p-3 space-y-2 text-sm" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid var(--border)' }}>
            <p className="font-semibold">
              {preview.lineCount === 0 ? `${account.code} has no entries — it is only switched off.` : `${preview.lineCount} line${preview.lineCount === 1 ? '' : 's'} in ${preview.entryCount} entr${preview.entryCount === 1 ? 'y' : 'ies'} will move to ${into.code} ${into.name}`}
            </p>
            {preview.lineCount > 0 && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
                <dt>Debits</dt><dd className="text-right font-mono">{fmtPkr(preview.debitCents)}</dd>
                <dt>Credits</dt><dd className="text-right font-mono">{fmtPkr(preview.creditCents)}</dd>
                <dt>Dated</dt><dd className="text-right">{preview.firstDate} to {preview.lastDate}</dd>
                {preview.subAccounts > 0 && <><dt>Sub-accounts moving too</dt><dd className="text-right">{preview.subAccounts}</dd></>}
              </dl>
            )}
            {preview.blockers.map((b) => (
              <p key={b.code + b.message} role="alert" className="text-xs font-semibold break-words" style={{ color: 'var(--erp-danger)' }}>Cannot merge: {b.message}</p>
            ))}
          </div>
        )}
        <Field label="Reason (at least 10 characters)">
          <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. duplicate of the same expense account" className="w-full" />
        </Field>
        {error && <p role="alert" className="text-xs font-semibold break-words" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
        {!isAdmin && <p className="text-xs" style={{ color: 'var(--muted)' }}>This goes to the CEO. Nothing moves until the CEO approves.</p>}
      </div>
      <DialogFooter onCancel={onClose}>
        <Button variant={isAdmin ? 'danger' : 'primary'} disabled={!intoId || !preview || blocked || reason.trim().length < 10 || merge.isPending} onClick={() => merge.mutate()}>
          {merge.isPending ? 'Working…' : isAdmin ? 'Merge the accounts' : 'Send to the CEO'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** Waiting merges (approve / reject / withdraw) and the latest done ones (the CEO may undo). */
export function MergeRequests() {
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [note, setNote] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const { data } = useQuery<{ items: MergeRow[] }>({ queryKey: KEY, queryFn: () => api.get('/accounting/account-merges') })
  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: unknown }) => api.post(`/accounting/account-merges/${id}/${path}`, body ?? {}),
    onSuccess: () => { setMsg(''); void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ['chart-of-accounts'] }) },
    onError: (e: Error) => setMsg(e.message || 'That did not go through'),
  })
  const rows = (data?.items ?? []).filter((r) => r.status === 'pending' || r.status === 'done').slice(0, 6)
  if (rows.length === 0) return null
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55">Account merges</h2>
      {msg && <p role="alert" className="text-xs font-semibold break-words" style={{ color: 'var(--erp-danger)' }}>{msg}</p>}
      {rows.map((r) => (
        <div key={r.id} className="s-card p-4 space-y-2 border-l-4" style={{ borderLeftColor: r.status === 'pending' ? 'var(--erp-warning)' : 'var(--erp-success)' }}>
          <p className="text-sm font-semibold break-words">
            {r.status === 'pending' ? 'Waiting for the CEO: merge ' : 'Merged: '}{r.fromCode} {r.fromName} → {r.intoCode} {r.intoName}
          </p>
          <p className="text-xs break-words" style={{ color: 'var(--muted)' }}>
            {r.lineCount} line{r.lineCount === 1 ? '' : 's'} · debits {fmtPkr(r.debitCents)} · credits {fmtPkr(r.creditCents)} · asked by {r.requestedByName ?? '—'}: {r.reason}
          </p>
          {r.blockedBy && <p role="alert" className="text-xs break-words" style={{ color: 'var(--erp-danger)' }}>Cannot be merged now: {r.blockedBy}</p>}
          {r.status === 'pending' && isAdmin && (
            <div className="space-y-2">
              <Button disabled={act.isPending || !!r.blockedBy} onClick={() => act.mutate({ id: r.id, path: 'approve' })}>Approve — merge the accounts</Button>
              <div className="flex flex-wrap gap-2 items-center">
                <Input type="text" aria-label="Reason to reject" placeholder="To reject, say why (10+ characters)" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} className="flex-1 min-w-[12rem]" />
                <Button variant="danger" disabled={act.isPending || (note[r.id] ?? '').trim().length < 10} onClick={() => act.mutate({ id: r.id, path: 'reject', body: { note: (note[r.id] ?? '').trim() } })}>Reject</Button>
              </div>
            </div>
          )}
          {r.status === 'pending' && !isAdmin && r.canWithdraw && (
            <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, path: 'withdraw' })}>Withdraw the request</Button>
          )}
          {r.status === 'done' && r.canUndo && (
            <div className="flex flex-wrap gap-2 items-center">
              <Input type="text" aria-label="Reason to undo" placeholder="To undo, say why (10+ characters)" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} className="flex-1 min-w-[12rem]" />
              <Button variant="secondary" disabled={act.isPending || (note[r.id] ?? '').trim().length < 10} onClick={() => act.mutate({ id: r.id, path: 'undo', body: { reason: (note[r.id] ?? '').trim() } })}>Undo this merge</Button>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
