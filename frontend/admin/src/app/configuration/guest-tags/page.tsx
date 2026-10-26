'use client'

// Guest tags (owner, 2026-10-26, B8): the company's own list of tags staff put on a guest (VIP, allergy,
// birthday …). Create, rename, recolour, switch off. Per company; switched off, never deleted.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'

interface TagType { id: string; name: string; color: string | null; active: boolean }

export default function GuestTagsPage() {
  const qc = useQueryClient()
  const { data = [], isLoading } = useQuery<TagType[]>({ queryKey: ['guest-tag-types', 'all'], queryFn: () => api.get('/reservations/guest-tag-types?all=1') })
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6a0dad')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = () => { setError(null); qc.invalidateQueries({ queryKey: ['guest-tag-types'] }) }
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save')

  const create = useMutation({
    mutationFn: () => api.post('/reservations/guest-tag-types', { name, color }),
    onSuccess: () => { setName(''); done() }, onError: fail,
  })
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<TagType> }) => api.patch(`/reservations/guest-tag-types/${v.id}`, v.body),
    onSuccess: () => { setEditing(null); done() }, onError: fail,
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/crm" className="text-xs text-white/40 hover:text-white/70">← CRM</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Guest tags</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          The tags your staff put on a guest — VIP, allergy, birthday. Create them once here, then pick them on the guest card.
          Switching a tag off hides it from the list; tags already on guests stay.
        </p>
      </header>
      <div className="px-7 py-7 max-w-2xl space-y-5">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }}>
          <label className="flex-1 text-xs text-white/50">New tag
            <input className="s-input mt-1" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Birthday" />
          </label>
          <input type="color" aria-label="Tag colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-12 rounded-lg border border-white/10 bg-transparent" />
          <button type="submit" disabled={create.isPending || !name.trim()} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on disabled:opacity-50">Add</button>
        </form>
        {error && <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
        {isLoading ? <p className="text-white/50 text-sm">Loading…</p> : data.length === 0 ? (
          <p className="text-sm text-white/40">No tags yet.</p>
        ) : (
          <ul className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06]">
            {data.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3" style={{ opacity: t.active ? 1 : 0.55 }}>
                <span className="h-3 w-3 rounded-full" style={{ background: t.color ?? 'var(--erp-primary)' }} />
                {editing?.id === t.id ? (
                  <input autoFocus className="s-input flex-1" value={editing.name} maxLength={40}
                    onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && editing.name.trim()) patch.mutate({ id: t.id, body: { name: editing.name } }) }} />
                ) : <span className="flex-1 text-sm font-bold text-white/85">{t.name}{!t.active && ' (off)'}</span>}
                {editing?.id === t.id ? (
                  <>
                    <button className="text-xs font-bold text-primary-ink" onClick={() => editing.name.trim() && patch.mutate({ id: t.id, body: { name: editing.name } })}>Save</button>
                    <button className="text-xs text-white/50" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="text-xs font-bold text-primary-ink" onClick={() => setEditing({ id: t.id, name: t.name })}>Rename</button>
                    <button className="text-xs text-white/60 hover:text-white/90" onClick={() => patch.mutate({ id: t.id, body: { active: !t.active } })}>
                      {t.active ? 'Switch off' : 'Switch on'}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
