'use client'
// Business Info — per-brand "real info" editor: phone, WhatsApp, street,
// locality, geo, cuisine, price tier, reservations toggle. Saves via
// PATCH /concepts/:id (the same endpoint admin uses for everything else on a
// concept). Inline edits, optimistic local state, save button per brand.
//
// Lifted out of the CEO dashboard into its own Executive module: this is a
// reference surface the operator edits occasionally, not a daily-cadence
// scorecard tile, so it doesn't belong buried under revenue numbers. Editing
// here updates the live customer-facing surfaces (Google rich results via
// schema.org JSON-LD, the brand microsite footer, the Maps link, /press
// contact, and the /locations geo pages) so the operator never needs a code
// deploy to fix a wrong number on Google or change the displayed neighbourhood.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Select } from '@/components/ui/Select'

interface ConceptRow {
  id:               string
  name:             string
  slug:             string
  phone:            string | null
  whatsapp:         string | null
  address:          string | null
  addressLocality:  string | null
  latitude:         number | null
  longitude:        number | null
  cuisine:          string | null
  priceTier:        string | null
  reservationsEnabled: boolean
}

export default function BusinessInfoPage() {
  const { data: concepts, refetch, isLoading } = useQuery<ConceptRow[]>({
    queryKey: ['business-info', 'concepts'],
    queryFn:  () => api.get<ConceptRow[]>('/concepts'),
  })

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '60rem', margin: '0 auto' }}>
        <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--erp-success)', margin: 0 }}>
          executive
        </p>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>
          Business info
        </h1>
        <p style={{ color: 'var(--muted)', margin: '0.35rem 0 0', fontSize: '0.88rem', maxWidth: '40rem', lineHeight: 1.5 }}>
          Phone, WhatsApp, address &amp; geo per brand. Edits flow to schema.org rich
          results, the Maps link, the storefront footer, /press, and the /locations
          pages — no code deploy needed.
        </p>

        <div style={{ marginTop: '1.8rem', display: 'grid', gap: '0.85rem' }}>
          {isLoading && (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: 0 }}>Loading brands…</p>
          )}
          {concepts && concepts.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: 0 }}>No brands found.</p>
          )}
          {(concepts ?? []).map((c) => (
            <BrandInfoCard key={c.id} concept={c} onSaved={() => void refetch()} />
          ))}
        </div>
      </div>
    </main>
  )
}

