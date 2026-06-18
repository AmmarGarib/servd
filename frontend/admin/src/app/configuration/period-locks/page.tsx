'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Lock { id: string; lockedThrough: string; lockedBy: string; lockedAt: string; note: string | null }

export default function PeriodLocksPage() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Lock[]>({ queryKey: ['period-locks'], queryFn: () => api.get('/setup/period-locks') })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/setup/period-locks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['period-locks'] }) })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🔒 Period locks</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              After a period close, lock the books up to that date. Postings dated on or before the lock will be blocked unless an admin reopens the period.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ Add lock</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-3xl mx-auto space-y-2">
        {data.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No period locks yet</p>
            <p className="text-sm text-white/45 mt-1">Books are open for all dates.</p>
          </div>
        )}
        {data.map((l) => (
          <div key={l.id} className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-bold text-white/90">Locked through {new Date(l.lockedThrough).toLocaleDateString()}</p>
                <p className="text-xs text-white/40 mt-0.5">By {l.lockedBy} · {new Date(l.lockedAt).toLocaleString()}</p>
                {l.note && <p className="text-xs text-white/55 mt-1">{l.note}</p>}
              </div>
              <button onClick={() => { if (confirm('Reopen period? Postings dated within will be allowed again.')) del.mutate(l.id) }}
                className="rounded-lg border border-red-500/20 text-red-400/70 px-3 py-1.5 text-xs hover:text-red-300">Reopen</button>
            </div>
          </div>
        ))}
      </div>

      {adding && <Modal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ['period-locks'] }) }} />}
    </div>
  )
}

function Modal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [lockedThrough, setLockedThrough] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: () => api.post('/setup/period-locks', { lockedThrough, note: note || undefined }),
    onSuccess: () => onSaved(),
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">Lock period</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs text-white/55">Lock through (inclusive) *</label>
            <input type="date" value={lockedThrough} onChange={(e) => setLockedThrough(e.target.value)} className={fieldCls + ' mt-1'} />
            <p className="text-[10px] text-white/30 mt-1">Books closed on/before this date will be read-only.</p>
          </div>
          <div>
            <label className="text-xs text-white/55">Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Q1 2026 close" className={fieldCls + ' mt-1'} />
          </div>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Locking…' : 'Lock period'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
