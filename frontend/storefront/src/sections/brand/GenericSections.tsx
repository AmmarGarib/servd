// The rest of the generic brand home (`brand:*`): signature dishes, story,
// reviews, cross-brand strip, first-order CTA. Each paints its own surface
// (white, servd ink) since the brand shell behind it can be dark.

import { brandStory } from '../../lib/concept'
import { CrossBrandStrip } from '../../components/brand/parts/CrossBrandStrip'
import { BottomCTA } from '../../components/brand/parts/BottomCTA'
import type { SectionProps } from '../types'
import { color, link, list, safeSrc, str } from '../safe'
import { brandHref, brandNameOf, fill, orLive } from './util'

const eyebrowStyle = (accent: string, center = false): React.CSSProperties => ({
  color: accent, fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase',
  marginBottom: '0.5rem', ...(center && { textAlign: 'center' }),
})

function accentOf(fields: Record<string, unknown>, ctx: SectionProps['ctx']): string {
  return color(fields.accent) ?? (ctx.concept?.primaryColor || 'var(--servd-green-dark)')
}

/** brand.signatures — a row of signature-dish cards. */
export function Signatures({ fields, ctx }: SectionProps) {
  const name = brandNameOf(ctx)
  const t = (v: unknown) => fill(v, ctx, name)
  const accent = accentOf(fields, ctx)
  const items = list<{ name?: unknown; price?: unknown; note?: unknown; image?: unknown; alt?: unknown }>(fields.items)
  return (
    <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)', background: color(fields.bg) ?? '#fff', color: 'var(--servd-ink)' }}>
      <div className="container">
        {str(fields.eyebrow) && <p style={eyebrowStyle(accent)}>{t(fields.eyebrow)}</p>}
        <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', letterSpacing: '-0.02em', marginBottom: '2rem' }}>
          {t(fields.heading)}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
          {items.map((d, i) => {
            const dish = t(d.name)
            const img = safeSrc(d.image)
            // A described photo is a real <img> (Google Images, screen
            // readers); an undescribed one stays a decorative background.
            const alt = t(d.alt).trim()
            const photo = img && alt
            return (
              <div key={i} className="servd-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div {...(!photo && { 'aria-hidden': true })} style={{
                  aspectRatio: '4/3',
                  background: img
                    ? (photo ? undefined : `url(${img}) center/cover`)
                    : `linear-gradient(135deg, ${accent} 0%, color-mix(in srgb, ${accent} 80%, transparent) 100%)`,
                  display: 'grid', placeItems: 'center', fontSize: '4rem',
                  ...(photo && { position: 'relative', overflow: 'hidden' }),
                }}>
                  {photo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={alt} loading="lazy" decoding="async"
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }} />
                  )}
                  {/* No photo yet: the dish's initial, never an emoji. */}
                  {!img && (
                    <span aria-hidden="true" style={{ fontFamily: 'var(--font-display)', fontWeight: 900, color: 'rgba(255,255,255,0.9)', lineHeight: 1 }}>
                      {dish.charAt(0)}
                    </span>
                  )}
                </div>
                <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '-0.01em' }}>{dish}</h3>
                    {str(d.price) && <p style={{ fontSize: '1rem', fontWeight: 800, color: accent, whiteSpace: 'nowrap' }}>{t(d.price)}</p>}
                  </div>
                  {str(d.note) && <p style={{ color: 'var(--servd-mute)', fontSize: '0.88rem', lineHeight: 1.45 }}>{t(d.note)}</p>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/** brand.story — eyebrow, heading, the brand's long story, a closing line. */
export function Story({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const name = brandNameOf(ctx)
  const t = (v: unknown) => fill(v, ctx, name)
  const accent = accentOf(fields, ctx)
  const story = brandStory(concept?.slug ?? '')
  return (
    <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)', background: color(fields.bg) ?? '#fafaf9', color: 'var(--servd-ink)' }}>
      <div className="container" style={{ maxWidth: '46rem' }}>
        {str(fields.eyebrow) && <p style={eyebrowStyle(accent)}>{t(fields.eyebrow)}</p>}
        <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', letterSpacing: '-0.02em', marginBottom: '1.25rem' }}>
          {t(fields.heading)}
        </h2>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6 }}>
          {orLive(fields.body, story.long, ctx, name)}
        </p>
        {str(fields.note) && (
          <p style={{ fontSize: '1rem', lineHeight: 1.6, color: 'var(--servd-mute)', marginTop: '1rem' }}>
            {t(fields.note)}
          </p>
        )}
      </div>
    </section>
  )
}

