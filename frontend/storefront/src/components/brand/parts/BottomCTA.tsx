'use client'
import Link from 'next/link'

interface Props {
  brandName: string
  brandSlug: string
  accent: string
  /** Every word below is optional; `{name}` = the brand. Defaults = the
      first-order promo. '' hides a line. */
  eyebrow?: string        // 'New to {name}?'
  headline?: string       // 'Get'
  headlineAccent?: string // 'Rs. 200 off'
  headlineTail?: string   // 'your first order'
  bodyBefore?: string     // 'Use code'
  code?: string           // 'FRESH200'
  bodyAfter?: string      // 'at checkout. Free delivery over Rs. 1,500.'
  buttonText?: string     // 'Order from {name} →'
  buttonHref?: string     // '/<slug>'
}

export function BottomCTA({
  brandName, brandSlug, accent,
  eyebrow = 'New to {name}?', headline = 'Get', headlineAccent = 'Rs. 200 off', headlineTail = 'your first order',
  bodyBefore = 'Use code', code = 'FRESH200', bodyAfter = 'at checkout. Free delivery over Rs. 1,500.',
  buttonText = 'Order from {name} →', buttonHref,
}: Props) {
  const n = (s: string) => s.replace(/\{name\}/g, brandName)
  const hasBody = !!(bodyBefore || code || bodyAfter)
  return (
    <section style={{
      padding: 'clamp(3rem, 6vw, 5rem) 0',
      textAlign: 'center',
      background: `linear-gradient(180deg, #fff 0%, ${accent}1f 100%)`,
    }}>
      <div className="container">
        {eyebrow && (
          <p style={{ color: accent, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
            {n(eyebrow)}
          </p>
        )}
        <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', marginBottom: '0.5rem', letterSpacing: '-0.02em' }}>
          {n(headline)}{headline && headlineAccent ? ' ' : ''}{headlineAccent && <span style={{ color: accent }}>{n(headlineAccent)}</span>}{(headline || headlineAccent) && headlineTail ? ' ' : ''}{n(headlineTail)}
        </h2>
        {hasBody && (
          <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem', maxWidth: '34rem', marginInline: 'auto', fontSize: '1rem' }}>
            {n(bodyBefore)}{bodyBefore && code ? ' ' : ''}{code && <code style={{ background: `${accent}25`, color: accent, padding: '0.1rem 0.45rem', borderRadius: '4px', fontWeight: 800 }}>{code}</code>}{(bodyBefore || code) && bodyAfter ? ' ' : ''}{n(bodyAfter)}
          </p>
        )}
        {buttonText && <Link
          href={buttonHref || `/${brandSlug}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.1rem 2.5rem',
            fontSize: '1.05rem',
            fontWeight: 900,
            background: accent,
            color: 'white',
            borderRadius: '999px',
            textDecoration: 'none',
            letterSpacing: '-0.01em',
          }}
        >
          {n(buttonText)}
        </Link>}
      </div>
    </section>
  )
}
