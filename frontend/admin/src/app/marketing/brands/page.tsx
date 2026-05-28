'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { TenantChip, useMyTenants } from '../../../components/ui/TenantPicker'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Concept {
  id: string
  name: string
  slug: string
  type: 'restaurant' | 'digital' | 'cart'
  description: string | null
  logoUrl: string | null
  primaryColor: string | null
  taxRate: number
  isActive: boolean
  storefrontVisible: boolean
  reservationsEnabled: boolean
  heroTagline: string | null
  announcementBanner: string | null
  latitude: number | null
  longitude: number | null
  deliveryRadiusKm: number
  strn: string | null
  ntn: string | null
  province: string | null
  invoiceLegalName: string | null
  invoiceAddress: string | null
  invoicePrefix: string | null
  fbrPosId: number | null
  // Surfaced by the backend in portfolio mode so the operator can tell which
  // company each brand belongs to without bouncing out of "All companies".
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
}

const PROVINCES = [
  { code: 'PB',  label: 'Punjab' },
  { code: 'SD',  label: 'Sindh' },
  { code: 'KP',  label: 'Khyber Pakhtunkhwa' },
  { code: 'BL',  label: 'Balochistan' },
  { code: 'ICT', label: 'Islamabad Capital Territory' },
  { code: 'GB',  label: 'Gilgit-Baltistan' },
  { code: 'AJK', label: 'Azad Jammu & Kashmir' },
]

export default function BrandEditorPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: tenants = [] } = useMyTenants()
  const { data: concepts = [], isLoading } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  useEffect(() => {
    if (!selectedId && concepts.length > 0) setSelectedId(concepts[0]!.id)
  }, [concepts, selectedId])

  const selected = concepts.find((c) => c.id === selectedId) ?? null

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Marketing</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Brand Editor</h1>
        <p className="text-sm text-white/40 mt-1">
          Edit every brand-facing field — logo, tagline, hero, hours, delivery radius, tax invoice details.
        </p>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Brand list */}
        <aside className="w-72 shrink-0 border-r border-white/[0.05] overflow-y-auto p-3 space-y-1">
          {isLoading && <p className="text-sm text-white/40">Loading…</p>}
          {concepts.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className="w-full text-left rounded-xl p-3 transition-colors"
              style={{
                background: c.id === selectedId ? 'rgba(0,212,177,0.08)' : 'transparent',
                border: c.id === selectedId ? '1px solid rgba(0,212,177,0.35)' : '1px solid transparent',
              }}
            >
              <div className="flex items-center gap-3">
                {c.logoUrl ? (
                  <img src={c.logoUrl} alt={c.name} className="h-8 w-8 rounded-lg object-cover" />
                ) : (
                  <div className="h-8 w-8 rounded-lg flex items-center justify-center text-xs font-black"
                    style={{ background: c.primaryColor ?? '#3D4452', color: '#fff' }}>
                    {c.name[0]?.toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="font-bold text-sm text-white/85 truncate">{c.name}</p>
                    {!c.isActive && <span className="text-[9px] font-bold text-white/30 px-1 py-0.5 rounded bg-white/5">PAUSED</span>}
                    {/* Indigo brand chip in portfolio view — shows which
                        company this brand belongs to so the CEO doesn't have
                        to flip out of "All companies" to know. */}
                    <TenantChip tenant={c.tenant} tenantId={c.tenantId} tenants={tenants} />
                  </div>
                  <p className="text-[10px] text-white/35 font-mono">{c.slug} · {c.type}</p>
                </div>
              </div>
            </button>
          ))}
          <Link href="/settings"
            className="block rounded-xl border border-dashed border-white/10 p-3 text-center text-xs text-white/45 hover:text-white hover:border-white/30">
            + Add brand (Settings)
          </Link>
        </aside>

        {/* Editor */}
        <main className="flex-1 overflow-y-auto p-7">
          {selected ? (
            <BrandForm concept={selected} />
          ) : (
            <div className="text-center mt-20 text-white/40">Select a brand to edit</div>
          )}
        </main>
      </div>
    </div>
  )
}

