'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../lib/api'
import { EmptyStateGuide } from '../../components/ui/EmptyStateGuide'
import { TenantChip, TenantField, useMyTenants } from '../../components/ui/TenantPicker'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { useKitchenView, useStockActions } from './kitchenView'

interface InventoryItem {
  id: string; name: string; unit: string; currentStock: number; parLevel: number
  unitCostCents: number | null; supplierId: string | null; notes: string | null
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
}

type Tab = 'stock' | 'alerts' | 'waste'

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
  const [addForm, setAddForm] = useState({ name: '', unit: 'kg', parLevel: '', notes: '', tenantId: '' })
  const { data: tenants = [] } = useMyTenants()
  const viewAll = useViewAllTenants()

  // Company for a new item: the ACTIVE company (the API binds it) unless the
  // operator is in "All companies" view, where they must pick one. Defaulting
  // to the first membership used to file items under the wrong company.
  const needsCompanyPick = viewAll && tenants.length > 1
  const [wasteItemId, setWasteItemId] = useState<string | null>(null)
  const [wasteForm, setWasteForm] = useState({ quantity: '', unit: 'kg', reason: 'spoilage' as typeof WASTE_REASONS[number], notes: '' })
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

  const addMutation = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name,
      unit: addForm.unit,
      parLevel: Number(addForm.parLevel),
      notes: addForm.notes || undefined,
      ...(needsCompanyPick && addForm.tenantId ? { tenantId: addForm.tenantId } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowAdd(false)
      setAddForm({ name: '', unit: 'kg', parLevel: '', notes: '', tenantId: '' })
    },
  })

  const wasteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/inventory/${id}/waste`, {
      quantity: Number(wasteForm.quantity),
      unit: wasteForm.unit,
      reason: wasteForm.reason,
      notes: wasteForm.notes || undefined,
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
    setWasteItemId(item.id)
    setWasteForm({ quantity: '', unit: item.unit, reason: 'spoilage', notes: '' })
  }

  function closeWaste() {
    clearPhoto()
    setWasteItemId(null)
    setWasteForm({ quantity: '', unit: 'kg', reason: 'spoilage', notes: '' })
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
    const cat = item.notes ?? 'Uncategorised'
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
        <div className="fixed top-4 right-4 z-50 rounded-xl border border-s-border bg-s-surface px-4 py-3 text-sm text-s-text shadow-xl">
          {toast}
        </div>
      )}

      <header className="border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Inventory</h1>
          <p className="text-sm text-s-muted">
            {tracked.length} items tracked{alertCount > 0 ? ` · ` : ''}
            {alertCount > 0 && <span className="text-s-red font-semibold">{alertCount} low stock alert{alertCount !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCount && (
            <Link href="/inventory/count"
              className="rounded-xl border border-s-border text-s-text font-bold px-4 py-2 text-sm hover:border-primary hover:text-primary-ink">
              Stock count
            </Link>
          )}
          {!kitchenView && (
            <button onClick={() => setShowAdd(true)}
              className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
              + Add item
            </button>
          )}
        </div>
      </header>

      {alertCount > 0 && (
        <div className="mx-6 mt-4 rounded-xl border border-s-red/40 bg-red-100/15 px-4 py-3 flex items-center gap-3 cursor-pointer"
          onClick={() => setTab('alerts')}>
          <span className="text-lg leading-none">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-s-red">
              {alertCount} item{alertCount !== 1 ? 's' : ''} below par level
            </p>
            <p className="text-xs text-s-red/70 mt-0.5">
              {tracked.filter(isBelowPar).map(i => i.name).slice(0, 4).join(', ')}
              {alertCount > 4 ? ` +${alertCount - 4} more` : ''}
            </p>
          </div>
          <span className="text-xs text-s-red/60 shrink-0">View alerts →</span>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-89px)]">
        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 border-b border-s-border pb-0">
          {([
            { key: 'stock', label: 'All stock' },
            { key: 'alerts', label: alertCount > 0 ? `Alerts (${alertCount})` : 'Alerts' },
            { key: 'waste', label: 'Waste log' },
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
            <div className="rounded-xl border border-primary bg-s-surface p-4 space-y-3">
              <p className="font-bold text-s-text text-sm">Add inventory item</p>
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
                <F label="Notes / category (optional)">
                  <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                    placeholder="Proteins, Veg, Dry goods…" className={fi} />
                </F>
              </div>
              {/* Tenant picker — hidden when the operator has one tenant
                  (auto-defaults). In portfolio view it's required and
                  prompts "— pick a company —". */}
              <p className="text-xs text-s-muted">
                New items start at zero on hand. Record the opening stock with a{' '}
                <Link href="/inventory/count" className="text-primary-ink hover:underline">stock count</Link>.
              </p>
              {needsCompanyPick && (
                <TenantField value={addForm.tenantId} autoDefault={false}
                  onChange={(id) => setAddForm({ ...addForm, tenantId: id })}
                  required={!addForm.tenantId} />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (needsCompanyPick && !addForm.tenantId) return
                    addMutation.mutate()
                  }}
                  disabled={!addForm.name || !addForm.parLevel || (needsCompanyPick && !addForm.tenantId) || addMutation.isPending}
                  className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {addMutation.isPending ? 'Adding…' : 'Add item'}
                </button>
                <button onClick={() => setShowAdd(false)}
                  className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {addMutation.isError && <p className="text-xs text-s-red">{(addMutation.error as Error).message}</p>}
            </div>
          )}

          {/* Log Waste inline form */}
          {wasteItemId && canWaste && (
            <div className="rounded-xl border border-s-red/50 bg-red-100/10 p-4 space-y-3">
              <p className="font-bold text-s-red text-sm">
                Log waste — {wasteItem?.name}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <F label="Quantity">
                  <input type="number" step="0.01" value={wasteForm.quantity}
                    onChange={(e) => setWasteForm({ ...wasteForm, quantity: e.target.value })}
                    placeholder="2.5" className={fi} autoFocus />
                </F>
                <F label="Unit">
                  {/* Stock is kept in the item's own unit; waste is logged in it too. */}
                  <input value={wasteForm.unit} readOnly className={fi + ' opacity-70'} />
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
                <button onClick={() => wasteMutation.mutate(wasteItemId)}
                  disabled={!wasteForm.quantity || wasteMutation.isPending || photoBusy}
                  className="rounded-xl bg-s-red text-bone font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {wasteMutation.isPending ? 'Logging…' : 'Log waste & deduct stock'}
                </button>
                <button onClick={closeWaste}
                  className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              </div>
              {wasteError && !photoRequiredMsg && <p className="text-xs text-s-red">{wasteError.message}</p>}
            </div>
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
              ) : <EmptyStateGuide
                icon="📦"
                title="Track what you cook with"
                description="Inventory drives recipe costing, auto-86, demand forecasting, and reorder alerts. Add raw ingredients first — finished menu items get linked via Recipe Costing."
                whyItMatters="When inventory hits zero, the platform auto-disables menu items across POS and storefront. No more 'sorry, we ran out' calls to disappointed customers."
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

                {Object.entries(grouped).map(([cat, catItems]) => (
                  <div key={cat}>
                    <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">{cat}</p>
                    <div className="rounded-xl border border-s-border overflow-hidden">
                      {catItems.map((item) => {
                        const isLow = item.currentStock <= item.parLevel
                        return (
                          <div key={item.id}
                            className={`border-b border-s-border/50 last:border-0 transition-colors ${isLow ? 'bg-red-100/5' : ''}`}>
                            <div className="flex items-center justify-between px-4 py-3">
                              <div className="flex items-center gap-3 min-w-0 flex-wrap">
                                <span className={`text-sm font-semibold ${isLow ? 'text-s-red' : 'text-s-text'}`}>
                                  {item.name}
                                </span>
                                {isLow && <span className="text-xs font-bold text-s-red bg-red-100/30 px-2 py-0.5 rounded-full">Low stock</span>}
                                {/* Brand chip in portfolio view — every item
                                    belongs to one company. Orphan rows always
                                    show "⚠ No company". */}
                                <TenantChip tenant={item.tenant} tenantId={item.tenantId} tenants={tenants} />
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
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
                <p className="text-4xl mb-3">✅</p>
                <p className="font-semibold text-success">All stocked up</p>
                <p className="text-sm mt-1">No items are below par level</p>
              </div>
            ) : (
              <div className="rounded-xl border border-s-red/30 overflow-hidden">
                <div className="px-4 py-3 bg-red-100/10 border-b border-s-red/30 flex items-center justify-between">
                  <p className="font-bold text-s-red text-sm">⚠ {alerts.length} item{alerts.length !== 1 ? 's' : ''} below par level</p>
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
                            <p className="text-xs text-s-muted">{item.notes ?? 'Uncategorised'}</p>
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
                            <button
                              onClick={() => showToast('Purchase order feature coming soon')}
                              className="text-xs px-3 py-1.5 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                              Create PO
                            </button>
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
                    Log waste →
                  </button>
                )}
              </div>

              {wasteLoading ? (
                <p className="text-s-muted text-sm">Loading…</p>
              ) : wasteLogs.length === 0 ? (
                <div className="text-center py-16 text-s-muted">
                  <p className="text-4xl mb-3">✅</p>
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

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-s-muted font-medium">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

const fi = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none transition-colors'
