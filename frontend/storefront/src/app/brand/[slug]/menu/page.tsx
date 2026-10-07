import Link from 'next/link'
import { notFound } from 'next/navigation'
import { formatBrandName, type Concept } from '../../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../../lib/fallbackBrands'
import { SimmerMenu } from '../../../../components/brand/layouts/SimmerMenu'
import { FlipdMenuPage } from '../../../../components/brand/layouts/FlipdMenuPage'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// Force-dynamic + no-store so a single bad fetch at first request
// doesn't get baked into the ISR cache for the next 60s.
export const dynamic = 'force-dynamic'

interface ModifierGroup {
  id: string
  name: string
  modifiers?: { id: string; name: string; priceDeltaCents?: number }[]
}
interface MenuItem {
  id: string; name: string; description: string | null; priceCents: number
  imageUrl: string | null
  videoUrl: string | null
  isAvailable?: boolean
  // The API returns these; the generic layout ignores them but the flipd
  // layout prints them as the item's options (Single / Double / Lettuce wrap).
  modifierGroups?: ModifierGroup[]
}
interface MenuCategory { id: string; name: string; items: MenuItem[] }

async function getData(slug: string): Promise<{ concept: Concept, categories: MenuCategory[] } | null> {
  // Find the concept (live or fallback).
  let concept: Concept | undefined
  try {
    const conceptsRes = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (conceptsRes.ok) {
      const live: Concept[] = await conceptsRes.json()
      concept = live.find((c) => c.slug === slug)
    }
  } catch { /* swallow — fall through to fallback */ }
  if (!concept) concept = FALLBACK_CONCEPTS[slug]
  if (!concept) return null

  // Try to load real categories. Backend may return either a bare
  // array (legacy shape) or `{ concept, categories: [...] }` (current
  // shape) — handle both so a server-side migration doesn't break
  // this page silently.
  let categories: MenuCategory[] = []
  try {
    const menuRes = await fetch(`${API_URL}/api/v1/storefront/${slug}/menu`, { cache: 'no-store' })
    if (menuRes.ok) {
      const payload = await menuRes.json() as MenuCategory[] | { categories?: MenuCategory[] }
      categories = Array.isArray(payload) ? payload : (payload.categories ?? [])
    }
  } catch { /* swallow */ }

  return { concept, categories }
}

export default async function BrandMenuPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const data = await getData(slug)
  if (!data) notFound()
  const { concept, categories } = data
  const fmt = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

  // A "published menu" requires at least one item somewhere — a
  // category list with all empty `items[]` is still a draft as far as
  // the customer is concerned.
  const hasAnyItems = categories.some((c) => (c.items?.length ?? 0) > 0)

  // Simmer-branded surface: when the slug is `simmer` AND there's no
  // published menu yet, render the placeholder in the brand's own
  // typography + palette. Once the operator publishes a menu, the
  // page drops through to the generic table-style layout below so
  // pricing and availability stay accurate.
  if (slug === 'simmer' && !hasAnyItems) {
    return <SimmerMenu slug={concept.slug} conceptName={formatBrandName(concept.name)} />
  }

  // flipd renders its menu in its own brand chrome whether or not anything is
  // published — unlike simmer's, this layout is driven entirely by the live
  // categories and has its own empty state, so there is no point dropping to
  // the generic white table once a menu exists.
  if (slug === 'flipd') {
    return (
      <FlipdMenuPage
        slug={concept.slug}
        conceptName={formatBrandName(concept.name)}
        categories={categories}
      />
    )
  }

  return (
    <div style={{ background: 'white' }}>
      {/* Page header */}
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)', paddingBottom: '1.5rem' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            Menu
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', marginBottom: '0.5rem' }}>
            Everything {formatBrandName(concept.name)} serves.
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1rem', maxWidth: '36rem' }}>
            Browse the full menu. Tap Order to start a basket — your selection follows you into checkout.
          </p>
          <Link href={`/${concept.slug}`} className="servd-btn-primary" style={{ marginTop: '1.5rem', padding: '0.85rem 1.75rem' }}>
            Start ordering →
          </Link>
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
          <p style={{ color: 'var(--servd-mute)' }}>Menu&rsquo;s not loaded yet — try the order page.</p>
          <Link href={`/${concept.slug}`} className="servd-btn-primary" style={{ marginTop: '1rem' }}>
            Go to ordering
          </Link>
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
                {cat.items.map((item) => (
                  <article key={item.id} className="servd-card" style={{ display: 'flex', flexDirection: 'column', opacity: item.isAvailable === false ? 0.5 : 1 }}>
                    {/* Media tile — prefer video when the operator's set
                        one, fall back to the still image, then to a
                        gradient placeholder. Videos auto-play silently
                        in a loop; the muted + playsInline combo is
                        what mobile Safari requires for autoplay. */}
                    <div style={{
                      aspectRatio: '4/3',
                      position: 'relative',
                      overflow: 'hidden',
                      background: item.imageUrl
                        ? `url(${item.imageUrl}) center/cover`
                        : `linear-gradient(135deg, var(--servd-green-soft) 0%, white 100%)`,
                    }}>
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
                          Sold out
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
                        {fmt(item.priceCents)}
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
      <section style={{ padding: 'clamp(3rem, 6vw, 5rem) 0', textAlign: 'center', background: 'var(--servd-surface)' }}>
        <div className="container">
          <h2 style={{ fontSize: 'clamp(1.5rem, 3.5vw, 2.25rem)', marginBottom: '0.75rem' }}>Hungry yet?</h2>
          <p style={{ color: 'var(--servd-mute)', marginBottom: '1.75rem' }}>Build your order in two taps.</p>
          <Link href={`/${concept.slug}`} className="servd-btn-primary" style={{ padding: '1rem 2.25rem', fontSize: '1rem' }}>
            Start ordering →
          </Link>
        </div>
      </section>
    </div>
  )
}
