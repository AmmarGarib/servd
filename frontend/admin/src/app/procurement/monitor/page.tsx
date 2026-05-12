'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Supplier {
  id: string
  name: string
  category: string | null
  phone: string | null
  email: string | null
  notes: string | null
  assignedStaffId: string | null
  assignedStaff: { id: string; name: string } | null
  _count: { purchaseOrders: number; conversations: number }
}

interface PurchaseOrder {
  id: string
  supplierId: string
  status: string
  orderDate: string
  expectedDate: string | null
  receivedDate: string | null
  totalCents: number
  notes: string | null
  reference: string | null
  supplier: { name: string; category: string | null }
  createdByUser?: { name: string } | null
  lines: { id: string; inventoryItem: { name: string }; quantityOrdered: number; unitCostCents: number }[]
}

const STATUS_COLORS: Record<string, string> = {
  draft:            'text-kds-subtext border-kds-border',
  pending_approval: 'text-kds-amber border-kds-amber',
  sent:             'text-blue-400 border-blue-400',
  received:         'text-kds-green border-kds-green',
  partial:          'text-kds-amber border-kds-amber',
  cancelled:        'text-kds-red border-kds-red',
}

const CATEGORY_COLORS: Record<string, string> = {
  meat:       'bg-red-500/20 text-red-300',
  fish:       'bg-blue-500/20 text-blue-300',
  farm:       'bg-green-500/20 text-green-300',
  dairy:      'bg-yellow-500/20 text-yellow-300',
  'dry-goods':'bg-orange-500/20 text-orange-300',
}

function fmt(cents: number) { return `PKR ${(cents / 100).toLocaleString('en-PK')}` }

function daysAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const d = Math.floor(diff / 864e5)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
}

