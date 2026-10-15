// servd.faq — questions and answers as native <details> (works with no
// JavaScript, every answer is in the HTML) plus the FAQPage JSON-LD built from
// the SAME fields, so what Google reads is exactly what a visitor can open.
// Hidden items (empty question or answer) are left out of both.

import type { SectionProps } from '../types'
import { lines, str } from '../safe'
import { faqSchema, jsonLdScript } from '../../lib/jsonLd'
import { faqItemsOf } from './faqData'

export function Faq({ fields }: SectionProps) {
  const items = faqItemsOf(fields.items)
  if (!items.length) return null
  const heading = str(fields.heading)
  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(3rem, 6vw, 5rem)' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqSchema(items)) }} />
      <div className="container" style={{ maxWidth: '52rem' }}>
        {heading && <h2 className="display" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', margin: '0 0 1rem' }}>{heading}</h2>}
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {items.map((it, i) => (
            <details key={i} className="servd-card" open={fields.openFirst === true && i === 0} style={{ padding: '1rem 1.25rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.4 }}>{it.question}</summary>
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.98rem', lineHeight: 1.65, margin: '0.75rem 0 0' }}>
                {lines(it.answer).map((l, j) => <span key={j}>{j > 0 && <br />}{l}</span>)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
