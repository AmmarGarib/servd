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
interface User { id: string; name: string; email: string; role: string; isActive: boolean; hasPin: boolean }

type Section = 'concepts' | 'stations' | 'users' | 'location' | 'shifts' | 'preferences'

const SECTIONS: { id: Section; label: string; icon: string; desc: string }[] = [
  { id: 'concepts',    label: 'Concepts',     icon: '🏷',  desc: 'Brands, tax, visibility' },
  { id: 'stations',    label: 'Stations',     icon: '🍳',  desc: 'Kitchen + KDS stations' },
  { id: 'users',       label: 'Staff',        icon: '👤',  desc: 'Logins, roles, PINs' },
  { id: 'location',    label: 'Location',     icon: '📍',  desc: 'On-site sign-in enforcement' },
  { id: 'shifts',      label: 'Shift Report', icon: '🕐',  desc: 'Clock-in / out logs' },
  { id: 'preferences', label: 'Preferences',  icon: '⚙️',  desc: 'Language, printer, display' },
]

export default function SettingsPage() {
  const [section, setSection] = useState<Section>('concepts')

  return (
    <div className="h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-4 py-3 md:px-6 md:py-4">
        <h1 className="text-xl md:text-2xl font-black text-kds-text mt-0.5">Settings</h1>
        <p className="text-xs md:text-sm text-kds-subtext">Concepts, stations, and staff management</p>
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
          {section === 'users'       && <UsersSection />}
          {section === 'location'    && <LocationSection />}
          {section === 'shifts'      && <ShiftsSection />}
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
  const { data = [] } = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })

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

// ─── Users ────────────────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  admin:     'bg-purple-900/40 text-purple-400',
  manager:   'bg-blue-900/40 text-kds-blue',
  cashier:   'bg-kds-bg text-kds-subtext',
  kitchen:   'bg-green-900/40 text-green-400',
  expediter: 'bg-yellow-900/40 text-yellow-400',
}

