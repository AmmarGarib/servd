'use client'
import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { ApAging } from '../../components/finance/ApAging'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string; name: string; phone?: string | null; email?: string | null
  address?: string | null; taxId?: string | null; notes?: string | null
  paymentTermsDays: number; leadTimeDays?: number | null; openingBalanceCents: number
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
  _count?: { purchaseOrders: number; inventoryItems: number; bills: number; payments: number }
}

interface PoLine {
  id: string; inventoryItemId: string; quantityOrdered: number; quantityReceived: number
  unitCostCents: number; notes?: string | null
  inventoryItem?: { name: string; unit: string } | null
}

interface PurchaseOrder {
  id: string; supplierId: string; status: string; reference?: string | null
  expectedDate?: string | null; notes?: string | null; totalCents: number
  createdAt: string; approvedAt?: string | null; sentAt?: string | null
  cancelReason?: string | null; rejectedReason?: string | null
  supplier?: { name: string; email?: string | null } | null
  lines?: PoLine[]
}

interface Bill {
  id: string; supplierId: string; poId?: string | null; billNumber: string
  billDate: string; dueDate: string; status: string
  subtotalCents: number; taxCents: number; totalCents: number; whtCents: number; paidCents: number
  notes?: string | null; attachmentUrl?: string | null
  supplier?: { name: string } | null
  po?: { id: string; reference?: string | null } | null
}

// What the supplier is still owed: net of the withholding the ledger moved to
// FBR (the server's billDueCents rule).
const billDue = (b: Pick<Bill, 'totalCents' | 'whtCents' | 'paidCents'>) => b.totalCents - (b.whtCents ?? 0) - b.paidCents

interface SupplierPayment {
  id: string; supplierId: string; paymentDate: string; method: string
  reference?: string | null; amountCents: number; appliedCents: number
  notes?: string | null
  supplier?: { name: string } | null
}


interface ReorderItem {
  id: string; name: string; unit: string; currentStock: number; parLevel: number
  reorderQty: number; costPerUnit?: number | null
  suppliers?: Array<{ id: string; name: string }> | null
}

interface InventoryItem { id: string; name: string; unit: string }
interface PriceHistoryRow {
  id: string; inventoryItemId: string; supplierId?: string | null
  oldCostCents?: number | null; newCostCents: number; source: string
  recordedAt: string
  inventoryItem?: { name: string; unit: string } | null
  supplier?: { name: string } | null
}

type Tab = 'pos' | 'bills' | 'payments' | 'suppliers' | 'aging' | 'reorder' | 'approvals' | 'history'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pkr = (cents: number) =>
  `PKR ${Math.floor(cents / 100).toLocaleString()}`

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-zinc-400 bg-zinc-800/60',
  pending_approval: 'text-amber-400 bg-amber-950/40',
  approved: 'text-sky-400 bg-sky-950/40',
  sent: 'text-blue-400 bg-blue-950/40',
  partial: 'text-purple-400 bg-purple-950/40',
  received: 'text-kds-green bg-green-950/40',
  cancelled: 'text-zinc-500 bg-zinc-900/60',
  open: 'text-amber-400 bg-amber-950/40',
  partially_paid: 'text-purple-400 bg-purple-950/40',
  paid: 'text-kds-green bg-green-950/40',
  void: 'text-zinc-500 bg-zinc-900/60',
  overdue: 'text-kds-red bg-red-950/40',
}

function Badge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'text-zinc-400 bg-zinc-800/60'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function fmt(iso: string) { return new Date(iso).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: '2-digit' }) }

