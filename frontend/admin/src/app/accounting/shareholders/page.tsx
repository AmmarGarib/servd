'use client'
// Shareholder funding (owner, 2026-11-24: "a page … that shows how much variance there is so we are always aware of
// any shareholding disparity"; 60 / 40 at Flipd). What each shareholder has put in (the balances of their accounts)
// against the agreed split. Per company — a company with none set shows nothing. Backend accounting/shareholders.ts.
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkrWhole, todayPktIso } from '../../../lib/money'
import { Button, CheckLabel, Dialog, DialogFooter, Field, Input } from '@/components/finance/ui'

interface Holder {
  id: string; name: string; sharePercent: number
  accounts: { code: string; name: string | null; balanceCents: number; missing: boolean }[]
  fundedCents: number; fundedPercent: number; expectedCents: number; varianceCents: number; topUpCents: number
}
interface Data { tenantId: string; companyName: string | null; canEdit: boolean; totalCents: number; shareholders: Holder[] }
interface PickAcc { code: string; name: string; type: string; isActive: boolean; balanceCents: number }
interface Draft { name: string; sharePercent: string; accountCodes: string[] }

export default function ShareholdersPage() {
  const [asOf, setAsOf] = useState(todayPktIso())
  const [editing, setEditing] = useState(false)
  const { data, isLoading, error } = useQuery<Data>({ queryKey: ['shareholders', asOf], queryFn: () => api.get(`/accounting/shareholders?asOf=${asOf}`) })
  const holders = data?.shareholders ?? []
  const behind = holders.filter((h) => h.topUpCents > 0)
  const split = holders.map((h) => `${h.sharePercent}`).join(' / ')

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Shareholder funding</h1>
          {data?.companyName && <p className="text-xs text-s-muted break-words">{data.companyName}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sh-asof" className="text-xs text-s-muted">As at</label>
          <Input id="sh-asof" type="date" value={asOf} max={todayPktIso()} onChange={(e) => setAsOf(e.target.value || todayPktIso())} className="w-auto" />
          {data?.canEdit && <Button variant="secondary" onClick={() => setEditing(true)}>{holders.length ? 'Edit shareholders' : 'Set up shareholders'}</Button>}
        </div>
      </header>

      <main className="px-4 sm:px-6 py-6 max-w-4xl mx-auto space-y-5">
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {error && <p role="alert" className="text-sm text-s-red break-words">{(error as Error).message}</p>}
        {data && holders.length === 0 && (
          <div className="s-card p-6 text-sm text-s-muted space-y-2">
            <p className="font-semibold text-s-text">No shareholders are set for this company.</p>
            <p>{data.canEdit ? 'Add each shareholder, their agreed share and the accounts that hold what they have put in.' : 'The CEO sets each shareholder, their agreed share and their accounts.'}</p>
          </div>
        )}
        {holders.length > 0 && (
          <>
            <div className="s-card p-4 space-y-1">
              <p className="text-xs text-s-muted">Total put in by shareholders</p>
              <p className="text-2xl font-bold text-s-text">{fmtPkrWhole(data!.totalCents)}</p>
              <p className="text-xs text-s-muted">Agreed split {split}. Figures are the balances of each shareholder&rsquo;s accounts as at {asOf}.</p>
            </div>

            <div className="s-card p-4 space-y-2 border-l-4" style={{ borderLeftColor: behind.length ? 'var(--erp-warning)' : 'var(--erp-success)' }}>
              <h2 className="text-sm font-semibold text-s-text">{behind.length ? 'The funding is not at the agreed split' : 'The funding is at the agreed split'}</h2>
              {behind.map((h) => (
                <p key={h.id} className="text-sm text-s-text break-words">
                  <strong>{h.name}</strong> should put in <strong>{fmtPkrWhole(h.topUpCents)}</strong> more to stand at {h.sharePercent}% (with nobody taking money out).
                </p>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {holders.map((h) => (
                <div key={h.id} className="s-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-bold text-s-text break-words min-w-0">{h.name}</h3>
                    <span className="s-badge-purple text-xs shrink-0">Agreed {h.sharePercent}%</span>
                  </div>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
                    <dt className="text-s-muted">Put in</dt><dd className="text-right font-mono text-s-text">{fmtPkrWhole(h.fundedCents)}</dd>
                    <dt className="text-s-muted">Share of the total now</dt><dd className="text-right font-mono text-s-text">{h.fundedPercent}%</dd>
                    <dt className="text-s-muted">Should be at {h.sharePercent}%</dt><dd className="text-right font-mono text-s-text">{fmtPkrWhole(h.expectedCents)}</dd>
                    <dt className="font-semibold text-s-text">Variance</dt>
                    <dd className={`text-right font-mono font-bold ${h.varianceCents < 0 ? 'text-s-red' : 'text-success'}`}>
                      {h.varianceCents === 0 ? 'None' : `${fmtPkrWhole(Math.abs(h.varianceCents))} ${h.varianceCents > 0 ? 'over' : 'short'}`}
                    </dd>
                  </dl>
                  <div className="border-t border-s-border pt-2 space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-s-muted">Accounts counted</p>
                    {h.accounts.length === 0 && <p className="text-xs text-s-muted">None picked.</p>}
                    {h.accounts.map((a) => (
                      <div key={a.code} className="flex items-start justify-between gap-3 text-xs">
                        <span className="text-s-text break-words min-w-0"><span className="font-mono text-s-muted">{a.code}</span> {a.missing ? 'Account not found' : a.name}</span>
                        <span className="font-mono text-s-text shrink-0">{fmtPkrWhole(a.balanceCents)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
      {editing && data && <EditDialog current={holders} onClose={() => setEditing(false)} />}
    </div>
  )
}

function EditDialog({ current, onClose }: { current: Holder[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Draft[]>(current.length
    ? current.map((h) => ({ name: h.name, sharePercent: String(h.sharePercent), accountCodes: h.accounts.map((a) => a.code) }))
    : [{ name: '', sharePercent: '', accountCodes: [] }, { name: '', sharePercent: '', accountCodes: [] }])
  const [err, setErr] = useState('')
  const { data: pick } = useQuery<{ accounts: PickAcc[] }>({ queryKey: ['shareholder-accounts'], queryFn: () => api.get('/accounting/shareholders/accounts') })
  const total = rows.reduce((t, r) => t + (Number(r.sharePercent) || 0), 0)
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const takenElsewhere = (i: number, code: string) => rows.some((r, j) => j !== i && r.accountCodes.includes(code))
  const save = useMutation({
    mutationFn: () => api.put('/accounting/shareholders', { shareholders: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), sharePercent: Number(r.sharePercent), accountCodes: r.accountCodes })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shareholders'] }); onClose() },
    onError: (e: Error) => setErr(e.message || 'Not saved'),
  })
  const named = rows.filter((r) => r.name.trim())
  const ok = named.length === 0 || (Math.abs(total - 100) < 0.001 && named.every((r) => Number(r.sharePercent) > 0))
  return (
    <Dialog title="Shareholders of this company" onClose={onClose} wide dirty>
      <div className="space-y-4">
        {rows.map((r, i) => (
          <div key={i} className="rounded-xl p-3 space-y-3" style={{ border: '1px solid var(--border)' }}>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] items-end">
              <Field label="Shareholder"><Input type="text" value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. Yousuf Madraswala" className="w-full" /></Field>
              <Field label="Agreed share %"><Input type="number" min={0} max={100} step="0.01" inputMode="decimal" value={r.sharePercent} onChange={(e) => set(i, { sharePercent: e.target.value })} className="w-full" /></Field>
              <Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Accounts that hold what they put in</p>
              <div className="max-h-44 overflow-y-auto rounded-lg p-2 space-y-1" style={{ border: '1px solid var(--border)' }}>
                {(pick?.accounts ?? []).length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>No liability or equity accounts found.</p>}
                {(pick?.accounts ?? []).map((a) => {
                  const taken = takenElsewhere(i, a.code)
                  return (
                    <CheckLabel key={a.code} className={`flex items-start gap-2 text-xs ${taken ? 'opacity-40' : ''}`}>
                      <input type="checkbox" disabled={taken} checked={r.accountCodes.includes(a.code)}
                        onChange={(e) => set(i, { accountCodes: e.target.checked ? [...r.accountCodes, a.code] : r.accountCodes.filter((c) => c !== a.code) })} />
                      <span className="min-w-0 break-words flex-1"><span className="font-mono">{a.code}</span> {a.name}{!a.isActive ? ' (switched off)' : ''}</span>
                      <span className="font-mono shrink-0">{fmtPkrWhole(a.balanceCents)}</span>
                    </CheckLabel>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={() => setRows([...rows, { name: '', sharePercent: '', accountCodes: [] }])}>+ Add shareholder</Button>
          <p className={`text-sm font-semibold ${Math.abs(total - 100) < 0.001 ? 'text-success' : 'text-s-red'}`}>Shares add up to {Math.round(total * 100) / 100}% {Math.abs(total - 100) < 0.001 ? '' : '— must be 100%'}</p>
        </div>
        {err && <p role="alert" className="text-xs font-semibold break-words" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
      </div>
      <DialogFooter onCancel={onClose}>
        <Button disabled={!ok || save.isPending} onClick={() => { setErr(''); save.mutate() }}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </DialogFooter>
    </Dialog>
  )
}