function UsersSection() {
  const qc = useQueryClient()
  const [showAdd,   setShowAdd]   = useState(false)
  const [editPin,   setEditPin]   = useState<string | null>(null)  // userId being PIN-edited
  const [newPin,    setNewPin]    = useState('')
  const [form, setForm] = useState({ name: '', email: '', pin: '', role: 'cashier' })

  const { data } = useQuery({
    queryKey: ['users'],
    queryFn:  () => api.get<User[]>('/auth/users'),
  })

  const addMut = useMutation({
    mutationFn: () => api.post('/auth/users', { name: form.name, email: form.email, pin: form.pin, role: form.role }),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['users'] }); setShowAdd(false); setForm({ name: '', email: '', pin: '', role: 'cashier' }) },
  })

  const patchMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<User>(`/auth/users/${id}`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); setEditPin(null); setNewPin('') },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/users/${id}`),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <p className="text-sm text-kds-subtext">
        Staff sign in using their PIN only. Set each person&apos;s PIN here — they&apos;ll use it on the login screen.
      </p>

      {/* Add form */}
      {showAdd ? (
        <div className="rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
          <p className="font-bold text-kds-text text-sm">Add staff member</p>
          <Row2>
            <F label="Full name">
              <input type="text" placeholder="Ahmad Khan"
                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fi} />
            </F>
            <F label="Email (for records)">
              <input type="email" placeholder="ahmad@servd.pk"
                value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={fi} />
            </F>
            <F label="PIN (4–8 digits)">
              <input type="number" placeholder="e.g. 1234"
                value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })}
                className={fi} maxLength={8} />
            </F>
            <F label="Role">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={fi}>
                <option value="cashier">Cashier</option>
                <option value="kitchen">Kitchen</option>
                <option value="expediter">Expediter</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </F>
          </Row2>
          {addMut.isError && (
            <p className="text-xs text-red-400">{(addMut.error as Error).message}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => addMut.mutate()}
              disabled={!form.name || !form.email || form.pin.length < 4 || addMut.isPending}
              className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50">
              {addMut.isPending ? 'Adding…' : 'Add Staff Member'}
            </button>
            <button onClick={() => setShowAdd(false)}
              className="rounded-xl border border-kds-border text-kds-subtext px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add Staff Member
        </button>
      )}

      {/* Staff list */}
      <div className="rounded-xl border border-kds-border overflow-hidden">
        {(data ?? []).length === 0 && (
          <p className="px-4 py-8 text-center text-kds-subtext text-sm">No staff yet</p>
        )}
        {(data ?? []).map((u) => (
          <div key={u.id}
            className="border-b border-kds-border last:border-0"
            style={{ background: u.isActive ? '' : 'rgba(255,255,255,0.01)' }}>

            {/* Main row */}
            <div className="flex items-center gap-3 px-4 py-3">
              {/* Avatar */}
              <div className="h-9 w-9 rounded-full shrink-0 flex items-center justify-center text-sm font-black"
                style={{
                  background: u.isActive
                    ? 'linear-gradient(135deg, rgba(0,212,177,0.2), rgba(99,102,241,0.2))'
                    : 'rgba(255,255,255,0.04)',
                  color: u.isActive ? '#00D4B1' : 'rgba(255,255,255,0.2)',
                  border: `1px solid ${u.isActive ? 'rgba(0,212,177,0.2)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                {u.name.charAt(0).toUpperCase()}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={`text-sm font-semibold truncate ${u.isActive ? 'text-kds-text' : 'text-kds-subtext line-through'}`}>
                    {u.name}
                  </p>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full capitalize shrink-0 ${ROLE_COLORS[u.role] ?? ''}`}>
                    {u.role}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-kds-subtext truncate">{u.email}</p>
                  <span className={`text-[10px] font-semibold shrink-0 ${u.hasPin ? 'text-kds-green' : 'text-red-400'}`}>
                    {u.hasPin ? '🔢 PIN set' : '⚠ No PIN'}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Active toggle */}
                <Toggle
                  value={u.isActive}
                  onChange={(v) => patchMut.mutate({ id: u.id, body: { isActive: v } })}
                />
                {/* Set/Change PIN */}
                <button
                  onClick={() => { setEditPin(u.id); setNewPin('') }}
                  className="text-xs px-2.5 py-1.5 rounded-lg font-semibold transition-colors"
                  style={{
                    background:  'rgba(0,212,177,0.08)',
                    border:      '1px solid rgba(0,212,177,0.2)',
                    color:       '#00D4B1',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,212,177,0.15)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,212,177,0.08)')}>
                  {u.hasPin ? 'Change PIN' : 'Set PIN'}
                </button>
                {/* Delete */}
                <button
                  onClick={() => { if (confirm(`Remove ${u.name}? This cannot be undone.`)) deleteMut.mutate(u.id) }}
                  className="text-xs px-2 py-1.5 rounded-lg text-kds-subtext transition-colors hover:text-red-400 hover:bg-red-900/20">
                  ✕
                </button>
              </div>
            </div>

            {/* Inline PIN editor */}
            {editPin === u.id && (
              <div className="px-4 pb-3 flex items-center gap-3"
                style={{ borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '10px', background: 'rgba(0,212,177,0.03)' }}>
                <p className="text-xs text-kds-subtext shrink-0">New PIN for {u.name}:</p>
                <input
                  type="number"
                  placeholder="e.g. 3742"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  className={`${fi} w-32`}
                  maxLength={8}
                  autoFocus
                />
                <button
                  onClick={() => patchMut.mutate({ id: u.id, body: { pin: newPin } })}
                  disabled={newPin.length < 4 || patchMut.isPending}
                  className="rounded-lg bg-kds-green text-black font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-40">
                  {patchMut.isPending ? 'Saving…' : 'Save PIN'}
                </button>
                <button onClick={() => { setEditPin(null); setNewPin('') }}
                  className="text-xs text-kds-subtext hover:text-kds-text">
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Location ─────────────────────────────────────────────────────────────────

interface LocationConfig {
  enabled: boolean
  lat: number | null
  lng: number | null
  radiusMeters: number
}

function LocationSection() {
  const qc = useQueryClient()
  const [gettingLoc, setGettingLoc] = useState(false)
  const [locError,   setLocError]   = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['location-config'],
    queryFn:  () => api.get<LocationConfig>('/auth/location-config'),
  })

  const [form, setForm] = useState<LocationConfig>({
    enabled: false, lat: null, lng: null, radiusMeters: 200,
  })

  // Sync form once data loads
  const [synced, setSynced] = useState(false)
  if (data && !synced) { setForm(data); setSynced(true) }

  const saveMut = useMutation({
    mutationFn: () => api.put<LocationConfig>('/auth/location-config', form),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['location-config'] }),
  })

  function useCurrentLocation() {
    if (!navigator.geolocation) { setLocError('Geolocation not supported by this browser'); return }
    setGettingLoc(true); setLocError('')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude, lng: pos.coords.longitude }))
        setGettingLoc(false)
      },
      (err) => {
        setLocError(err.code === 1 ? 'Location access denied — allow it in your browser settings' : 'Could not get location')
        setGettingLoc(false)
      },
      { timeout: 10000, enableHighAccuracy: true },
    )
  }

  if (isLoading) return <div className="skeleton h-40 rounded-xl" />

  const hasCoords = form.lat !== null && form.lng !== null

  return (
    <div className="max-w-lg space-y-5">
      <div>
        <p className="text-sm text-kds-subtext">
          When enabled, staff must be physically on-site to sign in using their PIN.
          Admins and managers are always exempt.
        </p>
      </div>

      {/* Enable toggle */}
      <div className="rounded-xl border border-kds-border bg-kds-card p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-kds-text">Enforce on-site sign-in</p>
          <p className="text-xs text-kds-subtext mt-0.5">
            Blocks PIN login if staff are outside the allowed radius
          </p>
        </div>
        <Toggle value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
      </div>

      {/* Location picker */}
      <div className="rounded-xl border border-kds-border bg-kds-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-kds-text">Restaurant Location</p>
          <button
            onClick={useCurrentLocation}
            disabled={gettingLoc}
            className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50"
            style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.25)', color: '#00D4B1' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,212,177,0.18)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,212,177,0.1)')}>
            {gettingLoc ? 'Getting location…' : '📍 Use my current location'}
          </button>
        </div>

        {locError && <p className="text-xs text-red-400">{locError}</p>}

        <Row2>
          <F label="Latitude">
            <input
              type="number" step="any" placeholder="e.g. 33.7215"
              value={form.lat ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value ? parseFloat(e.target.value) : null }))}
              className={fi} />
          </F>
          <F label="Longitude">
            <input
              type="number" step="any" placeholder="e.g. 73.0433"
              value={form.lng ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value ? parseFloat(e.target.value) : null }))}
              className={fi} />
          </F>
        </Row2>

        <F label="Allowed radius (metres)">
          <div className="flex items-center gap-3">
            <input
              type="range" min={25} max={2000} step={25}
              value={form.radiusMeters}
              onChange={(e) => setForm((f) => ({ ...f, radiusMeters: parseInt(e.target.value) }))}
              className="flex-1 accent-kds-green" />
            <span className="text-sm font-bold text-kds-text w-16 text-right">{form.radiusMeters}m</span>
          </div>
          <p className="text-[10px] text-kds-subtext mt-1">
            {form.radiusMeters <= 50  && 'Very tight — GPS must be right on-site'}
            {form.radiusMeters > 50  && form.radiusMeters <= 150  && 'Tight — suitable for a single building'}
            {form.radiusMeters > 150 && form.radiusMeters <= 400  && 'Standard — recommended for most restaurants'}
            {form.radiusMeters > 400 && form.radiusMeters <= 1000 && 'Loose — covers a full block or complex'}
            {form.radiusMeters > 1000 && 'Very loose — almost no restriction'}
          </p>
        </F>

        {hasCoords && (
          <div className="rounded-lg p-3 text-xs space-y-1"
            style={{ background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.15)' }}>
            <p className="font-semibold text-kds-green">Location configured</p>
            <p className="text-kds-subtext">
              {form.lat!.toFixed(6)}, {form.lng!.toFixed(6)} · {form.radiusMeters}m radius
            </p>
            <a
              href={`https://www.google.com/maps?q=${form.lat},${form.lng}`}
              target="_blank" rel="noreferrer"
              className="text-kds-green hover:underline">
              View on Google Maps →
            </a>
          </div>
        )}
      </div>

      {/* Save */}
      {saveMut.isError && (
        <p className="text-xs text-red-400">{(saveMut.error as Error).message}</p>
      )}
      {saveMut.isSuccess && (
        <p className="text-xs text-kds-green">Saved ✓</p>
      )}
      <button
        onClick={() => saveMut.mutate()}
        disabled={saveMut.isPending || (form.enabled && !hasCoords)}
        className="rounded-xl bg-kds-green text-black font-bold px-5 py-2 text-sm hover:opacity-90 disabled:opacity-50">
        {saveMut.isPending ? 'Saving…' : 'Save Location Settings'}
      </button>
      {form.enabled && !hasCoords && (
        <p className="text-xs text-red-400">Set a location before enabling enforcement.</p>
      )}
    </div>
  )
}

