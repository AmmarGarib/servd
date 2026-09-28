'use client'

// Builder side panels: draft status badge, page settings (fonts, A/B test)
// and pop-up rules.

import { useState } from 'react'
import { cloneBlocks, type Block } from '../../lib/blocks'
import {
  draftStatusInfo, fromLocalInput, toLocalInput,
  type ConceptLite, type DraftStatus, type LayoutKind, type MediaAssetLite, type PageSettings, type PopupRules, type Variant,
} from '../../lib/content'
import { Check, Field, FontSelect, NumberInput, Section } from './fields'

const TONE: Record<string, string> = {
  teal: 's-badge-teal', amber: 's-badge-amber', blue: 's-badge-blue', red: 's-badge-red', muted: 's-badge-muted',
}

export function StatusBadge({ row, showNote }: { row: { draftStatus: DraftStatus | null; reviewNote: string | null; publishAt: string | null }; showNote?: boolean }) {
  const s = draftStatusInfo(row)
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className={TONE[s.tone]}>{s.label}</span>
      {showNote && s.note && <span className="text-[11px] text-s-red max-w-xs">&ldquo;{s.note}&rdquo;</span>}
    </span>
  )
}

// ─── Page settings ─────────────────────────────────────────────────────────

export function PageSettingsPanel({ kind, title, onTitle, settings, onChange, fonts, variant, onVariant, blocksA }: {
  kind: LayoutKind
  title: string
  onTitle: (t: string) => void
  settings: PageSettings
  onChange: (s: PageSettings) => void
  fonts: MediaAssetLite[]
  variant: Variant
  onVariant: (v: Variant) => void
  blocksA: Block[]
}) {
  const ab = settings.ab
  const abAllowed = kind === 'page' || kind === 'popup'
  const setFonts = (patch: { heading?: string; body?: string }) => {
    const next = { ...settings.fonts, ...patch }
    if (!next.heading) delete next.heading
    if (!next.body) delete next.body
    onChange({ ...settings, fonts: Object.keys(next).length ? next : undefined })
  }
  const toggleAb = (on: boolean) => {
    if (on) {
      onChange({ ...settings, ab: { splitPct: 50, blocks: cloneBlocks(blocksA) } })
      return
    }
    if (ab && ab.blocks.length && !confirm('Turn off the A/B test? Variant B will be deleted.')) return
    const { ab: _drop, ...rest } = settings
    void _drop
    onChange(rest)
    onVariant('a')
  }

  return (
    <div className="p-4 space-y-3 max-h-[calc(100vh-14rem)] overflow-y-auto">
      <Section title="Page">
        <Field label="Title (admin only)"><input value={title} onChange={(e) => onTitle(e.target.value)} className="s-input" /></Field>
      </Section>

      {kind !== 'footer' && (
        <Section title="Fonts">
          <Field label="Headings"><FontSelect value={settings.fonts?.heading} onChange={(v) => setFonts({ heading: v })} fonts={fonts} emptyLabel="Brand default" /></Field>
          <Field label="Body"><FontSelect value={settings.fonts?.body} onChange={(v) => setFonts({ body: v })} fonts={fonts} emptyLabel="Brand default" /></Field>
          <p className="text-[11px] text-s-dim">Upload fonts in the Library tab. An element&apos;s own font overrides these.</p>
        </Section>
      )}

      {abAllowed && (
        <Section title="A/B test">
          <Check checked={!!ab} onChange={toggleAb}>Show a second version (B) to some visitors</Check>
          {ab && (
            <>
              <Field label={`Visitors who get B: ${ab.splitPct}%`}>
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={100} step={5} value={ab.splitPct}
                    onChange={(e) => onChange({ ...settings, ab: { ...ab, splitPct: Number(e.target.value) } })} className="flex-1" />
                  <div className="w-20"><NumberInput value={ab.splitPct} min={0} max={100} onChange={(v) => onChange({ ...settings, ab: { ...ab, splitPct: v ?? 0 } })} /></div>
                </div>
              </Field>
              <div className="flex gap-2 flex-wrap">
                <button type="button" onClick={() => onVariant(variant === 'b' ? 'a' : 'b')} className="s-btn-secondary text-xs">
                  {variant === 'b' ? 'Back to variant A' : 'Edit variant B'}
                </button>
                <button type="button" className="s-btn-ghost text-xs"
                  onClick={() => { if (confirm('Replace variant B with a copy of variant A?')) onChange({ ...settings, ab: { ...ab, blocks: cloneBlocks(blocksA) } }) }}>
                  Copy A to B
                </button>
              </div>
              <p className="text-[11px] text-s-dim">Views and conversions per variant show in Versions once this is live.</p>
            </>
          )}
        </Section>
      )}
    </div>
  )
}

