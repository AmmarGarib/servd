'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

// /configuration/loyalty — full operator-managed loyalty system.
//   1. Global rules: earn rate, redeem rate, minimum redeem, expiry,
//      birthday bonus, stamp threshold. Each value lives in the Settings
//      table; saving here busts the backend's cache so live earns pick
//      up the change.
//   2. Tier list: every membership tier (Bronze / Silver / Gold / Insider
//      / whatever the operator names them). Edit a tier inline to set:
//        - free vs paid (with monthly price if paid)
//        - lifetime-spend threshold to auto-upgrade (free tiers only)
//        - the structured perks (delivery, birthday, reservations,
//          monthly comp credit, early menu access, free birthday item)
//        - custom freeform perks (bulleted list)
//        - description (operator-facing rationale)
//   3. Create / delete tiers from the top-right + per-row buttons.
//
// The storefront /insiders page is the customer-facing read of the same
// data (to be wired in a follow-up).

interface Tier {
  id:                     string
  tier:                   string
  displayName:            string | null
  rank:                   number
  isPaid:                 boolean
  monthlyPriceCents:      number | null
  unlockSpendCents:       number | null
  isActive:               boolean
  alwaysFreeDelivery:     boolean
  freeDeliveryAboveCents: number | null
  birthdayDiscountPct:    number | null
  priorityReservationDays: number | null
  waitlistPriority:       boolean
  monthlyCompCents:       number | null
  earlyMenuAccess:        boolean
  freeBirthdayItem:       boolean
  customPerks:            string[]
  description:            string | null
  memberCount:            number
}

interface LoyaltySettings {
  values: {
    'loyalty.earn_cents_per_point':  number
    'loyalty.point_value_cents':     number
    'loyalty.min_redeem_points':     number
    'loyalty.expiry_months':         number
    'loyalty.birthday_bonus_points': number
    'loyalty.stamp_threshold':       number
  }
  defaults?: LoyaltySettings['values']
}

