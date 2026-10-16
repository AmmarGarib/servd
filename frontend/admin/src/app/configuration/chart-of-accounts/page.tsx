'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { Select } from '@/components/ui/Select'
import { usePermissions } from '../../../hooks/useCan'

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
interface Account {
  id: string
  code: string
  name: string
  type: AccountType
  description: string | null
  isActive: boolean
}

const TYPE_COLOR: Record<AccountType, { bg: string; fg: string }> = {
  asset:     { bg: 'rgb(var(--erp-primary-rgb) / 0.12)', fg: 'var(--erp-primary)' },
  liability: { bg: 'rgba(245,158,11,0.12)', fg: 'var(--erp-warning)' },
  equity:    { bg: 'rgb(var(--ink-rgb) / 0.12)', fg: 'var(--erp-primary-ink)' },
  revenue:   { bg: 'rgb(var(--erp-accent-rgb) / 0.18)', fg: 'var(--erp-success)' },
  expense:   { bg: 'rgba(239,68,68,0.12)', fg: 'var(--erp-danger)' },
}

export default function ChartOfAccountsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Account | null>(null)
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Account[]>({ queryKey: ['chart-of-accounts'], queryFn: () => api.get('/setup/chart-of-accounts') })

  const grouped = data.reduce<Record<AccountType, Account[]>>((acc, a) => {
    if (!acc[a.type]) acc[a.type] = []
    acc[a.type].push(a)
    return acc
  }, { asset: [], liability: [], equity: [], revenue: [], expense: [] })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">📒 Chart of accounts</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              The ledger codes the platform posts against. Add custom accounts (e.g. <code className="text-primary-ink">6210 — Marketing software</code>) to mirror your accountant's tree.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New account</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-6">
        {(['asset', 'liability', 'equity', 'revenue', 'expense'] as AccountType[]).map((t) => (
          <section key={t}>
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">{t}s · {grouped[t].length}</h2>
            <div className="rounded-2xl overflow-hidden" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              {grouped[t].length === 0 && <p className="p-5 text-xs text-white/35">No {t} accounts.</p>}
              {grouped[t].map((a) => (
                <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-xs text-white/45 shrink-0 w-12">{a.code}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white/85">{a.name}</p>
                      {a.description && <p className="text-xs text-white/40">{a.description}</p>}
                    </div>
                    {!a.isActive && <span className="text-[10px] text-white/30">PAUSED</span>}
                  </div>
                  <button onClick={() => setEditing(a)} className="text-xs text-white/55 hover:text-white shrink-0">Edit</button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {(adding || editing) && (
        <Modal account={editing} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['chart-of-accounts'] }) }} />
      )}
    </div>
  )
}

function Modal({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.type ?? 'expense')
  const [description, setDescription] = useState(account?.description ?? '')
  const [isActive, setIsActive] = useState(account?.isActive ?? true)
  // Finance adds and edits accounts; switching one off / on is the CEO's only
  // (owner, 2026-10-16) — the server refuses it too (ACCOUNT_SWITCH_CEO_ONLY).
  const isCeo = usePermissions().data?.role === 'admin'

  const save = useMutation({
    mutationFn: () => {
      if (account) return api.patch(`/setup/chart-of-accounts/${account.id}`, { name: name.trim(), description: description || null, ...(isCeo ? { isActive } : {}) })
      return api.post('/setup/chart-of-accounts', { code: code.trim(), name: name.trim(), type, description: description || null })
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{account ? 'Edit account' : 'New account'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-3">
            <Field label="Code *">
              <input value={code} onChange={(e) => setCode(e.target.value)} disabled={!!account} placeholder="6210" className={fieldCls + ' font-mono'} autoFocus />
            </Field>
            <Field label="Type *">
              <Select value={type} onChange={(e) => setType(e.target.value as AccountType)} disabled={!!account} className={fieldCls}>
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
                <option value="equity">Equity</option>
                <option value="revenue">Revenue</option>
                <option value="expense">Expense</option>
              </Select>
            </Field>
          </div>
          <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing software" className={fieldCls} /></Field>
          <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={fieldCls} placeholder="What goes here vs other accounts" /></Field>
          {account && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isActive} disabled={!isCeo} onChange={(e) => setIsActive(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-white/65">Active{!isCeo && ' — only the CEO can switch an account off or on'}</span>
            </label>
          )}
        </div>
        {save.isError && <p role="alert" className="px-5 pb-3 text-xs" style={{ color: 'var(--erp-danger)' }}>{(save.error as Error).message}</p>}
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || (!account && !code.trim())}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : account ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none disabled:opacity-50"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
