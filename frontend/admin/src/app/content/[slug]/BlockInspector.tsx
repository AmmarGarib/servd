'use client'

// Per-block editing form. Switch on block.type and render the appropriate
// fields. All edits flow through onChange(newBlock); the parent stores the
// updated array. Universal section controls (background, padding, hide)
// appear in every form via <SectionControls>.

import type { Block, ButtonStyle, ButtonSize, Align, SectionPad } from '../../../lib/blocks'

interface Props {
  block: Block
  onChange: (next: Block) => void
}

export function BlockInspector({ block, onChange }: Props) {
  const set = (patch: Partial<Block>) => onChange({ ...block, ...patch })

  return (
    <div className="overflow-hidden">
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
        <p className="text-xs text-s-muted uppercase tracking-wider font-bold">{block.type}</p>
      </div>
      <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
        {block.type === 'hero'          && <HeroFields block={block} set={set} />}
        {block.type === 'cta_button'    && <CtaFields block={block} set={set} />}
        {block.type === 'banner'        && <BannerFields block={block} set={set} />}
        {block.type === 'text'          && <TextFields block={block} set={set} />}
        {block.type === 'image'         && <ImageFields block={block} set={set} />}
        {block.type === 'gallery'       && <GalleryFields block={block} set={set} />}
        {block.type === 'stat_strip'    && <StatsFields block={block} set={set} />}
        {block.type === 'voices'        && <VoicesFields block={block} set={set} />}
        {block.type === 'kitchens'      && <KitchensFields block={block} set={set} />}
        {block.type === 'featured_menu' && <FeaturedMenuFields block={block} set={set} />}
        {block.type === 'reviews'       && <ReviewsFields block={block} set={set} />}
        {block.type === 'quote'         && <QuoteFields block={block} set={set} />}
        {block.type === 'spacer'        && <SpacerFields block={block} set={set} />}

        <div className="pt-3 border-t border-s-border">
          <SectionControls block={block} set={set} />
        </div>
      </div>
    </div>
  )
}

// ── Universal controls applied to every block ────────────────────────────

