'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MapPin } from '../../../components/ui/MapPin'

interface Concept {
  id: string
  name: string
  slug: string
  description: string | null
  logoUrl: string | null
  primaryColor: string | null
  heroTagline: string | null
  announcementBanner: string | null
  latitude: number | null
  longitude: number | null
  deliveryRadiusKm: number | null
}

export default function BrandIdentityPage() {
  const qc = useQueryClient()
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const [conceptId, setConceptId] = useState<string>('')
  useEffect(() => { if (!conceptId && concepts.length > 0) setConceptId(concepts[0]!.id) }, [concepts, conceptId])

  const concept = concepts.find((c) => c.id === conceptId)

  const [logoUrl, setLogoUrl] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#D4581A')
  const [heroTagline, setHeroTagline] = useState('')
  const [announcementBanner, setAnnouncementBanner] = useState('')
  const [description, setDescription] = useState('')
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null })
  const [deliveryRadiusKm, setDeliveryRadiusKm] = useState<number>(5)

  // Hydrate when concept changes
  useEffect(() => {
    if (!concept) return
    setLogoUrl(concept.logoUrl ?? '')
    setPrimaryColor(concept.primaryColor ?? '#D4581A')
    setHeroTagline(concept.heroTagline ?? '')
    setAnnouncementBanner(concept.announcementBanner ?? '')
    setDescription(concept.description ?? '')
    setCoords({ lat: concept.latitude ?? null, lng: concept.longitude ?? null })
    setDeliveryRadiusKm(concept.deliveryRadiusKm ?? 5)
  }, [concept])

  const save = useMutation({
    mutationFn: () => api.patch(`/concepts/${conceptId}`, {
      logoUrl: logoUrl || null,
      primaryColor: primaryColor || null,
      heroTagline: heroTagline || null,
      announcementBanner: announcementBanner || null,
      description: description || null,
      latitude: coords.lat,
      longitude: coords.lng,
      deliveryRadiusKm,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['concepts'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">🎨 Brand identity</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Logo, brand colour, hero tagline, announcement banner — what customers see on the storefront, in the footer of receipts, and in marketing emails.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl space-y-6">
        {concepts.length === 0 ? (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <p className="font-bold text-amber-400">Add a brand first</p>
            <p className="text-sm text-white/45 mt-1">
              Identity attaches to a brand. <Link href="/onboarding" className="text-amber-400 hover:underline">Run setup wizard</Link>.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs text-white/55">Brand</label>
              <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls + ' mt-1 max-w-sm'}>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <Section title="Logo">
              <Field label="Logo URL">
                <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://cdn.servd.app/brands/stax/logo.png" className={fieldCls} />
                <Hint>Hosted URL. Upload to your media library or paste any public image link.</Hint>
              </Field>
              {logoUrl && (
                <div className="mt-3 rounded-lg p-4 inline-flex items-center" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <img src={logoUrl} alt="Logo preview" style={{ maxHeight: '60px', maxWidth: '180px', objectFit: 'contain' }} />
                </div>
              )}
            </Section>

            <Section title="Brand colour">
              <div className="flex gap-3 items-end">
                <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-16 h-12 rounded cursor-pointer bg-transparent" />
                <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className={fieldCls + ' font-mono flex-1 max-w-[160px]'} />
                <div className="flex-1 rounded-lg p-3 text-xs font-bold uppercase tracking-wider"
                  style={{ background: primaryColor, color: '#000' }}>
                  Preview · primary CTA
                </div>
              </div>
              <Hint>Used on storefront buttons, brand-page hero, badge accents.</Hint>
            </Section>

            <Section title="Storefront copy">
              <Field label="Hero tagline">
                <input value={heroTagline} onChange={(e) => setHeroTagline(e.target.value)}
                  placeholder="Smashed. Stacked. Sauced." maxLength={140} className={fieldCls} />
                <Hint>Big slab type at the top of /brand/{concept?.slug}. ≤140 chars.</Hint>
              </Field>
              <Field label="Announcement banner">
                <input value={announcementBanner} onChange={(e) => setAnnouncementBanner(e.target.value)}
                  placeholder="20% off all burgers · this weekend only" maxLength={280} className={fieldCls} />
                <Hint>Top strip on the storefront. Leave blank to hide.</Hint>
              </Field>
              <Field label="Brand description">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
                  placeholder="The story you want to tell. Goes on the brand About page and in OG share cards." className={fieldCls} />
              </Field>
            </Section>

            <Section title="Location & delivery">
              <Field label="Pin on map">
                <MapPin value={coords} onChange={setCoords}
                  hint="Drives delivery zone radius from this point + storefront 'nearest brand' picker. If multiple kitchens serve this brand, pin the primary one." />
              </Field>
              <Field label="Delivery radius (km)">
                <input type="number" step="0.5" min={0} max={50} value={deliveryRadiusKm}
                  onChange={(e) => setDeliveryRadiusKm(parseFloat(e.target.value) || 0)} className={fieldCls + ' max-w-[160px]'} />
                <Hint>Storefront refuses delivery outside this radius. Default 5 km.</Hint>
              </Field>
            </Section>

            <div className="flex justify-between gap-3 pt-4 border-t border-white/[0.05]">
              <Link href={`http://localhost:3002/brand/${concept?.slug}`} target="_blank"
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">
                Preview storefront ↗
              </Link>
              <button onClick={() => save.mutate()} disabled={save.isPending || !conceptId}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save identity'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div>
}
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-white/35 mt-1">{children}</p>
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