const fi = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-kds-subtext font-medium">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProcurementPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('pos')

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'pos',       label: 'Purchase Orders', icon: '📋' },
    { id: 'bills',     label: 'Bills (AP)',       icon: '🧾' },
    { id: 'payments',  label: 'Payments',         icon: '💳' },
    { id: 'suppliers', label: 'Suppliers',        icon: '🏭' },
    { id: 'aging',     label: 'Aging',            icon: '📅' },
    { id: 'reorder',   label: 'Reorder',          icon: '🔄' },
    { id: 'approvals', label: 'Approvals',        icon: '✅' },
    { id: 'history',   label: 'Price History',    icon: '📈' },
  ]

  return (
    <div className="min-h-screen bg-kds-bg flex flex-col">
      <header className="border-b border-kds-border px-6 py-4 shrink-0">
        <h1 className="text-2xl font-black text-kds-text">Procurement</h1>
        <p className="text-sm text-kds-subtext mt-0.5">Purchase orders · Accounts payable · Supplier management</p>
      </header>

      {/* Tab strip */}
      <div className="flex gap-0.5 px-6 pt-4 border-b border-kds-border overflow-x-auto shrink-0 scrollbar-hide">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 whitespace-nowrap transition-colors
              ${tab === t.id ? 'border-kds-green text-kds-green bg-kds-card' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'pos'       && <PoTab       qc={qc} />}
        {tab === 'bills'     && <BillsTab    qc={qc} />}
        {tab === 'payments'  && <PaymentsTab qc={qc} />}
        {tab === 'suppliers' && <SuppliersTab qc={qc} />}
        {tab === 'aging'     && <AgingTab />}
        {tab === 'reorder'   && <ReorderTab />}
        {tab === 'approvals' && <ApprovalsTab qc={qc} />}
        {tab === 'history'   && <PriceHistoryTab />}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PURCHASE ORDERS TAB
// ══════════════════════════════════════════════════════════════════════════════

function PoTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  const qs = new URLSearchParams()
  if (statusFilter) qs.set('status', statusFilter)

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['procurement', 'pos', statusFilter],
    queryFn: () => api.get<PurchaseOrder[]>(`/procurement/purchase-orders?${qs}`),
  })

  const { data: detail } = useQuery({
    queryKey: ['procurement', 'po', detailId],
    queryFn: () => api.get<PurchaseOrder>(`/procurement/purchase-orders/${detailId}`),
    enabled: !!detailId,
  })

  const actionMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/procurement/purchase-orders/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement', 'pos'] })
      void qc.invalidateQueries({ queryKey: ['procurement', 'po', detailId] })
      void qc.invalidateQueries({ queryKey: ['procurement', 'approvals'] })
    },
  })

  const statuses = ['', 'draft', 'pending_approval', 'approved', 'sent', 'partial', 'received', 'cancelled']

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 flex-wrap">
          {statuses.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                ${statusFilter === s ? 'bg-kds-green text-black' : 'bg-kds-card border border-kds-border text-kds-subtext hover:text-kds-text'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <button onClick={() => setShowCreate(true)}
          className="ml-auto rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + New PO
        </button>
      </div>

      {showCreate && <CreatePoForm qc={qc} onClose={() => setShowCreate(false)} />}

      {isLoading ? (
        <p className="text-kds-subtext text-sm py-8 text-center">Loading…</p>
      ) : orders.length === 0 ? (
        <EmptyState icon="📋" title="No purchase orders" sub="Create your first PO to get started" />
      ) : (
        <div className="rounded-xl border border-kds-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border bg-kds-card/40">
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Reference</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Created</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Expected</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Total</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <tr key={po.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => setDetailId(po.id === detailId ? null : po.id)}
                      className="font-mono text-xs text-kds-green hover:underline">
                      {po.reference ?? po.id.slice(-8)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-kds-text font-medium">{po.supplier?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">{fmt(po.createdAt)}</td>
                  <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">{po.expectedDate ? fmt(po.expectedDate) : '—'}</td>
                  <td className="px-4 py-3 text-kds-text font-semibold text-right">{pkr(po.totalCents)}</td>
                  <td className="px-4 py-3"><Badge status={po.status} /></td>
                  <td className="px-4 py-3">
                    <PoActions po={po} onAction={(action, body) => {
                      if (action === 'reject') { setRejectId(po.id); return }
                      if (action === 'cancel') { setCancelId(po.id); return }
                      if (action === 'receive') { router.push(`/procurement/receiving?poId=${po.id}`); return }
                      actionMut.mutate({ id: po.id, action, body })
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {detail && (
        <div className="rounded-xl border border-kds-border bg-kds-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold text-kds-text">PO Detail — {detail.reference ?? detail.id.slice(-8)}</p>
            <button onClick={() => setDetailId(null)} className="text-kds-subtext hover:text-kds-text text-xs">✕ Close</button>
          </div>
          {detail.lines && detail.lines.length > 0 && (
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-kds-border/50">
                  <th className="text-left py-1.5 text-kds-subtext">Item</th>
                  <th className="text-right py-1.5 text-kds-subtext">Ordered</th>
                  <th className="text-right py-1.5 text-kds-subtext">Received</th>
                  <th className="text-right py-1.5 text-kds-subtext">Unit Cost</th>
                  <th className="text-right py-1.5 text-kds-subtext">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id} className="border-b border-kds-border/30 last:border-0">
                    <td className="py-1.5 text-kds-text">{l.inventoryItem?.name ?? l.inventoryItemId}</td>
                    <td className="py-1.5 text-right text-kds-text">{l.quantityOrdered} {l.inventoryItem?.unit}</td>
                    <td className="py-1.5 text-right text-kds-subtext">{l.quantityReceived}</td>
                    <td className="py-1.5 text-right text-kds-subtext">{pkr(l.unitCostCents)}</td>
                    <td className="py-1.5 text-right text-kds-text font-semibold">{pkr(l.quantityOrdered * l.unitCostCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {detail.notes && <p className="text-xs text-kds-subtext">Notes: {detail.notes}</p>}
          {detail.rejectedReason && <p className="text-xs text-kds-red">Rejected: {detail.rejectedReason}</p>}
          {detail.cancelReason && <p className="text-xs text-kds-subtext">Cancelled: {detail.cancelReason}</p>}
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-kds-text">Reject PO</p>
            <Field label="Reason (required)">
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!rejectReason || actionMut.isPending}
                onClick={() => { actionMut.mutate({ id: rejectId, action: 'reject', body: { reason: rejectReason } }); setRejectId(null); setRejectReason('') }}
                className="rounded-xl bg-kds-red text-white font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Reject
              </button>
              <button onClick={() => { setRejectId(null); setRejectReason('') }}
                className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel modal */}
      {cancelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-kds-text">Cancel PO</p>
            <Field label="Reason (required)">
              <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!cancelReason || actionMut.isPending}
                onClick={() => { actionMut.mutate({ id: cancelId, action: 'cancel', body: { reason: cancelReason } }); setCancelId(null); setCancelReason('') }}
                className="rounded-xl bg-kds-red text-white font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Cancel PO
              </button>
              <button onClick={() => { setCancelId(null); setCancelReason('') }}
                className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PoActions({ po, onAction }: { po: PurchaseOrder; onAction: (action: string, body?: unknown) => void }) {
  const actions: { label: string; action: string; cls: string }[] = []
  if (po.status === 'draft') {
    actions.push({ label: 'Submit', action: 'submit', cls: 'text-amber-400 hover:text-amber-300' })
  }
  if (po.status === 'pending_approval') {
    actions.push({ label: 'Approve', action: 'approve', cls: 'text-kds-green hover:opacity-80' })
    actions.push({ label: 'Reject', action: 'reject', cls: 'text-kds-red hover:opacity-80' })
  }
  if (po.status === 'approved') {
    actions.push({ label: 'Send', action: 'send', cls: 'text-sky-400 hover:opacity-80' })
  }
  if (po.status === 'sent' || po.status === 'partial') {
    actions.push({ label: 'Receive', action: 'receive', cls: 'text-kds-green hover:opacity-80' })
  }
  if (['draft', 'pending_approval', 'approved'].includes(po.status)) {
    actions.push({ label: 'Cancel', action: 'cancel', cls: 'text-zinc-500 hover:text-kds-red' })
  }
  if (actions.length === 0) return null
  return (
    <div className="flex gap-2">
      {actions.map((a) => (
        <button key={a.action} onClick={() => onAction(a.action)}
          className={`text-xs font-semibold transition-colors ${a.cls}`}>
          {a.label}
        </button>
      ))}
    </div>
  )
}

// ─── Create PO form ───────────────────────────────────────────────────────────

function CreatePoForm({ qc, onClose }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: suppliers = [] } = useQuery({
    queryKey: ['procurement', 'suppliers'],
    queryFn: () => api.get<Supplier[]>('/procurement/suppliers'),
  })
  const { data: invItems = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
  })

  const [supplierId, setSupplierId] = useState('')
  const [reference, setReference] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState([{ inventoryItemId: '', quantityOrdered: '', unitCostCents: '', notes: '' }])

  const mut = useMutation({
    mutationFn: () => api.post('/procurement/purchase-orders', {
      supplierId, reference: reference || null, expectedDate: expectedDate || null,
      notes: notes || null,
      lines: lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        quantityOrdered: Number(l.quantityOrdered),
        unitCostCents: Math.round(Number(l.unitCostCents) * 100),
        notes: l.notes || null,
      })),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement', 'pos'] })
      onClose()
    },
  })

  function addLine() { setLines([...lines, { inventoryItemId: '', quantityOrdered: '', unitCostCents: '', notes: '' }]) }
  function removeLine(i: number) { setLines(lines.filter((_, idx) => idx !== i)) }
  function updateLine(i: number, field: string, val: string) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }

  const totalCents = lines.reduce((s, l) => s + (Number(l.quantityOrdered) || 0) * Math.round((Number(l.unitCostCents) || 0) * 100), 0)
  const valid = supplierId && lines.every((l) => l.inventoryItemId && l.quantityOrdered && l.unitCostCents)

  return (
    <div className="rounded-xl border border-kds-green bg-kds-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-kds-text">New Purchase Order</p>
        <button onClick={onClose} className="text-kds-subtext hover:text-kds-text text-xs">✕</button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Supplier *">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fi}>
            <option value="">Select supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO-2024-001" className={fi} />
        </Field>
        <Field label="Expected delivery">
          <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className={fi} />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional…" className={fi} />
        </Field>
      </div>

      {/* Lines */}
      <div className="space-y-2">
        <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest">Line items</p>
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-5">
              <select value={line.inventoryItemId} onChange={(e) => updateLine(i, 'inventoryItemId', e.target.value)} className={fi}>
                <option value="">Select item</option>
                {invItems.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.unit})</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <input type="number" placeholder="Qty" value={line.quantityOrdered}
                onChange={(e) => updateLine(i, 'quantityOrdered', e.target.value)} className={fi} />
            </div>
            <div className="col-span-2">
              <input type="number" placeholder="Unit cost (PKR)" value={line.unitCostCents}
                onChange={(e) => updateLine(i, 'unitCostCents', e.target.value)} className={fi} />
            </div>
            <div className="col-span-2">
              <input placeholder="Notes" value={line.notes}
                onChange={(e) => updateLine(i, 'notes', e.target.value)} className={fi} />
            </div>
            <div className="col-span-1">
              <button onClick={() => removeLine(i)} className="w-full rounded-lg border border-kds-border text-kds-red py-2 text-sm hover:bg-red-950/20">✕</button>
            </div>
          </div>
        ))}
        <button onClick={addLine} className="text-xs text-kds-green hover:underline">+ Add line</button>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-kds-border">
        <p className="text-sm font-bold text-kds-text">Total: {pkr(totalCents)}</p>
        <div className="flex gap-2">
          <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
            className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Creating…' : 'Create PO'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
      {mut.isError && <p className="text-xs text-kds-red">{(mut.error as Error).message}</p>}
    </div>
  )
}

// Receiving happens on ONE screen, /procurement/receiving (the dock page):
// the "Receive" action opens it with the PO preselected. The old modal here
// posted the full ordered quantity again on a part-received PO and couldn't
// skip a line that hadn't arrived.

// ══════════════════════════════════════════════════════════════════════════════
// BILLS TAB
// ══════════════════════════════════════════════════════════════════════════════

function BillsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [statusFilter, setStatusFilter] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [matchId, setMatchId] = useState<string | null>(null)

  const qs = new URLSearchParams()
  if (statusFilter) qs.set('status', statusFilter)
  if (overdue) qs.set('overdue', 'true')

  const { data: bills = [], isLoading } = useQuery({
    queryKey: ['procurement', 'bills', statusFilter, overdue],
    queryFn: () => api.get<Bill[]>(`/procurement/bills?${qs}`),
  })

  const { data: matchResult } = useQuery({
    queryKey: ['procurement', 'bill-match', matchId],
    queryFn: () => api.get<Record<string, unknown>>(`/procurement/bills/${matchId}/match`),
    enabled: !!matchId,
  })

  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/procurement/bills/${id}/void`, { reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['procurement', 'bills'] }); setVoidId(null); setVoidReason('') },
  })

  const statuses = ['', 'open', 'partially_paid', 'paid', 'void']

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 flex-wrap">
          {statuses.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                ${statusFilter === s && !overdue ? 'bg-kds-green text-black' : 'bg-kds-card border border-kds-border text-kds-subtext hover:text-kds-text'}`}>
              {s || 'All'}
            </button>
          ))}
          <button onClick={() => { setOverdue(!overdue); setStatusFilter('') }}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
              ${overdue ? 'bg-kds-red text-white' : 'bg-kds-card border border-kds-border text-kds-subtext hover:text-kds-text'}`}>
            Overdue
          </button>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="ml-auto rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + New Bill
        </button>
      </div>

      {showCreate && <CreateBillForm qc={qc} onClose={() => setShowCreate(false)} />}

      {isLoading ? (
        <p className="text-kds-subtext text-sm py-8 text-center">Loading…</p>
      ) : bills.length === 0 ? (
        <EmptyState icon="🧾" title="No bills" sub="Record supplier invoices here" />
      ) : (
        <div className="rounded-xl border border-kds-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border bg-kds-card/40">
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Bill #</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Date</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Due</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Total</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Outstanding</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const isOverdue = b.status !== 'paid' && b.status !== 'void' && new Date(b.dueDate) < new Date()
                return (
                  <tr key={b.id} className={`border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30 transition-colors ${isOverdue ? 'bg-red-950/5' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs text-kds-green">{b.billNumber}</td>
                    <td className="px-4 py-3 text-kds-text font-medium">{b.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">{fmt(b.billDate)}</td>
                    <td className={`px-4 py-3 hidden md:table-cell ${isOverdue ? 'text-kds-red font-semibold' : 'text-kds-subtext'}`}>{fmt(b.dueDate)}</td>
                    <td className="px-4 py-3 text-kds-text font-semibold text-right">{pkr(b.totalCents)}</td>
                    <td className={`px-4 py-3 font-semibold text-right ${billDue(b) > 0 ? 'text-kds-red' : 'text-kds-green'}`}>
                      {pkr(billDue(b))}
                    </td>
                    <td className="px-4 py-3"><Badge status={isOverdue ? 'overdue' : b.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => setMatchId(matchId === b.id ? null : b.id)}
                          className="text-xs text-sky-400 hover:opacity-80 font-semibold">Match</button>
                        {b.status !== 'void' && (
                          <button onClick={() => { setVoidId(b.id); setVoidReason('') }}
                            className="text-xs text-kds-red hover:opacity-80 font-semibold">Void</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* 3-way match result */}
      {matchId && matchResult && (
        <div className="rounded-xl border border-kds-border bg-kds-card p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-kds-text text-sm">3-Way Match Result</p>
            <button onClick={() => setMatchId(null)} className="text-kds-subtext text-xs">✕</button>
          </div>
          <pre className="text-xs text-kds-subtext overflow-auto max-h-48">{JSON.stringify(matchResult, null, 2)}</pre>
        </div>
      )}

      {/* Void modal */}
      {voidId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-kds-text">Void Bill</p>
            <Field label="Reason (required)">
              <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!voidReason || voidMut.isPending}
                onClick={() => voidMut.mutate({ id: voidId, reason: voidReason })}
                className="rounded-xl bg-kds-red text-white font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Void
              </button>
              <button onClick={() => { setVoidId(null); setVoidReason('') }}
                className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateBillForm({ qc, onClose }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: suppliers = [] } = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api.get<Supplier[]>('/procurement/suppliers') })
  const { data: pos = [] } = useQuery({ queryKey: ['procurement', 'pos', ''], queryFn: () => api.get<PurchaseOrder[]>('/procurement/purchase-orders') })

  const [form, setForm] = useState({
    supplierId: '', poId: '', billNumber: '', billDate: '', dueDate: '', taxCents: '', notes: '', attachmentUrl: '',
  })
  const [lines, setLines] = useState([{ description: '', quantity: '', unitCostCents: '' }])

  const mut = useMutation({
    mutationFn: () => api.post('/procurement/bills', {
      supplierId: form.supplierId, poId: form.poId || null, billNumber: form.billNumber,
      billDate: form.billDate, dueDate: form.dueDate || null,
      taxCents: form.taxCents ? Math.round(Number(form.taxCents) * 100) : 0,
      notes: form.notes || null, attachmentUrl: form.attachmentUrl || null,
      lines: lines.map((l) => ({
        description: l.description, quantity: Number(l.quantity),
        unitCostCents: Math.round(Number(l.unitCostCents) * 100),
      })),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['procurement', 'bills'] }); onClose() },
  })

  const valid = form.supplierId && form.billNumber && form.billDate && lines.every((l) => l.description && l.quantity && l.unitCostCents)

  return (
    <div className="rounded-xl border border-kds-green bg-kds-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-kds-text">New Supplier Bill</p>
        <button onClick={onClose} className="text-kds-subtext text-xs">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Supplier *">
          <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} className={fi}>
            <option value="">Select</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Link to PO">
          <select value={form.poId} onChange={(e) => setForm({ ...form, poId: e.target.value })} className={fi}>
            <option value="">None</option>
            {pos.filter((p) => !form.supplierId || p.supplierId === form.supplierId).map((p) => (
              <option key={p.id} value={p.id}>{p.reference ?? p.id.slice(-8)}</option>
            ))}
          </select>
        </Field>
        <Field label="Bill number *">
          <input value={form.billNumber} onChange={(e) => setForm({ ...form, billNumber: e.target.value })} className={fi} />
        </Field>
        <Field label="Bill date *">
          <input type="date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.target.value })} className={fi} />
        </Field>
        <Field label="Due date">
          <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className={fi} />
        </Field>
        <Field label="Tax (PKR)">
          <input type="number" value={form.taxCents} onChange={(e) => setForm({ ...form, taxCents: e.target.value })} placeholder="0" className={fi} />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={fi} />
        </Field>
        <Field label="Attachment URL">
          <input value={form.attachmentUrl} onChange={(e) => setForm({ ...form, attachmentUrl: e.target.value })} placeholder="https://…" className={fi} />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest">Lines</p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-6">
              <input placeholder="Description *" value={l.description}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} className={fi} />
            </div>
            <div className="col-span-2">
              <input type="number" placeholder="Qty *" value={l.quantity}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} className={fi} />
            </div>
            <div className="col-span-3">
              <input type="number" placeholder="Unit cost (PKR) *" value={l.unitCostCents}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitCostCents: e.target.value } : x))} className={fi} />
            </div>
            <div className="col-span-1">
              <button onClick={() => setLines(lines.filter((_, j) => j !== i))}
                className="w-full rounded-lg border border-kds-border text-kds-red py-2 text-sm">✕</button>
            </div>
          </div>
        ))}
        <button onClick={() => setLines([...lines, { description: '', quantity: '', unitCostCents: '' }])}
          className="text-xs text-kds-green hover:underline">+ Add line</button>
      </div>

      <div className="flex gap-2 pt-2 border-t border-kds-border">
        <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {mut.isPending ? 'Saving…' : 'Save Bill'}
        </button>
        <button onClick={onClose} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
      </div>
      {mut.isError && <p className="text-xs text-kds-red">{(mut.error as Error).message}</p>}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PAYMENTS TAB
