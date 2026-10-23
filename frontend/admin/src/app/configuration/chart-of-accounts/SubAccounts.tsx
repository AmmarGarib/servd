'use client'
// Sub-accounts of one chart account (owner, 2026-10-23): list, add, rename,
// switch off / on. A sub-account only TAGS amounts of journal lines — the
// account's own balance is unchanged; the Journals → Accounts view reports
// each sub-account's balance under the main account. Employee sub-accounts
// are created by payroll and keep the employee's name (no rename).
// GET/POST /setup/chart-of-accounts/:id/sub-accounts, PATCH …/sub-accounts/:id
// (CEO and finance with accounting write; the server decides).
// "Sub-accounts on" (owner, 2026-10-23): only the HO wages account starts on; opening a sub-account switches
// its account on; off = payroll does not tag it and journals / statements show no sub-accounts (old tags stay).
// PUT /setup/chart-of-accounts/:id/sub-accounts-switch { enabled }.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { Button, Input, LinkButton } from '@/components/finance/ui'

interface Sub { id: string; name: string; code: string | null; kind: string; employeeId: string | null; isActive: boolean }

export function SubAccounts({ accountId, enabled }: { accountId: string; enabled: boolean }) {
  const qc = useQueryClient()
  const key = ['coa-sub-accounts', accountId]
  const { data = [], isLoading, error } = useQuery<Sub[]>({ queryKey: key, queryFn: () => api.get(`/setup/chart-of-accounts/${accountId}/sub-accounts`) })
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const done = () => { setErr(null); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['sub-accounts'] }) }
  const add = useMutation({
    mutationFn: () => api.post(`/setup/chart-of-accounts/${accountId}/sub-accounts`, { name: name.trim(), ...(code.trim() && { code: code.trim() }) }),
    onSuccess: () => { setName(''); setCode(''); done() },
    onError: (e: Error) => setErr(e.message),
  })
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.put(`/setup/chart-of-accounts/${accountId}/sub-accounts-switch`, { enabled: on }),
    onSuccess: () => { done(); void qc.invalidateQueries({ queryKey: ['chart-of-accounts'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`/setup/chart-of-accounts/sub-accounts/${v.id}`, v.body),
    onSuccess: () => { setEditId(null); done() },
    onError: (e: Error) => setErr(e.message),
  })

  return (
    <div className="px-4 pb-3 pt-1 space-y-2 border-t border-white/[0.04]">
      <label className="flex items-start gap-2 text-xs text-white/75">
        <input type="checkbox" checked={enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} className="mt-0.5" />
        <span className="font-semibold">Sub-accounts on for this account</span>
      </label>
      <p className="text-xs text-white/45 pl-5">{enabled
          ? 'Shown in journals and statements; payroll fills employee sub-accounts here if staff wages post to it.'
          : 'Off: not shown in journals or statements, and payroll does not fill it. Adding a sub-account switches it on.'}</p>
      {isLoading && <p className="text-xs text-white/45">Loading…</p>}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{(error as Error).message}</p>}
      {!isLoading && !error && data.length === 0 && <p className="text-xs text-white/45">No sub-accounts yet.</p>}
      <ul className="space-y-1">
        {data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
            {editId === s.id ? (
              <>
                <Input aria-label="Sub-account name" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={120} className="w-auto px-2 py-1 text-xs" />
                <Button size="sm" disabled={!editName.trim() || patch.isPending} onClick={() => patch.mutate({ id: s.id, body: { name: editName.trim() } })}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <span className={`font-semibold ${s.isActive ? 'text-white/85' : 'text-white/40'}`}>{s.name}</span>
                {s.code && <span className="font-mono text-white/45">{s.code}</span>}
                {s.kind === 'employee' || s.employeeId ? <span className="text-white/40">created by payroll</span> : null}
                {!s.isActive && <span className="text-[10px] text-white/30">OFF</span>}
                {!(s.kind === 'employee' || s.employeeId) && (
                  <LinkButton tone="muted" onClick={() => { setEditId(s.id); setEditName(s.name) }}>Rename</LinkButton>
                )}
                <LinkButton tone={s.isActive ? 'muted' : 'primary'} disabled={patch.isPending}
                  onClick={() => patch.mutate({ id: s.id, body: { isActive: !s.isActive } })}>{s.isActive ? 'Switch off' : 'Switch on'}</LinkButton>
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate() }}>
        <Input aria-label="New sub-account name" placeholder="New sub-account name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="w-auto px-2 py-1 text-xs" />
        <Input aria-label="Code (optional)" placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} className="w-auto px-2 py-1 text-xs max-w-[9rem]" />
        <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || add.isPending}>{add.isPending ? 'Adding…' : 'Add'}</Button>
      </form>
      {err && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
      <p className="text-xs text-white/40">Sub-accounts tag amounts on journal lines; the account&apos;s own balance does not change. Journals → Accounts shows each one&apos;s balance.</p>
    </div>
  )
}