export default function ProcurementMonitorPage() {
  const qc = useQueryClient()
  const [selectedStaff, setSelectedStaff] = useState<string>('all')
  const [selectedCat, setSelectedCat] = useState<string>('all')
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null)

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ['procurement-suppliers'],
    queryFn: () => api.get('/procurement/suppliers'),
  })

  const { data: staff = [] } = useQuery<{ id: string; name: string; role: string }[]>({
    queryKey: ['staff'],
    queryFn: () => api.get('/auth/users'),
  })

  const { data: posResult } = useQuery<{ data: PurchaseOrder[] }>({
    queryKey: ['purchase-orders'],
    queryFn: () => api.get('/procurement/purchase-orders?limit=200'),
  })
  const orders = posResult?.data ?? []

  // Derive unique categories from suppliers
  const categories = [...new Set(suppliers.map((s) => s.category).filter(Boolean))] as string[]

  // Filter suppliers by staff + category
  const visibleSuppliers = suppliers.filter((s) => {
    if (selectedStaff !== 'all' && s.assignedStaffId !== selectedStaff) return false
    if (selectedCat !== 'all' && s.category !== selectedCat) return false
    return true
  })

  // Group suppliers by assigned staff person
  const byStaff = new Map<string, { staffName: string; suppliers: Supplier[] }>()
  for (const s of visibleSuppliers) {
    const key = s.assignedStaffId ?? '__unassigned__'
    const staffName = s.assignedStaff?.name ?? 'Unassigned'
    if (!byStaff.has(key)) byStaff.set(key, { staffName, suppliers: [] })
    byStaff.get(key)!.suppliers.push(s)
  }

  // Pending orders summary per staff
  const pendingByStaff = new Map<string, { count: number; totalCents: number }>()
  for (const po of orders) {
    if (!['received', 'cancelled'].includes(po.status)) {
      const sid = suppliers.find((s) => s.id === po.supplierId)?.assignedStaffId ?? '__unassigned__'
      const cur = pendingByStaff.get(sid) ?? { count: 0, totalCents: 0 }
      pendingByStaff.set(sid, { count: cur.count + 1, totalCents: cur.totalCents + po.totalCents })
    }
  }

  // Recent orders (last 30 days)
  const recentOrders = orders
    .filter((o) => new Date(o.orderDate).getTime() > Date.now() - 30 * 864e5)
    .filter((o) => {
      if (selectedStaff === 'all') return true
      const sup = suppliers.find((s) => s.id === o.supplierId)
      return sup?.assignedStaffId === selectedStaff
    })
    .slice(0, 50)

  return (
    <div className="min-h-screen bg-kds-bg p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/procurement" className="text-xs text-kds-subtext hover:text-kds-text mb-0.5 inline-block">← Procurement</Link>
          <h1 className="text-2xl font-black text-kds-text">Procurement Monitor</h1>
          <p className="text-sm text-kds-subtext mt-0.5">Track all procurement staff, suppliers, and orders</p>
        </div>
        <a href="/procurement/chat" className="rounded-xl bg-kds-green px-4 py-2 text-sm font-bold text-black hover:opacity-90">
          💬 Supplier Chat
        </a>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-3 flex-wrap">
        <select value={selectedStaff} onChange={(e) => setSelectedStaff(e.target.value)}
          className="rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text">
          <option value="all">All Staff</option>
          {staff.filter((u) => ['admin','manager','cashier'].includes(u.role)).map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <select value={selectedCat} onChange={(e) => setSelectedCat(e.target.value)}
          className="rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text">
          <option value="all">All Categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Staff cards */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from(byStaff.entries()).map(([staffId, { staffName, suppliers: sups }]) => {
          const pending = pendingByStaff.get(staffId)
          return (
            <div key={staffId} className="rounded-xl border border-kds-border bg-kds-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-bold text-kds-text">{staffName}</p>
                  <p className="text-xs text-kds-subtext">{sups.length} supplier{sups.length !== 1 ? 's' : ''}</p>
                </div>
                {pending && pending.count > 0 && (
                  <div className="text-right">
                    <p className="text-sm font-bold text-kds-amber">{pending.count} pending</p>
                    <p className="text-xs text-kds-subtext">{fmt(pending.totalCents)}</p>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                {sups.map((s) => {
                  const catStyle = s.category ? (CATEGORY_COLORS[s.category] ?? 'bg-kds-border/30 text-kds-subtext') : ''
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {s.category && (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${catStyle}`}>
                            {s.category}
                          </span>
                        )}
                        <span className="truncate text-sm text-kds-text">{s.name}</span>
                      </div>
                      <button onClick={() => setEditSupplier(s)}
                        className="shrink-0 text-xs text-kds-subtext hover:text-kds-text">Edit</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {byStaff.size === 0 && (
          <p className="col-span-full text-center text-kds-subtext py-8">No suppliers found. Add suppliers in Procurement.</p>
        )}
      </div>

      {/* Recent orders */}
      <div>
        <h2 className="mb-4 text-lg font-bold text-kds-text">Recent Orders (30 days)</h2>
        <div className="overflow-x-auto rounded-xl border border-kds-border bg-kds-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border text-xs uppercase tracking-wide text-kds-subtext">
                <th className="px-4 py-3 text-left">Supplier</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Staff</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Total</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Expected</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((po) => {
                const sup = suppliers.find((s) => s.id === po.supplierId)
                const statusClass = STATUS_COLORS[po.status] ?? 'text-kds-subtext border-kds-border'
                return (
                  <tr key={po.id} className="border-b border-kds-border last:border-0 hover:bg-kds-bg/30">
                    <td className="px-4 py-3 font-medium text-kds-text">{po.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {po.supplier?.category && (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[po.supplier.category] ?? 'bg-kds-border/30 text-kds-subtext'}`}>
                          {po.supplier.category}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext">{sup?.assignedStaff?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${statusClass}`}>
                        {po.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-kds-text">{fmt(po.totalCents)}</td>
                    <td className="px-4 py-3 text-kds-subtext">{daysAgo(po.orderDate)}</td>
                    <td className="px-4 py-3 text-kds-subtext">
                      {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-PK') : '—'}
                    </td>
                  </tr>
                )
              })}
              {recentOrders.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-kds-subtext">No orders in the last 30 days</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit supplier drawer */}
      {editSupplier && (
        <SupplierEditDrawer
          supplier={editSupplier}
          staff={staff}
          onClose={() => setEditSupplier(null)}
          onSaved={() => { setEditSupplier(null); void qc.invalidateQueries({ queryKey: ['procurement-suppliers'] }) }}
        />
      )}
    </div>
  )
}

function SupplierEditDrawer({
  supplier, staff, onClose, onSaved,
}: {
  supplier: Supplier
  staff: { id: string; name: string; role: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [category, setCategory] = useState(supplier.category ?? '')
  const [assignedStaffId, setAssignedStaff] = useState(supplier.assignedStaffId ?? '')
  const [notes, setNotes] = useState(supplier.notes ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`/procurement/suppliers/${supplier.id}`, {
      category: category || null,
      assignedStaffId: assignedStaffId || null,
      notes: notes || undefined,
    }),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-kds-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-kds-text">{supplier.name}</h2>
          <button onClick={onClose} className="text-kds-subtext text-2xl leading-none">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-kds-subtext">Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)}
              placeholder="meat, fish, farm, dairy, dry-goods…"
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm" />
          </div>
          <div>
            <label className="text-xs text-kds-subtext">Assigned Procurement Staff</label>
            <select value={assignedStaffId} onChange={(e) => setAssignedStaff(e.target.value)}
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm">
              <option value="">— Unassigned —</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-kds-subtext">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm resize-none" />
          </div>
        </div>
        {save.isError && <p className="text-sm text-kds-red">Save failed</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext hover:text-kds-text text-sm">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-black disabled:opacity-50 hover:opacity-90 text-sm">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
