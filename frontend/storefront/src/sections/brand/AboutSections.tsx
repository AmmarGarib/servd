// The brand About page (`brand:<slug>:about`) as sections: hero, pillars,
// image break, CTA band. Each also works on any other brand page.

import Link from 'next/link'
import { brandStory, conceptHeroImage, heroCover } from '../../lib/concept'
import type { SectionProps } from '../types'
import { color, link, list, safeSrc, str } from '../safe'
import { TEXT_SURFACE, brandHref, brandNameOf, fill, orLive } from './util'

/** brand.aboutHero — eyebrow, headline, long story. */
export function AboutHero({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  if (!concept) return null
  const name = brandNameOf(ctx)
  const story = brandStory(concept.slug)
  return (
    <section className="section" style={{ paddingTop: 'clamp(3rem, 7vw, 5rem)', background: color(fields.bg) ?? TEXT_SURFACE }}>
      <div className="container-narrow" style={{ textAlign: 'center' }}>
        <p style={{ color: color(fields.eyebrowColor) ?? 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
          {fill(fields.eyebrow, ctx, name)}
        </p>
        <h1 style={{ fontSize: 'clamp(2.25rem, 6vw, 4rem)', marginBottom: '1.25rem' }}>
          {orLive(fields.headline, story.tagline, ctx, name)}
        </h1>
        <p style={{ color: 'var(--servd-mute)', fontSize: 'clamp(1.05rem, 1.6vw, 1.2rem)', lineHeight: 1.6 }}>
          {orLive(fields.body, story.long, ctx, name)}
        </p>
      </div>
    </section>
  )
}

/** brand.pillars — a stack of heading + paragraph pairs. */
export function Pillars({ fields, ctx }: SectionProps) {
  const name = brandNameOf(ctx)
  const items = list<{ heading?: unknown; body?: unknown }>(fields.items)
  if (items.length === 0) return null
  return (
    <section className="section" style={{ background: color(fields.bg) ?? 'var(--servd-surface)' }}>
      <div className="container-narrow">
        <div style={{ display: 'grid', gap: '2.5rem' }}>
          {items.map((p, i) => (
            <div key={i}>
              <h2 style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.75rem)', marginBottom: '0.75rem' }}>{fill(p.heading, ctx, name)}</h2>
              <p style={{ color: 'var(--servd-mute)', fontSize: '1rem', lineHeight: 1.7 }}>{fill(p.body, ctx, name)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/** brand.imageBreak — a full-bleed band: the brand colour, plus its image.
 *  A described photo (alt text set) is a real <img>, so search engines and
 *  screen readers get it; without a description it is decoration, drawn as
 *  a background and hidden from both. */
export function ImageBreak({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const img = safeSrc(fields.image) || (concept ? conceptHeroImage(concept) : null)
  const bg = color(fields.bg) ?? concept?.primaryColor ?? 'var(--servd-green-dark)'
  const alt = str(fields.alt).trim()
  if (img && alt) {
    return (
      <section style={{ height: 'clamp(220px, 40vw, 420px)', background: bg, overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img} alt={fill(alt, ctx)} loading="lazy" decoding="async"
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }} />
      </section>
    )
  }
  return (
    <section style={{
      height: 'clamp(220px, 40vw, 420px)',
      background: `${bg}${heroCover(img)}`,
    }} aria-hidden="true" />
  )
}

/** brand.ctaBand — headline, line, and up to two buttons. */
export function CtaBand({ fields, ctx }: SectionProps) {
  const name = brandNameOf(ctx)
  const primary = link(fields.primary)
  const secondary = link(fields.secondary)
  const p = brandHref(primary.href, ctx)
  const s = brandHref(secondary.href, ctx)
  const body = fill(fields.body, ctx, name)
  return (
    <section className="section" style={{ textAlign: 'center', background: color(fields.bg) ?? TEXT_SURFACE }}>
      <div className="container-narrow">
        <h2 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.5rem)', marginBottom: '0.75rem' }}>
          {fill(fields.headline, ctx, name)}
        </h2>
        {str(body) && (
          <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem', maxWidth: '32rem', marginInline: 'auto' }}>
            {body}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          {p && primary.text && (
            <Link href={p.href} className="servd-btn-primary" style={{ padding: '1rem 2.25rem' }}
              {...(p.external && { target: '_blank', rel: 'noopener noreferrer' })}>
              {fill(primary.text, ctx, name)}
            </Link>
          )}
          {s && secondary.text && (
            <Link href={s.href} className="servd-btn-secondary" style={{ padding: '1rem 2rem' }}
              {...(s.external && { target: '_blank', rel: 'noopener noreferrer' })}>
              {fill(secondary.text, ctx, name)}
            </Link>
          )}
        </div>
      </div>
    </section>
  )
}
