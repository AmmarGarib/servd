'use client'
import { useState, useEffect, useId, isValidElement, cloneElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { TenantChip, useMyTenants } from '../../../components/ui/TenantPicker'
import { BrandKitCard } from '../../../components/storefront/BrandKitCard'
import { Select } from '@/components/ui/Select'

interface Concept {
  id: string
  name: string
  slug: string
  type: 'restaurant' | 'digital' | 'cart'
  description: string | null
  logoUrl: string | null
  primaryColor: string | null
  isActive: boolean
  storefrontVisible: boolean
  reservationsEnabled: boolean
  /** The brand's primary service vessel: 'plate' or 'packaging' (the packaging IS the serving vessel). */
  serviceVessel?: 'plate' | 'packaging'
  heroTagline: string | null
  // Brand microsite artwork. Null = the storefront falls back to the file
  // bundled in its build, which is how every brand behaved before these
  // existed — so clearing one is safe, not a broken image.
  wordmarkUrl: string | null
  mascotUrl: string | null
  // Contact — per brand (owner decision 18).
  phone: string | null
  whatsapp: string | null
  email: string | null
  addressLocality: string | null
  // The brand's public profiles: social profile links (https, up to 12) and
  // the Google Maps / Business Profile link. Published as the brand's
  // schema.org sameAs / hasMap and used by the brand pages' social buttons.
  sameAs?: string[]
  googleMapsUrl?: string | null
  // Read-only mirror of the brand's primary Location (decision 18). Edited
  // on Storefront → Locations, never here.
  address: string | null
  latitude: number | null
  longitude: number | null
  // Brand brief (captured at onboarding, editable here).
  conceptStatement: string | null
  cuisine: string | null
  heroProduct: string | null
  anchoringExperience: string | null
  targetCustomer: string | null
  priceTier: string | null
  daypartFocus: string[]
  competitors: string[]
  differentiator: string | null
  brandVoice: string | null
  // Tax — every order is charged at the tender split; the legacy single
  // taxRate is not edited here.
  taxRateCash: number
  taxRateCard: number
  forecastPortionsPerMonth: number
  strn: string | null
  ntn: string | null
  province: string | null
  invoiceLegalName: string | null
  invoiceAddress: string | null
  invoicePrefix: string | null
  // fbrPosId / srbPosId still exist on the brand (the ledger reads srbPosId),
  // but their one editor is Dev → API → POS connector (/connectors/pos).
  // Surfaced by the backend in portfolio mode so the operator can tell which
  // company each brand belongs to without bouncing out of "All companies".
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
  // GET /concepts?view=brand marks every row 'full' (the editor is CEO only).
  brandEditorAccess?: 'full'
}

/** Most profile links a brand may list (the backend's MAX_PROFILE_LINKS). */
const MAX_PROFILE_LINKS = 12

/** A link the backend will accept: a full https:// address. */
function isProfileUrl(v: string): boolean {
  if (!v || v.length > 500 || /\s/.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.')
  } catch {
    return false
  }
}

/** One link per line → the list the API stores (blanks and repeats dropped). */
function profileLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** A plain-words problem with the profile fields, or '' when they are fine. */
function profileProblem(sameAsText: string, mapsUrl: string): string {
  const links = profileLines(sameAsText)
  const bad = links.find((l) => !isProfileUrl(l))
  if (bad) return `Social profiles: "${bad.slice(0, 60)}" is not a full https:// link.`
  if (links.length > MAX_PROFILE_LINKS) return `Social profiles: at most ${MAX_PROFILE_LINKS} links.`
  if (mapsUrl.trim() && !isProfileUrl(mapsUrl.trim())) return 'Google Maps / Business Profile link: use the full https:// link.'
  return ''
}

interface LocationRow {
  id: string
  name: string
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  isActive: boolean
  concepts: Array<{ conceptId: string; isPrimary: boolean }>
}

interface ZoneRow {
  id: string
  tenantId: string | null
  conceptId: string | null
  name: string
  radiusKmMin: number | null
  radiusKmMax: number | null
  feeCents: number
  minOrderCents: number
  isActive: boolean
}

const PRICE_TIERS = [
  { value: '',        label: '— pick —' },
  { value: 'budget',  label: 'Budget ($)' },
  { value: 'mid',     label: 'Mid ($$)' },
  { value: 'premium', label: 'Premium ($$$)' },
  { value: 'luxury',  label: 'Luxury ($$$$)' },
]

const DAYPARTS = ['breakfast', 'lunch', 'afternoon', 'dinner', 'late_night']

const PROVINCES = [
  { code: 'SD',  label: 'Sindh' },
  { code: 'ICT', label: 'Islamabad Capital Territory' },
  { code: 'GB',  label: 'Gilgit-Baltistan' },
  { code: 'AJK', label: 'Azad Jammu & Kashmir' },
]

export default function BrandEditorPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: tenants = [] } = useMyTenants()
  // includeInactive: this is the ONE brand editor, so it is also where a
  // retired brand (isActive=false) is seen and reactivated. Everywhere else
  // in the admin retired brands are hidden. view=brand: the full rows, for
  // the CEO only (owner, 2026-10-14 — Brands is a CEO-only module).
  const { data: concepts = [], isLoading } = useQuery<Concept[]>({
    queryKey: ['concepts', 'brand-editor'],
    queryFn: () => api.get('/concepts?view=brand&includeInactive=1'),
  })

  // /ceo/brands?id=<conceptId> opens that brand (the "new brand" flow
  // lands here). Read once on mount; the picker drives it afterwards.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('id')
    if (want) setSelectedId(want)
  }, [])

  useEffect(() => {
    if (concepts.length === 0) return
    if (!selectedId || !concepts.some((c) => c.id === selectedId)) setSelectedId(concepts[0]!.id)
  }, [concepts, selectedId])

  const selected = concepts.find((c) => c.id === selectedId) ?? null

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">CEO</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Brand Editor</h1>
        <p className="text-sm text-white/40 mt-1">
          The one place a brand is edited — identity, contact, brief, storefront copy and tax. The kitchen address and map pin
          live on <Link href="/configuration/locations" className="text-primary-ink hover:underline">Locations</Link>, delivery
          coverage on <Link href="/configuration/delivery-zones" className="text-primary-ink hover:underline">Delivery zones</Link>.
        </p>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Brand picker — compact dropdown below lg so the editor stays reachable
            on phone/tablet where the 288px sidebar would overflow the viewport. */}
        <div className="lg:hidden shrink-0 border-b border-white/[0.05] p-3">
          <Select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
            className="s-input w-full">
            {isLoading && <option value="">Loading…</option>}
            {concepts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{!c.isActive ? ' (retired)' : ''} · {c.slug}
              </option>
            ))}
          </Select>
        </div>

        {/* Brand list */}
        <aside className="hidden lg:block w-72 shrink-0 border-r border-white/[0.05] overflow-y-auto p-3 space-y-1">
          {isLoading && <p className="text-sm text-white/40">Loading…</p>}
          {concepts.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className="w-full text-left rounded-xl p-3 transition-colors"
              style={{
                background: c.id === selectedId ? 'rgb(var(--erp-primary-rgb) / 0.08)' : 'transparent',
                border: c.id === selectedId ? '1px solid rgb(var(--erp-primary-rgb) / 0.35)' : '1px solid transparent',
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
                    {!c.isActive && <span className="text-[9px] font-bold text-white/30 px-1 py-0.5 rounded bg-white/5">RETIRED</span>}
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
          <Link href="/onboarding"
            className="block rounded-xl border border-dashed border-white/10 p-3 text-center text-xs text-white/45 hover:text-white hover:border-white/30">
            + Add brand
          </Link>
        </aside>

        {/* Editor */}
        <main className="flex-1 overflow-y-auto p-7">
          {selected ? (
            <BrandForm key={selected.id} concept={selected} onDeleted={() => setSelectedId(null)} />
          ) : (
            <div className="text-center mt-20 text-white/40">Select a brand to edit</div>
          )}
        </main>
      </div>
    </div>
  )
}

type TabKey = 'identity' | 'contact' | 'brief' | 'storefront' | 'delivery' | 'tax'

function BrandForm({ concept, onDeleted }: { concept: Concept; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabKey>('identity')

  // Form state. The component is keyed on the brand id, so picking another
  // brand remounts it with fresh state — no re-sync effect needed.
  const [name, setName] = useState(concept.name)
  const [description, setDescription] = useState(concept.description ?? '')
  const [isActive, setIsActive] = useState(concept.isActive)
  const [serviceVessel, setServiceVessel] = useState<'plate' | 'packaging' | ''>(concept.serviceVessel ?? '')

  const [phone, setPhone] = useState(concept.phone ?? '')
  const [whatsapp, setWhatsapp] = useState(concept.whatsapp ?? '')
  const [email, setEmail] = useState(concept.email ?? '')
  const [addressLocality, setAddressLocality] = useState(concept.addressLocality ?? '')
  const [sameAsText, setSameAsText] = useState((concept.sameAs ?? []).join('\n'))
  const [googleMapsUrl, setGoogleMapsUrl] = useState(concept.googleMapsUrl ?? '')
  const profileError = profileProblem(sameAsText, googleMapsUrl)

  const [conceptStatement, setConceptStatement] = useState(concept.conceptStatement ?? '')
  const [cuisine, setCuisine] = useState(concept.cuisine ?? '')
  const [priceTier, setPriceTier] = useState(concept.priceTier ?? '')
  const [heroProduct, setHeroProduct] = useState(concept.heroProduct ?? '')
  const [anchoringExperience, setAnchoringExperience] = useState(concept.anchoringExperience ?? '')
  const [targetCustomer, setTargetCustomer] = useState(concept.targetCustomer ?? '')
  const [differentiator, setDifferentiator] = useState(concept.differentiator ?? '')
  const [brandVoice, setBrandVoice] = useState(concept.brandVoice ?? '')
  const [daypartFocus, setDaypartFocus] = useState<string[]>(concept.daypartFocus ?? [])
  const [competitors, setCompetitors] = useState((concept.competitors ?? []).join(', '))

  const [heroTagline, setHeroTagline] = useState(concept.heroTagline ?? '')
  const [storefrontVisible, setStorefrontVisible] = useState(concept.storefrontVisible)
  const [reservationsEnabled, setReservationsEnabled] = useState(concept.reservationsEnabled)

  const [taxRateCash, setTaxRateCash] = useState(String(concept.taxRateCash ?? 15))
  const [taxRateCard, setTaxRateCard] = useState(String(concept.taxRateCard ?? 8))
  const [forecastPortions, setForecastPortions] = useState(String(concept.forecastPortionsPerMonth ?? 0))
  const [strn, setStrn] = useState(concept.strn ?? '')
  const [ntn, setNtn] = useState(concept.ntn ?? '')
  const [province, setProvince] = useState(concept.province ?? '')
  const [invoiceLegalName, setInvoiceLegalName] = useState(concept.invoiceLegalName ?? '')
  const [invoiceAddress, setInvoiceAddress] = useState(concept.invoiceAddress ?? '')
  const [invoicePrefix, setInvoicePrefix] = useState(concept.invoicePrefix ?? '')

  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const num = (v: string, fallback: number) => {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : fallback
  }

  const save = useMutation({
    mutationFn: () => api.patch(`/concepts/${concept.id}`, {
      name, description: description || null, isActive,
      ...(serviceVessel ? { serviceVessel } : {}),
      phone: phone.trim() || null,
      // wa.me wants digits only — strip what people paste (+, spaces, dashes).
      whatsapp: whatsapp.replace(/[^\d]/g, '') || null,
      email: email.trim().toLowerCase() || null,
      addressLocality: addressLocality.trim() || null,
      sameAs: profileLines(sameAsText),
      googleMapsUrl: googleMapsUrl.trim() || null,
      conceptStatement: conceptStatement || null,
      cuisine: cuisine || null,
      priceTier: priceTier || null,
      heroProduct: heroProduct || null,
      anchoringExperience: anchoringExperience || null,
      targetCustomer: targetCustomer || null,
      differentiator: differentiator || null,
      brandVoice: brandVoice || null,
      daypartFocus,
      competitors: competitors.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 10),
      heroTagline: heroTagline || null,
      storefrontVisible,
      reservationsEnabled,
      taxRateCash: num(taxRateCash, 15),
      taxRateCard: num(taxRateCard, 8),
      forecastPortionsPerMonth: Math.max(0, Math.round(num(forecastPortions, 0))),
      strn: strn || null, ntn: ntn || null, province: province || null,
      invoiceLegalName: invoiceLegalName || null, invoiceAddress: invoiceAddress || null,
      invoicePrefix: invoicePrefix || null,
      // POS ids are NOT sent from here — the POS connector page owns them.
    }),
    onSuccess: () => {
      setSavedAt(Date.now()); setSaveError('')
      void qc.invalidateQueries({ queryKey: ['concepts'] })
    },
    onError: (err) => setSaveError((err as Error).message || 'Save failed'),
  })

  // Soft delete: the backend stamps deletedAt + isActive=false so historical
  // orders and books still resolve the name; the brand leaves every picker,
  // the POS and the storefront.
  const del = useMutation({
    mutationFn: () => api.delete(`/concepts/${concept.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concepts'] })
      onDeleted()
    },
  })

  const TABS: Array<{ key: TabKey; label: string; emoji: string }> = [
    { key: 'identity',   label: 'Identity',   emoji: '🏷' },
    { key: 'contact',    label: 'Contact',    emoji: '📞' },
    { key: 'brief',      label: 'Brief',      emoji: '🧭' },
    { key: 'storefront', label: 'Storefront', emoji: '🛍' },
    { key: 'delivery',   label: 'Kitchen & delivery', emoji: '📍' },
    { key: 'tax',        label: 'Tax registration', emoji: '🧾' },
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
            onClick={() => {
              // A bad profile link would be refused by the API; say which one here.
              if (profileError) { setSaveError(profileError); setTab('contact'); return }
              save.mutate()
            }}
            disabled={save.isPending}
            className="rounded-xl bg-primary px-5 py-2 text-xs font-black text-primary-on hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      {savedAt && Date.now() - savedAt < 4000 && (
        <p className="text-xs text-primary-ink">✓ Saved</p>
      )}
      {saveError && <p className="text-xs text-s-red">{saveError}</p>}
      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.05] overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2.5 text-xs font-bold transition-all relative shrink-0"
            style={{ color: tab === t.key ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.45)' }}
          >
            {t.emoji} {t.label}
            {tab === t.key && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-0.5" style={{ background: 'var(--erp-primary)' }} />
            )}
          </button>
        ))}
      </div>

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      {tab === 'identity' && (
        <div className="space-y-5">
          <Section title="Brand identity" subtitle="Name and description">
            <div className="space-y-3">
              <Field label="Display name *">
                <input value={name} onChange={(e) => setName(e.target.value)}
                  className="s-input w-full" />
              </Field>
              <Field label="Description" hint="Shown in page titles, JSON-LD and cross-brand cards on the storefront.">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                  className="s-input w-full resize-none" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                  <Field label="Status" hint="Off = retired: hidden from the POS, pickers and the storefront. History is kept.">
                    <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                      <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-primary" />
                      Brand is active
                    </label>
                  </Field>
              </div>
            </div>
          </Section>

          <Section title="Brand kit" subtitle="Colours, fonts and pictures. Read-only here: they are set in Storefront → Brand kit and go live after CEO approval.">
            <BrandKitCard slug={concept.slug} primaryColor={concept.primaryColor} logoUrl={concept.logoUrl} wordmarkUrl={concept.wordmarkUrl} mascotUrl={concept.mascotUrl} />
          </Section>

          <Section title="Primary service vessel" subtitle="How this brand serves its food: on plates, or in packaging.">
            <Field label="Primary service vessel *"
              hint="Packaging counts on takeaway and delivery always. With Plate, dine-in counts packaging only when staff tap Box given. With Packaging (the packaging is the serving vessel, e.g. Stackd), it counts on every order.">
              <Select value={serviceVessel} onChange={(e) => setServiceVessel(e.target.value as 'plate' | 'packaging')}
                className="s-input w-full max-w-md" aria-label="Primary service vessel">
                {serviceVessel === '' && <option value="" disabled>— choose —</option>}
                <option value="plate">Plate</option>
                <option value="packaging">Packaging (the packaging is the serving vessel)</option>
              </Select>
            </Field>
            {concept.serviceVessel && serviceVessel !== concept.serviceVessel && (
              <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>
                Applies to orders from now on. Orders already rung up keep the vessel they were sold with, so past food cost is not restated.
              </p>
            )}
          </Section>

          <Section title="Delete brand" subtitle="Removes the brand from the POS, pickers and storefront. Orders and books keep its name.">
            {confirmDelete ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-amber-700">Delete <span className="font-bold">{concept.name}</span>?</span>
                <button onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55">Cancel</button>
                <button onClick={() => del.mutate()} disabled={del.isPending}
                  className="rounded-lg bg-s-red px-3 py-1.5 text-xs font-bold text-[#fff] disabled:opacity-50">
                  {del.isPending ? 'Deleting…' : 'Yes, delete'}
                </button>
                {del.isError && <span className="text-xs text-s-red">{(del.error as Error).message}</span>}
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)}
                className="rounded-lg border border-s-red/40 px-3 py-1.5 text-xs text-s-red hover:bg-s-red/10">
                Delete brand
              </button>
            )}
          </Section>
        </div>
      )}

      {/* ── Contact ──────────────────────────────────────────────────────── */}
      {tab === 'contact' && (
        <Section title="Public contact" subtitle="Per brand. Feeds schema.org rich results, the microsite footer, the WhatsApp buttons and /press — no deploy needed.">
          <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Phone (E.164)" hint="The number Google lists. Keep it identical to the Google Business Profile.">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" name="brand-phone" autoComplete="off"
                placeholder="+923001234567" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="WhatsApp" hint="The brand's one WhatsApp number — every WhatsApp button on its microsite uses it. Digits only; blank falls back to the phone.">
              <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} type="tel" inputMode="tel" name="brand-whatsapp" autoComplete="off"
                placeholder="923001234567" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="Email" hint="The brand's guest-facing email — shown on its microsite, visit page and the app.">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} name="brand-email" inputMode="email"
                autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder="brand@gsfoods.pk" className="s-input w-full font-mono text-sm" />
            </Field>
            <Field label="Area label" hint="The neighbourhood shown in the storefront pill, e.g. “Ittehad Commercial, DHA Phase 6”.">
              <input value={addressLocality} onChange={(e) => setAddressLocality(e.target.value)}
                className="s-input w-full" />
            </Field>
          </fieldset>
          <p className="text-[11px] text-white/40">
            Street address and map pin belong to the kitchen, not the brand — see the Kitchen &amp; delivery tab.
          </p>
        </Section>
      )}

      {tab === 'contact' && (
        <Section title="Profiles on the web" subtitle="Tells Google and AI search which Instagram, Facebook and Maps listing belong to this brand. Also used by the brand page's social buttons.">
          <Field label="Social profiles" hint={`One link per line, up to ${MAX_PROFILE_LINKS} — Instagram, Facebook, TikTok, YouTube, LinkedIn, X. Use the full address starting https://.`}>
            <textarea value={sameAsText} onChange={(e) => setSameAsText(e.target.value)} rows={4}
              placeholder={'https://instagram.com/yourbrand\nhttps://facebook.com/yourbrand'}
              aria-label="Social profiles" className="s-input w-full font-mono text-sm resize-y" />
          </Field>
          <Field label="Google Maps / Business Profile link" hint="Open the brand on Google Maps, tap Share, and paste the link here. Keep it the same listing your phone number is on.">
            <input value={googleMapsUrl} onChange={(e) => setGoogleMapsUrl(e.target.value)}
              placeholder="https://maps.app.goo.gl/…" aria-label="Google Maps / Business Profile link"
              className="s-input w-full font-mono text-sm" />
          </Field>
          {profileError && <p className="text-xs text-s-red">{profileError}</p>}
          <p className="text-[11px] text-white/40">
            A social button on a brand page that was given its own link in <Link href="/storefront" className="text-primary-ink hover:underline">Storefront</Link> keeps that link; a button left empty uses these.
          </p>
        </Section>
      )}

      {/* ── Brief ────────────────────────────────────────────────────────── */}
      {tab === 'brief' && (
        <Section title="Brand brief" subtitle="Captured at onboarding. Feeds schema.org cuisine / price range, CRM segments and marketing copy.">
          <Field label="Concept statement" hint="One line: what the brand is.">
            <input value={conceptStatement} onChange={(e) => setConceptStatement(e.target.value)} maxLength={280}
              className="s-input w-full" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Cuisine" hint="schema.org servesCuisine.">
              <input value={cuisine} onChange={(e) => setCuisine(e.target.value)} maxLength={60} className="s-input w-full" />
            </Field>
            <Field label="Price tier" hint="schema.org priceRange.">
              <Select value={priceTier} onChange={(e) => setPriceTier(e.target.value)} className="s-input w-full">
                {PRICE_TIERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Hero product">
              <input value={heroProduct} onChange={(e) => setHeroProduct(e.target.value)} maxLength={120} className="s-input w-full" />
            </Field>
            <Field label="Target customer">
              <input value={targetCustomer} onChange={(e) => setTargetCustomer(e.target.value)} maxLength={280} className="s-input w-full" />
            </Field>
          </div>
          <Field label="Anchoring experience" hint="The memorable thing.">
            <input value={anchoringExperience} onChange={(e) => setAnchoringExperience(e.target.value)} maxLength={280} className="s-input w-full" />
          </Field>
          <Field label="Differentiator">
            <input value={differentiator} onChange={(e) => setDifferentiator(e.target.value)} maxLength={280} className="s-input w-full" />
          </Field>
          <Field label="Brand voice" hint="Tone notes for anyone writing as the brand. This is the one place brand voice is kept.">
            <textarea value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} maxLength={500} rows={3}
              className="s-input w-full resize-none" />
          </Field>
          <Field label="Daypart focus">
            <div className="flex flex-wrap gap-2">
              {DAYPARTS.map((d) => {
                const on = daypartFocus.includes(d)
                return (
                  <button key={d} type="button"
                    onClick={() => setDaypartFocus(on ? daypartFocus.filter((x) => x !== d) : [...daypartFocus, d])}
                    className="text-xs font-semibold px-3 py-1 rounded-full"
                    style={on
                      ? { background: 'rgb(var(--erp-primary-rgb) / 0.12)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }
                      : { background: 'rgb(var(--fg-rgb) / 0.03)', color: 'rgb(var(--fg-rgb) / 0.55)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                    {d.replace('_', ' ')}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="Competitors" hint="Comma-separated, up to 10.">
            <input value={competitors} onChange={(e) => setCompetitors(e.target.value)} className="s-input w-full" />
          </Field>
        </Section>
      )}

      {/* ── Storefront ───────────────────────────────────────────────────── */}
      {tab === 'storefront' && (
        <div className="space-y-5">
          <Section title="Public storefront" subtitle="Customer-facing copy on the brand microsite">
            <div className="space-y-4">
              <Field label="Hero tagline" hint="One punchy line under the brand name. Max 120 chars.">
                <input value={heroTagline} onChange={(e) => setHeroTagline(e.target.value)} maxLength={120}
                  className="s-input w-full" />
              </Field>
              <fieldset className="space-y-4">
              <Field label="Storefront visibility">
                <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                  <input type="checkbox" checked={storefrontVisible} onChange={(e) => setStorefrontVisible(e.target.checked)} className="accent-primary" />
                  Show on the customer ordering page
                </label>
                <p className="text-[10px] text-white/35 mt-1">Uncheck to hide from the servd home page without disabling the brand entirely.</p>
              </Field>
              <Field label="Reservations">
                <label className="flex items-center gap-2 mt-2 text-xs text-white/65 cursor-pointer">
                  <input type="checkbox" checked={reservationsEnabled} onChange={(e) => setReservationsEnabled(e.target.checked)} className="accent-primary" />
                  Accept table reservations for this brand
                </label>
                <p className="text-[10px] text-white/35 mt-1">Uncheck for takeaway-only / ghost-kitchen brands. Hides the "Book a table" CTA on the storefront and brand microsite. Staff can still take phone bookings via the admin.</p>
              </Field>
              </fieldset>
            </div>
          </Section>
          <div className="rounded-xl p-4 text-xs text-white/55"
            style={{ background: 'rgb(var(--ink-rgb) / 0.05)', border: '1px solid rgb(var(--ink-rgb) / 0.18)' }}>
            The brand&apos;s colours, fonts and pictures are in <Link href={`/storefront/kit/${encodeURIComponent(concept.slug)}`} className="text-primary-ink underline">Storefront → Brand kit</Link>. The brand page itself (blocks above and below the signature design, pop-ups) is built in the <Link href={`/storefront/pages/${encodeURIComponent(`brand:${concept.slug}`)}`} className="text-primary-ink underline">storefront hub</Link>; footer copy and social links are on its <Link href={`/storefront/pages/${encodeURIComponent(`brand:${concept.slug}:footer`)}`} className="text-primary-ink underline">footer page</Link>. Changes go live after CEO approval.
          </div>
        </div>
      )}

      {/* ── Kitchen & delivery (read-only here) ──────────────────────────── */}
      {tab === 'delivery' && <KitchenAndDelivery concept={concept} showZones />}

      {/* ── Tax registration ─────────────────────────────────────────────── */}
      {tab === 'tax' && (
        <Section title="Tax registration" subtitle="GST rates and the details printed on tax invoices. Filing goes through the fiscal POS (Dev → API → POS connector).">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="GST — cash tender %" hint="Charged on cash and cash-on-delivery sales.">
              <input value={taxRateCash} onChange={(e) => setTaxRateCash(e.target.value)}
                type="number" step="0.5" min="0" max="100" className="s-input w-full max-w-[140px]" />
            </Field>
            <Field label="GST — card / online %" hint="Charged on card, wallet and paid-online sales.">
              <input value={taxRateCard} onChange={(e) => setTaxRateCard(e.target.value)}
                type="number" step="0.5" min="0" max="100" className="s-input w-full max-w-[140px]" />
            </Field>
          </div>
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
          <Field label="Province" hint="Required for Sindh tax routing (the ledger books SRB tax by province).">
            <Select value={province} onChange={(e) => setProvince(e.target.value)}
              className="s-input w-full max-w-md">
              <option value="">Select province…</option>
              {PROVINCES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Invoice legal name" hint="Registered entity name printed on tax invoices.">
            <input value={invoiceLegalName} onChange={(e) => setInvoiceLegalName(e.target.value)}
              placeholder="GS Foods (Pvt) Ltd."
              className="s-input w-full" />
          </Field>
          <Field label="Invoice address" hint="Billing address printed on tax invoices.">
            <textarea value={invoiceAddress} onChange={(e) => setInvoiceAddress(e.target.value)} rows={2}
              className="s-input w-full resize-none" />
          </Field>
          <Field label="Invoice prefix" hint="Brand-scoped sequence prefix, e.g. STK-">
            <input value={invoicePrefix} onChange={(e) => setInvoicePrefix(e.target.value)}
              placeholder="STK-" maxLength={10}
              className="s-input w-full max-w-[180px] font-mono text-sm" />
          </Field>
          <p className="text-xs text-s-muted">
            POS IDs (FBR / SRB) are set in Dev → API →{' '}
            <Link href="/connectors/pos" className="text-primary-ink underline">POS connector</Link>.
          </p>
          <Field label="Forecast portions / month" hint="Steady-state portions — the denominator for opex per portion on recipes and menu engineering.">
            <input value={forecastPortions} onChange={(e) => setForecastPortions(e.target.value.replace(/[^0-9]/g, ''))}
              className="s-input w-full max-w-[180px] font-mono text-sm" />
          </Field>
          {(!strn || !ntn || !invoiceLegalName) && (
            <div className="rounded-xl p-3 text-xs text-s-amber bg-s-amber-dim border border-s-amber/30">
              Tax invoices need the STRN, NTN and legal name. The fiscal POS files with whatever is set here, so fill them before the company goes live.
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

/**
 * Where the brand cooks and how far it delivers — shown here, edited where
 * each lives. The kitchen address and pin are the Location's (decision 18;
 * the brand's address fields are a read-only mirror of its primary Location)
 * and coverage is the delivery-zone bands (decision 19: beyond the last zone,
 * delivery is refused).
 */
function KitchenAndDelivery({ concept, showZones }: { concept: Concept; showZones: boolean }) {
  const { data: locations = [], isLoading: locLoading } = useQuery<LocationRow[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/locations'),
  })
  // Delivery zones are a management read (GET /setup/delivery-zones); the
  // marketing tier is told where they live instead of getting a 403 toast.
  const { data: zones = [], isLoading: zoneLoading } = useQuery<ZoneRow[]>({
    queryKey: ['delivery-zones'],
    queryFn: () => api.get('/setup/delivery-zones'),
    enabled: showZones,
  })
  const mine = locations
    .filter((l) => l.concepts.some((c) => c.conceptId === concept.id))
    .sort((a, b) => Number(b.concepts.find((c) => c.conceptId === concept.id)?.isPrimary ?? false)
      - Number(a.concepts.find((c) => c.conceptId === concept.id)?.isPrimary ?? false))
  const myZones = zones
    .filter((z) => z.isActive && (z.conceptId === concept.id
      || (z.conceptId === null && (!concept.tenantId || z.tenantId === concept.tenantId))))
    .sort((a, b) => (a.radiusKmMin ?? 0) - (b.radiusKmMin ?? 0))
  const reach = myZones.reduce<number | null>((m, z) =>
    z.radiusKmMax == null ? Number.POSITIVE_INFINITY : Math.max(m ?? 0, z.radiusKmMax), null)
  const pkr = (c: number) => `PKR ${(c / 100).toLocaleString()}`

  return (
    <div className="space-y-5">
      <Section title="Kitchen" subtitle="The address and map pin customers see belong to the physical kitchen (Location). A kitchen that runs several brands has one address.">
        {locLoading ? <p className="text-xs text-white/40">Loading…</p> : mine.length === 0 ? (
          <p className="text-xs text-amber-700">
            No kitchen is linked to this brand yet, so the storefront has no address or pin for it and delivery cannot be quoted.
            Link it on <Link href="/configuration/locations" className="underline">Locations</Link>.
          </p>
        ) : (
          <div className="space-y-2">
            {mine.map((l, i) => (
              <div key={l.id} className="rounded-xl p-3 text-xs" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <p className="font-bold text-white/85">{l.name}{i === 0 ? ' · primary' : ''}{!l.isActive ? ' · inactive' : ''}</p>
                <p className="text-white/55 mt-0.5">{[l.address, l.city].filter(Boolean).join(', ') || 'No address set'}</p>
                <p className="text-white/40 font-mono mt-0.5">
                  {l.latitude != null && l.longitude != null
                    ? <a className="hover:underline" target="_blank" rel="noreferrer"
                        href={`https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}`}>{l.latitude.toFixed(5)}, {l.longitude.toFixed(5)} ↗</a>
                    : 'No map pin'}
                </p>
              </div>
            ))}
          </div>
        )}
        <Link href="/configuration/locations" className="inline-block text-xs font-bold text-primary-ink hover:underline">
          Edit on Locations →
        </Link>
      </Section>

      <Section title="Delivery coverage" subtitle="Delivery zones decide the fee, the minimum order and how far this brand delivers. Beyond the last zone, delivery is refused.">
        {!showZones ? (
          <p className="text-xs text-white/45">Delivery zones are set by management on Configuration → Delivery zones.</p>
        ) : zoneLoading ? <p className="text-xs text-white/40">Loading…</p> : myZones.length === 0 ? (
          <p className="text-xs text-amber-700">No active delivery zone covers this brand — the storefront refuses delivery orders for it (pickup still works).</p>
        ) : (
          <div className="space-y-1.5">
            {myZones.map((z) => (
              <div key={z.id} className="flex items-center justify-between gap-3 text-xs rounded-lg px-3 py-2"
                style={{ background: 'rgb(var(--fg-rgb) / 0.03)' }}>
                <span className="text-white/80 font-semibold">{z.name}{z.conceptId === null ? ' (all brands)' : ''}</span>
                <span className="text-white/50 font-mono">
                  {z.radiusKmMin ?? 0}–{z.radiusKmMax ?? '∞'} km · {pkr(z.feeCents)}{z.minOrderCents > 0 ? ` · min ${pkr(z.minOrderCents)}` : ''}
                </span>
              </div>
            ))}
            {reach !== null && (
              <p className="text-[11px] text-white/40 pt-1">
                Delivers up to {Number.isFinite(reach) ? `${reach} km` : 'any distance'} from the kitchen.
              </p>
            )}
          </div>
        )}
        {showZones && (
          <Link href="/configuration/delivery-zones" className="inline-block text-xs font-bold text-primary-ink hover:underline">
            Edit delivery zones →
          </Link>
        )}
      </Section>
    </div>
  )
}

// ─── Tiny presentational helpers ──────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div>
        <h3 className="font-black text-white/90">{title}</h3>
        {subtitle && <p className="text-xs text-white/45 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  // Wire the label to its control (click focuses it; screen readers announce it)
  // and the hint to the control's description.
  const uid = useId()
  const only = isValidElement<Record<string, unknown>>(children) ? children : null
  const id = (only?.props['id'] as string | undefined) ?? `${uid}-f`
  const hintId = `${uid}-h`
  return (
    <div>
      <label htmlFor={id} className="text-xs text-white/55 block mb-1">{label}</label>
      {only ? cloneElement(only, { id, ...(hint ? { 'aria-describedby': hintId } : {}) }) : children}
      {hint && <p id={hintId} className="text-[10px] text-white/35 mt-1">{hint}</p>}
    </div>
  )
}
