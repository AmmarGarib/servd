'use client'
// Welcome Wizard — interactive 6-step setup for a fresh-start project.
// Auto-creates the tenant, first brand, first location, hours, first menu
// category and a starter menu item. Each step writes to the API as the user
// progresses so partial completion is durable.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { MapPin } from '../../components/ui/MapPin'
import { MoneyInput } from '../../components/ui/MoneyInput'

type StepKey = 'company' | 'brand' | 'location' | 'hours' | 'menu' | 'done'

const STEP_ORDER: StepKey[] = ['company', 'brand', 'location', 'hours', 'menu', 'done']
const STEP_LABEL: Record<StepKey, string> = {
  company: 'Company',
  brand: 'Brand(s)',
  location: 'First kitchen',
  hours: 'Hours',
  menu: 'Menu categories',
  done: 'Live',
}

interface Tenant {
  id: string; slug: string; name: string
  ownerEmail: string | null; industry: string | null
  countryCode: string; currency: string; timezone: string
  // Present on /tenants/mine response — flags the user's role + which is active
  role?: string
  isActive?: boolean
}
interface Concept {
  id: string; slug: string; name: string
  type?: string
  primaryColor?: string | null
  heroTagline?: string | null
  province?: string | null
  conceptStatement?: string | null
  cuisine?: string | null
  heroProduct?: string | null
  anchoringExperience?: string | null
  targetCustomer?: string | null
  priceTier?: string | null
  daypartFocus?: string[]
  competitors?: string[]
  differentiator?: string | null
  brandVoice?: string | null
}
interface Location { id: string; name: string }

export default function OnboardingWizardPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const [step, setStep] = useState<StepKey>('company')

  const { data: tenants = [] } = useQuery<Tenant[]>({ queryKey: ['wizard-tenants'], queryFn: () => api.get<Tenant[]>('/tenants/mine') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['wizard-concepts'], queryFn: () => api.get<Concept[]>('/concepts') })
  const { data: locations = [] } = useQuery<Location[]>({ queryKey: ['wizard-locations'], queryFn: () => api.get<Location[]>('/locations') })

  // Auto-advance to the first incomplete step on initial load
  useEffect(() => {
    if (tenants.length === 0) { setStep('company'); return }
    if (concepts.length === 0) { setStep('brand'); return }
    if (locations.length === 0) { setStep('location'); return }
  }, [tenants.length, concepts.length, locations.length])

  const stepIndex = STEP_ORDER.indexOf(step)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Browser <option> dropdowns ignore the page's dark theme by default and
          render white-on-white. Force dark styling globally for this page. */}
      <style>{`
        select option { background-color: var(--surface); color: #f5f5f5; }
        select option:hover, select option:checked { background-color: var(--elevated); }
      `}</style>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center justify-between max-w-3xl mx-auto">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Setup</p>
            <h1 className="text-2xl font-black text-white/90 mt-1">Get servd running.</h1>
            <p className="text-sm text-white/40 mt-1">
              Six steps. About ten minutes. You can come back to any of them later.
            </p>
          </div>
          <button
            onClick={() => { localStorage.setItem('servd_skip_wizard', '1'); router.push('/w') }}
            className="text-xs text-white/45 hover:text-white shrink-0">
            Skip to your workspace →
          </button>
        </div>

        <div className="flex gap-2 mt-6 max-w-3xl mx-auto">
          {STEP_ORDER.map((s, i) => {
            const isActive = i === stepIndex
            const isDone = i < stepIndex
            return (
              <button key={s} onClick={() => setStep(s)} className="flex-1 group text-left">
                <div className="h-1 rounded-full transition-colors"
                  style={{ background: isActive ? 'var(--erp-primary)' : isDone ? 'rgb(135 197 64 / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)' }} />
                <p className="text-[10px] font-black uppercase tracking-[0.18em] mt-2"
                  style={{ color: isActive ? 'var(--erp-primary-ink)' : isDone ? 'rgb(79 122 28 / 0.7)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
                  {i + 1} · {STEP_LABEL[s]}
                </p>
              </button>
            )
          })}
        </div>
      </header>

      <div className="px-7 py-8 max-w-3xl mx-auto">
        {step === 'company'  && <CompanyStep tenants={tenants} onDone={() => {
          qc.invalidateQueries({ queryKey: ['wizard-tenants'] })
          qc.invalidateQueries({ queryKey: ['wizard-concepts'] })
          qc.invalidateQueries({ queryKey: ['wizard-locations'] })
          setStep('brand')
        }} />}
        {step === 'brand'    && <BrandStep onDone={() => { qc.invalidateQueries({ queryKey: ['wizard-concepts'] }); setStep('location') }} />}
        {step === 'location' && <LocationStep concepts={concepts} onDone={() => { qc.invalidateQueries({ queryKey: ['wizard-locations'] }); setStep('hours') }} />}
        {step === 'hours'    && <HoursStep concepts={concepts} onDone={() => setStep('menu')} />}
        {step === 'menu'     && <MenuStep concepts={concepts} onDone={() => setStep('done')} />}
        {step === 'done'     && <DoneStep onGo={() => router.push('/w')} />}
      </div>
    </div>
  )
}

// ─── Step 1 · Company / tenant ───────────────────────────────────────────────

// Step 1 supports the full multi-tenant manager: list existing companies the
// user is a member of, switch active company, edit active, or create a new one.
// Each company is billed independently — same login can own many.

const INDUSTRY_OPTIONS: { value: string; label: string }[] = [
  { value: 'qsr', label: 'Quick service / fast food (burgers, sandwiches, fried chicken)' },
  { value: 'casual_dining', label: 'Casual dining' },
  { value: 'fine_dining', label: 'Fine dining' },
  { value: 'cafe', label: 'Café / coffee shop' },
  { value: 'bakery', label: 'Bakery / patisserie' },
  { value: 'cloud_kitchen', label: 'Cloud kitchen (delivery only)' },
  { value: 'multi_brand', label: 'Multi-brand operator (multiple concepts in one kitchen)' },
  { value: 'desi', label: 'Desi / Pakistani / Indian' },
  { value: 'biryani', label: 'Biryani / handi specialist' },
  { value: 'bbq_grill', label: 'BBQ / grill / kebabs' },
  { value: 'pizzeria', label: 'Pizzeria' },
  { value: 'asian', label: 'Asian (Chinese, Thai, Japanese, Korean)' },
  { value: 'middle_eastern', label: 'Middle Eastern / shawarma / Lebanese' },
  { value: 'dessert', label: 'Dessert / ice cream / sweets' },
  { value: 'juice_health', label: 'Juice bar / health / smoothie' },
  { value: 'catering', label: 'Catering / events / corporate' },
  { value: 'food_truck', label: 'Food truck / mobile' },
  { value: 'bar_pub', label: 'Bar / pub / nightlife' },
  { value: 'other', label: "Other (we'll ask later)" },
]

