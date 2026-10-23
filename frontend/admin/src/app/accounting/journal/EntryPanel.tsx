'use client'
// One journal entry in a side panel (Journals and Accounts tabs): its lines,
// status, change history and text edit history, with Edit text / Edit amounts /
// Cancel entry per the row's own flags (canTextEdit, canRequestChange,
// blockedReason). The server decides every right; this file keeps no role list.
//   • Edit text   PATCH /accounting/journal/:id/text   — applies at once.
//   • Edit amounts hands the entry to the posting form (amend mode).
//   • Cancel      POST  /accounting/journal/:id/reverse — CEO 201, finance 202.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Button, ErrorBanner, Field, Input, LinkButton, SidePanel } from '@/components/finance/ui'
import { RecordFiles } from '@/components/files/RecordFiles'
import { StatusBadge, SubAccountSelect, readableDescription } from './JournalBits'
import { PENDING_MSG, isPending, pktDate, type EntryDetail, type RegRow } from './journalTypes'

const inputCls = 'py-1.5'

function brief(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return '—' }
}

/** A text edit's before / after as "field: old -> new" lines. */
function editLines(before: unknown, after: unknown): string[] {
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
  return keys.map((k) => `${k}: ${brief(b[k])} → ${brief(a[k])}`)
}

export function EntryPanel({ entryId, tenantId, onClose, onEditAmounts }: {
  entryId: string
  tenantId?: string | null
  onClose: () => void
  /** Opens the posting form pre-filled in amend mode. */
  onEditAmounts: (e: RegRow) => void
}) {
  const qc = useQueryClient()
  const pin = tenantId ? { tenantId } : undefined
  const { data, isLoading, error } = useQuery<EntryDetail>({
    queryKey: ['journal-entry', entryId],
    queryFn: () => api.get(`/accounting/journals/${entryId}`),
  })
  const [mode, setMode] = useState<'view' | 'text' | 'cancel'>('view')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // text edit draft
  const [desc, setDesc] = useState('')
  const [ref, setRef] = useState('')
  const [memos, setMemos] = useState<Record<string, string>>({})
  const [subs, setSubs] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')

  const e = data?.entry
  const singleSub = (l: RegRow['lines'][number]) => (l.subAccounts.length === 1 ? l.subAccounts[0]!.subAccountId : '')

  function startText() {
    if (!e) return
    setDesc(e.description); setRef(e.operatorReference ?? '')
    setMemos(Object.fromEntries(e.lines.map((l) => [l.id, l.memo ?? ''])))
    setSubs(Object.fromEntries(e.lines.map((l) => [l.id, singleSub(l)])))
    setMsg(null); setMode('text')
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['journal-entry'] })
    void qc.invalidateQueries({ queryKey: ['journals'] })
    void qc.invalidateQueries({ queryKey: ['account-statement'] })
    void qc.invalidateQueries({ queryKey: ['ledger'] })
  }

  const saveText = useMutation({
    mutationFn: () => {
      if (!e) throw new Error('Entry not loaded')
      const body: Record<string, unknown> = {}
      if (desc.trim() !== e.description) body['description'] = desc.trim()
      if (ref.trim() !== (e.operatorReference ?? '')) body['reference'] = ref.trim()
      const m = e.lines.filter((l) => (memos[l.id] ?? '') !== (l.memo ?? '')).map((l) => ({ lineId: l.id, memo: memos[l.id] ?? '' }))
      if (m.length) body['memos'] = m
      const s = e.lines.filter((l) => l.subAccounts.length <= 1 && (subs[l.id] ?? '') !== singleSub(l))
        .map((l) => ({ lineId: l.id, subAccountId: subs[l.id] || null }))
      if (s.length) body['subAccounts'] = s
      return api.patch(`/accounting/journal/${entryId}/text`, body, pin)
    },
    onSuccess: () => { setMode('view'); setMsg({ ok: true, text: 'Saved' }); refresh() },
    onError: (x: Error) => setMsg({ ok: false, text: x.message }),
  })

  const cancel = useMutation({
    mutationFn: () => api.post<unknown>(`/accounting/journal/${entryId}/reverse`, { reason: reason.trim() }, pin),
    onSuccess: (r) => {
      setMode('view'); setReason('')
      setMsg({ ok: true, text: isPending(r) ? PENDING_MSG : 'Cancelled — a reversing entry is posted.' })
      refresh()
    },
    onError: (x: Error) => setMsg({ ok: false, text: x.message }),
  })

  const dirty = !!e && (
    desc.trim() !== e.description || ref.trim() !== (e.operatorReference ?? '')
    || e.lines.some((l) => (memos[l.id] ?? '') !== (l.memo ?? '') || (l.subAccounts.length <= 1 && (subs[l.id] ?? '') !== singleSub(l))))

  const canChange = !!e && e.canRequestChange && e.status === 'live' && !e.pendingChange
  const total = e ? e.totalCents : 0

  return (
    <SidePanel wide title={e ? `${e.voucherNo ?? 'Entry'} · ${fmtPkr(total)}` : 'Journal entry'}
      subtitle={e ? `${pktDate(e.entryDate)}${e.companyName ? ` · ${e.companyName}` : ''}` : undefined} onClose={onClose}>
      {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {error && <ErrorBanner message={(error as Error).message} />}
      {e && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={e.status} />
            {e.reverses && <span className="text-xs text-s-muted">Reverses another entry</span>}
            {e.reversedBy && <span className="text-xs text-s-muted">Reversed on {pktDate(e.reversedBy.entryDate)}</span>}
            {e.postedBy && <span className="text-xs text-s-muted">Posted by {e.postedBy.name}</span>}
          </div>

          {e.pendingChange && (
            <div role="status" className="rounded-lg border border-s-border p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
              <p className="font-semibold text-s-text">Awaiting CEO — {e.pendingChange.kind === 'reverse' ? 'cancel' : 'edit'} requested</p>
              <p className="text-xs text-s-muted">
                Raised by {e.pendingChange.preparedByName ?? '—'}{e.pendingChange.submittedAt ? ` on ${pktDate(e.pendingChange.submittedAt)}` : ''}.
                {e.pendingChange.reason ? ` Why: ${e.pendingChange.reason}` : ''}
              </p>
              <p className="text-xs text-s-muted">The CEO decides it in the approvals inbox. Nothing changes in the books until then.</p>
            </div>
          )}

          {msg && (
            <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-success' : 'text-s-red'}`}>{msg.text}</p>
          )}

          {mode === 'text' ? (
            <div className="space-y-3">
              <Field label="Description"><Input value={desc} maxLength={300} onChange={(x) => setDesc(x.target.value)} className={inputCls} /></Field>
              <Field label="Cheque / bank reference"><Input value={ref} maxLength={60} onChange={(x) => setRef(x.target.value)} className={inputCls} /></Field>
              <div className="space-y-2">
                {e.lines.map((l) => (
                  <div key={l.id} className="rounded-lg border border-s-border p-2 space-y-1">
                    <p className="text-xs text-s-text"><span className="font-mono text-s-muted mr-1">{l.accountCode}</span>{l.accountName}
                      <span className="text-s-muted"> · {l.type === 'debit' ? 'Dr' : 'Cr'} {fmtPkr(l.amountCents)}</span></p>
                    <Input aria-label={`Memo for ${l.accountCode}`} value={memos[l.id] ?? ''} maxLength={200} placeholder="Memo"
                      onChange={(x) => setMemos((m) => ({ ...m, [l.id]: x.target.value }))} className={inputCls} />
                    {l.subAccounts.length > 1
                      ? <p className="text-xs text-s-muted">Split across {l.subAccounts.length} sub-accounts — set on the Accounts tab.</p>
                      : <SubAccountSelect accountId={l.accountId} label={`Sub-account for ${l.accountCode}`} value={subs[l.id] ?? ''}
                        onChange={(v) => setSubs((s) => ({ ...s, [l.id]: v }))} />}
                  </div>
                ))}
              </div>
              <p className="text-xs text-s-muted">Text changes apply at once and are kept in the edit history. Amounts, accounts, brand and date are changed with Edit amounts.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => { setMsg(null); saveText.mutate() }} disabled={!dirty || !desc.trim() || saveText.isPending}>
                  {saveText.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="ghost" type="button" onClick={() => setMode('view')}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <p className="text-sm font-semibold text-s-text break-words">{readableDescription(e.description)}</p>
                <p className="text-xs text-s-muted">
                  {e.reference ? <span className="font-mono">{e.reference}</span> : null}
                  {e.operatorReference ? <> · ref {e.operatorReference}</> : null}
                </p>
              </div>
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full text-xs min-w-[24rem]">
                  <thead className="text-s-muted">
                    <tr>
                      <th className="text-left font-medium py-1 pr-2">Account</th>
                      <th className="text-right font-medium py-1 pr-2">Debit</th>
                      <th className="text-right font-medium py-1">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.lines.map((l) => (
                      <tr key={l.id} className="border-t border-s-border align-top">
                        <td className="py-1.5 pr-2">
                          <span className="font-mono text-s-muted mr-1">{l.accountCode}</span><span className="text-s-text">{l.accountName}</span>
                          {l.conceptName && <span className="block text-s-muted">Brand: {l.conceptName}</span>}
                          {l.memo && <span className="block text-s-muted">{l.memo}</span>}
                          {l.subAccounts.map((s) => (
                            <span key={s.subAccountId} className="mt-0.5 mr-1 inline-block s-badge-purple">{s.name} · {fmtPkr(s.amountCents)}</span>
                          ))}
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono">{l.type === 'debit' ? fmtPkr(l.amountCents) : ''}</td>
                        <td className="py-1.5 text-right font-mono">{l.type === 'credit' ? fmtPkr(l.amountCents) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {mode === 'cancel' ? (
                <div className="space-y-2 rounded-lg border border-s-border p-3">
                  <Field label="Why is it being cancelled? (at least 10 characters)">
                    <Input value={reason} maxLength={500} onChange={(x) => setReason(x.target.value)} className={inputCls} />
                  </Field>
                  <p className="text-xs text-s-muted">
                    {e.changeNeedsApproval
                      ? 'This goes to the CEO. Nothing changes in the books until it is approved.'
                      : 'A reversing entry is posted now and both stay in the ledger.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="danger" type="button" disabled={reason.trim().length < 10 || cancel.isPending}
                      onClick={() => { setMsg(null); cancel.mutate() }}>
                      {cancel.isPending ? 'Sending…' : e.changeNeedsApproval ? 'Send to the CEO' : 'Cancel entry'}
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => setMode('view')}>Back</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" type="button" disabled={!e.canTextEdit} onClick={startText}
                    title={!e.canTextEdit ? (e.blockedReason ?? undefined) : undefined}>Edit text</Button>
                  <Button variant="secondary" type="button" disabled={!canChange} onClick={() => onEditAmounts(e)}
                    title={!canChange ? (e.blockedReason ?? undefined) : undefined}>Edit amounts</Button>
                  <Button variant="danger" type="button" disabled={!canChange} onClick={() => { setMsg(null); setMode('cancel') }}
                    title={!canChange ? (e.blockedReason ?? undefined) : undefined}>Cancel entry</Button>
                </div>
              )}
              {e.blockedReason && (!e.canTextEdit || !canChange) && <p className="text-xs text-s-muted">{e.blockedReason}</p>}
              {canChange && e.changeNeedsApproval && (
                <p className="text-xs text-s-muted">A change of amount, and cancelling, waits for the CEO&apos;s approval. Text edits, and moving the account, brand or date with the same amounts, apply at once.</p>
              )}
            </>
          )}

          {e.sourceType === 'manual' || e.reference?.startsWith('manual') ? (
            <RecordFiles ownerType="journal_entry" ownerId={e.id} tenantId={e.tenantId ?? undefined} canUpload={e.canTextEdit} compact lazy
              emptyText="No supporting documents yet." />
          ) : null}

          {(data?.changes ?? []).length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Change history</h3>
              <ul className="space-y-1">
                {(data?.changes ?? []).map((c) => (
                  <li key={c.id} className="text-xs text-s-text">
                    <span className="font-semibold">{c.kind === 'reverse' ? 'Cancel' : c.kind === 'amend' ? 'Edit' : c.kind}</span>
                    {' '}· {c.status} · {c.preparedByName ?? '—'}{c.submittedAt ? ` · ${pktDate(c.submittedAt)}` : ''}
                    {c.reason && <span className="block text-s-muted">Why: {c.reason}</span>}
                    {c.decidedByName && <span className="block text-s-muted">Decided by {c.decidedByName}{c.decisionNote ? `: “${c.decisionNote}”` : ''}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data?.textEdits ?? []).length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Text edits</h3>
              <ul className="space-y-1">
                {(data?.textEdits ?? []).map((t, i) => (
                  <li key={i} className="text-xs text-s-text">
                    {t.userName ?? '—'} · {pktDate(t.at)}
                    {editLines(t.before, t.after).map((l, j) => <span key={j} className="block text-s-muted break-words">{l}</span>)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <LinkButton tone="muted" type="button" onClick={onClose}>Close</LinkButton>
        </div>
      )}
    </SidePanel>
  )
}
