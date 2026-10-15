// servd.aboutIntro — the "what is servd" answer, first: an H1, two or three
// plain factual sentences (the paragraph search engines and AI tools quote),
// then a table of the kitchens built from the LIVE brand records (cuisine,
// area, price range, hours, ordering link). Anything a brand has not filled in
// shows a dash — never invented. {brands} in the intro = the live kitchen
// names ("Simmer, Stackd and Flipd"), {count} = how many.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { brandCanonical } from '../../lib/brandDomains'
import { filled, locationFromConcept } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import { isServdCompanyBrand } from '../../lib/liveConcepts'
import type { SectionProps } from '../types'
import { str } from '../safe'
import { hoursSummary, priceWords } from './brandFacts'

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const th: CSSProperties = { textAlign: 'left', padding: '0.75rem 1rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--servd-mute)', borderBottom: '1px solid var(--servd-line, rgba(38,16,56,0.12))', whiteSpace: 'nowrap' }
const td: CSSProperties = { padding: '0.85rem 1rem', fontSize: '0.95rem', verticalAlign: 'top', borderBottom: '1px solid var(--servd-line, rgba(38,16,56,0.08))' }

export function AboutIntro({ fields, ctx }: SectionProps) {
  const rows = ctx.concepts
    .filter((c) => !c.isTestCompany && isServdCompanyBrand(c.slug, ctx.concepts))
    .map((c) => {
      const loc = locationFromConcept(c)
      return {
        slug: c.slug,
        name: formatBrandName(c.name),
        cuisine: filled(loc.cuisine),
        area: [filled(loc.area), filled(loc.city)].filter(Boolean).join(', '),
        price: filled(loc.priceRange) ? priceWords(loc.priceRange) : '',
        hours: hoursSummary(c.serviceHours),
      }
    })
  const names = listNames(rows.map((r) => r.name))
  const intro = str(fields.intro).replace(/\{brands\}/g, names).replace(/\{count\}/g, String(rows.length))
  const showTable = fields.showTable !== false && rows.length > 0
  const dash = str(fields.emptyText) || '—'
  const heading = str(fields.heading)

  return (
    <section className="section" style={{ paddingTop: 'clamp(4rem, 9vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
      <div className="container">
        {str(fields.eyebrow) && <p className="eyebrow eyebrow-accent">{str(fields.eyebrow)}</p>}
        {heading && (
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1.25rem', letterSpacing: '-0.04em' }}>
            {heading}
          </h1>
        )}
        {intro && (
          <p data-speakable="about" style={{ color: 'var(--servd-ink)', fontSize: '1.15rem', maxWidth: '44rem', lineHeight: 1.6, marginBottom: '2rem' }}>
            {intro}
          </p>
        )}
        {showTable && (
          <div>
            {str(fields.tableHeading) && <h2 className="display" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', margin: '0 0 1rem' }}>{str(fields.tableHeading)}</h2>}
            <div className="servd-card sv-hard-card" style={{ padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '44rem' }}>
                <thead>
                  <tr>
                    <th scope="col" style={th}>{str(fields.colKitchen) || 'Kitchen'}</th>
                    <th scope="col" style={th}>{str(fields.colCuisine) || 'Cuisine'}</th>
                    <th scope="col" style={th}>{str(fields.colArea) || 'Area'}</th>
                    <th scope="col" style={th}>{str(fields.colPrice) || 'Price range'}</th>
                    <th scope="col" style={th}>{str(fields.colHours) || 'Hours'}</th>
                    <th scope="col" style={th}>{str(fields.colOrder) || 'Order'}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.slug}>
                      <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 700 }}>
                        <a href={brandCanonical(r.slug)} style={{ color: 'inherit' }}>{r.name}</a>
                      </th>
                      <td style={td}>{r.cuisine || dash}</td>
                      <td style={td}>{r.area || dash}</td>
                      <td style={td}>{r.price || dash}</td>
                      <td style={td}>{r.hours || dash}</td>
                      <td style={td}>
                        <Link href={`/${r.slug}`} style={{ color: 'var(--servd-purple)', fontWeight: 600 }}>
                          {str(fields.orderText) || 'Order'} <span className="sr-only">{r.name}</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {str(fields.note) && <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginTop: '0.75rem', maxWidth: '44rem' }}>{str(fields.note)}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