const TIMEZONE_OPTIONS = [
  { value: 'Asia/Karachi', label: 'Asia/Karachi (PKT)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
  { value: 'Asia/Riyadh', label: 'Asia/Riyadh (AST)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Dhaka', label: 'Asia/Dhaka (BST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'America/New_York', label: 'America/New York (EST/EDT)' },
]

function CompanyStep({ tenants, onDone }: { tenants: Tenant[]; onDone: () => void }) {
  const qc = useQueryClient()
  const active = tenants.find((t) => t.isActive) ?? tenants[0]
  // mode: 'list' shows existing + add-new option; 'edit' shows the form for the
  // active tenant; 'new' shows a blank create form; 'merge' lets the user
  // combine two tenants.
  // Initial state must match SSR — we read `?tab=merge` after mount.
  const [mode, setMode] = useState<'list' | 'edit' | 'new' | 'merge'>(
    tenants.length === 0 ? 'new' : 'list',
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (new URLSearchParams(window.location.search).get('tab') === 'merge' && tenants.length >= 2) {
      setMode('merge')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchTenant = useMutation({
    mutationFn: (id: string) => api.post(`/tenants/switch/${id}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wizard-tenants'] })
      qc.invalidateQueries({ queryKey: ['wizard-concepts'] })
      qc.invalidateQueries({ queryKey: ['wizard-locations'] })
    },
  })

  if (mode === 'new') {
    return <CompanyForm
      tenant={undefined}
      onSaved={() => { qc.invalidateQueries({ queryKey: ['wizard-tenants'] }); onDone() }}
      onCancel={tenants.length > 0 ? () => setMode('list') : undefined}
    />
  }
  if (mode === 'edit' && active) {
    return <CompanyForm
      tenant={active}
      onSaved={() => { qc.invalidateQueries({ queryKey: ['wizard-tenants'] }); onDone() }}
      onCancel={() => setMode('list')}
    />
  }
  if (mode === 'merge') {
    return <MergeCompaniesForm tenants={tenants} onDone={() => setMode('list')} />
  }

  // List mode
  return (
    <Card title="Your companies"
      hint="Each company is a separate legal entity — own staff, P&L, billing. Switch between them or add a new one. The active company's brands &amp; locations are what you'll set up in the next steps.">

      <div className="space-y-2">
        {tenants.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-xl p-3"
            style={{
              background: t.isActive ? 'rgb(135 197 64 / 0.08)' : 'rgb(var(--fg-rgb) / 0.025)',
              border: `1px solid ${t.isActive ? 'rgb(135 197 64 / 0.3)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
            }}>
            <span className="text-2xl shrink-0" aria-hidden="true">🏢</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-bold text-white/90 text-sm truncate">{t.name}</p>
                {t.isActive && (
                  <span className="text-[10px] font-black uppercase tracking-wider text-primary-ink bg-primary/10 px-1.5 py-0.5 rounded">
                    Active
                  </span>
                )}
                {t.role && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                    {t.role}
                  </span>
                )}
              </div>
              <p className="text-xs text-white/45 font-mono truncate mt-0.5">/{t.slug} · {t.industry ?? 'unset industry'}</p>
            </div>
            {t.isActive ? (
              <button onClick={() => setMode('edit')}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/65 hover:text-white shrink-0">
                Edit
              </button>
            ) : (
              <button onClick={() => switchTenant.mutate(t.id)}
                disabled={switchTenant.isPending}
                className="rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs font-bold text-white/85 shrink-0 disabled:opacity-50">
                {switchTenant.isPending ? '…' : 'Switch to'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        <button onClick={() => setMode('new')}
          className="rounded-xl border-2 border-dashed border-white/15 px-4 py-3 text-sm font-bold text-white/55 hover:text-white hover:border-white/30 transition-colors">
          + Add a new company
        </button>
        <button onClick={() => setMode('merge')}
          disabled={tenants.length < 2}
          title={tenants.length < 2 ? 'You need at least two companies to combine' : ''}
          className="rounded-xl border-2 border-dashed border-white/15 px-4 py-3 text-sm font-bold text-white/55 hover:text-white hover:border-white/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
          ⤵ Combine companies
        </button>
      </div>

      {switchTenant.error && <ErrorBanner error={switchTenant.error} />}

      <Footer>
        <p className="text-xs text-white/45 mr-auto self-center">
          Active: <span className="font-bold text-white/85">{active?.name ?? '—'}</span> · brands &amp; locations
          you set up next will belong to this company
        </p>
        <button onClick={onDone} disabled={!active} className={primaryBtn}>
          Continue with {active?.name ?? '—'} →
        </button>
      </Footer>
    </Card>
  )
}

// ─── CompanyForm — shared edit/create form ───────────────────────────────────

function CompanyForm({ tenant, onSaved, onCancel }: {
  tenant: Tenant | undefined
  onSaved: () => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(tenant?.name ?? '')
  const [ownerEmail, setOwnerEmail] = useState(tenant?.ownerEmail ?? '')
  const [industry, setIndustry] = useState(tenant?.industry ?? 'qsr')
  const [timezone, setTimezone] = useState(tenant?.timezone ?? 'Asia/Karachi')
  const isEditing = !!tenant

  const save = useMutation({
    mutationFn: () => {
      const payload = { name, ownerEmail: ownerEmail || null, industry, timezone }
      return isEditing
        ? api.patch(`/tenants/${tenant.id}`, payload)
        : api.post('/tenants', payload)
    },
    onSuccess: () => {
      localStorage.setItem('servd_wizard_industry', industry)
      onSaved()
    },
  })

  return (
    <Card title={isEditing ? `Editing ${tenant.name}` : 'Add a new company'}
      hint={isEditing
        ? 'The name you give here goes on receipts, FBR invoices, and customer emails for this company.'
        : 'A new company = its own legal entity, billing, FBR registration, and isolated data.'}>
      <Field label="Company name *">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="GS Foods (Pvt) Ltd" className={fieldCls} autoFocus />
      </Field>
      <Field label="Owner email">
        <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="ali@gsfoods.pk" className={fieldCls} />
        <Hint>Where critical alerts go: refund threshold breaches, FBR submission failures, daily digests.</Hint>
      </Field>
      <Field label="What you run">
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} className={selectCls}>
          {INDUSTRY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </Field>
      <Field label="Timezone">
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={selectCls}>
          {TIMEZONE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </Field>

      {save.error && <ErrorBanner error={save.error} />}

      <Footer>
        <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
          {save.isPending ? 'Saving…' : isEditing ? 'Save & continue →' : 'Create company →'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="text-xs text-white/45 hover:text-white/75 transition-colors">
            ← Back to companies
          </button>
        )}
      </Footer>
    </Card>
  )
}

// ─── Combine two companies into one (destructive) ──────────────────────────

function MergeCompaniesForm({ tenants, onDone }: { tenants: Tenant[]; onDone: () => void }) {
  const qc = useQueryClient()
  const active = tenants.find((t) => t.isActive)
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState(active?.id ?? '')
  const [confirmText, setConfirmText] = useState('')

  const source = tenants.find((t) => t.id === sourceId)
  const target = tenants.find((t) => t.id === targetId)
  const confirmExpected = source ? `merge ${source.name}` : ''
  const canMerge = !!sourceId && !!targetId && sourceId !== targetId && confirmText.trim() === confirmExpected

  const merge = useMutation({
    mutationFn: () => api.post<{ conceptsMoved: number; usersMoved: number }>('/tenants/merge', { sourceId, targetId }),
    onSuccess: () => {
      qc.invalidateQueries()
      onDone()
    },
  })

  return (
    <Card title="Combine two companies"
      hint="Move every brand, location, staff member, and historical record from one company into another. The source company is then closed. This cannot be undone.">

      <div className="rounded-xl px-4 py-3 mb-1"
        style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)' }}>
        <p className="text-sm font-bold text-red-700/90 mb-1">⚠ Destructive operation</p>
        <p className="text-xs text-white/65 leading-relaxed">
          Everything under the <span className="font-bold">source</span> company — brands, kitchens, orders, staff,
          ledger — gets reassigned to the <span className="font-bold">target</span>. The source company is then
          closed. There is no rollback.
        </p>
      </div>

      <Field label="Source company (will be merged in & closed) *">
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={selectCls}>
          <option value="">Pick a company…</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id} disabled={t.id === targetId}>
              {t.name}{t.isActive ? ' (active)' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Target company (everything moves here) *">
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className={selectCls}>
          <option value="">Pick a company…</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id} disabled={t.id === sourceId}>
              {t.name}{t.isActive ? ' (active)' : ''}
            </option>
          ))}
        </select>
      </Field>

      {source && target && (
        <div className="rounded-xl p-4"
          style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <p className="text-xs text-white/55 leading-relaxed mb-3">
            All brands, staff, and historical data under <span className="font-bold text-white/90">{source.name}</span>{' '}
            will be moved into <span className="font-bold text-white/90">{target.name}</span>.
            Then <span className="font-bold text-white/90">{source.name}</span> will be closed.
          </p>
          <Field label={`Type "${confirmExpected}" to confirm`}>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder={confirmExpected}
              className={fieldCls} autoComplete="off" />
          </Field>
        </div>
      )}

      {merge.error && <ErrorBanner error={merge.error} />}

      <Footer>
        <button onClick={() => merge.mutate()} disabled={!canMerge || merge.isPending}
          className="rounded-xl bg-s-red text-[#fff] font-bold px-5 py-2.5 text-sm hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          {merge.isPending ? 'Combining…' : 'Combine companies →'}
        </button>
        <button type="button" onClick={onDone}
          className="text-xs text-white/45 hover:text-white/75 transition-colors">
          ← Back to companies
        </button>
      </Footer>
    </Card>
  )
}

// ─── Step 2 · First brand (concept) ──────────────────────────────────────────
// Multi-brand mode: when industry === 'multi_brand', render a list of brands
// being created + a "+ add another brand" button. Otherwise just one form.

function BrandStep({ onDone }: { onDone: () => void }) {
  const [isMultiBrand, setIsMultiBrand] = useState(false)
  useEffect(() => {
    setIsMultiBrand(localStorage.getItem('servd_wizard_industry') === 'multi_brand')
  }, [])

  if (isMultiBrand) return <MultiBrandStep onDone={onDone} />
  return <SingleBrandStep onDone={onDone} />
}

function SingleBrandStep({ onDone }: { onDone: () => void }) {
  return <BrandBriefForm
    title="Define your brand"
    hint="The strategic brief — concept, hero product, anchoring experience, who you're for, who you compete with. We'll auto-fill the technical bits at the end."
    onCreated={onDone}
    showContinueAfterCreate
  />
}

// ─── Step 2b · Multi-brand mode ──────────────────────────────────────────────
// Operator runs multiple concepts in one kitchen. Add brands one-at-a-time;
// each goes through the same strategic-brief form. Continue requires at
// least one brand briefed.

function MultiBrandStep({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const { data: existingBrands = [] } = useQuery<Concept[]>({
    queryKey: ['wizard-concepts'], queryFn: () => api.get<Concept[]>('/concepts'),
  })
  // mode: idle (just showing list), 'new' (form for a new brand), or
  // { editing: brand } (form pre-populated for an existing brand).
  const [mode, setMode] = useState<'idle' | 'new' | { editing: Concept }>('idle')

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/concepts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wizard-concepts'] }),
  })

  return (
    <Card title="Define your brands"
      hint="You run multiple concepts. Brief each one — concept, hero product, anchor, who you're for. They'll all share the kitchen you set up in the next step.">

      {existingBrands.length > 0 && mode === 'idle' && (
        <div className="space-y-2">
          {existingBrands.map((b) => (
            <div key={b.id} className="flex items-center gap-3 rounded-lg p-3"
              style={{ background: 'rgb(135 197 64 / 0.06)', border: '1px solid rgb(135 197 64 / 0.18)' }}>
              <span className="text-primary-ink text-lg shrink-0" aria-hidden="true">✓</span>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-white/90 text-sm">{b.name}</p>
                <p className="text-xs text-white/45 font-mono truncate">{b.conceptStatement ?? `/${b.slug}`}</p>
              </div>
              <button onClick={() => setMode({ editing: b })}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white shrink-0">
                Edit
              </button>
              <button onClick={() => { if (confirm(`Delete brand "${b.name}"? You can re-create it later.`)) del.mutate(b.id) }}
                className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-700/70 hover:text-red-700 shrink-0">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {(existingBrands.length === 0 || mode !== 'idle') && (
        <div className="mt-3">
          <BrandBriefForm
            inline
            title=""
            hint=""
            existingBrand={mode !== 'idle' && mode !== 'new' ? mode.editing : undefined}
            onCreated={() => {
              qc.invalidateQueries({ queryKey: ['wizard-concepts'] })
              setMode('idle')
            }}
            onCancel={existingBrands.length > 0 ? () => setMode('idle') : undefined}
            defaultColor={pickColor(existingBrands.length + 1)}
          />
        </div>
      )}

      {existingBrands.length > 0 && mode === 'idle' && (
        <button onClick={() => setMode('new')}
          className="w-full rounded-xl border-2 border-dashed border-white/15 px-4 py-3 text-sm font-bold text-white/55 hover:text-white hover:border-white/30 transition-colors mt-3">
          + Brief another brand
        </button>
      )}

      <Footer>
        <p className="text-xs text-white/45 mr-auto self-center">
          {existingBrands.length === 0
            ? 'Brief at least one brand to continue'
            : `${existingBrands.length} brand${existingBrands.length === 1 ? '' : 's'} briefed · add more or continue`}
        </p>
        <button onClick={onDone} disabled={existingBrands.length === 0 || mode !== 'idle'} className={primaryBtn}>
          Continue →
        </button>
      </Footer>
    </Card>
  )
}

// Pick a default colour from a small palette so each new brand looks distinct.
function pickColor(n: number): string {
  const palette = ['#D4581A', '#3d1f3b', '#3f7d20', '#a15c00', '#6b2f68', '#be185d', '#1d4ed8', '#84CC16']
  return palette[(n - 1) % palette.length]!
}

// ─── BrandBriefForm — strategic brief for a single brand ─────────────────────
// Used by both single-brand and multi-brand modes. Captures the operator's
// brand-strategy thinking up front (concept, hero, anchor, target, competitors,
// wedge, voice) and tucks the operational details (slug, tax, color, type)
// at the bottom in an "Advanced" panel that's auto-filled and rarely opened.

const DAYPARTS = ['breakfast', 'lunch', 'tea', 'dinner', 'late_night']
const PRICE_TIERS: { value: 'budget' | 'mid' | 'premium' | 'luxury'; label: string; hint: string }[] = [
  { value: 'budget',  label: 'Budget',  hint: 'Under PKR 500 ticket' },
  { value: 'mid',     label: 'Mid',     hint: 'PKR 500–1,500 ticket' },
  { value: 'premium', label: 'Premium', hint: 'PKR 1,500–4,000 ticket' },
  { value: 'luxury',  label: 'Luxury',  hint: 'PKR 4,000+ · destination dining' },
]

// Pakistan sales-tax rates per provincial revenue authority. Source: SRB/PRA/
// KPRA/BRA published rate cards as of 2025. Restaurants are services so they
// fall under the provincial regimes (not federal FBR sales tax on goods).
type ProvinceCode = 'SD' | 'PB' | 'KP' | 'BL' | 'ICT' | 'GB' | 'AJK'
const PROVINCES: { value: ProvinceCode; name: string; authority: string; rate: number; cardRate?: number; note?: string }[] = [
  { value: 'SD',  name: 'Sindh',                  authority: 'SRB',  rate: 13, note: 'Karachi, Hyderabad' },
  { value: 'PB',  name: 'Punjab',                 authority: 'PRA',  rate: 16, cardRate: 5, note: 'Lahore, Faisalabad. Card / digital payments at 5%.' },
  { value: 'KP',  name: 'Khyber Pakhtunkhwa',     authority: 'KPRA', rate: 8,  note: 'Peshawar, Mardan' },
  { value: 'BL',  name: 'Balochistan',            authority: 'BRA',  rate: 15, note: 'Quetta' },
  { value: 'ICT', name: 'Islamabad Capital',      authority: 'FBR',  rate: 16, note: 'Federal jurisdiction' },
  { value: 'GB',  name: 'Gilgit-Baltistan',       authority: 'GBRA', rate: 15 },
  { value: 'AJK', name: 'Azad Jammu & Kashmir',   authority: 'AJK',  rate: 15 },
]
function provinceRate(p: ProvinceCode | null | undefined): number {
  if (!p) return 13
  return PROVINCES.find((x) => x.value === p)?.rate ?? 13
}

interface BrandBriefFormProps {
  title: string
  hint: string
  onCreated: () => void
  onCancel?: () => void
  inline?: boolean                    // when true, skip the outer Card wrapper
  defaultColor?: string
  showContinueAfterCreate?: boolean   // single-brand mode: auto-advance after save
  existingBrand?: Concept             // when present, edit-mode: pre-populate + PATCH
}

function BrandBriefForm({ title, hint, onCreated, onCancel, inline, defaultColor, showContinueAfterCreate, existingBrand }: BrandBriefFormProps) {
  const isEdit = !!existingBrand

  // Strategy
  const [name, setName] = useState(existingBrand?.name ?? '')
  const [conceptStatement, setConceptStatement] = useState(existingBrand?.conceptStatement ?? '')
  const [cuisine, setCuisine] = useState(existingBrand?.cuisine ?? '')
  const [heroProduct, setHeroProduct] = useState(existingBrand?.heroProduct ?? '')
  const [anchoringExperience, setAnchoringExperience] = useState(existingBrand?.anchoringExperience ?? '')
  const [daypartFocus, setDaypartFocus] = useState<string[]>(existingBrand?.daypartFocus ?? ['lunch', 'dinner'])

  // Position
  const [targetCustomer, setTargetCustomer] = useState(existingBrand?.targetCustomer ?? '')
  const [priceTier, setPriceTier] = useState<'budget' | 'mid' | 'premium' | 'luxury'>((existingBrand?.priceTier as 'budget' | 'mid' | 'premium' | 'luxury') ?? 'mid')
  const [competitors, setCompetitors] = useState<string[]>(existingBrand?.competitors ?? [])
  const [competitorInput, setCompetitorInput] = useState('')
  const [differentiator, setDifferentiator] = useState(existingBrand?.differentiator ?? '')
  const [brandVoice, setBrandVoice] = useState(existingBrand?.brandVoice ?? '')

  // Tax — operator picks province, we derive the default rate. Per-payment-
  // method, per-channel and per-item overrides are applied at transaction
  // time (POS, storefront, ingestion) and during P&L computation — not here.
  const [province, setProvince] = useState<ProvinceCode>((existingBrand?.province as ProvinceCode) ?? 'SD')

  // Visual / setup (auto-derived; hidden in advanced)
  const [primaryColor, setPrimaryColor] = useState(existingBrand?.primaryColor ?? defaultColor ?? '#D4581A')
  const [heroTagline, setHeroTagline] = useState(existingBrand?.heroTagline ?? '')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [slug, setSlug] = useState(existingBrand?.slug ?? '')
  const [type, setType] = useState<'restaurant' | 'cafe' | 'cloud_kitchen' | 'food_truck'>((existingBrand?.type as 'restaurant' | 'cafe' | 'cloud_kitchen' | 'food_truck') ?? 'restaurant')

  // Auto-derive slug from name (skip if editing — slug is immutable post-create
  // because storefront URLs already point at it).
  useEffect(() => {
    if (isEdit) return
    if (!slug || slug === slugify(name).slice(0, slug.length)) setSlug(slugify(name))
  }, [name])  // eslint-disable-line react-hooks/exhaustive-deps

  function addCompetitor() {
    const v = competitorInput.trim()
    if (!v || competitors.includes(v) || competitors.length >= 5) return
    setCompetitors([...competitors, v]); setCompetitorInput('')
  }
  function toggleDaypart(d: string) {
    setDaypartFocus((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d])
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name, type,
        primaryColor,
        taxRate: provinceRate(province),    // base rate; transaction-time rules can override
        province,
        heroTagline: heroTagline || conceptStatement || null,
        isActive: true, storefrontVisible: true,
        conceptStatement: conceptStatement || null,
        cuisine: cuisine || null,
        heroProduct: heroProduct || null,
        anchoringExperience: anchoringExperience || null,
        targetCustomer: targetCustomer || null,
        priceTier,
        daypartFocus,
        competitors,
        differentiator: differentiator || null,
        brandVoice: brandVoice || null,
      }
      if (isEdit && existingBrand) {
        return api.patch(`/concepts/${existingBrand.id}`, payload)
      }
      return api.post('/concepts', { ...payload, slug })
    },
    onSuccess: () => onCreated(),
  })

  const body = (
    <>
      <Section heading="Concept">
        <Field label="Brand name *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stax" className={fieldCls} autoFocus />
        </Field>
        <Field label="One-line concept *">
          <input value={conceptStatement} onChange={(e) => setConceptStatement(e.target.value)}
            placeholder="Build-your-own smashburger over brioche, focaccia or croissant" maxLength={280} className={fieldCls} />
          <Hint>How you pitch the brand in one breath.</Hint>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cuisine / category">
            <input value={cuisine} onChange={(e) => setCuisine(e.target.value)}
              placeholder="Burgers · Smashburgers" className={fieldCls} />
          </Field>
          <Field label="Hero product">
            <input value={heroProduct} onChange={(e) => setHeroProduct(e.target.value)}
              placeholder="The Stax Classic" className={fieldCls} />
            <Hint>The signature dish.</Hint>
          </Field>
        </div>
        <Field label="Anchoring experience">
          <textarea value={anchoringExperience} onChange={(e) => setAnchoringExperience(e.target.value)} rows={2}
            placeholder="27-layer in-house croissant. Lacy-edged smash patties. Build-your-own with 18 toppings." className={fieldCls} />
          <Hint>What makes the brand memorable.</Hint>
        </Field>
        <Field label="Daypart focus">
          <div className="flex flex-wrap gap-1.5">
            {DAYPARTS.map((d) => (
              <button key={d} type="button" onClick={() => toggleDaypart(d)}
                className="text-xs font-bold px-3 py-1.5 rounded-full"
                style={daypartFocus.includes(d)
                  ? { background: 'rgb(135 197 64 / 0.15)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(135 197 64 / 0.4)' }
                  : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.55)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                {d.replace('_', ' ')}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section heading="Customer & price">
        <Field label="Who's it for?">
          <textarea value={targetCustomer} onChange={(e) => setTargetCustomer(e.target.value)} rows={2}
            placeholder="22–35 urban DHA / Clifton, weekly indulgence with friends, willing to pay premium for in-house craft." className={fieldCls} />
          <Hint>Customer profile: age, geography, occasion, willingness-to-pay.</Hint>
        </Field>
        <Field label="Price tier">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {PRICE_TIERS.map((t) => (
              <button key={t.value} type="button" onClick={() => setPriceTier(t.value)}
                className="text-xs px-3 py-2.5 rounded-lg text-left"
                style={priceTier === t.value
                  ? { background: 'rgb(135 197 64 / 0.12)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(135 197 64 / 0.45)' }
                  : { background: 'rgb(var(--fg-rgb) / 0.025)', color: 'rgb(var(--fg-rgb) / 0.7)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <p className="font-bold">{t.label}</p>
                <p className="text-[10px] opacity-75 mt-0.5">{t.hint}</p>
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section heading="Tax jurisdiction">
        <Field label="Province *">
          <select value={province} onChange={(e) => setProvince(e.target.value as ProvinceCode)} className={selectCls}>
            {PROVINCES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.name} — {p.authority} · {p.rate}%{p.cardRate ? ` (card ${p.cardRate}%)` : ''}
              </option>
            ))}
          </select>
          <Hint>
            Sets the base sales-tax rate. Transaction-time rules — card vs cash, dine-in vs delivery, zero-rated items — apply automatically at the till and on P&L. You don't manage rates per item here.
          </Hint>
        </Field>
        <div className="rounded-xl px-4 py-3 text-xs"
          style={{ background: 'rgb(135 197 64 / 0.05)', border: '1px solid rgb(135 197 64 / 0.18)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
          <strong className="text-primary-ink">{PROVINCES.find((p) => p.value === province)?.name}</strong>
          {' · '}{PROVINCES.find((p) => p.value === province)?.authority}{' authority · '}
          base rate <strong>{provinceRate(province)}%</strong>
          {PROVINCES.find((p) => p.value === province)?.cardRate &&
            <> · card payments <strong>{PROVINCES.find((p) => p.value === province)?.cardRate}%</strong></>
          }
          {PROVINCES.find((p) => p.value === province)?.note && <span className="block text-white/50 mt-1">{PROVINCES.find((p) => p.value === province)?.note}</span>}
        </div>
      </Section>

      <Section heading="Competitive landscape">
        <Field label="Top competitors (up to 5)">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {competitors.map((c) => (
              <span key={c} className="inline-flex items-center gap-2 rounded-full px-3 py-1.5"
                style={{ background: 'rgba(245,158,11,0.12)', color: '#a15c00', border: '1px solid rgba(245,158,11,0.3)' }}>
                <span className="text-xs font-bold">{c}</span>
                <button onClick={() => setCompetitors(competitors.filter((x) => x !== c))} className="text-xs">✕</button>
              </span>
            ))}
            {competitors.length === 0 && <p className="text-xs text-white/35 italic">None added yet.</p>}
          </div>
          <div className="flex gap-2">
            <input value={competitorInput} onChange={(e) => setCompetitorInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCompetitor() } }}
              placeholder="Burger Lab, Daily Deli, Johnny Rockets PK…"
              disabled={competitors.length >= 5}
              className={fieldCls + ' flex-1'} />
            <button onClick={addCompetitor} disabled={!competitorInput.trim() || competitors.length >= 5}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-on disabled:opacity-50">+ Add</button>
          </div>
          <Hint>Press Enter to add. Drives benchmarking + market-share dashboards later.</Hint>
        </Field>
        <Field label="Your differentiator / wedge">
          <textarea value={differentiator} onChange={(e) => setDifferentiator(e.target.value)} rows={2}
            placeholder="In-house lamination of croissants & focaccia. Cooked-when-ordered. Heat-graded build-your-own." className={fieldCls} />
          <Hint>Why customers choose you over the names above.</Hint>
        </Field>
      </Section>

      <Section heading="Brand voice">
        <Field label="Tone of voice">
          <textarea value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} rows={3}
            placeholder="Loud, urban, no-precious-paragraphs. Slab type. All-caps editorial. We don't apologise for spice." className={fieldCls} />
          <Hint>How marketing copy + customer messages should sound.</Hint>
        </Field>
        <Field label="One-line tagline">
          <input value={heroTagline} onChange={(e) => setHeroTagline(e.target.value)}
            placeholder="Smashed. Stacked. Sauced." maxLength={120} className={fieldCls} />
          <Hint>Goes in the hero of your storefront. Leave blank to use the concept statement.</Hint>
        </Field>
        <Field label="Brand colour">
          <div className="flex gap-2">
            <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-12 h-10 rounded cursor-pointer bg-transparent" />
            <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className={fieldCls + ' font-mono flex-1'} />
            <div className="flex-1 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider"
              style={{ background: primaryColor, color: 'var(--erp-on-primary)' }}>
              Preview
            </div>
          </div>
        </Field>
      </Section>

      {/* Advanced — slug + venue type. Tax is no longer here (province above). */}
      <button onClick={() => setAdvancedOpen((v) => !v)} type="button"
        className="w-full text-left text-xs font-bold uppercase tracking-[0.18em] text-white/45 hover:text-white/70 mt-2">
        {advancedOpen ? '▾' : '▸'}  Advanced · storefront URL &amp; venue type {advancedOpen ? '' : `(auto: /${slug || 'brand'} · ${type})`}
      </button>
      {advancedOpen && (
        <div className="rounded-2xl p-4"
          style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <Field label="Storefront URL slug">
            <input value={slug} onChange={(e) => setSlug(slugify(e.target.value))}
              disabled={isEdit}
              className={fieldCls + ' font-mono disabled:opacity-50'} />
            <Hint>
              {isEdit
                ? <>Locked — changing the slug breaks existing storefront links. Contact support if you must rename.</>
                : <>The URL fragment customers visit: <code className="text-white/65">yourdomain.com/{slug || 'your-brand'}</code>. Auto-derived from your brand name.</>}
            </Hint>
          </Field>
          <Field label="Venue type">
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={selectCls}>
              <option value="restaurant">Dine-in restaurant</option>
              <option value="cafe">Café</option>
              <option value="cloud_kitchen">Cloud kitchen (delivery only)</option>
              <option value="food_truck">Food truck</option>
            </select>
          </Field>
        </div>
      )}

      {save.error && <ErrorBanner error={save.error} />}

      <Footer>
        {onCancel && <button onClick={onCancel} className="text-xs text-white/55 hover:text-white mr-auto">Cancel</button>}
        <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !conceptStatement.trim()}
          className={primaryBtn}>
          {save.isPending
            ? (isEdit ? 'Saving changes…' : 'Saving brief…')
            : isEdit
              ? 'Save changes →'
              : showContinueAfterCreate ? 'Save & continue →' : '+ Save this brand'}
        </button>
      </Footer>
    </>
  )

  return inline ? <div className="rounded-2xl p-5 space-y-5"
    style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>{body}</div>
    : <Card title={title} hint={hint}>{body}</Card>
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[11px] font-black uppercase tracking-[0.28em] text-primary-ink/70 pt-2 border-t border-white/[0.05]">{heading}</h3>
      {children}
    </div>
  )
}

// ─── Step 3 · First location ─────────────────────────────────────────────────

function LocationStep({ concepts, onDone }: { concepts: Concept[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [phone, setPhone] = useState('')
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null })
  const [conceptIds, setConceptIds] = useState<string[]>(concepts.map((c) => c.id))

  // Keep all concepts ticked by default as the list loads
  useEffect(() => { setConceptIds(concepts.map((c) => c.id)) }, [concepts])

  const save = useMutation({
    mutationFn: () => api.post('/locations', {
      name, address: address || undefined, city: city || undefined, phone: phone || undefined,
      latitude: coords.lat, longitude: coords.lng,
      conceptIds, isActive: true,
    }),
    onSuccess: onDone,
  })

  return (
    <Card title="Where's your kitchen?"
      hint="A location is a physical place. Multi-concept kitchens link all the brands they serve here. You can add more locations later.">
      <Field label="Location name *">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="DHA Phase 5 main kitchen" className={fieldCls} autoFocus />
      </Field>
      <Field label="Address">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="MM Alam Road, Block H Gulberg III" className={fieldCls} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City">
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Lahore" className={fieldCls} />
        </Field>
        <Field label="Phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+92 42 1234567" className={fieldCls} />
        </Field>
      </div>

      <Field label="Pin on map *">
        <MapPin value={coords} onChange={setCoords}
          hint="Drives delivery zone radius, geofenced clock-in, and the storefront's nearest-branch picker. Use the 'My location' button on a phone for the most accurate result." />
      </Field>

      <Field label="Brands operated at this location">
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          {concepts.map((c) => (
            <label key={c.id} className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors"
              style={conceptIds.includes(c.id)
                ? { background: 'rgb(135 197 64 / 0.08)', border: '1px solid rgb(135 197 64 / 0.35)' }
                : { background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <input type="checkbox" checked={conceptIds.includes(c.id)}
                onChange={() => setConceptIds((p) => p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id])}
                className="accent-primary" />
              <span className="text-xs font-bold text-white/85">{c.name}</span>
            </label>
          ))}
        </div>
      </Field>

      {save.error && <ErrorBanner error={save.error} />}

      <Footer>
        <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
          {save.isPending ? 'Saving…' : 'Continue →'}
        </button>
      </Footer>
    </Card>
  )
}

// ─── Step 4 · Hours ──────────────────────────────────────────────────────────

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DEFAULT_SHIFT = { openMin: 11 * 60, closeMin: 23 * 60 }

interface Shift { openMin: number; closeMin: number }
interface DayHours { dayOfWeek: number; isOpen: boolean; shifts: Shift[] }

function fmtMin(min: number) {
  const h = Math.floor(min / 60); const m = min % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}
function parseMin(v: string) { const [h, m] = v.split(':').map(Number); return ((h ?? 0) * 60 + (m ?? 0)) }

function HoursStep({ concepts, onDone }: { concepts: Concept[]; onDone: () => void }) {
  const concept = concepts[0]
  const [days, setDays] = useState<DayHours[]>(
    DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true, shifts: [{ ...DEFAULT_SHIFT }] })),
  )

  const save = useMutation({
    mutationFn: async () => {
      if (!concept) return
      // Flatten all shifts from open days into one row each (the API accepts
      // several ServiceHours rows per day-of-week → split-shift support).
      // /setup/hours is the one hours writer (same rows /configuration/hours
      // edits). This used to PUT a path that did not exist and swallow the
      // 404, so wizard-entered hours were silently lost.
      const flat = days.flatMap((d) => d.isOpen
        ? d.shifts.map((s) => ({
            dayOfWeek: d.dayOfWeek, openMin: s.openMin, closeMin: s.closeMin, isReservable: true,
          }))
        : [],
      )
      await api.put(`/setup/hours/${concept.id}`, { hours: flat })
    },
    onSuccess: onDone,
  })

  function patchDay(i: number, p: Partial<DayHours>) {
    setDays((prev) => prev.map((d, idx) => idx === i ? { ...d, ...p } : d))
  }
  function patchShift(dayIdx: number, shiftIdx: number, p: Partial<Shift>) {
    setDays((prev) => prev.map((d, i) => i !== dayIdx ? d : ({
      ...d, shifts: d.shifts.map((s, si) => si === shiftIdx ? { ...s, ...p } : s),
    })))
  }
  function addShift(dayIdx: number) {
    setDays((prev) => prev.map((d, i) => i !== dayIdx ? d : ({
      ...d, shifts: [...d.shifts, { openMin: 18 * 60, closeMin: 23 * 60 }],
    })))
  }
  function removeShift(dayIdx: number, shiftIdx: number) {
    setDays((prev) => prev.map((d, i) => i !== dayIdx ? d : ({
      ...d, shifts: d.shifts.length > 1 ? d.shifts.filter((_, si) => si !== shiftIdx) : d.shifts,
    })))
  }
  function copyToAll(srcIdx: number) {
    const src = days[srcIdx]; if (!src) return
    setDays((prev) => prev.map((d) => ({
      ...d,
      isOpen: src.isOpen,
      shifts: src.shifts.map((s) => ({ ...s })),
    })))
  }
  function copyToWeekdays(srcIdx: number) {
    const src = days[srcIdx]; if (!src) return
    setDays((prev) => prev.map((d) => (d.dayOfWeek >= 1 && d.dayOfWeek <= 5)
      ? { ...d, isOpen: src.isOpen, shifts: src.shifts.map((s) => ({ ...s })) }
      : d))
  }
  function copyToWeekends(srcIdx: number) {
    const src = days[srcIdx]; if (!src) return
    setDays((prev) => prev.map((d) => (d.dayOfWeek === 0 || d.dayOfWeek === 6)
      ? { ...d, isOpen: src.isOpen, shifts: src.shifts.map((s) => ({ ...s })) }
      : d))
  }
  function applyPreset(preset: 'standard' | 'split' | '24-7' | 'weekdays-only') {
    if (preset === 'standard') {
      setDays(DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true, shifts: [{ openMin: 11 * 60, closeMin: 23 * 60 }] })))
    } else if (preset === 'split') {
      setDays(DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true,
        shifts: [{ openMin: 11 * 60, closeMin: 15 * 60 }, { openMin: 18 * 60, closeMin: 23 * 60 }] })))
    } else if (preset === '24-7') {
      setDays(DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true, shifts: [{ openMin: 0, closeMin: 1440 }] })))
    } else if (preset === 'weekdays-only') {
      setDays(DAY_LABELS.map((_, i) => ({
        dayOfWeek: i, isOpen: i >= 1 && i <= 5,
        shifts: [{ openMin: 11 * 60, closeMin: 23 * 60 }],
      })))
    }
  }

  return (
    <Card title="When are you open?"
      hint={`Hours apply to ${concept?.name ?? 'your brand'}'s storefront and reservations. Add multiple shifts per day for split service (e.g. lunch + dinner).`}>

      {/* Quick presets */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[11px] uppercase tracking-wider text-white/40 font-bold mr-1">Quick set:</span>
        <PresetBtn onClick={() => applyPreset('standard')}>11am–11pm daily</PresetBtn>
        <PresetBtn onClick={() => applyPreset('split')}>Lunch + Dinner</PresetBtn>
        <PresetBtn onClick={() => applyPreset('weekdays-only')}>Weekdays only</PresetBtn>
        <PresetBtn onClick={() => applyPreset('24-7')}>24/7</PresetBtn>
      </div>

      <div className="space-y-2">
        {days.map((d, i) => (
          <div key={i} className="rounded-lg p-3"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex items-center justify-between gap-3 mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={d.isOpen}
                  onChange={(e) => patchDay(i, { isOpen: e.target.checked })}
                  className="accent-primary" />
                <span className="text-sm font-bold text-white/85 w-10">{DAY_LABELS[i]}</span>
                {!d.isOpen && <span className="text-xs text-white/35 italic">Closed</span>}
              </label>
              {d.isOpen && (
                <div className="flex items-center gap-1">
                  <CopyMenu
                    onCopyAll={() => copyToAll(i)}
                    onCopyWeekdays={() => copyToWeekdays(i)}
                    onCopyWeekends={() => copyToWeekends(i)}
                  />
                  <button type="button" onClick={() => addShift(i)}
                    className="text-[11px] font-bold text-primary-ink hover:text-white px-2 py-1 rounded hover:bg-white/[0.05] transition-colors">
                    + Add shift
                  </button>
                </div>
              )}
            </div>

            {d.isOpen && (
              <div className="space-y-1.5 ml-6">
                {d.shifts.map((s, si) => (
                  <div key={si} className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-white/35 font-bold w-12">
                      {d.shifts.length > 1 ? `Shift ${si + 1}` : 'Open'}
                    </span>
                    <input type="time" value={fmtMin(s.openMin)}
                      onChange={(e) => patchShift(i, si, { openMin: parseMin(e.target.value) })}
                      className={fieldCls + ' w-32'} />
                    <span className="text-white/40 text-sm">→</span>
                    <input type="time" value={fmtMin(s.closeMin)}
                      onChange={(e) => patchShift(i, si, { closeMin: parseMin(e.target.value) })}
                      className={fieldCls + ' w-32'} />
                    {d.shifts.length > 1 && (
                      <button type="button" onClick={() => removeShift(i, si)}
                        title="Remove shift"
                        className="text-white/30 hover:text-red-700 px-1.5 text-sm transition-colors">×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {save.error && <ErrorBanner error={save.error} />}

      <Footer>
        <button onClick={() => save.mutate()} disabled={save.isPending} className={primaryBtn}>
          {save.isPending ? 'Saving…' : 'Continue →'}
        </button>
      </Footer>
    </Card>
  )
}

function PresetBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="text-[11px] font-bold text-white/65 hover:text-white border border-white/[0.08] hover:border-primary/40 px-2.5 py-1 rounded-full hover:bg-white/[0.04] transition-colors">
      {children}
    </button>
  )
}

function CopyMenu({ onCopyAll, onCopyWeekdays, onCopyWeekends }: {
  onCopyAll: () => void; onCopyWeekdays: () => void; onCopyWeekends: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-white/55 hover:text-white px-2 py-1 rounded hover:bg-white/[0.05] transition-colors">
        ⎘ Copy to…
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 rounded-lg overflow-hidden min-w-[170px]"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.1)', boxShadow: '0 12px 28px rgb(61 31 59 / 0.18)' }}>
            <button type="button" onClick={() => { onCopyAll(); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/[0.05]">All days</button>
            <button type="button" onClick={() => { onCopyWeekdays(); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/[0.05]">Weekdays (Mon–Fri)</button>
            <button type="button" onClick={() => { onCopyWeekends(); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/[0.05]">Weekends (Sat–Sun)</button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Step 5 · Menu categories ────────────────────────────────────────────────

const SUGGESTED_CATEGORIES = [
  'Burgers', 'Sandwiches', 'Wraps', 'Pizzas', 'Pasta', 'Mains',
  'Appetizers', 'Sides', 'Salads', 'Soups',
  'Drinks', 'Mocktails', 'Desserts', 'Specials',
]

function MenuStep({ concepts, onDone }: { concepts: Concept[]; onDone: () => void }) {
  const concept = concepts[0]
  const [draft, setDraft] = useState('')
  const [categories, setCategories] = useState<string[]>([])

  const save = useMutation({
    mutationFn: async () => {
      if (!concept || categories.length === 0) return
      // Sequential POSTs preserve order — backend assigns sortOrder by index.
      for (let i = 0; i < categories.length; i++) {
        await api.post('/menu/categories', {
          conceptId: concept.id, name: categories[i], sortOrder: i,
        })
      }
    },
    onSuccess: onDone,
  })

  function addDraft() {
    const name = draft.trim()
    if (!name) return
    if (categories.includes(name)) { setDraft(''); return }
    setCategories((prev) => [...prev, name])
    setDraft('')
  }
  function addSuggestion(name: string) {
    if (categories.includes(name)) return
    setCategories((prev) => [...prev, name])
  }
  function remove(i: number) {
    setCategories((prev) => prev.filter((_, idx) => idx !== i))
  }
  function move(i: number, dir: -1 | 1) {
    setCategories((prev) => {
      const next = [...prev]
      const j = i + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }

  const remainingSuggestions = SUGGESTED_CATEGORIES.filter((s) => !categories.includes(s))

  return (
    <Card title="What kind of menu do you serve?"
      hint="Just the categories. You'll fill in dishes in the Menu Editor — that's where prices, photos, and modifiers live.">

      {/* Draft input */}
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDraft() } }}
          placeholder="Type a category and press Enter (e.g. Burgers)"
          className={fieldCls + ' flex-1'} autoFocus />
        <button type="button" onClick={addDraft} disabled={!draft.trim()}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-40">
          Add
        </button>
      </div>

      {/* Suggestions */}
      {remainingSuggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-wider text-white/40 font-bold mb-2">Quick add</p>
          <div className="flex flex-wrap gap-1.5">
            {remainingSuggestions.map((s) => (
              <button key={s} type="button" onClick={() => addSuggestion(s)}
                className="text-[11px] font-bold text-white/70 hover:text-white border border-white/[0.08] hover:border-primary/40 px-2.5 py-1 rounded-full hover:bg-white/[0.04] transition-colors">
                + {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selected categories list */}
      <div className="mt-5">
        <p className="text-[11px] uppercase tracking-wider text-white/40 font-bold mb-2">
          Your menu sections {categories.length > 0 && <span className="text-white/65">· {categories.length}</span>}
        </p>
        {categories.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-8 text-center">
            <p className="text-xs text-white/45">No categories yet — add at least one to continue.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {categories.map((cat, i) => (
              <div key={cat} className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <span className="text-[10px] font-mono text-white/35 w-5">{i + 1}.</span>
                <span className="flex-1 text-sm text-white/85 font-semibold">{cat}</span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                  title="Move up"
                  className="text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed text-xs px-1">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === categories.length - 1}
                  title="Move down"
                  className="text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed text-xs px-1">▼</button>
                <button type="button" onClick={() => remove(i)}
                  title="Remove"
                  className="text-white/30 hover:text-red-700 transition-colors px-1.5">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {save.error && <ErrorBanner error={save.error} />}

      <Footer>
        <button onClick={() => save.mutate()} disabled={save.isPending || categories.length === 0} className={primaryBtn}>
          {save.isPending ? 'Creating categories…' : `Continue with ${categories.length || 0} categor${categories.length === 1 ? 'y' : 'ies'} →`}
        </button>
        <button onClick={onDone} className="text-xs text-white/45 hover:text-white/75 transition-colors">
          Skip — I'll add these later in the Menu Editor
        </button>
      </Footer>
    </Card>
  )
}

// ─── Step 6 · Done ───────────────────────────────────────────────────────────

function DoneStep({ onGo }: { onGo: () => void }) {
  return (
    <Card title="You're live."
      hint="Your dashboard now has a brand, a location, hours, and a menu. Next steps live in the Configuration Hub.">
      <div className="rounded-2xl p-5"
        style={{ background: 'rgb(135 197 64 / 0.06)', border: '1px solid rgb(135 197 64 / 0.25)' }}>
        <p className="text-sm font-bold text-primary-ink mb-3">Recommended next steps:</p>
        <ul className="text-sm text-white/80 space-y-2">
          <li>· Add staff under <Link href="/settings" className="text-primary-ink hover:underline">Settings → Staff</Link></li>
          <li>· Configure tax invoice numbering at <Link href="/configuration/tax" className="text-primary-ink hover:underline">Configuration → Tax</Link></li>
          <li>· Connect a payment gateway at <Link href="/configuration/payment-methods" className="text-primary-ink hover:underline">Payment Methods</Link></li>
          <li>· Set delivery zones at <Link href="/configuration/delivery-zones" className="text-primary-ink hover:underline">Delivery Zones</Link></li>
          <li>· Customise email/SMS at <Link href="/configuration/templates" className="text-primary-ink hover:underline">Notification Templates</Link></li>
          <li>· Add allergen + dietary tags at <Link href="/configuration/dietary-tags" className="text-primary-ink hover:underline">Dietary Tags</Link></li>
          <li>· Mark holiday closures at <Link href="/reservations/blockouts" className="text-primary-ink hover:underline">Closures &amp; blockouts</Link></li>
        </ul>
      </div>
      <Footer>
        <button onClick={onGo} className={primaryBtn}>Open your workspace →</button>
      </Footer>
    </Card>
  )
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-7"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-2xl font-black text-white/90">{title}</h2>
      {hint && <p className="text-sm text-white/45 mt-1.5 leading-relaxed">{hint}</p>}
      <div className="mt-6 space-y-4">{children}</div>
    </section>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs font-bold text-white/65">{label}</label><div className="mt-1">{children}</div></div>
}
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-white/35 mt-1">{children}</p>
}
function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end items-center gap-3 pt-4 mt-4 border-t border-white/[0.05]">{children}</div>
}
function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'Something went wrong'
  return (
    <div className="rounded-xl px-4 py-3 mt-4 text-sm"
      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#b42318' }}>
      <strong className="font-bold">Save failed:</strong> {msg}
    </div>
  )
}
function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none"
// Same as fieldCls but with an explicit chevron — the system <select> arrow
// disappears against our dark background. SVG chevron is embedded inline.
const selectCls = fieldCls + " appearance-none cursor-pointer pr-9 bg-no-repeat bg-[right_0.75rem_center] bg-[length:1em] [background-image:url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20d%3D%22M2%204l4%204%204-4%22%20stroke%3D%22%23ffffff80%22%20stroke-width%3D%221.5%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')]"
const primaryBtn = "rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50 transition-opacity"
