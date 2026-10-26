'use client'

// Guest tags on the guest card (owner, 2026-10-26, B8): the company's own list (Configuration -> Guest tags) —
// pick one to put it on this guest, remove it with the x. Reads / writes /reservations/guest-tags.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface GuestTag { id: string; label: string; color: string | null }
interface TagType { id: string; name: string; color: string | null }

export function GuestTagsPanel({ customerId }: { customerId: string }) {
  const qc = useQueryClient()
  const key = ['guest-tags', customerId]
  const { data: tags = [] } = useQuery<GuestTag[]>({ queryKey: key, queryFn: () => api.get(`/reservations/guest-tags?customerId=${customerId}`) })
  const { data: types = [] } = useQuery<TagType[]>({ queryKey: ['guest-tag-types'], queryFn: () => api.get('/reservations/guest-tag-types') })
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const add = useMutation({ mutationFn: (tagTypeId: string) => api.post('/reservations/guest-tags', { customerId, tagTypeId }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/reservations/guest-tags/${id}`), onSuccess: refresh })
  const onGuest = new Set(tags.map((t) => t.label))
  const free = types.filter((t) => !onGuest.has(t.name))

  return (
    <div className="rounded-xl p-3 border" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', borderColor: 'rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 mb-2">Guest tags</div>
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && <span className="text-[11px] text-white/35">None yet.</span>}
        {tags.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
            style={{ background: `color-mix(in srgb, ${t.color ?? 'var(--erp-primary)'} 14%, transparent)`, color: t.color ?? 'var(--erp-primary-ink)' }}>
            {t.label}
            <button type="button" aria-label={`Remove ${t.label}`} onClick={() => remove.mutate(t.id)} className="opacity-60 hover:opacity-100">×</button>
          </span>
        ))}
      </div>
      {free.length > 0 && (
        <select className="s-input w-auto mt-2 text-xs" value="" disabled={add.isPending}
          onChange={(e) => { if (e.target.value) add.mutate(e.target.value) }}>
          <option value="">Add a tag…</option>
          {free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
    </div>
  )
}
