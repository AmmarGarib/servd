'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'

function fmt(cents: number) {
  return `PKR ${Math.round(cents / 100).toLocaleString()}`
}
function fmtK(cents: number) {
  const n = cents / 100
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${n.toFixed(0)}`
}

interface Vendor {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  taxId: string | null
  notes: string | null
  _count: { purchaseOrders: number; inventoryItems: number }
}

interface InventoryItem { id: string; name: string; unit: string; unitCostCents: number | null }

interface POLine {
  id: string
  inventoryItemId: string
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
  notes: string | null
  inventoryItem: { name: string; unit: string }
}

interface PurchaseOrder {
  id: string
  supplierId: string
  status: string
  orderDate: string
  expectedDate: string | null
  receivedDate: string | null
  reference: string | null
  notes: string | null
  totalCents: number
  createdBy: string | null
  supplier: { name: string }
  lines: POLine[]
}

const PO_STATUS = ['draft', 'sent', 'partial', 'received', 'cancelled'] as const
const STATUS_BADGE: Record<string, string> = {
  draft:     's-badge-muted',
  sent:      's-badge-blue',
  partial:   's-badge-amber',
  received:  's-badge-teal',
  cancelled: 's-badge-red',
}

interface POLineRow {
  inventoryItemId: string
  quantityOrdered: string
  unitCostCents: string
  notes: string
}
const BLANK_LINE: POLineRow = { inventoryItemId: '', quantityOrdered: '', unitCostCents: '', notes: '' }

export default function VendorsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'vendors' | 'pos'>('vendors')

  // Vendor form
  const [vendorModal, setVendorModal] = useState<Vendor | 'create' | null>(null)
  const [vName, setVName] = useState('')
  const [vPhone, setVPhone] = useState('')
  const [vEmail, setVEmail] = useState('')
  const [vAddress, setVAddress] = useState('')
  const [vTaxId, setVTaxId] = useState('')
  const [vNotes, setVNotes] = useState('')
  const [vError, setVError] = useState('')

  // PO form
  const [poModal, setPoModal] = useState<PurchaseOrder | 'create' | null>(null)
  const [poSupplierId, setPoSupplierId] = useState('')
  const [poExpected, setPoExpected] = useState('')
  const [poReference, setPoReference] = useState('')
  const [poNotes, setPoNotes] = useState('')
  const [poLines, setPoLines] = useState<POLineRow[]>([{ ...BLANK_LINE }])
  const [poError, setPoError] = useState('')

  // Receive modal
  const [receiveModal, setReceiveModal] = useState<PurchaseOrder | null>(null)
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>({})

  // Filters
  const [poStatus, setPoStatus] = useState('')
  const [poVendorFilter, setPoVendorFilter] = useState('')

  const { data: vendors } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<Vendor[]>('/recipes/vendors'),
  })

  const poQs = new URLSearchParams({
    limit: '100',
    ...(poStatus        && { status: poStatus }),
    ...(poVendorFilter  && { supplierId: poVendorFilter }),
  })
  const { data: pos, isLoading: posLoading } = useQuery({
    queryKey: ['purchase-orders', poStatus, poVendorFilter],
    queryFn: () => api.get<PurchaseOrder[]>(`/recipes/purchase-orders?${poQs}`),
  })

  const { data: invItems } = useQuery({
    queryKey: ['inventory-items-flat'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
    enabled: poModal !== null,
  })

  // Mutations
  const createVendor = useMutation({
    mutationFn: (body: unknown) => api.post('/recipes/vendors', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vendors'] }); setVendorModal(null) },
    onError: (e: Error) => setVError(e.message),
  })
  const updateVendor = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.patch(`/recipes/vendors/${id}`, body) as Promise<unknown>,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vendors'] }); setVendorModal(null) },
    onError: (e: Error) => setVError(e.message),
  })
  const createPO = useMutation({
    mutationFn: (body: unknown) => api.post('/recipes/purchase-orders', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); setPoModal(null) },
    onError: (e: Error) => setPoError(e.message),
  })
  const receivePO = useMutation({
    mutationFn: ({ id, lines }: { id: string; lines: { lineId: string; quantityReceived: number }[] }) =>
      api.post(`/recipes/purchase-orders/${id}/receive`, { lines }) as Promise<unknown>,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); setReceiveModal(null) },
  })
  const cancelPO = useMutation({
    mutationFn: (id: string) => api.patch(`/recipes/purchase-orders/${id}/cancel`, {}) as Promise<unknown>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-orders'] }),
  })

  function openCreateVendor() {
    setVName(''); setVPhone(''); setVEmail(''); setVAddress(''); setVTaxId(''); setVNotes(''); setVError('')
    setVendorModal('create')
  }
  function openEditVendor(v: Vendor) {
    setVName(v.name); setVPhone(v.phone ?? ''); setVEmail(v.email ?? '')
    setVAddress(v.address ?? ''); setVTaxId(v.taxId ?? ''); setVNotes(v.notes ?? ''); setVError('')
    setVendorModal(v)
  }

  function openCreatePO() {
    setPoSupplierId(''); setPoExpected(''); setPoReference(''); setPoNotes('')
    setPoLines([{ ...BLANK_LINE }]); setPoError('')
    setPoModal('create')
  }
  function openReceive(po: PurchaseOrder) {
    const qtys: Record<string, string> = {}
    po.lines.forEach((l) => { qtys[l.id] = String(l.quantityOrdered - l.quantityReceived) })
    setReceivedQtys(qtys)
    setReceiveModal(po)
  }

  function addPOLine() { setPoLines((p) => [...p, { ...BLANK_LINE }]) }
  function removePOLine(idx: number) { setPoLines((p) => p.filter((_, i) => i !== idx)) }
  function updatePOLine(idx: number, f: keyof POLineRow, v: string) {
    setPoLines((p) => p.map((l, i) => i === idx ? { ...l, [f]: v } : l))
  }

  function handleVendorSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body = {
      name: vName, phone: vPhone || undefined, email: vEmail || undefined,
      address: vAddress || undefined, taxId: vTaxId || undefined, notes: vNotes || undefined,
    }
    if (typeof vendorModal === 'object' && vendorModal !== null && 'id' in vendorModal) {
      updateVendor.mutate({ id: vendorModal.id, body })
    } else {
      createVendor.mutate(body)
    }
  }

  function handlePOSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPoError('')
    const lines = poLines.filter((l) => l.inventoryItemId && l.quantityOrdered && l.unitCostCents)
    if (!lines.length) { setPoError('Add at least one line item'); return }
    createPO.mutate({
      supplierId: poSupplierId,
      expectedDate: poExpected ? `${poExpected}T00:00:00Z` : undefined,
      reference: poReference || undefined,
      notes: poNotes || undefined,
      lines: lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        quantityOrdered: parseFloat(l.quantityOrdered),
        unitCostCents: Math.round(parseFloat(l.unitCostCents) * 100),
        notes: l.notes || undefined,
      })),
    })
  }

  function handleReceive(e: React.FormEvent) {
    e.preventDefault()
    if (!receiveModal) return
    const lines = receiveModal.lines
      .filter((l) => parseFloat(receivedQtys[l.id] ?? '0') > 0)
      .map((l) => ({ lineId: l.id, quantityReceived: parseFloat(receivedQtys[l.id] ?? '0') }))
    if (!lines.length) return
    receivePO.mutate({ id: receiveModal.id, lines })
  }

  const poTotalValue = pos?.filter((p) => p.status !== 'cancelled')
    .reduce((s, p) => s + p.totalCents, 0) ?? 0

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-s-muted">Accounting</p>
            <h1 className="text-xl font-bold text-s-text">Vendors & Purchase Orders</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/accounting" className="text-xs text-s-teal hover:underline">← Hub</Link>
            {tab === 'vendors'
              ? <button onClick={openCreateVendor} className="s-btn-primary text-xs px-3 py-1.5">+ Add Vendor</button>
              : <button onClick={openCreatePO} className="s-btn-primary text-xs px-3 py-1.5">+ New PO</button>
            }
          </div>
        </div>
      </header>

      <div className="p-6 space-y-4 max-w-6xl mx-auto">

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Vendors', value: vendors?.length ?? '—', color: 'text-s-text' },
            { label: 'Open POs', value: pos?.filter((p) => ['draft', 'sent', 'partial'].includes(p.status)).length ?? '—', color: 'text-s-amber' },
            { label: 'Received (all)', value: pos?.filter((p) => p.status === 'received').length ?? '—', color: 'text-s-teal' },
            { label: 'Total PO Value', value: fmtK(poTotalValue), color: 'text-gradient-brand' },
          ].map((k) => (
            <div key={k.label} className="metric-card">
              <p className="metric-label">{k.label}</p>
              <p className={`metric-value ${k.color}`}>{k.value}</p>
            </div>
          ))}
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-s-border">
          {(['vendors', 'pos'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-s-teal text-s-teal'
                  : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {t === 'vendors' ? 'Vendors' : 'Purchase Orders'}
            </button>
          ))}
        </div>

        {/* ── Vendors tab ───────────────────────────────────────────────────── */}
        {tab === 'vendors' && (
          <div className="s-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="s-table w-full">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Contact</th>
                    <th>Tax ID</th>
                    <th className="text-right">Items</th>
                    <th className="text-right">POs</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {!vendors?.length ? (
                    <tr>
                      <td colSpan={6} className="text-center text-s-dim py-10">
                        No vendors yet — add your first supplier
                      </td>
                    </tr>
                  ) : vendors.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <p className="font-medium text-s-text">{v.name}</p>
                        {v.address && <p className="text-[11px] text-s-dim">{v.address}</p>}
                      </td>
                      <td>
                        {v.phone && <p className="text-sm text-s-muted">{v.phone}</p>}
                        {v.email && <p className="text-xs text-s-dim">{v.email}</p>}
                      </td>
                      <td className="text-s-muted text-sm mono">{v.taxId ?? '—'}</td>
                      <td className="text-right text-s-muted">{v._count.inventoryItems}</td>
                      <td className="text-right text-s-muted">{v._count.purchaseOrders}</td>
                      <td className="text-right">
                        <button onClick={() => openEditVendor(v)}
                          className="text-xs text-s-muted hover:text-s-teal transition-colors px-2 py-1 rounded hover:bg-s-teal-dim">
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── POs tab ───────────────────────────────────────────────────────── */}
        {tab === 'pos' && (
          <>
            <div className="flex flex-wrap gap-3">
              <select value={poStatus} onChange={(e) => setPoStatus(e.target.value)}
                className="s-select text-sm h-9 w-40">
                <option value="">All Statuses</option>
                {PO_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={poVendorFilter} onChange={(e) => setPoVendorFilter(e.target.value)}
                className="s-select text-sm h-9 w-44">
                <option value="">All Vendors</option>
                {vendors?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>

            <div className="s-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      <th>PO / Ref</th>
                      <th>Vendor</th>
                      <th>Order Date</th>
                      <th>Expected</th>
                      <th className="text-right">Lines</th>
                      <th className="text-right">Total</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {posLoading ? (
                      <tr><td colSpan={8} className="text-center text-s-dim py-8">Loading…</td></tr>
                    ) : !pos?.length ? (
                      <tr><td colSpan={8} className="text-center text-s-dim py-10">No purchase orders yet</td></tr>
                    ) : pos.map((po) => (
                      <tr key={po.id}>
                        <td>
                          <p className="font-mono text-xs text-s-text">{po.reference ?? po.id.slice(-8).toUpperCase()}</p>
                        </td>
                        <td className="text-s-text font-medium">{po.supplier.name}</td>
                        <td className="text-s-muted text-sm">{new Date(po.orderDate).toLocaleDateString()}</td>
                        <td className="text-s-muted text-sm">
                          {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : '—'}
                        </td>
                        <td className="text-right text-s-muted">{po.lines.length}</td>
                        <td className="text-right font-semibold text-s-text">{fmt(po.totalCents)}</td>
                        <td>
                          <span className={`s-badge text-[10px] ${STATUS_BADGE[po.status] ?? 's-badge-muted'}`}>
                            {po.status}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {['draft', 'sent', 'partial'].includes(po.status) && (
                              <button onClick={() => openReceive(po)}
                                className="text-xs text-s-teal hover:underline px-2 py-1 rounded hover:bg-s-teal-dim transition-colors">
                                Receive
                              </button>
                            )}
                            {['draft', 'sent'].includes(po.status) && (
                              <button
                                onClick={() => { if (confirm('Cancel this PO?')) cancelPO.mutate(po.id) }}
                                className="text-xs text-s-dim hover:text-s-red transition-colors px-2 py-1 rounded hover:bg-s-red-dim">
                                Cancel
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Vendor Modal ─────────────────────────────────────────────────────── */}
      {vendorModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setVendorModal(null) }}>
          <div className="bg-s-surface border border-s-border rounded-2xl shadow-modal w-full max-w-md animate-scale-in">
            <div className="px-6 py-4 border-b border-s-border flex items-center justify-between">
              <h2 className="font-bold text-s-text">
                {typeof vendorModal === 'object' && vendorModal !== null ? 'Edit Vendor' : 'New Vendor'}
              </h2>
              <button onClick={() => setVendorModal(null)} className="text-s-dim hover:text-s-text text-lg leading-none">✕</button>
            </div>
            <form onSubmit={handleVendorSubmit} className="p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Vendor Name *</label>
                <input value={vName} onChange={(e) => setVName(e.target.value)} required className="s-input w-full" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Phone</label>
                  <input value={vPhone} onChange={(e) => setVPhone(e.target.value)} className="s-input w-full" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Email</label>
                  <input type="email" value={vEmail} onChange={(e) => setVEmail(e.target.value)} className="s-input w-full" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Address</label>
                <input value={vAddress} onChange={(e) => setVAddress(e.target.value)} className="s-input w-full" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Tax ID / NTN</label>
                <input value={vTaxId} onChange={(e) => setVTaxId(e.target.value)} className="s-input w-full" placeholder="e.g. 1234567-1" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Notes</label>
                <textarea value={vNotes} onChange={(e) => setVNotes(e.target.value)} rows={2}
                  className="s-input w-full resize-none" />
              </div>
              {vError && <p className="text-xs text-s-red">{vError}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setVendorModal(null)} className="s-btn-ghost text-sm">Cancel</button>
                <button type="submit"
                  disabled={createVendor.isPending || updateVendor.isPending}
                  className="s-btn-primary text-sm">
                  {createVendor.isPending || updateVendor.isPending ? 'Saving…' : 'Save Vendor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Create PO Modal ───────────────────────────────────────────────────── */}
      {poModal !== null && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setPoModal(null) }}>
          <div className="bg-s-surface border border-s-border rounded-2xl shadow-modal w-full max-w-2xl max-h-[calc(100vh-6rem)] overflow-y-auto animate-scale-in">
            <div className="px-6 py-4 border-b border-s-border flex items-center justify-between">
              <h2 className="font-bold text-s-text">New Purchase Order</h2>
              <button onClick={() => setPoModal(null)} className="text-s-dim hover:text-s-text text-lg leading-none">✕</button>
            </div>
            <form onSubmit={handlePOSubmit} className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Vendor *</label>
                  <select value={poSupplierId} onChange={(e) => setPoSupplierId(e.target.value)}
                    required className="s-select w-full">
                    <option value="">Select vendor…</option>
                    {vendors?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Expected Delivery</label>
                  <input type="date" value={poExpected} onChange={(e) => setPoExpected(e.target.value)}
                    className="s-input w-full" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">PO Reference</label>
                  <input value={poReference} onChange={(e) => setPoReference(e.target.value)}
                    className="s-input w-full" placeholder="e.g. INV-2026-001" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Notes</label>
                  <input value={poNotes} onChange={(e) => setPoNotes(e.target.value)} className="s-input w-full" />
                </div>
              </div>

              {/* Line items */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-s-muted uppercase tracking-wider">Line Items</label>
                  <button type="button" onClick={addPOLine} className="text-xs text-s-teal hover:underline">+ Add Row</button>
                </div>
                {/* Header */}
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-1 text-[10px] text-s-dim uppercase tracking-wider">
                  <span>Ingredient</span><span>Qty</span><span>Unit Cost (PKR)</span><span />
                </div>
                {poLines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                    <select value={line.inventoryItemId}
                      onChange={(e) => updatePOLine(idx, 'inventoryItemId', e.target.value)}
                      className="s-select text-sm" required={idx === 0}>
                      <option value="">Select item…</option>
                      {invItems?.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                    </select>
                    <input type="number" min={0.001} step="any" placeholder="Qty"
                      value={line.quantityOrdered}
                      onChange={(e) => updatePOLine(idx, 'quantityOrdered', e.target.value)}
                      className="s-input w-20 text-sm" required={idx === 0} />
                    <input type="number" min={1} step="any" placeholder="PKR/unit"
                      value={line.unitCostCents}
                      onChange={(e) => updatePOLine(idx, 'unitCostCents', e.target.value)}
                      className="s-input w-28 text-sm" required={idx === 0} />
                    <button type="button" onClick={() => removePOLine(idx)}
                      disabled={poLines.length === 1}
                      className="text-s-dim hover:text-s-red transition-colors disabled:opacity-30 px-1">
                      ✕
                    </button>
                  </div>
                ))}

                {/* Total preview */}
                {poLines.some((l) => l.quantityOrdered && l.unitCostCents) && (
                  <div className="flex justify-end text-sm text-s-muted pt-1">
                    Total: <span className="ml-2 font-bold text-s-text">
                      {fmt(poLines.reduce((s, l) => {
                        return s + (parseFloat(l.quantityOrdered) || 0) * (parseFloat(l.unitCostCents) || 0) * 100
                      }, 0))}
                    </span>
                  </div>
                )}
              </div>

              {poError && <p className="text-xs text-s-red">{poError}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setPoModal(null)} className="s-btn-ghost text-sm">Cancel</button>
                <button type="submit" disabled={createPO.isPending} className="s-btn-primary text-sm">
                  {createPO.isPending ? 'Creating…' : 'Create Purchase Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Receive PO Modal ──────────────────────────────────────────────────── */}
      {receiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setReceiveModal(null) }}>
          <div className="bg-s-surface border border-s-border rounded-2xl shadow-modal w-full max-w-xl animate-scale-in">
            <div className="px-6 py-4 border-b border-s-border flex items-center justify-between">
              <div>
                <h2 className="font-bold text-s-text">Receive PO — {receiveModal.supplier.name}</h2>
                <p className="text-xs text-s-dim">
                  {receiveModal.reference ?? receiveModal.id.slice(-8).toUpperCase()} · {fmt(receiveModal.totalCents)}
                </p>
              </div>
              <button onClick={() => setReceiveModal(null)} className="text-s-dim hover:text-s-text text-lg leading-none">✕</button>
            </div>
            <form onSubmit={handleReceive} className="p-6 space-y-4">
              <p className="text-xs text-s-muted">
                Enter quantities received. Inventory will be updated and unit costs recalculated using weighted average.
              </p>
              <div className="space-y-2">
                {receiveModal.lines.map((line) => {
                  const remaining = line.quantityOrdered - line.quantityReceived
                  return (
                    <div key={line.id} className="flex items-center gap-3 rounded-lg bg-s-elevated border border-s-border p-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-s-text">{line.inventoryItem.name}</p>
                        <p className="text-[11px] text-s-dim">
                          Ordered: {line.quantityOrdered} {line.inventoryItem.unit} ·
                          Received so far: {line.quantityReceived} ·
                          Remaining: {remaining}
                        </p>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <input
                          type="number" min={0} max={remaining} step="any"
                          value={receivedQtys[line.id] ?? ''}
                          onChange={(e) => setReceivedQtys((prev) => ({ ...prev, [line.id]: e.target.value }))}
                          className="s-input w-24 text-sm text-right"
                          placeholder={String(remaining)}
                        />
                        <span className="text-xs text-s-dim w-10">{line.inventoryItem.unit}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setReceiveModal(null)} className="s-btn-ghost text-sm">Cancel</button>
                <button type="submit" disabled={receivePO.isPending} className="s-btn-primary text-sm">
                  {receivePO.isPending ? 'Processing…' : 'Confirm Receipt & Update Stock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
