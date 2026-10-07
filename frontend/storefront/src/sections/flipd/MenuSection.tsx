// flipd.menu — the menu, as its own page (/brand/flipd/menu). Ported from
// components/brand/layouts/FlipdMenuPage.tsx.
//
// This is the READ-ONLY menu: what we serve and what it costs. Ordering lives
// at /flipd, which is the same data plus a basket. Both read the same API, so
// there is one menu in the system and admin → Menu is the only place items are
// edited. The page's own copy (headings, buttons, empty state) is fields.
//
// Built to the brand book: mustard field, Flipd Blue marks, navy/bone checker
// as the rule, bone panels so long lists stay readable. Voice rule is "names
// the ingredient, skips the adjective", so the item's description is printed
// as-is and nothing is written around it.

import Link from 'next/link'
import { formatBrandName } from '../../lib/concept'
import { fetchBrandMenu, pkr } from '../data'
import type { SectionProps } from '../types'
import { safeHref, str, link } from '../safe'

function Checker() {
  return <div aria-hidden className="flipd-checker" />
}

export async function FlipdMenuSection({ fields, ctx }: SectionProps) {
  const slug = ctx.concept?.slug ?? 'flipd'
  const brandName = formatBrandName(ctx.concept?.name ?? slug)
  const categories = await fetchBrandMenu(slug)
  // A category with no items is a draft as far as a customer is concerned —
  // don't print an empty heading at them.
  const shown = categories.filter((c) => (c.items?.length ?? 0) > 0)

  const primary = link(fields.primary)
  const back = link(fields.back)
  const backText = back.text.trim() || `Back to ${brandName}`
  const emptyCta = link(fields.emptyCta)
  const closingCta = link(fields.closingCta)
  const soldOutLabel = str(fields.soldOut)
  const jumpNav = fields.jumpNav !== false

  return (
    <div className="flipd-page">
      <Checker />

      {/* No badge here. It carries the landing page; repeating it at the top
          of every sub-page is decoration, and the book asks for restraint. */}
      <section style={{ padding: 'clamp(2.5rem, 7vh, 4rem) clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 4vh, 2.5rem)' }}>
        <div style={{ maxWidth: '62rem', margin: '0 auto' }}>
          {str(fields.eyebrow) && <span className="flipd-eyebrow">{str(fields.eyebrow)}</span>}
          <h1 className="flipd-display" style={{ fontSize: 'clamp(2rem, 5.5vw, 3.4rem)', margin: '0.6rem 0 0' }}>
            {str(fields.headline)}
          </h1>
          {str(fields.intro) && (
            <p
              style={{
                fontSize: '1rem',
                lineHeight: 1.65,
                color: 'var(--flipd-blue-dim)',
                maxWidth: '48ch',
                margin: '1rem 0 0',
                whiteSpace: 'pre-line',
              }}
            >
              {str(fields.intro)}
            </p>
          )}

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {primary.text && <Link href={safeHref(primary.href, `/${slug}`)} className="flipd-btn">{primary.text}</Link>}
            <Link href={safeHref(back.href, `/brand/${slug}`)} className="flipd-btn flipd-btn-ghost">{backText}</Link>
          </div>
        </div>
      </section>

      {/* Section jump-list. Only worth its space once there's more than one. */}
      {jumpNav && shown.length > 1 && (
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
        // Nothing published (or the API is down). Say so plainly and send them
        // somewhere useful rather than printing an empty page.
        <section style={{ padding: 'clamp(3rem, 9vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div className="flipd-panel" style={{ maxWidth: '40rem', margin: '0 auto', padding: 'clamp(2rem, 5vw, 3rem)', textAlign: 'center' }}>
            <h2 className="flipd-display" style={{ fontSize: '1.5rem', margin: '0 0 0.6rem' }}>
              {str(fields.emptyHeadline)}
            </h2>
            {str(fields.emptyBody) && (
              <p style={{ color: 'var(--flipd-blue-dim)', margin: '0 0 1.5rem', fontSize: '0.95rem' }}>
                {str(fields.emptyBody)}
              </p>
            )}
            {emptyCta.text && <Link href={safeHref(emptyCta.href, `/${slug}`)} className="flipd-btn">{emptyCta.text}</Link>}
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
                    // style choices — the operator's own words, printed flat.
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
                          <p className="flipd-item-name" style={{ margin: 0 }}>
                            {item.name}
                            {soldOut && soldOutLabel && (
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
                                {soldOutLabel}
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
                            {pkr(item.priceCents)}
                          </p>
                        </div>

                        {item.description && (
                          <p className="flipd-item-build" style={{ margin: '0.3rem 0 0' }}>
                            {item.description}
                          </p>
                        )}

                        {options.length > 0 && (
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                            {options.map((o, i) => (
                              <span key={`${o}-${i}`} className="flipd-chip">{o}</span>
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
          {str(fields.closingHeadline)}
        </h2>
        {closingCta.text && <Link href={safeHref(closingCta.href, `/${slug}`)} className="flipd-btn">{closingCta.text}</Link>}
      </section>

      <Checker />
    </div>
  )
}
