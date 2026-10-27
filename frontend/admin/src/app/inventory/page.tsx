'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../lib/api'
import { todayPktIso } from '../../lib/money'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'
import { TenantChip, TenantField, useMyTenants } from '../../components/ui/TenantPicker'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { useKitchenView, useStockActions } from './kitchenView'
import { canOpenPath } from '../../lib/moduleCatalog'
import { usePermissions } from '../../hooks/useCan'
import { useManagerRoles } from '../../lib/roles'
import { useAuthStore } from '../../store/auth'
import { INVENTORY_CATEGORY_OPTIONS, categoryOptionText, categoryLabel, categoryValueOf, stockErrorText } from '../../lib/stockUi'
import { Select } from '@/components/ui/Select'
import { FormField } from '../../components/ui/FormField'
import { NumberField } from '../../components/ui/NumberField'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { ExpiringLots, type ExpiringRow } from '../../components/inventory/ExpiringLots'
import { ItemStockHistory } from '../../components/kitchen/ItemStockHistory'

interface InventoryItem {
  id: string; name: string; unit: string; currentStock: number; parLevel: number
  unitCostCents: number | null; supplierId: string | null; notes: string | null
  /** One of the stock categories (Drinks = beverage → 1220, Packaging → 1230, the rest food → 1210). */
  category?: string | null
  /** Oil, salt and other items no recipe measures: each receipt goes straight to cost of sales. */
  issueOnReceipt?: boolean
  /** 'deliveries' = the cost is the price paid (lots / deliveries); 'opening' = a typed estimate. */
  costSource?: 'deliveries' | 'opening' | null
  onHandValueCents?: number
  /** On hand per outlet (stock by site, 2026-10-24); currentStock is the company total. */
  bySite?: Array<{ locationId: string; qty: number }>
  /** 'prep' = made in house by prep batches. */
  kind?: string
  /** The unit it is bought in and how many stock units one holds (a delivery typed in it converts at the dock). */
  purchaseUnit?: string | null
  purchaseUnitFactor?: number
  countFrequency?: 'daily' | 'weekly'
  /** Use-by (owner B6, 2026-10-26): from servd's ingredient when linked (masterIngredientId), else the item's own. */
  perishable?: boolean
  shelfLifeDays?: number | null
  masterIngredientId?: string | null
  /** Kitchen floor view: the API took cost and supplier out (wave 3). */
  costsHidden?: boolean
  // Tenant scoping added 2026-05-13. Backfilled via supplier where one
  // exists; legacy rows with no supplier come through with tenantId=null
  // and wear the "⚠ No company" badge until the CEO assigns them.
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
}

interface WasteLog {
  id: string
  quantity: number
  unit: string
  reason: string
  estimatedCostCents: number | null
  photoUrl: string | null
  notes: string | null
  recordedAt: string
  inventoryItem: { name: string; unit: string }
  recordedBy: { name: string } | null
  conceptId?: string | null
  locationId?: string | null
}
interface BrandLite { id: string; name: string; tenantId: string | null }
interface OutletLite { id: string; name: string; tenantId?: string | null; isActive?: boolean }

type Tab = 'stock' | 'alerts' | 'waste' | 'expiring'

const WASTE_REASONS = ['spoilage', 'over_prep', 'expired', 'damaged', 'other'] as const

function getStockStatus(item: InventoryItem): 'out' | 'low' | 'ok' {
  if (item.currentStock === 0) return 'out'
  if (item.currentStock <= item.parLevel) return 'low'
  return 'ok'
}

// ─── Waste photo ──────────────────────────────────────────────────────────────
//
// The server values waste itself (the item's average cost × quantity) and
// refuses waste above the company's photo limit (PKR 500 by default) without a
// photo. The photo goes up through the same presigned flow as every other
// admin upload (GET /media/upload-url, then PUT straight to storage), and the
// public URL rides on the waste log as photoUrl.

// The server's default photo limit, for the hint only — the server decides.
const DEFAULT_PHOTO_LIMIT_CENTS = 50_000
const PHOTO_MAX_EDGE = 1600

/**
 * Re-encode a camera / gallery image as a JPEG, at most 1600 px on its long
 * edge. Storage accepts JPEG/PNG/WebP/GIF only and some phones hand over HEIC;
 * a full-size phone photo is also far bigger than a waste record needs.
 */
async function toJpeg(file: File): Promise<Blob> {
  const src = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('That photo could not be read. Take it again, or pick a JPEG or PNG.'))
      el.src = src
    })
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser could not prepare the photo. Try another device.')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) throw new Error('This browser could not prepare the photo. Try another device.')
    return blob
  } finally {
    URL.revokeObjectURL(src)
  }
}

/** Upload a waste photo; returns the JPEG (for the preview) and its public URL. */
async function uploadWastePhoto(file: File): Promise<{ blob: Blob; url: string }> {
  const blob = await toJpeg(file)
  const filename = `waste-${Date.now()}.jpg`
  const { uploadUrl, publicUrl } = await api.get<{ uploadUrl: string; publicUrl: string }>(
    `/media/upload-url?filename=${encodeURIComponent(filename)}&contentType=image/jpeg&category=waste`,
  )
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => null)
  if (!put || !put.ok) throw new Error('The photo did not upload. Check the connection and try again.')
  return { blob, url: publicUrl }
}

