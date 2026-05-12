'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { menuApi, api, type Category, type MenuItem } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import Link from 'next/link'
import { EmptyStateGuide } from '../../components/ui/EmptyStateGuide'

function fmt(cents: number) { return `PKR ${(cents / 100).toFixed(0)}` }

export default function MenuPage() {
  const [selectedConceptId, setSelectedConceptId] = useState<string>('')
  const [editItem, setEditItem] = useState<MenuItem | null>(null)
  const [addingItemToCat, setAddingItemToCat] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const qc = useQueryClient()

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/concepts'),
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

  return (
    <div className="min-h-screen bg-kds-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-1">Menu Editor</h1>
        </div>
        <button
          onClick={() => setAddingCategory(true)}
          disabled={!conceptId}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 hover:opacity-90 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add Category
        </button>
      </header>

      {/* Concept tabs */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {concepts.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedConceptId(c.id)}
            className={`shrink-0 rounded-lg px-4 py-2 font-semibold text-sm transition-colors ${
              c.id === conceptId ? 'bg-kds-green text-black' : 'bg-kds-card text-kds-subtext hover:text-kds-text'
            }`}
          >
            {c.name}
          </button>
        ))}
        {concepts.length === 0 && <p className="text-kds-subtext text-sm">Loading concepts…</p>}
      </div>

      {/* Add category form */}
      {addingCategory && (
        <AddCategoryForm
          conceptId={conceptId}
          sortOrder={categories.length}
          onSaved={() => { void qc.invalidateQueries({ queryKey: ['menu', conceptId] }); setAddingCategory(false) }}
          onCancel={() => setAddingCategory(false)}
        />
      )}

      {isLoading && <p className="text-kds-subtext">Loading menu…</p>}

      {/* Categories + Items */}
      <div className="space-y-8">
        {categories.map((cat) => (
          <section key={cat.id}>
            <div className="flex items-center justify-between mb-3 border-b border-kds-border pb-2">
              <h2 className="text-lg font-bold text-kds-text">{cat.name}</h2>
              <button
                onClick={() => setAddingItemToCat(addingItemToCat === cat.id ? null : cat.id)}
                className="text-sm text-kds-green hover:underline font-medium"
              >
                {addingItemToCat === cat.id ? 'Cancel' : '+ Add Item'}
              </button>
            </div>

            {addingItemToCat === cat.id && (
              <AddItemForm
                conceptId={conceptId}
                categoryId={cat.id}
                displayOrder={cat.items.length}
                onSaved={() => { void qc.invalidateQueries({ queryKey: ['menu', conceptId] }); setAddingItemToCat(null) }}
                onCancel={() => setAddingItemToCat(null)}
              />
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cat.items.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border bg-kds-card p-4 ${
                    item.isAvailable ? 'border-kds-border' : 'border-kds-red opacity-60'
                  }`}
                >
                  {item.imageUrl && (
                    <img src={item.imageUrl} alt={item.name} className="mb-2 h-20 w-full rounded-lg object-cover" />
                  )}
                  <p className="font-semibold text-kds-text">{item.name}</p>
                  {item.description && (
                    <p className="text-xs text-kds-subtext mt-0.5 line-clamp-2">{item.description}</p>
                  )}
                  <p className="mt-1 font-bold text-kds-green">{fmt(item.priceCents)}</p>
                  {!item.isAvailable && <p className="text-xs text-kds-red font-bold mt-1">86&apos;d</p>}

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => toggle86.mutate({ id: item.id, isAvailable: !item.isAvailable })}
                      className={`flex-1 rounded-lg py-2 text-xs font-bold transition-colors ${
                        item.isAvailable
                          ? 'bg-kds-red/20 text-kds-red hover:bg-kds-red/40'
                          : 'bg-kds-green/20 text-kds-green hover:bg-kds-green/40'
                      }`}
                    >
                      {item.isAvailable ? '86 Item' : 'Restore'}
                    </button>
                    <button
                      onClick={() => setEditItem(item)}
                      className="rounded-lg border border-kds-border px-3 py-2 text-xs text-kds-subtext hover:text-kds-text"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Delete "${item.name}"?`)) deleteItem.mutate(item.id) }}
                      className="rounded-lg border border-kds-border px-2 py-2 text-xs text-kds-red hover:border-kds-red"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              {cat.items.length === 0 && addingItemToCat !== cat.id && (
                <button
                  onClick={() => setAddingItemToCat(cat.id)}
                  className="rounded-xl border border-dashed border-kds-border p-6 text-center text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors col-span-full"
                >
                  + Add first item to this category
                </button>
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
            secondaryAction={{ label: 'Browse media library for photos', href: '/media' }}
          />
        )}
      </div>

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
    <div className="mb-6 rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
      <h3 className="font-bold text-kds-text">New Category</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) mutation.mutate() }}
        placeholder="e.g. Starters, Mains, Drinks, Desserts"
        className="w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none"
      />
      {mutation.isError && <p className="text-kds-red text-sm">Failed to create — make sure you&apos;re logged in as admin/manager.</p>}
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim()) mutation.mutate() }}
          disabled={!name.trim() || mutation.isPending}
          className="rounded-lg bg-kds-green text-black font-bold px-4 py-2 text-sm disabled:opacity-50 hover:opacity-90"
        >
          {mutation.isPending ? 'Creating…' : 'Create Category'}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-kds-border text-kds-subtext px-4 py-2 text-sm hover:text-kds-text">
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
    <div className="mb-4 rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
      <h3 className="font-bold text-kds-text">New Menu Item</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-xs text-kds-subtext">Item name *</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Grilled Chicken Sandwich"
            className="w-full mt-1 rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs text-kds-subtext">Description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description for customers"
            className="w-full mt-1 rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-kds-subtext">Price (PKR) *</label>
          <input
            type="number"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="850"
            className="w-full mt-1 rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm"
          />
        </div>
      </div>
      {mutation.isError && <p className="text-kds-red text-sm">Save failed — check the price is a valid number.</p>}
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim() && price) mutation.mutate() }}
          disabled={!name.trim() || !price || mutation.isPending}
          className="rounded-lg bg-kds-green text-black font-bold px-4 py-2 text-sm disabled:opacity-50 hover:opacity-90"
        >
          {mutation.isPending ? 'Saving…' : 'Add to Menu'}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-kds-border text-kds-subtext px-4 py-2 text-sm hover:text-kds-text">
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
  const [instructions, setInstructions] = useState(item.instructions ?? '')
  const [instructionsUrdu, setInstructionsUrdu] = useState(item.instructionsUrdu ?? '')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

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

  const save = useMutation({
    mutationFn: () => menuApi.updateItem(item.id, {
      name,
      nameUrdu: nameUrdu.trim() || undefined,
      description: description || undefined,
      priceCents: Math.round(parseFloat(price) * 100),
      imageUrl: imageUrl.trim() || undefined,
      instructions: instructions.trim() || undefined,
      instructionsUrdu: instructionsUrdu.trim() || undefined,
    }),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-t-2xl bg-kds-card p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-kds-text">Edit: {item.name}</h2>
          <button onClick={onClose} className="text-kds-subtext text-2xl leading-none">✕</button>
        </div>
        <div className="space-y-3">
          {/* Image */}
          <div>
            <label className="text-xs text-kds-subtext">Item Image</label>
            <div className="mt-1 flex items-center gap-3">
              {imageUrl
                ? <img src={imageUrl} alt="preview" className="h-16 w-16 rounded-lg object-cover border border-kds-border" />
                : <div className="h-16 w-16 rounded-lg border border-dashed border-kds-border bg-kds-bg flex items-center justify-center text-2xl">📷</div>
              }
              <label className={`cursor-pointer rounded-lg border border-kds-border px-3 py-2 text-xs text-kds-subtext hover:text-kds-text transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading ? 'Uploading…' : 'Upload Image'}
                <input type="file" accept="image/*" className="sr-only" onChange={handleImageUpload} />
              </label>
              {imageUrl && (
                <button onClick={() => setImageUrl('')} className="text-xs text-kds-red hover:underline">Remove</button>
              )}
            </div>
            {uploadError && <p className="text-xs text-kds-red mt-1">{uploadError}</p>}
          </div>

          {/* Name */}
          <div>
            <label className="text-xs text-kds-subtext">Name (English)</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-kds-subtext">اردو نام — Urdu name (for KDS)</label>
            <input
              value={nameUrdu}
              onChange={(e) => setNameUrdu(e.target.value)}
              dir="rtl"
              placeholder="مثلاً: گرلڈ چکن سینڈوچ"
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none"
              style={{ fontFamily: 'sans-serif' }}
            />
          </div>
          <div>
            <label className="text-xs text-kds-subtext">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-kds-subtext">Price (PKR)</label>
            <input type="number" value={price} onChange={(e) => setPrice(e.target.value)}
              className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none" />
          </div>

          {/* Instructions */}
          <div className="border-t border-kds-border pt-3">
            <label className="text-xs font-semibold text-kds-subtext uppercase tracking-wide">Kitchen Instructions</label>
            <p className="text-xs text-kds-subtext mb-2">Shown to kitchen staff when they tap the dish name on KDS</p>
            <div>
              <label className="text-xs text-kds-subtext">Instructions (English)</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="e.g. 1. Grill chicken breast 6 min each side&#10;2. Toast bun 2 min&#10;3. Add sauces, lettuce, tomato&#10;4. Plate immediately"
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm resize-none"
              />
            </div>
            <div className="mt-2">
              <label className="text-xs text-kds-subtext">ہدایات — Instructions (اردو)</label>
              <textarea
                value={instructionsUrdu}
                onChange={(e) => setInstructionsUrdu(e.target.value)}
                rows={4}
                dir="rtl"
                placeholder="مثلاً: ۱. چکن گرل کریں ۶ منٹ..."
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm resize-none"
                style={{ fontFamily: 'sans-serif' }}
              />
            </div>
          </div>
        </div>

        {save.isError && <p className="text-sm text-kds-red">Save failed</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext hover:text-kds-text">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || uploading}
            className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-black disabled:opacity-50 hover:opacity-90">
            {save.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