export default function LoyaltyAdminPage() {
  const qc = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating,  setCreating]  = useState(false)

  const { data: tiers,    isLoading: tiersLoading } = useQuery<Tier[]>({
    queryKey: ['loyalty-tiers'], queryFn: () => api.get<Tier[]>('/loyalty/tiers'),
  })
  const { data: settings, isLoading: settingsLoading } = useQuery<LoyaltySettings>({
    queryKey: ['loyalty-settings'], queryFn: () => api.get<LoyaltySettings>('/loyalty/settings'),
  })

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-10">
      <header>
        <Link href="/configuration" className="text-xs text-s-dim hover:text-s-text">← Configuration</Link>
        <h1 className="text-3xl font-black mt-2 mb-1">Loyalty &amp; Memberships</h1>
        <p className="text-sm text-s-muted max-w-2xl">
          Configure points earn/redeem rules and the membership tiers customers can unlock.
          Free tiers auto-upgrade on lifetime spend; paid tiers are subscription-priced and
          assigned via CRM (or charged once payments are wired).
        </p>
      </header>

      {/* ── Global rules ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-s-border bg-s-elevated p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Global rules</h2>
            <p className="text-xs text-s-muted">Applied platform-wide. Saving busts the live cache immediately.</p>
          </div>
        </div>
        {settingsLoading || !settings ? (
          <p className="text-sm text-s-muted">Loading…</p>
        ) : (
          <SettingsForm settings={settings} onSaved={() => qc.invalidateQueries({ queryKey: ['loyalty-settings'] })} />
        )}
      </section>

      {/* ── Tiers ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold">Membership tiers</h2>
            <p className="text-xs text-s-muted">
              Stack tiers from least to most generous. Customer's tier is the highest one
              they qualify for (paid memberships beat free).
            </p>
          </div>
          <button onClick={() => setCreating(true)} className="s-btn-primary text-sm">+ New tier</button>
        </div>

        {tiersLoading && <p className="text-sm text-s-muted">Loading tiers…</p>}

        {!tiersLoading && tiers && tiers.length === 0 && !creating && (
          <div className="rounded-xl border border-s-border bg-s-elevated p-8 text-center">
            <p className="text-sm text-s-muted">No tiers yet. Start with a Bronze (auto, free) tier so every customer has a baseline.</p>
            <button onClick={() => setCreating(true)} className="s-btn-primary text-sm mt-4">Create first tier</button>
          </div>
        )}

        <div className="space-y-2">
          {tiers?.map((t) => (
            <TierRow
              key={t.id}
              tier={t}
              expanded={editingId === t.id}
              onToggle={() => setEditingId(editingId === t.id ? null : t.id)}
              onSaved={() => { qc.invalidateQueries({ queryKey: ['loyalty-tiers'] }); setEditingId(null) }}
              onDeleted={() => qc.invalidateQueries({ queryKey: ['loyalty-tiers'] })}
            />
          ))}
        </div>

        {creating && (
          <TierEditor
            initial={null}
            onCancel={() => setCreating(false)}
            onSaved={() => { qc.invalidateQueries({ queryKey: ['loyalty-tiers'] }); setCreating(false) }}
          />
        )}
      </section>
    </div>
  )
}

// ─── Global settings form ─────────────────────────────────────────────

function SettingsForm({ settings, onSaved }: { settings: LoyaltySettings; onSaved: () => void }) {
  const [values, setValues] = useState(settings.values)
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  // Reset local form whenever upstream settings change (e.g. after save)
  useEffect(() => { setValues(settings.values) }, [settings])

  const dirty = Object.entries(values).some(([k, v]) => v !== settings.values[k as keyof typeof values])

  async function save() {
    setSaving(true); setErr(null)
    try {
      await api.patch('/loyalty/settings', values)
      onSaved()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  const fields: Array<{ key: keyof typeof values; label: string; suffix: string; hint: string }> = [
    { key: 'loyalty.earn_cents_per_point',  label: 'Earn — cents of spend per point',      suffix: 'paisa', hint: '100 = 1 point per PKR 1 spent. Lower = customers earn faster.' },
    { key: 'loyalty.point_value_cents',     label: 'Redeem — value of one point',          suffix: 'paisa', hint: '100 = 1 point worth PKR 1 at redeem.' },
    { key: 'loyalty.min_redeem_points',     label: 'Minimum points per redemption',        suffix: 'points', hint: 'Stops dust redemptions cluttering up the books.' },
    { key: 'loyalty.expiry_months',         label: 'Points expire after',                  suffix: 'months', hint: 'Unused points expire this many months after earning.' },
    { key: 'loyalty.birthday_bonus_points', label: 'Birthday bonus',                       suffix: 'points', hint: 'Auto-credited on customer\'s birthday if DOB on file.' },
    { key: 'loyalty.stamp_threshold',       label: 'Visits per stamp-card free item',      suffix: 'orders', hint: 'Per-concept stamp card. Default 9 = buy 9 get 1 free.' },
  ]

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {fields.map((f) => (
          <label key={f.key} className="block space-y-1">
            <span className="text-xs font-bold text-s-muted">{f.label}</span>
            <div className="relative">
              <input
                type="number" min={0}
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: parseInt(e.target.value) || 0 }))}
                className="s-input w-full pr-16"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-s-dim uppercase tracking-wider">
                {f.suffix}
              </span>
            </div>
            <p className="text-[10px] text-s-dim">{f.hint}</p>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-s-border/60">
        <div className="text-xs text-s-dim">
          {dirty ? '· unsaved changes' : '· in sync'}
        </div>
        <div className="flex items-center gap-3">
          {err && <span className="text-xs text-s-red">{err}</span>}
          <button onClick={save} disabled={!dirty || saving} className="s-btn-primary text-sm disabled:opacity-50">
            {saving ? 'Saving…' : 'Save rules'}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Tier row (collapsed list view + click-to-expand editor) ─────────

function TierRow({ tier, expanded, onToggle, onSaved, onDeleted }: {
  tier: Tier
  expanded: boolean
  onToggle: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  return (
    <div className="rounded-xl border border-s-border bg-s-elevated overflow-hidden">
      <button onClick={onToggle}
        className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-s-bg/30 transition-colors">
        <span className="text-[10px] text-s-dim w-6 shrink-0">▾</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-s-text">{tier.displayName || tier.tier}</span>
            <span className="text-[10px] uppercase tracking-wider text-s-dim font-mono">{tier.tier}</span>
            {tier.isPaid && (
              <span className="text-[10px] uppercase font-bold tracking-wider rounded-full px-2 py-0.5 bg-amber-400/10 text-amber-700 border border-amber-400/30">
                PAID · PKR {((tier.monthlyPriceCents ?? 0) / 100).toLocaleString()}/mo
              </span>
            )}
            {!tier.isActive && (
              <span className="text-[10px] uppercase font-bold tracking-wider rounded-full px-2 py-0.5 bg-s-bg text-s-dim border border-s-border">
                INACTIVE
              </span>
            )}
          </div>
          {tier.description && (
            <p className="text-xs text-s-muted mt-1 truncate">{tier.description}</p>
          )}
        </div>
        <div className="text-right shrink-0 text-xs">
          <p className="text-s-muted">{tier.memberCount} member{tier.memberCount === 1 ? '' : 's'}</p>
          <p className="text-s-dim">rank {tier.rank}</p>
        </div>
      </button>
      {expanded && (
        <TierEditor
          initial={tier}
          onCancel={onToggle}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

// ─── Tier editor ────────────────────────────────────────────────────

function TierEditor({ initial, onCancel, onSaved, onDeleted }: {
  initial: Tier | null
  onCancel: () => void
  onSaved: () => void
  onDeleted?: () => void
}) {
  const isNew = initial === null
  const [form, setForm] = useState({
    tier:                   initial?.tier ?? '',
    displayName:            initial?.displayName ?? '',
    rank:                   initial?.rank ?? 0,
    isPaid:                 initial?.isPaid ?? false,
    monthlyPriceCents:      initial?.monthlyPriceCents ?? null,
    unlockSpendCents:       initial?.unlockSpendCents ?? null,
    isActive:               initial?.isActive ?? true,
    alwaysFreeDelivery:     initial?.alwaysFreeDelivery ?? false,
    freeDeliveryAboveCents: initial?.freeDeliveryAboveCents ?? null,
    birthdayDiscountPct:    initial?.birthdayDiscountPct ?? null,
    priorityReservationDays: initial?.priorityReservationDays ?? null,
    waitlistPriority:       initial?.waitlistPriority ?? false,
    monthlyCompCents:       initial?.monthlyCompCents ?? null,
    earlyMenuAccess:        initial?.earlyMenuAccess ?? false,
    freeBirthdayItem:       initial?.freeBirthdayItem ?? false,
    customPerks:            initial?.customPerks ?? [],
    description:            initial?.description ?? '',
  })
  const [perkDraft, setPerkDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function patch<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      const body = {
        ...form,
        // empty-string → null for nullables
        displayName: form.displayName || null,
        description: form.description || null,
        // ensure paid tiers always have a monthly price
        monthlyPriceCents: form.isPaid ? (form.monthlyPriceCents ?? 0) : null,
      }
      if (isNew) {
        if (!body.tier) throw new Error('Tier slug is required (e.g. "insider-gold")')
        await api.post('/loyalty/tiers', body)
      } else {
        await api.patch(`/loyalty/tiers/${initial!.id}`, body)
      }
      onSaved()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  async function remove() {
    if (!initial) return
    if (!confirm(`Delete the "${initial.displayName || initial.tier}" tier? This will fail if customers are still on it — toggle Inactive instead if so.`)) return
    setSaving(true); setErr(null)
    try {
      await api.delete(`/loyalty/tiers/${initial.id}`)
      onDeleted?.()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Delete failed') }
    finally { setSaving(false) }
  }

  function addPerk() {
    const v = perkDraft.trim()
    if (!v) return
    patch('customPerks', [...form.customPerks, v])
    setPerkDraft('')
  }
  function removePerk(idx: number) {
    patch('customPerks', form.customPerks.filter((_, i) => i !== idx))
  }

  return (
    <div className={`p-5 ${isNew ? 'rounded-xl border border-s-teal bg-s-teal-dim/30' : 'border-t border-s-border bg-s-bg/30'} space-y-5`}>
      {isNew && <p className="text-xs font-bold text-primary-ink">+ New tier</p>}

      {/* Identity */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-bold text-s-muted">Slug *</span>
          <input
            value={form.tier}
            onChange={(e) => patch('tier', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            disabled={!isNew}
            placeholder="insider-gold"
            className="s-input w-full font-mono text-sm disabled:opacity-60"
          />
          <p className="text-[10px] text-s-dim">lowercase, letters/numbers/dashes. Locked once saved.</p>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-bold text-s-muted">Display name</span>
          <input
            value={form.displayName}
            onChange={(e) => patch('displayName', e.target.value)}
            placeholder="Insider Gold"
            className="s-input w-full text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-bold text-s-muted">Rank (sort order)</span>
          <input
            type="number" min={0}
            value={form.rank}
            onChange={(e) => patch('rank', parseInt(e.target.value) || 0)}
            className="s-input w-full text-sm"
          />
        </label>
      </div>

      {/* Type + threshold + price */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox" checked={form.isPaid}
            onChange={(e) => patch('isPaid', e.target.checked)}
            className="accent-s-teal"
          />
          <span className="text-xs font-bold">Paid subscription</span>
        </label>
        {form.isPaid ? (
          <label className="block space-y-1">
            <span className="text-xs font-bold text-s-muted">Monthly price (PKR)</span>
            <input
              type="number" min={0}
              value={(form.monthlyPriceCents ?? 0) / 100}
              onChange={(e) => patch('monthlyPriceCents', Math.round((parseFloat(e.target.value) || 0) * 100))}
              placeholder="500"
              className="s-input w-full text-sm"
            />
          </label>
        ) : (
          <label className="block space-y-1">
            <span className="text-xs font-bold text-s-muted">Auto-upgrade at lifetime spend (PKR)</span>
            <input
              type="number" min={0}
              value={(form.unlockSpendCents ?? 0) / 100}
              onChange={(e) => patch('unlockSpendCents', Math.round((parseFloat(e.target.value) || 0) * 100))}
              placeholder="25000"
              className="s-input w-full text-sm"
            />
            <p className="text-[10px] text-s-dim">leave 0 for "everyone starts here"</p>
          </label>
        )}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox" checked={form.isActive}
            onChange={(e) => patch('isActive', e.target.checked)}
            className="accent-s-teal"
          />
          <span className="text-xs font-bold">Active (accepting new members)</span>
        </label>
      </div>

      {/* Structured perks */}
      <div className="rounded-lg bg-s-elevated border border-s-border/60 p-4 space-y-3">
        <p className="text-xs font-black uppercase tracking-wider text-s-muted">Built-in perks</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <PerkToggle label="Always free delivery" checked={form.alwaysFreeDelivery} onChange={(v) => patch('alwaysFreeDelivery', v)} />
          <PerkInput
            label="Free delivery above (PKR)"
            value={(form.freeDeliveryAboveCents ?? 0) / 100}
            onChange={(v) => patch('freeDeliveryAboveCents', v ? Math.round(v * 100) : null)}
            placeholder="1500"
          />
          <PerkInput
            label="Birthday discount (%)"
            value={form.birthdayDiscountPct ?? 0}
            onChange={(v) => patch('birthdayDiscountPct', v || null)}
            placeholder="25"
            max={100}
          />
          <PerkInput
            label="Reservation lookahead (days)"
            value={form.priorityReservationDays ?? 0}
            onChange={(v) => patch('priorityReservationDays', v || null)}
            placeholder="14"
            max={180}
          />
          <PerkToggle label="Waitlist priority" checked={form.waitlistPriority} onChange={(v) => patch('waitlistPriority', v)} />
          <PerkInput
            label="Monthly wallet comp (PKR)"
            value={(form.monthlyCompCents ?? 0) / 100}
            onChange={(v) => patch('monthlyCompCents', v ? Math.round(v * 100) : null)}
            placeholder="500"
          />
          <PerkToggle label="Early menu access" checked={form.earlyMenuAccess} onChange={(v) => patch('earlyMenuAccess', v)} />
          <PerkToggle label="Free birthday item" checked={form.freeBirthdayItem} onChange={(v) => patch('freeBirthdayItem', v)} />
        </div>
      </div>

      {/* Custom perks (freeform) */}
      <div className="rounded-lg bg-s-elevated border border-s-border/60 p-4 space-y-3">
        <div>
          <p className="text-xs font-black uppercase tracking-wider text-s-muted">Custom perks</p>
          <p className="text-[10px] text-s-dim mt-0.5">Freeform bullets shown to customers. e.g. "Off-menu Stax", "Invite-only omakase nights at Simmer".</p>
        </div>
        <div className="space-y-1.5">
          {form.customPerks.map((p, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md bg-s-bg/40 px-3 py-2">
              <span className="text-primary-ink text-xs">•</span>
              <span className="flex-1 text-sm text-s-text">{p}</span>
              <button onClick={() => removePerk(i)} className="text-[10px] text-s-dim hover:text-s-red">remove</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={perkDraft}
            onChange={(e) => setPerkDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerk() } }}
            placeholder="Add a perk and press Enter"
            className="s-input flex-1 text-sm"
          />
          <button onClick={addPerk} disabled={!perkDraft.trim()} className="s-btn-secondary text-xs disabled:opacity-40">
            + Add
          </button>
        </div>
      </div>

      {/* Description */}
      <label className="block space-y-1">
        <span className="text-xs font-bold text-s-muted">Operator notes (internal)</span>
        <textarea
          value={form.description}
          onChange={(e) => patch('description', e.target.value)}
          rows={2}
          placeholder="Why this tier exists, who it's for, when to promote a customer to it…"
          className="s-input w-full text-sm resize-none"
        />
      </label>

      {err && <p className="text-xs text-s-red">{err}</p>}

      <div className="flex items-center justify-between pt-2">
        <div>
          {!isNew && (
            <button onClick={remove} disabled={saving}
              className="text-xs text-s-red hover:underline disabled:opacity-50">
              Delete tier
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} className="s-btn-ghost text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="s-btn-primary text-sm disabled:opacity-50">
            {saving ? 'Saving…' : isNew ? 'Create tier' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PerkToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-s-teal" />
      <span>{label}</span>
    </label>
  )
}
function PerkInput({ label, value, onChange, placeholder, max }: {
  label: string
  value: number
  onChange: (v: number) => void
  placeholder?: string
  max?: number
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-s-muted">{label}</span>
      <input
        type="number" min={0} max={max}
        value={value || ''}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        placeholder={placeholder}
        className="s-input w-full text-xs"
      />
    </label>
  )
}
