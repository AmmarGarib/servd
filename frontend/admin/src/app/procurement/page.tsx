'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api, ApiError } from '../../lib/api'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { ApAging } from '../../components/finance/ApAging'
import { BankAccountSelect } from '../../components/finance/BankAccountSelect'
import { fmtPkrWhole, todayPktIso } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { useManagerRoles } from '../../lib/roles'
import { canOpenPath } from '../../lib/moduleCatalog'
import { usePermissions } from '../../hooks/useCan'
import { stockErrorText } from '../../lib/stockUi'
import { Select } from '@/components/ui/Select'

// Only the API's MANAGERS take a delivery in (owner decision 27, R2-UI-02) —
// the list comes from the server (lib/roles.ts). The buyer sees the dock read-only.

// Whoever raised a PO can't receive it; the CEO (role admin) is exempt — the
// server's assertNotSelfApproval rule (lib/separation-of-duties.ts). A PO with
// no creator on file predates tracking and is receivable.
const raisedByMe = (po: { createdBy?: string | null }, me: { id: string; role: string } | null) =>
  !!me && me.role !== 'admin' && !!po.createdBy && po.createdBy === me.id

// ─── Types ────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string; name: string; phone?: string | null; email?: string | null
  address?: string | null; taxId?: string | null; notes?: string | null
  paymentTermsDays: number; leadTimeDays?: number | null; openingBalanceCents: number
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
  _count?: { purchaseOrders: number; inventoryItems: number; bills: number; payments: number }
  // Tax profile (H8 / H28): decides the withholding on its bills and which
  // authority its sales tax is claimed from.
  filerStatus?: 'filer' | 'non_filer' | 'exempt' | 'unknown' | null
  whtExemptCertNo?: string | null
  whtExemptUntil?: string | null
  defaultTaxAuthority?: string | null
  defaultWhtSection?: string | null
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
  createdBy?: string | null
  cancelReason?: string | null; rejectedReason?: string | null
  supplier?: { name: string; email?: string | null } | null
  lines?: PoLine[]
}

// A supplier credit note is a bill row too (kind 'credit_note', against
// originalBillId): its creditedCents is how much of it has been applied.
interface Bill {
  id: string; supplierId: string; poId?: string | null; billNumber: string
  billDate: string; dueDate: string; status: string
  subtotalCents: number; taxCents: number; totalCents: number; whtCents: number; paidCents: number
  /** Who charged the sales tax (fbr / srb) and the withholding section applied. */
  taxAuthority?: string | null
  whtSection?: string | null
  creditedCents?: number
  kind?: 'bill' | 'credit_note'
  originalBillId?: string | null
  originalBill?: { id: string; billNumber: string } | null
  notes?: string | null; attachmentUrl?: string | null
  supplier?: { name: string; tenantId?: string | null } | null
  po?: { id: string; reference?: string | null } | null
}

// What the supplier is still owed: net of the withholding the ledger moved to
// FBR, payments and credit notes applied (the server's billDueCents rule).
const billDue = (b: Pick<Bill, 'totalCents' | 'whtCents' | 'paidCents' | 'creditedCents'>) =>
  b.totalCents - (b.whtCents ?? 0) - b.paidCents - (b.creditedCents ?? 0)

// What is left of a credit note to apply to bills (what it took off AP, less what is applied).
const creditLeft = (cn: Pick<Bill, 'totalCents' | 'whtCents' | 'creditedCents'>) =>
  cn.totalCents - (cn.whtCents ?? 0) - (cn.creditedCents ?? 0)

interface CreditableLine {
  billLineId: string; description: string; quantity: number; unitCostCents: number; lineTotalCents: number
  stockItemId: string | null; creditedCents: number; returnedQty: number; leftCents: number; returnableQty: number
}

interface BillDetail extends Bill {
  creditable: { lines: CreditableLine[]; subtotalLeftCents: number; taxLeftCents: number } | null
  creditsGiven?: Array<{ billId: string; amountCents: number; bill?: { id: string; billNumber: string } | null }>
}

interface SupplierPayment {
  id: string; supplierId: string; paymentDate: string; method: string
  reference?: string | null; amountCents: number; appliedCents: number
  notes?: string | null
  bankAccountId?: string | null
  bankAccount?: { id: string; name: string; bankName?: string | null; accountCode?: string | null } | null
  voidedAt?: string | null; voidReason?: string | null
  applications?: Array<{ billId: string; amountAppliedCents: number; bill?: { id: string; billNumber: string } | null }>
  supplier?: { name: string; tenantId?: string | null } | null
}

const PAYMENT_METHODS: Array<{ id: string; label: string }> = [
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'cheque',        label: 'Cheque' },
  { id: 'wallet',        label: 'Wallet (JazzCash / Easypaisa)' },
  { id: 'cash',          label: 'Cash' },
]
const methodLabel = (m: string) => PAYMENT_METHODS.find((x) => x.id === m)?.label ?? m.replace(/_/g, ' ')

const CREDIT_REASONS: Array<{ id: 'return' | 'price' | 'short' | 'damaged' | 'rebate'; label: string; hint: string }> = [
  { id: 'return',  label: 'Goods returned',   hint: 'Goods went back to the supplier — credited at the billed price.' },
  { id: 'damaged', label: 'Damaged goods',    hint: 'Damaged on arrival — sent back, or kept at an allowance.' },
  { id: 'short',   label: 'Short delivery',   hint: 'Billed for more than arrived — no stock moves.' },
  { id: 'price',   label: 'Price correction', hint: 'The supplier charged too much per unit — enter the credit per unit.' },
  { id: 'rebate',  label: 'Rebate',           hint: 'A discount after the bill — enter the credit per unit.' },
]

// GET /procurement/reorder: items below par, grouped by their supplier —
// each group is a purchase order ready to draft.
interface ReorderLine {
  inventoryItemId: string; name: string; unit: string
  currentStock: number; parLevel: number; onOrder: number; suggestedQty: number; unitCostCents: number
}
interface ReorderGroup {
  supplierId: string | null; supplierName: string; estimatedTotalCents: number
  lines: ReorderLine[]
}

interface PoDraft {
  supplierId: string
  lines: Array<{ inventoryItemId: string; quantityOrdered: string; unitCostCents: string; notes: string }>
}

const errText = (e: unknown) => stockErrorText(e)
const rupeesToPaisa = (v: string) => Math.round(Number(v) * 100)
/** A stored instant (the end of a PKT day) as the PKT calendar date YYYY-MM-DD. */
const pktDate = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10)

interface InventoryItem { id: string; name: string; unit: string; supplierId?: string | null; unitCostCents?: number | null }
interface PriceHistoryRow {
  id: string; inventoryItemId: string; supplierId?: string | null
  oldCostCents?: number | null; newCostCents: number; source: string
  recordedAt: string
  inventoryItem?: { name: string; unit: string } | null
  supplier?: { name: string } | null
}

type Tab = 'pos' | 'bills' | 'payments' | 'suppliers' | 'aging' | 'reorder' | 'approvals' | 'history'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-s-muted bg-s-elevated',
  pending_approval: 'text-s-amber bg-amber-100/40',
  approved: 'text-success bg-accent-dim',
  sent: 'text-blue-700 bg-blue-100/40',
  partial: 'text-primary-ink bg-primary/10',
  received: 'text-success bg-accent-dim',
  cancelled: 'text-s-muted bg-s-elevated',
  open: 'text-s-amber bg-amber-100/40',
  partially_paid: 'text-primary-ink bg-primary/10',
  paid: 'text-success bg-accent-dim',
  applied: 'text-success bg-accent-dim',
  void: 'text-s-muted bg-s-elevated',
  overdue: 'text-s-red bg-red-100/40',
}

function Badge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'text-zinc-600 bg-s-elevated'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function fmt(iso: string) { return new Date(iso).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: '2-digit' }) }