function SectionControls({ block, set }: { block: Block; set: (p: Partial<Block>) => void }) {
  return (
    <>
      <p className="text-[11px] uppercase tracking-wider text-s-muted font-bold mb-2">Section</p>
      <Field label="Background colour">
        <input value={block.background ?? ''} onChange={(e) => set({ background: e.target.value || undefined })}
          placeholder="#ffffff or var(--servd-black)"
          className="input" />
      </Field>
      <Field label="Text colour">
        <input value={block.textColor ?? ''} onChange={(e) => set({ textColor: e.target.value || undefined })}
          placeholder="#000000"
          className="input" />
      </Field>
      <Field label="Top/bottom padding">
        <select value={block.paddingY ?? ''} onChange={(e) => set({ paddingY: (e.target.value || undefined) as SectionPad | undefined })} className="input">
          <option value="">— default —</option>
          <option value="none">none</option>
          <option value="sm">small</option>
          <option value="md">medium</option>
          <option value="lg">large</option>
          <option value="xl">x-large</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 mt-2 text-xs">
        <input type="checkbox" checked={!!block.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
        Hide this block (kept in editor; not rendered on storefront)
      </label>
    </>
  )
}

// ── Per-type field forms ─────────────────────────────────────────────────

function HeroFields({ block, set }: any) {
  return (
    <>
      <Field label="Kicker (small uppercase label)"><input value={block.kicker ?? ''} onChange={(e) => set({ kicker: e.target.value })} className="input" /></Field>
      <Field label="Title *"><input value={block.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="input" /></Field>
      <Field label="Subtitle"><textarea rows={3} value={block.subtitle ?? ''} onChange={(e) => set({ subtitle: e.target.value })} className="input" /></Field>
      <Field label="Background image URL"><input value={block.imageUrl ?? ''} onChange={(e) => set({ imageUrl: e.target.value })} placeholder="https://…" className="input" /></Field>
      <Field label="Image overlay (0–1)"><input type="number" min={0} max={1} step={0.05} value={block.imageOverlay ?? 0.45} onChange={(e) => set({ imageOverlay: parseFloat(e.target.value) })} className="input" /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'left'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Height">
        <select value={block.height ?? 'lg'} onChange={(e) => set({ height: e.target.value })} className="input">
          {(['sm', 'md', 'lg', 'xl', 'screen'] as const).map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </Field>
      <fieldset className="border border-s-border rounded p-2">
        <legend className="text-xs text-s-muted px-1">Primary CTA</legend>
        <Field label="Text"><input value={block.primaryCta?.text ?? ''} onChange={(e) => set({ primaryCta: { ...(block.primaryCta ?? { href: '/browse' }), text: e.target.value } })} className="input" /></Field>
        <Field label="Link"><input value={block.primaryCta?.href ?? ''} onChange={(e) => set({ primaryCta: { ...(block.primaryCta ?? { text: 'Order Now' }), href: e.target.value } })} className="input" /></Field>
        {block.primaryCta && (
          <button onClick={() => set({ primaryCta: undefined })} className="text-[11px] text-s-red hover:underline mt-1">Remove primary CTA</button>
        )}
      </fieldset>
      <fieldset className="border border-s-border rounded p-2">
        <legend className="text-xs text-s-muted px-1">Secondary CTA (optional)</legend>
        <Field label="Text"><input value={block.secondaryCta?.text ?? ''} onChange={(e) => set({ secondaryCta: { ...(block.secondaryCta ?? { href: '#' }), text: e.target.value } })} className="input" /></Field>
        <Field label="Link"><input value={block.secondaryCta?.href ?? ''} onChange={(e) => set({ secondaryCta: { ...(block.secondaryCta ?? { text: '' }), href: e.target.value } })} className="input" /></Field>
        {block.secondaryCta && (
          <button onClick={() => set({ secondaryCta: undefined })} className="text-[11px] text-s-red hover:underline mt-1">Remove secondary CTA</button>
        )}
      </fieldset>
    </>
  )
}

function CtaFields({ block, set }: any) {
  return (
    <>
      <Field label="Button text *"><input value={block.text ?? ''} onChange={(e) => set({ text: e.target.value })} className="input" /></Field>
      <Field label="Link URL *"><input value={block.href ?? ''} onChange={(e) => set({ href: e.target.value })} placeholder="/browse" className="input" /></Field>
      <Field label="Style">
        <select value={block.style ?? 'primary'} onChange={(e) => set({ style: e.target.value as ButtonStyle })} className="input">
          <option value="primary">Primary (green)</option>
          <option value="secondary">Secondary (outlined)</option>
          <option value="dark">Dark</option>
          <option value="ghost">Ghost (transparent)</option>
        </select>
      </Field>
      <Field label="Size">
        <select value={block.size ?? 'lg'} onChange={(e) => set({ size: e.target.value as ButtonSize })} className="input">
          <option value="sm">Small</option>
          <option value="md">Medium</option>
          <option value="lg">Large</option>
          <option value="xl">X-large</option>
          <option value="huge">Huge (hero-sized)</option>
        </select>
      </Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'center'} onChange={(v) => set({ align: v })} /></Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!block.fullWidth} onChange={(e) => set({ fullWidth: e.target.checked })} />
        Stretch to full container width
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!block.trailingArrow} onChange={(e) => set({ trailingArrow: e.target.checked })} />
        Append "→" to label
      </label>
    </>
  )
}

function BannerFields({ block, set }: any) {
  return (
    <>
      <Field label="Title *"><input value={block.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="input" /></Field>
      <Field label="Subtitle"><input value={block.subtitle ?? ''} onChange={(e) => set({ subtitle: e.target.value })} className="input" /></Field>
      <Field label="Background image URL"><input value={block.backgroundUrl ?? ''} onChange={(e) => set({ backgroundUrl: e.target.value })} className="input" /></Field>
      <Field label="Background colour"><input value={block.backgroundColor ?? ''} onChange={(e) => set({ backgroundColor: e.target.value })} className="input" /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'center'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Height">
        <select value={block.height ?? 'md'} onChange={(e) => set({ height: e.target.value })} className="input">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
        </select>
      </Field>
    </>
  )
}

function TextFields({ block, set }: any) {
  return (
    <>
      <Field label="Body *"><textarea rows={6} value={block.body ?? ''} onChange={(e) => set({ body: e.target.value })} className="input" /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'left'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Size">
        <select value={block.size ?? 'md'} onChange={(e) => set({ size: e.target.value })} className="input">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large (display)</option>
        </select>
      </Field>
      <Field label="Width">
        <select value={block.maxWidth ?? 'narrow'} onChange={(e) => set({ maxWidth: e.target.value })} className="input">
          <option value="narrow">Narrow (reading column)</option>
          <option value="wide">Wide (full container)</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!block.emphasized} onChange={(e) => set({ emphasized: e.target.checked })} />
        Emphasized weight
      </label>
    </>
  )
}

