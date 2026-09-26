// flipd — the menu, as its own page (/brand/flipd/menu).
//
// This is the READ-ONLY menu: what we serve and what it costs. Ordering lives
// at /flipd, which is the same data plus a basket. Both read the same API
// (`/storefront/flipd/menu`), so there is one menu in the system and the admin
// is the only place it is edited. Nothing here is hardcoded — an item renamed
// in admin is renamed here on the next request.
//
// Built to the brand book like the landing page: mustard field, Flipd Blue
// marks, navy/bone checker as the rule, bone panels so long lists stay
// readable. Voice rule is "names the ingredient, skips the adjective", so the
// item's description is printed as-is and nothing is written around it.

'use client'

import Link from 'next/link'

export interface FlipdModifier {
  id: string
  name: string
  priceDeltaCents?: number
}
export interface FlipdModifierGroup {
  id: string
  name: string
  modifiers?: FlipdModifier[]
}
export interface FlipdMenuItemLive {
  id: string
  name: string
  description: string | null
  priceCents: number
  isAvailable?: boolean
  modifierGroups?: FlipdModifierGroup[]
}
export interface FlipdMenuCategoryLive {
  id: string
  name: string
  items: FlipdMenuItemLive[]
}

interface Props {
  slug: string
  conceptName: string
  categories: FlipdMenuCategoryLive[]
}

function Checker() {
  return <div aria-hidden className="flipd-checker" />
}

