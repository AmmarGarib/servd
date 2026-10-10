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

import { formatBrandName } from '../../lib/concept'
import { fetchBrandMenu, pkr } from '../data'
import type { SectionProps } from '../types'
import { str, link } from '../safe'
import { FlipdLink, flipdHref } from './links'
import { fill } from '../brand/util'

function Checker() {
  return <div aria-hidden className="flipd-checker" />
}

export async function FlipdMenuSection({ fields, ctx }: SectionProps) {
  const slug = ctx.concept?.slug ?? 'flipd'
  const brandName = formatBrandName(ctx.concept?.name ?? slug)
  // An unfilled placeholder (no brand in context) is dropped, never read out.
  const lead = fill(fields.headingLead, ctx, brandName).trim()
  const headingLead = lead.includes('{{') ? '' : lead
  const categories = await fetchBrandMenu(slug)
  // A category with no items is a draft as far as a customer is concerned —
  // don't print an empty heading at them.
  const shown = categories.filter((c) => (c.items?.length ?? 0) > 0)

  // Links follow the host (./links): Flipd's home is / on flipd.pk and
  // /brand/flipd on servd.pk; ordering is always servd's page. An empty href
  // falls back to the token; an unusable one hides the button.
  const primary = link(fields.primary)
  const primaryTo = primary.text ? flipdHref(primary.href, ctx, '@order') : null
  const back = link(fields.back)
  const backText = back.text.trim() || `Back to ${brandName}`
  const backTo = flipdHref(back.href, ctx, '@home')
  const emptyCta = link(fields.emptyCta)
  const emptyTo = emptyCta.text ? flipdHref(emptyCta.href, ctx, '@order') : null
  const closingCta = link(fields.closingCta)
  const closingTo = closingCta.text ? flipdHref(closingCta.href, ctx, '@order') : null
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
            {/* The heading names the brand for search engines and screen
                readers; the design shows only the line. */}
            {headingLead && <span className="sr-only">{headingLead} </span>}
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
            {primaryTo && <FlipdLink to={primaryTo} className="flipd-btn">{primary.text}</FlipdLink>}
            {backTo && <FlipdLink to={backTo} className="flipd-btn flipd-btn-ghost">{backText}</FlipdLink>}
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
            {emptyTo && <FlipdLink to={emptyTo} className="flipd-btn">{emptyCta.text}</FlipdLink>}
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
                          {/* The item is a heading under its category's h2
                              (page outline: h1 title → h2 category → h3
                              item). Weight and tracking are inherited as the
                              <p> it replaced had them: the global h1–h4 rule
                              would set 800 (a faux bold on the one-weight
                              display face) and tighten the letters. */}
                          <h3 className="flipd-item-name" style={{ margin: 0, fontWeight: 'inherit', letterSpacing: 'inherit' }}>
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
                          </h3>
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
        {closingTo && <FlipdLink to={closingTo} className="flipd-btn">{closingCta.text}</FlipdLink>}
      </section>

      <Checker />
    </div>
  )
}
