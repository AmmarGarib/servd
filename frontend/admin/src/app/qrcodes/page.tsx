'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { useBrandFilter } from '../../store/brandFilter'

interface QrCode {
  id: string
  label: string
  orderType: 'dine-in' | 'pickup'
  scanCount: number
  conversions: number
  qrImageUrl: string | null
  createdAt: string
  concept: { name: string; slug: string }
  table: { label: string } | null
}

interface Concept { id: string; name: string }
interface Table { id: string; label: string; conceptId: string }

const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none w-full'

export default function QrCodesPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [conceptFilter, setConceptFilter] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [form, setForm] = useState({ conceptId: '', tableId: '', orderType: 'dine-in' as 'dine-in' | 'pickup', label: '' })

  const { data: qrCodes = [], isLoading } = useQuery({
    queryKey: ['qrcodes', conceptFilter],
    queryFn: () => api.get<QrCode[]>(`/qrcodes${conceptFilter ? `?conceptId=${conceptFilter}` : ''}`),
  })

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const { data: tables = [] } = useQuery({
    queryKey: ['tables', form.conceptId],
    queryFn: () => api.get<Table[]>(`/tables?conceptId=${form.conceptId}`),
    enabled: !!form.conceptId,
  })

  const create = useMutation({
    mutationFn: (body: typeof form) => api.post('/qrcodes', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['qrcodes'] })
      setShowForm(false)
      setForm({ conceptId: '', tableId: '', orderType: 'dine-in', label: '' })
    },
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/qrcodes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['qrcodes'] }),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    create.mutate(form)
  }

  const totalScans = qrCodes.reduce((s, q) => s + q.scanCount, 0)
  const totalConversions = qrCodes.reduce((s, q) => s + q.conversions, 0)
  const convRate = totalScans > 0 ? Math.round((totalConversions / totalScans) * 100) : 0

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">QR Codes</h1>
          <p className="text-sm text-s-muted">
            {qrCodes.length} codes · {totalScans} scans · {convRate}% conversion
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90">
          + Generate QR
        </button>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total scans', value: totalScans, color: 'text-s-blue' },
            { label: 'Conversions', value: totalConversions, color: 'text-primary-ink' },
            { label: 'Conversion rate', value: `${convRate}%`, color: 'text-s-amber' },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-s-border bg-s-surface p-4">
              <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
              <p className="text-xs text-s-muted mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {showForm && (
          <form onSubmit={submit} className="rounded-xl border border-primary bg-s-surface p-5 space-y-4">
            <p className="font-bold text-s-text">Generate QR code</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-s-muted mb-1 block">Concept *</label>
                <select value={form.conceptId} onChange={(e) => setForm({ ...form, conceptId: e.target.value, tableId: '' })} required className={inp}>
                  <option value="">Select concept…</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-s-muted mb-1 block">Table (optional)</label>
                <select value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })} className={inp} disabled={!form.conceptId}>
                  <option value="">No specific table</option>
                  {tables.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-s-muted mb-1 block">Label *</label>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Table 5 – Window seat" required className={inp} />
              </div>
              <div>
                <label className="text-xs text-s-muted mb-1 block">Order type *</label>
                <select value={form.orderType} onChange={(e) => setForm({ ...form, orderType: e.target.value as 'dine-in' | 'pickup' })} className={inp}>
                  <option value="dine-in">Dine-in</option>
                  <option value="pickup">Pickup</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={create.isPending}
                className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {create.isPending ? 'Generating…' : 'Generate QR'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-s-text">
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Concept filter */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setConceptFilter('')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${!conceptFilter ? 'bg-primary text-primary-on' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
            All concepts
          </button>
          {concepts.map((c) => (
            <button key={c.id} onClick={() => setConceptFilter(c.id)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${conceptFilter === c.id ? 'bg-primary text-primary-on' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
              {c.name}
            </button>
          ))}
        </div>

        {isLoading ? (
          <p className="text-s-muted text-sm">Loading…</p>
        ) : qrCodes.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-3">📱</p>
            <p className="font-semibold text-s-text">No QR codes yet</p>
            <p className="text-sm text-s-muted mt-1">Generate QR codes for tables to enable scan-to-order</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {qrCodes.map((qr) => (
              <div key={qr.id} className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-s-text">{qr.label}</p>
                    <p className="text-xs text-s-muted">{qr.concept.name}{qr.table ? ` · ${qr.table.label}` : ''}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold shrink-0 ${
                    qr.orderType === 'dine-in' ? 'bg-s-blue/20 text-s-blue' : 'bg-s-amber/20 text-s-amber'
                  }`}>
                    {qr.orderType}
                  </span>
                </div>

                {qr.qrImageUrl && (
                  <div className="rounded-lg bg-s-bg border border-s-border p-3 text-center">
                    <p className="text-xs text-s-muted mb-2 font-mono break-all">{qr.qrImageUrl}</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(qr.qrImageUrl!).catch(() => {}) }}
                      className="text-xs text-primary-ink hover:opacity-80">
                      Copy link
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-s-border/50">
                  <div className="text-center">
                    <p className="font-black text-s-blue text-lg">{qr.scanCount}</p>
                    <p className="text-xs text-s-muted">Scans</p>
                  </div>
                  <div className="text-center">
                    <p className="font-black text-primary-ink text-lg">{qr.conversions}</p>
                    <p className="text-xs text-s-muted">Orders</p>
                  </div>
                  <div className="text-center">
                    <p className="font-black text-s-amber text-lg">
                      {qr.scanCount > 0 ? `${Math.round((qr.conversions / qr.scanCount) * 100)}%` : '—'}
                    </p>
                    <p className="text-xs text-s-muted">CVR</p>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button onClick={() => { if (confirm('Delete this QR code?')) del.mutate(qr.id) }}
                    className="text-xs text-s-muted hover:text-s-red transition-colors">
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
