'use client'

// "Scroll effect" in the element inspector (D4 stage 1): a gallery of presets
// (block.motion = { preset, intensity }), a strength switch and a preview
// slider that plays the effect on the selected element in the live page.
// The presets' real behaviour is the storefront's (lib/motion.ts +
// components/blocks/motion.css); the thumbnails here are only a hint of it,
// drawn with admin tokens. The slider never writes the block: it only moves
// the live frame (motion-preview), and goes back to live on its own.

import { useEffect, useRef, useState } from 'react'
import {
  isMotionIntensity, isSimmerSlug, MOTION_INTENSITIES, MOTION_INTENSITY_UI, MOTION_UI, motionPresetOf, motionPresetsFor,
  type Block, type BlockMotion, type MotionIntensity, type MotionPreset,
} from '../../lib/blocks'
import type { LayoutKind } from '../../lib/content'
import { Field } from './fields'

export interface MotionPreviewControl {
  /** The live page is connected and shows the latest edit. */
  ready: boolean
  /** Why the slider is off, when it is. */
  reason: string | null
  /** Bumped when the page ended the preview (scrolled, element gone) or reconnected. */
  resetNonce: number
  /** progress 0..1 plays the effect at that point; null = back to live. */
  onPreview: (id: string, progress: number | null) => void
}

interface Props {
  block: Block
  kind: LayoutKind
  slug: string
  preview: MotionPreviewControl
  onChange: (motion: BlockMotion | undefined) => void
}

