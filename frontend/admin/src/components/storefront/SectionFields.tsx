'use client'

// The editing form for a `section` element, built from its spec in the
// storefront's section catalogue (lib/sections.ts). Every field shows the
// section's current value — its own edit, or the design's default — and an
// edited field can be reset back to the design.

import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Block } from '../../lib/blocks'
import { fieldValue, isCatalogLoaded, sectionSpec, type FieldSpec } from '../../lib/sections'
import { Check, ColorInput, CopyInput, Field, MediaInput, NumberInput } from './fields'
import { Select } from '@/components/ui/Select'

type Obj = Record<string, unknown>

export function SectionFields({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const spec = sectionSpec(block.variant as string | undefined)
  if (!spec && !isCatalogLoaded()) {
    // The catalogue never arrived: the section is fine, its form just lives
    // on the storefront. Nothing about the block is touched.
    return (
      <p className="text-xs text-s-amber">
        This section&apos;s form comes from the storefront, which didn&apos;t answer. Its content is kept as it is.
      </p>
    )
  }
  if (!spec) {
    return (
      <p className="text-xs text-s-red">
        This section ({String(block.variant ?? 'unknown')}) is not in the storefront any more. Delete it, or hide it.
      </p>
    )
  }
  const own = (block.fields as Obj | undefined) ?? {}
  const setField = (key: string, v: unknown) => onChange({ ...block, fields: { ...own, [key]: v } })
  const reset = (key: string) => {
    const next = { ...own }
    delete next[key]
    onChange({ ...block, fields: next })
  }

  return (
    <div className="space-y-3">
      {spec.description && <p className="text-[11px] text-s-muted">{spec.description}</p>}
      {spec.fields.map((f) => (
        <div key={f.key}>
          <FieldInput spec={f} value={fieldValue(block, spec, f.key)} onChange={(v) => setField(f.key, v)} />
          {f.key in own && (
            <button type="button" onClick={() => reset(f.key)} className="mt-1 text-[11px] text-s-muted hover:text-s-text underline">
              Reset to the design
            </button>
          )}
        </div>
      ))}
      {spec.fields.length === 0 && <p className="text-xs text-s-muted">Nothing to edit here: this section shows live data.</p>}
    </div>
  )
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const text = typeof value === 'string' ? value : ''
  switch (spec.kind) {
    case 'text':
      return <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}><CopyInput value={text} onChange={onChange} /></Field>
    case 'textarea':
      return <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}><CopyInput rows={spec.rows ?? 3} value={text} onChange={onChange} /></Field>
    case 'image':
    case 'video':
      return <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}><MediaInput kind={spec.kind} value={text} onChange={onChange} /></Field>
    case 'url':
      return (
        <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}>
          <input value={text} onChange={(e) => onChange(e.target.value)} className="s-input" placeholder="/home or https://..." />
        </Field>
      )
    case 'link': {
      const l = (value && typeof value === 'object' ? value : { text: '', href: typeof value === 'string' ? value : '' }) as { text?: string; href?: string }
      return (
        <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}>
          <div className="grid grid-cols-2 gap-2">
            <input value={l.text ?? ''} onChange={(e) => onChange({ text: e.target.value, href: l.href ?? '' })} className="s-input" placeholder="Label" />
            <input value={l.href ?? ''} onChange={(e) => onChange({ text: l.text ?? '', href: e.target.value })} className="s-input" placeholder="/link" />
          </div>
        </Field>
      )
    }
    case 'color':
      return (
        <Field label={spec.label} hint={spec.hint ?? 'Empty uses the design colour.'}>
          <ColorInput value={text || undefined} onChange={(v) => onChange(v ?? '')} placeholder="#5a2156 or var(--servd-purple)" />
        </Field>
      )
    case 'toggle':
      return <Check checked={!!value} onChange={onChange}>{spec.label}</Check>
    case 'number':
      return (
        <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}>
          <NumberInput value={typeof value === 'number' ? value : undefined} onChange={(v) => onChange(v)}
            {...(spec.min !== undefined && { min: spec.min })} {...(spec.max !== undefined && { max: spec.max })} {...(spec.step !== undefined && { step: spec.step })} />
        </Field>
      )
    case 'select': {
      // A blank stored value would otherwise SHOW the first option while
      // storing '' (which the storefront ignores), so say it is unset.
      const unset = text === '' && !spec.options.some((o) => o.value === '')
      return (
        <Field label={spec.label} {...(spec.hint && { hint: spec.hint })}>
          <Select value={text} onChange={(e) => onChange(e.target.value)} className="s-select">
            {unset && <option value="" disabled>Choose…</option>}
            {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
      )
    }
    case 'list':
      return <ListInput spec={spec} value={value} onChange={onChange} />
  }
}

function ListInput({ spec, value, onChange }: { spec: Extract<FieldSpec, { kind: 'list' }>; value: unknown; onChange: (v: unknown) => void }) {
  const items = Array.isArray(value) ? (value as Obj[]) : []
  const [open, setOpen] = useState<number | null>(null)
  const noun = spec.itemLabel ?? 'Item'
  const set = (next: Obj[]) => onChange(next)
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    set(next)
    setOpen(j)
  }
  const add = () => {
    // A new item starts empty: text cleared, toggles off, and a select on its
    // first option — the one the dropdown shows. (A blank '' there looked
    // chosen in the editor but was dropped on the site, e.g. a feedback
    // 'choice'.)
    const blank: Obj = {}
    for (const f of spec.item) {
      blank[f.key] = f.kind === 'toggle' ? false
        : f.kind === 'list' ? []
        : f.kind === 'link' ? { text: '', href: '' }
        : f.kind === 'select' ? f.options[0]?.value ?? ''
        : ''
    }
    set([...items, blank])
    setOpen(items.length)
  }
  const title = (it: Obj, i: number) => {
    const first = spec.item.find((f) => f.kind === 'text' || f.kind === 'link')
    const v = first ? it[first.key] : undefined
    const s = typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as Obj).text ?? '') : ''
    return s.trim() || `${noun} ${i + 1}`
  }

  return (
    <div>
      <p className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">{spec.label}</p>
      {spec.hint && <p className="text-[11px] text-s-dim mb-1">{spec.hint}</p>}
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border border-s-border bg-s-surface">
            <div className="flex items-center gap-1 px-2 py-1.5">
              <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex-1 text-left text-xs font-semibold text-s-text truncate">
                {title(it, i)}
              </button>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="p-1 text-s-muted disabled:opacity-30"><ChevronUp size={13} /></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down" className="p-1 text-s-muted disabled:opacity-30"><ChevronDown size={13} /></button>
              <button type="button" onClick={() => { set(items.filter((_, k) => k !== i)); setOpen(null) }} aria-label={`Remove ${noun}`} className="p-1 text-s-muted hover:text-s-red"><Trash2 size={13} /></button>
            </div>
            {open === i && (
              <div className="border-t border-s-border p-2 space-y-2">
                {spec.item.map((f) => (
                  <FieldInput key={f.key} spec={f} value={it[f.key]} onChange={(v) => set(items.map((x, k) => (k === i ? { ...x, [f.key]: v } : x)))} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {(spec.max === undefined || items.length < spec.max) && (
        <button type="button" onClick={add} className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary-ink hover:underline">
          <Plus size={12} /> Add {noun.toLowerCase()}
        </button>
      )}
    </div>
  )
}
