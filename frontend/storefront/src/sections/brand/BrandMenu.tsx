// brand.menu — the generic brand menu page (`brand:*:menu`): header, sticky
// category nav, item cards, bottom CTA. Items, prices, photos and
// availability are live (the brand's published menu); the words around them
// are fields. Brands with a bespoke menu (simmer.menu, flipd.menu) register
// their own default for `brand:<slug>:menu`.

import Link from 'next/link'
import type { SectionProps } from '../types'
import { color, link, str } from '../safe'
import { fetchBrandMenu, pkr, type MenuCategory } from '../data'
import { brandHref, brandNameOf, fill } from './util'

export async function BrandMenu({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  if (!concept) return null
  const categories = await fetchBrandMenu(concept.slug)
  return <BrandMenuView fields={fields} ctx={ctx} categories={categories} />
}

/** The generic menu layout for already-fetched categories (other groups'
 *  menu sections can fall back to it). */
export function BrandMenuView({ fields, ctx, categories }: Omit<SectionProps, 'id'> & { categories: MenuCategory[] }) {
  const name = brandNameOf(ctx)
  const cta = link(fields.cta)
  const ctaTo = brandHref(cta.href, ctx)
  const emptyCta = link(fields.emptyCta)
  const emptyTo = brandHref(emptyCta.href, ctx)
  const bottomCta = link(fields.bottomCta)
  const bottomTo = brandHref(bottomCta.href, ctx)
  const t = (v: unknown) => fill(v, ctx, name)

  return (
    <div style={{ background: color(fields.bg) ?? 'white' }}>
      {/* Page header */}
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)', paddingBottom: '1.5rem' }}>
        <div className="container">
          {str(fields.eyebrow) && (
            <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              {t(fields.eyebrow)}
            </p>
          )}
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', marginBottom: '0.5rem' }}>
            {t(fields.headline)}
          </h1>
          {str(fields.body) && (
            <p style={{ color: 'var(--servd-mute)', fontSize: '1rem', maxWidth: '36rem' }}>
              {t(fields.body)}
            </p>
          )}
          {ctaTo && cta.text && (
            <Link href={ctaTo.href} className="servd-btn-primary" style={{ marginTop: '1.5rem', padding: '0.85rem 1.75rem' }}>
              {t(cta.text)}
            </Link>
          )}
        </div>
      </section>

      {/* Sticky category nav */}
      {categories.length > 1 && (
        <nav
          aria-label="Menu sections"
          className="no-scrollbar"
          style={{
            position: 'sticky',
            top: '60px',
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            borderBottom: '1px solid var(--servd-line)',
            zIndex: 40,
            display: 'flex',
            gap: '0.25rem',
            overflowX: 'auto',
            padding: '0.5rem clamp(1rem, 4vw, 2rem)',
          }}
        >
          {categories.map((c) => (
            <a
              key={c.id}
              href={`#cat-${c.id}`}
              style={{
                whiteSpace: 'nowrap',
                padding: '0.45rem 0.85rem',
                fontWeight: 600,
                fontSize: '0.875rem',
                color: 'var(--servd-mute)',
                textDecoration: 'none',
                borderRadius: '999px',
              }}
            >
              {c.name}
            </a>
          ))}
        </nav>
      )}

      {categories.length === 0 ? (
        <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
          <p style={{ color: 'var(--servd-mute)' }}>{t(fields.emptyText)}</p>
          {emptyTo && emptyCta.text && (
            <Link href={emptyTo.href} className="servd-btn-primary" style={{ marginTop: '1rem' }}>
              {t(emptyCta.text)}
            </Link>
          )}
        </div>
      ) : (
        <div className="container" style={{ padding: 'clamp(2rem, 5vw, 3rem) 0', display: 'grid', gap: '3rem' }}>
          {categories.map((cat) => (
            <section key={cat.id} id={`cat-${cat.id}`} style={{ scrollMarginTop: '120px' }}>
              <h2 style={{ fontSize: 'clamp(1.4rem, 3vw, 1.85rem)', marginBottom: '1.5rem' }}>{cat.name}</h2>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '1.25rem',
              }}>
                {(cat.items ?? []).map((item) => (
                  <article key={item.id} className="servd-card" style={{ display: 'flex', flexDirection: 'column', opacity: item.isAvailable === false ? 0.5 : 1 }}>
                    {/* Media tile — video when set (muted + playsInline for
                        mobile autoplay), else the still, else a soft wash.
                        The still is a real <img> named for the dish, so dish
                        photos are found in image search. */}
                    <div style={{
                      aspectRatio: '4/3',
                      position: 'relative',
                      overflow: 'hidden',
                      ...(!item.imageUrl && { background: `linear-gradient(135deg, var(--servd-green-soft) 0%, white 100%)` }),
                    }}>
                      {item.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
                        />
                      )}
                      {item.videoUrl && (
                        <video
                          src={item.videoUrl}
                          {...(item.imageUrl ? { poster: item.imageUrl } : {})}
                          autoPlay muted loop playsInline preload="metadata"
                          aria-hidden="true"
                          style={{
                            position: 'absolute', inset: 0,
                            width: '100%', height: '100%',
                            objectFit: 'cover',
                          }}
                        />
                      )}
                      {item.isAvailable === false && (
                        <span style={{
                          position: 'absolute', top: '0.7rem', left: '0.7rem',
                          background: 'rgba(0,0,0,0.7)', color: 'white',
                          fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                          padding: '0.25rem 0.6rem', borderRadius: '999px',
                          zIndex: 1,
                        }}>
                          {t(fields.soldOutLabel)}
                        </span>
                      )}
                    </div>
                    <div style={{ padding: '1.1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                      <h3 style={{ fontSize: '1rem' }}>{item.name}</h3>
                      {item.description && (
                        <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', lineHeight: 1.4, flex: 1 }}>
                          {item.description}
                        </p>
                      )}
                      <p style={{ fontWeight: 800, color: 'var(--servd-green-dark)', marginTop: '0.5rem' }}>
                        {pkr(item.priceCents)}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Bottom CTA */}
      {(str(fields.bottomHeadline) || str(fields.bottomBody) || (bottomTo && bottomCta.text)) && (
        <section style={{ padding: 'clamp(3rem, 6vw, 5rem) 0', textAlign: 'center', background: color(fields.bottomBg) ?? 'var(--servd-surface)' }}>
          <div className="container">
            {str(fields.bottomHeadline) && (
              <h2 style={{ fontSize: 'clamp(1.5rem, 3.5vw, 2.25rem)', marginBottom: '0.75rem' }}>{t(fields.bottomHeadline)}</h2>
            )}
            {str(fields.bottomBody) && (
              <p style={{ color: 'var(--servd-mute)', marginBottom: '1.75rem' }}>{t(fields.bottomBody)}</p>
            )}
            {bottomTo && bottomCta.text && (
              <Link href={bottomTo.href} className="servd-btn-primary" style={{ padding: '1rem 2.25rem', fontSize: '1rem' }}>
                {t(bottomCta.text)}
              </Link>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
