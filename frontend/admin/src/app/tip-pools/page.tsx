'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkr, fmtPkrShort } from '../../lib/money'

interface PoolSummary {
  id: string; name: string
  periodStart: string; periodEnd: string
  totalTipsCents: number
  status: 'draft' | 'posted' | 'paid'
  _count: { members: number }
}

interface PoolMember {
  id: string; userId: string; userName: string
  hoursWorked: number; roleWeight: number; shareUnits: number
  shareCents: number
}

interface PoolDetail extends PoolSummary {
  members: PoolMember[]
}

export default function TipPoolsPage() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['tip-pools'],
    queryFn: () => api.get<PoolSummary[]>('/tip-pools'),
  })

  const detail = useQuery({
    queryKey: ['tip-pool', openId],
    queryFn: () => api.get<PoolDetail>(`/tip-pools/${openId}`),
    enabled: !!openId,
  })

  const post = useMutation({
    mutationFn: (id: string) => api.post(`/tip-pools/${id}/post`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); void qc.invalidateQueries({ queryKey: ['tip-pool', openId] }) },
  })
  const pay = useMutation({
    mutationFn: (id: string) => api.post(`/tip-pools/${id}/pay`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); void qc.invalidateQueries({ queryKey: ['tip-pool', openId] }) },
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/payroll" className="text-xs text-s-muted hover:text-s-text">← Payroll</Link>
          <h1 className="text-xl font-bold text-s-text">Tip pools</h1>
          <p className="text-xs text-s-muted">Pool customer tips, distribute by hours × role weight, pay out staff.</p>
        </div>
        <button onClick={() => setShowNew(true)} className="s-btn-primary text-xs">+ New pool</button>
      </header>

      <div className="p-6 max-w-6xl grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-bold">All pools</div>
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-right">Total tips</th>
                <th className="px-4 py-2 text-right">Members</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((p) => (
                <tr key={p.id} className={`border-t border-s-border cursor-pointer ${openId === p.id ? 'bg-s-bg-soft' : 'hover:bg-s-bg-soft'}`}
                  onClick={() => setOpenId(p.id)}>
                  <td className="px-4 py-2 text-xs">
                    <p>{p.periodStart.slice(0, 10)} → {p.periodEnd.slice(0, 10)}</p>
                  </td>
                  <td className="px-4 py-2 text-s-text">{p.name}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(p.totalTipsCents)}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-muted">{p._count.members}</td>
                  <td className="px-4 py-2"><span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${
                    p.status === 'paid' ? 'bg-s-teal text-white' : p.status === 'posted' ? 'bg-s-amber text-white' : 'bg-gray-200'
                  }`}>{p.status}</span></td>
                </tr>
              ))}
              {list.data && list.data.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-s-muted">No pools yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <aside>
          {!openId && (
            <div className="s-card p-6 text-center text-sm text-s-muted">Select a pool to inspect.</div>
          )}
          {openId && detail.data && (
            <div className="s-card overflow-hidden sticky top-24">
              <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
                <p className="text-xs text-s-muted">{detail.data.periodStart.slice(0,10)} → {detail.data.periodEnd.slice(0,10)}</p>
                <h2 className="text-base font-bold">{detail.data.name}</h2>
                <p className="text-xs text-s-muted mt-0.5">Total: <strong>{fmtPkr(detail.data.totalTipsCents)}</strong></p>
              </div>
              <div className="divide-y divide-s-border max-h-[60vh] overflow-y-auto">
                {detail.data.members.map((m) => (
                  <div key={m.id} className="px-4 py-2 flex justify-between items-center text-sm">
                    <div>
                      <p className="font-semibold">{m.userName}</p>
                      <p className="text-[11px] text-s-muted">
                        {m.hoursWorked.toFixed(1)}h · ×{m.roleWeight} = {m.shareUnits.toFixed(2)} units
                      </p>
                    </div>
                    <span className="font-mono text-xs">{detail.data.status === 'draft' ? '—' : fmtPkrShort(m.shareCents)}</span>
                  </div>
                ))}
                {detail.data.members.length === 0 && <p className="px-4 py-3 text-xs text-s-muted">No eligible staff in this period.</p>}
              </div>
              <div className="px-4 py-3 border-t border-s-border flex gap-2">
                {detail.data.status === 'draft' && (
                  <button onClick={() => post.mutate(detail.data.id)} disabled={post.isPending} className="s-btn-primary text-xs flex-1">
                    {post.isPending ? 'Posting…' : 'Post & lock distribution'}
                  </button>
                )}
                {detail.data.status === 'posted' && (
                  <button onClick={() => pay.mutate(detail.data.id)} disabled={pay.isPending} className="s-btn-primary text-xs flex-1">
                    {pay.isPending ? 'Paying…' : 'Mark paid (post JE)'}
                  </button>
                )}
                {detail.data.status === 'paid' && <span className="text-xs text-s-teal w-full text-center">Paid out ✓</span>}
              </div>
            </div>
          )}
        </aside>
      </div>

      {showNew && <NewPoolModal onClose={() => setShowNew(false)} onCreated={() => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); setShowNew(false) }} />}
    </div>
  )
}

function NewPoolModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(`Pool · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`)
  const [start, setStart] = useState(`${new Date().toISOString().slice(0,10)}T17:00`)
  const [end,   setEnd]   = useState(`${new Date().toISOString().slice(0,10)}T23:59`)
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post('/tip-pools', {
      name,
      periodStart: new Date(`${start}:00+05:00`).toISOString(),
      periodEnd:   new Date(`${end}:00+05:00`).toISOString(),
    }),
    onSuccess: onCreated,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Failed'),
  })

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between">
          <h2 className="text-lg font-bold">New tip pool</h2>
          <button onClick={onClose} className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-s-muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1 bg-white border border-s-border rounded px-2 py-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-s-muted">Start</span>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full mt-1 bg-white border border-s-border rounded px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">End</span>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full mt-1 bg-white border border-s-border rounded px-2 py-1.5" />
            </label>
          </div>
          <p className="text-[11px] text-s-muted">Pulls Order.tipCents during this window and pairs with clock-log hours.</p>
          {err && <p className="text-xs text-s-red">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending} className="s-btn-primary text-sm">
            {create.isPending ? 'Computing…' : 'Compute pool'}
          </button>
        </div>
      </div>
    </div>
  )
}
