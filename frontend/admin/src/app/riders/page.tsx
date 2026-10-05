'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'

interface ActiveOrder {
  id: string; status: string; customerName: string | null
  concept: { name: string }; placedAt: string
}
interface Rider {
  id: string; name: string; phone: string; vehicleType: string
  status: 'available' | 'busy' | 'offline'; isActive: boolean
  totalDeliveries: number; notes: string | null
  orders: ActiveOrder[]
}
interface DeliveryOrder {
  id: string; status: string; source: string; customerName: string | null
  deliveryNotes: string | null; totalCents: number; placedAt: string
  completedAt: string | null
  riderId: string | null
  concept: { name: string }
  rider?: { id: string; name: string; phone: string } | null
}

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-primary/20 text-primary-ink border border-primary/30',
  busy: 'bg-s-amber/20 text-s-amber border border-s-amber/30',
  offline: 'bg-s-border text-s-muted border border-s-border',
}
const STATUS_DOT: Record<string, string> = {
  available: 'bg-primary',
  busy: 'bg-s-amber',
  offline: 'bg-s-border',
}
const VEHICLE_ICONS: Record<string, string> = {
  bike: '🏍', car: '🚗', bicycle: '🚲', foot: '🚶',
}

export default function RidersPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'dispatch' | 'roster'>('dispatch')
  const [showAdd, setShowAdd] = useState(false)
  const [viewingHistory, setViewingHistory] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ name: '', phone: '', vehicleType: 'bike', notes: '' })
  const [assigningOrder, setAssigningOrder] = useState<string | null>(null)

  const { data: riders = [], isLoading: ridersLoading } = useQuery({
    queryKey: ['riders'],
    queryFn: () => api.get<Rider[]>('/riders'),
    refetchInterval: 15_000,
  })

  const { data: deliveryOrders = [] } = useQuery({
    queryKey: ['orders-delivery'],
    queryFn: () => api.get<{ data: DeliveryOrder[] }>('/orders?status=received,confirmed,preparing,ready&limit=50')
      .then((r) => r.data.filter((o) => o.source !== 'pos')),
    refetchInterval: 10_000,
  })

  const { data: history } = useQuery({
    queryKey: ['rider-history', viewingHistory],
    queryFn: () => api.get<{ rider: Rider; orders: DeliveryOrder[]; totalDeliveries: number }>(`/riders/${viewingHistory}/history`),
    enabled: !!viewingHistory,
  })

  const addMutation = useMutation({
    mutationFn: (body: typeof addForm) => api.post<Rider>('/riders', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['riders'] }); setShowAdd(false); setAddForm({ name: '', phone: '', vehicleType: 'bike', notes: '' }) },
  })

  // Assigning, delivering and rider availability all go through /dispatch —
  // the one set of rider rules (same company, active, not offline; the rider
  // is freed after their last drop).
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/dispatch/riders/${id}/status`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['riders'] }),
    onError: (err: Error) => alert(err.message),
  })

  const assignMutation = useMutation({
    mutationFn: ({ orderId, riderId }: { orderId: string; riderId: string }) =>
      api.post(`/dispatch/orders/${orderId}/assign`, { riderId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['riders'] }); void qc.invalidateQueries({ queryKey: ['orders-delivery'] }); setAssigningOrder(null) },
    onError: (err: Error) => alert(err.message),
  })

  const deliveredMutation = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/delivered`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['riders'] }); void qc.invalidateQueries({ queryKey: ['orders-delivery'] }) },
    onError: (err: Error) => alert(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/riders/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['riders'] }),
  })

  const available = riders.filter((r) => r.status === 'available')
  const busy = riders.filter((r) => r.status === 'busy')
  const offline = riders.filter((r) => r.status === 'offline')
  const unassigned = deliveryOrders.filter((o) => !o.riderId && ['received', 'confirmed', 'preparing', 'ready'].includes(o.status))
  const inTransit = deliveryOrders.filter((o) => o.riderId)

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-1">Rider Portal</h1>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add Rider
        </button>
      </header>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Available', value: available.length, color: 'text-primary-ink' },
          { label: 'On Delivery', value: busy.length, color: 'text-s-amber' },
          { label: 'Offline', value: offline.length, color: 'text-s-muted' },
          { label: 'Unassigned Orders', value: unassigned.length, color: unassigned.length > 0 ? 'text-s-red' : 'text-primary-ink' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-xs text-s-muted">{s.label}</p>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Add rider form */}
      {showAdd && (
        <div className="mb-6 rounded-xl border border-primary bg-s-surface p-4 space-y-3 max-w-lg">
          <h3 className="font-bold text-s-text">Add Rider</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-s-muted">Name</label>
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="Full name" className={inp} />
            </div>
            <div>
              <label className="text-xs text-s-muted">Phone</label>
              <input value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })}
                placeholder="+92 3XX XXXXXXX" className={inp} />
            </div>
            <div>
              <label className="text-xs text-s-muted">Vehicle</label>
              <select value={addForm.vehicleType} onChange={(e) => setAddForm({ ...addForm, vehicleType: e.target.value })} className={inp}>
                <option value="bike">🏍 Bike</option>
                <option value="car">🚗 Car</option>
                <option value="bicycle">🚲 Bicycle</option>
                <option value="foot">🚶 On Foot</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Notes (optional)</label>
              <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                placeholder="Area, shift, etc." className={inp} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => addMutation.mutate(addForm)} disabled={!addForm.name || !addForm.phone || addMutation.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {addMutation.isPending ? 'Saving…' : 'Add Rider'}
            </button>
            <button onClick={() => setShowAdd(false)} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-s-border pb-0">
        {(['dispatch', 'roster'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 capitalize transition-colors
              ${tab === t ? 'border-primary text-primary-ink bg-s-surface' : 'border-transparent text-s-muted hover:text-s-text'}`}>
            {t === 'dispatch' ? `Dispatch Board${unassigned.length > 0 ? ` (${unassigned.length} pending)` : ''}` : 'Rider Roster'}
          </button>
        ))}
      </div>

      {/* ══════════════ DISPATCH TAB ══════════════ */}
      {tab === 'dispatch' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Unassigned orders */}
          <div>
            <h2 className="text-sm font-bold text-s-muted uppercase tracking-widest mb-3">
              Awaiting Rider ({unassigned.length})
            </h2>
            <div className="space-y-3">
              {unassigned.length === 0 && (
                <div className="rounded-xl border border-s-border p-6 text-center text-s-muted text-sm">
                  All orders assigned ✓
                </div>
              )}
              {unassigned.map((order) => (
                <div key={order.id} className="rounded-xl border border-s-red/30 bg-s-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-s-text">
                        {order.customerName ?? 'Guest'} · {order.concept.name}
                      </p>
                      <p className="text-xs text-s-muted mt-0.5">
                        {order.deliveryNotes ?? 'No address'} · PKR {(order.totalCents / 100).toFixed(0)}
                      </p>
                      <p className="text-xs text-s-muted">
                        {new Date(order.placedAt).toLocaleTimeString()} · #{order.id.slice(0, 8)}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize
                      ${order.status === 'ready' ? 'bg-primary/20 text-primary-ink' : 'bg-s-amber/20 text-s-amber'}`}>
                      {order.status}
                    </span>
                  </div>
                  {assigningOrder === order.id ? (
                    <div className="mt-3">
                      <p className="text-xs text-s-muted mb-2">Choose a rider:</p>
                      <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {available.length === 0 && (
                          <p className="text-xs text-s-red">No available riders right now</p>
                        )}
                        {available.map((r) => (
                          <button key={r.id}
                            onClick={() => assignMutation.mutate({ orderId: order.id, riderId: r.id })}
                            disabled={assignMutation.isPending}
                            className="w-full flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-left hover:bg-primary/20 transition-colors disabled:opacity-50">
                            <span>{VEHICLE_ICONS[r.vehicleType]}</span>
                            <div>
                              <p className="text-sm font-semibold text-s-text">{r.name}</p>
                              <p className="text-xs text-s-muted">{r.phone}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setAssigningOrder(null)}
                        className="mt-2 text-xs text-s-muted hover:text-s-text">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setAssigningOrder(order.id)}
                      className="mt-3 w-full rounded-lg bg-primary text-primary-on font-bold py-2 text-sm hover:opacity-90">
                      Assign Rider →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* In transit */}
          <div>
            <h2 className="text-sm font-bold text-s-muted uppercase tracking-widest mb-3">
              In Transit ({inTransit.length})
            </h2>
            <div className="space-y-3">
              {inTransit.length === 0 && (
                <div className="rounded-xl border border-s-border p-6 text-center text-s-muted text-sm">
                  No deliveries in progress
                </div>
              )}
              {inTransit.map((order) => (
                <div key={order.id} className="rounded-xl border border-s-amber/30 bg-s-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-s-text">
                        {order.customerName ?? 'Guest'} · {order.concept.name}
                      </p>
                      <p className="text-xs text-s-muted mt-0.5">
                        {order.deliveryNotes ?? 'No address'} · PKR {(order.totalCents / 100).toFixed(0)}
                      </p>
                      {order.rider && (
                        <p className="text-xs text-s-amber mt-1">
                          {VEHICLE_ICONS[riders.find((r) => r.id === order.rider?.id)?.vehicleType ?? 'bike']} {order.rider.name} · {order.rider.phone}
                        </p>
                      )}
                    </div>
                    <span className="text-xs px-2 py-1 rounded-full bg-s-amber/20 text-s-amber font-medium">
                      In transit
                    </span>
                  </div>
                  {order.status === 'ready' ? (
                    <button onClick={() => deliveredMutation.mutate(order.id)}
                      disabled={deliveredMutation.isPending}
                      className="mt-3 w-full rounded-lg border border-primary text-primary-ink font-bold py-2 text-sm hover:bg-primary/10 transition-colors disabled:opacity-50">
                      Mark Delivered
                    </button>
                  ) : (
                    <p className="mt-3 text-center text-xs text-s-muted">
                      Kitchen still on it ({order.status}) — deliverable once ready
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ ROSTER TAB ══════════════ */}
      {tab === 'roster' && (
        <div className="space-y-3">
          {ridersLoading && <p className="text-s-muted text-sm">Loading riders…</p>}
          {riders.length === 0 && !ridersLoading && (
            <div className="rounded-xl border border-dashed border-s-border p-12 text-center">
              <p className="text-4xl mb-3">🏍</p>
              <p className="font-semibold text-s-text">No riders yet</p>
              <p className="text-sm text-s-muted mt-1">Add your first rider to start dispatching deliveries</p>
              <button onClick={() => setShowAdd(true)}
                className="mt-4 rounded-xl bg-primary text-primary-on font-bold px-6 py-2.5 hover:opacity-90">
                Add Rider
              </button>
            </div>
          )}
          {riders.map((rider) => (
            <div key={rider.id} className="rounded-xl border border-s-border bg-s-surface p-4">
              <div className="flex items-center gap-4 flex-wrap">
                {/* Avatar */}
                <div className="h-12 w-12 rounded-full bg-s-bg border border-s-border flex items-center justify-center text-xl shrink-0">
                  {VEHICLE_ICONS[rider.vehicleType]}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-s-text">{rider.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[rider.status]}`}>
                      <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${STATUS_DOT[rider.status]}`} />
                      {rider.status}
                    </span>
                  </div>
                  <p className="text-sm text-s-muted">{rider.phone}</p>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-xs text-s-muted">{rider.totalDeliveries} deliveries</span>
                    {rider.notes && <span className="text-xs text-s-muted">· {rider.notes}</span>}
                    {rider.orders[0] && (
                      <span className="text-xs text-s-amber">· On: {rider.orders[0].concept.name} order</span>
                    )}
                  </div>
                </div>

                {/* Status controls */}
                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  {(['available', 'busy', 'offline'] as const).map((s) => (
                    <button key={s} onClick={() => statusMutation.mutate({ id: rider.id, status: s })}
                      disabled={rider.status === s || statusMutation.isPending}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors
                        ${rider.status === s ? STATUS_COLORS[s] : 'border border-s-border text-s-muted hover:border-primary hover:text-primary-ink'}`}>
                      {s}
                    </button>
                  ))}
                  <button onClick={() => setViewingHistory(viewingHistory === rider.id ? null : rider.id)}
                    className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs hover:text-s-text transition-colors">
                    History
                  </button>
                  <button onClick={() => { if (window.confirm(`Remove ${rider.name}?`)) deleteMutation.mutate(rider.id) }}
                    className="rounded-lg border border-s-border text-s-red px-2 py-1.5 text-xs hover:border-s-red transition-colors">
                    ✕
                  </button>
                </div>
              </div>

              {/* Delivery history inline */}
              {viewingHistory === rider.id && history && (
                <div className="mt-4 border-t border-s-border pt-4">
                  <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">
                    Last 50 deliveries ({history.totalDeliveries} total)
                  </p>
                  {history.orders.length === 0 && <p className="text-xs text-s-muted">No deliveries yet</p>}
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {history.orders.map((o) => (
                      <div key={o.id} className="flex items-center justify-between text-xs py-1 border-b border-s-border/50 last:border-0">
                        <span className="text-s-text">{o.customerName ?? 'Guest'} · {o.concept.name}</span>
                        <span className="text-s-muted">PKR {(o.totalCents / 100).toFixed(0)} · {o.completedAt ? new Date(o.completedAt).toLocaleDateString() : '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const inp = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none mt-1'