function ImageFields({ block, set }: any) {
  return (
    <>
      <Field label="Image URL *"><input value={block.url ?? ''} onChange={(e) => set({ url: e.target.value })} className="input" /></Field>
      <Field label="Alt text (accessibility)"><input value={block.alt ?? ''} onChange={(e) => set({ alt: e.target.value })} className="input" /></Field>
      <Field label="Caption"><input value={block.caption ?? ''} onChange={(e) => set({ caption: e.target.value })} className="input" /></Field>
      <Field label="Aspect ratio">
        <select value={block.aspect ?? '16/9'} onChange={(e) => set({ aspect: e.target.value })} className="input">
          <option value="16/9">16/9</option><option value="4/3">4/3</option><option value="1/1">1/1 (square)</option><option value="3/4">3/4 (portrait)</option><option value="21/9">21/9 (cinematic)</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!block.rounded} onChange={(e) => set({ rounded: e.target.checked })} /> Rounded corners
      </label>
    </>
  )
}

function GalleryFields({ block, set }: any) {
  const images = (block.images as Array<{ url: string; alt?: string }> | undefined) ?? []
  return (
    <>
      <Field label="Columns">
        <select value={block.columns ?? 3} onChange={(e) => set({ columns: parseInt(e.target.value, 10) })} className="input">
          <option value={2}>2</option><option value={3}>3</option><option value={4}>4</option>
        </select>
      </Field>
      <p className="text-xs text-s-muted">Images</p>
      {images.map((img, i) => (
        <div key={i} className="flex gap-2">
          <input value={img.url} onChange={(e) => {
            const next = [...images]; next[i] = { ...next[i]!, url: e.target.value }; set({ images: next })
          }} placeholder="image URL" className="input flex-1" />
          <button onClick={() => { const next = images.filter((_, j) => j !== i); set({ images: next }) }}
            className="text-xs text-s-red hover:bg-red-50 px-2 rounded">×</button>
        </div>
      ))}
      <button onClick={() => set({ images: [...images, { url: '' }] })} className="text-xs text-s-teal hover:underline">+ Add image</button>
    </>
  )
}

function StatsFields({ block, set }: any) {
  const stats = (block.stats as Array<{ value: string; label: string }> | undefined) ?? []
  return (
    <>
      <p className="text-xs text-s-muted">Stat tiles</p>
      {stats.map((s, i) => (
        <div key={i} className="flex gap-2">
          <input value={s.value} onChange={(e) => { const n = [...stats]; n[i] = { ...n[i]!, value: e.target.value }; set({ stats: n }) }} placeholder="Value" className="input w-24" />
          <input value={s.label} onChange={(e) => { const n = [...stats]; n[i] = { ...n[i]!, label: e.target.value }; set({ stats: n }) }} placeholder="Label" className="input flex-1" />
          <button onClick={() => { set({ stats: stats.filter((_, j) => j !== i) }) }} className="text-xs text-s-red px-2">×</button>
        </div>
      ))}
      <button onClick={() => set({ stats: [...stats, { value: '', label: '' }] })} className="text-xs text-s-teal hover:underline">+ Add stat</button>
    </>
  )
}