function BrandForm({ concept }: { concept: Concept }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'identity' | 'storefront' | 'delivery' | 'tax'>('identity')

  // Form state
  const [name, setName] = useState(concept.name)
  const [description, setDescription] = useState(concept.description ?? '')
  const [logoUrl, setLogoUrl] = useState(concept.logoUrl ?? '')
  const [primaryColor, setPrimaryColor] = useState(concept.primaryColor ?? '#00D4B1')
  const [isActive, setIsActive] = useState(concept.isActive)

  const [heroTagline, setHeroTagline] = useState(concept.heroTagline ?? '')
  const [announcementBanner, setAnnouncementBanner] = useState(concept.announcementBanner ?? '')
  const [storefrontVisible, setStorefrontVisible] = useState(concept.storefrontVisible)
  const [reservationsEnabled, setReservationsEnabled] = useState(concept.reservationsEnabled)

  const [latitude, setLatitude] = useState(concept.latitude !== null ? String(concept.latitude) : '')
  const [longitude, setLongitude] = useState(concept.longitude !== null ? String(concept.longitude) : '')
  const [deliveryRadiusKm, setDeliveryRadiusKm] = useState(String(concept.deliveryRadiusKm))

  const [taxRate, setTaxRate] = useState(String(concept.taxRate))
  const [strn, setStrn] = useState(concept.strn ?? '')
  const [ntn, setNtn] = useState(concept.ntn ?? '')
  const [province, setProvince] = useState(concept.province ?? '')
  const [invoiceLegalName, setInvoiceLegalName] = useState(concept.invoiceLegalName ?? '')
  const [invoiceAddress, setInvoiceAddress] = useState(concept.invoiceAddress ?? '')
  const [invoicePrefix, setInvoicePrefix] = useState(concept.invoicePrefix ?? '')
  const [fbrPosId, setFbrPosId] = useState(concept.fbrPosId !== null ? String(concept.fbrPosId) : '')

  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Re-sync when the user picks a different brand from the sidebar
  useEffect(() => {
    setName(concept.name); setDescription(concept.description ?? ''); setLogoUrl(concept.logoUrl ?? '')
    setPrimaryColor(concept.primaryColor ?? '#00D4B1'); setIsActive(concept.isActive)
    setHeroTagline(concept.heroTagline ?? ''); setAnnouncementBanner(concept.announcementBanner ?? '')
    setStorefrontVisible(concept.storefrontVisible)
    setReservationsEnabled(concept.reservationsEnabled)
    setLatitude(concept.latitude !== null ? String(concept.latitude) : '')
    setLongitude(concept.longitude !== null ? String(concept.longitude) : '')
    setDeliveryRadiusKm(String(concept.deliveryRadiusKm))
    setTaxRate(String(concept.taxRate))
    setStrn(concept.strn ?? ''); setNtn(concept.ntn ?? ''); setProvince(concept.province ?? '')
    setInvoiceLegalName(concept.invoiceLegalName ?? ''); setInvoiceAddress(concept.invoiceAddress ?? '')
    setInvoicePrefix(concept.invoicePrefix ?? '')
    setFbrPosId(concept.fbrPosId !== null ? String(concept.fbrPosId) : '')
  }, [concept.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api.patch(`/concepts/${concept.id}`, {
      name, description: description || null, logoUrl: logoUrl || null,
      primaryColor: primaryColor || null, isActive,
      heroTagline: heroTagline || null, announcementBanner: announcementBanner || null,
      storefrontVisible,
      reservationsEnabled,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      deliveryRadiusKm: parseFloat(deliveryRadiusKm) || 0,
      taxRate: parseFloat(taxRate) || 0,
      strn: strn || null, ntn: ntn || null, province: province || null,
      invoiceLegalName: invoiceLegalName || null, invoiceAddress: invoiceAddress || null,
      invoicePrefix: invoicePrefix || null,
      fbrPosId: fbrPosId ? parseInt(fbrPosId, 10) : null,
    }),
    onSuccess: () => {
      setSavedAt(Date.now())
      void qc.invalidateQueries({ queryKey: ['concepts'] })
    },
  })

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true); setUploadError('')
    try {
      const token = useAuthStore.getState().token   // F43
      const qs = new URLSearchParams({ filename: file.name, contentType: file.type, category: 'marketing' })
      const res = await fetch(`${API_URL}/api/v1/media/upload-url?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to get upload URL')
      const { uploadUrl, publicUrl } = await res.json() as { uploadUrl: string; publicUrl: string }
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
      setLogoUrl(publicUrl)
    } catch {
      setUploadError('Upload failed — check R2 setup in Configuration → Integrations')
    } finally {
      setUploading(false)
    }
  }

  const TABS: Array<{ key: typeof tab; label: string; emoji: string }> = [
    { key: 'identity',   label: 'Identity',   emoji: '🏷' },
    { key: 'storefront', label: 'Storefront', emoji: '🛍' },
    { key: 'delivery',   label: 'Delivery',   emoji: '🛵' },
    { key: 'tax',        label: 'Tax & FBR',  emoji: '🧾' },
  ]

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Top header strip */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-black text-white/90">{concept.name}</h2>
          <p className="text-xs text-white/40 mt-1">{concept.slug} · type: {concept.type}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/storefront`} className="text-xs text-white/55 hover:text-white">
            Edit storefront layout →
          </Link>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2 text-xs font-black text-black hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      {savedAt && Date.now() - savedAt < 4000 && (
        <p className="text-xs text-kds-green">✓ Saved</p>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.05]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2.5 text-xs font-bold transition-all relative"
            style={{ color: tab === t.key ? '#00D4B1' : 'rgba(255,255,255,0.45)' }}
          >
            {t.emoji} {t.label}
            {tab === t.key && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-0.5" style={{ background: '#00D4B1' }} />
            )}
          </button>
        ))}
      </div>

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      {tab === 'identity' && (
        <div className="space-y-5">
          <Section title="Brand identity" subtitle="Name, logo, primary colour, description">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {/* Logo upload */}
              <div>
                <label className="text-xs text-white/55 block mb-2">Logo</label>
                <div className="aspect-square rounded-xl overflow-hidden flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {logoUrl ? (
                    <img src={logoUrl} alt={name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl opacity-40">🏷</span>
                  )}
                </div>
                <label className="block mt-2 cursor-pointer rounded-lg bg-white/5 hover:bg-white/10 text-center py-2 text-xs font-bold text-white/85">
                  {uploading ? 'Uploading…' : '📤 Upload new logo'}
                  <input type="file" accept="image/*" className="sr-only" onChange={handleLogoUpload} />
                </label>
                {uploadError && <p className="text-[10px] text-kds-red mt-1">{uploadError}</p>}
              </div>

              {/* Name + description */}
              <div className="sm:col-span-2 space-y-3">
                <Field label="Display name *">
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    className="s-input w-full" />
                </Field>
                <Field label="Description" hint="Shown on /brand/<slug> microsite + admin tooltips.">
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                    placeholder="e.g. Smash burgers and loaded fries. House-made sauces, double-smash technique."
                    className="s-input w-full resize-none" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Primary colour" hint="Used as accent across brand microsite + dashboards.">
                    <div className="flex items-center gap-2">
                      <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
                        className="h-10 w-12 rounded-lg cursor-pointer bg-transparent border border-white/10" />
                      <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
                        className="s-input flex-1 font-mono text-xs" placeholder="#00D4B1" />
                    </div>
                  </Field>
                  <Field label="Status">
                    <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                      <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-kds-green" />
                      Brand is active
                    </label>
                  </Field>
                </div>
              </div>
            </div>
          </Section>
        </div>
      )}

      {/* ── Storefront ───────────────────────────────────────────────────── */}
      {tab === 'storefront' && (
        <div className="space-y-5">
          <Section title="Public storefront" subtitle="Customer-facing copy on the brand microsite">
            <div className="space-y-4">
              <Field label="Hero tagline" hint="One punchy line under the brand name. Max 120 chars.">
                <input value={heroTagline} onChange={(e) => setHeroTagline(e.target.value)} maxLength={120}
                  placeholder="e.g. Late-night biryani with a side of jazz."
                  className="s-input w-full" />
              </Field>
              <Field label="Announcement banner" hint="Big pinned message at the top. Use for closures, promos, holidays. Empty = no banner.">
                <input value={announcementBanner} onChange={(e) => setAnnouncementBanner(e.target.value)} maxLength={300}
                  placeholder="e.g. Closed for Eid 10–12 May. Pre-order opens 13 May."
                  className="s-input w-full" />
              </Field>
              <Field label="Storefront visibility">
                <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                  <input type="checkbox" checked={storefrontVisible} onChange={(e) => setStorefrontVisible(e.target.checked)} className="accent-kds-green" />
                  Show on the customer ordering page
                </label>
                <p className="text-[10px] text-white/35 mt-1">Uncheck to hide from /browse without disabling the brand entirely.</p>
              </Field>
              <Field label="Reservations">
                <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                  <input type="checkbox" checked={reservationsEnabled} onChange={(e) => setReservationsEnabled(e.target.checked)} className="accent-kds-green" />
                  Accept table reservations for this brand
                </label>
                <p className="text-[10px] text-white/35 mt-1">Uncheck for takeaway-only / ghost-kitchen brands. Hides the "Book a table" CTA on the storefront and brand microsite. Staff can still take phone bookings via the admin.</p>
              </Field>
            </div>
          </Section>
          <div className="rounded-xl p-4 text-xs text-white/55"
            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)' }}>
            💡 For the visual page builder (hero blocks, gallery, menu strip, footer), open <Link href="/storefront" className="text-kds-green underline">Storefront Designer</Link> — that's the layout-level editor.
          </div>
        </div>
      )}

      {/* ── Delivery ─────────────────────────────────────────────────────── */}
      {tab === 'delivery' && (
        <Section title="Delivery geography" subtitle="Where you deliver from + radius for your own fleet">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Latitude" hint="Decimal degrees, e.g. 31.5204">
              <input value={latitude} onChange={(e) => setLatitude(e.target.value)}
                placeholder="31.5204" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="Longitude" hint="Decimal degrees, e.g. 74.3587">
              <input value={longitude} onChange={(e) => setLongitude(e.target.value)}
                placeholder="74.3587" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="Delivery radius (km)" hint="Customers outside this radius see 'pickup only'.">
              <input value={deliveryRadiusKm} onChange={(e) => setDeliveryRadiusKm(e.target.value)}
                type="number" step="0.5" min="0" max="50" className="s-input w-full" />
            </Field>
          </div>
        </Section>
      )}

      {/* ── Tax & FBR ────────────────────────────────────────────────────── */}
      {tab === 'tax' && (
        <Section title="Tax & FBR invoicing" subtitle="Required for Tier-1 businesses under SRO 1307(I)/2022">
          <Field label="GST rate %" hint="Standard rate 17%. Override per item in Menu Editor for reduced/exempt items.">
            <input value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
              type="number" step="0.1" min="0" max="100" className="s-input w-full max-w-[140px]" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="STRN" hint="Sales Tax Registration Number from FBR.">
              <input value={strn} onChange={(e) => setStrn(e.target.value)}
                placeholder="03-12-3456-789-12" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="NTN" hint="National Tax Number.">
              <input value={ntn} onChange={(e) => setNtn(e.target.value)}
                placeholder="1234567-8" className="s-input w-full font-mono text-sm" />
            </Field>
          </div>
          <Field label="Province" hint="Used for provincial sales tax + FBR routing.">
            <select value={province} onChange={(e) => setProvince(e.target.value)}
              className="s-input w-full max-w-md">
              <option value="">Select province…</option>
              {PROVINCES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Invoice legal name" hint="Registered entity name printed on tax invoices.">
            <input value={invoiceLegalName} onChange={(e) => setInvoiceLegalName(e.target.value)}
              placeholder="GS Foods (Pvt) Ltd."
              className="s-input w-full" />
          </Field>
          <Field label="Invoice address" hint="Billing address printed on tax invoices.">
            <textarea value={invoiceAddress} onChange={(e) => setInvoiceAddress(e.target.value)} rows={2}
              placeholder="House #5, Street 12, DHA Phase 2, Lahore."
              className="s-input w-full resize-none" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Invoice prefix" hint="Concept-scoped sequence prefix, e.g. STX-">
              <input value={invoicePrefix} onChange={(e) => setInvoicePrefix(e.target.value)}
                placeholder="STX-" maxLength={10}
                className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="FBR POS ID" hint="POSID assigned by FBR PRAL at registration. Required for real-time submission.">
              <input value={fbrPosId} onChange={(e) => setFbrPosId(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="123456" className="s-input w-full font-mono text-sm" />
            </Field>
          </div>
          {(!strn || !ntn || !invoiceLegalName) && (
            <div className="rounded-xl p-3 text-xs text-amber-400"
              style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
              ⚠ FBR submission requires STRN, NTN, and Legal name. Until those are filled, completed orders skip the invoicing worker.
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

// ─── Tiny presentational helpers ──────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div>
        <h3 className="font-black text-white/90">{title}</h3>
        {subtitle && <p className="text-xs text-white/45 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55 block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/35 mt-1">{hint}</p>}
    </div>
  )
}
