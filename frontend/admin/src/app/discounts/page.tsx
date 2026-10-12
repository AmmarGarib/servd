'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'

interface SectionDiscount {
  id: string
  discountPercent: number
  deliveryTypes: string[]
  orderTypes: string[]
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  isActive: boolean
  concept: { name: string } | null
  category: { name: string } | null
}

interface Concept { id: string; name: string }
interface Category { id: string; name: string; conceptId: string }

const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none w-full'

export default function DiscountsPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const blank = {
    conceptId: '', categoryId: '', discountPercent: '',
    startDate: '', endDate: '', startTime: '00:00', endTime: '23:59',
    deliveryTypes: ['all'], orderTypes: ['all'], isActive: true,
  }
  const [form, setForm] = useState(blank)

  const { data: discounts = [], isLoading } = useQuery({
    queryKey: ['discounts'],
    queryFn: () => api.get<SectionDiscount[]>('/discounts/sections'),
  })

  const { data: concepts = [] } = useQuery({
    // The brand picker view (id + name, own companies, any staff role): the
    // full brand row is managers-only and this page only needs the names.
    queryKey: ['concepts', 'picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
  })

  // The brand's menu sections, from the one menu read (GET /menu/:conceptId —
  // every staff role, the brand must be in the operator's company). There is
  // no /menu/categories route: that URL matched /menu/:conceptId with
  // conceptId 'categories' and 404'd, so a discount could never be scoped to
  // a section (W3A-RV-06).
  const { data: categories = [] } = useQuery({
    queryKey: ['menu', form.conceptId, 'sections'],
    queryFn: async () => (await api.get<Category[]>(`/menu/${form.conceptId}`))
      .map((c) => ({ id: c.id, name: c.name, conceptId: c.conceptId })),
    enabled: !!form.conceptId,
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editId
        ? api.patch(`/discounts/sections/${editId}`, body)
        : api.post('/discounts/sections', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discounts'] })
      setShowForm(false)
      setEditId(null)
      setForm(blank)
    },
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/discounts/sections/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['discounts'] }),
  })

  function openEdit(d: SectionDiscount) {
    setEditId(d.id)
    const conceptId = concepts.find((c) => c.name === d.concept?.name)?.id ?? ''
    setForm({
      conceptId,
      categoryId: '',
      discountPercent: String(d.discountPercent),
      startDate: d.startDate.slice(0, 10),
      endDate: d.endDate.slice(0, 10),
      startTime: d.startTime,
      endTime: d.endTime,
      deliveryTypes: d.deliveryTypes,
      orderTypes: d.orderTypes,
      isActive: d.isActive,
    })
    setShowForm(true)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    save.mutate({
      conceptId: form.conceptId || undefined,
      categoryId: form.categoryId || undefined,
      discountPercent: parseFloat(form.discountPercent),
      startDate: new Date(`${form.startDate}T00:00:00`).toISOString(),
      endDate: new Date(`${form.endDate}T23:59:59`).toISOString(),
      startTime: form.startTime,
      endTime: form.endTime,
      deliveryTypes: form.deliveryTypes,
      orderTypes: form.orderTypes,
      isActive: form.isActive,
    })
  }

  function toggleType(field: 'deliveryTypes' | 'orderTypes', val: string) {
    setForm((f) => {
      const cur = f[field]
      if (val === 'all') return { ...f, [field]: ['all'] }
      const without = cur.filter((v) => v !== 'all' && v !== val)
      return { ...f, [field]: cur.includes(val) ? (without.length ? without : ['all']) : [...without, val] }
    })
  }

  const typeBtn = (field: 'deliveryTypes' | 'orderTypes', val: string, label: string) => (
    <button type="button" key={val}
      onClick={() => toggleType(field, val)}
      className={`rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
        form[field].includes(val)
          ? 'border-primary bg-primary/20 text-primary-ink'
          : 'border-s-border text-s-muted hover:border-s-border-strong'
      }`}>
      {label}
    </button>
  )

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Section Discounts</h1>
          <p className="text-sm text-s-muted">Time-boxed % off on menu categories</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm(blank) }}
          className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90">
          + New discount
        </button>
      </header>

      <div className="p-6 max-w-5xl mx-auto">
        {showForm && (
          <form onSubmit={submit} className="rounded-xl border border-primary bg-s-surface p-5 mb-6 space-y-4">
            <p className="font-bold text-s-text">{editId ? 'Edit discount' : 'New section discount'}</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-s-muted mb-1 block">Concept</label>
                <select value={form.conceptId} onChange={(e) => setForm({ ...form, conceptId: e.target.value, categoryId: '' })} className={inp}>
                  <option value="">All concepts</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-s-muted mb-1 block">Category</label>
                <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} className={inp} disabled={!form.conceptId}>
                  <option value="">Whole menu</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-s-muted mb-1 block">Discount % *</label>
                <input type="number" min="0.1" max="100" step="0.1" value={form.discountPercent}
                  onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                  placeholder="20" required className={inp} />
              </div>
              <div className="col-span-2 grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-s-muted mb-1 block">Start date *</label>
                  <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required className={inp} />
                </div>
                <div>
                  <label className="text-xs text-s-muted mb-1 block">End date *</label>
                  <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required className={inp} />
                </div>
                <div>
                  <label className="text-xs text-s-muted mb-1 block">Start time *</label>
                  <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required className={inp} />
                </div>
                <div>
                  <label className="text-xs text-s-muted mb-1 block">End time *</label>
                  <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} required className={inp} />
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs text-s-muted mb-2">Delivery type</p>
              <div className="flex gap-2 flex-wrap">
                {[['all','All'], ['delivery','Delivery'], ['pickup','Pickup']].map(([v, l]) => typeBtn('deliveryTypes', v!, l!))}
              </div>
            </div>
            <div>
              <p className="text-xs text-s-muted mb-2">Order type</p>
              <div className="flex gap-2 flex-wrap">
                {[['all','All'], ['dine-in','Dine-in'], ['takeaway','Takeaway'], ['online','Online']].map(([v, l]) => typeBtn('orderTypes', v!, l!))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-s-text cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="accent-primary" />
              Active
            </label>
            <div className="flex gap-3">
              <button type="submit" disabled={save.isPending}
                className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : editId ? 'Update' : 'Create discount'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditId(null) }}
                className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-s-border-strong">
                Cancel
              </button>
            </div>
          </form>
        )}

        {isLoading ? (
          <p className="text-s-muted text-sm">Loading…</p>
        ) : discounts.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-3">🏷</p>
            <p className="font-semibold text-s-text">No section discounts yet</p>
            <p className="text-sm text-s-muted mt-1">Create time-based discounts on menu categories</p>
          </div>
        ) : (
          <div className="rounded-xl border border-s-border overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-s-surface border-b border-s-border">
                <tr>
                  {['Discount', 'Concept', 'Category', 'Date range', 'Time window', 'Types', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-s-muted uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-s-border">
                {discounts.map((d) => (
                  <tr key={d.id} className="hover:bg-s-elevated/40 transition-colors">
                    <td className="px-4 py-3 font-bold text-primary-ink text-lg">{d.discountPercent}%</td>
                    <td className="px-4 py-3 text-s-muted text-xs">{d.concept?.name ?? 'All'}</td>
                    <td className="px-4 py-3 text-s-muted text-xs">{d.category?.name ?? 'All items'}</td>
                    <td className="px-4 py-3 text-s-muted text-xs">
                      {new Date(d.startDate).toLocaleDateString()} – {new Date(d.endDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-s-muted text-xs font-mono">{d.startTime} – {d.endTime}</td>
                    <td className="px-4 py-3 text-xs">
                      <div className="flex gap-1 flex-wrap">
                        {d.deliveryTypes.map((t) => (
                          <span key={t} className="rounded bg-s-bg border border-s-border px-1.5 py-0.5 text-s-muted">{t}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${d.isActive ? 'bg-primary/20 text-primary-ink' : 'bg-s-border text-s-muted'}`}>
                        {d.isActive ? 'Active' : 'Off'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(d)} className="text-xs text-s-muted hover:text-primary-ink">Edit</button>
                        <button onClick={() => { if (confirm('Delete this discount?')) del.mutate(d.id) }}
                          className="text-xs text-s-muted hover:text-s-red">Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