function VoicesFields({ block, set }: any) {
  const voices = (block.voices as Array<{ brand: string; line: string }> | undefined) ?? []
  return (
    <>
      <Field label="Kicker"><input value={block.kicker ?? ''} onChange={(e) => set({ kicker: e.target.value })} className="input" /></Field>
      {voices.map((v, i) => (
        <div key={i} className="flex gap-2">
          <input value={v.brand} onChange={(e) => { const n = [...voices]; n[i] = { ...n[i]!, brand: e.target.value }; set({ voices: n }) }} placeholder="Brand" className="input w-32" />
          <input value={v.line}  onChange={(e) => { const n = [...voices]; n[i] = { ...n[i]!, line: e.target.value }; set({ voices: n }) }} placeholder="Tagline" className="input flex-1" />
          <button onClick={() => { set({ voices: voices.filter((_, j) => j !== i) }) }} className="text-xs text-s-red px-2">×</button>
        </div>
      ))}
      <button onClick={() => set({ voices: [...voices, { brand: '', line: '' }] })} className="text-xs text-s-teal hover:underline">+ Add voice</button>
    </>
  )
}

function KitchensFields({ block, set }: any) {
  return (
    <>
      <Field label="Kicker"><input value={block.kicker ?? ''} onChange={(e) => set({ kicker: e.target.value })} className="input" /></Field>
      <Field label="Title"><input value={block.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="input" /></Field>
      <Field label="Max kitchens to show"><input type="number" min={1} max={20} value={block.max ?? 6} onChange={(e) => set({ max: parseInt(e.target.value, 10) })} className="input" /></Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!block.showAllLink} onChange={(e) => set({ showAllLink: e.target.checked })} />
        Show "See all →" link
      </label>
    </>
  )
}

function FeaturedMenuFields({ block, set }: any) {
  return (
    <>
      <Field label="Brand slug (leave blank to inherit on a brand page)">
        <input value={block.conceptSlug ?? ''} onChange={(e) => set({ conceptSlug: e.target.value || undefined })} placeholder="stax" className="input" />
      </Field>
      <Field label="Kicker"><input value={block.kicker ?? ''} onChange={(e) => set({ kicker: e.target.value })} className="input" /></Field>
      <Field label="Title"><input value={block.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="input" /></Field>
      <Field label="Max items"><input type="number" min={1} max={20} value={block.max ?? 6} onChange={(e) => set({ max: parseInt(e.target.value, 10) })} className="input" /></Field>
    </>
  )
}

function ReviewsFields({ block, set }: any) {
  return (
    <>
      <Field label="Brand slug (leave blank to inherit)">
        <input value={block.conceptSlug ?? ''} onChange={(e) => set({ conceptSlug: e.target.value || undefined })} className="input" />
      </Field>
      <Field label="Max reviews"><input type="number" min={1} max={20} value={block.max ?? 6} onChange={(e) => set({ max: parseInt(e.target.value, 10) })} className="input" /></Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={block.showRating !== false} onChange={(e) => set({ showRating: e.target.checked })} />
        Show overall star rating
      </label>
    </>
  )
}

function QuoteFields({ block, set }: any) {
  return (
    <>
      <Field label="Quote *"><textarea rows={3} value={block.text ?? ''} onChange={(e) => set({ text: e.target.value })} className="input" /></Field>
      <Field label="Attribution"><input value={block.attribution ?? ''} onChange={(e) => set({ attribution: e.target.value })} placeholder="— Source" className="input" /></Field>
      <Field label="Size">
        <select value={block.size ?? 'lg'} onChange={(e) => set({ size: e.target.value })} className="input">
          <option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large</option>
        </select>
      </Field>
    </>
  )
}

function SpacerFields({ block, set }: any) {
  return (
    <Field label="Size">
      <select value={block.size ?? 'md'} onChange={(e) => set({ size: e.target.value as SectionPad })} className="input">
        <option value="none">None</option><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large</option>
      </select>
    </Field>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-s-muted font-bold mb-1 uppercase tracking-wider">{label}</span>
      {children}
    </label>
  )
}

function AlignSelect({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  return (
    <div className="flex gap-1">
      {(['left', 'center', 'right'] as const).map((a) => (
        <button key={a} onClick={() => onChange(a)} aria-pressed={value === a}
          className={`flex-1 py-1.5 rounded text-xs font-bold border ${value === a ? 'bg-black text-white border-black' : 'bg-white border-s-border'}`}>
          {a}
        </button>
      ))}
    </div>
  )
}

// Tailwind utility shortcut (kept inline since web app uses Tailwind globally)
const _ = `.input { @apply w-full bg-white border border-s-border rounded px-2 py-1.5 text-sm; }`
void _