export function MotionPicker({ block, kind, slug, preview, onChange }: Props) {
  const offered = motionPresetsFor(kind, slug)
  const preset = motionPresetOf(block)
  const raw = block.motion as unknown
  const unknownValue = raw !== undefined && raw !== null && !preset
  const rawIntensity = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['intensity'] : undefined
  const intensity: MotionIntensity = isMotionIntensity(rawIntensity) ? rawIntensity : 'medium'
  const simmer = isSimmerSlug(slug)

  // ─── Preview slider (frame only, never saved) ────────────────────────────
  const [progress, setProgress] = useState<number | null>(null)
  const progressRef = useRef<number | null>(null)
  progressRef.current = progress
  const onPreviewRef = useRef(preview.onPreview)
  onPreviewRef.current = preview.onPreview
  const id = block.id

  const backToLive = (post: boolean) => {
    if (progressRef.current === null) return
    setProgress(null)
    if (post) onPreviewRef.current(id, null)
  }

  // The page ended the preview or reconnected: show "live" again.
  const firstNonce = useRef(preview.resetNonce)
  useEffect(() => {
    if (preview.resetNonce === firstNonce.current) return
    setProgress(null)
  }, [preview.resetNonce])

  // Leaving the element (another selection, the inspector closing) ends the preview.
  useEffect(() => () => {
    if (progressRef.current !== null) onPreviewRef.current(id, null)
  }, [id])

  const choose = (next: MotionPreset | null) => {
    backToLive(true)
    onChange(next ? { preset: next, intensity } : undefined)
  }
  const setStrength = (next: MotionIntensity) => {
    if (!preset) return
    backToLive(true)
    onChange({ preset, intensity: next })
  }

  const scrub = (v: number) => {
    const p = Math.max(0, Math.min(1, v / 100))
    setProgress(p)
    onPreviewRef.current(id, p)
  }

  const tiles: Array<MotionPreset | null> = [null, ...offered]
  // A saved value this page doesn't offer (Text reveal on Simmer, a pin on a
  // footer) still shows as selected, with a note.
  if (preset && !offered.includes(preset)) tiles.push(preset)

  return (
    <div className="space-y-3">
      <style>{THUMB_CSS}</style>
      <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Scroll effect">
        {tiles.map((p) => {
          const on = p === preset || (p === null && !preset && !unknownValue)
          return (
            <button key={p ?? 'none'} type="button" role="radio" aria-checked={on} onClick={() => choose(p)}
              title={p ? MOTION_UI[p].description : 'No scroll effect'}
              className={`text-left rounded-lg border p-1.5 transition-colors ${on ? 'border-s-teal bg-s-teal-dim/40' : 'border-s-border bg-s-surface hover:border-s-border-strong'}`}>
              <Thumb preset={p} />
              <span className="mt-1 block text-[11px] font-semibold text-s-text leading-tight">{p ? MOTION_UI[p].label : 'None'}</span>
              <span className="block text-[10px] text-s-muted leading-snug">{p ? MOTION_UI[p].description : 'Scrolls with the page.'}</span>
            </button>
          )
        })}
      </div>

      {unknownValue && (
        <div className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-[11px] text-s-amber space-y-1">
          <p>This element carries a scroll effect this editor doesn&apos;t know. The site ignores it and shows the element still.</p>
          <button type="button" onClick={() => onChange(undefined)} className="underline">Remove it</button>
        </div>
      )}

      {preset && (
        <>
          <Field label="Strength">
            <div className="flex gap-1" role="radiogroup" aria-label="Strength">
              {MOTION_INTENSITIES.map((i) => (
                <button key={i} type="button" role="radio" aria-checked={intensity === i} onClick={() => setStrength(i)}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold border ${intensity === i ? 'bg-primary text-primary-on border-s-teal' : 'bg-s-bg-soft text-s-text border-s-border'}`}>
                  {MOTION_INTENSITY_UI[i]}
                </button>
              ))}
            </div>
          </Field>

          <PresetNotes preset={preset} kind={kind} simmer={simmer} offered={offered.includes(preset)} />

          <Field label="Preview">
            <div className="space-y-1">
              <input type="range" min={0} max={100} step={1} value={Math.round((progress ?? 0) * 100)}
                disabled={!preview.ready} aria-label="Preview the scroll effect"
                aria-valuetext={progress === null ? 'Live' : `${Math.round(progress * 100)}%`}
                onChange={(e) => scrub(Number(e.target.value))}
                className="w-full accent-primary disabled:opacity-40" />
              <div className="flex justify-between text-[10px] text-s-dim">
                <span>Start</span>
                <span className="text-s-muted">{progress === null ? 'Live' : `${Math.round(progress * 100)}%`}</span>
                <span>End</span>
              </div>
              {preview.ready
                ? (
                  <p className="text-[11px] text-s-dim">
                    {preset === 'sticky-stack'
                      ? 'Drag to scroll the page through the stack. Scroll the page to see it live.'
                      : 'Drag to play the effect on the page. Scroll the page to see it live.'}
                    {progress !== null && (
                      <> <button type="button" onClick={() => backToLive(true)} className="text-primary-ink hover:underline">Back to live</button></>
                    )}
                  </p>
                )
                : <p className="text-[11px] text-s-dim">{preview.reason ?? 'Preview needs the live page.'}</p>}
            </div>
          </Field>
        </>
      )}

      <p className="text-[11px] text-s-dim">Visitors who turn off motion on their device see it still.</p>
      <p className="text-[11px] text-s-dim">The servd app shows a simple entrance instead.</p>
    </div>
  )
}

function PresetNotes({ preset, kind, simmer, offered }: { preset: MotionPreset; kind: LayoutKind; simmer: boolean; offered: boolean }) {
  const notes: string[] = []
  if (!offered) {
    if (kind === 'footer' && (preset === 'pin-reveal' || preset === 'sticky-stack')) {
      notes.push('A footer is never followed by enough page for this effect, so it may not play. Pick another one.')
    } else if (simmer && preset === 'text-reveal') {
      notes.push('Simmer pages leave this effect out: its soft fade reads as a gradient, which Simmer does not use (owner to confirm). It still shows on the site until you change it.')
    }
  }
  if (preset === 'parallax' || preset === 'side-pan') notes.push('Best on images and text. On a coloured band, Strong can show a gap at its edges.')
  if (preset === 'pin-reveal') notes.push('Adds extra scrolling while it is held.')
  if (preset === 'sticky-stack') {
    notes.push('Use it on two or more elements in a row. Each needs its own background.')
    if (simmer) notes.push('On Simmer pages the cards stack without a shadow (Simmer uses no gradients).')
  }
  if (notes.length === 0) return null
  return (
    <div className="space-y-1">
      {notes.map((n) => <p key={n} className={`text-[11px] ${offered ? 'text-s-muted' : 'text-s-amber'}`}>{n}</p>)}
    </div>
  )
}

// ─── Thumbnails ──────────────────────────────────────────────────────────────
// Looping hints of each effect, admin tokens only. The resting style of every
// element is its natural, fully visible state; the keyframes start from the
// effect, so with reduced motion (animation off) each thumbnail sits still.

const THUMB_CSS = `
.sfm-stage { position: relative; height: 44px; border-radius: 6px; overflow: hidden; background: var(--elevated); border: 1px solid var(--border); }
.sfm-line { position: absolute; left: 12%; right: 12%; height: 3px; border-radius: 2px; background: var(--border-strong, var(--border)); }
.sfm-box { position: absolute; left: 22%; right: 22%; top: 12px; height: 18px; border-radius: 4px; background: var(--erp-secondary); }
.sfm-full { position: absolute; inset: 6px 10px; border-radius: 0; background: var(--erp-secondary); }
.sfm-card { position: absolute; left: 16%; right: 16%; height: 22px; border-radius: 4px; }
.sfm-card.one { top: 6px; background: var(--erp-secondary); }
.sfm-card.two { top: 12px; background: var(--erp-primary); }
.sfm-text { position: absolute; left: 16%; height: 4px; border-radius: 2px; background: var(--erp-secondary); }
.sfm-a { animation-duration: 2.4s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-direction: alternate; animation-fill-mode: both; }
@keyframes sfm-parallax { from { transform: translateY(7px); } to { transform: translateY(-7px); } }
@keyframes sfm-parallax-page { from { transform: translateY(16px); } to { transform: translateY(-16px); } }
@keyframes sfm-fade { from { opacity: 0.15; } to { opacity: 1; } }
@keyframes sfm-grow { from { transform: scale(0.6); } to { transform: none; } }
@keyframes sfm-reveal { from { clip-path: inset(22% 18% round 6px); } to { clip-path: inset(0 round 0); } }
@keyframes sfm-stack { from { transform: translateY(26px); } to { transform: none; } }
@keyframes sfm-pan { from { transform: translateX(70%); } to { transform: none; } }
@keyframes sfm-text { from { opacity: 0.15; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .sfm-a { animation: none !important; } }
`

function Thumb({ preset }: { preset: MotionPreset | null }) {
  const a = (name: string, delay?: number): React.CSSProperties => ({ animationName: name, ...(delay ? { animationDelay: `${delay}ms` } : {}) })
  switch (preset) {
    case null:
      return (
        <div className="sfm-stage" aria-hidden>
          <span className="sfm-line" style={{ top: 8 }} /><span className="sfm-box" /><span className="sfm-line" style={{ top: 34 }} />
        </div>
      )
    case 'parallax':
      return (
        <div className="sfm-stage" aria-hidden>
          <span className="sfm-line sfm-a" style={{ top: 6, ...a('sfm-parallax-page') }} />
          <span className="sfm-box sfm-a" style={a('sfm-parallax')} />
          <span className="sfm-line sfm-a" style={{ top: 36, ...a('sfm-parallax-page') }} />
        </div>
      )
    case 'fade':
      return <div className="sfm-stage" aria-hidden><span className="sfm-box sfm-a" style={a('sfm-fade')} /></div>
    case 'grow':
      return <div className="sfm-stage" aria-hidden><span className="sfm-box sfm-a" style={a('sfm-grow')} /></div>
    case 'pin-reveal':
      return <div className="sfm-stage" aria-hidden><span className="sfm-full sfm-a" style={a('sfm-reveal')} /></div>
    case 'sticky-stack':
      return (
        <div className="sfm-stage" aria-hidden>
          <span className="sfm-card one" /><span className="sfm-card two sfm-a" style={a('sfm-stack')} />
        </div>
      )
    case 'side-pan':
      return <div className="sfm-stage" aria-hidden><span className="sfm-box sfm-a" style={a('sfm-pan')} /></div>
    case 'text-reveal':
      return (
        <div className="sfm-stage" aria-hidden>
          <span className="sfm-text sfm-a" style={{ top: 9, right: '16%', ...a('sfm-text') }} />
          <span className="sfm-text sfm-a" style={{ top: 19, right: '24%', ...a('sfm-text', 300) }} />
          <span className="sfm-text sfm-a" style={{ top: 29, right: '34%', ...a('sfm-text', 600) }} />
        </div>
      )
  }
}
