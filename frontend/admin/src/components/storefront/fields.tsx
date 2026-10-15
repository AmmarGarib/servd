'use client'

// Small form primitives shared by the builder's inspector, page settings and
// pop-up rules. Image/video fields and copy fields can pull from the media
// library (LibraryPanel in pick mode).

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { LibraryPanel, type LibraryAsset } from './LibraryPanel'
import { contentApi, type MediaAssetLite } from '../../lib/content'
import { BUILTIN_FONTS, type Align } from '../../lib/blocks'
import { Select } from '@/components/ui/Select'
import { useDialog } from '@/components/ui/Modal'

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">{label}</span>
      {children}
      {hint && <p className="text-[11px] text-s-dim mt-1">{hint}</p>}
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-3 mt-3 border-t border-s-border space-y-3 first:mt-0 first:pt-0 first:border-t-0">
      <p className="text-[11px] uppercase tracking-wider text-s-text font-bold">{title}</p>
      {children}
    </div>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-s-text cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

export function AlignSelect({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  return (
    <div className="flex gap-1">
      {(['left', 'center', 'right'] as const).map((a) => (
        <button key={a} type="button" onClick={() => onChange(a)} aria-pressed={value === a}
          className={`flex-1 py-1.5 rounded text-xs font-semibold border ${value === a ? 'bg-primary text-primary-on border-s-teal' : 'bg-s-bg-soft text-s-text border-s-border'}`}>
          {a}
        </button>
      ))}
    </div>
  )
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
/** #rgb to #rrggbb, for the native colour picker. */
const longHex = (v: string) => (v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v)

export function ColorInput({ value, onChange, placeholder, fallback }: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  placeholder?: string
  /** What the colour picker shows while the value is empty (e.g. the default). */
  fallback?: string
}) {
  const [text, setText] = useState(value ?? '')
  const [focused, setFocused] = useState(false)
  // Follow outside changes (the swatch, undo, a reload) while not typing.
  useEffect(() => { if (!focused) setText(value ?? '') }, [value, focused])
  const valid = text === '' || HEX_RE.test(text.trim())
  const shown = value && HEX_RE.test(value) ? longHex(value) : fallback && HEX_RE.test(fallback) ? longHex(fallback) : '#000000'
  const commit = () => {
    const t = text.trim()
    if (t === '') { onChange(undefined); return }
    if (HEX_RE.test(t)) { onChange(t); setText(t) } else setText(value ?? '') // invalid: revert
  }
  return (
    <div>
      <div className="flex gap-2">
        <input type="color" value={shown} onChange={(e) => { setText(e.target.value); onChange(e.target.value) }}
          className="h-9 w-10 shrink-0 rounded border border-s-border bg-s-bg-soft cursor-pointer" aria-label="Pick colour" />
        <input value={text} placeholder={placeholder} className="s-input" aria-invalid={!valid || undefined}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            setText(e.target.value)
            const t = e.target.value.trim()
            if (HEX_RE.test(t)) onChange(t) // live preview while a valid hex is typed
          }}
          onBlur={() => { setFocused(false); commit() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
      </div>
      {!valid && <p role="alert" className="text-[11px] text-s-red mt-1">Use a hex colour like #6a0dad or #fff. It goes back to the last good colour when you leave the box.</p>}
    </div>
  )
}

export function NumberInput({ value, onChange, min, max, step }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number }) {
  // Keep what was typed; clamp and commit on blur or Enter, so "1" on the way to "15" is never snapped to the minimum.
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(value === undefined ? '' : String(value)) }, [value, focused])
  const commit = () => {
    const t = text.trim()
    if (t === '') { onChange(undefined); return }
    let n = Number(t)
    if (Number.isNaN(n)) { setText(value === undefined ? '' : String(value)); return }
    if (min !== undefined) n = Math.max(min, n)
    if (max !== undefined) n = Math.min(max, n)
    setText(String(n))
    onChange(n)
  }
  const range = min !== undefined && max !== undefined ? `${min} to ${max}` : min !== undefined ? `at least ${min}` : max !== undefined ? `at most ${max}` : ''
  return (
    <div>
      <input type="number" inputMode="decimal" min={min} max={max} step={step} value={text} className="s-input"
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setFocused(false); commit() }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()} />
      {range && <p className="text-[11px] text-s-dim mt-1">{range}</p>}
    </div>
  )
}

