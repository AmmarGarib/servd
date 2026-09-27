'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'

interface Concept {
  id: string; name: string; slug: string; type: string
  description: string | null; primaryColor: string | null; isActive: boolean
  // Legacy single rate (still on the schema for back-compat) + the new
  // tender-split rates used by every fresh order's tax calc.
  taxRate: number
  taxRateCash: number
  taxRateCard: number
  storefrontVisible: boolean; heroTagline: string | null; announcementBanner: string | null
  logoUrl: string | null
  // Present only when fetched via the portfolio endpoint — tells the CEO
  // which company each brand belongs to in the listing.
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
}
interface Station { id: string; name: string; concept: { name: string } }

// Staff accounts are managed on /workforce only. The old 'Staff' tab here
// threw away the one-time password it generated, offered only legacy roles and
// could not set companies — it was removed rather than kept as a second editor.
type Section = 'concepts' | 'stations' | 'preferences'

const SECTIONS: { id: Section; label: string; icon: string; desc: string }[] = [
  { id: 'concepts',    label: 'Concepts',     icon: '🏷',  desc: 'Brands, tax, visibility' },
  { id: 'stations',    label: 'Stations',     icon: '🍳',  desc: 'Kitchen + KDS stations' },
  { id: 'preferences', label: 'Preferences',  icon: '⚙️',  desc: 'Language' },
]

