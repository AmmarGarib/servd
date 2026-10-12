'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { menuApi, api, type Category, type MenuItem } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import Link from 'next/link'
import { EmptyStateGuide } from '../../components/ui/EmptyStateGuide'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { fmtPkrWhole } from '../../lib/money'

interface ConceptTab { id: string; name: string; tenantId?: string | null; tenant?: { id: string; name: string } | null }

// Categories as GET /menu/:conceptId returns them — the shared Category type
// does not carry the storefront time window.
type WindowedCategory = Category & { timeRestrictionStart?: string | null; timeRestrictionEnd?: string | null }

type MenuView = 'items' | 'availability' | 'windows'
const VIEW_LABEL: Record<MenuView, string> = { items: 'Items', availability: 'Availability (86)', windows: 'Time windows' }

export default function MenuPage() {
  const [view, setView] = useState<MenuView>('items')
  const [selectedConceptId, setSelectedConceptId] = useState<string>('')
  const [editItem, setEditItem] = useState<MenuItem | null>(null)
  const [addingItemToCat, setAddingItemToCat] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const qc = useQueryClient()

  const viewAll = useViewAllTenants()
  const { data: tenants = [] } = useMyTenants()
  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<ConceptTab[]>('/concepts'),
  })

  // Derive conceptId — no useEffect needed
  const conceptId = selectedConceptId || concepts[0]?.id || ''

  const { data: categories = [], isLoading } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })

  const toggle86 = useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      menuApi.toggleAvailability(id, isAvailable),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu', conceptId] }),
  })

  const deleteItem = useMutation({
    mutationFn: (id: string) => menuApi.deleteItem(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu', conceptId] }),
  })

  // ── Category edit / delete ─────────────────────────────────────────────
  // Click the category name → inline rename input + Save / Delete buttons.
  // Delete is gated server-side: if the category still has live items the
  // backend returns 409 CATEGORY_NOT_EMPTY and we surface that to the user.
  const [editingCatId, setEditingCatId]   = useState<string | null>(null)
  const [editingCatName, setEditingCatName] = useState('')
  const [catError, setCatError]           = useState<string | null>(null)

  const renameCategory = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      menuApi.updateCategory(id, { name }),
    onSuccess: () => {
      setEditingCatId(null); setCatError(null)
      void qc.invalidateQueries({ queryKey: ['menu', conceptId] })
    },
    onError: (e: Error) => setCatError(e.message ?? 'Rename failed'),
  })
  const removeCategory = useMutation({
    mutationFn: (id: string) => menuApi.deleteCategory(id),
    onSuccess: () => {
      setEditingCatId(null); setCatError(null)
      void qc.invalidateQueries({ queryKey: ['menu', conceptId] })
    },
    onError: (e: Error) => setCatError(e.message ?? 'Delete failed'),
  })

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-1">Menu Editor</h1>
        </div>
        <button
          onClick={() => { setView('items'); setAddingCategory(true) }}
          disabled={!conceptId}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 hover:opacity-90 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add Category
        </button>
      </header>

      {/* Concept tabs — each tab shows its brand-chip in portfolio view so the
          operator can tell which company they're editing the menu for. */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {concepts.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedConceptId(c.id)}
            className={`shrink-0 rounded-lg px-4 py-2 font-semibold text-sm transition-colors flex items-center gap-2 ${
              c.id === conceptId ? 'bg-primary text-primary-on' : 'bg-s-surface text-s-muted hover:text-s-text'
            }`}
          >
            <span>{c.name}</span>
            {viewAll && (
              <TenantChip tenant={c.tenant} tenantId={c.tenantId} tenants={tenants} />
            )}
          </button>
        ))}
        {concepts.length === 0 && <p className="text-s-muted text-sm">Loading concepts…</p>}
      </div>

      {/* Views — the item editor, the quick 86 board and the storefront time
          windows (the last two moved here from the retired Visual Layout page). */}
      <div className="mb-6 flex gap-1 border-b border-s-border">
        {(Object.keys(VIEW_LABEL) as MenuView[]).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              view === v ? 'border-accent text-primary-ink' : 'border-transparent text-s-muted hover:text-s-text'
            }`}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {view === 'availability' && (
        <AvailabilityBoard
          categories={categories}
          loading={isLoading}
          pendingId={toggle86.isPending ? toggle86.variables?.id ?? null : null}
          onToggle={(id, isAvailable) => toggle86.mutate({ id, isAvailable })}
        />
      )}
      {view === 'windows' && (
        <TimeWindows
          categories={categories as WindowedCategory[]}
          loading={isLoading}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['menu', conceptId] })}
        />
      )}

      {view === 'items' && (<>
      {/* Add category form */}
      {addingCategory && (
        <AddCategoryForm
          conceptId={conceptId}
          sortOrder={categories.length}
          onSaved={() => { void qc.invalidateQueries({ queryKey: ['menu', conceptId] }); setAddingCategory(false) }}
          onCancel={() => setAddingCategory(false)}
        />
      )}

      {isLoading && <p className="text-s-muted">Loading menu…</p>}

      {/* Categories + Items */}
      <div className="space-y-8">
        {categories.map((cat) => (
          <section key={cat.id}>
            <div className="flex items-center justify-between mb-3 border-b border-s-border pb-2 gap-3">
              {editingCatId === cat.id ? (
                /* Inline edit mode — rename input + Save/Cancel/Delete row. */
                <div className="flex-1 flex items-center gap-2 flex-wrap">
                  <input
                    autoFocus
                    value={editingCatName}
                    onChange={(e) => setEditingCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editingCatName.trim()) {
                        renameCategory.mutate({ id: cat.id, name: editingCatName.trim() })
                      } else if (e.key === 'Escape') {
                        setEditingCatId(null); setCatError(null)
                      }
                    }}
                    className="rounded-lg bg-s-bg border border-s-border px-3 py-1.5 text-lg font-bold text-s-text focus:border-primary focus:outline-none"
                  />
                  <button
                    onClick={() => editingCatName.trim() && renameCategory.mutate({ id: cat.id, name: editingCatName.trim() })}
                    disabled={!editingCatName.trim() || editingCatName.trim() === cat.name || renameCategory.isPending}
                    className="rounded-lg bg-primary text-primary-on font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-40">
                    {renameCategory.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setEditingCatId(null); setCatError(null) }}
                    className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs hover:text-s-text">
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const itemCount = cat.items.filter((i) => !(i as { deletedAt?: string }).deletedAt).length
                      if (itemCount > 0) {
                        setCatError(`Delete or move the ${itemCount} item${itemCount === 1 ? '' : 's'} in this category first.`)
                        return
                      }
                      if (confirm(`Delete category "${cat.name}"?`)) {
                        removeCategory.mutate(cat.id)
                      }
                    }}
                    disabled={removeCategory.isPending}
                    className="rounded-lg border border-s-red/40 text-s-red px-3 py-1.5 text-xs hover:bg-s-red/10 ml-auto">
                    🗑 Delete category
                  </button>
                  {catError && <p className="basis-full text-xs text-s-red font-semibold">{catError}</p>}
                </div>
              ) : (
                <>
                  <button
                    onClick={() => { setEditingCatId(cat.id); setEditingCatName(cat.name); setCatError(null) }}
                    className="group flex items-center gap-2 text-left hover:opacity-80"
                    title="Click to rename or delete">
                    <h2 className="text-lg font-bold text-s-text">{cat.name}</h2>
                    <span className="text-xs text-s-muted opacity-0 group-hover:opacity-100 transition-opacity">
                      ✎ Edit
                    </span>
                  </button>
                  {/* Items are now created via the Recipe form so the menu
                      price auto-fills from the recipe's spec calc. The Menu
                      Editor just curates what's live + lets you deviate from
                      the recipe's suggested price. */}
                  <Link
                    href={`/accounting/recipes/new?brandId=${conceptId}&categoryId=${cat.id}`}
                    className="text-sm text-primary-ink hover:underline font-medium"
                  >
                    + Add via Recipe
                  </Link>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {cat.items.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border bg-s-surface p-4 ${
                    item.isAvailable ? 'border-s-border' : 'border-s-red opacity-60'
                  }`}
                >
                  {item.imageUrl && (
                    <img src={item.imageUrl} alt={item.name} className="mb-2 h-20 w-full rounded-lg object-cover" />
                  )}
                  <p className="font-semibold text-s-text">{item.name}</p>
                  {item.description && (
                    <p className="text-xs text-s-muted mt-0.5 line-clamp-2">{item.description}</p>
                  )}
                  <p className="mt-1 font-bold text-primary-ink">{fmtPkrWhole(item.priceCents)}</p>
                  {!item.isAvailable && <p className="text-xs text-s-red font-bold mt-1">86&apos;d</p>}

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => toggle86.mutate({ id: item.id, isAvailable: !item.isAvailable })}
                      className={`flex-1 rounded-lg py-2 text-xs font-bold transition-colors ${
                        item.isAvailable
                          ? 'bg-s-red/20 text-s-red hover:bg-s-red/40'
                          : 'bg-primary/20 text-primary-ink hover:bg-primary/40'
                      }`}
                    >
                      {item.isAvailable ? '86 Item' : 'Restore'}
                    </button>
                    <button
                      onClick={() => setEditItem(item)}
                      className="rounded-lg border border-s-border px-3 py-2 text-xs text-s-muted hover:text-s-text"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Delete "${item.name}"?`)) deleteItem.mutate(item.id) }}
                      className="rounded-lg border border-s-border px-2 py-2 text-xs text-s-red hover:border-s-red"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              {cat.items.length === 0 && (
                <Link
                  href={`/accounting/recipes/new?brandId=${conceptId}&categoryId=${cat.id}`}
                  className="rounded-xl border border-dashed border-s-border p-6 text-center text-s-muted hover:border-primary hover:text-primary-ink transition-colors col-span-full"
                >
                  + Add first item via Recipe
                </Link>
              )}
            </div>
          </section>
        ))}

        {!isLoading && categories.length === 0 && conceptId && (
          <EmptyStateGuide
            icon="📝"
            title="Build your menu"
            description="Group items into categories first — Starters, Mains, Drinks. Then add items with prices, photos, and Urdu names for the KDS."
            whyItMatters="A clean category structure speeds up POS taps and makes the storefront scannable. Aim for 4–6 categories with 5–10 items each."
            samples={[
              { emoji: '🥗', title: 'Starters', hint: 'Soups, salads, small bites' },
              { emoji: '🍛', title: 'Mains',    hint: 'Biryani, karahi, grills' },
              { emoji: '🥤', title: 'Drinks',   hint: 'Soft drinks, lassi, chai' },
            ]}
            primaryAction={{ label: 'Add your first category', onClick: () => setAddingCategory(true) }}
            secondaryAction={{ label: 'Browse the library for photos', href: '/storefront?tab=library' }}
          />
        )}
      </div>
      </>)}

      {editItem && (
        <EditItemDrawer
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={() => { setEditItem(null); void qc.invalidateQueries({ queryKey: ['menu', conceptId] }) }}
        />
      )}
    </div>
  )
}

// ─── Availability (86) board ────────────────────────────────────────────────
// One compact row per item with an on/off switch — the fast way to 86 a dish
// mid-service. Same endpoint as the "86 Item" button on the item cards
// (PATCH /menu/items/:id/availability), which also emits the 86 to the KDS.
function AvailabilityBoard({ categories, loading, pendingId, onToggle }: {
  categories: Category[]
  loading: boolean
  pendingId: string | null
  onToggle: (id: string, isAvailable: boolean) => void
}) {
  const off = categories.reduce((n, c) => n + c.items.filter((i) => !i.isAvailable).length, 0)
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-s-muted">
        Switch an item off to 86 it: it drops off the storefront menu at once and the kitchen screens are told.
        {off > 0 && <span className="ml-1 font-semibold text-s-red">{off} item{off === 1 ? '' : 's'} 86&apos;d now.</span>}
      </p>
      {loading && <p className="text-sm text-s-muted">Loading menu…</p>}
      {!loading && categories.length === 0 && <p className="text-sm text-s-muted">No categories yet — add them in the Items view.</p>}
      {categories.map((cat) => (
        <div key={cat.id} className="overflow-hidden rounded-xl border border-s-border">
          <div className="flex items-center justify-between border-b border-s-border bg-s-surface px-4 py-2.5">
            <p className="font-bold text-s-text">{cat.name}</p>
            <p className="text-xs text-s-muted">
              {cat.items.filter((i) => i.isAvailable).length} of {cat.items.length} on
            </p>
          </div>
          {cat.items.length === 0 && <p className="px-4 py-3 text-xs italic text-s-muted">No items in this category</p>}
          {cat.items.map((item) => (
            <div key={item.id}
              className={`flex items-center justify-between gap-3 border-b border-s-border/50 px-4 py-2.5 last:border-0 ${item.isAvailable ? '' : 'opacity-60'}`}>
              <div className="min-w-0">
                <p className={`truncate text-sm font-medium ${item.isAvailable ? 'text-s-text' : 'text-s-muted line-through'}`}>{item.name}</p>
                <p className="text-xs text-s-muted">{fmtPkrWhole(item.priceCents)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {!item.isAvailable && <span className="rounded-full bg-s-red/15 px-2 py-0.5 text-xs font-bold text-s-red">86&apos;d</span>}
                <Switch value={item.isAvailable} disabled={pendingId === item.id}
                  label={item.isAvailable ? `86 ${item.name}` : `Restore ${item.name}`}
                  onChange={(v) => onToggle(item.id, v)} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Switch({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} title={label}
      disabled={disabled} onClick={() => onChange(!value)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${value ? 'bg-accent' : 'bg-s-border'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-s-surface shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

// ─── Storefront time windows ────────────────────────────────────────────────
// A category with a window only shows on the storefront between From and To
// (server clock). Stored on Category.timeRestrictionStart/End and saved with
// PATCH /menu/categories/:id. Both ends are required: the storefront treats a
// window with no end as "never", and it does not wrap past midnight.
function TimeWindows({ categories, loading, onSaved }: {
  categories: WindowedCategory[]
  loading: boolean
  onSaved: () => void
}) {
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-s-muted">
        Limit a category to certain hours on the storefront, e.g. breakfast 08:00 to 11:30. Leave both blank for always on.
      </p>
      {loading && <p className="text-sm text-s-muted">Loading…</p>}
      {!loading && categories.length === 0 && <p className="text-sm text-s-muted">No categories yet.</p>}
      {categories.map((cat) => (
        <TimeWindowRow key={`${cat.id}:${cat.timeRestrictionStart ?? ''}:${cat.timeRestrictionEnd ?? ''}`} cat={cat} onSaved={onSaved} />
      ))}
    </div>
  )
}

function TimeWindowRow({ cat, onSaved }: { cat: WindowedCategory; onSaved: () => void }) {
  const [start, setStart] = useState(cat.timeRestrictionStart ?? '')
  const [end, setEnd] = useState(cat.timeRestrictionEnd ?? '')
  const dirty = start !== (cat.timeRestrictionStart ?? '') || end !== (cat.timeRestrictionEnd ?? '')
  const invalid = (!!start !== !!end) || (!!start && !!end && end <= start)

  const save = useMutation({
    mutationFn: () => api.patch(`/menu/categories/${cat.id}`, {
      timeRestrictionStart: start || null,
      timeRestrictionEnd: end || null,
    }),
    onSuccess: onSaved,
  })

  const inputCls = 'rounded-lg border border-s-border bg-s-bg px-2 py-1.5 text-sm text-s-text focus:border-primary focus:outline-none'
  return (
    <div className="rounded-xl border border-s-border bg-s-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold text-s-text">{cat.name}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-s-muted">From
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
          </label>
          <label className="flex items-center gap-2 text-xs text-s-muted">To
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
          </label>
          {(start || end) && (
            <button onClick={() => { setStart(''); setEnd('') }} className="text-xs text-s-muted hover:text-s-red">Clear</button>
          )}
          {dirty && (
            <button onClick={() => save.mutate()} disabled={invalid || save.isPending}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on hover:opacity-90 disabled:opacity-40">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
      <p className={`mt-1.5 text-xs ${invalid ? 'text-s-red' : 'text-s-muted'}`}>
        {invalid
          ? (!!start !== !!end ? 'Set both From and To, or clear both.' : 'To must be later than From (windows cannot run past midnight).')
          : start && end ? `Shown ${start} to ${end} only` : 'Always shown'}
      </p>
      {save.isError && <p className="mt-1 text-xs text-s-red">{(save.error as Error).message || 'Save failed'}</p>}
    </div>
  )
}

function AddCategoryForm({ conceptId, sortOrder, onSaved, onCancel }: {
  conceptId: string; sortOrder: number; onSaved: () => void; onCancel: () => void
}) {
  const [name, setName] = useState('')
  const mutation = useMutation({
    mutationFn: () => menuApi.createCategory({ conceptId, name: name.trim(), sortOrder }),
    onSuccess: onSaved,
    onError: (e) => console.error('create category failed', e),
  })

  return (
    <div className="mb-6 rounded-xl border border-primary bg-s-surface p-4 space-y-3">
      <h3 className="font-bold text-s-text">New Category</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) mutation.mutate() }}
        placeholder="e.g. Starters, Mains, Drinks, Desserts"
        className="w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text focus:border-primary focus:outline-none"
      />
      {mutation.isError && <p className="text-s-red text-sm">Failed to create — make sure you&apos;re logged in as admin/manager.</p>}
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim()) mutation.mutate() }}
          disabled={!name.trim() || mutation.isPending}
          className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50 hover:opacity-90"
        >
          {mutation.isPending ? 'Creating…' : 'Create Category'}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm hover:text-s-text">
          Cancel
        </button>
      </div>
    </div>
  )
}

function AddItemForm({ conceptId, categoryId, displayOrder, onSaved, onCancel }: {
  conceptId: string; categoryId: string; displayOrder: number; onSaved: () => void; onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')

  const mutation = useMutation({
    mutationFn: () => menuApi.createItem({
      conceptId,
      categoryId,
      name: name.trim(),
      description: description.trim() || undefined,
      priceCents: Math.round(parseFloat(price) * 100),
      isAvailable: true,
      displayOrder,
    }),
    onSuccess: onSaved,
  })

  return (
    <div className="mb-4 rounded-xl border border-primary bg-s-surface p-4 space-y-3">
      <h3 className="font-bold text-s-text">New Menu Item</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-xs text-s-muted">Item name *</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Grilled Chicken Sandwich"
            className="w-full mt-1 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs text-s-muted">Description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description for customers"
            className="w-full mt-1 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-s-muted">Price (PKR) *</label>
          <input
            type="number"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="850"
            className="w-full mt-1 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm"
          />
        </div>
      </div>
      {mutation.isError && <p className="text-s-red text-sm">Save failed — check the price is a valid number.</p>}
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim() && price) mutation.mutate() }}
          disabled={!name.trim() || !price || mutation.isPending}
          className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50 hover:opacity-90"
        >
          {mutation.isPending ? 'Saving…' : 'Add to Menu'}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm hover:text-s-text">
          Cancel
        </button>
      </div>
    </div>
  )
}

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

function EditItemDrawer({ item, onClose, onSaved }: { item: MenuItem; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item.name)
  const [nameUrdu, setNameUrdu] = useState(item.nameUrdu ?? '')
  const [description, setDescription] = useState(item.description ?? '')
  const [price, setPrice] = useState(String(item.priceCents / 100))
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? '')
  const [videoUrl, setVideoUrl] = useState(item.videoUrl ?? '')
  const [instructions, setInstructions] = useState(item.instructions ?? '')
  const [instructionsUrdu, setInstructionsUrdu] = useState(item.instructionsUrdu ?? '')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoUploadError, setVideoUploadError] = useState('')

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const token = useAuthStore.getState().token   // F43
      const qs = new URLSearchParams({ filename: file.name, contentType: file.type, category: 'menu' })
      const res = await fetch(`${API_URL}/api/v1/media/upload-url?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to get upload URL')
      const { uploadUrl, publicUrl } = await res.json() as { uploadUrl: string; publicUrl: string }
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
      setImageUrl(publicUrl)
    } catch {
      setUploadError('Upload failed — check R2 config')
    } finally {
      setUploading(false)
    }
  }

  async function handleVideoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Storefront video tiles auto-play muted in a loop. Anything over
    // ~10MB starts to hurt LCP on mobile, so we soft-warn at 10MB and
    // hard-stop at 25MB.
    if (file.size > 25 * 1024 * 1024) {
      setVideoUploadError('Video is over 25 MB — please trim it before uploading.')
      return
    }
    setVideoUploading(true)
    setVideoUploadError('')
    try {
      const token = useAuthStore.getState().token
      const qs = new URLSearchParams({ filename: file.name, contentType: file.type, category: 'menu' })
      const res = await fetch(`${API_URL}/api/v1/media/upload-url?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to get upload URL')
      const { uploadUrl, publicUrl } = await res.json() as { uploadUrl: string; publicUrl: string }
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
      setVideoUrl(publicUrl)
    } catch {
      setVideoUploadError('Upload failed — check R2 config')
    } finally {
      setVideoUploading(false)
    }
  }

  const save = useMutation({
    mutationFn: () => menuApi.updateItem(item.id, {
      name,
      nameUrdu: nameUrdu.trim() || undefined,
      description: description || undefined,
      priceCents: Math.round(parseFloat(price) * 100),
      imageUrl: imageUrl.trim() || undefined,
      videoUrl: videoUrl.trim() || undefined,
      instructions: instructions.trim() || undefined,
      instructionsUrdu: instructionsUrdu.trim() || undefined,
    }),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-secondary/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-t-2xl bg-s-surface p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-s-text">Edit: {item.name}</h2>
          <button onClick={onClose} className="text-s-muted text-2xl leading-none">✕</button>
        </div>
        <div className="space-y-3">
          {/* Image */}
          <div>
            <label className="text-xs text-s-muted">Item Image</label>
            <div className="mt-1 flex items-center gap-3">
              {imageUrl
                ? <img src={imageUrl} alt="preview" className="h-16 w-16 rounded-lg object-cover border border-s-border" />
                : <div className="h-16 w-16 rounded-lg border border-dashed border-s-border bg-s-bg flex items-center justify-center text-2xl">📷</div>
              }
              <label className={`cursor-pointer rounded-lg border border-s-border px-3 py-2 text-xs text-s-muted hover:text-s-text transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading ? 'Uploading…' : 'Upload Image'}
                <input type="file" accept="image/*" className="sr-only" onChange={handleImageUpload} />
              </label>
              {imageUrl && (
                <button onClick={() => setImageUrl('')} className="text-xs text-s-red hover:underline">Remove</button>
              )}
            </div>
            {uploadError && <p className="text-xs text-s-red mt-1">{uploadError}</p>}
          </div>

          {/* Video (optional) — when set, takes the place of the image
              on the storefront menu (auto-plays muted in a loop). */}
          <div>
            <label className="text-xs text-s-muted">Item Video (optional — wins over image when set)</label>
            <div className="mt-1 flex items-center gap-3">
              {videoUrl
                ? <video src={videoUrl} muted playsInline loop autoPlay className="h-16 w-16 rounded-lg object-cover border border-s-border" />
                : <div className="h-16 w-16 rounded-lg border border-dashed border-s-border bg-s-bg flex items-center justify-center text-2xl">▶</div>
              }
              <label className={`cursor-pointer rounded-lg border border-s-border px-3 py-2 text-xs text-s-muted hover:text-s-text transition-colors ${videoUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {videoUploading ? 'Uploading…' : 'Upload Video'}
                <input type="file" accept="video/mp4,video/webm" className="sr-only" onChange={handleVideoUpload} />
              </label>
              {videoUrl && (
                <button onClick={() => setVideoUrl('')} className="text-xs text-s-red hover:underline">Remove</button>
              )}
            </div>
            <p className="text-[10px] text-s-muted mt-1">
              MP4 or WebM, up to 25 MB. Loops silently on the storefront menu.
            </p>
            {videoUploadError && <p className="text-xs text-s-red mt-1">{videoUploadError}</p>}
          </div>

          {/* Name */}
          <div>
            <label className="text-xs text-s-muted">Name (English)</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-s-muted">اردو نام — Urdu name (for KDS)</label>
            <input
              value={nameUrdu}
              onChange={(e) => setNameUrdu(e.target.value)}
              dir="rtl"
              placeholder="مثلاً: گرلڈ چکن سینڈوچ"
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none"
              style={{ fontFamily: 'sans-serif' }}
            />
          </div>
          <div>
            <label className="text-xs text-s-muted">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-s-muted">Price (PKR)</label>
            <input type="number" value={price} onChange={(e) => setPrice(e.target.value)}
              className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none" />
          </div>

          {/* Instructions */}
          <div className="border-t border-s-border pt-3">
            <label className="text-xs font-semibold text-s-muted uppercase tracking-wide">Kitchen Instructions</label>
            <p className="text-xs text-s-muted mb-2">Shown to kitchen staff when they tap the dish name on KDS</p>
            <div>
              <label className="text-xs text-s-muted">Instructions (English)</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="e.g. 1. Grill chicken breast 6 min each side&#10;2. Toast bun 2 min&#10;3. Add sauces, lettuce, tomato&#10;4. Plate immediately"
                className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm resize-none"
              />
            </div>
            <div className="mt-2">
              <label className="text-xs text-s-muted">ہدایات — Instructions (اردو)</label>
              <textarea
                value={instructionsUrdu}
                onChange={(e) => setInstructionsUrdu(e.target.value)}
                rows={4}
                dir="rtl"
                placeholder="مثلاً: ۱. چکن گرل کریں ۶ منٹ..."
                className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm resize-none"
                style={{ fontFamily: 'sans-serif' }}
              />
            </div>
          </div>
        </div>

        {save.isError && <p className="text-sm text-s-red">Save failed</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-s-border py-3 text-s-muted hover:text-s-text">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || uploading}
            className="flex-1 rounded-xl bg-primary py-3 font-bold text-primary-on disabled:opacity-50 hover:opacity-90">
            {save.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
