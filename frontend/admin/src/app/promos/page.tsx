'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'

function fmt(cents: number) { return `PKR ${(cents / 100).toLocaleString()}` }

interface PromoCode {
  id: string
  code: string
  description: string | null
  discountType: 'percentage' | 'fixed'
  discountValue: number
  minOrderCents: number | null
  maxUsageCount: number | null
  usedCount: number
  perCustomerLimit: number
  isActive: boolean
  startAt: string | null
  endAt: string | null
  concept: { name: string } | null
  createdAt: string
}

interface Concept { id: string; name: string }

const inp = 'rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none w-full'
const sel = 'rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none'

export default function PromosPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const [form, setForm] = useState({
    code: '', description: '', type: 'percentage' as 'percentage' | 'fixed',
    value: '', minOrderCents: '', maxUsages: '', perCustomerLimit: '',
    conceptId: '', isActive: true, startsAt: '', expiresAt: '',
  })

  const { data: promos = [], isLoading } = useQuery({
    queryKey: ['promos'],
    queryFn: () => api.get<PromoCode[]>('/promos'),
  })

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editId
        ? api.patch(`/promos/${editId}`, body)
        : api.post('/promos', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['promos'] })
      setShowForm(false)
      setEditId(null)
      setForm({ code: '', description: '', type: 'percentage', value: '', minOrderCents: '', maxUsages: '', perCustomerLimit: '', conceptId: '', isActive: true, startsAt: '', expiresAt: '' })
    },
  })

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/promos/${id}`, { isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['promos'] }),
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/promos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['promos'] }),
  })

  function openEdit(p: PromoCode) {
    setEditId(p.id)
    setForm({
      code: p.code,
      description: p.description ?? '',
      type: p.discountType,
      value: String(p.discountType === 'fixed' ? p.discountValue / 100 : p.discountValue),
      minOrderCents: p.minOrderCents ? String(p.minOrderCents / 100) : '',
      maxUsages: p.maxUsageCount ? String(p.maxUsageCount) : '',
      perCustomerLimit: p.perCustomerLimit ? String(p.perCustomerLimit) : '',
      conceptId: p.concept ? (concepts.find((c) => c.name === p.concept?.name)?.id ?? '') : '',
      isActive: p.isActive,
      startsAt: p.startAt ? p.startAt.slice(0, 16) : '',
      expiresAt: p.endAt ? p.endAt.slice(0, 16) : '',
    })
    setShowForm(true)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const valueNum = parseFloat(form.value)
    save.mutate({
      code: form.code.toUpperCase(),
      description: form.description || undefined,
      discountType: form.type,
      discountValue: form.type === 'fixed' ? Math.round(valueNum * 100) : valueNum,
      minOrderCents: form.minOrderCents ? Math.round(parseFloat(form.minOrderCents) * 100) : undefined,
      maxUsageCount: form.maxUsages ? parseInt(form.maxUsages) : undefined,
      perCustomerLimit: form.perCustomerLimit ? parseInt(form.perCustomerLimit) : undefined,
      conceptId: form.conceptId || undefined,
      isActive: form.isActive,
      startAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined,
      endAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
    })
  }

  const activeCount = promos.filter((p) => p.isActive).length

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Promo Codes</h1>
          <p className="text-sm text-kds-subtext">{activeCount} active · {promos.length} total</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null) }}
          className="rounded-xl bg-kds-green text-black text-sm font-bold px-4 py-2 hover:opacity-90">
          + New promo
        </button>
      </header>

      <div className="p-6 max-w-5xl">
        {showForm && (
          <form onSubmit={submit} className="rounded-xl border border-kds-green bg-kds-card p-5 mb-6 space-y-4">
            <p className="font-bold text-kds-text">{editId ? 'Edit promo' : 'New promo code'}</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Code *</label>
                <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="SAVE20" required className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="20% off for new customers" className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Type *</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'percentage' | 'fixed' })} className={`${inp}`}>
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed amount (PKR)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">
                  Value * {form.type === 'percentage' ? '(%)' : '(PKR)'}
                </label>
                <input type="number" min="0" step="0.01" value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  placeholder={form.type === 'percentage' ? '20' : '200'} required className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Min order (PKR)</label>
                <input type="number" min="0" value={form.minOrderCents}
                  onChange={(e) => setForm({ ...form, minOrderCents: e.target.value })}
                  placeholder="500" className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Max total uses</label>
                <input type="number" min="1" value={form.maxUsages}
                  onChange={(e) => setForm({ ...form, maxUsages: e.target.value })}
                  placeholder="100" className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Per-customer limit</label>
                <input type="number" min="1" value={form.perCustomerLimit}
                  onChange={(e) => setForm({ ...form, perCustomerLimit: e.target.value })}
                  placeholder="1" className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Concept (optional)</label>
                <select value={form.conceptId} onChange={(e) => setForm({ ...form, conceptId: e.target.value })} className={`${inp}`}>
                  <option value="">All concepts</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Starts at</label>
                <input type="datetime-local" value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className={inp} />
              </div>
              <div>
                <label className="text-xs text-kds-subtext mb-1 block">Expires at</label>
                <input type="datetime-local" value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className={inp} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-kds-text cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="accent-kds-green" />
              Active immediately
            </label>
            <div className="flex gap-3">
              <button type="submit" disabled={save.isPending}
                className="rounded-xl bg-kds-green text-black text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : editId ? 'Update promo' : 'Create promo'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditId(null) }}
                className="rounded-xl border border-kds-border text-kds-subtext text-sm px-4 py-2 hover:border-kds-text">
                Cancel
              </button>
            </div>
          </form>
        )}

        {isLoading ? (
          <p className="text-kds-subtext text-sm">Loading…</p>
        ) : promos.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-3">🎟</p>
            <p className="font-semibold text-kds-text">No promo codes yet</p>
            <p className="text-sm text-kds-subtext mt-1">Create your first promo to drive customer orders</p>
          </div>
        ) : (
          <div className="rounded-xl border border-kds-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-kds-card border-b border-kds-border">
                <tr>
                  {['Code', 'Type', 'Value', 'Min order', 'Usage', 'Expires', 'Concept', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-kds-subtext uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-kds-border">
                {promos.map((p) => (
                  <tr key={p.id} className="hover:bg-kds-card/40 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono font-bold text-kds-text bg-kds-bg border border-kds-border rounded px-2 py-0.5 text-xs">
                        {p.code}
                      </span>
                      {p.description && <p className="text-xs text-kds-subtext mt-0.5">{p.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext">{p.discountType}</td>
                    <td className="px-4 py-3 font-bold text-kds-green">
                      {p.discountType === 'percentage' ? `${p.discountValue}%` : fmt(p.discountValue)}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext">
                      {p.minOrderCents ? fmt(p.minOrderCents) : '—'}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext">
                      {p.usedCount}{p.maxUsageCount ? ` / ${p.maxUsageCount}` : ''}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext text-xs">
                      {p.endAt ? new Date(p.endAt).toLocaleDateString() : '∞'}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext text-xs">
                      {p.concept?.name ?? 'All'}
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggle.mutate({ id: p.id, isActive: !p.isActive })}
                        className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                          p.isActive ? 'bg-kds-green/20 text-kds-green' : 'bg-kds-border text-kds-subtext'
                        }`}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(p)}
                          className="text-xs text-kds-subtext hover:text-kds-green transition-colors">Edit</button>
                        <button onClick={() => { if (confirm('Delete this promo?')) del.mutate(p.id) }}
                          className="text-xs text-kds-subtext hover:text-kds-red transition-colors">Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