function downloadStockCsv(items: InventoryItem[]) {
  const rows = [
    ['Name', 'Category', 'Current Stock', 'Unit', 'Par Level', 'Status'],
    ...items.map((i) => [
      i.name,
      categoryLabel(i.category),
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
  a.download = `inventory-${todayPktIso()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function InventoryPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('stock')
  // The bell's use-by notice links to /inventory?tab=expiring[&locationId=] (owner B6, 2026-10-26).
  const [expiringSite, setExpiringSite] = useState<string | undefined>(undefined)
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      if (sp.get('tab') === 'expiring') { setTab('expiring'); setExpiringSite(sp.get('locationId') ?? undefined) }
    } catch { /* no window */ }
  }, [])
  const [showAdd, setShowAdd] = useState(false)
  // A panel's Save was pressed once: show what is missing next to each field.
  const [tried, setTried] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', unit: 'kg', parLevel: '', category: '', notes: '', tenantId: '' })
  const { data: tenants = [] } = useMyTenants()
  const viewAll = useViewAllTenants()

  // Company for a new item: the ACTIVE company (the API binds it) unless the
  // operator is in "All companies" view, where they must pick one. Defaulting
  // to the first membership used to file items under the wrong company.
  const needsCompanyPick = viewAll && tenants.length > 1
  const [wasteItemId, setWasteItemId] = useState<string | null>(null)
  const [wasteForm, setWasteForm] = useState({ quantity: '', unit: 'kg', reason: 'spoilage' as typeof WASTE_REASONS[number], notes: '', conceptId: '', locationId: '' })
  // Edit panel (category, opening cost, par, issue on receipt) and the
  // "assign a company" panel for a company-less item.
  const [editItemId, setEditItemId] = useState<string | null>(null)
  // Stock item history (owner, 2026-10-27): every stock movement of one item.
  const [historyItemId, setHistoryItemId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ category: '', costPkr: '', parLevel: '', issueOnReceipt: false, purchaseUnit: '', purchaseUnitFactor: '', countFrequency: 'weekly', perishable: false, shelfLifeDays: '' })
  const [assignItemId, setAssignItemId] = useState<string | null>(null)
  const [assignForm, setAssignForm] = useState({ tenantId: '', costPkr: '' })
  const me = useAuthStore((s) => s.user)
  const managerRoles = useManagerRoles()
  const { data: perms } = usePermissions()
  const canOpen = (path: string) => !!perms && canOpenPath(path, perms.role, perms.modules ?? [])
  // The uploaded photo: its public URL (sent as photoUrl) and a local preview.
  const [wastePhoto, setWastePhoto] = useState<{ url: string; previewUrl: string } | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)

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

  // A line cook reads stock and logs waste, but adds no items and sees no cost.
  const kitchenView = useKitchenView(items)
  // Waste and count buttons only for the roles the API lets do them.
  const { canWaste, canCount } = useStockActions()

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

  // The waste drawer's brand and outlet pickers (and the names in the log).
  // Both lists are the operator's own companies'; the drawer narrows them to
  // the wasted item's company.
  const { data: brands = [] } = useQuery<BrandLite[]>({
    queryKey: ['concepts-picker'],
    queryFn: () => api.get('/concepts?view=picker'),
    enabled: !!wasteItemId || tab === 'waste',
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const { data: outlets = [] } = useQuery<OutletLite[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/locations'),
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  // Sold with nothing on the books at an outlet, not yet settled by a delivery (stock by site, 2026-10-24).
  const { data: negative } = useQuery<{ items: Array<{ inventoryItemId: string; name: string | null; unit: string | null; locationName: string | null; shortQty: number; saleLines: number }> }>({
    queryKey: ['inventory-negative'],
    queryFn: () => api.get('/inventory/negative'),
    retry: false, meta: { background: true },
  })
  const siteName = (id: string) => outlets.find((o) => o.id === id)?.name ?? 'Outlet'

  const addMutation = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name,
      unit: addForm.unit,
      parLevel: Number(addForm.parLevel),
      category: addForm.category || null,
      notes: addForm.notes || undefined,
      ...(needsCompanyPick && addForm.tenantId ? { tenantId: addForm.tenantId } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowAdd(false)
      setAddForm({ name: '', unit: 'kg', parLevel: '', category: '', notes: '', tenantId: '' })
    },
  })

  // PATCH /inventory/:id — category (moves the item's stock value to the right
  // account when the cost class changes), the opening cost of an item with no
  // deliveries (422 COST_FROM_DELIVERIES otherwise), par, issue on receipt.
  const editItem = editItemId ? items.find((i) => i.id === editItemId) ?? null : null
  const historyItem = historyItemId ? items.find((i) => i.id === historyItemId) ?? null : null
  useEffect(() => { if (historyItemId) document.getElementById('stock-history')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [historyItemId])
  const editMutation = useMutation({
    mutationFn: (item: InventoryItem) => {
      const body: Record<string, unknown> = {}
      const cat = editForm.category
      if (cat && cat !== categoryValueOf(item.category)) body['category'] = cat
      if (item.costSource !== 'deliveries' && editForm.costPkr.trim() !== '') {
        const cents = Math.round(Number(editForm.costPkr) * 100)
        if (cents !== item.unitCostCents) body['unitCostCents'] = cents
      }
      if (editForm.parLevel.trim() !== '' && Number(editForm.parLevel) !== item.parLevel) body['parLevel'] = Number(editForm.parLevel)
      if (editForm.issueOnReceipt !== !!item.issueOnReceipt) body['issueOnReceipt'] = editForm.issueOnReceipt
      const pu = editForm.purchaseUnit.trim()
      if (pu !== (item.purchaseUnit ?? '')) body['purchaseUnit'] = pu || null
      const pf = Number(editForm.purchaseUnitFactor)
      if (editForm.purchaseUnitFactor.trim() !== '' && pf > 0 && pf !== (item.purchaseUnitFactor ?? 1)) body['purchaseUnitFactor'] = pf
      if (editForm.countFrequency !== (item.countFrequency ?? 'weekly')) body['countFrequency'] = editForm.countFrequency
      // Use-by: only an item with no servd ingredient keeps its own (a linked one takes the master's).
      if (!item.masterIngredientId) {
        const shelf = editForm.perishable && Number(editForm.shelfLifeDays) >= 1 ? Math.round(Number(editForm.shelfLifeDays)) : null
        if (editForm.perishable !== !!item.perishable) body['perishable'] = editForm.perishable
        if (shelf !== (item.shelfLifeDays ?? null)) body['shelfLifeDays'] = shelf
      }
      return Object.keys(body).length === 0 ? Promise.resolve(null) : api.patch(`/inventory/${item.id}`, body)
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['inventory'] }); setEditItemId(null) },
  })

  // Give a company-less item its company. An item that holds stock gets an
  // OPENING count in that company at the unit cost typed here (finance, CEO or
  // management; the server refuses anyone else: 403 OPENING_COUNT_ROLE).
  const assignItem = assignItemId ? items.find((i) => i.id === assignItemId) ?? null : null
  const assignMutation = useMutation({
    mutationFn: (item: InventoryItem) => api.patch<{ openingCount?: { id: string; ledger: { posted: boolean; reason?: string; error?: string } } }>(`/inventory/${item.id}`, {
      tenantId: assignForm.tenantId,
      ...(assignForm.costPkr.trim() !== '' ? { unitCostCents: Math.round(Number(assignForm.costPkr) * 100) } : {}),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      setAssignItemId(null)
      if (r?.openingCount) {
        showToast(r.openingCount.ledger.posted
          ? 'Company assigned. Its stock was booked as an opening count.'
          : `Company assigned and the opening count saved, but its books entry did not post: ${r.openingCount.ledger.reason ?? r.openingCount.ledger.error ?? 'the ledger refused it'}`)
      } else showToast('Company assigned.')
    },
  })

  const wasteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/inventory/${id}/waste`, {
      quantity: Number(wasteForm.quantity),
      unit: wasteForm.unit,
      reason: wasteForm.reason,
      notes: wasteForm.notes || undefined,
      // Charged to a brand, or (left empty) split by each brand's recipe use.
      conceptId: wasteForm.conceptId || null,
      locationId: wasteForm.locationId || null,
      ...(wastePhoto ? { photoUrl: wastePhoto.url } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['inventory', 'waste-logs'] })
      closeWaste()
    },
  })

  function clearPhoto() {
    if (wastePhoto) URL.revokeObjectURL(wastePhoto.previewUrl)
    setWastePhoto(null)
    setPhotoError(null)
  }

  function openWaste(item: InventoryItem) {
    clearPhoto()
    wasteMutation.reset()
    setTried(false)
    setWasteItemId(item.id)
    setWasteForm({ quantity: '', unit: item.unit, reason: 'spoilage', notes: '', conceptId: '', locationId: '' })
  }

  function openEdit(item: InventoryItem) {
    editMutation.reset()
    setTried(false)
    setAssignItemId(null)
    setEditItemId(item.id)
    setEditForm({
      category: categoryValueOf(item.category),
      costPkr: item.unitCostCents != null ? String(item.unitCostCents / 100) : '',
      parLevel: String(item.parLevel),
      issueOnReceipt: !!item.issueOnReceipt,
      purchaseUnit: item.purchaseUnit ?? '',
      purchaseUnitFactor: String(item.purchaseUnitFactor ?? 1),
      countFrequency: item.countFrequency ?? 'weekly',
      perishable: !!item.perishable, shelfLifeDays: item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
    })
  }
  function openAssign(item: InventoryItem) {
    assignMutation.reset()
    setTried(false)
    setEditItemId(null)
    setAssignItemId(item.id)
    setAssignForm({ tenantId: tenants.length === 1 ? tenants[0]!.id : '', costPkr: item.unitCostCents != null ? String(item.unitCostCents / 100) : '' })
  }

  function closeWaste() {
    clearPhoto()
    setWasteItemId(null)
    setWasteForm({ quantity: '', unit: 'kg', reason: 'spoilage', notes: '', conceptId: '', locationId: '' })
  }

  async function onPhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      const { blob, url } = await uploadWastePhoto(file)
      if (wastePhoto) URL.revokeObjectURL(wastePhoto.previewUrl)
      setWastePhoto({ url, previewUrl: URL.createObjectURL(blob) })
      // A PHOTO_REQUIRED refusal is answered now — clear it.
      wasteMutation.reset()
    } catch (err) {
      setPhotoError((err as Error).message || 'The photo did not upload. Try again.')
    } finally {
      setPhotoBusy(false)
    }
  }

  // The server's refusal for want of a photo is shown at the photo field
  // (its message carries the value and the limit); anything else under the form.
  const wasteError = wasteMutation.error as Error | null
  const photoRequiredMsg = wasteError instanceof ApiError && wasteError.code === 'PHOTO_REQUIRED' ? wasteError.message : null
  const wasteItem = items.find((i) => i.id === wasteItemId) ?? null
  // Only the wasted item's own company's brands and outlets are offered.
  const wasteBrands = brands.filter((b) => !wasteItem?.tenantId || b.tenantId === wasteItem.tenantId)
  const wasteOutlets = outlets.filter((o) => o.isActive !== false && (!wasteItem?.tenantId || !o.tenantId || o.tenantId === wasteItem.tenantId))
  const brandName = (id?: string | null) => (id ? brands.find((b) => b.id === id)?.name ?? null : null)
  const outletName = (id?: string | null) => (id ? outlets.find((o) => o.id === id)?.name ?? null : null)
  const wasteQty = Number(wasteForm.quantity)
  const wasteValueCents = wasteItem?.unitCostCents && wasteQty > 0 ? Math.round(wasteItem.unitCostCents * wasteQty) : null
  const photoLikelyNeeded = wasteValueCents != null && wasteValueCents >= DEFAULT_PHOTO_LIMIT_CENTS

  // Only items you actually track as stock belong on the Inventory page —
  // i.e. anything with stock on hand or a par level set. This keeps the shared
  // Sourcing Master Sheet catalog (loaded at 0 stock / 0 par) off this page;
  // an item joins Inventory once you give it a par level or log stock.
  const tracked = items.filter((i) => i.currentStock > 0 || i.parLevel > 0)

  const grouped: Record<string, InventoryItem[]> = {}
  for (const item of tracked) {
    const cat = categoryLabel(item.category)
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat]!.push(item)
  }

  // Below-par only counts items that actually have a par level.
  const isBelowPar = (i: InventoryItem) => i.parLevel > 0 && i.currentStock <= i.parLevel
  const alertCount = tracked.filter(isBelowPar).length
  const totalWasteCost = wasteLogs.reduce((s, w) => s + (w.estimatedCostCents ?? 0), 0)

  return (
    <div className="min-h-screen bg-s-bg">
      {/* Toast */}
      {toast && (
        <div role="status" className="fixed top-4 right-4 z-50 rounded-xl border border-s-border bg-s-surface px-4 py-3 text-sm text-s-text shadow-xl">
          {toast}
        </div>
      )}

      <header className="border-b border-s-border px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Inventory</h1>
          <p className="text-sm text-s-muted">
            {tracked.length} items tracked{alertCount > 0 ? ` · ` : ''}
            {alertCount > 0 && <span className="text-s-red font-semibold">{alertCount} low stock alert{alertCount !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canCount && (
            <Link href="/inventory/count"
              className="rounded-xl border border-s-border text-s-text font-bold px-4 py-2 text-sm hover:border-primary hover:text-primary-ink">
              Stock count
            </Link>
          )}
          {!kitchenView && canOpen('/procurement') && (
            <Link href="/procurement?new=po"
              className="rounded-xl border border-s-border text-s-text font-bold px-4 py-2 text-sm hover:border-primary hover:text-primary-ink">
              Purchase order
            </Link>
          )}
          {!kitchenView && (
            <button onClick={() => { setTried(false); setShowAdd(true) }}
              className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
              + Add item
            </button>
          )}
        </div>
      </header>

      {alertCount > 0 && (
        <div className="mx-6 mt-4 rounded-xl border border-s-red/40 bg-red-100/15 px-4 py-3 flex items-center gap-3 cursor-pointer"
          onClick={() => setTab('alerts')}>
          <span className="s-badge-red shrink-0">Low</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-s-red">
              {alertCount} item{alertCount !== 1 ? 's' : ''} below par level
            </p>
            <p className="text-xs text-s-red/70 mt-0.5">
              {tracked.filter(isBelowPar).map(i => i.name).slice(0, 4).join(', ')}
              {alertCount > 4 ? ` +${alertCount - 4} more` : ''}
            </p>
          </div>
          <span className="text-xs text-s-red/60 shrink-0">View alerts</span>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-89px)]">
        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 border-b border-s-border pb-0">
          {([
            { key: 'stock', label: 'All stock' },
            { key: 'alerts', label: alertCount > 0 ? `Alerts (${alertCount})` : 'Alerts' },
            { key: 'waste', label: 'Waste log' },
            { key: 'expiring', label: 'Use-by' },
          ] as { key: Tab; label: string }[]).map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                ${tab === t.key ? 'border-accent text-primary-ink bg-s-surface' : 'border-transparent text-s-muted hover:text-s-text'}`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Add form */}
          {showAdd && !kitchenView && (
            <form noValidate className="rounded-xl border border-primary bg-s-surface p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                setTried(true)
                if (!addForm.name.trim() || addForm.parLevel === '' || (needsCompanyPick && !addForm.tenantId) || addMutation.isPending) return
                addMutation.mutate()
              }}>
              <p className="font-bold text-s-text text-sm">Add inventory item</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <F label="Item name" required error={tried && !addForm.name.trim() ? 'Enter the item name.' : null}>
                  <input required enterKeyHint="next" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="Chicken breast" className={fi} autoFocus />
                </F>
                <F label="Unit">
                  <Select value={addForm.unit} onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })} className={fi}>
                    {['kg', 'g', 'L', 'ml', 'pcs', 'box', 'bag', 'bottle'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </Select>
                </F>
                <F label="Par level" required error={tried && addForm.parLevel === '' ? 'Enter a par level (0 or more).' : null}>
                  <NumberField decimals={3} min={0} enterKeyHint="next" value={numOf(addForm.parLevel)}
                    onValueChange={(v) => setAddForm({ ...addForm, parLevel: textOf(v) })}
                    placeholder="5" className={fi} />
                </F>
                <F label="Category">
                  <Select value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })} className={fi}>
                    <option value="">— pick a category —</option>
                    {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{categoryOptionText(o)}</option>)}
                  </Select>
                </F>
                <F label="Notes (optional)">
                  <input enterKeyHint="done" value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                    placeholder="Brand, cut, pack size…" className={fi} />
                </F>
              </div>
              {/* Tenant picker — hidden when the operator has one tenant
                  (auto-defaults). In portfolio view it's required and
                  prompts "— pick a company —". */}
              <p className="text-xs text-s-muted">
                The category decides which stock account the item&rsquo;s value sits in: Drinks in 1220, Packaging in 1230, everything else in 1210.
                New items start at zero on hand — record opening stock with an{' '}
                <Link href="/inventory/count" className="text-primary-ink hover:underline">opening count</Link>.
              </p>
              {needsCompanyPick && (
                <TenantField value={addForm.tenantId} autoDefault={false}
                  onChange={(id) => setAddForm({ ...addForm, tenantId: id })}
                  required={!addForm.tenantId} />
              )}
              {tried && needsCompanyPick && !addForm.tenantId && <p role="alert" className="text-xs text-s-red">Pick the company this item belongs to.</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={addMutation.isPending}
                  className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {addMutation.isPending ? 'Adding…' : 'Add item'}
                </button>
                <button type="button" onClick={() => setShowAdd(false)}
                  className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {addMutation.isError && <p role="alert" className="text-xs text-s-red">{(addMutation.error as Error).message}</p>}
            </form>
          )}

          {historyItem && (
            <section id="stock-history" aria-label={`History of ${historyItem.name}`}
              className="rounded-xl border border-primary bg-s-surface p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-s-text text-sm">History — {historyItem.name}</p>
                  <p className="text-xs text-s-muted">Every delivery, sale (by plate recipe), prep, count, waste and transfer. On hand now: {historyItem.currentStock} {historyItem.unit}.</p>
                </div>
                <button type="button" onClick={() => setHistoryItemId(null)} className="rounded-xl border border-s-border text-s-muted px-3 py-1.5 text-xs">Close</button>
              </div>
              <ItemStockHistory itemId={historyItem.id} />
            </section>
          )}

          {/* Edit item: category, opening cost, par, issue on receipt */}
          {editItem && !kitchenView && (
            <form noValidate className="rounded-xl border border-primary bg-s-surface p-4 space-y-3"
              onSubmit={(e) => { e.preventDefault(); if (!editMutation.isPending) editMutation.mutate(editItem) }}>
              <p className="font-bold text-s-text text-sm">Edit — {editItem.name}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <F label="Category">
                  <Select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} className={fi}>
                    <option value="">— none —</option>
                    {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{categoryOptionText(o)}</option>)}
                  </Select>
                </F>
                <F label={editItem.costSource === 'deliveries' ? 'Cost (price actually paid)' : 'Opening cost (PKR per unit)'}>
                  {editItem.costSource === 'deliveries' ? (
                    <p className="rounded-lg border border-s-border bg-s-elevated px-3 py-2 text-sm text-s-text">
                      {editItem.unitCostCents != null ? `PKR ${(editItem.unitCostCents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })} per ${editItem.unit}` : '—'}
                    </p>
                  ) : (
                    <MoneyInput value={centsOf(editForm.costPkr)} onChange={(c) => setEditForm({ ...editForm, costPkr: pkrOf(c) })}
                      placeholder="1.5" className={fi} />
                  )}
                </F>
                <F label="Par level">
                  <NumberField decimals={3} min={0} value={numOf(editForm.parLevel)}
                    onValueChange={(v) => setEditForm({ ...editForm, parLevel: textOf(v) })} className={fi} />
                </F>
                <F label="Bought in (purchase unit)">
                  <input value={editForm.purchaseUnit} onChange={(e) => setEditForm({ ...editForm, purchaseUnit: e.target.value })}
                    placeholder="case" maxLength={30} className={fi} />
                </F>
                <F label={`${editItem.unit} per ${editForm.purchaseUnit.trim() || 'purchase unit'}`}>
                  <NumberField decimals={3} min={0} value={numOf(editForm.purchaseUnitFactor)}
                    onValueChange={(v) => setEditForm({ ...editForm, purchaseUnitFactor: textOf(v) })} className={fi} />
                </F>
                <F label="Count">
                  <Select value={editForm.countFrequency} onChange={(e) => setEditForm({ ...editForm, countFrequency: e.target.value })} className={fi}>
                    <option value="weekly">Weekly (Mondays)</option>
                    <option value="daily">Daily</option>
                  </Select>
                </F>
              </div>
              <p className="text-xs text-s-muted">
                {editItem.costSource === 'deliveries'
                  ? 'This item has stock or deliveries, so its cost is the price actually paid. It changes when stock is received, not by typing a number.'
                  : 'No delivery yet: this cost is only an estimate. The first delivery replaces it with the price paid.'}
                {' '}Changing the category to or from Drinks or Packaging moves the item&rsquo;s stock value to the right account.
              </p>
              {editItem.masterIngredientId ? (
                <p className="text-xs text-s-muted">
                  {editItem.perishable ? `Perishable${editItem.shelfLifeDays ? ` (shelf life ${editItem.shelfLifeDays} days)` : ''}: deliveries carry a use-by date.` : 'Not perishable.'}
                  {' '}Set on <Link href="/kitchen/ingredients" className="text-primary-ink underline">Operations → Ingredients</Link> (servd&rsquo;s ingredient).
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex items-center gap-2 text-sm text-s-text cursor-pointer">
                    <input type="checkbox" className="accent-accent" checked={editForm.perishable}
                      onChange={(e) => setEditForm({ ...editForm, perishable: e.target.checked })} />
                    Perishable — deliveries carry a use-by date
                  </label>
                  <F label="Shelf life (days, optional)">
                    <NumberField decimals={0} min={1} value={numOf(editForm.shelfLifeDays)} disabled={!editForm.perishable}
                      onValueChange={(v) => setEditForm({ ...editForm, shelfLifeDays: textOf(v) })} className={fi} />
                  </F>
                </div>
              )}
              {managerRoles.has(me?.role ?? '') && (
                <label className="flex items-start gap-2 text-sm text-s-text cursor-pointer">
                  <input type="checkbox" className="accent-accent mt-0.5" checked={editForm.issueOnReceipt}
                    onChange={(e) => setEditForm({ ...editForm, issueOnReceipt: e.target.checked })} />
                  <span>
                    <span className="font-semibold">Issue on receipt</span>
                    <span className="block text-xs text-s-muted">For oil, salt and other items no recipe measures: each delivery goes straight to cost of sales instead of sitting in stock.</span>
                  </span>
                </label>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={editMutation.isPending}
                  className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {editMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditItemId(null)} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {editMutation.isError && <p role="alert" className="text-xs text-s-red">{stockErrorText(editMutation.error)}</p>}
            </form>
          )}

          {/* Assign a company to a company-less item */}
          {assignItem && !kitchenView && (
            <form noValidate className="rounded-xl border border-primary bg-s-surface p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                setTried(true)
                if (assignMutation.isPending || !assignForm.tenantId || (assignItem.currentStock > 0 && assignForm.costPkr.trim() === '')) return
                assignMutation.mutate(assignItem)
              }}>
              <p className="font-bold text-s-text text-sm">Assign a company — {assignItem.name}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <F label="Company" required error={tried && !assignForm.tenantId ? 'Pick a company.' : null}>
                  <Select value={assignForm.tenantId} onChange={(e) => setAssignForm({ ...assignForm, tenantId: e.target.value })} className={fi}>
                    <option value="">— pick a company —</option>
                    {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </F>
                {assignItem.currentStock > 0 && (
                  <F label={`Opening unit cost (PKR per ${assignItem.unit})`} required
                    error={tried && assignForm.costPkr.trim() === '' ? 'Enter the cost per unit — the stock is booked at it.' : null}>
                    <MoneyInput value={centsOf(assignForm.costPkr)} onChange={(c) => setAssignForm({ ...assignForm, costPkr: pkrOf(c) })}
                      placeholder="1.5" className={fi} />
                  </F>
                )}
              </div>
              <p className="text-xs text-s-muted">
                {assignItem.currentStock > 0
                  ? `${assignItem.name} holds ${assignItem.currentStock} ${assignItem.unit} with no company. Giving it a company books that stock as an opening count to the owner’s capital, at this unit cost. Only finance, the CEO or management can do this.`
                  : 'An item needs a company before it can be counted, wasted, received or costed. This cannot be changed afterwards.'}
              </p>
              <div className="flex gap-2">
                <button type="submit" disabled={assignMutation.isPending}
                  className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {assignMutation.isPending ? 'Assigning…' : 'Assign company'}
                </button>
                <button type="button" onClick={() => setAssignItemId(null)} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {assignMutation.isError && <p role="alert" className="text-xs text-s-red">{stockErrorText(assignMutation.error)}</p>}
            </form>
          )}

          {/* Log Waste inline form */}
          {wasteItemId && canWaste && (
            <form noValidate className="rounded-xl border border-s-red/50 bg-red-100/10 p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                setTried(true)
                if (!(wasteQty > 0) || wasteMutation.isPending || photoBusy) return
                wasteMutation.mutate(wasteItemId)
              }}>
              <p className="font-bold text-s-red text-sm">
                Log waste — {wasteItem?.name}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <F label="Quantity" required error={tried && !(wasteQty > 0) ? 'Enter how much was wasted (more than 0).' : null}>
                  <NumberField decimals={3} min={0} enterKeyHint="next" value={numOf(wasteForm.quantity)}
                    onValueChange={(v) => setWasteForm({ ...wasteForm, quantity: textOf(v) })}
                    placeholder="2.5" className={fi} autoFocus />
                </F>
                <F label="Unit">
                  {/* Stock is kept in the item's own unit; waste is logged in it too. */}
                  <input value={wasteForm.unit} readOnly className={fi + ' opacity-70'} />
                </F>
                <F label="Reason">
                  <Select value={wasteForm.reason} onChange={(e) => setWasteForm({ ...wasteForm, reason: e.target.value as typeof WASTE_REASONS[number] })} className={fi}>
                    {WASTE_REASONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                  </Select>
                </F>
                <F label="Notes (optional)">
                  <input enterKeyHint="done" value={wasteForm.notes} onChange={(e) => setWasteForm({ ...wasteForm, notes: e.target.value })}
                    placeholder="Describe waste…" className={fi} />
                </F>
              </div>

              {/* Whose waste is it? A brand of the item's own company, and the
                  outlet it happened at. Left empty, the cost is split across
                  the brands by how much each uses the item. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <F label="Brand (optional)">
                  <Select value={wasteForm.conceptId} onChange={(e) => setWasteForm({ ...wasteForm, conceptId: e.target.value })} className={fi}>
                    <option value="">Not sure — split by recipe use</option>
                    {wasteBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                </F>
                <F label="Outlet (optional)">
                  <Select value={wasteForm.locationId} onChange={(e) => setWasteForm({ ...wasteForm, locationId: e.target.value })} className={fi}>
                    <option value="">No particular outlet</option>
                    {wasteOutlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </Select>
                </F>
              </div>

              {/* Value at the item's current cost — the same figure the server
                  books — so staff know before they press Log. */}
              {wasteValueCents != null && (
                <p className="text-xs text-s-muted">
                  Worth about <span className="font-semibold text-s-text">PKR {Math.round(wasteValueCents / 100).toLocaleString()}</span> at current cost.
                </p>
              )}

              {/* Photo — required above the company's photo limit. */}
              <div className={`rounded-lg border p-3 space-y-2 ${photoRequiredMsg ? 'border-s-red bg-red-100/15' : 'border-s-border'}`}>
                <div className="flex items-center gap-3 flex-wrap">
                  <label className={`cursor-pointer rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                    photoRequiredMsg ? 'border-s-red text-s-red' : 'border-s-border text-s-text hover:border-primary hover:text-primary-ink'
                  } ${photoBusy ? 'pointer-events-none opacity-50' : ''}`}>
                    {photoBusy ? 'Uploading photo…' : wastePhoto ? 'Retake photo' : 'Take or add photo'}
                    <input type="file" accept="image/*" capture="environment" className="sr-only"
                      onChange={(e) => void onPhotoPicked(e)} disabled={photoBusy} />
                  </label>
                  {wastePhoto && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
                      <img src={wastePhoto.previewUrl} alt="Waste photo" className="h-14 w-14 rounded-lg border border-s-border object-cover" />
                      <button type="button" onClick={clearPhoto} className="text-xs text-s-muted hover:text-s-text underline">
                        Remove
                      </button>
                    </>
                  )}
                  {!wastePhoto && !photoRequiredMsg && (
                    <span className="text-xs text-s-muted">
                      {photoLikelyNeeded ? 'Waste this size needs a photo.' : 'Needed for larger waste (PKR 500+ by default).'}
                    </span>
                  )}
                </div>
                {photoRequiredMsg && !wastePhoto && <p className="text-xs font-semibold text-s-red">{photoRequiredMsg}</p>}
                {photoError && <p className="text-xs text-s-red">{photoError}</p>}
              </div>

              <div className="flex gap-2">
                <button type="submit" disabled={wasteMutation.isPending || photoBusy}
                  className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {wasteMutation.isPending ? 'Logging…' : 'Log waste & deduct stock'}
                </button>
                <button type="button" onClick={closeWaste}
                  className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {wasteError && !photoRequiredMsg && <p role="alert" className="text-xs text-s-red">{stockErrorText(wasteError)}</p>}
            </form>
          )}

          {/* ════ ALL STOCK ════ */}
          {tab === 'stock' && (
            isLoading ? <p className="text-s-muted text-sm">Loading…</p> :
            Object.keys(grouped).length === 0 ? (
              kitchenView ? (
                <div className="text-center py-16 text-s-muted">
                  <p className="font-semibold text-s-text">No stock tracked yet</p>
                  <p className="text-sm mt-1">Your manager adds the ingredients; they appear here once they have a par level or stock on hand.</p>
                </div>
              ) : <CompactEmptyState
                message="No stock tracked yet. Add the ingredients you cook with."
                action={{ label: 'Add your first ingredient', onClick: () => setShowAdd(true) }}
              />
            ) : (
              <>
                {/* Stock on hand changes only through a count, a waste log or a
                    delivery (owner decision 28) — there is no +/- or "set to". */}
                <div className="flex items-center gap-3 flex-wrap">
                  {canCount && (
                    <Link href="/inventory/count"
                      className="text-sm rounded-xl border border-s-border px-4 py-2 text-s-muted hover:border-primary hover:text-primary-ink transition-colors font-semibold">
                      Count stock
                    </Link>
                  )}
                  <button
                    onClick={() => downloadStockCsv(items)}
                    className="text-sm rounded-xl border border-s-border px-4 py-2 text-s-muted hover:border-primary hover:text-primary-ink transition-colors font-semibold">
                    Export CSV
                  </button>
                  <span className="text-xs text-s-muted">Stock changes come from counts, waste logs and deliveries.</span>
                </div>

                {negative && negative.items.length > 0 && (
                  <div className="rounded-xl px-4 py-3 text-sm"
                    style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 25%, transparent)' }}>
                    <p className="font-semibold">Sold with nothing on hand — not yet covered by a delivery</p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {negative.items.map((n) => (
                        <li key={`${n.inventoryItemId}|${n.locationName ?? ''}`}>
                          {n.name ?? 'An item'}{n.locationName ? ` at ${n.locationName}` : ''}: short {n.shortQty} {n.unit ?? ''} ({n.saleLines} sale line{n.saleLines === 1 ? '' : 's'})
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs opacity-80">Receive the delivery, move stock from another outlet, or count it in.</p>
                  </div>
                )}

                {Object.entries(grouped).map(([cat, catItems]) => (
                  <div key={cat}>
                    <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">{cat}</p>
                    <div className="rounded-xl border border-s-border overflow-hidden">
                      {catItems.map((item) => {
                        const isLow = item.currentStock <= item.parLevel
                        return (
                          <div key={item.id}
                            className={`border-b border-s-border/50 last:border-0 transition-colors ${isLow ? 'bg-red-100/5' : ''}`}>
                            <div className="flex items-center justify-between gap-2 px-4 py-3 flex-wrap">
                              <div className="flex items-center gap-3 min-w-0 flex-wrap">
                                <span className={`text-sm font-semibold ${isLow ? 'text-s-red' : 'text-s-text'}`}>
                                  {item.name}
                                </span>
                                {isLow && <span className="text-xs font-bold text-s-red bg-red-100/30 px-2 py-0.5 rounded-full">Low stock</span>}
                                {/* Brand chip in portfolio view — every item
                                    belongs to one company. Orphan rows always
                                    show "⚠ No company". */}
                                <TenantChip tenant={item.tenant} tenantId={item.tenantId} tenants={tenants} />
                                {item.issueOnReceipt && <span className="s-badge-muted" title="Each delivery goes straight to cost of sales">Issued on receipt</span>}
                                {item.kind === 'prep' && <span className="s-badge-purple" title="Made in house by prep batches">Prep</span>}
                                {(item.bySite ?? []).filter((b) => b.qty !== 0).length > 1 && (
                                  <span className="text-xs text-s-muted">
                                    {(item.bySite ?? []).filter((b) => b.qty !== 0).map((b) => `${siteName(b.locationId)} ${b.qty}`).join(' · ')}
                                  </span>
                                )}
                                {item.onHandValueCents != null && item.onHandValueCents > 0 && (
                                  <span className="text-xs text-s-muted">worth PKR {Math.round(item.onHandValueCents / 100).toLocaleString('en-PK')}</span>
                                )}
                              </div>

                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`font-black text-lg w-14 text-center ${isLow ? 'text-s-red' : 'text-s-text'}`}>
                                  {item.currentStock}
                                </span>
                                <span className="text-xs text-s-muted w-16">{item.unit} · par {item.parLevel}</span>
                                {canCount && (
                                  <Link href={`/inventory/count?item=${item.id}`}
                                    className="text-xs px-2 py-1 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink transition-colors">
                                    count
                                  </Link>
                                )}
                                {/* Company-less legacy rows cannot be wasted
                                    until a manager assigns them a company. */}
                                {canWaste && item.tenantId && (
                                  <button onClick={() => openWaste(item)}
                                    className="text-xs px-2 py-1 rounded-lg border border-s-red/30 text-s-red/70 hover:border-s-red hover:text-s-red transition-colors">
                                    waste
                                  </button>
                                )}
                                {item.tenantId && (
                                  <button onClick={() => setHistoryItemId(item.id)}
                                    className="text-xs px-2 py-1 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink transition-colors">
                                    history
                                  </button>
                                )}
                                {!kitchenView && item.tenantId && (
                                  <button onClick={() => openEdit(item)}
                                    className="text-xs px-2 py-1 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink transition-colors">
                                    edit
                                  </button>
                                )}
                                {!kitchenView && !item.tenantId && (
                                  <button onClick={() => openAssign(item)}
                                    className="text-xs px-2 py-1 rounded-lg border border-primary/40 text-primary-ink hover:bg-primary/10 transition-colors">
                                    Assign a company
                                  </button>
                                )}
                              </div>
                            </div>
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
              <div className="text-center py-16 text-s-muted">
                <p className="font-semibold text-success">All stocked up</p>
                <p className="text-sm mt-1">No items are below par level</p>
              </div>
            ) : (
              <div className="rounded-xl border border-s-red/30 overflow-hidden">
                <div className="px-4 py-3 bg-red-100/10 border-b border-s-red/30 flex items-center justify-between">
                  <p className="font-bold text-s-red text-sm">{alerts.length} item{alerts.length !== 1 ? 's' : ''} below par level</p>
                  <p className="text-xs text-s-muted">Suggested order quantities to reach par</p>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-s-surface border-b border-s-red/20">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs text-s-muted font-semibold">Item</th>
                      <th className="px-4 py-2.5 text-right text-xs text-s-muted font-semibold">Current</th>
                      <th className="px-4 py-2.5 text-right text-xs text-s-muted font-semibold">Par Level</th>
                      <th className="px-4 py-2.5 text-right text-xs text-s-muted font-semibold">Suggested Order Qty</th>
                      <th className="px-4 py-2.5 text-right text-xs text-s-muted font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((item) => {
                      const suggestedQty = Math.max(0, item.parLevel - item.currentStock)
                      return (
                        <tr key={item.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-elevated/40">
                          <td className="px-4 py-3">
                            <p className="text-sm font-semibold text-s-text">{item.name}</p>
                            <p className="text-xs text-s-muted">{categoryLabel(item.category)}</p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="text-lg font-black text-s-red">
                              {item.currentStock}
                              <span className="text-xs font-normal ml-1">{item.unit}</span>
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-s-muted">
                            {item.parLevel} {item.unit}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="inline-flex items-center gap-1 rounded-full bg-s-amber/10 border border-s-amber/30 px-3 py-1 text-sm font-semibold text-s-amber">
                              Order {suggestedQty} {item.unit}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {/* A new purchase order for this item (Procurement → Purchase Orders). */}
                            {canOpen('/procurement') && (
                              <Link href={`/procurement?new=po&item=${encodeURIComponent(item.id)}&qty=${suggestedQty}`}
                                className="inline-block text-xs px-3 py-1.5 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                                Purchase order
                              </Link>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            )
          )}

          {/* ════ USE-BY (owner B6, 2026-10-26) ════ */}
          {tab === 'expiring' && (
            <ExpiringLots
              outlets={outlets.filter((o) => (o as { isActive?: boolean }).isActive !== false)}
              initialLocationId={expiringSite}
              canWaste={canWaste}
              onWaste={(r: ExpiringRow) => {
                const item = items.find((i) => i.id === r.inventoryItemId)
                if (!item) return
                openWaste(item)
                setWasteForm((f) => ({ ...f, reason: 'expired', locationId: r.locationId ?? '', quantity: String(r.remainingQty) }))
              }}
            />
          )}

          {/* ════ WASTE LOG ════ */}
          {tab === 'waste' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-s-text">Waste & Spoilage Log</p>
                  <p className="text-xs text-s-muted mt-0.5">
                    {wasteLogs.length} entries
                    {!kitchenView && (
                      <>
                        {' '}· estimated cost:{' '}
                        <span className="text-s-red font-semibold">
                          PKR {Math.round(totalWasteCost / 100).toLocaleString()}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                {canWaste && (
                  <button onClick={() => setTab('stock')}
                    className="text-xs rounded-lg bg-s-red/10 border border-s-red/30 text-s-red px-3 py-1.5 font-semibold hover:bg-s-red/20">
                    Log waste
                  </button>
                )}
              </div>

              {wasteLoading ? (
                <p className="text-s-muted text-sm">Loading…</p>
              ) : wasteLogs.length === 0 ? (
                <div className="text-center py-16 text-s-muted">
                  <p className="font-semibold text-s-text">No waste logged</p>
                  {canWaste && <p className="text-sm mt-1">Use the "waste" button on any inventory item to record spoilage</p>}
                </div>
              ) : (
                <div className="rounded-xl border border-s-border overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-s-border bg-s-surface">
                        <th className="text-left px-4 py-2.5 text-xs text-s-muted font-semibold">Item</th>
                        <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Qty</th>
                        <th className="px-4 py-2.5 text-xs text-s-muted font-semibold">Reason</th>
                        {!kitchenView && <th className="text-right px-4 py-2.5 text-xs text-s-muted font-semibold">Est. Cost</th>}
                        <th className="px-4 py-2.5 text-xs text-s-muted font-semibold">Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wasteLogs.map((log) => (
                        <tr key={log.id} className="border-b border-s-border/50 last:border-0 hover:bg-s-elevated/40">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-s-text">{log.inventoryItem.name}</p>
                            {(brandName(log.conceptId) || outletName(log.locationId)) && (
                              <p className="text-xs text-s-muted mt-0.5">
                                {[brandName(log.conceptId), outletName(log.locationId)].filter(Boolean).join(' · ')}
                              </p>
                            )}
                            {log.notes && <p className="text-xs text-s-muted mt-0.5">{log.notes}</p>}
                            {log.photoUrl && (
                              <a href={log.photoUrl} target="_blank" rel="noreferrer"
                                className="text-xs text-primary-ink hover:underline mt-0.5 inline-block">View photo</a>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-s-red">
                            {log.quantity} {log.unit}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-s-red/10 text-s-red capitalize">
                              {log.reason.replace('_', ' ')}
                            </span>
                          </td>
                          {!kitchenView && (
                            <td className="px-4 py-3 text-right text-s-muted">
                              {log.estimatedCostCents != null
                                ? `PKR ${Math.round(log.estimatedCostCents / 100).toLocaleString()}`
                                : '—'}
                            </td>
                          )}
                          <td className="px-4 py-3 text-xs text-s-muted">
                            {new Date(log.recordedAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            {log.recordedBy && <span className="ml-1 opacity-60">· {log.recordedBy.name}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// Label wired to its control (htmlFor / aria-describedby) with an inline error.
function F({ label, required, error, children }: { label: string; required?: boolean; error?: string | null; children: React.ReactElement }) {
  return <FormField label={label} required={required} error={error ?? undefined}>{children}</FormField>
}

// Form state keeps numbers as typed text ('' = empty); the fields want number | null.
const numOf = (t: string): number | null => (t.trim() === '' || !Number.isFinite(Number(t)) ? null : Number(t))
const textOf = (n: number | null): string => (n == null ? '' : String(n))
// A PKR-per-unit string and the cents MoneyInput works in (same unit the API gets: cents).
const centsOf = (pkr: string): number => Math.round((numOf(pkr) ?? 0) * 100)
const pkrOf = (cents: number): string => (cents > 0 ? String(cents / 100) : '')

const fi = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none transition-colors'
