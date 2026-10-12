'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useViewAllTenants } from '../../../components/ui/TenantSwitcher'
import { fmtPkrWhole } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'

// Who may read the staff directory (GET /auth/users: management + HR). Any
// other holder of the procurement module (the buyer) gets the staff already
// assigned to a supplier plus themselves, without a 403 toast (R2-UI-04).
const STAFF_DIRECTORY_ROLES = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager', 'hr']
type StaffLite = { id: string; name: string; role: string }

interface TenantLite { id: string; name: string; slug: string }

interface Supplier {
  id: string
  name: string
  category: string | null
  phone: string | null
  email: string | null
  notes: string | null
  assignedStaffId: string | null
  assignedStaff: { id: string; name: string } | null
  tenantId: string | null
  tenant?: TenantLite | null
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
  draft:            'text-s-muted border-s-border',
  pending_approval: 'text-s-amber border-s-amber',
  approved:         'text-sky-700 border-sky-400',
  sent:             'text-blue-700 border-blue-400',
  received:         'text-primary-ink border-primary',
  partial:          'text-s-amber border-s-amber',
  cancelled:        'text-s-red border-s-red',
}

const CATEGORY_COLORS: Record<string, string> = {
  meat:       'bg-red-500/20 text-red-700',
  fish:       'bg-blue-500/20 text-blue-700',
  farm:       'bg-green-500/20 text-green-700',
  dairy:      'bg-yellow-500/20 text-yellow-700',
  'dry-goods':'bg-orange-500/20 text-orange-700',
}

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
  const viewAll = useViewAllTenants()

  const { data: tenants = [] } = useQuery<TenantLite[]>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get('/tenants/mine'),
    staleTime: 5 * 60_000,
  })

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ['procurement-suppliers'],
    queryFn: () => api.get('/procurement/suppliers'),
  })

  const me = useAuthStore((st) => st.user)
  const canReadDirectory = !!me && STAFF_DIRECTORY_ROLES.includes(me.role)
  const { data: directory } = useQuery<StaffLite[]>({
    queryKey: ['staff'],
    queryFn: () => api.get('/auth/users'),
    enabled: canReadDirectory,
    meta: { background: true },
  })
  // The buyer's fallback: everyone already assigned to a supplier, and me.
  const staff: StaffLite[] = directory ?? (() => {
    const seen = new Map<string, StaffLite>()
    if (me) seen.set(me.id, { id: me.id, name: me.name, role: me.role })
    for (const sup of suppliers) {
      if (sup.assignedStaff && !seen.has(sup.assignedStaff.id)) {
        seen.set(sup.assignedStaff.id, { id: sup.assignedStaff.id, name: sup.assignedStaff.name, role: '' })
      }
    }
    return [...seen.values()]
  })()

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
    <div className="min-h-screen bg-s-bg p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/procurement" className="text-xs text-s-muted hover:text-s-text mb-0.5 inline-block">← Procurement</Link>
          <h1 className="text-2xl font-black text-s-text">Procurement Monitor</h1>
          <p className="text-sm text-s-muted mt-0.5">Track all procurement staff, suppliers, and orders</p>
        </div>
        <a href="/procurement/chat" className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-on hover:opacity-90">
          💬 Supplier Chat
        </a>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-3 flex-wrap">
        <select value={selectedStaff} onChange={(e) => setSelectedStaff(e.target.value)}
          className="rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text">
          <option value="all">All Staff</option>
          {/* Roles that plausibly own supplier accounts. Procurement, the
              management tiers, and BOH-management (head chef) all touch
              ordering — keep the list permissive so the CEO can assign
              suppliers to whoever actually deals with them. */}
          {staff.filter((u) => !directory || [
            'admin', 'manager', 'management',
            'foh_management', 'boh_management',
            'procurement', 'cashier',
          ].includes(u.role)).map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <select value={selectedCat} onChange={(e) => setSelectedCat(e.target.value)}
          className="rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text">
          <option value="all">All Categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Staff cards */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from(byStaff.entries()).map(([staffId, { staffName, suppliers: sups }]) => {
          const pending = pendingByStaff.get(staffId)
          return (
            <div key={staffId} className="rounded-xl border border-s-border bg-s-surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-bold text-s-text">{staffName}</p>
                  <p className="text-xs text-s-muted">{sups.length} supplier{sups.length !== 1 ? 's' : ''}</p>
                </div>
                {pending && pending.count > 0 && (
                  <div className="text-right">
                    <p className="text-sm font-bold text-s-amber">{pending.count} pending</p>
                    <p className="text-xs text-s-muted">{fmtPkrWhole(pending.totalCents)}</p>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                {sups.map((s) => {
                  const catStyle = s.category ? (CATEGORY_COLORS[s.category] ?? 'bg-s-border/30 text-s-muted') : ''
                  // Resolve tenant chip the same way /workforce does — prefer
                  // hydrated relation, fall back to a name lookup in the
                  // operator's tenant list.
                  const tenant: TenantLite | null =
                    s.tenant ?? (s.tenantId ? tenants.find((t) => t.id === s.tenantId) ?? null : null)
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        {s.category && (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${catStyle}`}>
                            {s.category}
                          </span>
                        )}
                        <span className="truncate text-sm text-s-text">{s.name}</span>
                        {/* Indigo brand chip — shown only in portfolio view,
                            mirrors the workforce hub. */}
                        {viewAll && tenant && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                            style={{ background: 'rgb(61 31 59 / 0.15)', color: '#6b2f68' }}>
                            {tenant.name}
                          </span>
                        )}
                        {/* Orphan warning always shows — broken row needing
                            a company assignment via the edit drawer. */}
                        {!s.tenantId && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(255,77,79,0.10)', color: '#b42318' }}
                            title="No company assigned — click Edit to fix.">
                            ⚠ No company
                          </span>
                        )}
                      </div>
                      <button onClick={() => setEditSupplier(s)}
                        className="shrink-0 text-xs text-s-muted hover:text-s-text">Edit</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {byStaff.size === 0 && (
          <p className="col-span-full text-center text-s-muted py-8">No suppliers found. Add suppliers in Procurement.</p>
        )}
      </div>

      {/* Recent orders */}
      <div>
        <h2 className="mb-4 text-lg font-bold text-s-text">Recent Orders (30 days)</h2>
        <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border text-xs uppercase tracking-wide text-s-muted">
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
                const statusClass = STATUS_COLORS[po.status] ?? 'text-s-muted border-s-border'
                return (
                  <tr key={po.id} className="border-b border-s-border last:border-0 hover:bg-s-bg/30">
                    <td className="px-4 py-3 font-medium text-s-text">{po.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {po.supplier?.category && (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[po.supplier.category] ?? 'bg-s-border/30 text-s-muted'}`}>
                          {po.supplier.category}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-s-muted">{sup?.assignedStaff?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${statusClass}`}>
                        {po.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-s-text">{fmtPkrWhole(po.totalCents)}</td>
                    <td className="px-4 py-3 text-s-muted">{daysAgo(po.orderDate)}</td>
                    <td className="px-4 py-3 text-s-muted">
                      {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-PK') : '—'}
                    </td>
                  </tr>
                )
              })}
              {recentOrders.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-s-muted">No orders in the last 30 days</td></tr>
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
          tenants={tenants}
          onClose={() => setEditSupplier(null)}
          onSaved={() => { setEditSupplier(null); void qc.invalidateQueries({ queryKey: ['procurement-suppliers'] }) }}
        />
      )}
    </div>
  )
}

function SupplierEditDrawer({
  supplier, staff, tenants, onClose, onSaved,
}: {
  supplier: Supplier
  staff: { id: string; name: string; role: string }[]
  tenants: TenantLite[]
  onClose: () => void
  onSaved: () => void
}) {
  const [category, setCategory] = useState(supplier.category ?? '')
  const [assignedStaffId, setAssignedStaff] = useState(supplier.assignedStaffId ?? '')
  const [tenantId, setTenantId]   = useState(supplier.tenantId ?? '')
  const [notes, setNotes] = useState(supplier.notes ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`/procurement/suppliers/${supplier.id}`, {
      category: category || null,
      assignedStaffId: assignedStaffId || null,
      // Only send tenantId if it changed (or is being set for an orphan).
      ...(tenantId && tenantId !== (supplier.tenantId ?? '') ? { tenantId } : {}),
      notes: notes || undefined,
    }),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-secondary/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-s-surface p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-s-text">{supplier.name}</h2>
          <button onClick={onClose} className="text-s-muted text-2xl leading-none">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-s-muted">Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)}
              placeholder="meat, fish, farm, dairy, dry-goods…"
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm" />
          </div>
          <div>
            <label className="text-xs text-s-muted">Assigned Procurement Staff</label>
            <select value={assignedStaffId} onChange={(e) => setAssignedStaff(e.target.value)}
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm">
              <option value="">— Unassigned —</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}{u.role ? ` (${u.role})` : ''}</option>)}
            </select>
          </div>
          {tenants.length > 0 && (
            <div>
              <label className="text-xs text-s-muted">
                Company {!supplier.tenantId && <span className="text-red-700">— orphan, pick one</span>}
              </label>
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}
                className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm">
                {!supplier.tenantId && <option value="">— pick a company —</option>}
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-xs text-s-muted">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm resize-none" />
          </div>
        </div>
        {save.isError && <p className="text-sm text-s-red">Save failed</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-s-border py-3 text-s-muted hover:text-s-text text-sm">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="flex-1 rounded-xl bg-primary py-3 font-bold text-primary-on disabled:opacity-50 hover:opacity-90 text-sm">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
