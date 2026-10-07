'use client'
// stackd.stickers — each line is a seal, in the packaging palette and set
// slightly off-square, the way a label goes on by hand. Cards on this brand are
// stickers, never rectangles.

import { useEffect, useRef } from 'react'
import type { SectionProps } from '../types'
import { str, list } from '../safe'
import { DIE_SHAPES } from '../../lib/stackdDie'
import { StackdFrame, stackdConcept, fill } from './shared'

/** The wavy seal behind a sticker: pale-blue outer band, plum keyline, fill. */
function StickerDie({ index }: { index: number }) {
  const d = DIE_SHAPES[index % DIE_SHAPES.length]!
  return (
    <svg className="stackd-sticker-die" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <path className="die-band" d={d} />
      <path className="die-face" d={d} />
    </svg>
  )
}

export function StackdStickers({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const items = list<{ text?: unknown }>(fields.items).map((i) => str(i.text)).filter((t) => t.trim())
  const heading = str(fields.heading)
  const spec = str(fields.spec)

  // Scroll reveal. Everything renders visible by default and .stackd-reveal is
  // only ADDED here, so a browser without JS (or IntersectionObserver) gets the
  // page with no animation rather than a page of invisible cards.
  const revealRoot = useRef<HTMLDivElement | null>(null)
  const count = items.length
  useEffect(() => {
    const root = revealRoot.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))
    cards.forEach((el, i) => {
      el.classList.add('stackd-reveal')
      el.style.transitionDelay = `${Math.min(i, 6) * 70}ms`
    })

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          e.target.classList.add('is-in')
          io.unobserve(e.target)   // one-way: cards don't fade back out on scroll up
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    )
    cards.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [count])

  return (
    <StackdFrame>
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div ref={revealRoot} style={{ maxWidth: '76rem', margin: '0 auto' }}>
          {(heading || spec) && (
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '2rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: 0 }}>
                {fill(heading, concept)}
              </h2>
              <span className="stackd-spec">{fill(spec, concept)}</span>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: 'clamp(1rem, 2vw, 1.5rem)',
              marginTop: '2.25rem',
            }}
          >
            {items.map((h, i) => (
              <div key={`${i}-${h}`} data-reveal className="stackd-sticker" style={{ aspectRatio: '1 / 0.92' }}>
                <StickerDie index={i} />
                <div className="stackd-sticker-inner">
                  {fields.numbered !== false && <span className="stackd-spec">{String(i + 1).padStart(2, '0')}</span>}
                  <p
                    className="stackd-display"
                    style={{ fontSize: 'clamp(0.95rem, 1.45vw, 1.15rem)', lineHeight: 1.18, margin: '0.5rem 0 0', fontWeight: 600 }}
                  >
                    {fill(h, concept)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </StackdFrame>
  )
}