// ─── Shifts ───────────────────────────────────────────────────────────────────

interface ClockLog {
  id: string
  type: 'in' | 'out'
  recordedAt: string
  lat: number | null
  lng: number | null
  user: { id: string; name: string; role: string }
}

function ShiftsSection() {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)

  const { data = [], isLoading, refetch } = useQuery({
    queryKey: ['clock-logs', date],
    queryFn:  () => api.get<ClockLog[]>(`/auth/clock-logs?date=${date}`),
  })

  // Group by user
  const byUser = new Map<string, { name: string; role: string; logs: ClockLog[] }>()
  for (const log of data) {
    const existing = byUser.get(log.user.id)
    if (existing) {
      existing.logs.push(log)
    } else {
      byUser.set(log.user.id, { name: log.user.name, role: log.user.role, logs: [log] })
    }
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true })

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-kds-subtext flex-1">Staff clock-in and clock-out records.</p>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          className={`${fi} w-44`}
        />
        <button onClick={() => void refetch()}
          className="text-xs px-3 py-2 rounded-lg font-semibold"
          style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.2)', color: '#00D4B1' }}>
          Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-kds-subtext">Loading…</p>
      ) : byUser.size === 0 ? (
        <div className="text-center py-16 rounded-xl border border-kds-border">
          <p className="text-3xl mb-2">🕐</p>
          <p className="font-semibold text-kds-text text-sm">No clock records for this date</p>
          <p className="text-xs text-kds-subtext mt-1">Staff clock in automatically when they sign in via PIN</p>
        </div>
      ) : (
        <div className="space-y-3">
          {[...byUser.values()].map(({ name, role, logs }) => {
            const ins  = logs.filter((l) => l.type === 'in').sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
            const outs = logs.filter((l) => l.type === 'out').sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
            const firstIn  = ins[0]
            const lastOut  = outs[outs.length - 1]

            let hoursWorked: string | null = null
            if (firstIn && lastOut) {
              const ms = new Date(lastOut.recordedAt).getTime() - new Date(firstIn.recordedAt).getTime()
              const h = Math.floor(ms / 3_600_000)
              const m = Math.floor((ms % 3_600_000) / 60_000)
              hoursWorked = `${h}h ${m}m`
            }

            return (
              <div key={name} className="rounded-xl border border-kds-border bg-kds-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                      style={{ background: 'rgba(0,212,177,0.15)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.2)' }}>
                      {name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-kds-text">{name}</p>
                      <p className="text-xs text-kds-subtext capitalize">{role}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    {hoursWorked && (
                      <p className="text-sm font-bold text-kds-green">{hoursWorked}</p>
                    )}
                    {!lastOut && ins.length > 0 && (
                      <p className="text-xs font-semibold text-yellow-400">Still clocked in</p>
                    )}
                  </div>
                </div>
                <div className="divide-y divide-kds-border/30">
                  {logs.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((log) => (
                    <div key={log.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={`text-xs font-bold w-10 shrink-0 uppercase ${log.type === 'in' ? 'text-kds-green' : 'text-red-400'}`}>
                        {log.type === 'in' ? '→ IN' : '← OUT'}
                      </span>
                      <span className="text-sm font-semibold text-kds-text">{fmt(log.recordedAt)}</span>
                      {log.lat && log.lng && (
                        <a href={`https://www.google.com/maps?q=${log.lat},${log.lng}`}
                          target="_blank" rel="noreferrer"
                          className="text-xs text-kds-subtext hover:text-kds-green ml-auto">
                          📍 {log.lat.toFixed(4)}, {log.lng.toFixed(4)}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

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
  const qc = useQueryClient()
  const [locale, setLocale] = useState('en')
  const [printerIp, setPrinterIp] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const cookieLocale = document.cookie.split('; ').find(r => r.startsWith('NEXT_LOCALE='))?.split('=')[1]
    if (cookieLocale) setLocale(cookieLocale)
  }, [])

  const { data: printerSetting } = useQuery({
    queryKey: ['setting', 'printer_ip'],
    queryFn: () => api.get<{ key: string; value: string }>('/settings/printer_ip').catch(() => null),
  })

  useEffect(() => {
    if (printerSetting?.value) setPrinterIp(printerSetting.value)
  }, [printerSetting])

  const savePrinterMutation = useMutation({
    mutationFn: () => api.post('/settings', { key: 'printer_ip', value: printerIp }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['setting', 'printer_ip'] })
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    },
  })

  function changeLocale(newLocale: string) {
    setLocale(newLocale)
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000`
    window.location.reload()
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-base font-bold text-kds-text mb-1">Preferences</h2>
        <p className="text-sm text-kds-subtext">Language, printer, and display settings</p>
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

      {/* Printer IP */}
      <div className="rounded-xl border border-kds-border bg-kds-card p-4 space-y-3">
        <h3 className="text-sm font-bold text-kds-text">Network Receipt Printer</h3>
        <p className="text-xs text-kds-subtext">IP address of your Epson / Star network receipt printer (optional). Leave blank to use browser print.</p>
        <div className="flex gap-2">
          <input type="text" value={printerIp} onChange={e => setPrinterIp(e.target.value)}
            placeholder="192.168.1.100"
            className={fi + ' flex-1'} />
          <button onClick={() => savePrinterMutation.mutate()}
            disabled={savePrinterMutation.isPending}
            className="rounded-lg bg-kds-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {savePrinterMutation.isPending ? '…' : saved ? '✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fi = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none transition-colors'
