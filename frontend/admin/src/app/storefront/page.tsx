'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, menuApi } from '../../lib/api'
import Link from 'next/link'

// ─── Block type definitions (mirrored from apps/storefront/src/lib/blocks.ts) ──

type BlockType = 'hero' | 'announcement' | 'story' | 'features' | 'menu' | 'gallery' | 'quote' | 'cta' | 'spacer'

interface HeroBlock { type: 'hero'; imageUrl?: string; headline?: string; subline?: string; ctaText?: string; ctaUrl?: string; fullHeight?: boolean; overlay?: boolean; textAlign?: 'left' | 'center' | 'right'; usesBrandColor?: boolean }
interface AnnouncementBlock { type: 'announcement'; text: string; bgColor?: string; textColor?: string }
interface StoryBlock { type: 'story'; heading: string; body: string; imageUrl?: string; imagePosition?: 'left' | 'right'; bgColor?: string }
interface FeaturesBlock { type: 'features'; heading?: string; columns?: 2 | 3 | 4; bgColor?: string; items: Array<{ icon: string; title: string; body: string }> }
interface MenuBlock { type: 'menu'; title?: string; layout?: 'list' | 'grid' }
interface GalleryBlock { type: 'gallery'; heading?: string; columns?: 2 | 3 | 4; images: string[] }
interface QuoteBlock { type: 'quote'; text: string; author?: string; bgColor?: string; textColor?: string }
interface CTABlock { type: 'cta'; heading: string; body?: string; buttonText: string; buttonUrl?: string; bgColor?: string; textColor?: string }
interface SpacerBlock { type: 'spacer'; size: 'sm' | 'md' | 'lg' }

type Block = HeroBlock | AnnouncementBlock | StoryBlock | FeaturesBlock | MenuBlock | GalleryBlock | QuoteBlock | CTABlock | SpacerBlock

const BLOCK_META: Record<BlockType, { label: string; icon: string; desc: string }> = {
  hero:         { label: 'Hero Banner',        icon: '🖼',  desc: 'Full-width hero with headline & CTA' },
  announcement: { label: 'Announcement Strip', icon: '📢', desc: 'Coloured banner for promos & alerts' },
  story:        { label: 'Brand Story',        icon: '📖', desc: 'Text + image side-by-side section' },
  features:     { label: 'Feature Cards',      icon: '✨', desc: 'Icon cards highlighting selling points' },
  menu:         { label: 'Menu',               icon: '🍽', desc: 'Embed the live menu (list or grid)' },
  gallery:      { label: 'Photo Gallery',      icon: '🖼', desc: 'Image grid for food photography' },
  quote:        { label: 'Pull Quote',         icon: '💬', desc: 'Large testimonial or tagline' },
  cta:          { label: 'Call to Action',     icon: '🎯', desc: 'Prominent button section' },
  spacer:       { label: 'Spacer',             icon: '↕',  desc: 'Vertical whitespace between sections' },
}

function mkDefaultBlock(type: BlockType): Block {
  switch (type) {
    case 'hero':         return { type: 'hero', headline: 'Welcome', usesBrandColor: true, textAlign: 'center', overlay: true }
    case 'announcement': return { type: 'announcement', text: '🔥 New items just dropped!' }
    case 'story':        return { type: 'story', heading: 'Our Story', body: 'Tell your brand story here.', imagePosition: 'right' }
    case 'features':     return { type: 'features', heading: 'Why us?', columns: 3, items: [
      { icon: '🌿', title: 'Fresh Daily', body: 'Made fresh every morning.' },
      { icon: '✅', title: 'Halal Certified', body: '100% halal ingredients.' },
      { icon: '⚡', title: 'Fast Service', body: 'Ready in under 15 minutes.' },
    ]}
    case 'menu':         return { type: 'menu', layout: 'list' }
    case 'gallery':      return { type: 'gallery', heading: 'Gallery', columns: 3, images: [] }
    case 'quote':        return { type: 'quote', text: 'The food that makes you come back.', author: '' }
    case 'cta':          return { type: 'cta', heading: 'Ready to order?', buttonText: 'Order Now', buttonUrl: '#menu' }
    case 'spacer':       return { type: 'spacer', size: 'md' }
  }
}

function mkDefaultLayout(concept: Concept): Block[] {
  const blocks: Block[] = []
  if (concept.announcementBanner) blocks.push({ type: 'announcement', text: concept.announcementBanner })
  blocks.push({ type: 'hero', headline: concept.heroTagline ?? concept.name, usesBrandColor: true, textAlign: 'center', overlay: false })
  blocks.push({ type: 'menu', layout: 'list' })
  return blocks
}

function blockPreview(block: Block): string {
  switch (block.type) {
    case 'hero':         return block.headline ?? 'No headline set'
    case 'announcement': return block.text
    case 'story':        return block.heading
    case 'features':     return `${block.items.length} feature card${block.items.length !== 1 ? 's' : ''}`
    case 'menu':         return `${block.layout ?? 'list'} layout`
    case 'gallery':      return `${block.images.length} image${block.images.length !== 1 ? 's' : ''}`
    case 'quote':        return block.text.slice(0, 60) + (block.text.length > 60 ? '…' : '')
    case 'cta':          return block.heading
    case 'spacer':       return `${block.size} spacer`
  }
}

// ─── Data interfaces ───────────────────────────────────────────────────────────

interface Concept {
  id: string; name: string; slug: string; type: string
  description: string | null; primaryColor: string | null
  storefrontVisible: boolean; heroTagline: string | null
  announcementBanner: string | null; logoUrl: string | null
  storefrontLayout: Block[] | null
}
interface Category {
  id: string; name: string; sortOrder: number; isActive: boolean
  timeRestrictionStart: string | null; timeRestrictionEnd: string | null
  items: MenuItem[]
}
interface MenuItem {
  id: string; name: string; description: string | null
  priceCents: number; imageUrl: string | null; isAvailable: boolean; displayOrder: number
}

interface Promo {
  id: string; emoji: string; badge: string; headline: string; sub: string
  bg: string; shadow: string; sortOrder: number; isActive: boolean
}

