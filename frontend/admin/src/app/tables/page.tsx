'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'

interface Table {
  id: string; label: string; capacity: number | null; status: string; conceptId: string
  concept: { name: string }
}
interface Concept { id: string; name: string; primaryColor: string | null }

const STATUS_CYCLE = ['available', 'seated', 'ordered', 'eating', 'check', 'reserved']
const STATUS_COLORS: Record<string, string> = {
  available: 'bg-kds-green/20 text-kds-green border-kds-green/30',
  seated:    'bg-kds-blue/20 text-kds-blue border-kds-blue/30',
  ordered:   'bg-kds-amber/20 text-kds-amber border-kds-amber/30',
  eating:    'bg-orange-900/30 text-orange-400 border-orange-400/30',
  check:     'bg-purple-900/30 text-purple-400 border-purple-400/30',
  reserved:  'bg-kds-border text-kds-subtext border-kds-border',
}
const STATUS_LABEL: Record<string, string> = {
  available: '● Available', seated: '● Seated', ordered: '◑ Ordered',
  eating: '◑ Eating', check: '⊙ Bill', reserved: '○ Reserved',
}

type Tab = 'floorplan' | 'configure'

export default function TablesPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('floorplan')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [editingTable, setEditingTable] = useState<Table | null>(null)
  const [addForm, setAddForm] = useState({ label: '', capacity: '', conceptId: '' })
  const [showAdd, setShowAdd] = useState(false)

  const { data: tables = [] } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api.get<Table[]>('/tables'),
    refetchInterval: 15_000,
  })

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/tables/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tables'] }),
  })

  const updateTable = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Table> }) => api.patch(`/tables/${id}`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tables'] }); setEditingTable(null) },
  })

  const addTable = useMutation({
    mutationFn: () => api.post('/tables', { label: addForm.label, capacity: addForm.capacity ? Number(addForm.capacity) : null, conceptId: addForm.conceptId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tables'] }); setShowAdd(false); setAddForm({ label: '', capacity: '', conceptId: '' }) },
  })

  const deleteTable = useMutation({
    mutationFn: (id: string) => api.delete(`/tables/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tables'] }); setEditingTable(null) },
  })

  const filtered = conceptFilter === 'all' ? tables : tables.filter((t) => t.conceptId === conceptFilter)
  const available = filtered.filter((t) => t.status === 'available').length
  const occupied = filtered.length - available

  function nextStatus(current: string) {
    const i = STATUS_CYCLE.indexOf(current)
    return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length] ?? 'available'
  }

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Floor Plan</h1>
          <p className="text-sm text-kds-subtext">
            {available} available · {occupied} occupied
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setConceptFilter('all')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              conceptFilter === 'all' ? 'bg-kds-green text-black' : 'bg-kds-card border border-kds-border text-kds-subtext hover:text-kds-text'
            }`}>All</button>
          {concepts.map((c) => (
            <button key={c.id} onClick={() => setConceptFilter(c.id)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors border ${
                conceptFilter === c.id ? 'text-black border-transparent' : 'bg-kds-card border-kds-border text-kds-subtext hover:text-kds-text'
              }`}
              style={conceptFilter === c.id ? { background: c.primaryColor ?? '#6366f1' } : {}}>
              {c.name}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-col h-[calc(100vh-89px)]">
        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 border-b border-kds-border pb-0">
          {(['floorplan', 'configure'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors capitalize
                ${tab === t ? 'border-kds-green text-kds-green bg-kds-card' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
              {t === 'floorplan' ? 'Floor plan' : 'Configure tables'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">

          {/* ════ FLOOR PLAN ════ */}
          {tab === 'floorplan' && (
            <div className="space-y-6">
              {/* Status legend */}
              <div className="flex flex-wrap gap-2">
                {STATUS_CYCLE.map((s) => (
                  <span key={s} className={`rounded-full px-2.5 py-1 text-xs font-medium border ${STATUS_COLORS[s] ?? ''}`}>
                    {STATUS_LABEL[s]}
                  </span>
                ))}
                <span className="text-xs text-kds-subtext self-center ml-1">— click to cycle</span>
              </div>

              {filtered.length === 0 ? (
                <div className="text-center py-16 text-kds-subtext">
                  <p className="text-4xl mb-3">🪑</p>
                  <p className="font-semibold text-kds-text">No tables configured</p>
                  <p className="text-sm mt-1">Add tables in the Configure tab</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {filtered.map((table) => (
                    <button key={table.id}
                      onClick={() => updateStatus.mutate({ id: table.id, status: nextStatus(table.status) })}
                      className={`relative rounded-xl border-2 px-4 py-5 font-bold text-sm transition-all hover:scale-105 active:scale-95 min-w-[80px] ${STATUS_COLORS[table.status] ?? ''}`}>
                      <p className="text-lg font-black">{table.label}</p>
                      {table.capacity && <p className="text-xs opacity-70 mt-0.5">{table.capacity}p</p>}
                      <p className="text-xs capitalize mt-1 opacity-80">{table.status}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════ CONFIGURE ════ */}
          {tab === 'configure' && (
            <div className="max-w-2xl space-y-4">
              <p className="text-sm text-kds-subtext">Add, rename, and remove tables. Changes take effect on the floor plan immediately.</p>

              {/* Add table form */}
              {showAdd ? (
                <div className="rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
                  <p className="font-bold text-kds-text text-sm">Add table</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-kds-subtext">Label</label>
                      <input value={addForm.label} onChange={(e) => setAddForm({ ...addForm, label: e.target.value })}
                        placeholder="T1, A3, Bar 1…" className={fi} autoFocus />
                    </div>
                    <div>
                      <label className="text-xs text-kds-subtext">Capacity (optional)</label>
                      <input type="number" value={addForm.capacity} onChange={(e) => setAddForm({ ...addForm, capacity: e.target.value })}
                        placeholder="4" className={fi} />
                    </div>
                    <div>
                      <label className="text-xs text-kds-subtext">Concept</label>
                      <select value={addForm.conceptId} onChange={(e) => setAddForm({ ...addForm, conceptId: e.target.value })} className={fi}>
                        <option value="">Select…</option>
                        {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => addTable.mutate()} disabled={!addForm.label || !addForm.conceptId || addTable.isPending}
                      className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                      {addTable.isPending ? 'Adding…' : 'Add table'}
                    </button>
                    <button onClick={() => setShowAdd(false)}
                      className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowAdd(true)}
                  className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
                  + Add table
                </button>
              )}

              {/* Table list */}
              <div className="rounded-xl border border-kds-border overflow-hidden">
                {filtered.map((t) => (
                  <div key={t.id}>
                    <div className="flex items-center justify-between px-4 py-3 border-b border-kds-border last:border-0 hover:bg-kds-card/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-sm font-black border ${STATUS_COLORS[t.status] ?? ''}`}>
                          {t.label}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-kds-text">{t.label}</p>
                          <p className="text-xs text-kds-subtext">{t.concept.name}{t.capacity ? ` · ${t.capacity} seats` : ''}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[t.status] ?? ''}`}>
                          {t.status}
                        </span>
                        <button onClick={() => setEditingTable(editingTable?.id === t.id ? null : t)}
                          className="text-xs text-kds-subtext hover:text-kds-text px-2 py-1 rounded hover:bg-kds-bg transition-colors">
                          {editingTable?.id === t.id ? '▲' : 'Edit ▼'}
                        </button>
                      </div>
                    </div>
                    {editingTable?.id === t.id && (
                      <div className="px-4 py-3 bg-kds-card/30 border-b border-kds-border">
                        <div className="flex items-center gap-3">
                          <input defaultValue={t.label}
                            onBlur={(e) => updateTable.mutate({ id: t.id, body: { label: e.target.value } })}
                            className={`${fi} w-28`} />
                          <input type="number" defaultValue={t.capacity ?? ''} placeholder="Capacity"
                            onBlur={(e) => updateTable.mutate({ id: t.id, body: { capacity: e.target.value ? Number(e.target.value) : null } })}
                            className={`${fi} w-24`} />
                          <button onClick={() => { if (window.confirm(`Delete table "${t.label}"?`)) deleteTable.mutate(t.id) }}
                            className="rounded-lg px-3 py-2 text-xs font-bold text-kds-red border border-kds-red/30 hover:bg-red-950/20 transition-colors">
                            Delete
                          </button>
                        </div>
                        <p className="text-xs text-kds-subtext mt-1.5">Changes save on focus out</p>
                      </div>
                    )}
                  </div>
                ))}
                {filtered.length === 0 && <p className="px-4 py-8 text-center text-kds-subtext text-sm">No tables yet</p>}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

const fi = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none transition-colors'