// ─── Pop-up rules ──────────────────────────────────────────────────────────

function PagesInput({ pages, onChange }: { pages: string[]; onChange: (p: string[]) => void }) {
  const [text, setText] = useState(pages.join('\n'))
  return (
    <textarea rows={3} className="s-input font-mono text-xs" placeholder={'/\n/brand/*\n/pages/ramadan'} value={text}
      onChange={(e) => { setText(e.target.value); onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)) }} />
  )
}

export function PopupRulesPanel({ rules, onChange, concepts }: { rules: PopupRules; onChange: (r: PopupRules) => void; concepts: ConceptLite[] }) {
  const set = (patch: Partial<PopupRules>) => onChange({ ...rules, ...patch })
  const picked = concepts.filter((c) => rules.brands.includes(c.slug))
  const companies = new Set(picked.map((c) => c.tenantId).filter(Boolean))
  return (
    <div className="p-4 space-y-3 max-h-[calc(100vh-14rem)] overflow-y-auto">
      <Section title="What">
        <Field label="Pop-up type">
          <select value={rules.popupKind} onChange={(e) => set({ popupKind: e.target.value as PopupRules['popupKind'] })} className="s-select">
            <option value="signup">Sign-up</option><option value="login">Log-in</option>
            <option value="offer">Offer</option><option value="announcement">Announcement</option>
          </select>
        </Field>
        <Field label="Display">
          <select value={rules.display} onChange={(e) => set({ display: e.target.value as PopupRules['display'] })} className="s-select">
            <option value="modal">Modal (centre of screen)</option><option value="bar">Bar (top of page)</option><option value="corner">Corner card</option>
          </select>
        </Field>
      </Section>

      <Section title="When">
        <Field label="Trigger">
          <select value={rules.trigger} onChange={(e) => set({ trigger: e.target.value as PopupRules['trigger'] })} className="s-select">
            <option value="before_page">Before the page shows</option>
            <option value="after_seconds">After a delay</option>
            <option value="exit_intent">When the visitor is about to leave</option>
            <option value="scroll">After scrolling</option>
          </select>
        </Field>
        {rules.trigger === 'after_seconds' && (
          <Field label="Delay (seconds)"><NumberInput value={rules.delaySeconds ?? 5} min={0} max={600} onChange={(v) => set({ delaySeconds: v })} /></Field>
        )}
        {rules.trigger === 'scroll' && (
          <Field label="Scrolled (% of page)"><NumberInput value={rules.scrollPct ?? 50} min={0} max={100} onChange={(v) => set({ scrollPct: v })} /></Field>
        )}
        <Field label="Frequency">
          <select value={rules.frequency} onChange={(e) => set({ frequency: e.target.value as PopupRules['frequency'] })} className="s-select">
            <option value="once">Once per visitor</option><option value="daily">At most once a day</option><option value="every_visit">Every visit</option>
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-2">
          <Field label="Starts (optional)">
            <input type="datetime-local" value={toLocalInput(rules.startsAt)} onChange={(e) => set({ startsAt: fromLocalInput(e.target.value) })} className="s-input" />
          </Field>
          <Field label="Ends (optional)">
            <input type="datetime-local" value={toLocalInput(rules.endsAt)} onChange={(e) => set({ endsAt: fromLocalInput(e.target.value) })} className="s-input" />
          </Field>
        </div>
      </Section>

      <Section title="Where">
        <Field label="Pages" hint="One path per line. End with * to match everything below it, e.g. /brand/* . Leave empty for every page.">
          <PagesInput pages={rules.pages} onChange={(pages) => set({ pages })} />
        </Field>
        <Field label="Brands" hint="None ticked = every brand. Ticked brands must belong to one company.">
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {concepts.map((c) => (
              <Check key={c.id} checked={rules.brands.includes(c.slug)}
                onChange={(v) => set({ brands: v ? [...rules.brands, c.slug] : rules.brands.filter((s) => s !== c.slug) })}>
                {c.name}
              </Check>
            ))}
            {concepts.length === 0 && <p className="text-xs text-s-muted">No brands visible.</p>}
          </div>
          {companies.size > 1 && <p className="text-[11px] text-s-red mt-1">These brands belong to different companies. Pick brands from one company.</p>}
        </Field>
      </Section>

      <Section title="Who">
        <Field label="Audience">
          <select value={rules.audience} onChange={(e) => set({ audience: e.target.value as PopupRules['audience'] })} className="s-select">
            <option value="everyone">Everyone</option><option value="signed_out">Signed-out visitors</option>
            <option value="signed_in">Signed-in customers</option><option value="never_ordered">Customers who have never ordered</option>
          </select>
        </Field>
      </Section>
    </div>
  )
}