export default function SettingsPage() {
  const [section, setSection] = useState<Section>('concepts')

  return (
    <div className="h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-4 py-3 md:px-6 md:py-4">
        <h1 className="text-xl md:text-2xl font-black text-kds-text mt-0.5">Settings</h1>
        <p className="text-xs md:text-sm text-kds-subtext">Concepts, stations and language. Staff accounts live in <Link href="/workforce" className="text-kds-green font-semibold">Workforce</Link>; the clock-in geofence in <Link href="/configuration/operations" className="text-kds-green font-semibold">Operations</Link>; punches in <Link href="/hr/attendance" className="text-kds-green font-semibold">HR → Attendance</Link>; the receipt printer in <Link href="/configuration/receipts" className="text-kds-green font-semibold">Receipts</Link>.</p>
      </header>

      {/* ── Mobile tab strip ── */}
      <div className="lg:hidden flex overflow-x-auto border-b border-kds-border scrollbar-hide">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`shrink-0 flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${
              section === s.id
                ? 'border-kds-green text-kds-green bg-kds-card/40'
                : 'border-transparent text-kds-subtext hover:text-kds-text'
            }`}>
            <span>{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar (desktop only) ── */}
        <aside className="hidden lg:block w-56 shrink-0 border-r border-kds-border overflow-y-auto">
          <p className="px-4 pt-4 pb-2 text-xs font-bold text-kds-subtext uppercase tracking-widest">Configuration</p>
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setSection(s.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-kds-border/40 transition-colors ${
                section === s.id ? 'bg-kds-card border-l-2 border-l-kds-green' : 'hover:bg-kds-card/50'
              }`}>
              <span className="text-lg shrink-0">{s.icon}</span>
              <div className="min-w-0">
                <p className={`text-sm font-semibold truncate ${section === s.id ? 'text-kds-text' : 'text-kds-subtext'}`}>{s.label}</p>
                <p className="text-xs text-kds-subtext truncate">{s.desc}</p>
              </div>
            </button>
          ))}
        </aside>

        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {section === 'concepts'    && <ConceptsSection />}
          {section === 'stations'    && <StationsSection />}
          {section === 'preferences' && <PreferencesSection />}
        </div>
      </div>
    </div>
  )
}

// ─── Concepts ─────────────────────────────────────────────────────────────────

function ConceptsSection() {
  const qc = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<Concept>>({})
  const [saved, setSaved] = useState(false)
  const { data: tenants = [] } = useMyTenants()

  // Brand list respects the sidebar tenant switcher — single tenant returns
  // just that company's brands, "All companies" returns the full set. Each
  // row still wears its tenant chip when portfolio mode is on so the CEO
  // sees which company they're editing.
  // includeInactive: this is the ONE page that still shows retired brands
  // (e.g. Simmer) so the CEO can see or reactivate them — everywhere else
  // in the admin they're hidden.
  const { data = [] } = useQuery({ queryKey: ['concepts', 'all'], queryFn: () => api.get<Concept[]>('/concepts?includeInactive=1') })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Concept> }) => api.patch(`/concepts/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concepts'] })
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    },
  })

  // Soft-delete a brand. Backend marks the row with deletedAt + isActive=false
  // so historical orders/financial entries still resolve to a name; the brand
  // just stops appearing in pickers, POS, and storefront. Reversible by
  // an admin via the DB if the CEO ever wants it back.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/concepts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concepts'] })
      setConfirmDeleteId(null)
      setExpandedId(null)
    },
  })

  function startEdit(c: Concept) {
    if (expandedId === c.id) { setExpandedId(null); return }
    setExpandedId(c.id)
    setForm({
      name: c.name, description: c.description ?? '', primaryColor: c.primaryColor ?? '#6366f1',
      isActive: c.isActive, taxRate: c.taxRate, taxRateCash: c.taxRateCash, taxRateCard: c.taxRateCard, logoUrl: c.logoUrl ?? '',
      storefrontVisible: c.storefrontVisible, heroTagline: c.heroTagline ?? '', announcementBanner: c.announcementBanner ?? '',
    })
    setSaved(false)
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-start justify-between gap-3 mb-4">
        <p className="text-sm text-kds-subtext flex-1">
          Configure your restaurant concepts — branding, tax rates, and storefront visibility.
          For full page layout editing use <Link href="/storefront" className="text-kds-green hover:underline">Storefront CMS ↗</Link>
        </p>
        <Link href="/onboarding"
          className="shrink-0 rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 inline-flex items-center gap-1.5">
          + Add brand
        </Link>
      </div>
      {data.length === 0 && (
        <div className="rounded-xl border border-dashed border-kds-border bg-kds-card/40 px-6 py-10 text-center">
          <p className="text-3xl mb-2">🏷</p>
          <p className="text-sm font-semibold text-kds-text">No brands yet</p>
          <p className="text-xs text-kds-subtext mt-1 mb-4">Create your first brand to start taking orders.</p>
          <Link href="/onboarding"
            className="inline-flex rounded-xl bg-kds-green text-black font-bold px-5 py-2 text-sm hover:opacity-90">
            Open brand setup →
          </Link>
        </div>
      )}
      {data.map((c) => (
        <div key={c.id} className={`rounded-xl border bg-kds-card transition-all ${expandedId === c.id ? 'border-kds-green' : 'border-kds-border'}`}>
          <div className="flex items-center justify-between px-4 py-3.5 cursor-pointer select-none"
            onClick={() => startEdit(c)}>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full shrink-0 flex items-center justify-center font-black text-sm overflow-hidden"
                style={{ background: c.primaryColor ?? '#6366f1', color: '#fff' }}>
                {c.logoUrl ? <img src={c.logoUrl} alt={c.name} className="h-full w-full object-cover" /> : c.name[0]}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-kds-text">{c.name}</p>
                  <TenantChip tenant={c.tenant} tenantId={c.tenantId} tenants={tenants} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-kds-subtext capitalize">{c.type}</span>
                  <span className="text-xs font-mono text-kds-subtext">{c.slug}</span>
                  <span className={`text-xs font-bold ${c.isActive ? 'text-kds-green' : 'text-kds-red'}`}>
                    {c.isActive ? '● Active' : '○ Off'}
                  </span>
                  <span className="text-xs text-kds-subtext">GST {c.taxRateCash ?? c.taxRate}/{c.taxRateCard ?? c.taxRate}%</span>
                </div>
              </div>
            </div>
            <span className="text-kds-subtext text-xs shrink-0">{expandedId === c.id ? '▲' : 'Edit ▼'}</span>
          </div>

          {expandedId === c.id && (
            <div className="border-t border-kds-border px-4 py-4 space-y-5">
              <SubSection label="General">
                <Row2>
                  <F label="Display name">
                    <input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fi} />
                  </F>
                  {/* GST splits by tender per FBR — cashier rings up cash at
                      the higher rate, card / digital at the discounted rate.
                      Both editable so a brand can negotiate its own rates.
                      The legacy single `taxRate` field is still on the
                      schema for back-compat but no new orders read it. */}
                  <F label="GST — Cash / Card (%)">
                    <div className="flex items-center gap-2">
                      <input type="number" step="0.5" min={0} max={50}
                        value={form.taxRateCash ?? 15}
                        onChange={(e) => setForm({ ...form, taxRateCash: Number(e.target.value) })}
                        className={fi} aria-label="Cash GST rate %" />
                      <span className="text-xs text-kds-subtext">/</span>
                      <input type="number" step="0.5" min={0} max={50}
                        value={form.taxRateCard ?? 8}
                        onChange={(e) => setForm({ ...form, taxRateCard: Number(e.target.value) })}
                        className={fi} aria-label="Card GST rate %" />
                    </div>
                  </F>
                </Row2>
                <Row2>
                  <F label="Brand colour">
                    <div className="flex items-center gap-2">
                      <input type="color" value={form.primaryColor ?? '#6366f1'} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                        className="h-9 w-14 rounded-lg border border-kds-border bg-kds-bg cursor-pointer p-1" />
                      <input value={form.primaryColor ?? ''} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                        className={`${fi} font-mono`} />
                    </div>
                  </F>
                  <F label="">
                    <div className="flex items-center gap-3 mt-3">
                      <span className="text-xs text-kds-subtext">Active (POS/KDS)</span>
                      <Toggle value={!!form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
                    </div>
                  </F>
                </Row2>
              </SubSection>

              <SubSection label="Storefront — customer-facing">
                <div className="flex items-center gap-3 mb-3 rounded-xl border border-kds-border/50 px-3 py-2">
                  <span className="text-xs text-kds-subtext flex-1">Visible on ordering site</span>
                  <Toggle value={!!form.storefrontVisible} onChange={(v) => setForm({ ...form, storefrontVisible: v })} />
                  <span className="text-xs text-kds-subtext">{form.storefrontVisible ? 'Live' : 'Hidden'}</span>
                </div>
                <Row2>
                  <F label="Description">
                    <input value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Gourmet sandwiches, loaded fries…" className={fi} />
                  </F>
                  <F label="Logo URL">
                    <input value={(form.logoUrl as string) ?? ''} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                      placeholder="https://…" className={fi} />
                  </F>
                </Row2>
                <F label="Hero tagline (max 120 chars)">
                  <input value={(form.heroTagline as string) ?? ''} onChange={(e) => setForm({ ...form, heroTagline: e.target.value })}
                    maxLength={120} placeholder="Built different. Eaten fast." className={fi} />
                </F>
                <F label="Announcement banner (blank to hide)">
                  <input value={(form.announcementBanner as string) ?? ''} onChange={(e) => setForm({ ...form, announcementBanner: e.target.value })}
                    maxLength={300} placeholder="🔥 Weekend special — free drink today!" className={fi} />
                </F>
              </SubSection>

              <div className="flex items-center gap-3 pt-1 flex-wrap">
                <button onClick={() => updateMutation.mutate({ id: c.id, body: form })}
                  disabled={updateMutation.isPending}
                  className="rounded-xl bg-kds-green text-black font-bold px-5 py-2 text-sm hover:opacity-90 disabled:opacity-50">
                  {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                </button>
                <button onClick={() => setExpandedId(null)}
                  className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
                {saved && <span className="text-sm text-kds-green">✓ Saved</span>}

                {/* Delete moves to the right edge — destructive, two-step,
                    requires explicit confirmation so the CEO can't nuke a
                    brand by mistake. Soft-deletes server-side: history is
                    preserved, just hidden from pickers and storefront. */}
                <div className="ml-auto flex items-center gap-2">
                  {confirmDeleteId === c.id ? (
                    <>
                      <span className="text-xs text-kds-amber">
                        Delete <span className="font-bold">{c.name}</span>? This hides it from POS/storefront but keeps history.
                      </span>
                      <button onClick={() => setConfirmDeleteId(null)}
                        className="rounded-xl border border-kds-border text-kds-subtext px-3 py-1.5 text-xs">Cancel</button>
                      <button onClick={() => deleteMutation.mutate(c.id)}
                        disabled={deleteMutation.isPending}
                        className="rounded-xl bg-kds-red text-white font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50">
                        {deleteMutation.isPending ? 'Deleting…' : 'Yes, delete'}
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(c.id)}
                      className="rounded-xl border border-kds-red/40 text-kds-red px-3 py-1.5 text-xs hover:bg-kds-red/10">
                      🗑 Delete brand
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Stations ─────────────────────────────────────────────────────────────────

function StationsSection() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: '', conceptId: '' })

  const { data: stations } = useQuery({ queryKey: ['stations'], queryFn: () => api.get<Station[]>('/stations') })
  const { data: concepts } = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })

  const addMutation = useMutation({
    mutationFn: () => api.post('/stations', form),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stations'] }); setShowAdd(false); setForm({ name: '', conceptId: '' }) },
  })

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <p className="text-sm text-kds-subtext">Kitchen display stations — each station shows its assigned items on the KDS screen.</p>

      {showAdd ? (
        <div className="rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
          <p className="font-bold text-kds-text text-sm">Add station</p>
          <Row2>
            <F label="Station name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Grill, Cold, Drinks" className={fi} autoFocus />
            </F>
            <F label="Concept">
              <select value={form.conceptId} onChange={(e) => setForm({ ...form, conceptId: e.target.value })} className={fi}>
                <option value="">Select…</option>
                {(concepts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </F>
          </Row2>
          <div className="flex gap-2">
            <button onClick={() => addMutation.mutate()} disabled={!form.name || !form.conceptId || addMutation.isPending}
              className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
              {addMutation.isPending ? 'Saving…' : 'Add station'}
            </button>
            <button onClick={() => setShowAdd(false)}
              className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add station
        </button>
      )}

      <div className="rounded-xl border border-kds-border overflow-hidden">
        {(stations ?? []).map((s) => (
          <div key={s.id} className="flex items-center justify-between px-4 py-3.5 border-b border-kds-border last:border-0 hover:bg-kds-card/50 transition-colors">
            <div>
              <p className="text-sm font-semibold text-kds-text">{s.name}</p>
              <p className="text-xs text-kds-subtext">{s.concept.name}</p>
            </div>
            <Link href={`/kds/${s.id}`} className="text-xs text-kds-blue hover:underline">Open KDS →</Link>
          </div>
        ))}
        {(stations ?? []).length === 0 && <p className="px-4 py-8 text-center text-kds-subtext text-sm">No stations yet</p>}
      </div>
    </div>
  )
}

// The 'Location' (geofence) and 'Shift Report' tabs are gone (D6). The
// geofence is company config at Configuration → Operations (anchored on each
// location's map pin, /setup/operations-config) — the tab here called an
// /auth/location-config route that never existed. Punches are read on
// HR → Attendance (GET /time-clock/logs, PKT day boundaries), which replaced
// the old /auth/clock-logs report this tab used.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SubSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">{label}</p>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label className="text-xs text-kds-subtext font-medium">{label}</label>}
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-kds-green' : 'bg-kds-border'}`}>
      <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

// ─── Preferences ──────────────────────────────────────────────────────────────

function PreferencesSection() {
  const [locale, setLocale] = useState('en')

  useEffect(() => {
    const cookieLocale = document.cookie.split('; ').find(r => r.startsWith('NEXT_LOCALE='))?.split('=')[1]
    if (cookieLocale) setLocale(cookieLocale)
  }, [])

  function changeLocale(newLocale: string) {
    setLocale(newLocale)
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000`
    window.location.reload()
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-base font-bold text-kds-text mb-1">Preferences</h2>
        <p className="text-sm text-kds-subtext">Language. The receipt printer is set up in <Link href="/configuration/receipts" className="text-kds-green font-semibold">Configuration → Receipts</Link>.</p>
      </div>

      {/* Language */}
      <div className="rounded-xl border border-kds-border bg-kds-card p-4 space-y-3">
        <h3 className="text-sm font-bold text-kds-text">Language / زبان</h3>
        <div className="grid grid-cols-2 gap-2">
          {[{ code: 'en', label: 'English', native: 'English' }, { code: 'ur', label: 'Urdu', native: 'اردو' }].map(lang => (
            <button key={lang.code} onClick={() => changeLocale(lang.code)}
              className={`rounded-xl p-3 text-center border transition-colors ${
                locale === lang.code
                  ? 'border-kds-green bg-kds-green/15 text-kds-green'
                  : 'border-kds-border text-kds-subtext hover:border-kds-text'
              }`}>
              <div className="font-bold text-sm">{lang.native}</div>
              <div className="text-xs opacity-70">{lang.label}</div>
            </button>
          ))}
        </div>
        <p className="text-xs text-kds-subtext">Changing language reloads the page. KDS and POS interfaces will use the selected language.</p>
      </div>
    </div>
  )
}

const fi = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none transition-colors'