const BLANK_PROMO: Omit<Promo, 'id' | 'isActive' | 'sortOrder'> = { emoji: '🔥', badge: '', headline: '', sub: '', bg: '#c0392b', shadow: '#922b21' }

const STOREFRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL'] ?? 'http://localhost:3002'
type Tab = 'branding' | 'menu' | 'schedule' | 'layout'
type PageMode = 'concepts' | 'promos'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StorefrontCMSPage() {
  const qc = useQueryClient()
  const [pageMode, setPageMode] = useState<PageMode>('concepts')
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('branding')
  const [form, setForm] = useState<Partial<Concept>>({})
  const [saved, setSaved] = useState(false)
  const [layoutBlocks, setLayoutBlocks] = useState<Block[]>([])
  const [layoutSaved, setLayoutSaved] = useState(false)
  const [promoForm, setPromoForm] = useState<Omit<Promo, 'id' | 'isActive' | 'sortOrder'>>(BLANK_PROMO)
  const [editingPromo, setEditingPromo] = useState<string | null>(null)
  const [showAddPromo, setShowAddPromo] = useState(false)

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const { data: promos = [] } = useQuery({
    queryKey: ['storefront-promos'],
    queryFn: () => api.get<Promo[]>('/storefront/admin/promos'),
    enabled: pageMode === 'promos',
  })

  const createPromoMutation = useMutation({
    mutationFn: (body: typeof BLANK_PROMO) => api.post('/storefront/admin/promos', { ...body, sortOrder: promos.length }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['storefront-promos'] }); setShowAddPromo(false); setPromoForm(BLANK_PROMO) },
  })

  const updatePromoMutation = useMutation({
    mutationFn: ({ id, ...body }: Partial<Promo> & { id: string }) => api.patch(`/storefront/admin/promos/${id}`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['storefront-promos'] }); setEditingPromo(null) },
  })

  const deletePromoMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/storefront/admin/promos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['storefront-promos'] }),
  })

  const selectedConcept = concepts.find((c) => c.id === selected) ?? null

  const { data: categories = [], isLoading: menuLoading } = useQuery({
    queryKey: ['menu', selected],
    queryFn: () => api.get<Category[]>(`/menu/${selected}`),
    enabled: !!selected && (tab === 'menu' || tab === 'schedule'),
  })

  const updateConceptMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/concepts/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concepts'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const saveLayoutMutation = useMutation({
    mutationFn: ({ id, layout }: { id: string; layout: Block[] }) =>
      api.patch(`/concepts/${id}`, { storefrontLayout: layout }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concepts'] })
      setLayoutSaved(true)
      setTimeout(() => setLayoutSaved(false), 2500)
    },
  })

  const toggleItemMutation = useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      menuApi.toggleAvailability(id, isAvailable),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu', selected] }),
  })

  const toggleCategoryMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/menu/categories/${id}`, { isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu', selected] }),
  })

  const updateCategoryMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/menu/categories/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu', selected] }),
  })

  function selectConcept(c: Concept) {
    setSelected(c.id)
    setForm({
      name: c.name,
      description: c.description ?? '',
      primaryColor: c.primaryColor ?? '#6366f1',
      heroTagline: c.heroTagline ?? '',
      announcementBanner: c.announcementBanner ?? '',
      logoUrl: c.logoUrl ?? '',
      storefrontVisible: c.storefrontVisible,
    })
    setLayoutBlocks(
      Array.isArray(c.storefrontLayout) && c.storefrontLayout.length > 0
        ? (c.storefrontLayout as Block[])
        : mkDefaultLayout(c)
    )
    setSaved(false)
    setLayoutSaved(false)
  }

  const previewBg = form.primaryColor ?? '#6366f1'
  const previewText = isLight(previewBg) ? '#111' : '#fff'

  const TAB_LABELS: Record<Tab, string> = {
    branding: 'Branding & copy',
    menu: 'Menu availability',
    schedule: 'Opening hours',
    layout: 'Layout builder',
  }

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Storefront CMS</h1>
          <p className="text-sm text-kds-subtext">Everything customers see on the ordering site</p>
        </div>
        <a href={STOREFRONT_URL} target="_blank" rel="noopener noreferrer"
          className="rounded-xl border border-kds-border px-4 py-2 text-sm text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
          Open storefront ↗
        </a>
      </header>

      <div className="flex h-[calc(100vh-81px)]">
        {/* ── Sidebar ── */}
        <aside className="w-56 shrink-0 border-r border-kds-border overflow-y-auto flex flex-col">
          {/* Mode tabs */}
          <div className="flex border-b border-kds-border">
            <button onClick={() => setPageMode('concepts')}
              className={`flex-1 py-2.5 text-xs font-bold transition-colors ${pageMode === 'concepts' ? 'text-kds-green border-b-2 border-kds-green' : 'text-kds-subtext hover:text-kds-text'}`}>
              Concepts
            </button>
            <button onClick={() => setPageMode('promos')}
              className={`flex-1 py-2.5 text-xs font-bold transition-colors ${pageMode === 'promos' ? 'text-kds-green border-b-2 border-kds-green' : 'text-kds-subtext hover:text-kds-text'}`}>
              Homepage
            </button>
          </div>

          {pageMode === 'concepts' && concepts.map((c) => (
            <button key={c.id} onClick={() => selectConcept(c)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-kds-border/40
                ${selected === c.id ? 'bg-kds-card border-l-2 border-l-kds-green' : 'hover:bg-kds-card/50'}`}>
              <div className="h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-xs font-black overflow-hidden"
                style={{ background: c.primaryColor ?? '#6366f1', color: isLight(c.primaryColor ?? '#6366f1') ? '#111' : '#fff' }}>
                {c.logoUrl ? <img src={c.logoUrl} alt={c.name} className="h-full w-full object-cover" /> : c.name[0]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-kds-text truncate">{c.name}</p>
                <p className="text-xs text-kds-subtext capitalize">{c.type}</p>
              </div>
              <div className={`h-2 w-2 rounded-full shrink-0 ${c.storefrontVisible ? 'bg-kds-green' : 'bg-kds-border'}`} />
            </button>
          ))}

          {pageMode === 'promos' && (
            <div className="p-3">
              <p className="text-xs text-kds-subtext leading-relaxed">
                Deals & offers shown on the customer homepage deals strip.
              </p>
              <p className="text-xs text-kds-subtext mt-2">{promos.length} promo{promos.length !== 1 ? 's' : ''} · {promos.filter(p => p.isActive).length} active</p>
            </div>
          )}
        </aside>

        {pageMode === 'promos' ? (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-black text-kds-text">Homepage Deals Strip</h2>
                  <p className="text-sm text-kds-subtext mt-0.5">Cards shown in the scrollable deals section on the customer home page</p>
                </div>
                <button onClick={() => { setShowAddPromo(true); setEditingPromo(null); setPromoForm(BLANK_PROMO) }}
                  className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
                  + Add promo
                </button>
              </div>

              {/* Add form */}
              {showAddPromo && (
                <PromoForm
                  value={promoForm}
                  onChange={setPromoForm}
                  onSave={() => createPromoMutation.mutate(promoForm)}
                  onCancel={() => { setShowAddPromo(false); setPromoForm(BLANK_PROMO) }}
                  saving={createPromoMutation.isPending}
                  label="New promo"
                />
              )}

              {/* Promo list */}
              {promos.length === 0 && !showAddPromo && (
                <div className="rounded-xl border-2 border-dashed border-kds-border py-16 text-center">
                  <p className="text-4xl mb-3">🎁</p>
                  <p className="font-semibold text-kds-text">No promos yet</p>
                  <p className="text-sm text-kds-subtext mt-1">Click "Add promo" to create your first deal card</p>
                </div>
              )}

              {promos.map((p) => (
                <div key={p.id} className={`rounded-xl border bg-kds-card transition-all ${editingPromo === p.id ? 'border-kds-green' : 'border-kds-border'}`}>
                  {editingPromo === p.id ? (
                    <div className="p-4">
                      <PromoForm
                        value={promoForm}
                        onChange={setPromoForm}
                        onSave={() => updatePromoMutation.mutate({ id: p.id, ...promoForm })}
                        onCancel={() => setEditingPromo(null)}
                        saving={updatePromoMutation.isPending}
                        label="Edit promo"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 px-4 py-3">
                      {/* Mini card preview */}
                      <div className="h-14 w-14 rounded-xl shrink-0 flex flex-col justify-between p-2"
                        style={{ background: p.bg }}>
                        <span className="text-[10px] font-black text-white/80 leading-none truncate">{p.badge}</span>
                        <span className="text-lg leading-none">{p.emoji}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-black text-kds-text">{p.headline}</p>
                        <p className="text-xs text-kds-subtext truncate">{p.sub}</p>
                        <p className="text-xs text-kds-subtext mt-0.5">{p.badge}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Toggle value={p.isActive}
                          onChange={(v) => updatePromoMutation.mutate({ id: p.id, isActive: v })} />
                        <button onClick={() => { setEditingPromo(p.id); setPromoForm({ emoji: p.emoji, badge: p.badge, headline: p.headline, sub: p.sub, bg: p.bg, shadow: p.shadow }) }}
                          className="h-8 w-8 flex items-center justify-center rounded-lg text-kds-subtext hover:text-kds-text hover:bg-kds-bg transition-colors text-sm">
                          ✎
                        </button>
                        <button onClick={() => deletePromoMutation.mutate(p.id)}
                          className="h-8 w-8 flex items-center justify-center rounded-lg text-kds-subtext hover:text-red-400 hover:bg-red-950/20 transition-colors">
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : selectedConcept ? (
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* ── Tabs ── */}
            <div className="flex gap-1 px-6 pt-4 border-b border-kds-border pb-0">
              {(['branding', 'menu', 'schedule', 'layout'] as Tab[]).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                    ${tab === t ? 'border-kds-green text-kds-green bg-kds-card' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
                  {TAB_LABELS[t]}
                </button>
              ))}
              <a href={`${STOREFRONT_URL}/${selectedConcept.slug}`} target="_blank" rel="noopener noreferrer"
                className="ml-auto mb-1 self-end text-xs text-kds-subtext hover:text-kds-green transition-colors">
                Preview ↗
              </a>
            </div>

            <div className="flex-1 overflow-y-auto p-6">

              {/* ═══════════════════ BRANDING TAB ═══════════════════ */}
              {tab === 'branding' && (
                <div className="max-w-2xl space-y-6">
                  <div className="flex items-center justify-between rounded-xl border border-kds-border bg-kds-card px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-kds-text">Visible on ordering site</p>
                      <p className="text-xs text-kds-subtext mt-0.5">
                        {form.storefrontVisible ? 'Customers can see and order' : 'Hidden — not visible to customers'}
                      </p>
                    </div>
                    <Toggle value={!!form.storefrontVisible} onChange={(v) => setForm({ ...form, storefrontVisible: v })} />
                  </div>

                  <Section label="Branding">
                    <Field label="Display name">
                      <input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inp} />
                    </Field>
                    <Field label="Brand colour">
                      <div className="flex items-center gap-3">
                        <input type="color" value={form.primaryColor ?? '#6366f1'}
                          onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                          className="h-10 w-16 rounded-lg border border-kds-border bg-kds-bg cursor-pointer p-1" />
                        <input value={form.primaryColor ?? ''} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                          className={`${inp} font-mono w-28`} />
                        <div className="h-8 w-8 rounded-full border border-kds-border" style={{ background: previewBg }} />
                      </div>
                    </Field>
                    <Field label="Logo URL" hint="Direct image link — square PNG/JPG preferred">
                      <input value={form.logoUrl ?? ''} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                        placeholder="https://…" className={inp} />
                      {form.logoUrl && (
                        <img src={form.logoUrl} alt="logo" className="mt-2 h-12 w-12 rounded-full object-cover border border-kds-border" />
                      )}
                    </Field>
                  </Section>

                  <Section label="Copy">
                    <Field label="Short description" hint="Landing page card — keep it punchy">
                      <input value={form.description ?? ''} maxLength={200}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        placeholder="e.g. Gourmet sandwiches, loaded fries, house-made sauces" className={inp} />
                    </Field>
                    <Field label="Hero tagline" hint="Big headline on the menu page">
                      <input value={form.heroTagline ?? ''} maxLength={120}
                        onChange={(e) => setForm({ ...form, heroTagline: e.target.value })}
                        placeholder="e.g. Built different. Eaten fast." className={inp} />
                      <p className="text-right text-xs text-kds-subtext mt-0.5">{(form.heroTagline ?? '').length}/120</p>
                    </Field>
                    <Field label="Announcement banner" hint="Highlighted strip at top — blank to hide">
                      <textarea value={form.announcementBanner ?? ''} maxLength={300} rows={2}
                        onChange={(e) => setForm({ ...form, announcementBanner: e.target.value })}
                        placeholder="🔥 Weekend special — free drink with any meal today!"
                        className={`${inp} resize-none`} />
                      <p className="text-right text-xs text-kds-subtext mt-0.5">{(form.announcementBanner ?? '').length}/300</p>
                    </Field>
                  </Section>

                  <Section label="Preview">
                    <div className="rounded-2xl overflow-hidden border border-kds-border w-64">
                      {form.announcementBanner && (
                        <div className="px-3 py-2 text-xs text-center font-medium" style={{ background: previewBg, color: previewText, opacity: 0.9 }}>
                          {form.announcementBanner}
                        </div>
                      )}
                      <div className="px-4 py-4 flex items-center gap-3" style={{ background: previewBg }}>
                        <div className="h-11 w-11 rounded-full shrink-0 overflow-hidden border-2 border-white/30 flex items-center justify-center font-black"
                          style={{ background: 'rgba(255,255,255,0.15)', color: previewText }}>
                          {form.logoUrl ? <img src={form.logoUrl} alt="logo" className="h-full w-full object-cover" /> : (form.name ?? selectedConcept.name)[0]}
                        </div>
                        <div>
                          <p className="font-black text-sm" style={{ color: previewText }}>{form.name || selectedConcept.name}</p>
                          {form.heroTagline && <p className="text-xs opacity-80 mt-0.5" style={{ color: previewText }}>{form.heroTagline}</p>}
                        </div>
                      </div>
                      <div className="bg-white px-3 py-2 space-y-1.5">
                        {[75, 60, 80].map((w, i) => (
                          <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-100 p-1.5">
                            <div className="h-8 w-8 rounded bg-gray-100 shrink-0" />
                            <div className="flex-1 space-y-1">
                              <div className="h-2 rounded bg-gray-200" style={{ width: `${w}%` }} />
                              <div className="h-1.5 rounded bg-gray-100" style={{ width: `${w - 20}%` }} />
                            </div>
                            <div className="h-6 w-6 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold"
                              style={{ background: previewBg }}>+</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Section>

                  <div className="flex items-center gap-3 pt-2">
                    <button onClick={() => updateConceptMutation.mutate({ id: selectedConcept.id, body: form as Record<string, unknown> })}
                      disabled={updateConceptMutation.isPending}
                      className="rounded-xl bg-kds-green text-black font-bold px-6 py-2.5 hover:opacity-90 disabled:opacity-50">
                      {updateConceptMutation.isPending ? 'Saving…' : 'Save changes'}
                    </button>
                    {saved && <span className="text-sm text-kds-green">✓ Saved</span>}
                  </div>
                </div>
              )}

              {/* ═══════════════════ MENU AVAILABILITY TAB ═══════════════════ */}
              {tab === 'menu' && (
                <div className="space-y-4">
                  <p className="text-sm text-kds-subtext">Toggle items on/off instantly. Toggling off 86's the item and notifies KDS screens in real-time.</p>
                  {menuLoading && <p className="text-kds-subtext text-sm">Loading menu…</p>}
                  {categories.map((cat) => (
                    <div key={cat.id} className="rounded-xl border border-kds-border overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 bg-kds-card border-b border-kds-border">
                        <div>
                          <p className="font-bold text-kds-text">{cat.name}</p>
                          <p className="text-xs text-kds-subtext">{cat.items.length} items</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-kds-subtext">Category visible</span>
                          <Toggle value={cat.isActive} onChange={(v) => toggleCategoryMutation.mutate({ id: cat.id, isActive: v })} />
                        </div>
                      </div>
                      {cat.items.length === 0 && (
                        <p className="px-4 py-3 text-xs text-kds-subtext italic">No items in this category</p>
                      )}
                      {cat.items.map((item) => (
                        <div key={item.id} className={`flex items-center justify-between px-4 py-3 border-b border-kds-border/50 last:border-0 transition-opacity ${!item.isAvailable ? 'opacity-50' : ''}`}>
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            {item.imageUrl && (
                              <img src={item.imageUrl} alt={item.name} className="h-10 w-10 rounded-lg object-cover shrink-0 border border-kds-border" />
                            )}
                            <div className="min-w-0">
                              <p className={`text-sm font-medium ${item.isAvailable ? 'text-kds-text' : 'text-kds-subtext line-through'}`}>{item.name}</p>
                              <p className="text-xs text-kds-subtext">PKR {(item.priceCents / 100).toLocaleString()}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {!item.isAvailable && <span className="text-xs font-bold text-kds-red bg-red-950/30 px-2 py-0.5 rounded-full">86'd</span>}
                            <Toggle value={item.isAvailable} onChange={(v) => toggleItemMutation.mutate({ id: item.id, isAvailable: v })} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {!menuLoading && categories.length === 0 && (
                    <div className="text-center py-12 text-kds-subtext">
                      <p className="text-3xl mb-2">📋</p>
                      <p>No menu items yet. Add them in the <Link href="/menu" className="text-kds-green hover:underline">Menu Editor</Link>.</p>
                    </div>
                  )}
                </div>
              )}

              {/* ═══════════════════ SCHEDULE / OPENING HOURS TAB ═══════════════════ */}
              {tab === 'schedule' && (
                <div className="space-y-4 max-w-2xl">
                  <p className="text-sm text-kds-subtext">
                    Set time windows per category. Categories only appear on the storefront during their active hours. Leave blank for always-on.
                  </p>
                  {menuLoading && <p className="text-kds-subtext text-sm">Loading…</p>}
                  {categories.map((cat) => (
                    <CategoryScheduleRow key={cat.id} cat={cat}
                      onSave={(body) => updateCategoryMutation.mutate({ id: cat.id, body })} />
                  ))}
                  {!menuLoading && categories.length === 0 && (
                    <p className="text-kds-subtext text-sm">No categories yet.</p>
                  )}
                </div>
              )}

              {/* ═══════════════════ LAYOUT BUILDER TAB ═══════════════════ */}
              {tab === 'layout' && (
                <LayoutEditor
                  blocks={layoutBlocks}
                  onChange={setLayoutBlocks}
                  onSave={() => saveLayoutMutation.mutate({ id: selectedConcept.id, layout: layoutBlocks })}
                  saving={saveLayoutMutation.isPending}
                  saved={layoutSaved}
                  conceptName={selectedConcept.name}
                  brandColor={selectedConcept.primaryColor ?? '#6366f1'}
                  slug={selectedConcept.slug}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-kds-subtext">
            <div className="text-center">
              <p className="text-5xl mb-3">🛍</p>
              <p className="font-semibold text-kds-text">Select a concept to edit</p>
              <p className="text-sm mt-1">Changes save instantly and reflect on the customer site</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Promo Form ───────────────────────────────────────────────────────────────

function PromoForm({
  value, onChange, onSave, onCancel, saving, label,
}: {
  value: Omit<Promo, 'id' | 'isActive' | 'sortOrder'>
  onChange: (v: Omit<Promo, 'id' | 'isActive' | 'sortOrder'>) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  label: string
}) {
  const f = (key: keyof typeof value) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value })

  return (
    <div className="rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
      <p className="text-sm font-bold text-kds-text">{label}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Emoji"><input value={value.emoji} onChange={f('emoji')} className={inp} maxLength={4} /></Field>
        <Field label="Badge label"><input value={value.badge} onChange={f('badge')} className={inp} placeholder="Limited Time" /></Field>
        <Field label="Headline"><input value={value.headline} onChange={f('headline')} className={inp} placeholder="20% OFF" /></Field>
        <Field label="Sub-line"><input value={value.sub} onChange={f('sub')} className={inp} placeholder="Your first order" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Card background colour">
          <div className="flex items-center gap-2">
            <input type="color" value={value.bg} onChange={f('bg')} className="h-9 w-14 rounded-lg border border-kds-border bg-kds-bg cursor-pointer p-1" />
            <input value={value.bg} onChange={f('bg')} className={`${inp} font-mono w-28`} />
          </div>
        </Field>
        <Field label="Badge background colour">
          <div className="flex items-center gap-2">
            <input type="color" value={value.shadow} onChange={f('shadow')} className="h-9 w-14 rounded-lg border border-kds-border bg-kds-bg cursor-pointer p-1" />
            <input value={value.shadow} onChange={f('shadow')} className={`${inp} font-mono w-28`} />
          </div>
        </Field>
      </div>
      {/* Mini preview */}
      <div className="flex items-center gap-3">
        <div className="h-24 w-20 rounded-xl flex flex-col justify-between p-3 shrink-0" style={{ background: value.bg }}>
          <span className="text-[9px] font-black text-white/80 leading-none truncate px-1.5 py-0.5 rounded-full self-start" style={{ background: value.shadow }}>
            {value.badge || 'Badge'}
          </span>
          <div>
            <div className="text-2xl">{value.emoji}</div>
            <div className="text-white font-black text-sm leading-none">{value.headline || 'Headline'}</div>
            <div className="text-white/50 text-[10px] leading-snug mt-0.5">{value.sub || 'Sub-line'}</div>
          </div>
        </div>
        <p className="text-xs text-kds-subtext">Preview — this is how the deal card will look on the homepage</p>
      </div>
      <div className="flex items-center gap-3 pt-1">
        <button onClick={onSave} disabled={saving || !value.badge || !value.headline}
          className="rounded-xl bg-kds-green text-black font-bold px-5 py-2 text-sm hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="text-sm text-kds-subtext hover:text-kds-text transition-colors">Cancel</button>
      </div>
    </div>
  )
}

// ─── Layout Editor ─────────────────────────────────────────────────────────────

function LayoutEditor({
  blocks,
  onChange,
  onSave,
  saving,
  saved,
  conceptName,
  brandColor,
  slug,
}: {
  blocks: Block[]
  onChange: (blocks: Block[]) => void
  onSave: () => void
  saving: boolean
  saved: boolean
  conceptName: string
  brandColor: string
  slug: string
}) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  const STOREFRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL'] ?? 'http://localhost:3002'

  function move(i: number, dir: -1 | 1) {
    const next = [...blocks]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    const tmp = next[i]!
    next[i] = next[j]!
    next[j] = tmp
    onChange(next)
    setExpanded(j)
  }

  function remove(i: number) {
    onChange(blocks.filter((_, idx) => idx !== i))
    if (expanded === i) setExpanded(null)
    else if (expanded !== null && expanded > i) setExpanded(expanded - 1)
  }

  function addBlock(type: BlockType) {
    const next = [...blocks, mkDefaultBlock(type)]
    onChange(next)
    setExpanded(next.length - 1)
    setShowPicker(false)
  }

  function updateBlock(i: number, patch: Record<string, unknown>) {
    const next = [...blocks]
    next[i] = { ...next[i]!, ...patch } as Block
    onChange(next)
  }

  return (
    <div className="max-w-3xl space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-sm text-kds-subtext">
            Build the page layout for <span className="font-semibold text-kds-text">{conceptName}</span>.
            Add, reorder, and configure sections — changes go live when you save.
          </p>
          <p className="text-xs text-kds-subtext mt-1">
            <span className="font-medium text-kds-text">{blocks.length}</span> section{blocks.length !== 1 ? 's' : ''} ·{' '}
            <a href={`${STOREFRONT_URL}/${slug}`} target="_blank" rel="noopener noreferrer" className="text-kds-green hover:underline">
              preview live page ↗
            </a>
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {saved && <span className="text-sm text-kds-green">✓ Saved</span>}
          <button onClick={onSave} disabled={saving}
            className="rounded-xl bg-kds-green text-black font-bold px-5 py-2 text-sm hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save layout'}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {blocks.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-kds-border py-16 text-center">
          <p className="text-4xl mb-3">📐</p>
          <p className="font-semibold text-kds-text">No sections yet</p>
          <p className="text-sm text-kds-subtext mt-1">Click "Add section" below to start building</p>
        </div>
      )}

      {/* Block list */}
      {blocks.map((block, i) => {
        const meta = BLOCK_META[block.type]
        const isOpen = expanded === i
        return (
          <div key={i}
            className={`rounded-xl border transition-all ${isOpen ? 'border-kds-green shadow-lg shadow-black/20' : 'border-kds-border'} bg-kds-card`}>
            {/* Block header */}
            <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
              onClick={() => setExpanded(isOpen ? null : i)}>
              <span className="text-xl shrink-0">{meta.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-kds-text">{meta.label}</p>
                  <span className="text-xs font-mono text-kds-subtext bg-kds-bg px-1.5 py-0.5 rounded">{block.type}</span>
                </div>
                <p className="text-xs text-kds-subtext truncate mt-0.5">{blockPreview(block)}</p>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button onClick={(e) => { e.stopPropagation(); move(i, -1) }} disabled={i === 0}
                  title="Move up"
                  className="h-7 w-7 flex items-center justify-center rounded-lg text-kds-subtext hover:text-kds-text hover:bg-kds-bg disabled:opacity-25 transition-colors">
                  ↑
                </button>
                <button onClick={(e) => { e.stopPropagation(); move(i, 1) }} disabled={i === blocks.length - 1}
                  title="Move down"
                  className="h-7 w-7 flex items-center justify-center rounded-lg text-kds-subtext hover:text-kds-text hover:bg-kds-bg disabled:opacity-25 transition-colors">
                  ↓
                </button>
                <button onClick={(e) => { e.stopPropagation(); remove(i) }}
                  title="Remove block"
                  className="h-7 w-7 flex items-center justify-center rounded-lg text-kds-subtext hover:text-red-400 hover:bg-red-950/20 transition-colors ml-1">
                  ✕
                </button>
                <span className="text-kds-subtext text-xs ml-2">{isOpen ? '▲' : '▼'}</span>
              </div>
            </div>

            {/* Block form — rendered when expanded */}
            {isOpen && (
              <div className="border-t border-kds-border px-4 pt-4 pb-5">
                <BlockForm block={block} brandColor={brandColor}
                  onChange={(patch) => updateBlock(i, patch)} />
              </div>
            )}
          </div>
        )
      })}

      {/* Add section picker */}
      <div className="relative">
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="w-full rounded-xl border-2 border-dashed border-kds-border py-3 text-sm text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors font-medium">
          {showPicker ? '✕ Close' : '+ Add section'}
        </button>
        {showPicker && (
          <div className="mt-2 rounded-xl border border-kds-border bg-kds-card shadow-2xl p-3 grid grid-cols-3 gap-2">
            {(Object.keys(BLOCK_META) as BlockType[]).map((type) => (
              <button key={type} onClick={() => addBlock(type)}
                className="flex flex-col items-start rounded-xl border border-kds-border/50 p-3 hover:border-kds-green hover:bg-kds-bg transition-colors text-left gap-1">
                <span className="text-2xl">{BLOCK_META[type].icon}</span>
                <p className="text-xs font-semibold text-kds-text leading-tight">{BLOCK_META[type].label}</p>
                <p className="text-xs text-kds-subtext leading-tight">{BLOCK_META[type].desc}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bottom save */}
      {blocks.length > 0 && (
        <div className="flex items-center gap-3 pt-3">
          <button onClick={onSave} disabled={saving}
            className="rounded-xl bg-kds-green text-black font-bold px-6 py-2.5 hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save layout'}
          </button>
          {saved && <span className="text-sm text-kds-green">✓ Saved</span>}
        </div>
      )}
    </div>
  )
}

// ─── Block Form — renders appropriate fields for each block type ───────────────

function BlockForm({
  block,
  brandColor,
  onChange,
}: {
  block: Block
  brandColor: string
  onChange: (patch: Record<string, unknown>) => void
}) {
  const f = (key: string) => (val: unknown) => onChange({ [key]: val })

  switch (block.type) {

    // ── Hero ────────────────────────────────────────────────────────────────
    case 'hero': return (
      <div className="space-y-3">
        <FormRow>
          <Field label="Headline">
            <input value={block.headline ?? ''} onChange={(e) => f('headline')(e.target.value)} className={inp} placeholder="Welcome to Stax" />
          </Field>
          <Field label="Sub-headline">
            <input value={block.subline ?? ''} onChange={(e) => f('subline')(e.target.value)} className={inp} placeholder="A short supporting line" />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="CTA button text">
            <input value={block.ctaText ?? ''} onChange={(e) => f('ctaText')(e.target.value)} className={inp} placeholder="Order now" />
          </Field>
          <Field label="CTA button URL">
            <input value={block.ctaUrl ?? ''} onChange={(e) => f('ctaUrl')(e.target.value)} className={inp} placeholder="#menu" />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Text alignment">
            <Select value={block.textAlign ?? 'center'} onChange={f('textAlign')} options={[['left','Left'],['center','Center'],['right','Right']]} />
          </Field>
        </FormRow>
        <div className="grid grid-cols-3 gap-3 pt-1">
          <ToggleRow label="Use brand colour as background" value={!!block.usesBrandColor} onChange={f('usesBrandColor')} />
          <ToggleRow label="Dark overlay on image" value={!!block.overlay} onChange={f('overlay')} />
          <ToggleRow label="Full viewport height" value={!!block.fullHeight} onChange={f('fullHeight')} />
        </div>
        {!block.usesBrandColor && (
          <Field label="Background image URL">
            <input value={block.imageUrl ?? ''} onChange={(e) => f('imageUrl')(e.target.value)} className={inp} placeholder="https://…" />
          </Field>
        )}
        {block.usesBrandColor && (
          <p className="text-xs text-kds-subtext">
            Background will use <span className="font-mono font-semibold" style={{ color: brandColor }}>{brandColor}</span>. Change the brand colour in the Branding tab.
          </p>
        )}
      </div>
    )

    // ── Announcement ────────────────────────────────────────────────────────
    case 'announcement': return (
      <div className="space-y-3">
        <Field label="Banner text">
          <textarea value={block.text} onChange={(e) => f('text')(e.target.value)} rows={2}
            className={`${inp} resize-none`} placeholder="🔥 New items just dropped — order now!" />
        </Field>
        <FormRow>
          <Field label="Background colour">
            <ColorPicker value={block.bgColor ?? '#f59e0b'} onChange={f('bgColor')} />
          </Field>
          <Field label="Text colour">
            <ColorPicker value={block.textColor ?? '#000000'} onChange={f('textColor')} />
          </Field>
        </FormRow>
      </div>
    )

    // ── Story ───────────────────────────────────────────────────────────────
    case 'story': return (
      <div className="space-y-3">
        <Field label="Heading">
          <input value={block.heading} onChange={(e) => f('heading')(e.target.value)} className={inp} placeholder="Our Story" />
        </Field>
        <Field label="Body text">
          <textarea value={block.body} onChange={(e) => f('body')(e.target.value)} rows={4}
            className={`${inp} resize-none`} placeholder="Tell your brand story here…" />
        </Field>
        <FormRow>
          <Field label="Image URL">
            <input value={block.imageUrl ?? ''} onChange={(e) => f('imageUrl')(e.target.value)} className={inp} placeholder="https://…" />
          </Field>
          <Field label="Image position">
            <Select value={block.imagePosition ?? 'right'} onChange={f('imagePosition')} options={[['left','Left'],['right','Right']]} />
          </Field>
        </FormRow>
        <Field label="Background colour (optional)">
          <ColorPicker value={block.bgColor ?? ''} onChange={f('bgColor')} allowEmpty />
        </Field>
      </div>
    )

    // ── Features ────────────────────────────────────────────────────────────
    case 'features': return (
      <FeaturesForm block={block} onChange={onChange} />
    )

    // ── Menu ────────────────────────────────────────────────────────────────
    case 'menu': return (
      <div className="space-y-3">
        <Field label="Section title (optional)">
          <input value={block.title ?? ''} onChange={(e) => f('title')(e.target.value)} className={inp} placeholder="Our Menu" />
        </Field>
        <Field label="Display layout">
          <Select value={block.layout ?? 'list'} onChange={f('layout')} options={[['list','List (vertical, full detail)'],['grid','Grid (cards, compact)']]} />
        </Field>
        <p className="text-xs text-kds-subtext">
          The menu block pulls live data — items toggled off in Menu Availability will not appear here.
        </p>
      </div>
    )

    // ── Gallery ─────────────────────────────────────────────────────────────
    case 'gallery': return (
      <GalleryForm block={block} onChange={onChange} />
    )

    // ── Quote ───────────────────────────────────────────────────────────────
    case 'quote': return (
      <div className="space-y-3">
        <Field label="Quote text">
          <textarea value={block.text} onChange={(e) => f('text')(e.target.value)} rows={3}
            className={`${inp} resize-none`} placeholder="The food that makes you come back." />
        </Field>
        <Field label="Attribution (optional)">
          <input value={block.author ?? ''} onChange={(e) => f('author')(e.target.value)} className={inp} placeholder="— Happy Customer" />
        </Field>
        <FormRow>
          <Field label="Background colour">
            <ColorPicker value={block.bgColor ?? '#111827'} onChange={f('bgColor')} />
          </Field>
          <Field label="Text colour">
            <ColorPicker value={block.textColor ?? '#ffffff'} onChange={f('textColor')} />
          </Field>
        </FormRow>
      </div>
    )

    // ── CTA ─────────────────────────────────────────────────────────────────
    case 'cta': return (
      <div className="space-y-3">
        <Field label="Heading">
          <input value={block.heading} onChange={(e) => f('heading')(e.target.value)} className={inp} placeholder="Ready to order?" />
        </Field>
        <Field label="Body text (optional)">
          <input value={block.body ?? ''} onChange={(e) => f('body')(e.target.value)} className={inp} placeholder="Fresh food, fast delivery." />
        </Field>
        <FormRow>
          <Field label="Button text">
            <input value={block.buttonText} onChange={(e) => f('buttonText')(e.target.value)} className={inp} placeholder="Order Now" />
          </Field>
          <Field label="Button URL">
            <input value={block.buttonUrl ?? ''} onChange={(e) => f('buttonUrl')(e.target.value)} className={inp} placeholder="#menu" />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Background colour">
            <ColorPicker value={block.bgColor ?? ''} onChange={f('bgColor')} allowEmpty />
          </Field>
          <Field label="Text colour">
            <ColorPicker value={block.textColor ?? ''} onChange={f('textColor')} allowEmpty />
          </Field>
        </FormRow>
      </div>
    )

    // ── Spacer ──────────────────────────────────────────────────────────────
    case 'spacer': return (
      <Field label="Size">
        <Select value={block.size} onChange={f('size')}
          options={[['sm','Small (24px)'],['md','Medium (48px)'],['lg','Large (96px)']]} />
      </Field>
    )
  }
}

// ─── Features block form (manages items array) ────────────────────────────────

function FeaturesForm({ block, onChange }: { block: FeaturesBlock; onChange: (patch: Record<string, unknown>) => void }) {
  function updateItem(i: number, patch: Partial<{ icon: string; title: string; body: string }>) {
    const items = block.items.map((item, idx) => idx === i ? { ...item, ...patch } : item)
    onChange({ items })
  }
  function addItem() {
    onChange({ items: [...block.items, { icon: '⭐', title: 'New Feature', body: 'Description here.' }] })
  }
  function removeItem(i: number) {
    onChange({ items: block.items.filter((_, idx) => idx !== i) })
  }

  return (
    <div className="space-y-4">
      <FormRow>
        <Field label="Section heading (optional)">
          <input value={block.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className={inp} placeholder="Why us?" />
        </Field>
        <Field label="Columns">
          <Select value={String(block.columns ?? 3)} onChange={(v) => onChange({ columns: Number(v) })}
            options={[['2','2 columns'],['3','3 columns'],['4','4 columns']]} />
        </Field>
      </FormRow>

      <div>
        <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Feature cards ({block.items.length})</p>
        <div className="space-y-2">
          {block.items.map((item, i) => (
            <div key={i} className="rounded-xl border border-kds-border/60 p-3 bg-kds-bg/50">
              <div className="flex items-center gap-2 mb-2">
                <input value={item.icon} onChange={(e) => updateItem(i, { icon: e.target.value })}
                  className="w-14 rounded-lg bg-kds-bg border border-kds-border px-2 py-1.5 text-kds-text text-center text-lg"
                  placeholder="🌿" maxLength={4} />
                <input value={item.title} onChange={(e) => updateItem(i, { title: e.target.value })}
                  className={`${inp} flex-1`} placeholder="Feature title" />
                <button onClick={() => removeItem(i)}
                  className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg text-kds-subtext hover:text-red-400 hover:bg-red-950/20 transition-colors">
                  ✕
                </button>
              </div>
              <textarea value={item.body} onChange={(e) => updateItem(i, { body: e.target.value })}
                rows={2} className={`${inp} resize-none`} placeholder="Short description" />
            </div>
          ))}
        </div>
        <button onClick={addItem}
          className="mt-2 w-full rounded-xl border border-dashed border-kds-border py-2 text-xs text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
          + Add card
        </button>
      </div>
    </div>
  )
}

// ─── Gallery block form (manages images array) ────────────────────────────────

function GalleryForm({ block, onChange }: { block: GalleryBlock; onChange: (patch: Record<string, unknown>) => void }) {
  const [newUrl, setNewUrl] = useState('')

  function addImage() {
    const url = newUrl.trim()
    if (!url) return
    onChange({ images: [...block.images, url] })
    setNewUrl('')
  }
  function removeImage(i: number) {
    onChange({ images: block.images.filter((_, idx) => idx !== i) })
  }
  function updateImage(i: number, val: string) {
    onChange({ images: block.images.map((img, idx) => idx === i ? val : img) })
  }

  return (
    <div className="space-y-3">
      <FormRow>
        <Field label="Section heading (optional)">
          <input value={block.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className={inp} placeholder="Gallery" />
        </Field>
        <Field label="Columns">
          <Select value={String(block.columns ?? 3)} onChange={(v) => onChange({ columns: Number(v) })}
            options={[['2','2 columns'],['3','3 columns'],['4','4 columns']]} />
        </Field>
      </FormRow>

      <div>
        <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Images ({block.images.length})</p>
        <div className="space-y-2">
          {block.images.map((img, i) => (
            <div key={i} className="flex items-center gap-2">
              {img && <img src={img} alt="" className="h-8 w-8 rounded object-cover shrink-0 border border-kds-border" />}
              <input value={img} onChange={(e) => updateImage(i, e.target.value)}
                className={`${inp} flex-1`} placeholder="https://…" />
              <button onClick={() => removeImage(i)}
                className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg text-kds-subtext hover:text-red-400 hover:bg-red-950/20 transition-colors">
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addImage()}
            className={`${inp} flex-1`} placeholder="Paste image URL and press Add" />
          <button onClick={addImage}
            className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Category schedule row ────────────────────────────────────────────────────

function CategoryScheduleRow({ cat, onSave }: { cat: Category; onSave: (body: Record<string, unknown>) => void }) {
  const [start, setStart] = useState(cat.timeRestrictionStart ?? '')
  const [end, setEnd] = useState(cat.timeRestrictionEnd ?? '')
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  function save() {
    onSave({ timeRestrictionStart: start || null, timeRestrictionEnd: end || null })
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="rounded-xl border border-kds-border bg-kds-card px-4 py-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="font-semibold text-kds-text">{cat.name}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-kds-subtext">From</label>
            <input type="time" value={start} onChange={(e) => { setStart(e.target.value); setDirty(true) }}
              className="rounded-lg bg-kds-bg border border-kds-border px-2 py-1.5 text-kds-text text-sm" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-kds-subtext">To</label>
            <input type="time" value={end} onChange={(e) => { setEnd(e.target.value); setDirty(true) }}
              className="rounded-lg bg-kds-bg border border-kds-border px-2 py-1.5 text-kds-text text-sm" />
          </div>
          {(start || end) && (
            <button onClick={() => { setStart(''); setEnd(''); setDirty(true) }}
              className="text-xs text-kds-subtext hover:text-kds-red transition-colors">Clear</button>
          )}
          {dirty && (
            <button onClick={save} className="rounded-lg bg-kds-green text-black font-bold px-3 py-1.5 text-xs hover:opacity-90">Save</button>
          )}
          {saved && <span className="text-xs text-kds-green">✓</span>}
        </div>
      </div>
      <p className="text-xs text-kds-subtext mt-1.5">
        {start && end ? `Shown ${start} – ${end} only` : start ? `Shown from ${start}` : end ? `Shown until ${end}` : 'Always visible'}
      </p>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-kds-green' : 'bg-kds-border'}`}>
      <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: unknown) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-kds-border/50 px-3 py-2 bg-kds-bg/30">
      <span className="text-xs text-kds-subtext">{label}</span>
      <Toggle value={value} onChange={onChange} />
    </div>
  )
}

function ColorPicker({ value, onChange, allowEmpty }: { value: string; onChange: (v: unknown) => void; allowEmpty?: boolean }) {
  const safe = value && value.startsWith('#') ? value : '#6366f1'
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={safe} onChange={(e) => onChange(e.target.value)}
        className="h-9 w-14 rounded-lg border border-kds-border bg-kds-bg cursor-pointer p-1" />
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className={`${inp} font-mono w-28`} placeholder={allowEmpty ? 'auto' : '#000000'} />
      {allowEmpty && value && (
        <button onClick={() => onChange('')} className="text-xs text-kds-subtext hover:text-kds-red transition-colors">Clear</button>
      )}
    </div>
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: unknown) => void; options: [string, string][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`${inp} cursor-pointer`}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

function FormRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">{label}</p>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-kds-subtext">
        {label}{hint && <span className="ml-1 font-normal opacity-60"> — {hint}</span>}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

const inp = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none transition-colors'

function isLight(hex: string): boolean {
  const c = hex.replace('#', '')
  if (c.length !== 6) return false
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}