function BrandInfoCard({ concept, onSaved }: { concept: ConceptRow; onSaved: () => void }) {
  const [open, setOpen]       = useState(false)
  const [draft, setDraft]     = useState<ConceptRow>(concept)
  const [busy, setBusy]       = useState(false)
  const [msg, setMsg]         = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Reset draft whenever the parent's concept identity changes (refetch).
  useEffect(() => { setDraft(concept) }, [concept.id])

  const dirty = JSON.stringify(draft) !== JSON.stringify(concept)

  async function save() {
    setBusy(true); setMsg(null)
    try {
      // Send only the fields this editor owns. PATCH /concepts/:id will
      // ignore unknown keys via zod's .partial() schema.
      await api.patch(`/concepts/${concept.id}`, {
        phone:           draft.phone           || null,
        whatsapp:        draft.whatsapp        || null,
        address:         draft.address         || null,
        addressLocality: draft.addressLocality || null,
        latitude:        draft.latitude,
        longitude:       draft.longitude,
        cuisine:         draft.cuisine         || null,
        priceTier:       draft.priceTier       || null,
        reservationsEnabled: draft.reservationsEnabled,
      })
      setMsg({ kind: 'ok', text: 'Saved' })
      onSaved()
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid rgb(var(--fg-rgb) / 0.06)',
      borderRadius: '0.85rem',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left',
          display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.75rem',
          alignItems: 'center',
          padding: '0.95rem 1.1rem',
          background: 'transparent', border: 'none', color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <div>
          <p style={{ fontWeight: 700, fontSize: '0.98rem', margin: 0, color: 'var(--text)' }}>
            {concept.name}
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '0.78rem', margin: '0.2rem 0 0' }}>
            {concept.addressLocality ?? concept.address ?? 'no address set'} · {concept.phone ?? 'no phone'}
          </p>
        </div>
        <span style={{
          fontSize: '0.68rem', fontWeight: 700,
          color: filled(concept) === 'all' ? 'var(--erp-success)' : filled(concept) === 'some' ? 'var(--erp-warning)' : 'var(--erp-danger)',
          background: filled(concept) === 'all' ? 'var(--erp-accent-dim)' : filled(concept) === 'some' ? 'rgba(245,158,11,0.10)' : 'rgba(239,68,68,0.10)',
          padding: '0.2rem 0.5rem', borderRadius: '999px',
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}>
          {filled(concept) === 'all' ? 'Complete' : filled(concept) === 'some' ? 'Partial' : 'Empty'}
        </span>
        <span aria-hidden style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0.5rem 1.1rem 1.1rem', borderTop: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
            <Field label="Phone (E.164)"
              value={draft.phone ?? ''} placeholder="+923001234567"
              onChange={(v) => setDraft((d) => ({ ...d, phone: v }))}
              hint="The number Google lists. Keep byte-identical with the Google Business Profile." />
            <Field label="WhatsApp (digits only)"
              value={draft.whatsapp ?? ''} placeholder="923001234567"
              onChange={(v) => setDraft((d) => ({ ...d, whatsapp: v }))}
              hint="wa.me/<this>. No +, no spaces. Falls back to phone digits if blank." />
            <Field label="Street address"
              value={draft.address ?? ''} placeholder="Shop 12, ground floor, …"
              onChange={(v) => setDraft((d) => ({ ...d, address: v }))}
              hint="Street line only. Area goes in the next field." />
            <Field label="Area / neighbourhood"
              value={draft.addressLocality ?? ''} placeholder="Bukhari Commercial, DHA Phase 6"
              onChange={(v) => setDraft((d) => ({ ...d, addressLocality: v }))}
              hint="The locality shown in the storefront pill and Maps title." />
            <Field label="Latitude"
              value={draft.latitude == null ? '' : String(draft.latitude)}
              placeholder="24.8054"
              onChange={(v) => setDraft((d) => ({ ...d, latitude: v === '' ? null : parseFloat(v) }))}
              hint="Map pin lat. Drop the pin on the actual entrance." />
            <Field label="Longitude"
              value={draft.longitude == null ? '' : String(draft.longitude)}
              placeholder="67.0517"
              onChange={(v) => setDraft((d) => ({ ...d, longitude: v === '' ? null : parseFloat(v) }))}
              hint="Map pin lng." />
            <Field label="Cuisine"
              value={draft.cuisine ?? ''} placeholder="Small plates, Burgers, Fried chicken, …"
              onChange={(v) => setDraft((d) => ({ ...d, cuisine: v }))}
              hint="Fed into schema.org servesCuisine." />
            <SelectField label="Price tier"
              value={draft.priceTier ?? ''}
              onChange={(v) => setDraft((d) => ({ ...d, priceTier: v || null }))}
              options={[
                { value: '',        label: '— pick —' },
                { value: 'budget',  label: 'Budget ($)' },
                { value: 'mid',     label: 'Mid ($$)' },
                { value: 'premium', label: 'Premium ($$$)' },
                { value: 'luxury',  label: 'Luxury ($$$$)' },
              ]}
              hint="Fed into schema.org priceRange." />
            <ToggleField label="Takes reservations"
              checked={draft.reservationsEnabled}
              onChange={(v) => setDraft((d) => ({ ...d, reservationsEnabled: v }))}
              hint="Off = walk-in / delivery only. Hides Book-a-table CTA on storefront." />
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              style={{
                padding: '0.55rem 1.2rem',
                borderRadius: '0.6rem',
                background: dirty ? 'var(--erp-primary)' : 'var(--elevated)',
                color: dirty ? 'var(--erp-on-primary)' : 'var(--muted)',
                fontWeight: 700, fontSize: '0.85rem',
                border: 'none', cursor: dirty ? 'pointer' : 'not-allowed',
                opacity: busy ? 0.6 : 1,
              }}>
              {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(concept)}
                style={{
                  padding: '0.55rem 1rem', borderRadius: '0.6rem',
                  background: 'transparent', color: 'var(--muted)',
                  border: '1px solid rgb(var(--fg-rgb) / 0.12)',
                  fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer',
                }}>
                Revert
              </button>
            )}
            {msg && (
              <span role="alert" style={{
                color: msg.kind === 'ok' ? 'var(--erp-success)' : 'var(--erp-danger)',
                fontSize: '0.8rem', fontWeight: 600,
              }}>{msg.text}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function filled(c: ConceptRow): 'all' | 'some' | 'none' {
  const has = [c.phone, c.whatsapp, c.address, c.addressLocality, c.latitude, c.longitude, c.cuisine, c.priceTier].filter(Boolean).length
  if (has === 0) return 'none'
  if (has >= 6)  return 'all'
  return 'some'
}

function Field({
  label, value, placeholder, onChange, hint,
}: {
  label: string; value: string; placeholder?: string
  onChange: (v: string) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {label}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--bg)',
          border: '1px solid rgb(var(--fg-rgb) / 0.10)',
          borderRadius: '0.45rem',
          padding: '0.55rem 0.7rem',
          color: 'var(--text)',
          fontSize: '0.88rem',
          outline: 'none',
        }}
      />
      {hint && <span style={{ fontSize: '0.7rem', color: 'var(--muted)', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}

function SelectField({
  label, value, onChange, options, hint,
}: {
  label: string; value: string; options: Array<{ value: string; label: string }>
  onChange: (v: string) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {label}
      </span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--bg)',
          border: '1px solid rgb(var(--fg-rgb) / 0.10)',
          borderRadius: '0.45rem',
          padding: '0.55rem 0.7rem',
          color: 'var(--text)',
          fontSize: '0.88rem',
          outline: 'none',
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      {hint && <span style={{ fontSize: '0.7rem', color: 'var(--muted)', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}

function ToggleField({
  label, checked, onChange, hint,
}: {
  label: string; checked: boolean
  onChange: (v: boolean) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {label}
      </span>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.6rem',
        padding: '0.45rem 0.5rem',
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: '1.1rem', height: '1.1rem', accentColor: 'var(--erp-accent)' }}
        />
        <span style={{ color: 'var(--text)', fontSize: '0.88rem' }}>{checked ? 'Yes' : 'No'}</span>
      </div>
      {hint && <span style={{ fontSize: '0.7rem', color: 'var(--muted)', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}