// ══════════════════════════════════════════════════════════════════════════════

function PaymentsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [showCreate, setShowCreate] = useState(false)
  const [allocateId, setAllocateId] = useState<string | null>(null)

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ['procurement', 'payments'],
    queryFn: () => api.get<SupplierPayment[]>('/procurement/payments'),
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowCreate(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Record Payment
        </button>
      </div>

      {showCreate && <CreatePaymentForm qc={qc} onClose={() => setShowCreate(false)} />}

      {isLoading ? (
        <p className="text-kds-subtext text-sm py-8 text-center">Loading…</p>
      ) : payments.length === 0 ? (
        <EmptyState icon="💳" title="No payments" sub="Record supplier payments here" />
      ) : (
        <div className="rounded-xl border border-kds-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border bg-kds-card/40">
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Date</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Method</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Ref</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Amount</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Unallocated</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30">
                  <td className="px-4 py-3 text-kds-subtext">{fmt(p.paymentDate)}</td>
                  <td className="px-4 py-3 text-kds-text font-medium">{p.supplier?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-kds-subtext hidden md:table-cell capitalize">{p.method.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-kds-subtext font-mono text-xs hidden md:table-cell">{p.reference ?? '—'}</td>
                  <td className="px-4 py-3 text-kds-text font-semibold text-right">{pkr(p.amountCents)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${p.amountCents - p.appliedCents > 0 ? 'text-amber-400' : 'text-kds-subtext'}`}>
                    {pkr(p.amountCents - p.appliedCents)}
                  </td>
                  <td className="px-4 py-3">
                    {p.amountCents - p.appliedCents > 0 && (
                      <button onClick={() => setAllocateId(p.id)}
                        className="text-xs text-kds-green hover:underline font-semibold">Allocate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {allocateId && <AllocateModal paymentId={allocateId} qc={qc} onClose={() => setAllocateId(null)} />}
    </div>
  )
}

function CreatePaymentForm({ qc, onClose }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: suppliers = [] } = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api.get<Supplier[]>('/procurement/suppliers') })

  const [form, setForm] = useState({ supplierId: '', paymentDate: '', method: 'bank_transfer', reference: '', amountCents: '', notes: '' })

  const mut = useMutation({
    mutationFn: () => api.post('/procurement/payments', {
      supplierId: form.supplierId, paymentDate: form.paymentDate,
      method: form.method, reference: form.reference || null,
      amountCents: Math.round(Number(form.amountCents) * 100),
      notes: form.notes || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['procurement', 'payments'] }); onClose() },
  })

  const valid = form.supplierId && form.paymentDate && form.amountCents

  return (
    <div className="rounded-xl border border-kds-green bg-kds-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-kds-text">Record Payment</p>
        <button onClick={onClose} className="text-kds-subtext text-xs">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Supplier *">
          <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} className={fi}>
            <option value="">Select</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Date *">
          <input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} className={fi} />
        </Field>
        <Field label="Method *">
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={fi}>
            {['cash', 'bank_transfer', 'cheque', 'wallet'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Reference">
          <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="CHQ-001" className={fi} />
        </Field>
        <Field label="Amount (PKR) *">
          <input type="number" value={form.amountCents} onChange={(e) => setForm({ ...form, amountCents: e.target.value })} placeholder="50000" className={fi} />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={fi} />
        </Field>
      </div>
      <div className="flex gap-2 pt-2 border-t border-kds-border">
        <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {mut.isPending ? 'Saving…' : 'Record Payment'}
        </button>
        <button onClick={onClose} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
      </div>
    </div>
  )
}

function AllocateModal({ paymentId, qc, onClose }: { paymentId: string; qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: bills = [] } = useQuery({
    queryKey: ['procurement', 'bills', '', false],
    queryFn: () => api.get<Bill[]>('/procurement/bills?status=open'),
  })

  const [allocations, setAllocations] = useState<Record<string, string>>({})

  const mut = useMutation({
    mutationFn: () => {
      const applications = Object.entries(allocations)
        .filter(([, v]) => v && Number(v) > 0)
        .map(([billId, v]) => ({ billId, amountAppliedCents: Math.round(Number(v) * 100) }))
      return api.post(`/procurement/payments/${paymentId}/allocate`, { applications })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement', 'payments'] })
      void qc.invalidateQueries({ queryKey: ['procurement', 'bills'] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-kds-card border border-kds-border rounded-2xl p-6 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-bold text-kds-text">Allocate to Bills</p>
          <button onClick={onClose} className="text-kds-subtext text-xs">✕</button>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {bills.filter((b) => billDue(b) > 0).map((b) => (
            <div key={b.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-kds-text font-medium">{b.billNumber}</p>
                <p className="text-xs text-kds-subtext">Outstanding: {pkr(billDue(b))}</p>
              </div>
              <input type="number" placeholder="Amount (PKR)" className="w-32 rounded-lg bg-kds-bg border border-kds-border px-2 py-1.5 text-sm text-kds-text focus:border-kds-green focus:outline-none"
                value={allocations[b.id] ?? ''}
                onChange={(e) => setAllocations({ ...allocations, [b.id]: e.target.value })} />
            </div>
          ))}
          {bills.filter((b) => billDue(b) > 0).length === 0 && (
            <p className="text-kds-subtext text-sm">No open bills to allocate to.</p>
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={() => mut.mutate()} disabled={mut.isPending || Object.values(allocations).every((v) => !v || Number(v) <= 0)}
            className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Applying…' : 'Apply allocations'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLIERS TAB
// ══════════════════════════════════════════════════════════════════════════════

function SuppliersTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [showCreate, setShowCreate] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [statementId, setStatementId] = useState<string | null>(null)

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ['procurement', 'suppliers'],
    queryFn: () => api.get<Supplier[]>('/procurement/suppliers'),
  })

  const { data: statement } = useQuery({
    queryKey: ['procurement', 'statement', statementId],
    queryFn: () => api.get<{ supplier: Supplier; outstanding: number; openingUnpostedCents?: number; bills: Bill[]; payments: SupplierPayment[] }>(`/procurement/suppliers/${statementId}/statement`),
    enabled: !!statementId,
  })

  const editing = editId ? suppliers.find((s) => s.id === editId) : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowCreate(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add Supplier
        </button>
      </div>

      {(showCreate || editing) && (
        <SupplierForm
          qc={qc} supplier={editing ?? null}
          onClose={() => { setShowCreate(false); setEditId(null) }}
        />
      )}

      {isLoading ? (
        <p className="text-kds-subtext text-sm py-8 text-center">Loading…</p>
      ) : suppliers.length === 0 ? (
        <EmptyState icon="🏭" title="No suppliers" sub="Add your first supplier to start ordering" />
      ) : (
        <div className="rounded-xl border border-kds-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border bg-kds-card/40">
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Name</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Contact</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">POs</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Bills</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Terms</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30">
                  <td className="px-4 py-3">
                    <p className="text-kds-text font-semibold">{s.name}</p>
                    {s.taxId && <p className="text-xs text-kds-subtext">TIN: {s.taxId}</p>}
                  </td>
                  <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">
                    {s.phone && <p className="text-xs">{s.phone}</p>}
                    {s.email && <p className="text-xs">{s.email}</p>}
                  </td>
                  <td className="px-4 py-3 text-kds-subtext text-right hidden md:table-cell">{s._count?.purchaseOrders ?? 0}</td>
                  <td className="px-4 py-3 text-kds-subtext text-right hidden md:table-cell">{s._count?.bills ?? 0}</td>
                  <td className="px-4 py-3 text-kds-subtext text-right">{s.paymentTermsDays}d</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => setEditId(s.id)} className="text-xs text-kds-green hover:underline font-semibold">Edit</button>
                      <button onClick={() => setStatementId(statementId === s.id ? null : s.id)} className="text-xs text-sky-400 hover:underline font-semibold">Statement</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Statement panel */}
      {statement && statementId && (
        <div className="rounded-xl border border-kds-border bg-kds-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold text-kds-text">{statement.supplier.name} — Statement</p>
            <button onClick={() => setStatementId(null)} className="text-kds-subtext text-xs">✕</button>
          </div>
          <div className="flex gap-6">
            <div>
              <p className="text-xs text-kds-subtext">Outstanding balance</p>
              <p className={`text-xl font-black ${statement.outstanding > 0 ? 'text-kds-red' : 'text-kds-green'}`}>{pkr(statement.outstanding)}</p>
            </div>
            <div>
              <p className="text-xs text-kds-subtext">Opening balance (included above)</p>
              <p className="text-sm font-semibold text-kds-text">{pkr(statement.supplier.openingBalanceCents)}</p>
              {(statement.openingUnpostedCents ?? 0) !== 0 && (
                <p className="text-[11px] text-amber-400">{pkr(statement.openingUnpostedCents ?? 0)} not yet posted to the ledger, so not in the balance</p>
              )}
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Bills</p>
              <div className="space-y-1">
                {statement.bills.slice(0, 5).map((b) => (
                  <div key={b.id} className="flex items-center justify-between text-xs">
                    <span className="text-kds-subtext font-mono">{b.billNumber}</span>
                    <span className="text-kds-text">{pkr(b.totalCents)}</span>
                    <Badge status={b.status} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Payments</p>
              <div className="space-y-1">
                {statement.payments.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-kds-subtext">{fmt(p.paymentDate)}</span>
                    <span className="text-kds-text capitalize">{p.method.replace(/_/g, ' ')}</span>
                    <span className="text-kds-green font-semibold">{pkr(p.amountCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SupplierForm({ qc, supplier, onClose }: { qc: ReturnType<typeof useQueryClient>; supplier: Supplier | null; onClose: () => void }) {
  // Tenant scoping for the create path. In portfolio view we force the
  // operator to pick a company before the supplier is saved; single-tenant
  // view defaults to the only / current tenant. Same coherent pattern as
  // /workforce Add Staff. `useViewAllTenants` is the global hook that tells
  // us whether portfolio mode is on.
  const viewAll = useViewAllTenants()
  const { data: tenants = [] } = useQuery<Array<{ id: string; name: string; slug: string }>>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get('/tenants/mine'),
    staleTime: 5 * 60_000,
  })

  const [form, setForm] = useState({
    name: supplier?.name ?? '', phone: supplier?.phone ?? '', email: supplier?.email ?? '',
    address: supplier?.address ?? '', taxId: supplier?.taxId ?? '', notes: supplier?.notes ?? '',
    paymentTermsDays: String(supplier?.paymentTermsDays ?? 30), leadTimeDays: String(supplier?.leadTimeDays ?? ''),
    openingBalanceCents: String(supplier?.openingBalanceCents ? supplier.openingBalanceCents / 100 : ''),
    // Tenant chosen by the operator. Edit path locks to the existing tenantId
    // (transfer happens via the Monitor edit drawer's Company dropdown).
    tenantId: supplier?.tenantId ?? (viewAll ? '' : (tenants[0]?.id ?? '')),
  })

  // Once tenants resolve, default-pick the first one in single-tenant mode so
  // the user doesn't see an empty dropdown on a fresh form.
  useEffect(() => {
    if (!viewAll && !form.tenantId && tenants[0]) {
      setForm((f) => ({ ...f, tenantId: tenants[0]!.id }))
    }
  }, [tenants, viewAll, form.tenantId])

  const [err, setErr] = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: () => {
      const data = {
        name: form.name, phone: form.phone || undefined, email: form.email || undefined,
        address: form.address || undefined, taxId: form.taxId || undefined, notes: form.notes || undefined,
        paymentTermsDays: form.paymentTermsDays ? Number(form.paymentTermsDays) : undefined,
        leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
        openingBalanceCents: form.openingBalanceCents ? Math.round(Number(form.openingBalanceCents) * 100) : 0,
        ...(form.tenantId ? { tenantId: form.tenantId } : {}),
      }
      return supplier
        ? api.patch(`/procurement/suppliers/${supplier.id}`, data)
        : api.post('/procurement/suppliers', data)
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['procurement', 'suppliers'] }); onClose() },
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to save supplier'),
  })

  function submit() {
    setErr(null)
    if (!form.name.trim()) return setErr('Supplier name is required.')
    if (!supplier && tenants.length > 0 && !form.tenantId) {
      return setErr('Pick which company this supplier is for.')
    }
    mut.mutate()
  }

  return (
    <div className="rounded-xl border border-kds-green bg-kds-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-kds-text">{supplier ? 'Edit Supplier' : 'New Supplier'}</p>
        <button onClick={onClose} className="text-kds-subtext text-xs">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Name *">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fi} autoFocus />
        </Field>
        {/* Company picker — required in portfolio mode for new suppliers,
            hidden for edits (transfer happens via the Monitor edit drawer to
            keep audit logging on the dedicated transfer surface). */}
        {!supplier && tenants.length > 1 && (
          <Field label="Company *">
            <select value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} className={fi}>
              {viewAll && <option value="">— pick a company —</option>}
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={fi} />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={fi} />
        </Field>
        <Field label="Address">
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={fi} />
        </Field>
        <Field label="Tax ID / NTN">
          <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} className={fi} />
        </Field>
        <Field label="Payment terms (days)">
          <input type="number" value={form.paymentTermsDays} onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })} className={fi} />
        </Field>
        <Field label="Lead time (days)">
          <input type="number" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} className={fi} />
        </Field>
        <Field label="Opening balance (PKR)">
          <input type="number" value={form.openingBalanceCents} onChange={(e) => setForm({ ...form, openingBalanceCents: e.target.value })} placeholder="0" className={fi} />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={fi} />
        </Field>
      </div>
      {err && <p className="text-xs font-bold text-red-400 pt-1">{err}</p>}
      <div className="flex gap-2 pt-2 border-t border-kds-border">
        <button onClick={submit} disabled={!form.name || mut.isPending}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {mut.isPending ? 'Saving…' : supplier ? 'Update' : 'Add Supplier'}
        </button>
        <button onClick={onClose} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// AGING TAB
// ══════════════════════════════════════════════════════════════════════════════

// The one AP aging (GET /procurement/ap-aging) — the same view as the
// Accounting AP aging page. This tab used to read GET /procurement/aging, an
// object it treated as an array, so it crashed.
function AgingTab() {
  return (
    <div className="p-6">
      <ApAging />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// REORDER TAB
// ══════════════════════════════════════════════════════════════════════════════

function ReorderTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['procurement', 'reorder'],
    queryFn: () => api.get<ReorderItem[]>('/procurement/reorder'),
  })

  if (isLoading) return <div className="p-6"><p className="text-kds-subtext text-sm">Loading…</p></div>
  if (!data || data.length === 0) return <div className="p-6"><EmptyState icon="🔄" title="All stocked up" sub="No items below reorder threshold" /></div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold text-kds-text text-lg">Reorder Suggestions</p>
          <p className="text-sm text-kds-subtext">{data.length} item{data.length !== 1 ? 's' : ''} below par level</p>
        </div>
      </div>

      <div className="rounded-xl border border-kds-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-kds-border bg-kds-card/40">
              <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Item</th>
              <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">In stock</th>
              <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Par level</th>
              <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Reorder qty</th>
              <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Est. cost</th>
              <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Suppliers</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item) => {
              const estCost = item.costPerUnit != null ? item.reorderQty * item.costPerUnit : null
              const pctBelow = ((item.parLevel - item.currentStock) / item.parLevel * 100).toFixed(0)
              return (
                <tr key={item.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30">
                  <td className="px-4 py-3">
                    <p className="text-kds-text font-medium">{item.name}</p>
                    <p className="text-xs text-kds-red">{pctBelow}% below par</p>
                  </td>
                  <td className="px-4 py-3 text-right text-kds-red font-bold">{item.currentStock} {item.unit}</td>
                  <td className="px-4 py-3 text-right text-kds-subtext">{item.parLevel} {item.unit}</td>
                  <td className="px-4 py-3 text-right text-amber-400 font-semibold">{item.reorderQty} {item.unit}</td>
                  <td className="px-4 py-3 text-right text-kds-subtext hidden md:table-cell">{estCost != null ? pkr(estCost * 100) : '—'}</td>
                  <td className="px-4 py-3 text-kds-subtext text-xs hidden md:table-cell">
                    {item.suppliers?.map((s) => s.name).join(', ') ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// APPROVALS TAB
// ══════════════════════════════════════════════════════════════════════════════

function ApprovalsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['procurement', 'approvals'],
    queryFn: () => api.get<PurchaseOrder[]>('/procurement/approvals'),
  })

  const [threshold, setThreshold] = useState<number | null>(null)
  const [newThreshold, setNewThreshold] = useState('')

  const { data: thresholdData, refetch: refetchThreshold } = useQuery({
    queryKey: ['procurement', 'threshold'],
    queryFn: () => api.get<{ thresholdCents: number }>('/procurement/settings/approval-threshold'),
  })

  const approveRejectMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'approve' | 'reject'; body?: { reason: string } }) =>
      api.post(`/procurement/purchase-orders/${id}/${action}`, body ?? {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['procurement', 'approvals'] }),
  })

  const thresholdMut = useMutation({
    mutationFn: (thresholdCents: number) => api.put('/procurement/settings/approval-threshold', { thresholdCents }),
    onSuccess: () => { void refetchThreshold(); setNewThreshold('') },
  })

  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  if (isLoading) return <div className="p-6"><p className="text-kds-subtext text-sm">Loading…</p></div>

  return (
    <div className="p-6 space-y-4">
      {/* Threshold setting */}
      <div className="rounded-xl border border-kds-border bg-kds-card p-4 flex flex-wrap items-center gap-4">
        <div>
          <p className="text-xs text-kds-subtext font-medium">Auto-approval threshold</p>
          <p className="text-sm font-bold text-kds-text">
            {thresholdData ? pkr(thresholdData.thresholdCents) : '…'}
          </p>
          <p className="text-xs text-kds-subtext">POs above this value require manual approval</p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <input type="number" placeholder="New threshold (PKR)" value={newThreshold}
            onChange={(e) => setNewThreshold(e.target.value)}
            className="w-44 rounded-lg bg-kds-bg border border-kds-border px-3 py-1.5 text-sm text-kds-text focus:border-kds-green focus:outline-none" />
          <button disabled={!newThreshold || thresholdMut.isPending}
            onClick={() => thresholdMut.mutate(Math.round(Number(newThreshold) * 100))}
            className="rounded-xl bg-kds-green text-black font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50">
            Update
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon="✅" title="No pending approvals" sub="All purchase orders have been reviewed" />
      ) : (
        <>
          <p className="text-sm font-bold text-amber-400">{orders.length} PO{orders.length !== 1 ? 's' : ''} awaiting approval</p>
          <div className="rounded-xl border border-amber-900/40 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-900/30 bg-amber-950/10">
                  <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Reference</th>
                  <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Supplier</th>
                  <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Created</th>
                  <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">Total</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {orders.map((po) => (
                  <tr key={po.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30">
                    <td className="px-4 py-3 font-mono text-xs text-kds-green">{po.reference ?? po.id.slice(-8)}</td>
                    <td className="px-4 py-3 text-kds-text font-medium">{po.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">{fmt(po.createdAt)}</td>
                    <td className="px-4 py-3 text-kds-text font-bold text-right">{pkr(po.totalCents)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => approveRejectMut.mutate({ id: po.id, action: 'approve' })}
                          disabled={approveRejectMut.isPending}
                          className="text-xs text-kds-green hover:opacity-80 font-semibold">Approve</button>
                        <button onClick={() => { setRejectId(po.id); setRejectReason('') }}
                          className="text-xs text-kds-red hover:opacity-80 font-semibold">Reject</button>
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

      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-kds-card border border-kds-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-kds-text">Reject PO</p>
            <Field label="Reason (required)">
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!rejectReason || approveRejectMut.isPending}
                onClick={() => { approveRejectMut.mutate({ id: rejectId, action: 'reject', body: { reason: rejectReason } }); setRejectId(null) }}
                className="rounded-xl bg-kds-red text-white font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Reject
              </button>
              <button onClick={() => setRejectId(null)} className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PRICE HISTORY TAB
// ══════════════════════════════════════════════════════════════════════════════

function PriceHistoryTab() {
  const [itemFilter, setItemFilter] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')

  const { data: suppliers = [] } = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api.get<Supplier[]>('/procurement/suppliers') })
  const { data: invItems = [] } = useQuery({ queryKey: ['inventory'], queryFn: () => api.get<InventoryItem[]>('/inventory') })

  const qs = new URLSearchParams()
  if (itemFilter) qs.set('itemId', itemFilter)
  if (supplierFilter) qs.set('supplierId', supplierFilter)

  const { data = [], isLoading } = useQuery({
    queryKey: ['procurement', 'price-history', itemFilter, supplierFilter],
    queryFn: () => api.get<PriceHistoryRow[]>(`/procurement/price-history?${qs}`),
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-kds-subtext">Item:</label>
          <select value={itemFilter} onChange={(e) => setItemFilter(e.target.value)}
            className="rounded-lg bg-kds-card border border-kds-border px-3 py-1.5 text-xs text-kds-text focus:border-kds-green focus:outline-none">
            <option value="">All items</option>
            {invItems.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-kds-subtext">Supplier:</label>
          <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
            className="rounded-lg bg-kds-card border border-kds-border px-3 py-1.5 text-xs text-kds-text focus:border-kds-green focus:outline-none">
            <option value="">All suppliers</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-kds-subtext text-sm py-8 text-center">Loading…</p>
      ) : data.length === 0 ? (
        <EmptyState icon="📈" title="No price history" sub="Receive purchase orders to build price history" />
      ) : (
        <div className="rounded-xl border border-kds-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kds-border bg-kds-card/40">
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Item</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Supplier</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Old cost</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold">New cost</th>
                <th className="text-right px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Change</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold hidden md:table-cell">Source</th>
                <th className="text-left px-4 py-2.5 text-xs text-kds-subtext font-semibold">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const pct = row.oldCostCents && row.oldCostCents > 0
                  ? ((row.newCostCents - row.oldCostCents) / row.oldCostCents * 100).toFixed(1)
                  : null
                const up = pct && Number(pct) > 0
                return (
                  <tr key={row.id} className="border-b border-kds-border/50 last:border-0 hover:bg-kds-card/30">
                    <td className="px-4 py-3 text-kds-text font-medium">{row.inventoryItem?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-kds-subtext hidden md:table-cell">{row.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-kds-subtext hidden md:table-cell">{row.oldCostCents != null ? pkr(row.oldCostCents) : '—'}</td>
                    <td className="px-4 py-3 text-right text-kds-text font-semibold">{pkr(row.newCostCents)}</td>
                    <td className="px-4 py-3 text-right hidden md:table-cell">
                      {pct ? (
                        <span className={`text-xs font-bold ${up ? 'text-kds-red' : 'text-kds-green'}`}>
                          {up ? '▲' : '▼'} {Math.abs(Number(pct))}%
                        </span>
                      ) : <span className="text-kds-subtext text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-kds-subtext text-xs hidden md:table-cell capitalize">{row.source.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-kds-subtext text-xs">{fmt(row.recordedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function EmptyState({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="text-center py-16 text-kds-subtext">
      <p className="text-4xl mb-3">{icon}</p>
      <p className="font-semibold text-kds-text">{title}</p>
      <p className="text-sm mt-1">{sub}</p>
    </div>
  )
}