const fmtPkr = (cents: number) =>
  `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export function FlipdMenuPage({ slug, conceptName, categories }: Props) {
  // A category with no items is a draft as far as a customer is concerned —
  // don't print an empty heading at them.
  const shown = categories.filter((c) => (c.items?.length ?? 0) > 0)

  return (
    <div className="flipd-page">
      <Checker />

      {/* ── HEADER ─────────────────────────────────────────────────────────
          No badge here. It carries the landing page; repeating it at the top
          of every sub-page is decoration, and the book asks for restraint. */}
      <section style={{ padding: 'clamp(2.5rem, 7vh, 4rem) clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 4vh, 2.5rem)' }}>
        <div style={{ maxWidth: '62rem', margin: '0 auto' }}>
          <span className="flipd-eyebrow">The menu</span>
          <h1
            className="flipd-display"
            style={{ fontSize: 'clamp(2rem, 5.5vw, 3.4rem)', margin: '0.6rem 0 0' }}
          >
            Built to spec.
          </h1>
          <p
            style={{
              fontSize: '1rem',
              lineHeight: 1.65,
              color: 'var(--flipd-blue-dim)',
              maxWidth: '48ch',
              margin: '1rem 0 0',
            }}
          >
            Every burger on a fixed build. Prices and what&rsquo;s on today come
            straight from the kitchen&rsquo;s own list.
          </p>

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link href={`/${slug}`} className="flipd-btn">Order now</Link>
            <Link href={`/brand/${slug}`} className="flipd-btn flipd-btn-ghost">Back to {conceptName}</Link>
          </div>
        </div>
      </section>

      {/* Section jump-list. Only worth its space once there's more than one. */}
      {shown.length > 1 && (
        <nav
          aria-label="Menu sections"
          className="no-scrollbar"
          style={{
            display: 'flex',
            gap: '0.5rem',
            overflowX: 'auto',
            padding: '0 clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 4vh, 2.5rem)',
            maxWidth: '68rem',
            margin: '0 auto',
          }}
        >
          {shown.map((c) => (
            <a key={c.id} href={`#cat-${c.id}`} className="flipd-chip" style={{ whiteSpace: 'nowrap', textDecoration: 'none' }}>
              {c.name}
            </a>
          ))}
        </nav>
      )}

      <Checker />

      {shown.length === 0 ? (
        // The API answered but there is nothing published. Say so plainly and
        // send them somewhere useful rather than printing an empty page.
        <section style={{ padding: 'clamp(3rem, 9vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div className="flipd-panel" style={{ maxWidth: '40rem', margin: '0 auto', padding: 'clamp(2rem, 5vw, 3rem)', textAlign: 'center' }}>
            <h2 className="flipd-display" style={{ fontSize: '1.5rem', margin: '0 0 0.6rem' }}>
              The menu isn&rsquo;t up yet.
            </h2>
            <p style={{ color: 'var(--flipd-blue-dim)', margin: '0 0 1.5rem', fontSize: '0.95rem' }}>
              Call the counter and we&rsquo;ll tell you what&rsquo;s on.
            </p>
            <Link href={`/${slug}`} className="flipd-btn">Go to ordering</Link>
          </div>
        </section>
      ) : (
        <section style={{ padding: 'clamp(2.5rem, 7vh, 4rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div style={{ maxWidth: '68rem', margin: '0 auto', display: 'grid', gap: 'clamp(1.25rem, 3vw, 2rem)' }}>
            {shown.map((cat) => (
              <div
                key={cat.id}
                id={`cat-${cat.id}`}
                className="flipd-panel"
                style={{ padding: 'clamp(1.5rem, 3.5vw, 2.25rem)', scrollMarginTop: '7rem' }}
              >
                <h2 className="flipd-display" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', margin: '0 0 0.25rem' }}>
                  {cat.name}
                </h2>

                <div style={{ marginTop: '1rem' }}>
                  {cat.items.map((item) => {
                    const soldOut = item.isAvailable === false
                    // Modifier names are the "Single / Double / Lettuce wrap"
                    // style choices. They're the operator's own words from
                    // admin, printed flat — not restyled per option.
                    const options = (item.modifierGroups ?? [])
                      .flatMap((g) => (g.modifiers ?? []).map((m) => m.name))
                      .filter(Boolean)

                    return (
                      <div
                        key={item.id}
                        className="flipd-item"
                        style={{ padding: '0.95rem 0', opacity: soldOut ? 0.45 : 1 }}
                      >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', justifyContent: 'space-between' }}>
                          {/* A level-3 heading under the category's h2, so a
                              screen reader can step item to item. Stays a <p>
                              so no heading styles leak into the look. */}
                          <p className="flipd-item-name" role="heading" aria-level={3} style={{ margin: 0 }}>
                            {item.name}
                            {/* The visible gap is a margin, so without this a
                                screen reader runs the two together. */}
                            {soldOut && <span className="sr-only">, </span>}
                            {soldOut && (
                              <span
                                style={{
                                  marginLeft: '0.6rem',
                                  fontSize: '0.64rem',
                                  fontWeight: 700,
                                  letterSpacing: '0.16em',
                                  textTransform: 'uppercase',
                                  color: 'var(--flipd-blue-faint)',
                                }}
                              >
                                Sold out
                              </span>
                            )}
                          </p>
                          <p
                            style={{
                              margin: 0,
                              whiteSpace: 'nowrap',
                              fontWeight: 700,
                              fontSize: '0.95rem',
                              color: 'var(--flipd-blue)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {fmtPkr(item.priceCents)}
                          </p>
                        </div>

                        {item.description && (
                          <p className="flipd-item-build" style={{ margin: '0.3rem 0 0' }}>
                            {item.description}
                          </p>
                        )}

                        {options.length > 0 && (
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                            {options.map((o) => (
                              <span key={o} className="flipd-chip">{o}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Checker />

      <section style={{ padding: 'clamp(2.5rem, 7vh, 4rem) clamp(1.5rem, 5vw, 3rem)', textAlign: 'center' }}>
        <h2 className="flipd-display" style={{ fontSize: 'clamp(1.5rem, 3.5vw, 2.25rem)', margin: '0 0 1.5rem' }}>
          Same burger, every time.
        </h2>
        <Link href={`/${slug}`} className="flipd-btn">Order now</Link>
      </section>

      <Checker />
    </div>
  )
}
