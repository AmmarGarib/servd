'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { EmptyStateGuide } from '../../components/ui/EmptyStateGuide'

interface InventoryItem {
  id: string; name: string; unit: string; currentStock: number; parLevel: number
  unitCostCents: number | null; supplierId: string | null; notes: string | null
}

interface WasteLog {
  id: string
  quantity: number
  unit: string
  reason: string
  estimatedCostCents: number | null
  notes: string | null
  recordedAt: string
  inventoryItem: { name: string; unit: string }
  recordedBy: { name: string } | null
}

type Tab = 'stock' | 'alerts' | 'waste'

const WASTE_REASONS = ['spoilage', 'over_prep', 'expired', 'damaged', 'other'] as const

function getStockStatus(item: InventoryItem): 'out' | 'low' | 'ok' {
  if (item.currentStock === 0) return 'out'
  if (item.currentStock <= item.parLevel) return 'low'
  return 'ok'
}

function downloadStockCsv(items: InventoryItem[]) {
  const rows = [
    ['Name', 'Category', 'Current Stock', 'Unit', 'Par Level', 'Status'],
    ...items.map((i) => [
      i.name,
      i.notes ?? 'Uncategorised',
      String(i.currentStock),
      i.unit,
      String(i.parLevel),
      getStockStatus(i),
    ]),
  ]
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function InventoryPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('stock')
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ name: '', unit: 'kg', parLevel: '', currentStock: '', notes: '' })
  const [adjustQty, setAdjustQty] = useState<Record<string, string>>({})
  const [wasteItemId, setWasteItemId] = useState<string | null>(null)
  const [wasteForm, setWasteForm] = useState({ quantity: '', unit: 'kg', reason: 'spoilage' as typeof WASTE_REASONS[number], notes: '' })

  // Bulk adjust mode
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkDeltas, setBulkDeltas] = useState<Record<string, string>>({}) // itemId → new absolute value as string

  // Toast state
  const [toast, setToast] = useState<string | null>(null)
  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
  })

  const { data: alerts = [] } = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () => api.get<InventoryItem[]>('/inventory/alerts'),
    enabled: tab === 'alerts',
  })

  const { data: wasteLogs = [], isLoading: wasteLoading } = useQuery({
    queryKey: ['inventory', 'waste-logs'],
    queryFn: () => api.get<WasteLog[]>('/inventory/waste-logs?limit=100'),
    enabled: tab === 'waste',
  })

  const addMutation = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name,
      unit: addForm.unit,
      parLevel: Number(addForm.parLevel),
      currentStock: addForm.currentStock ? Number(addForm.currentStock) : 0,
      notes: addForm.notes || undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowAdd(false)
      setAddForm({ name: '', unit: 'kg', parLevel: '', currentStock: '', notes: '' })
    },
  })

  const adjustMutation = useMutation({
    mutationFn: ({ id, delta }: { id: string; delta: number }) => api.patch(`/inventory/${id}/adjust`, { delta }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inventory'] }),
  })

  const wasteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/inventory/${id}/waste`, {
      quantity: Number(wasteForm.quantity),
      unit: wasteForm.unit,
      reason: wasteForm.reason,
      notes: wasteForm.notes || undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['inventory', 'waste-logs'] })
      setWasteItemId(null)
      setWasteForm({ quantity: '', unit: 'kg', reason: 'spoilage', notes: '' })
    },
  })

  const bulkAdjustMutation = useMutation({
    mutationFn: async (pending: Array<{ id: string; delta: number }>) => {
      await Promise.all(pending.map(({ id, delta }) => api.patch(`/inventory/${id}/adjust`, { delta })))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      setBulkMode(false)
      setBulkDeltas({})
    },
  })

  function adjust(id: string, delta: number) { adjustMutation.mutate({ id, delta }) }

  function applyBulkAdjust() {
    const pending = items
      .filter((item) => bulkDeltas[item.id] !== undefined && bulkDeltas[item.id] !== '')
      .map((item) => {
        const newVal = Number(bulkDeltas[item.id])
        return { id: item.id, delta: newVal - item.currentStock }
      })
      .filter(({ delta }) => delta !== 0)

    if (pending.length === 0) {
      setBulkMode(false)
      return
    }
    bulkAdjustMutation.mutate(pending)
  }

  function exitBulkMode() {
    setBulkMode(false)
    setBulkDeltas({})
  }

  const grouped: Record<string, InventoryItem[]> = {}
  for (const item of items) {
    const cat = item.notes ?? 'Uncategorised'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat]!.push(item)
  }

  const alertCount = items.filter((i) => i.currentStock <= i.parLevel).length
  const totalWasteCost = wasteLogs.reduce((s, w) => s + (w.estimatedCostCents ?? 0), 0)

  return (
    <div className="min-h-screen bg-kds-bg">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-xl border border-kds-border bg-kds-card px-4 py-3 text-sm text-kds-text shadow-xl">
          {toast}
        </div>
      )}

      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Inventory</h1>
          <p className="text-sm text-kds-subtext">
            {items.length} items tracked{alertCount > 0 ? ` · ` : ''}
            {alertCount > 0 && <span className="text-kds-red font-semibold">{alertCount} low stock alert{alertCount !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add item
        </button>
      </header>

      {alertCount > 0 && (
        <div className="mx-6 mt-4 rounded-xl border border-kds-red/40 bg-red-950/15 px-4 py-3 flex items-center gap-3 cursor-pointer"
          onClick={() => setTab('alerts')}>
          <span className="text-lg leading-none">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-kds-red">
              {alertCount} item{alertCount !== 1 ? 's' : ''} below par level
            </p>
            <p className="text-xs text-kds-red/70 mt-0.5">
              {items.filter(i => i.currentStock <= i.parLevel).map(i => i.name).slice(0, 4).join(', ')}
              {alertCount > 4 ? ` +${alertCount - 4} more` : ''}
            </p>
          </div>
          <span className="text-xs text-kds-red/60 shrink-0">View alerts →</span>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-89px)]">
        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 border-b border-kds-border pb-0">
          {([
            { key: 'stock', label: 'All stock' },
            { key: 'alerts', label: alertCount > 0 ? `Alerts (${alertCount})` : 'Alerts' },
            { key: 'waste', label: 'Waste log' },
          ] as { key: Tab; label: string }[]).map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                ${tab === t.key ? 'border-kds-green text-kds-green bg-kds-card' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Add form */}
          {showAdd && (
            <div className="rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
              <p className="font-bold text-kds-text text-sm">Add inventory item</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <F label="Item name">
                  <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="Chicken breast" className={fi} autoFocus />
                </F>
                <F label="Unit">
                  <select value={addForm.unit} onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })} className={fi}>
                    {['kg', 'g', 'L', 'ml', 'pcs', 'box', 'bag', 'bottle'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </F>
                <F label="Par level">
                  <input type="number" value={addForm.parLevel} onChange={(e) => setAddForm({ ...addForm, parLevel: e.target.value })}
                    placeholder="5" className={fi} />
                </F>
                <F label="Current stock (optional)">
                  <input type="number" value={addForm.currentStock} onChange={(e) => setAddForm({ ...addForm, currentStock: e.target.value })}
                    placeholder="0" className={fi} />
                </F>
                <F label="Notes / category (optional)">
                  <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                    placeholder="Proteins, Veg, Dry goods…" className={fi} />
                </F>
              </div>
              <div className="flex gap-2">
                <button onClick={() => addMutation.mutate()} disabled={!addForm.name || !addForm.parLevel || addMutation.isPending}
                  className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {addMutation.isPending ? 'Adding…' : 'Add item'}
                </button>
                <button onClick={() => setShowAdd(false)}
                  className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
              </div>
            </div>
          )}

          {/* Log Waste inline form */}
          {wasteItemId && (
            <div className="rounded-xl border border-kds-red/50 bg-red-950/10 p-4 space-y-3">
              <p className="font-bold text-kds-red text-sm">
                Log waste — {items.find((i) => i.id === wasteItemId)?.name}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <F label="Quantity">
                  <input type="number" step="0.01" value={wasteForm.quantity}
                    onChange={(e) => setWasteForm({ ...wasteForm, quantity: e.target.value })}
                    placeholder="2.5" className={fi} autoFocus />
                </F>
                <F label="Unit">
                  <select value={wasteForm.unit} onChange={(e) => setWasteForm({ ...wasteForm, unit: e.target.value })} className={fi}>
                    {['kg', 'g', 'L', 'ml', 'pcs', 'box', 'bag', 'bottle'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </F>
                <F label="Reason">
                  <select value={wasteForm.reason} onChange={(e) => setWasteForm({ ...wasteForm, reason: e.target.value as typeof WASTE_REASONS[number] })} className={fi}>
                    {WASTE_REASONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                  </select>
                </F>
                <F label="Notes (optional)">
                  <input value={wasteForm.notes} onChange={(e) => setWasteForm({ ...wasteForm, notes: e.target.value })}
                    placeholder="Describe waste…" className={fi} />
                </F>
              </div>
              <div className="flex gap-2">
                <button onClick={() => wasteMutation.mutate(wasteItemId)}
                  disabled={!wasteForm.quantity || wasteMutation.isPending}
                  className="rounded-xl bg-kds-red text-white font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {wasteMutation.isPending ? 'Logging…' : 'Log waste & deduct stock'}
                </button>
                <button onClick={() => setWasteItemId(null)}
                  className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
              </div>
            </div>
          )}

          {/* ════ ALL STOCK ════ */}
          {tab === 'stock' && (
            isLoading ? <p className="text-kds-subtext text-sm">Loading…</p> :
            Object.keys(grouped).length === 0 ? (
              <EmptyStateGuide
                icon="📦"
                title="Track what you cook with"
                description="Inventory drives recipe costing, auto-86, demand forecasting, and reorder alerts. Add raw ingredients first — finished menu items get linked via Recipe Costing."
                whyItMatters="When inventory hits zero, the platform auto-disables menu items across POS, storefront, and aggregators. No more 'sorry, we ran out' calls to disappointed customers."
                samples={[
                  { emoji: '🐔', title: 'Chicken (boneless)', hint: 'unit: kg · par: 10 kg · supplier: Mubarak Meat' },
                  { emoji: '🌶', title: 'Red chili powder', hint: 'unit: kg · par: 2 kg · supplier: Karachi Spice Co' },
                  { emoji: '🛢',  title: 'Cooking oil',       hint: 'unit: L · par: 20 L · supplier: City Distributors' },
                ]}
                primaryAction={{ label: 'Add your first ingredient', onClick: () => setShowAdd(true) }}
                secondaryAction={{ label: 'Set up suppliers first', href: '/procurement/chat' }}
              />
            ) : (
              <>
                {/* Bulk Adjust toolbar */}
                <div className="flex items-center gap-3">
                  {!bulkMode ? (
                    <>
                      <button
                        onClick={() => { setBulkMode(true); setBulkDeltas({}) }}
                        className="text-sm rounded-xl border border-kds-border px-4 py-2 text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors font-semibold">
                        Bulk Adjust
                      </button>
                      <button
                        onClick={() => downloadStockCsv(items)}
                        className="text-sm rounded-xl border border-kds-border px-4 py-2 text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors font-semibold">
                        Export CSV
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-kds-text">Bulk adjust mode</span>
                      <span className="text-xs text-kds-subtext">Enter new stock values for any items you want to update, then click Apply.</span>
                      <div className="ml-auto flex gap-2">
                        <button
                          onClick={applyBulkAdjust}
                          disabled={bulkAdjustMutation.isPending}
                          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                          {bulkAdjustMutation.isPending ? 'Applying…' : 'Apply All'}
                        </button>
                        <button
                          onClick={exitBulkMode}
                          className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {Object.entries(grouped).map(([cat, catItems]) => (
                  <div key={cat}>
                    <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">{cat}</p>
                    <div className="rounded-xl border border-kds-border overflow-hidden">
                      {catItems.map((item) => {
                        const isLow = item.currentStock <= item.parLevel
                        const isEditing = editingId === item.id
                        const bulkVal = bulkDeltas[item.id] ?? ''
                        const newVal = bulkVal !== '' ? Number(bulkVal) : item.currentStock
                        const delta = newVal - item.currentStock
                        return (
                          <div key={item.id}
                            className={`border-b border-kds-border/50 last:border-0 transition-colors ${isLow ? 'bg-red-950/5' : ''}`}>
                            <div className="flex items-center justify-between px-4 py-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <button onClick={() => !bulkMode && setEditingId(isEditing ? null : item.id)}
                                  className={`text-sm font-semibold hover:text-kds-green transition-colors ${isLow ? 'text-kds-red' : 'text-kds-text'}`}>
                                  {item.name}
                                </button>
                                {isLow && <span className="text-xs font-bold text-kds-red bg-red-950/30 px-2 py-0.5 rounded-full">Low stock</span>}
                              </div>

                              {bulkMode ? (
                                /* ── Bulk adjust row ── */
                                <div className="flex items-center gap-3 shrink-0">
                                  <span className="text-xs text-kds-subtext">
                                    Current: <span className="font-semibold text-kds-text">{item.currentStock}</span>
                                    {bulkVal !== '' && delta !== 0 && (
                                      <span className={delta > 0 ? 'text-kds-green' : 'text-kds-red'}>
                                        {' '}→ New: {newVal} ({delta > 0 ? `+${delta}` : delta})
                                      </span>
                                    )}
                                  </span>
                                  <input
                                    type="number"
                                    value={bulkVal}
                                    placeholder={String(item.currentStock)}
                                    onChange={(e) => setBulkDeltas((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                    className="w-20 rounded-lg bg-kds-bg border border-kds-border px-2 py-1 text-sm text-kds-text focus:border-kds-green focus:outline-none"
                                  />
                                  <span className="text-xs text-kds-subtext">{item.unit}</span>
                                </div>
                              ) : (
                                /* ── Normal row ── */
                                <div className="flex items-center gap-2 shrink-0">
                                  <div className="flex items-center gap-1">
                                    <button onClick={() => adjust(item.id, -1)} disabled={adjustMutation.isPending}
                                      className="h-7 w-7 rounded-lg bg-kds-bg border border-kds-border text-kds-text text-sm hover:border-kds-red hover:text-kds-red transition-colors">
                                      −
                                    </button>
                                    <span className={`font-black text-lg w-14 text-center ${isLow ? 'text-kds-red' : 'text-kds-text'}`}>
                                      {item.currentStock}
                                    </span>
                                    <button onClick={() => adjust(item.id, 1)} disabled={adjustMutation.isPending}
                                      className="h-7 w-7 rounded-lg bg-kds-bg border border-kds-border text-kds-text text-sm hover:border-kds-green hover:text-kds-green transition-colors">
                                      +
                                    </button>
                                  </div>
                                  <span className="text-xs text-kds-subtext w-16">{item.unit} · par {item.parLevel}</span>
                                  <button onClick={() => { setWasteItemId(item.id); setWasteForm({ ...wasteForm, unit: item.unit }) }}
                                    className="text-xs px-2 py-1 rounded-lg border border-kds-red/30 text-kds-red/70 hover:border-kds-red hover:text-kds-red transition-colors">
                                    waste
                                  </button>
                                </div>
                              )}
                            </div>
                            {!bulkMode && isEditing && (
                              <div className="px-4 pb-3 flex items-center gap-3">
                                <span className="text-xs text-kds-subtext">Set to:</span>
                                <input type="number" placeholder={String(item.currentStock)}
                                  value={adjustQty[item.id] ?? ''}
                                  onChange={(e) => setAdjustQty({ ...adjustQty, [item.id]: e.target.value })}
                                  className="w-20 rounded-lg bg-kds-bg border border-kds-border px-2 py-1 text-sm text-kds-text focus:border-kds-green focus:outline-none" />
                                <button
                                  onClick={() => {
                                    const qty = Number(adjustQty[item.id])
                                    if (!isNaN(qty)) adjust(item.id, qty - item.currentStock)
                                    setEditingId(null)
                                    setAdjustQty({ ...adjustQty, [item.id]: '' })
                                  }}
                                  className="rounded-lg bg-kds-green text-black font-bold px-3 py-1 text-xs hover:opacity-90">
                                  Update
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </>
            )
          )}

          {/* ════ ALERTS ════ */}
          {tab === 'alerts' && (
            alerts.length === 0 ? (
              <div className="text-center py-16 text-kds-subtext">
                <p className="text-4xl mb-3">✅</p>
                <p className="font-semibold text-kds-text">All stocked up</p>
                <p className="text-sm mt-1">No items are below par level</p>
              </div>
            ) : (
              <div className="rounded-xl border border-kds-red/30 overflow-hidden">
                <div className="px-4 py-3 bg-red-950/10 border-b border-kds-red/30 flex items-center justify-between">
                  <p className="font-bold text-kds-red text-sm">⚠ {alerts.length} item{alerts.length !== 1 ? 's' : ''} below par level</p>
                  <p className="text-xs text-kds-subtext">Suggested order quantities to reach par</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-kds-card border-b border-kds-red/20">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs text-kds-subtext font-semibold">Item</th>
                      <th className="px-4 py-2.5 text-right text-xs text-kds-subtext font-semibold">Current</th>
                      <th className="px-4 py-2.5 text-right text-xs text-kds-subtext font-semibold">Par Level</th>
                      <th className="px-4 py-2.5 text-right text-xs text-kds-subtext font-semibold">Suggested Order Qty</th>
                      <th className="px-4 py-2.5 text-right text-xs text-kds-subtext font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((item) => {
                      const suggestedQty = Math.max(0, item.parLevel - item.currentStock)
                      return (
                        <tr key={item.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/40">
                          <td className="px-4 py-3">
                            <p className="text-sm font-semibold text-kds-text">{item.name}</p>
                            <p className="text-xs text-kds-subtext">{item.notes ?? 'Uncategorised'}</p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="text-lg font-black text-kds-red">
                              {item.currentStock}
                              <span className="text-xs font-normal ml-1">{item.unit}</span>
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-kds-subtext">
                            {item.parLevel} {item.unit}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="inline-flex items-center gap-1 rounded-full bg-kds-amber/10 border border-kds-amber/30 px-3 py-1 text-sm font-semibold text-kds-amber">
                              Order {suggestedQty} {item.unit}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => showToast('Purchase order feature coming soon')}
                              className="text-xs px-3 py-1.5 rounded-lg border border-kds-border text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors whitespace-nowrap">
                              Create PO
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* ════ WASTE LOG ════ */}
          {tab === 'waste' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-kds-text">Waste & Spoilage Log</p>
                  <p className="text-xs text-kds-subtext mt-0.5">
                    {wasteLogs.length} entries · estimated cost:{' '}
                    <span className="text-kds-red font-semibold">
                      PKR {Math.round(totalWasteCost / 100).toLocaleString()}
                    </span>
                  </p>
                </div>
                <button onClick={() => setTab('stock')}
                  className="text-xs rounded-lg bg-kds-red/10 border border-kds-red/30 text-kds-red px-3 py-1.5 font-semibold hover:bg-kds-red/20">
                  Log waste →
                </button>
              </div>

              {wasteLoading ? (
                <p className="text-kds-subtext text-sm">Loading…</p>
              ) : wasteLogs.length === 0 ? (
                <div className="text-center py-16 text-kds-subtext">
                  <p className="text-4xl mb-3">✅</p>
                  <p className="font-semibold text-kds-text">No waste logged</p>
                  <p className="text-sm mt-1">Use the "waste" button on any inventory item to record spoilage</p>
                </div>
              ) : (
                <div className="rounded-xl border border-kds-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-kds-border bg-kds-card">
                        <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Item</th>
                        <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Qty</th>
                        <th className="px-4 py-2.5 text-xs text-kds-subtext font-semibold">Reason</th>
                        <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Est. Cost</th>
                        <th className="px-4 py-2.5 text-xs text-kds-subtext font-semibold">Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wasteLogs.map((log) => (
                        <tr key={log.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/40">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-kds-text">{log.inventoryItem.name}</p>
                            {log.notes && <p className="text-xs text-kds-subtext mt-0.5">{log.notes}</p>}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-kds-red">
                            {log.quantity} {log.unit}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-kds-red/10 text-kds-red capitalize">
                              {log.reason.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-kds-subtext">
                            {log.estimatedCostCents != null
                              ? `PKR ${Math.round(log.estimatedCostCents / 100).toLocaleString()}`
                              : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-kds-subtext">
                            {new Date(log.recordedAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            {log.recordedBy && <span className="ml-1 opacity-60">· {log.recordedBy.name}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-kds-subtext font-medium">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

const fi = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none transition-colors'