// ─── Library picker ────────────────────────────────────────────────────────

export function LibraryPickerModal({ kinds, title, onPick, onClose }: {
  kinds: Array<'image' | 'video' | 'font' | 'copy'>
  title: string
  onPick: (asset: LibraryAsset) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose }) // Escape, focus trap, focus back to the opener
  return (
    <div className="fixed inset-0 z-50 bg-secondary/50 flex items-center justify-center p-4" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className="s-card w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-s-border flex items-center justify-between">
          <h2 className="text-sm font-bold text-s-text">{title}</h2>
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close" className="text-s-muted hover:text-s-text"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-4">
          <LibraryPanel mode="pick" kinds={kinds} onPick={(a) => { onPick(a); onClose() }} />
        </div>
      </div>
    </div>
  )
}

/** URL field for an image or video with a "Library" button and a thumbnail. */
export function MediaInput({ value, onChange, kind, placeholder }: {
  value: string | undefined
  onChange: (v: string) => void
  kind: 'image' | 'video'
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [value])
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'https://...'} className="s-input" />
        <button type="button" onClick={() => setOpen(true)} className="s-btn-secondary text-xs shrink-0">Library</button>
      </div>
      {value && !broken && (
        <div className="h-20 w-32 rounded-lg overflow-hidden border border-s-border bg-s-elevated">
          {kind === 'video'
            ? <video src={value} className="h-full w-full object-cover" muted playsInline preload="metadata" onError={() => setBroken(true)} />
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={value} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} />}
        </div>
      )}
      {value && broken && <p className="text-[11px] text-s-amber">That address did not load as {kind === 'video' ? 'a video' : 'an image'}. Check the link.</p>}
      {open && (
        <LibraryPickerModal kinds={[kind]} title={kind === 'video' ? 'Pick a video' : 'Pick an image'}
          onPick={(a) => onChange(a.url)} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

/** Text or textarea with "Insert copy" from the library's copy snippets. */
export function CopyInput({ value, onChange, rows, placeholder }: {
  value: string | undefined
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const insert = (text: string) => {
    const cur = value ?? ''
    onChange(cur.trim() ? `${cur}${rows ? '\n' : ' '}${text}` : text)
  }
  return (
    <div>
      {rows
        ? <textarea rows={rows} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="s-input resize-y" />
        : <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="s-input" />}
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[11px] text-primary-ink hover:underline">Insert copy from library</button>
      {open && (
        <LibraryPickerModal kinds={['copy']} title="Insert a copy snippet"
          onPick={(a) => insert(a.text ?? '')} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

// ─── Fonts ─────────────────────────────────────────────────────────────────

export function useLibraryFonts() {
  return useQuery<MediaAssetLite[]>({
    queryKey: ['media', 'font'],
    queryFn: contentApi.fonts,
    staleTime: 60_000,
  })
}

/** @font-face rules so library fonts preview in the admin. */
export function FontFaces({ fonts }: { fonts: MediaAssetLite[] }) {
  const css = fonts
    .filter((f) => f.fontFamily && f.url)
    .map((f) => `@font-face{font-family:${JSON.stringify(f.fontFamily)};src:url(${JSON.stringify(f.url)});font-display:swap;}`)
    .join('\n')
  return css ? <style>{css}</style> : null
}

export function FontSelect({ value, onChange, fonts, emptyLabel }: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  fonts: MediaAssetLite[]
  emptyLabel: string
}) {
  const library = Array.from(new Set(fonts.map((f) => f.fontFamily).filter((f): f is string => !!f)))
  const known = new Set([...library, ...BUILTIN_FONTS.map((f) => f.value)])
  return (
    <div className="space-y-1">
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="s-select">
        <option value="">{emptyLabel}</option>
        {library.length > 0 && (
          <optgroup label="Library fonts">
            {library.map((f) => <option key={f} value={f}>{f}</option>)}
          </optgroup>
        )}
        <optgroup label="Built-in">
          {BUILTIN_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </optgroup>
        {value && !known.has(value) && <option value={value}>{value} (not in library)</option>}
      </Select>
      {value && <p className="text-sm text-s-text truncate" style={{ fontFamily: value }}>The quick brown fox, 0123</p>}
    </div>
  )
}