/** brand.reviews — rating headline and review cards. */
export function Reviews({ fields, ctx }: SectionProps) {
  const name = brandNameOf(ctx)
  const t = (v: unknown) => fill(v, ctx, name)
  const accent = accentOf(fields, ctx)
  const stars = color(fields.starColor) ?? '#f59e0b'
  const items = list<{ text?: unknown; name?: unknown; area?: unknown }>(fields.items)
  return (
    <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)', background: color(fields.bg) ?? '#fff', color: 'var(--servd-ink)' }}>
      <div className="container">
        {str(fields.eyebrow) && <p style={eyebrowStyle(accent, true)}>{t(fields.eyebrow)}</p>}
        <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', letterSpacing: '-0.02em', textAlign: 'center', marginBottom: '2.5rem' }}>
          {str(fields.headingAccent) && <span style={{ color: accent }}>{t(fields.headingAccent)}</span>}
          {str(fields.headingAccent) && str(fields.heading) ? ' ' : ''}{t(fields.heading)}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
          {items.map((r, i) => {
            const who = t(r.name)
            return (
              <div key={i} className="servd-card" style={{ padding: '1.75rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ color: stars, letterSpacing: '0.1em', fontSize: '0.95rem' }} aria-label="5 out of 5 stars">★★★★★</div>
                <p style={{ fontSize: '0.97rem', lineHeight: 1.55 }}>{t(r.text)}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                  <div style={{ width: '2.2rem', height: '2.2rem', borderRadius: '50%', background: `color-mix(in srgb, ${accent} 13.3%, transparent)`, color: accent, fontWeight: 800, display: 'grid', placeItems: 'center', fontSize: '0.85rem' }}>
                    {who.charAt(0)}
                  </div>
                  <div>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700 }}>{who}</p>
                    <p style={{ fontSize: '0.78rem', color: 'var(--servd-mute)' }}>{t(r.area)}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/** brand.crossBrand — the company's other brands (same company only). */
export function CrossBrand({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  if (!concept) return null
  const name = brandNameOf(ctx)
  const t = (v: unknown) => fill(v, ctx, name)
  const all = link(fields.allLink)
  return (
    <div style={{ background: color(fields.bg) ?? '#fff', color: 'var(--servd-ink)' }}>
      <CrossBrandStrip
        onBrandHost={!!ctx.onBrandHost}
        current={concept}
        concepts={ctx.concepts}
        accent={accentOf(fields, ctx)}
        kicker={t(fields.kicker)}
        heading={t(fields.heading)}
        subtitle={t(fields.subtitle)}
        allLabel={t(all.text)}
        allHref={brandHref(all.href, ctx)?.href ?? '/home#kitchens'}
        cardCta={str(fields.cardCta)}
      />
    </div>
  )
}

/** brand.bottomCta — the first-order promo band. */
export function BottomCta({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  if (!concept) return null
  const name = brandNameOf(ctx)
  const t = (v: unknown) => fill(v, ctx, name)
  const button = link(fields.button)
  const to = brandHref(button.href, ctx)
  return (
    <div style={{ background: '#fff', color: 'var(--servd-ink)' }}>
      <BottomCTA
        brandName={name}
        brandSlug={concept.slug}
        accent={accentOf(fields, ctx)}
        eyebrow={t(fields.eyebrow)}
        headline={t(fields.headline)}
        headlineAccent={t(fields.headlineAccent)}
        headlineTail={t(fields.headlineTail)}
        bodyBefore={t(fields.bodyBefore)}
        code={t(fields.code)}
        bodyAfter={t(fields.bodyAfter)}
        buttonText={to ? t(button.text) : ''}
        {...(to && { buttonHref: to.href })}
      />
    </div>
  )
}