const fi = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-s-muted font-medium">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProcurementPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('pos')
  // /procurement?new=po[&item=<id>&qty=<n>] — opened from Inventory's
  // "Purchase order" button: lands on Purchase Orders with the new-PO form
  // open (and, when an item is given, that item as its first line).
  const [newPo, setNewPo] = useState<{ item: string | null; qty: string | null } | null>(null)
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const wanted = sp.get('tab')
      if (wanted && ['pos', 'bills', 'payments', 'suppliers', 'aging', 'reorder', 'approvals', 'history'].includes(wanted)) setTab(wanted as Tab)
      if (sp.get('new') === 'po') { setTab('pos'); setNewPo({ item: sp.get('item'), qty: sp.get('qty') }) }
    } catch { /* no window */ }
  }, [])

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'pos',       label: 'Purchase Orders', icon: '' },
    { id: 'bills',     label: 'Bills (AP)',       icon: '' },
    { id: 'payments',  label: 'Payments',         icon: '' },
    { id: 'suppliers', label: 'Suppliers',        icon: '' },
    { id: 'aging',     label: 'Aging',            icon: '' },
    { id: 'reorder',   label: 'Reorder',          icon: '' },
    { id: 'approvals', label: 'Approvals',        icon: '' },
    { id: 'history',   label: 'Price History',    icon: '' },
  ]

  return (
    <div className="min-h-screen bg-s-bg flex flex-col">
      <header className="border-b border-s-border px-6 py-4 shrink-0">
        <h1 className="text-2xl font-black text-s-text">Procurement</h1>
        <p className="text-sm text-s-muted mt-0.5">Purchase orders · Accounts payable · Supplier management</p>
      </header>

      {/* Tab strip */}
      <div className="flex gap-0.5 px-6 pt-4 border-b border-s-border overflow-x-auto shrink-0 scrollbar-hide">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 whitespace-nowrap transition-colors
              ${tab === t.id ? 'border-accent text-primary-ink bg-s-surface' : 'border-transparent text-s-muted hover:text-s-text'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'pos'       && <PoTab       qc={qc} newPo={newPo} />}
        {tab === 'bills'     && <BillsTab    qc={qc} />}
        {tab === 'payments'  && <PaymentsTab qc={qc} />}
        {tab === 'suppliers' && <SuppliersTab qc={qc} />}
        {tab === 'aging'     && <AgingTab />}
        {tab === 'reorder'   && <ReorderTab qc={qc} />}
        {tab === 'approvals' && <ApprovalsTab qc={qc} />}
        {tab === 'history'   && <PriceHistoryTab />}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PURCHASE ORDERS TAB
// ══════════════════════════════════════════════════════════════════════════════

function PoTab({ qc, newPo }: { qc: ReturnType<typeof useQueryClient>; newPo?: { item: string | null; qty: string | null } | null }) {
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  // The deep link from Inventory opens the form once (and pre-fills one item line).
  const { data: stockItems, isError: stockItemsFailed } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
    enabled: !!newPo?.item,
  })
  useEffect(() => { if (newPo) setShowCreate(true) }, [newPo])
  const linkedItem = newPo?.item ? stockItems?.find((i) => i.id === newPo.item) ?? null : null
  const linkedDraft: PoDraft | undefined = linkedItem
    ? {
        supplierId: linkedItem.supplierId ?? '',
        lines: [{
          inventoryItemId: linkedItem.id,
          quantityOrdered: newPo?.qty && Number(newPo.qty) > 0 ? newPo.qty : '',
          unitCostCents: linkedItem.unitCostCents ? String(linkedItem.unitCostCents / 100) : '',
          notes: '',
        }],
      }
    : undefined
  const waitingForItem = !!newPo?.item && stockItems === undefined && !stockItemsFailed
  const [detailId, setDetailId] = useState<string | null>(null)
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  // Approved ≠ sent: "Mark sent" records that the buyer sent it themselves.
  const [markSentId, setMarkSentId] = useState<string | null>(null)
  const [markSentChannel, setMarkSentChannel] = useState<'phone' | 'whatsapp' | 'in_person' | 'email'>('phone')
  const [markSentNote, setMarkSentNote] = useState('')

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

  const [sentNotice, setSentNotice] = useState<string | null>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (sentTimer.current) clearTimeout(sentTimer.current) }, [])
  const actionMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/procurement/purchase-orders/${id}/${action}`, body ?? {}),
    onSuccess: (res, vars) => {
      // A submit that lands in the approvals inbox says so (also via a head office).
      const r = res as { status?: string; viaHeadOfficeId?: string | null } | null
      if (vars.action === 'submit' && r && ((r.status && ['pending_approval', 'submitted'].includes(r.status)) || r.viaHeadOfficeId)) {
        setSentNotice('Sent for approval')
        if (sentTimer.current) clearTimeout(sentTimer.current)
        sentTimer.current = setTimeout(() => setSentNotice(null), 6000)
      }
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
                ${statusFilter === s ? 'bg-accent-dim border border-accent text-s-text' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <button onClick={() => setShowCreate(true)}
          className="ml-auto rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + New PO
        </button>
      </div>

      {showCreate && !waitingForItem && (
        <CreatePoForm key={linkedDraft ? 'linked' : 'blank'} qc={qc} initial={linkedDraft} title={linkedDraft ? `New purchase order for ${linkedItem?.name ?? 'this item'}` : undefined}
          onClose={() => setShowCreate(false)} />
      )}

      {sentNotice && <p className="text-xs font-bold text-success">{sentNotice}</p>}
      {actionMut.error && (
        <p className="text-xs text-s-red">{actionMut.error instanceof Error ? actionMut.error.message : 'That did not work'}</p>
      )}

      {isLoading ? (
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : orders.length === 0 ? (
        <EmptyState icon="" title="No purchase orders" sub="Create your first PO to get started" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Reference</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Created</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Expected</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Total</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <tr key={po.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => setDetailId(po.id === detailId ? null : po.id)}
                      className="font-mono text-xs text-primary-ink hover:underline">
                      {po.reference ?? po.id.slice(-8)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-s-text font-medium">{po.supplier?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-s-muted hidden md:table-cell">{fmt(po.createdAt)}</td>
                  <td className="px-4 py-3 text-s-muted hidden md:table-cell">{po.expectedDate ? fmt(po.expectedDate) : '—'}</td>
                  <td className="px-4 py-3 text-s-text font-semibold text-right">{fmtPkrWhole(po.totalCents)}</td>
                  <td className="px-4 py-3"><Badge status={po.status} /></td>
                  <td className="px-4 py-3">
                    <PoActions po={po} onAction={(action, body) => {
                      if (action === 'reject') { setRejectId(po.id); return }
                      if (action === 'cancel') { setCancelId(po.id); return }
                      if (action === 'mark-sent') { setMarkSentId(po.id); return }
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
        <div className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold text-s-text">PO Detail — {detail.reference ?? detail.id.slice(-8)}</p>
            <button onClick={() => setDetailId(null)} className="text-s-muted hover:text-s-text text-xs">✕ Close</button>
          </div>
          {detail.lines && detail.lines.length > 0 && (
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-s-border/50">
                  <th className="text-left py-1.5 text-s-muted">Item</th>
                  <th className="text-right py-1.5 text-s-muted">Ordered</th>
                  <th className="text-right py-1.5 text-s-muted">Received</th>
                  <th className="text-right py-1.5 text-s-muted">Unit Cost</th>
                  <th className="text-right py-1.5 text-s-muted">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id} className="border-b border-s-border/30 last:border-0">
                    <td className="py-1.5 text-s-text">{l.inventoryItem?.name ?? l.inventoryItemId}</td>
                    <td className="py-1.5 text-right text-s-text">{l.quantityOrdered} {l.inventoryItem?.unit}</td>
                    <td className="py-1.5 text-right text-s-muted">{l.quantityReceived}</td>
                    <td className="py-1.5 text-right text-s-muted">{fmtPkrWhole(l.unitCostCents)}</td>
                    <td className="py-1.5 text-right text-s-text font-semibold">{fmtPkrWhole(l.quantityOrdered * l.unitCostCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {detail.notes && <p className="text-xs text-s-muted">Notes: {detail.notes}</p>}
          {detail.rejectedReason && <p className="text-xs text-s-red">Rejected: {detail.rejectedReason}</p>}
          {detail.cancelReason && <p className="text-xs text-s-muted">Cancelled: {detail.cancelReason}</p>}
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">Reject PO</p>
            <Field label="Reason (required)">
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!rejectReason || actionMut.isPending}
                onClick={() => { actionMut.mutate({ id: rejectId, action: 'reject', body: { reason: rejectReason } }); setRejectId(null); setRejectReason('') }}
                className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Reject
              </button>
              <button onClick={() => { setRejectId(null); setRejectReason('') }}
                className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Mark sent modal — the PO went out by phone / own WhatsApp / in person */}
      {markSentId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">Mark PO as sent</p>
            <p className="text-xs text-s-muted">Only if you have already given this order to the supplier yourself.</p>
            <Field label="How was it sent?">
              <Select value={markSentChannel} onChange={(e) => setMarkSentChannel(e.target.value as typeof markSentChannel)} className={fi}>
                <option value="phone">Phone call</option>
                <option value="whatsapp">WhatsApp (my phone)</option>
                <option value="in_person">In person</option>
                <option value="email">Email (my inbox)</option>
              </Select>
            </Field>
            <Field label="Note (optional)">
              <input value={markSentNote} onChange={(e) => setMarkSentNote(e.target.value)} placeholder="e.g. spoke to Imran, delivery Tuesday" className={fi} />
            </Field>
            <div className="flex gap-2">
              <button disabled={actionMut.isPending}
                onClick={() => { actionMut.mutate({ id: markSentId, action: 'mark-sent', body: { channel: markSentChannel, note: markSentNote || null } }); setMarkSentId(null); setMarkSentNote('') }}
                className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Mark sent
              </button>
              <button onClick={() => { setMarkSentId(null); setMarkSentNote('') }}
                className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Back</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel modal */}
      {cancelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">Cancel PO</p>
            <Field label="Reason (required)">
              <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!cancelReason || actionMut.isPending}
                onClick={() => { actionMut.mutate({ id: cancelId, action: 'cancel', body: { reason: cancelReason } }); setCancelId(null); setCancelReason('') }}
                className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Cancel PO
              </button>
              <button onClick={() => { setCancelId(null); setCancelReason('') }}
                className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PoActions({ po, onAction }: { po: PurchaseOrder; onAction: (action: string, body?: unknown) => void }) {
  const me = useAuthStore((s) => s.user)
  const isManager = useManagerRoles().has(me?.role ?? '')
  const ownPo = raisedByMe(po, me)
  const canReceive = isManager && !ownPo
  const actions: { label: string; action: string; cls: string; title?: string }[] = []
  if (po.status === 'draft') {
    actions.push({ label: 'Submit', action: 'submit', cls: 'text-s-amber hover:text-s-amber' })
  }
  if (po.status === 'pending_approval') {
    actions.push({ label: 'Approve', action: 'approve', cls: 'text-primary-ink hover:opacity-80' })
    actions.push({ label: 'Reject', action: 'reject', cls: 'text-s-red hover:opacity-80' })
  }
  if (po.status === 'approved') {
    // Approved is not sent: email/WhatsApp it, or record that it was phoned in.
    actions.push({ label: 'Send', action: 'send', cls: 'text-sky-700 hover:opacity-80' })
    actions.push({ label: 'Mark sent', action: 'mark-sent', cls: 'text-sky-700 hover:opacity-80' })
  }
  if (po.status === 'sent' || po.status === 'partial') {
    // A manager receives; anyone else (the buyer) opens the dock page
    // read-only. A manager who raised this PO can't receive it (decision 27).
    actions.push(canReceive
      ? { label: 'Receive', action: 'receive', cls: 'text-primary-ink hover:opacity-80' }
      : {
          label: 'View at dock', action: 'receive', cls: 'text-s-muted hover:text-s-text',
          title: ownPo ? 'You raised this PO, so a colleague receives it' : 'A manager takes the delivery in',
        })
  }
  if (['draft', 'pending_approval', 'approved'].includes(po.status)) {
    actions.push({ label: 'Cancel', action: 'cancel', cls: 'text-zinc-500 hover:text-s-red' })
  }
  if (actions.length === 0) return null
  return (
    <div className="flex gap-2">
      {actions.map((a) => (
        <button key={a.action} onClick={() => onAction(a.action)} title={a.title}
          className={`text-xs font-semibold transition-colors ${a.cls}`}>
          {a.label}
        </button>
      ))}
    </div>
  )
}

// ─── Create PO form ───────────────────────────────────────────────────────────

function CreatePoForm({ qc, onClose, initial, title }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void; initial?: PoDraft; title?: string }) {
  const { data: suppliers = [] } = useQuery({
    queryKey: ['procurement', 'suppliers'],
    queryFn: () => api.get<Supplier[]>('/procurement/suppliers'),
  })
  const { data: invItems = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
  })

  // A draft from the Reorder tab arrives pre-filled; the buyer can still change anything.
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? '')
  const [reference, setReference] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState(initial?.lines.length ? initial.lines : [{ inventoryItemId: '', quantityOrdered: '', unitCostCents: '', notes: '' }])

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
      // What is on order changes what the reorder list suggests.
      void qc.invalidateQueries({ queryKey: ['procurement', 'reorder'] })
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
    <div className="rounded-xl border border-primary bg-s-surface p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-s-text">{title ?? (initial ? 'Draft purchase order from reorder suggestions' : 'New Purchase Order')}</p>
        <button onClick={onClose} className="text-s-muted hover:text-s-text text-xs">✕</button>
      </div>
      {initial && !title && (
        <p className="text-xs text-s-muted">Quantities bring each item back to its par level, after what is already on order. Check them and the prices, then create the PO — it is a draft until you submit it.</p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Supplier *">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fi}>
            <option value="">Select supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
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
        <p className="text-xs font-bold text-s-muted uppercase tracking-widest">Line items</p>
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-5">
              <Select value={line.inventoryItemId} onChange={(e) => updateLine(i, 'inventoryItemId', e.target.value)} className={fi}>
                <option value="">Select item</option>
                {invItems.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.unit})</option>)}
              </Select>
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
              <button onClick={() => removeLine(i)} className="w-full rounded-lg border border-s-border text-s-red py-2 text-sm hover:bg-red-100/20">✕</button>
            </div>
          </div>
        ))}
        <button onClick={addLine} className="text-xs text-primary-ink hover:underline">+ Add line</button>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-s-border">
        <p className="text-sm font-bold text-s-text">Total: {fmtPkrWhole(totalCents)}</p>
        <div className="flex gap-2">
          <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
            className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Creating…' : 'Create PO'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
      {mut.isError && <p className="text-xs text-s-red">{(mut.error as Error).message}</p>}
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
  const [view, setView] = useState<'bills' | 'credit_notes'>('bills')
  const [statusFilter, setStatusFilter] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [matchId, setMatchId] = useState<string | null>(null)
  const [creditBillId, setCreditBillId] = useState<string | null>(null)
  const [applyCn, setApplyCn] = useState<Bill | null>(null)
  const [unapplyCnId, setUnapplyCnId] = useState<string | null>(null)

  const qs = new URLSearchParams()
  if (statusFilter) qs.set('status', statusFilter)
  if (overdue) qs.set('overdue', 'true')

  const { data: bills = [], isLoading } = useQuery({
    queryKey: ['procurement', 'bills', statusFilter, overdue],
    queryFn: () => api.get<Bill[]>(`/procurement/bills?${qs}`),
    enabled: view === 'bills',
  })

  const { data: creditNotes = [], isLoading: cnLoading } = useQuery({
    queryKey: ['procurement', 'credit-notes'],
    queryFn: () => api.get<Bill[]>('/procurement/bills?kind=credit_note'),
    enabled: view === 'credit_notes',
  })

  const { data: matchResult } = useQuery({
    queryKey: ['procurement', 'bill-match', matchId],
    queryFn: () => api.get<Record<string, unknown>>(`/procurement/bills/${matchId}/match`),
    enabled: !!matchId,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['procurement'] })
    void qc.invalidateQueries({ queryKey: ['ap-aging'] })
  }

  // Voids a bill — or a credit note (the server routes it to the credit
  // note's own void: stock goes back, its entry is reversed).
  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/procurement/bills/${id}/void`, { reason }),
    onSuccess: () => { refresh(); setVoidId(null); setVoidReason('') },
  })

  const statuses = ['', 'open', 'partially_paid', 'paid', 'void']
  const voiding = voidId ? [...bills, ...creditNotes].find((b) => b.id === voidId) : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex gap-1">
        {([['bills', 'Bills'], ['credit_notes', 'Credit notes & returns']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors
              ${view === id ? 'bg-primary text-primary-on' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'bills' && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 flex-wrap">
            {statuses.map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                  ${statusFilter === s && !overdue ? 'bg-accent-dim border border-accent text-s-text' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
                {s ? s.replace(/_/g, ' ') : 'All'}
              </button>
            ))}
            <button onClick={() => { setOverdue(!overdue); setStatusFilter('') }}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                ${overdue ? 'bg-s-red text-bone' : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'}`}>
              Overdue
            </button>
          </div>
          <button onClick={() => setShowCreate(true)}
            className="ml-auto rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
            + New Bill
          </button>
        </div>
      )}

      {view === 'credit_notes' && (
        <p className="text-xs text-s-muted">
          A credit note is recorded against a bill (Bills → Credit note). It lowers what the supplier is owed, the stock sent back and the input tax claimed.
          Whatever is not yet applied to a bill is a credit with the supplier.
        </p>
      )}

      {showCreate && view === 'bills' && <CreateBillForm qc={qc} onClose={() => setShowCreate(false)} />}

      {voidMut.error && <p className="text-xs text-s-red">{errText(voidMut.error)}</p>}

      {view === 'bills' && (isLoading ? (
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : bills.length === 0 ? (
        <EmptyState icon="" title="No bills" sub="Record supplier invoices here" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Bill #</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Date</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Due</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Total</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Outstanding</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const isOverdue = b.status !== 'paid' && b.status !== 'void' && new Date(b.dueDate) < new Date()
                return (
                  <tr key={b.id} className={`border-b border-s-border/50 last:border-0 hover:bg-s-surface/30 transition-colors ${isOverdue ? 'bg-red-100/5' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs text-primary-ink">{b.billNumber}</td>
                    <td className="px-4 py-3 text-s-text font-medium">{b.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-s-muted hidden md:table-cell">{fmt(b.billDate)}</td>
                    <td className={`px-4 py-3 hidden md:table-cell ${isOverdue ? 'text-s-red font-semibold' : 'text-s-muted'}`}>{fmt(b.dueDate)}</td>
                    <td className="px-4 py-3 text-s-text font-semibold text-right">
                      {fmtPkrWhole(b.totalCents)}
                      {b.taxCents > 0 && <p className="text-[10px] font-normal text-s-muted">incl. {fmtPkrWhole(b.taxCents)} {authorityShort(b.taxAuthority) || 'sales'} tax</p>}
                      {b.whtCents > 0 && <p className="text-[10px] font-normal text-s-muted">{fmtPkrWhole(b.whtCents)} withheld{b.whtSection && b.whtSection !== 'none' ? ` (${whtLabel(b.whtSection).split(' — ')[0]})` : ''}</p>}
                    </td>
                    <td className={`px-4 py-3 font-semibold text-right ${billDue(b) > 0 ? 'text-s-red' : 'text-success'}`}>
                      {fmtPkrWhole(billDue(b))}
                      {(b.creditedCents ?? 0) > 0 && <p className="text-[10px] font-normal text-s-muted">{fmtPkrWhole(b.creditedCents ?? 0)} credited</p>}
                    </td>
                    <td className="px-4 py-3"><Badge status={isOverdue ? 'overdue' : b.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => setMatchId(matchId === b.id ? null : b.id)}
                          className="text-xs text-sky-700 hover:opacity-80 font-semibold">Match</button>
                        {b.status !== 'void' && (
                          <button onClick={() => setCreditBillId(b.id)}
                            className="text-xs text-primary-ink hover:opacity-80 font-semibold whitespace-nowrap">Credit note / return</button>
                        )}
                        {b.status !== 'void' && (
                          <button onClick={() => { setVoidId(b.id); setVoidReason('') }}
                            className="text-xs text-s-red hover:opacity-80 font-semibold">Void</button>
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
      ))}

      {view === 'credit_notes' && (cnLoading ? (
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : creditNotes.length === 0 ? (
        <EmptyState icon="" title="No credit notes" sub="Record a supplier's credit note or a return from the bill it is against" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Credit note #</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Against bill</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Date</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Amount</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Not yet applied</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {creditNotes.map((cn) => {
                const left = cn.status === 'void' ? 0 : creditLeft(cn)
                return (
                  <tr key={cn.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-primary-ink">{cn.billNumber}</p>
                      {cn.notes && <p className="text-[11px] text-s-muted">{cn.notes}</p>}
                    </td>
                    <td className="px-4 py-3 text-s-text font-medium">{cn.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-s-muted font-mono text-xs hidden md:table-cell">{cn.originalBill?.billNumber ?? '—'}</td>
                    <td className="px-4 py-3 text-s-muted hidden md:table-cell">{fmt(cn.billDate)}</td>
                    <td className={`px-4 py-3 font-semibold text-right ${cn.status === 'void' ? 'text-s-muted line-through' : 'text-success'}`}>
                      {fmtPkrWhole(-cn.totalCents)}
                      {cn.whtCents > 0 && <p className="text-[10px] font-normal text-s-muted">incl. {fmtPkrWhole(cn.whtCents)} withholding</p>}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${left > 0 ? 'text-s-amber' : 'text-s-muted'}`}>{fmtPkrWhole(left)}</td>
                    <td className="px-4 py-3"><Badge status={cn.status} /></td>
                    <td className="px-4 py-3">
                      {cn.status !== 'void' && (
                        <div className="flex flex-wrap gap-2">
                          {left > 0 && (
                            <button onClick={() => setApplyCn(cn)} className="text-xs text-primary-ink hover:opacity-80 font-semibold">Apply</button>
                          )}
                          {(cn.creditedCents ?? 0) > 0 && (
                            <button onClick={() => setUnapplyCnId(cn.id)} className="text-xs text-sky-700 hover:opacity-80 font-semibold">Unapply</button>
                          )}
                          {(cn.creditedCents ?? 0) === 0 && (
                            <button onClick={() => { setVoidId(cn.id); setVoidReason('') }} className="text-xs text-s-red hover:opacity-80 font-semibold">Void</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      ))}

      {/* 3-way match result */}
      {matchId && matchResult && (
        <div className="rounded-xl border border-s-border bg-s-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-s-text text-sm">3-Way Match Result</p>
            <button onClick={() => setMatchId(null)} className="text-s-muted text-xs">✕</button>
          </div>
          <pre className="text-xs text-s-muted overflow-auto max-h-48">{JSON.stringify(matchResult, null, 2)}</pre>
        </div>
      )}

      {creditBillId && <CreditNoteForm billId={creditBillId} onDone={refresh} onClose={() => setCreditBillId(null)} />}
      {applyCn && <ApplyCreditModal cn={applyCn} onDone={refresh} onClose={() => setApplyCn(null)} />}
      {unapplyCnId && <UnapplyCreditModal creditNoteId={unapplyCnId} onDone={refresh} onClose={() => setUnapplyCnId(null)} />}

      {/* Void modal — a bill, or a credit note */}
      {voidId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">{voiding?.kind === 'credit_note' ? 'Void credit note' : 'Void Bill'}</p>
            {voiding?.kind === 'credit_note' && (
              <p className="text-xs text-s-muted">Its entry is reversed, any stock sent back goes back into stock, and the bill owes the credited amount again.</p>
            )}
            <Field label="Reason (required)">
              <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className={fi} autoFocus />
            </Field>
            {voidMut.error && <p className="text-xs text-s-red">{errText(voidMut.error)}</p>}
            <div className="flex gap-2">
              <button disabled={!voidReason || voidMut.isPending}
                onClick={() => voidMut.mutate({ id: voidId, reason: voidReason })}
                className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Void
              </button>
              <button onClick={() => { setVoidId(null); setVoidReason(''); voidMut.reset() }}
                className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Credit note / return against a bill ──────────────────────────────────────
//
// POST /procurement/bills/:id/credit-notes. Lines come from the bill; money is
// typed in rupees. The server caps everything at what is left on the bill and
// refuses a return that would take stock below zero.

function CreditNoteForm({ billId, onDone, onClose }: { billId: string; onDone: () => void; onClose: () => void }) {
  const { data: bill, isLoading, error } = useQuery({
    queryKey: ['procurement', 'bill', billId],
    queryFn: () => api.get<BillDetail>(`/procurement/bills/${billId}`),
  })

  const [number, setNumber] = useState('')
  const [date, setDate] = useState(todayPktIso())
  const [reason, setReason] = useState<(typeof CREDIT_REASONS)[number]['id']>('return')
  const [tax, setTax] = useState('')
  const [notes, setNotes] = useState('')
  const [returnStock, setReturnStock] = useState(true)
  const [applyToBill, setApplyToBill] = useState(true)
  const [picked, setPicked] = useState<Record<string, { on: boolean; qty: string; price: string }>>({})

  const byQuantity = reason === 'return' || reason === 'short' || reason === 'damaged'
  const lines = bill?.creditable?.lines ?? []
  const row = (l: CreditableLine) => picked[l.billLineId] ?? {
    on: false,
    qty: String(byQuantity && l.stockItemId ? Math.min(l.quantity, l.returnableQty || l.quantity) : l.quantity),
    price: byQuantity ? String(l.unitCostCents / 100) : '',
  }
  const setRow = (l: CreditableLine, patch: Partial<{ on: boolean; qty: string; price: string }>) =>
    setPicked((p) => ({ ...p, [l.billLineId]: { ...row(l), ...patch } }))

  const chosen = lines.filter((l) => row(l).on)
  const canSendBack = (reason === 'return' || reason === 'damaged') && chosen.some((l) => l.stockItemId)
  const subtotal = chosen.reduce((s, l) => s + Math.round((Number(row(l).qty) || 0) * rupeesToPaisa(row(l).price || '0')), 0)
  const taxCents = tax ? rupeesToPaisa(tax) : 0
  const valid = !!number.trim() && !!date && chosen.length > 0 &&
    chosen.every((l) => Number(row(l).qty) > 0 && Number(row(l).price) > 0)

  const mut = useMutation({
    mutationFn: () => api.post(`/procurement/bills/${billId}/credit-notes`, {
      number: number.trim(), date, reason,
      lines: chosen.map((l) => ({ billLineId: l.billLineId, qty: Number(row(l).qty), unitCostCents: rupeesToPaisa(row(l).price) })),
      taxCents, returnStock: canSendBack && returnStock, applyToBill, notes: notes.trim() || null,
    }),
    onSuccess: () => { onDone(); onClose() },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
      <div className="bg-s-surface border border-s-border rounded-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold text-s-text">Credit note / return{bill ? ` — bill ${bill.billNumber}` : ''}</p>
          <button onClick={onClose} className="text-s-muted text-xs">✕</button>
        </div>
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {error && <p className="text-sm text-s-red">{errText(error)}</p>}
        {bill && (
          <>
            <p className="text-xs text-s-muted">
              {bill.supplier?.name} · bill total {fmtPkrWhole(bill.totalCents)} · still owed {fmtPkrWhole(billDue(bill))}
              {bill.creditable && <> · {fmtPkrWhole(bill.creditable.subtotalLeftCents)} of goods left to credit</>}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Supplier's credit note no. *">
                <input value={number} onChange={(e) => setNumber(e.target.value)} className={fi} placeholder="CN-1043" />
              </Field>
              <Field label="Date *">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fi} />
              </Field>
              <Field label="Why *">
                <Select value={reason} onChange={(e) => { setReason(e.target.value as typeof reason); setPicked({}) }} className={fi}>
                  {CREDIT_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </Select>
              </Field>
            </div>
            <p className="text-xs text-s-muted">{CREDIT_REASONS.find((r) => r.id === reason)?.hint}</p>

            <div className="space-y-2">
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest">Lines credited</p>
              {lines.map((l) => {
                const r = row(l)
                return (
                  <div key={l.billLineId} className={`rounded-lg border p-3 space-y-2 ${r.on ? 'border-primary bg-s-bg' : 'border-s-border'}`}>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" checked={r.on} onChange={(e) => setRow(l, { on: e.target.checked })} className="mt-1 accent-accent" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-s-text font-medium">{l.description}{l.stockItemId ? '' : ' (not a stock item)'}</span>
                        <span className="block text-xs text-s-muted">
                          Billed {l.quantity} × {fmtPkrWhole(l.unitCostCents)} = {fmtPkrWhole(l.lineTotalCents)}
                          {l.creditedCents > 0 && <> · {fmtPkrWhole(l.creditedCents)} already credited</>}
                          {l.stockItemId && l.returnedQty > 0 && <> · {l.returnedQty} already sent back</>}
                        </span>
                      </span>
                    </label>
                    {r.on && (
                      <div className="grid grid-cols-2 gap-2 pl-6">
                        <Field label={byQuantity ? 'Quantity' : 'Quantity it applies to'}>
                          <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setRow(l, { qty: e.target.value })} className={fi} />
                        </Field>
                        <Field label={byQuantity ? 'Price per unit (PKR)' : 'Credit per unit (PKR) *'}>
                          <input type="number" min="0" step="any" value={r.price} onChange={(e) => setRow(l, { price: e.target.value })} className={fi} placeholder="0" />
                        </Field>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Sales tax on the credit note (PKR)">
                <input type="number" min="0" step="any" value={tax} onChange={(e) => setTax(e.target.value)} className={fi} placeholder="0" />
              </Field>
              <Field label="Note">
                <input value={notes} onChange={(e) => setNotes(e.target.value)} className={fi} placeholder="Optional" />
              </Field>
            </div>
            {canSendBack && (
              <label className="flex items-start gap-2 text-sm text-s-text cursor-pointer">
                <input type="checkbox" checked={returnStock} onChange={(e) => setReturnStock(e.target.checked)} className="mt-1 accent-accent" />
                <span>Goods sent back — take them out of stock <span className="block text-xs text-s-muted">Refused if it would take stock below zero; count the item first.</span></span>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm text-s-text cursor-pointer">
              <input type="checkbox" checked={applyToBill} onChange={(e) => setApplyToBill(e.target.checked)} className="mt-1 accent-accent" />
              <span>Take it off this bill now <span className="block text-xs text-s-muted">Up to what the bill still owes; the rest stays a credit with the supplier to apply later.</span></span>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-s-border">
              <p className="text-sm font-bold text-s-text">Credit note total: {fmtPkrWhole(-(subtotal + taxCents))}</p>
              <div className="flex gap-2">
                <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
                  className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {mut.isPending ? 'Saving…' : 'Record credit note'}
                </button>
                <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
            </div>
            {mut.isError && <p className="text-xs text-s-red">{errText(mut.error)}</p>}
          </>
        )}
      </div>
    </div>
  )
}

// Apply a credit note to open bills of the same supplier (no ledger change).
function ApplyCreditModal({ cn, onDone, onClose }: { cn: Bill; onDone: () => void; onClose: () => void }) {
  const { data: bills = [] } = useQuery({
    queryKey: ['procurement', 'bills', 'supplier', cn.supplierId],
    queryFn: () => api.get<Bill[]>(`/procurement/bills?supplierId=${cn.supplierId}`),
  })
  const open = bills.filter((b) => b.status !== 'void' && billDue(b) > 0)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const left = creditLeft(cn)
  const adding = Object.values(amounts).reduce((s, v) => s + (Number(v) > 0 ? rupeesToPaisa(v) : 0), 0)

  const mut = useMutation({
    mutationFn: () => api.post(`/procurement/credit-notes/${cn.id}/apply`, {
      applications: Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([billId, v]) => ({ billId, amountCents: rupeesToPaisa(v) })),
    }),
    onSuccess: () => { onDone(); onClose() },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
      <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-bold text-s-text">Apply credit note {cn.billNumber}</p>
          <button onClick={onClose} className="text-s-muted text-xs">✕</button>
        </div>
        <p className="text-xs text-s-muted">{fmtPkrWhole(left)} left to apply to {cn.supplier?.name ?? 'this supplier'}&apos;s bills.</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {open.map((b) => (
            <div key={b.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-s-text font-medium">{b.billNumber}</p>
                <p className="text-xs text-s-muted">Owed: {fmtPkrWhole(billDue(b))}</p>
              </div>
              <input type="number" min="0" step="any" placeholder="Amount (PKR)" className="w-32 rounded-lg bg-s-bg border border-s-border px-2 py-1.5 text-sm text-s-text focus:border-primary focus:outline-none"
                value={amounts[b.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [b.id]: e.target.value })} />
            </div>
          ))}
          {open.length === 0 && <p className="text-s-muted text-sm">This supplier has no open bills.</p>}
        </div>
        {adding > left && <p className="text-xs text-s-red">That is more than is left on the credit note.</p>}
        {mut.isError && <p className="text-xs text-s-red">{errText(mut.error)}</p>}
        <div className="flex gap-2 pt-2">
          <button onClick={() => mut.mutate()} disabled={mut.isPending || adding <= 0 || adding > left}
            className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Applying…' : 'Apply'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Take a credit note off the bills it settles (no ledger change).
function UnapplyCreditModal({ creditNoteId, onDone, onClose }: { creditNoteId: string; onDone: () => void; onClose: () => void }) {
  const { data: cn, refetch } = useQuery({
    queryKey: ['procurement', 'bill', creditNoteId],
    queryFn: () => api.get<BillDetail>(`/procurement/bills/${creditNoteId}`),
  })
  const mut = useMutation({
    mutationFn: (billId: string) => api.post(`/procurement/credit-notes/${creditNoteId}/unapply`, { billId }),
    onSuccess: () => { onDone(); void refetch() },
  })
  const applied = cn?.creditsGiven ?? []
  return (
    <UnapplyList
      title={`Unapply credit note ${cn?.billNumber ?? ''}`}
      rows={applied.map((a) => ({ billId: a.billId, billNumber: a.bill?.billNumber ?? a.billId.slice(-8), amountCents: a.amountCents }))}
      pending={mut.isPending} error={mut.error} onUnapply={(id) => mut.mutate(id)} onClose={onClose}
    />
  )
}

function UnapplyList({ title, rows, pending, error, onUnapply, onClose }: {
  title: string
  rows: Array<{ billId: string; billNumber: string; amountCents: number }>
  pending: boolean
  error: unknown
  onUnapply: (billId: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
      <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-bold text-s-text">{title}</p>
          <button onClick={onClose} className="text-s-muted text-xs">✕</button>
        </div>
        <p className="text-xs text-s-muted">The bill owes that amount again; the money stays on account with the supplier. The ledger does not change.</p>
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.billId} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-mono text-xs text-s-text">{r.billNumber}</span>
              <span className="text-s-text">{fmtPkrWhole(r.amountCents)}</span>
              <button disabled={pending} onClick={() => onUnapply(r.billId)}
                className="text-xs text-s-red hover:opacity-80 font-semibold disabled:opacity-50">Unapply</button>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-s-muted">Not applied to any bill.</p>}
        </div>
        {!!error && <p className="text-xs text-s-red">{errText(error)}</p>}
        <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Done</button>
      </div>
    </div>
  )
}

// ─── New supplier bill ────────────────────────────────────────────────────────
//
// POST /procurement/bills. Every line is one of two kinds:
//   • a STOCK line — an item that came in. It is billed against the delivery
//     that brought it ("Fill from receipt": GET /procurement/grni/unbilled-lines)
//     or its purchase-order line ("Fill from PO": poLineId + inventoryItemId),
//     never typed free-hand (422 STOCK_LINE_NEEDS_RECEIPT). Billing clears the
//     goods-received-not-invoiced balance (2015).
//   • an EXPENSE line — anything that is not stock. It names the 6xxx expense
//     account of the supplier's company (422 EXPENSE_ACCOUNT_REQUIRED). Equipment
//     and fit-out are refused (422 USE_CAPEX): they are bought through CapEx →
//     Quick buy. Finance or the CEO may say "not equipment" with a reason of 10
//     characters or more — the server decides (403 OVERRIDE_NOT_ALLOWED).
// The bill also says which authority charged the sales tax (it decides the input
// tax account) and which withholding section applies; left empty, both default
// to the supplier's usual ones.

interface UnbilledLine {
  receiptLineId: string; receiptId: string; poId: string | null; poLineId: string | null; receivedAt: string
  inventoryItemId: string | null; description: string; unit: string; openQty: number; unitCostCents: number
}
interface ChartAccount { code: string; name: string; type?: string; isActive: boolean; tenantId: string | null }

interface BillLine {
  key: string
  kind: 'stock' | 'expense'
  description: string
  quantity: string
  unitCostPkr: string
  // stock
  inventoryItemId: string
  receiptLineId: string
  poLineId: string
  source: string            // "Delivery of 12 Oct" / "PO line" — shown, not sent
  unit: string
  maxQty: number | null     // what is still open on the receipt (a hint, the server enforces)
  // expense
  expenseAccountCode: string
  notEquipment: boolean
  notEquipmentReason: string
}

const TAX_AUTHORITIES: Array<{ key: string; label: string }> = [
  { key: 'fbr', label: 'FBR — federal sales tax' },
  { key: 'srb', label: 'SRB — Sindh' },
]
const WHT_SECTION_OPTIONS: Array<{ key: string; label: string }> = [
  { key: '153_1_a', label: 's.153(1)(a) — goods' },
  { key: '153_1_b', label: 's.153(1)(b) — services' },
  { key: '153_1_c', label: 's.153(1)(c) — contracts' },
  { key: '155', label: 's.155 — rent' },
  { key: 'none', label: 'None — withhold nothing' },
]
const authorityShort = (k?: string | null) => (k ? k.toUpperCase() : '')
const whtLabel = (k?: string | null) => WHT_SECTION_OPTIONS.find((o) => o.key === k)?.label ?? ''

let billLineSeq = 0
const blankExpenseLine = (): BillLine => ({
  key: `bl${++billLineSeq}`, kind: 'expense', description: '', quantity: '1', unitCostPkr: '',
  inventoryItemId: '', receiptLineId: '', poLineId: '', source: '', unit: '', maxQty: null,
  expenseAccountCode: '', notEquipment: false, notEquipmentReason: '',
})

function CreateBillForm({ qc, onClose }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: me } = usePermissions()
  const { data: suppliers = [] } = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api.get<Supplier[]>('/procurement/suppliers') })
  const { data: pos = [] } = useQuery({ queryKey: ['procurement', 'pos', ''], queryFn: () => api.get<PurchaseOrder[]>('/procurement/purchase-orders') })

  const [form, setForm] = useState({
    supplierId: '', poId: '', billNumber: '', billDate: '', dueDate: '', taxPkr: '', taxAuthority: '', whtSection: '', notes: '', attachmentUrl: '',
  })
  const [lines, setLines] = useState<BillLine[]>([])
  const [picker, setPicker] = useState<'receipt' | 'po' | null>(null)
  const [chosen, setChosen] = useState<Record<string, boolean>>({})

  const supplier = suppliers.find((s) => s.id === form.supplierId) ?? null

  // What the supplier delivered and has not billed yet.
  const { data: unbilled = [], isFetching: unbilledLoading } = useQuery({
    queryKey: ['procurement', 'grni', 'unbilled', form.supplierId],
    queryFn: () => api.get<UnbilledLine[]>(`/procurement/grni/unbilled-lines?supplierId=${encodeURIComponent(form.supplierId)}`),
    enabled: !!form.supplierId,
    retry: false,
  })
  // The linked PO's lines.
  const { data: poDetail } = useQuery({
    queryKey: ['procurement', 'po', form.poId],
    queryFn: () => api.get<PurchaseOrder>(`/procurement/purchase-orders/${form.poId}`),
    enabled: !!form.poId,
  })
  // The supplier's company's expense accounts (6xxx, active).
  const { data: chart = [], isError: chartHidden } = useQuery({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get<ChartAccount[]>('/setup/chart-of-accounts'),
    enabled: !!form.supplierId,
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const expenseAccounts = chart
    .filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!supplier?.tenantId || a.tenantId === supplier.tenantId))
    .sort((a, b) => a.code.localeCompare(b.code))

  function patchLine(key: string, p: Partial<BillLine>) { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l))) }
  function changeSupplier(id: string) {
    // A line belongs to one supplier's deliveries and company: switching drops the stock lines.
    setForm({ ...form, supplierId: id, poId: '', taxAuthority: '', whtSection: '' })
    setLines((ls) => ls.filter((l) => l.kind === 'expense').map((l) => ({ ...l, expenseAccountCode: '' })))
    setPicker(null); setChosen({})
  }

  const used = new Set(lines.map((l) => l.receiptLineId).filter(Boolean))
  const usedPo = new Set(lines.map((l) => l.poLineId).filter(Boolean))

  function addReceiptLines() {
    const add = unbilled.filter((u) => chosen[u.receiptLineId] && !used.has(u.receiptLineId) && u.inventoryItemId).map<BillLine>((u) => ({
      key: `bl${++billLineSeq}`, kind: 'stock', description: u.description, quantity: String(Math.round(u.openQty * 1000) / 1000),
      unitCostPkr: String(u.unitCostCents / 100), inventoryItemId: u.inventoryItemId!, receiptLineId: u.receiptLineId, poLineId: '',
      source: `Delivery of ${fmt(u.receivedAt)}`, unit: u.unit, maxQty: u.openQty,
      expenseAccountCode: '', notEquipment: false, notEquipmentReason: '',
    }))
    setLines((ls) => [...ls, ...add]); setChosen({}); setPicker(null)
  }
  function addPoLines() {
    const add = (poDetail?.lines ?? []).filter((pl) => chosen[pl.id] && !usedPo.has(pl.id)).map<BillLine>((pl) => ({
      key: `bl${++billLineSeq}`, kind: 'stock', description: pl.inventoryItem?.name ?? 'Item', quantity: String(pl.quantityOrdered),
      unitCostPkr: String(pl.unitCostCents / 100), inventoryItemId: pl.inventoryItemId, receiptLineId: '', poLineId: pl.id,
      source: `PO line${poDetail?.reference ? ` (${poDetail.reference})` : ''}`, unit: pl.inventoryItem?.unit ?? '', maxQty: null,
      expenseAccountCode: '', notEquipment: false, notEquipmentReason: '',
    }))
    setLines((ls) => [...ls, ...add]); setChosen({}); setPicker(null)
  }

  const toCents = (v: string) => Math.round(Number(v) * 100)
  const mut = useMutation({
    mutationFn: () => api.post('/procurement/bills', {
      supplierId: form.supplierId, poId: form.poId || null, billNumber: form.billNumber.trim(),
      billDate: form.billDate, dueDate: form.dueDate || null,
      taxCents: form.taxPkr ? toCents(form.taxPkr) : 0,
      // Left empty, the server uses the supplier's usual authority / section.
      ...(form.taxAuthority ? { taxAuthority: form.taxAuthority } : {}),
      ...(form.whtSection ? { whtSection: form.whtSection } : {}),
      notes: form.notes || null, attachmentUrl: form.attachmentUrl || null,
      lines: lines.map((l) => l.kind === 'stock'
        ? {
            description: l.description, inventoryItemId: l.inventoryItemId,
            ...(l.receiptLineId ? { receiptLineId: l.receiptLineId } : { poLineId: l.poLineId }),
            quantity: Number(l.quantity), unitCostCents: toCents(l.unitCostPkr),
          }
        : {
            description: l.description, expenseAccountCode: l.expenseAccountCode.trim(),
            quantity: Number(l.quantity), unitCostCents: toCents(l.unitCostPkr),
            ...(l.notEquipment ? { notEquipment: true, notEquipmentReason: l.notEquipmentReason.trim() } : {}),
          }),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement'] })
      void qc.invalidateQueries({ queryKey: ['ap-aging'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      onClose()
    },
  })

  const lineOk = (l: BillLine) =>
    l.description.trim() !== '' && Number(l.quantity) > 0 && l.unitCostPkr !== '' && Number(l.unitCostPkr) >= 0
    && (l.kind === 'stock'
      ? !!l.inventoryItemId && (!!l.receiptLineId || !!l.poLineId)
      : /^\d{4}$/.test(l.expenseAccountCode.trim()) && (!l.notEquipment || l.notEquipmentReason.trim().length >= 10))
  const valid = !!form.supplierId && form.billNumber.trim() !== '' && form.billDate !== '' && lines.length > 0 && lines.every(lineOk)
  const subtotalCents = lines.reduce((s, l) => s + Math.round((Number(l.quantity) || 0) * (Number(l.unitCostPkr) || 0) * 100), 0)
  const taxCents = form.taxPkr ? toCents(form.taxPkr) : 0

  // The equipment refusal: which lines look like what the server matched.
  const err = mut.error as (Error & { code?: string; details?: { matched?: string; accountCode?: string } }) | null
  const equipmentRefusal = err instanceof ApiError && (err.code === 'USE_CAPEX' || err.code === 'OVERRIDE_REASON_REQUIRED' || err.code === 'OVERRIDE_NOT_ALLOWED')
  const matched = equipmentRefusal ? (err.details as { matched?: string } | undefined)?.matched?.toLowerCase() ?? '' : ''
  const looksEquipment = (l: BillLine) => l.kind === 'expense' && !!matched && l.description.toLowerCase().includes(matched)
  const canOpenCapex = !!me && canOpenPath('/finance/capex', me.role, me.modules ?? [])

  const supplierAuthority = supplier?.defaultTaxAuthority ?? null
  const supplierSection = supplier?.defaultWhtSection ?? null

  return (
    <div className="rounded-xl border border-primary bg-s-surface p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-s-text">New Supplier Bill</p>
        <button onClick={onClose} className="text-s-muted text-xs" aria-label="Close">✕</button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Supplier *">
          <Select value={form.supplierId} onChange={(e) => changeSupplier(e.target.value)} className={fi}>
            <option value="">Select</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Link to PO">
          <Select value={form.poId} onChange={(e) => setForm({ ...form, poId: e.target.value })} className={fi}>
            <option value="">None</option>
            {pos.filter((p) => !form.supplierId || p.supplierId === form.supplierId).map((p) => (
              <option key={p.id} value={p.id}>{p.reference ?? p.id.slice(-8)}</option>
            ))}
          </Select>
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
        <Field label="Sales tax on the bill (PKR)">
          <input type="number" min={0} step="any" value={form.taxPkr} onChange={(e) => setForm({ ...form, taxPkr: e.target.value })} placeholder="0" className={fi} />
        </Field>
        <Field label="Tax charged by">
          <Select value={form.taxAuthority} onChange={(e) => setForm({ ...form, taxAuthority: e.target.value })} className={fi}>
            <option value="">{`Supplier's usual (${authorityShort(supplierAuthority) || 'FBR'})`}</option>
            {TAX_AUTHORITIES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </Select>
        </Field>
        <Field label="Withholding section">
          <Select value={form.whtSection} onChange={(e) => setForm({ ...form, whtSection: e.target.value })} className={fi}>
            <option value="">{`Supplier's usual (${whtLabel(supplierSection) || 's.153(1)(a) — goods'})`}</option>
            {WHT_SECTION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={fi} />
        </Field>
        <Field label="Attachment URL">
          <input value={form.attachmentUrl} onChange={(e) => setForm({ ...form, attachmentUrl: e.target.value })} placeholder="https://…" className={fi} />
        </Field>
      </div>
      {supplier && (
        <p className="text-xs text-s-muted">
          {supplier.filerStatus === 'non_filer' && 'This supplier is a non-filer, so income tax is withheld at the higher rate. '}
          {supplier.filerStatus === 'exempt' && `This supplier holds a withholding exemption${supplier.whtExemptCertNo ? ` (certificate ${supplier.whtExemptCertNo})` : ''}${supplier.whtExemptUntil ? ` until ${fmt(supplier.whtExemptUntil)}` : ''}; nothing is withheld while it is valid. `}
          {(!supplier.filerStatus || supplier.filerStatus === 'unknown') && 'This supplier’s filer status is not set, so the higher withholding rate applies. Set it under Suppliers → Edit. '}
          The tax authority decides which input-tax account the sales tax is claimed on; the withholding is worked out by the server from the section and the supplier’s status.
        </p>
      )}

      {/* Lines */}
      <div className="space-y-2">
        <p className="text-xs font-bold text-s-muted uppercase tracking-widest">Lines</p>
        <p className="text-xs text-s-muted">
          Goods that came in are billed against their delivery (or purchase order) — they clear Goods received not invoiced.
          Anything else is an expense line booked to the expense account you pick.
        </p>

        {lines.length === 0 && <p className="text-xs text-s-muted italic py-2">No lines yet. Fill from a delivery or a PO, or add an expense line.</p>}

        {lines.map((l, i) => (
          <div key={l.key} className="rounded-lg border border-s-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
                Line {i + 1} · {l.kind === 'stock' ? 'Stock item' : 'Expense'}
              </span>
              <button onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="text-xs text-s-red hover:underline">Remove</button>
            </div>

            {l.kind === 'stock' ? (
              <>
                <p className="text-sm font-semibold text-s-text">{l.description}</p>
                <p className="text-xs text-s-muted">
                  {l.source}{l.maxQty != null ? ` · ${Math.round(l.maxQty * 1000) / 1000} ${l.unit} still to bill` : ''}
                </p>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input placeholder="Description *" value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} className={fi} />
                {chartHidden || expenseAccounts.length === 0 ? (
                  <input placeholder="Expense account code (6xxx) *" inputMode="numeric" maxLength={4} value={l.expenseAccountCode}
                    onChange={(e) => patchLine(l.key, { expenseAccountCode: e.target.value.replace(/\D/g, '') })} className={fi} aria-label="Expense account code" />
                ) : (
                  <Select value={l.expenseAccountCode} onChange={(e) => patchLine(l.key, { expenseAccountCode: e.target.value })} className={fi} aria-label="Expense account">
                    <option value="">— expense account * —</option>
                    {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </Select>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:max-w-md">
              <label className="text-[11px] text-s-muted">Quantity{l.unit ? ` (${l.unit})` : ''} *
                <input type="number" min={0} step="any" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} className={fi + ' mt-0.5'} />
              </label>
              <label className="text-[11px] text-s-muted">Unit cost (PKR) *
                <input type="number" min={0} step="any" value={l.unitCostPkr} onChange={(e) => patchLine(l.key, { unitCostPkr: e.target.value })} className={fi + ' mt-0.5'} />
              </label>
            </div>

            {l.kind === 'expense' && looksEquipment(l) && (
              <div className="rounded-lg p-2.5 space-y-1.5" style={{ background: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
                <label className="flex items-start gap-2 text-xs text-s-text cursor-pointer">
                  <input type="checkbox" className="accent-accent mt-0.5" checked={l.notEquipment} onChange={(e) => patchLine(l.key, { notEquipment: e.target.checked })} />
                  <span>It is not equipment (“{matched}” matched). Finance or the CEO only.</span>
                </label>
                {l.notEquipment && (
                  <input value={l.notEquipmentReason} onChange={(e) => patchLine(l.key, { notEquipmentReason: e.target.value })} maxLength={500}
                    placeholder="Why it is an expense (10 characters or more)" className={fi} />
                )}
              </div>
            )}
          </div>
        ))}

        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" disabled={!form.supplierId} onClick={() => { setPicker(picker === 'receipt' ? null : 'receipt'); setChosen({}) }}
            className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
            Fill from receipt
          </button>
          <button type="button" disabled={!form.poId} onClick={() => { setPicker(picker === 'po' ? null : 'po'); setChosen({}) }}
            className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
            Fill from PO
          </button>
          <button type="button" disabled={!form.supplierId} onClick={() => setLines([...lines, blankExpenseLine()])}
            className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
            + Expense line
          </button>
          {!form.supplierId && <span className="text-xs text-s-muted">Pick the supplier first.</span>}
        </div>

        {picker === 'receipt' && (
          <div className="rounded-lg border border-s-border p-3 space-y-2">
            <p className="text-xs font-bold text-s-text">Delivered and not billed yet</p>
            {unbilledLoading && <p className="text-xs text-s-muted">Loading…</p>}
            {!unbilledLoading && unbilled.length === 0 && (
              <p className="text-xs text-s-muted">
                Nothing from this supplier is waiting for a bill. Receive the goods first on{' '}
                <Link href="/procurement/receiving" className="text-primary-ink hover:underline">Receiving</Link>, or bill a purchase order line before it arrives with Fill from PO.
              </p>
            )}
            {unbilled.map((u) => {
              const taken = used.has(u.receiptLineId)
              return (
                <label key={u.receiptLineId} className={`flex items-start gap-2 text-xs ${taken ? 'opacity-50' : 'cursor-pointer'}`}>
                  <input type="checkbox" className="accent-accent mt-0.5" disabled={taken || !u.inventoryItemId} checked={!!chosen[u.receiptLineId] && !taken}
                    onChange={(e) => setChosen({ ...chosen, [u.receiptLineId]: e.target.checked })} />
                  <span className="text-s-text">
                    <span className="font-semibold">{u.description}</span>
                    <span className="text-s-muted"> · {fmt(u.receivedAt)} · {Math.round(u.openQty * 1000) / 1000} {u.unit} open · PKR {(u.unitCostCents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })} each{taken ? ' · already on this bill' : ''}</span>
                  </span>
                </label>
              )
            })}
            {unbilled.length > 0 && (
              <button type="button" onClick={addReceiptLines} disabled={!unbilled.some((u) => chosen[u.receiptLineId])}
                className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold disabled:opacity-50">Add selected</button>
            )}
          </div>
        )}

        {picker === 'po' && (
          <div className="rounded-lg border border-s-border p-3 space-y-2">
            <p className="text-xs font-bold text-s-text">Lines of {poDetail?.reference ?? 'the purchase order'}</p>
            <p className="text-xs text-s-muted">
              The PO line is billed at the quantity you enter: goods already received are matched to their delivery, the rest waits as billed before arrival.
              Lower the quantity if part was billed already.
            </p>
            {(poDetail?.lines ?? []).length === 0 && <p className="text-xs text-s-muted">Loading the PO…</p>}
            {(poDetail?.lines ?? []).map((pl) => {
              const taken = usedPo.has(pl.id)
              return (
                <label key={pl.id} className={`flex items-start gap-2 text-xs ${taken ? 'opacity-50' : 'cursor-pointer'}`}>
                  <input type="checkbox" className="accent-accent mt-0.5" disabled={taken} checked={!!chosen[pl.id] && !taken}
                    onChange={(e) => setChosen({ ...chosen, [pl.id]: e.target.checked })} />
                  <span className="text-s-text">
                    <span className="font-semibold">{pl.inventoryItem?.name ?? 'Item'}</span>
                    <span className="text-s-muted"> · ordered {pl.quantityOrdered} {pl.inventoryItem?.unit ?? ''} · received {pl.quantityReceived} · PKR {(pl.unitCostCents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })} each{taken ? ' · already on this bill' : ''}</span>
                  </span>
                </label>
              )
            })}
            {(poDetail?.lines ?? []).length > 0 && (
              <button type="button" onClick={addPoLines} disabled={!(poDetail?.lines ?? []).some((pl) => chosen[pl.id])}
                className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold disabled:opacity-50">Add selected</button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-s-border">
        <p className="text-sm text-s-text">
          Subtotal <span className="font-bold">{fmtPkrWhole(subtotalCents)}</span>
          {taxCents > 0 && <> · tax {fmtPkrWhole(taxCents)} · total <span className="font-bold">{fmtPkrWhole(subtotalCents + taxCents)}</span></>}
        </p>
        <div className="flex gap-2">
          <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
            className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Saving…' : 'Save Bill'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
      {mut.isError && (
        <div role="alert" className="text-xs text-s-red space-y-1">
          <p>{errText(mut.error)}</p>
          {equipmentRefusal && err.code === 'USE_CAPEX' && canOpenCapex && (
            <p><Link href="/finance/capex?quickBuy=1" className="text-primary-ink hover:underline">Buy it through CapEx → Quick buy</Link></p>
          )}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PAYMENTS TAB
// ══════════════════════════════════════════════════════════════════════════════

function PaymentsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [showCreate, setShowCreate] = useState(false)
  const [allocateId, setAllocateId] = useState<string | null>(null)
  const [unapplyId, setUnapplyId] = useState<string | null>(null)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ['procurement', 'payments'],
    queryFn: () => api.get<SupplierPayment[]>('/procurement/payments'),
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['procurement'] })
    void qc.invalidateQueries({ queryKey: ['ap-aging'] })
  }

  const unapplyMut = useMutation({
    mutationFn: ({ id, billId }: { id: string; billId: string }) => api.post(`/procurement/payments/${id}/unapply`, { billId }),
    onSuccess: refresh,
  })
  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/procurement/payments/${id}/void`, { reason }),
    onSuccess: () => { refresh(); setVoidId(null); setVoidReason('') },
  })
  const unapplying = unapplyId ? payments.find((p) => p.id === unapplyId) : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowCreate(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Record Payment
        </button>
      </div>

      {showCreate && <CreatePaymentForm qc={qc} onClose={() => setShowCreate(false)} />}

      {isLoading ? (
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : payments.length === 0 ? (
        <EmptyState icon="" title="No payments" sub="Record supplier payments here" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Date</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Paid from</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Ref</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Amount</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Unallocated</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const isVoid = !!p.voidedAt
                const unallocated = isVoid ? 0 : p.amountCents - p.appliedCents
                return (
                  <tr key={p.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                    <td className="px-4 py-3 text-s-muted">{fmt(p.paymentDate)}</td>
                    <td className="px-4 py-3 text-s-text font-medium">
                      {p.supplier?.name ?? '—'}
                      {p.applications && p.applications.length > 0 && (
                        <p className="text-[11px] text-s-muted font-normal">Bills: {p.applications.map((a) => a.bill?.billNumber ?? '—').join(', ')}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-s-muted hidden md:table-cell">
                      {methodLabel(p.method)}
                      {p.bankAccount && <p className="text-[11px]">{p.bankAccount.name}{p.bankAccount.accountCode ? ` (${p.bankAccount.accountCode})` : ''}</p>}
                    </td>
                    <td className="px-4 py-3 text-s-muted font-mono text-xs hidden md:table-cell">{p.reference ?? '—'}</td>
                    <td className={`px-4 py-3 font-semibold text-right ${isVoid ? 'text-s-muted line-through' : 'text-s-text'}`}>{fmtPkrWhole(p.amountCents)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${unallocated > 0 ? 'text-s-amber' : 'text-s-muted'}`}>
                      {fmtPkrWhole(unallocated)}
                    </td>
                    <td className="px-4 py-3">
                      {isVoid ? (
                        <span title={p.voidReason ?? undefined}><Badge status="void" /></span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {unallocated > 0 && (
                            <button onClick={() => setAllocateId(p.id)} className="text-xs text-primary-ink hover:underline font-semibold">Allocate</button>
                          )}
                          {p.appliedCents > 0 && (
                            <button onClick={() => setUnapplyId(p.id)} className="text-xs text-sky-700 hover:underline font-semibold">Unapply</button>
                          )}
                          {p.appliedCents === 0 && (
                            <button onClick={() => { setVoidId(p.id); setVoidReason('') }} className="text-xs text-s-red hover:underline font-semibold">Void</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {allocateId && <AllocateModal paymentId={allocateId} supplierId={payments.find((p) => p.id === allocateId)?.supplierId ?? ''} qc={qc} onClose={() => setAllocateId(null)} />}

      {unapplying && (
        <UnapplyList
          title={`Unapply payment of ${fmtPkrWhole(unapplying.amountCents)}`}
          rows={(unapplying.applications ?? []).map((a) => ({ billId: a.billId, billNumber: a.bill?.billNumber ?? a.billId.slice(-8), amountCents: a.amountAppliedCents }))}
          pending={unapplyMut.isPending} error={unapplyMut.error}
          onUnapply={(billId) => unapplyMut.mutate({ id: unapplying.id, billId })}
          onClose={() => { setUnapplyId(null); unapplyMut.reset() }}
        />
      )}

      {voidId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">Void payment</p>
            <p className="text-xs text-s-muted">For a bounced cheque or a payment recorded by mistake. Its ledger entry is reversed today. Cash paid out of petty cash or a till can&apos;t be voided here.</p>
            <Field label="Reason (required)">
              <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className={fi} autoFocus placeholder="e.g. cheque bounced" />
            </Field>
            {voidMut.error && <p className="text-xs text-s-red">{errText(voidMut.error)}</p>}
            <div className="flex gap-2">
              <button disabled={!voidReason.trim() || voidMut.isPending}
                onClick={() => voidMut.mutate({ id: voidId, reason: voidReason.trim() })}
                className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Void
              </button>
              <button onClick={() => { setVoidId(null); setVoidReason(''); voidMut.reset() }}
                className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CreatePaymentForm({ qc, onClose }: { qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  const { data: suppliers = [] } = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api.get<Supplier[]>('/procurement/suppliers') })

  const [form, setForm] = useState({ supplierId: '', paymentDate: '', method: 'bank_transfer', bankAccountId: '', reference: '', amountCents: '', notes: '' })
  // The bank list is the SUPPLIER's company's (the server checks the same).
  const supplierTenant = suppliers.find((s) => s.id === form.supplierId)?.tenantId ?? null
  const usesBank = form.method !== 'cash'

  const mut = useMutation({
    mutationFn: () => api.post('/procurement/payments', {
      supplierId: form.supplierId, paymentDate: form.paymentDate,
      method: form.method, reference: form.reference || null,
      bankAccountId: usesBank && form.bankAccountId ? form.bankAccountId : null,
      amountCents: rupeesToPaisa(form.amountCents),
      notes: form.notes || null,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement'] })
      void qc.invalidateQueries({ queryKey: ['ap-aging'] })
      onClose()
    },
  })

  const valid = form.supplierId && form.paymentDate && Number(form.amountCents) > 0 && (form.method !== 'wallet' || form.bankAccountId)

  return (
    <div className="rounded-xl border border-primary bg-s-surface p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-s-text">Record Payment</p>
        <button onClick={onClose} className="text-s-muted text-xs">✕</button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Supplier *">
          <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, bankAccountId: '' })} className={fi}>
            <option value="">Select</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Date *">
          <input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} className={fi} />
        </Field>
        <Field label="Method *">
          <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value, bankAccountId: '' })} className={fi}>
            {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
        {usesBank && form.supplierId && (
          <div>
            <BankAccountSelect
              id="supplier-payment-bank"
              label={form.method === 'wallet' ? 'Wallet account *' : 'Paid from'}
              tenantId={supplierTenant}
              value={form.bankAccountId}
              onChange={(bankAccountId) => setForm({ ...form, bankAccountId })}
              className={fi}
            />
            {form.method === 'wallet' && (
              <p className="text-[11px] text-s-muted mt-1">A JazzCash / Easypaisa wallet is its own account — add it under Configuration → Bank accounts.</p>
            )}
          </div>
        )}
        <Field label="Reference">
          <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder={form.method === 'cheque' ? 'Cheque no.' : 'Bank reference'} className={fi} />
        </Field>
        <Field label="Amount (PKR) *">
          <input type="number" min="0" step="any" value={form.amountCents} onChange={(e) => setForm({ ...form, amountCents: e.target.value })} placeholder="50000" className={fi} />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={fi} />
        </Field>
      </div>
      <div className="flex gap-2 pt-2 border-t border-s-border">
        <button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {mut.isPending ? 'Saving…' : 'Record Payment'}
        </button>
        <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
      </div>
      {mut.isError && <p className="text-xs text-s-red">{errText(mut.error)}</p>}
    </div>
  )
}

function AllocateModal({ paymentId, supplierId, qc, onClose }: { paymentId: string; supplierId: string; qc: ReturnType<typeof useQueryClient>; onClose: () => void }) {
  // This supplier's bills that still owe something (open or part-paid).
  const { data: bills = [] } = useQuery({
    queryKey: ['procurement', 'bills', 'supplier', supplierId],
    queryFn: () => api.get<Bill[]>(`/procurement/bills?supplierId=${supplierId}`),
    enabled: !!supplierId,
  })
  const owing = bills.filter((b) => b.status !== 'void' && billDue(b) > 0)

  const [allocations, setAllocations] = useState<Record<string, string>>({})

  const mut = useMutation({
    mutationFn: () => {
      const applications = Object.entries(allocations)
        .filter(([, v]) => v && Number(v) > 0)
        .map(([billId, v]) => ({ billId, amountAppliedCents: rupeesToPaisa(v) }))
      return api.post(`/procurement/payments/${paymentId}/allocate`, { applications })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['procurement'] })
      void qc.invalidateQueries({ queryKey: ['ap-aging'] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4">
      <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-bold text-s-text">Allocate to Bills</p>
          <button onClick={onClose} className="text-s-muted text-xs">✕</button>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {owing.map((b) => (
            <div key={b.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-s-text font-medium">{b.billNumber}</p>
                <p className="text-xs text-s-muted">Outstanding: {fmtPkrWhole(billDue(b))}</p>
              </div>
              <input type="number" min="0" step="any" placeholder="Amount (PKR)" className="w-32 rounded-lg bg-s-bg border border-s-border px-2 py-1.5 text-sm text-s-text focus:border-primary focus:outline-none"
                value={allocations[b.id] ?? ''}
                onChange={(e) => setAllocations({ ...allocations, [b.id]: e.target.value })} />
            </div>
          ))}
          {owing.length === 0 && (
            <p className="text-s-muted text-sm">No open bills to allocate to.</p>
          )}
        </div>
        {mut.isError && <p className="text-xs text-s-red">{errText(mut.error)}</p>}
        <div className="flex gap-2 pt-2">
          <button onClick={() => mut.mutate()} disabled={mut.isPending || Object.values(allocations).every((v) => !v || Number(v) <= 0)}
            className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {mut.isPending ? 'Applying…' : 'Apply allocations'}
          </button>
          <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
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
    queryFn: () => api.get<{ supplier: Supplier; outstanding: number; openingUnpostedCents?: number; bills: Bill[]; creditNotes?: Bill[]; payments: SupplierPayment[] }>(`/procurement/suppliers/${statementId}/statement`),
    enabled: !!statementId,
  })

  const editing = editId ? suppliers.find((s) => s.id === editId) : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowCreate(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
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
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : suppliers.length === 0 ? (
        <EmptyState icon="" title="No suppliers" sub="Add your first supplier to start ordering" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Name</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Contact</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">POs</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Bills</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Terms</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                  <td className="px-4 py-3">
                    <p className="text-s-text font-semibold">{s.name}</p>
                    {s.taxId && <p className="text-xs text-s-muted">TIN: {s.taxId}</p>}
                  </td>
                  <td className="px-4 py-3 text-s-muted hidden md:table-cell">
                    {s.phone && <p className="text-xs">{s.phone}</p>}
                    {s.email && <p className="text-xs">{s.email}</p>}
                  </td>
                  <td className="px-4 py-3 text-s-muted text-right hidden md:table-cell">{s._count?.purchaseOrders ?? 0}</td>
                  <td className="px-4 py-3 text-s-muted text-right hidden md:table-cell">{s._count?.bills ?? 0}</td>
                  <td className="px-4 py-3 text-s-muted text-right">{s.paymentTermsDays}d</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => setEditId(s.id)} className="text-xs text-primary-ink hover:underline font-semibold">Edit</button>
                      <button onClick={() => setStatementId(statementId === s.id ? null : s.id)} className="text-xs text-sky-700 hover:underline font-semibold">Statement</button>
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
        <div className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold text-s-text">{statement.supplier.name} — Statement</p>
            <button onClick={() => setStatementId(null)} className="text-s-muted text-xs">✕</button>
          </div>
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-xs text-s-muted">Outstanding balance</p>
              <p className={`text-xl font-black ${statement.outstanding > 0 ? 'text-s-red' : 'text-success'}`}>{fmtPkrWhole(statement.outstanding)}</p>
            </div>
            <div>
              <p className="text-xs text-s-muted">Opening balance (included above)</p>
              <p className="text-sm font-semibold text-s-text">{fmtPkrWhole(statement.supplier.openingBalanceCents)}</p>
              {(statement.openingUnpostedCents ?? 0) !== 0 && (
                <p className="text-[11px] text-s-amber">{fmtPkrWhole(statement.openingUnpostedCents ?? 0)} not yet posted to the ledger, so not in the balance</p>
              )}
            </div>
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Bills</p>
              <div className="space-y-1">
                {statement.bills.slice(0, 5).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-s-muted font-mono">{b.billNumber}</span>
                    <span className="text-s-text">{fmtPkrWhole(b.totalCents)}</span>
                    <Badge status={b.status} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Credit notes</p>
              <div className="space-y-1">
                {(statement.creditNotes ?? []).slice(0, 5).map((cn) => (
                  <div key={cn.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-s-muted font-mono" title={cn.originalBill ? `Against bill ${cn.originalBill.billNumber}` : undefined}>{cn.billNumber}</span>
                    <span className={cn.status === 'void' ? 'text-s-muted line-through' : 'text-success'}>{fmtPkrWhole(-cn.totalCents)}</span>
                    <Badge status={cn.status} />
                  </div>
                ))}
                {(statement.creditNotes ?? []).length === 0 && <p className="text-xs text-s-muted">None</p>}
              </div>
            </div>
            <div>
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Payments</p>
              <div className="space-y-1">
                {statement.payments.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-s-muted">{fmt(p.paymentDate)}</span>
                    <span className="text-s-text">{p.bankAccount?.name ?? methodLabel(p.method)}</span>
                    <span className={p.voidedAt ? 'text-s-muted line-through' : 'text-success font-semibold'}>{fmtPkrWhole(p.amountCents)}</span>
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
    // Tax profile
    filerStatus: supplier?.filerStatus ?? 'unknown',
    whtExemptCertNo: supplier?.whtExemptCertNo ?? '',
    whtExemptUntil: supplier?.whtExemptUntil ? pktDate(supplier.whtExemptUntil) : '',
    defaultTaxAuthority: supplier?.defaultTaxAuthority ?? '',
    defaultWhtSection: supplier?.defaultWhtSection ?? '',
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
        filerStatus: form.filerStatus,
        // The exemption certificate only exists for an exempt supplier.
        whtExemptCertNo: form.filerStatus === 'exempt' ? form.whtExemptCertNo.trim() || null : null,
        whtExemptUntil: form.filerStatus === 'exempt' ? form.whtExemptUntil || null : null,
        defaultTaxAuthority: form.defaultTaxAuthority || null,
        defaultWhtSection: form.defaultWhtSection || null,
        ...(form.tenantId ? { tenantId: form.tenantId } : {}),
      }
      return supplier
        ? api.patch(`/procurement/suppliers/${supplier.id}`, data)
        : api.post('/procurement/suppliers', data)
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['procurement', 'suppliers'] }); onClose() },
    onError:   (e: unknown) => setErr(stockErrorText(e, 'Failed to save supplier')),
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
    <div className="rounded-xl border border-primary bg-s-surface p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-s-text">{supplier ? 'Edit Supplier' : 'New Supplier'}</p>
        <button onClick={onClose} className="text-s-muted text-xs">✕</button>
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
            <Select value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} className={fi}>
              {viewAll && <option value="">— pick a company —</option>}
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
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

      {/* Tax block — how this supplier's bills are taxed and withheld on. */}
      <div className="rounded-lg border border-s-border p-3 space-y-3">
        <p className="text-xs font-bold text-s-muted uppercase tracking-widest">Tax</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Filer status">
            <Select value={form.filerStatus} onChange={(e) => setForm({ ...form, filerStatus: e.target.value as typeof form.filerStatus })} className={fi}>
              <option value="filer">Filer (active taxpayer)</option>
              <option value="non_filer">Non-filer (higher withholding)</option>
              <option value="exempt">Exempt (holds a certificate)</option>
              <option value="unknown">Not known yet (higher withholding)</option>
            </Select>
          </Field>
          <Field label="Sales tax usually charged by">
            <Select value={form.defaultTaxAuthority} onChange={(e) => setForm({ ...form, defaultTaxAuthority: e.target.value })} className={fi}>
              <option value="">FBR (default)</option>
              {TAX_AUTHORITIES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </Select>
          </Field>
          <Field label="Usual withholding section">
            <Select value={form.defaultWhtSection} onChange={(e) => setForm({ ...form, defaultWhtSection: e.target.value })} className={fi}>
              <option value="">s.153(1)(a) — goods (default)</option>
              {WHT_SECTION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </Select>
          </Field>
          {form.filerStatus === 'exempt' && (
            <>
              <Field label="Exemption certificate no.">
                <input value={form.whtExemptCertNo} onChange={(e) => setForm({ ...form, whtExemptCertNo: e.target.value })} maxLength={100} className={fi} />
              </Field>
              <Field label="Certificate valid until">
                <input type="date" value={form.whtExemptUntil} onChange={(e) => setForm({ ...form, whtExemptUntil: e.target.value })} className={fi} />
              </Field>
            </>
          )}
        </div>
        <p className="text-xs text-s-muted">
          The filer status sets the withholding rate on this supplier&rsquo;s bills. An exempt supplier is not withheld from while the certificate is valid
          {form.filerStatus === 'exempt' && !form.whtExemptUntil ? ' — enter the date it runs to, or it will not count' : ''}.
          The authority and section are the defaults a new bill starts with; each bill can change them.
        </p>
      </div>
      {err && <p role="alert" className="text-xs font-bold text-s-red pt-1">{err}</p>}
      <div className="flex gap-2 pt-2 border-t border-s-border">
        <button onClick={submit} disabled={!form.name || mut.isPending}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {mut.isPending ? 'Saving…' : supplier ? 'Update' : 'Add Supplier'}
        </button>
        <button onClick={onClose} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
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

// GET /procurement/reorder returns items below par grouped by their supplier
// (service.ts reorderSuggestions — quantities already net of open POs). Each
// group drafts ONE purchase order through the normal PO form, so the
// company checks and the approval limit apply as for any PO. This tab used to
// expect a flat item list the API never sent: blank names, "NaN% below par".
function ReorderTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['procurement', 'reorder'],
    queryFn: () => api.get<ReorderGroup[]>('/procurement/reorder'),
  })
  const [draft, setDraft] = useState<PoDraft | null>(null)

  if (isLoading) return <div className="p-6"><p className="text-s-muted text-sm">Loading…</p></div>
  if (error) return <div className="p-6"><p className="text-s-red text-sm">{errText(error)}</p></div>
  if (data.length === 0) return <div className="p-6"><EmptyState icon="" title="All stocked up" sub="No items below their par level, counting what is already on order" /></div>

  const itemCount = data.reduce((s, g) => s + g.lines.length, 0)

  return (
    <div className="p-6 space-y-4">
      <div>
        <p className="font-bold text-s-text text-lg">Reorder Suggestions</p>
        <p className="text-sm text-s-muted">
          {itemCount} item{itemCount !== 1 ? 's' : ''} below par level, from {data.length} supplier{data.length !== 1 ? 's' : ''}. Quantities bring each item back to par after what is already on order.
        </p>
      </div>

      {draft && <CreatePoForm key={draft.supplierId} qc={qc} initial={draft} onClose={() => setDraft(null)} />}

      {data.map((g) => (
        <div key={g.supplierId ?? 'unassigned'} className="rounded-xl border border-s-border overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-s-surface/40 border-b border-s-border">
            <div>
              <p className="font-semibold text-s-text">{g.supplierName}</p>
              <p className="text-xs text-s-muted">
                {g.lines.length} item{g.lines.length !== 1 ? 's' : ''} · about {fmtPkrWhole(g.estimatedTotalCents)} at current cost
              </p>
            </div>
            {g.supplierId ? (
              <button
                onClick={() => setDraft({
                  supplierId: g.supplierId!,
                  lines: g.lines.map((l) => ({
                    inventoryItemId: l.inventoryItemId,
                    quantityOrdered: String(l.suggestedQty),
                    unitCostCents: l.unitCostCents ? String(l.unitCostCents / 100) : '',
                    notes: '',
                  })),
                })}
                className="rounded-xl bg-primary text-primary-on font-bold px-3 py-1.5 text-xs hover:opacity-90">
                Draft PO
              </button>
            ) : (
              <p className="text-xs text-s-amber max-w-xs">These items have no supplier of this company — set one on each item (Inventory) to order them here.</p>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-s-border">
                  <th className="text-left px-4 py-2 text-xs text-s-muted font-semibold">Item</th>
                  <th className="text-right px-4 py-2 text-xs text-s-muted font-semibold">In stock</th>
                  <th className="text-right px-4 py-2 text-xs text-s-muted font-semibold hidden sm:table-cell">On order</th>
                  <th className="text-right px-4 py-2 text-xs text-s-muted font-semibold hidden sm:table-cell">Par level</th>
                  <th className="text-right px-4 py-2 text-xs text-s-muted font-semibold">Order</th>
                  <th className="text-right px-4 py-2 text-xs text-s-muted font-semibold hidden md:table-cell">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => (
                  <tr key={l.inventoryItemId} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                    <td className="px-4 py-2.5 text-s-text font-medium">{l.name}</td>
                    <td className="px-4 py-2.5 text-right text-s-red font-semibold">{l.currentStock} {l.unit}</td>
                    <td className="px-4 py-2.5 text-right text-s-muted hidden sm:table-cell">{l.onOrder > 0 ? `${l.onOrder} ${l.unit}` : '—'}</td>
                    <td className="px-4 py-2.5 text-right text-s-muted hidden sm:table-cell">{l.parLevel} {l.unit}</td>
                    <td className="px-4 py-2.5 text-right text-s-amber font-semibold">{l.suggestedQty} {l.unit}</td>
                    <td className="px-4 py-2.5 text-right text-s-muted hidden md:table-cell">{l.unitCostCents ? fmtPkrWhole(l.suggestedQty * l.unitCostCents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
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

  if (isLoading) return <div className="p-6"><p className="text-s-muted text-sm">Loading…</p></div>

  return (
    <div className="p-6 space-y-4">
      {/* Threshold setting */}
      <div className="rounded-xl border border-s-border bg-s-surface p-4 flex flex-wrap items-center gap-4">
        <div>
          <p className="text-xs text-s-muted font-medium">Auto-approval threshold</p>
          <p className="text-sm font-bold text-s-text">
            {thresholdData ? fmtPkrWhole(thresholdData.thresholdCents) : '…'}
          </p>
          <p className="text-xs text-s-muted">POs above this value require manual approval</p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <input type="number" placeholder="New threshold (PKR)" value={newThreshold}
            onChange={(e) => setNewThreshold(e.target.value)}
            className="w-44 rounded-lg bg-s-bg border border-s-border px-3 py-1.5 text-sm text-s-text focus:border-primary focus:outline-none" />
          <button disabled={!newThreshold || thresholdMut.isPending}
            onClick={() => thresholdMut.mutate(Math.round(Number(newThreshold) * 100))}
            className="rounded-xl bg-primary text-primary-on font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50">
            Update
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon="" title="No pending approvals" sub="All purchase orders have been reviewed" />
      ) : (
        <>
          <p className="text-sm font-bold text-s-amber">{orders.length} PO{orders.length !== 1 ? 's' : ''} awaiting approval</p>
          <div className="rounded-xl border border-amber-900/40 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-900/30 bg-amber-100/10">
                  <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Reference</th>
                  <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Supplier</th>
                  <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Created</th>
                  <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Total</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {orders.map((po) => (
                  <tr key={po.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                    <td className="px-4 py-3 font-mono text-xs text-primary-ink">{po.reference ?? po.id.slice(-8)}</td>
                    <td className="px-4 py-3 text-s-text font-medium">{po.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-s-muted hidden md:table-cell">{fmt(po.createdAt)}</td>
                    <td className="px-4 py-3 text-s-text font-bold text-right">{fmtPkrWhole(po.totalCents)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => approveRejectMut.mutate({ id: po.id, action: 'approve' })}
                          disabled={approveRejectMut.isPending}
                          className="text-xs text-primary-ink hover:opacity-80 font-semibold">Approve</button>
                        <button onClick={() => { setRejectId(po.id); setRejectReason('') }}
                          className="text-xs text-s-red hover:opacity-80 font-semibold">Reject</button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50">
          <div className="bg-s-surface border border-s-border rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="font-bold text-s-text">Reject PO</p>
            <Field label="Reason (required)">
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className={fi} autoFocus />
            </Field>
            <div className="flex gap-2">
              <button disabled={!rejectReason || approveRejectMut.isPending}
                onClick={() => { approveRejectMut.mutate({ id: rejectId, action: 'reject', body: { reason: rejectReason } }); setRejectId(null) }}
                className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                Reject
              </button>
              <button onClick={() => setRejectId(null)} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
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
          <label className="text-xs text-s-muted">Item:</label>
          <Select value={itemFilter} onChange={(e) => setItemFilter(e.target.value)}
            className="rounded-lg bg-s-surface border border-s-border px-3 py-1.5 text-xs text-s-text focus:border-primary focus:outline-none">
            <option value="">All items</option>
            {invItems.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-s-muted">Supplier:</label>
          <Select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
            className="rounded-lg bg-s-surface border border-s-border px-3 py-1.5 text-xs text-s-text focus:border-primary focus:outline-none">
            <option value="">All suppliers</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-s-muted text-sm py-8 text-center">Loading…</p>
      ) : data.length === 0 ? (
        <EmptyState icon="" title="No price history" sub="Receive purchase orders to build price history" />
      ) : (
        <div className="rounded-xl border border-s-border overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-s-border bg-s-surface/40">
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Item</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Supplier</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Old cost</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">New cost</th>
                <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Change</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold hidden md:table-cell">Source</th>
                <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const pct = row.oldCostCents && row.oldCostCents > 0
                  ? ((row.newCostCents - row.oldCostCents) / row.oldCostCents * 100).toFixed(1)
                  : null
                const up = pct && Number(pct) > 0
                return (
                  <tr key={row.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-surface/30">
                    <td className="px-4 py-3 text-s-text font-medium">{row.inventoryItem?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-s-muted hidden md:table-cell">{row.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-s-muted hidden md:table-cell">{row.oldCostCents != null ? fmtPkrWhole(row.oldCostCents) : '—'}</td>
                    <td className="px-4 py-3 text-right text-s-text font-semibold">{fmtPkrWhole(row.newCostCents)}</td>
                    <td className="px-4 py-3 text-right hidden md:table-cell">
                      {pct ? (
                        <span className={`text-xs font-bold ${up ? 'text-s-red' : 'text-success'}`}>
                          {up ? '▲' : '▼'} {Math.abs(Number(pct))}%
                        </span>
                      ) : <span className="text-s-muted text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-s-muted text-xs hidden md:table-cell capitalize">{row.source.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-s-muted text-xs">{fmt(row.recordedAt)}</td>
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
    <div className="text-center py-16 text-s-muted">
      {icon && <p className="text-4xl mb-3">{icon}</p>}
      <p className="font-semibold text-s-text">{title}</p>
      <p className="text-sm mt-1">{sub}</p>
    </div>
  )
}
