'use client'

// Per-element editing form (moved from the old /content editor and extended):
// type-specific fields, then Style (background, text colour, padding, font)
// and Animation (with a replay preview). Edits flow through onChange(next).

import { useState } from 'react'
import { ANIMATIONS, blockLabel, columnsOf, type Animation, type Block, type ButtonSize, type ButtonStyle, type SectionPad } from '../../lib/blocks'
import type { MediaAssetLite } from '../../lib/content'
import { setColumnCount } from './tree'
import { AlignSelect, Check, ColorInput, CopyInput, Field, FontSelect, MediaInput, NumberInput, Section } from './fields'

interface Props {
  block: Block
  onChange: (next: Block) => void
  fonts: MediaAssetLite[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>
type FP = { block: Loose; set: (p: Partial<Block>) => void }

const NO_STYLE = new Set(['signature', 'scrollHero', 'brandFooter'])

export function BlockInspector({ block, onChange, fonts }: Props) {
  const set = (patch: Partial<Block>) => onChange({ ...block, ...patch })
  const b = block as Loose

  return (
    <div>
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
        <p className="text-xs text-s-muted uppercase tracking-wider font-bold">{blockLabel(block.type)}</p>
      </div>
      <div className="p-4 max-h-[calc(100vh-14rem)] overflow-y-auto">
        <Section title="Content">
          {block.type === 'hero'          && <HeroFields block={b} set={set} />}
          {block.type === 'cta_button'    && <CtaFields block={b} set={set} />}
          {block.type === 'banner'        && <BannerFields block={b} set={set} />}
          {block.type === 'text'          && <TextFields block={b} set={set} />}
          {block.type === 'image'         && <ImageFields block={b} set={set} />}
          {block.type === 'gallery'       && <GalleryFields block={b} set={set} />}
          {block.type === 'stat_strip'    && <StatsFields block={b} set={set} />}
          {block.type === 'voices'        && <VoicesFields block={b} set={set} />}
          {block.type === 'kitchens'      && <KitchensFields block={b} set={set} />}
          {block.type === 'featured_menu' && <FeaturedMenuFields block={b} set={set} />}
          {block.type === 'reviews'       && <ReviewsFields block={b} set={set} />}
          {block.type === 'quote'         && <QuoteFields block={b} set={set} />}
          {block.type === 'spacer'        && <SpacerFields block={b} set={set} />}
          {block.type === 'divider'       && <p className="text-xs text-s-muted">A hairline rule. Style it below.</p>}
          {block.type === 'columns'       && <ColumnsFields block={block} onChange={onChange} />}
          {block.type === 'video'         && <VideoFields block={b} set={set} />}
          {block.type === 'signup_form'   && <SignupFields block={b} set={set} />}
          {block.type === 'scrollHero'    && <ScrollHeroFields block={b} set={set} />}
          {block.type === 'brandFooter'   && <BrandFooterFields block={b} set={set} />}
          {block.type === 'signature'     && (
            <p className="text-xs text-s-muted">
              The page&apos;s own designed layout renders here, exactly as it does today. Add elements above or
              below it, or hide it to build the page from scratch.
            </p>
          )}
        </Section>

        {!NO_STYLE.has(block.type) && (
          <>
            <Section title="Style">
              <Field label="Background"><ColorInput value={block.background} onChange={(v) => set({ background: v })} placeholder="#ffffff or var(--servd-ink)" /></Field>
              <Field label="Text colour"><ColorInput value={block.textColor} onChange={(v) => set({ textColor: v })} placeholder="#000000" /></Field>
              <Field label="Top/bottom padding">
                <select value={block.paddingY ?? ''} onChange={(e) => set({ paddingY: (e.target.value || undefined) as SectionPad | undefined })} className="s-select">
                  <option value="">Default</option>
                  <option value="none">None</option><option value="sm">Small</option><option value="md">Medium</option>
                  <option value="lg">Large</option><option value="xl">X-large</option>
                </select>
              </Field>
              <Field label="Font"><FontSelect value={block.fontFamily} onChange={(v) => set({ fontFamily: v })} fonts={fonts} emptyLabel="Page default" /></Field>
              <Check checked={!!block.fullBleed} onChange={(v) => set({ fullBleed: v || undefined })}>Full bleed (edge to edge)</Check>
            </Section>

            <Section title="Animation">
              <Field label="Entrance">
                <select value={block.animation ?? 'none'} onChange={(e) => set({ animation: e.target.value === 'none' ? undefined : e.target.value as Animation })} className="s-select">
                  {ANIMATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </Field>
              {block.animation && block.animation !== 'none' && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Delay (ms)"><NumberInput value={block.animationDelayMs} min={0} max={3000} step={100} onChange={(v) => set({ animationDelayMs: v })} /></Field>
                    <Field label="Duration (ms)"><NumberInput value={block.animationDurationMs ?? 600} min={200} max={3000} step={100} onChange={(v) => set({ animationDurationMs: v })} /></Field>
                  </div>
                  <AnimationPreview animation={block.animation} delay={block.animationDelayMs ?? 0} duration={block.animationDurationMs ?? 600} />
                </>
              )}
            </Section>
          </>
        )}

        <Section title="Visibility">
          <Check checked={!!block.hidden} onChange={(v) => set({ hidden: v || undefined })}>Hide (kept in the editor, not shown on the storefront)</Check>
        </Section>
      </div>
    </div>
  )
}

// ─── Animation preview ─────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes sfb-fade-up { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: none } }
@keyframes sfb-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes sfb-slide-left { from { opacity: 0; transform: translateX(48px) } to { opacity: 1; transform: none } }
@keyframes sfb-slide-right { from { opacity: 0; transform: translateX(-48px) } to { opacity: 1; transform: none } }
@keyframes sfb-zoom-in { from { opacity: 0; transform: scale(.85) } to { opacity: 1; transform: none } }
`

function AnimationPreview({ animation, delay, duration }: { animation: Animation; delay: number; duration: number }) {
  const [run, setRun] = useState(0)
  return (
    <div className="flex items-center gap-3">
      <style>{KEYFRAMES}</style>
      <div className="h-16 flex-1 rounded-lg bg-s-bg border border-s-border flex items-center justify-center overflow-hidden">
        <div key={`${run}-${animation}-${delay}-${duration}`}
          style={{ animation: `sfb-${animation} ${duration}ms ease-out ${delay}ms both` }}
          className="px-3 py-1.5 rounded bg-primary text-primary-on text-xs font-bold">
          Element
        </div>
      </div>
      <button type="button" onClick={() => setRun((n) => n + 1)} className="s-btn-secondary text-xs">Replay</button>
    </div>
  )
}

// ─── Per-type field forms ──────────────────────────────────────────────────

function CtaPair({ label, value, onChange, onRemove }: { label: string; value: { text?: string; href?: string } | undefined; onChange: (v: { text: string; href: string }) => void; onRemove: () => void }) {
  const v = { text: value?.text ?? '', href: value?.href ?? '' }
  return (
    <fieldset className="border border-s-border rounded-lg p-2 space-y-2">
      <legend className="text-[11px] text-s-muted px-1">{label}</legend>
      <Field label="Text"><CopyInput value={v.text} onChange={(t) => onChange({ ...v, text: t })} /></Field>
      <Field label="Link"><input value={v.href} onChange={(e) => onChange({ ...v, href: e.target.value })} placeholder="/browse" className="s-input" /></Field>
      {value && <button type="button" onClick={onRemove} className="text-[11px] text-s-red hover:underline">Remove</button>}
    </fieldset>
  )
}

function HeroFields({ block, set }: FP) {
  return (
    <>
      <Field label="Kicker (small label)"><CopyInput value={block.kicker} onChange={(v) => set({ kicker: v })} /></Field>
      <Field label="Title"><CopyInput value={block.title} onChange={(v) => set({ title: v })} /></Field>
      <Field label="Subtitle"><CopyInput rows={3} value={block.subtitle} onChange={(v) => set({ subtitle: v })} /></Field>
      <Field label="Background image"><MediaInput kind="image" value={block.imageUrl} onChange={(v) => set({ imageUrl: v })} /></Field>
      <Field label="Image overlay (0 to 1)"><NumberInput value={block.imageOverlay ?? 0.45} min={0} max={1} step={0.05} onChange={(v) => set({ imageOverlay: v })} /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'left'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Height">
        <select value={block.height ?? 'lg'} onChange={(e) => set({ height: e.target.value })} className="s-select">
          {(['sm', 'md', 'lg', 'xl', 'screen'] as const).map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </Field>
      <CtaPair label="Primary button" value={block.primaryCta} onChange={(v) => set({ primaryCta: v })} onRemove={() => set({ primaryCta: undefined })} />
      <CtaPair label="Secondary button (optional)" value={block.secondaryCta} onChange={(v) => set({ secondaryCta: v })} onRemove={() => set({ secondaryCta: undefined })} />
    </>
  )
}

function CtaFields({ block, set }: FP) {
  return (
    <>
      <Field label="Button text"><CopyInput value={block.text} onChange={(v) => set({ text: v })} /></Field>
      <Field label="Link"><input value={block.href ?? ''} onChange={(e) => set({ href: e.target.value })} placeholder="/browse" className="s-input" /></Field>
      <Field label="Style">
        <select value={block.style ?? 'primary'} onChange={(e) => set({ style: e.target.value as ButtonStyle })} className="s-select">
          <option value="primary">Primary</option><option value="secondary">Secondary (outlined)</option>
          <option value="dark">Dark</option><option value="ghost">Ghost (transparent)</option>
        </select>
      </Field>
      <Field label="Size">
        <select value={block.size ?? 'lg'} onChange={(e) => set({ size: e.target.value as ButtonSize })} className="s-select">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
          <option value="xl">X-large</option><option value="huge">Huge</option>
        </select>
      </Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'center'} onChange={(v) => set({ align: v })} /></Field>
      <Check checked={!!block.fullWidth} onChange={(v) => set({ fullWidth: v })}>Stretch to full width</Check>
      <Check checked={!!block.trailingArrow} onChange={(v) => set({ trailingArrow: v })}>Trailing arrow</Check>
    </>
  )
}

function BannerFields({ block, set }: FP) {
  return (
    <>
      <Field label="Title"><CopyInput value={block.title} onChange={(v) => set({ title: v })} /></Field>
      <Field label="Subtitle"><CopyInput value={block.subtitle} onChange={(v) => set({ subtitle: v })} /></Field>
      <Field label="Background image"><MediaInput kind="image" value={block.backgroundUrl} onChange={(v) => set({ backgroundUrl: v })} /></Field>
      <Field label="Band colour"><ColorInput value={block.backgroundColor} onChange={(v) => set({ backgroundColor: v })} /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'center'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Height">
        <select value={block.height ?? 'md'} onChange={(e) => set({ height: e.target.value })} className="s-select">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
        </select>
      </Field>
    </>
  )
}

function TextFields({ block, set }: FP) {
  return (
    <>
      <Field label="Body"><CopyInput rows={6} value={block.body} onChange={(v) => set({ body: v })} /></Field>
      <Field label="Alignment"><AlignSelect value={block.align ?? 'left'} onChange={(v) => set({ align: v })} /></Field>
      <Field label="Size">
        <select value={block.size ?? 'md'} onChange={(e) => set({ size: e.target.value })} className="s-select">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large (display)</option>
        </select>
      </Field>
      <Field label="Width">
        <select value={block.maxWidth ?? 'narrow'} onChange={(e) => set({ maxWidth: e.target.value })} className="s-select">
          <option value="narrow">Narrow (reading column)</option><option value="wide">Wide</option><option value="full">Full</option>
        </select>
      </Field>
      <Check checked={!!block.emphasized} onChange={(v) => set({ emphasized: v })}>Emphasized weight</Check>
    </>
  )
}

function ImageFields({ block, set }: FP) {
  return (
    <>
      <Field label="Image"><MediaInput kind="image" value={block.url} onChange={(v) => set({ url: v })} /></Field>
      <Field label="Alt text"><input value={block.alt ?? ''} onChange={(e) => set({ alt: e.target.value })} className="s-input" /></Field>
      <Field label="Caption"><CopyInput value={block.caption} onChange={(v) => set({ caption: v })} /></Field>
      <Field label="Aspect ratio">
        <select value={block.aspect ?? '16/9'} onChange={(e) => set({ aspect: e.target.value })} className="s-select">
          <option value="16/9">16/9</option><option value="4/3">4/3</option><option value="1/1">1/1 (square)</option>
          <option value="3/4">3/4 (portrait)</option><option value="21/9">21/9 (cinematic)</option>
        </select>
      </Field>
      <Check checked={!!block.rounded} onChange={(v) => set({ rounded: v })}>Rounded corners</Check>
    </>
  )
}

function GalleryFields({ block, set }: FP) {
  const images = (block.images as Array<{ url: string; alt?: string }> | undefined) ?? []
  return (
    <>
      <Field label="Columns">
        <select value={block.columns ?? 3} onChange={(e) => set({ columns: parseInt(e.target.value, 10) })} className="s-select">
          <option value={2}>2</option><option value={3}>3</option><option value={4}>4</option>
        </select>
      </Field>
      {images.map((img, i) => (
        <div key={i} className="border border-s-border rounded-lg p-2 space-y-1">
          <MediaInput kind="image" value={img.url} onChange={(v) => { const n = [...images]; n[i] = { ...n[i]!, url: v }; set({ images: n }) }} />
          <div className="flex gap-2">
            <input value={img.alt ?? ''} onChange={(e) => { const n = [...images]; n[i] = { ...n[i]!, alt: e.target.value }; set({ images: n }) }} placeholder="Alt text" className="s-input" />
            <button type="button" onClick={() => set({ images: images.filter((_, j) => j !== i) })} className="text-xs text-s-red px-2">Remove</button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => set({ images: [...images, { url: '' }] })} className="text-xs text-primary-ink hover:underline">+ Add image</button>
    </>
  )
}

function StatsFields({ block, set }: FP) {
  const stats = (block.stats as Array<{ value: string; label: string }> | undefined) ?? []
  return (
    <>
      {stats.map((s, i) => (
        <div key={i} className="flex gap-2">
          <input value={s.value} onChange={(e) => { const n = [...stats]; n[i] = { ...n[i]!, value: e.target.value }; set({ stats: n }) }} placeholder="Value" className="s-input w-20" />
          <input value={s.label} onChange={(e) => { const n = [...stats]; n[i] = { ...n[i]!, label: e.target.value }; set({ stats: n }) }} placeholder="Label" className="s-input" />
          <button type="button" onClick={() => set({ stats: stats.filter((_, j) => j !== i) })} className="text-xs text-s-red px-1">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => set({ stats: [...stats, { value: '', label: '' }] })} className="text-xs text-primary-ink hover:underline">+ Add stat</button>
    </>
  )
}

function VoicesFields({ block, set }: FP) {
  const voices = (block.voices as Array<{ brand: string; line: string }> | undefined) ?? []
  return (
    <>
      <Field label="Kicker"><CopyInput value={block.kicker} onChange={(v) => set({ kicker: v })} /></Field>
      {voices.map((v, i) => (
        <div key={i} className="flex gap-2">
          <input value={v.brand} onChange={(e) => { const n = [...voices]; n[i] = { ...n[i]!, brand: e.target.value }; set({ voices: n }) }} placeholder="Brand" className="s-input w-28" />
          <input value={v.line} onChange={(e) => { const n = [...voices]; n[i] = { ...n[i]!, line: e.target.value }; set({ voices: n }) }} placeholder="Tagline" className="s-input" />
          <button type="button" onClick={() => set({ voices: voices.filter((_, j) => j !== i) })} className="text-xs text-s-red px-1">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => set({ voices: [...voices, { brand: '', line: '' }] })} className="text-xs text-primary-ink hover:underline">+ Add voice</button>
    </>
  )
}

function KitchensFields({ block, set }: FP) {
  return (
    <>
      <Field label="Kicker"><CopyInput value={block.kicker} onChange={(v) => set({ kicker: v })} /></Field>
      <Field label="Title"><CopyInput value={block.title} onChange={(v) => set({ title: v })} /></Field>
      <Field label="Max kitchens"><NumberInput value={block.max ?? 6} min={1} max={20} onChange={(v) => set({ max: v })} /></Field>
      <Check checked={!!block.showAllLink} onChange={(v) => set({ showAllLink: v })}>Show a &quot;See all&quot; link</Check>
    </>
  )
}

function FeaturedMenuFields({ block, set }: FP) {
  return (
    <>
      <Field label="Brand slug" hint="Blank on a brand page uses that brand.">
        <input value={block.conceptSlug ?? ''} onChange={(e) => set({ conceptSlug: e.target.value || undefined })} placeholder="simmer" className="s-input" />
      </Field>
      <Field label="Kicker"><CopyInput value={block.kicker} onChange={(v) => set({ kicker: v })} /></Field>
      <Field label="Title"><CopyInput value={block.title} onChange={(v) => set({ title: v })} /></Field>
      <Field label="Max items"><NumberInput value={block.max ?? 6} min={1} max={20} onChange={(v) => set({ max: v })} /></Field>
    </>
  )
}

function ReviewsFields({ block, set }: FP) {
  return (
    <>
      <Field label="Brand slug" hint="Blank on a brand page uses that brand.">
        <input value={block.conceptSlug ?? ''} onChange={(e) => set({ conceptSlug: e.target.value || undefined })} className="s-input" />
      </Field>
      <Field label="Max reviews"><NumberInput value={block.max ?? 6} min={1} max={20} onChange={(v) => set({ max: v })} /></Field>
      <Check checked={block.showRating !== false} onChange={(v) => set({ showRating: v })}>Show overall star rating</Check>
    </>
  )
}

function QuoteFields({ block, set }: FP) {
  return (
    <>
      <Field label="Quote"><CopyInput rows={3} value={block.text} onChange={(v) => set({ text: v })} /></Field>
      <Field label="Attribution"><CopyInput value={block.attribution} onChange={(v) => set({ attribution: v })} /></Field>
      <Field label="Size">
        <select value={block.size ?? 'lg'} onChange={(e) => set({ size: e.target.value })} className="s-select">
          <option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large</option>
        </select>
      </Field>
    </>
  )
}

function SpacerFields({ block, set }: FP) {
  return (
    <Field label="Size">
      <select value={block.size ?? 'md'} onChange={(e) => set({ size: e.target.value as SectionPad })} className="s-select">
        <option value="none">None</option><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option><option value="xl">X-large</option>
      </select>
    </Field>
  )
}

function ColumnsFields({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const cols = columnsOf(block) ?? []
  const b = block as Loose
  return (
    <>
      <Field label="Columns" hint="Removing a column moves its elements into the last remaining one.">
        <select value={cols.length} onChange={(e) => onChange(setColumnCount(block, parseInt(e.target.value, 10)))} className="s-select">
          <option value={2}>2</option><option value={3}>3</option><option value={4}>4</option>
        </select>
      </Field>
      <Field label="Gap">
        <select value={b.gap ?? 'md'} onChange={(e) => onChange({ ...block, gap: e.target.value })} className="s-select">
          <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
        </select>
      </Field>
      <Check checked={b.stackOnMobile !== false} onChange={(v) => onChange({ ...block, stackOnMobile: v })}>Stack columns on phones</Check>
      <p className="text-[11px] text-s-dim">Drag elements from the palette or the canvas into a column.</p>
    </>
  )
}

function VideoFields({ block, set }: FP) {
  return (
    <>
      <Field label="Video" hint="Upload to the library, or paste an MP4/WebM link."><MediaInput kind="video" value={block.url} onChange={(v) => set({ url: v })} /></Field>
      <Field label="Poster image (optional)"><MediaInput kind="image" value={block.posterUrl} onChange={(v) => set({ posterUrl: v || undefined })} /></Field>
      <Field label="Aspect ratio">
        <select value={block.aspectRatio ?? '16:9'} onChange={(e) => set({ aspectRatio: e.target.value })} className="s-select">
          <option value="16:9">16:9</option><option value="9:16">9:16 (vertical)</option><option value="1:1">1:1</option><option value="4:5">4:5</option>
        </select>
      </Field>
      <Check checked={block.autoplay !== false} onChange={(v) => set({ autoplay: v })}>Autoplay</Check>
      <Check checked={block.loop !== false} onChange={(v) => set({ loop: v })}>Loop</Check>
      <Check checked={block.muted !== false} onChange={(v) => set({ muted: v })}>Muted (required for autoplay on phones)</Check>
    </>
  )
}

function SignupFields({ block, set }: FP) {
  return (
    <>
      <Field label="Mode">
        <select value={block.mode ?? 'signup'} onChange={(e) => set({ mode: e.target.value })} className="s-select">
          <option value="signup">Sign up</option><option value="login">Log in</option>
        </select>
      </Field>
      <Field label="Title"><CopyInput value={block.title} onChange={(v) => set({ title: v || undefined })} /></Field>
      <Field label="Subtitle"><CopyInput rows={2} value={block.subtitle} onChange={(v) => set({ subtitle: v || undefined })} /></Field>
      <p className="text-[11px] text-s-dim">Uses the storefront&apos;s one-code (OTP) sign-in. A submit counts as a conversion.</p>
    </>
  )
}

function ScrollHeroFields({ block, set }: FP) {
  const video = block.mediaType === 'video'
  return (
    <>
      <Field label="Hero media">
        <select value={video ? 'video' : 'image'} onChange={(e) => set({ mediaType: e.target.value })} className="s-select">
          <option value="image">Image</option><option value="video">Video</option>
        </select>
      </Field>
      <Field label={video ? 'Video' : 'Foreground image'} hint="The element that expands as the visitor scrolls.">
        <MediaInput kind={video ? 'video' : 'image'} value={block.mediaSrc} onChange={(v) => set({ mediaSrc: v })} />
      </Field>
      {video && <Field label="Video poster (optional)"><MediaInput kind="image" value={block.posterSrc} onChange={(v) => set({ posterSrc: v })} /></Field>}
      <Field label="Background image" hint="Full-bleed image behind the hero; fades out as the media expands.">
        <MediaInput kind="image" value={block.bgImageSrc} onChange={(v) => set({ bgImageSrc: v })} />
      </Field>
      <Field label="Title" hint="Blank uses food placeholders."><CopyInput value={block.title} onChange={(v) => set({ title: v })} /></Field>
      <Field label="Eyebrow label"><CopyInput value={block.date} onChange={(v) => set({ date: v })} /></Field>
      <Field label="Scroll hint"><input value={block.scrollToExpand ?? ''} onChange={(e) => set({ scrollToExpand: e.target.value })} className="s-input" /></Field>
      <Field label="Intro (after the hero expands)"><CopyInput rows={3} value={block.overview} onChange={(v) => set({ overview: v })} /></Field>
      <Field label="Sub-intro"><CopyInput rows={2} value={block.conclusion} onChange={(v) => set({ conclusion: v })} /></Field>
      <Check checked={block.textBlend !== false} onChange={(v) => set({ textBlend: v })}>Blend the title against the background</Check>
    </>
  )
}

function BrandFooterFields({ block, set }: FP) {
  const social = (block.social ?? {}) as Record<string, string>
  const setSocial = (k: string, v: string) => set({ social: { ...social, [k]: v } })
  return (
    <>
      <p className="text-[11px] text-s-dim">Blank fields fall back to the brand&apos;s defaults. The footer takes the brand colour automatically.</p>
      <Field label="Eyebrow"><CopyInput value={block.ctaEyebrow} onChange={(v) => set({ ctaEyebrow: v })} /></Field>
      <Field label="Headline"><CopyInput value={block.ctaHeadline} onChange={(v) => set({ ctaHeadline: v })} /></Field>
      <Field label="Headline accent" hint="Shown in the brand colour."><CopyInput value={block.ctaAccent} onChange={(v) => set({ ctaAccent: v })} /></Field>
      <Field label="Tagline"><CopyInput rows={2} value={block.tagline} onChange={(v) => set({ tagline: v })} /></Field>
      {(['instagram', 'tiktok', 'facebook', 'whatsapp'] as const).map((k) => (
        <Field key={k} label={k}>
          <input value={social[k] ?? ''} onChange={(e) => setSocial(k, e.target.value)} placeholder="https://..." className="s-input" />
        </Field>
      ))}
    </>
  )
}
