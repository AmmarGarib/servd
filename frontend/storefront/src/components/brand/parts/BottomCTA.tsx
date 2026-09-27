'use client'
import Link from 'next/link'
import { pressArrowClass, pressClass, pressReleaseHandlers } from '../BrandShell'

// The Order button presses like the brand's own material (rubber / enamel /
// sticker / linen — see pressMaterial in BrandShell). Colours stay inline.

interface Props {
  brandName: string
  brandSlug: string
  accent: string
}

export function BottomCTA({ brandName, brandSlug, accent }: Props) {
  return (
    <section style={{
      padding: 'clamp(3rem, 6vw, 5rem) 0',
      textAlign: 'center',
      background: `linear-gradient(180deg, #fff 0%, ${accent}1f 100%)`,
    }}>
      <div className="container">
        <p style={{ color: accent, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
          New to {brandName}?
        </p>
        <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', marginBottom: '0.5rem', letterSpacing: '-0.02em' }}>
          Get <span style={{ color: accent }}>Rs. 200 off</span> your first order
        </h2>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem', maxWidth: '34rem', marginInline: 'auto', fontSize: '1rem' }}>
          Use code <code style={{ background: `${accent}25`, color: accent, padding: '0.1rem 0.45rem', borderRadius: '4px', fontWeight: 800 }}>FRESH200</code> at checkout. Free delivery over Rs. 1,500.
        </p>
        <Link
          href={`/${brandSlug}`}
          className={pressClass(brandSlug)}
          {...pressReleaseHandlers}
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
          Order from {brandName}&nbsp;<span aria-hidden="true" className={pressArrowClass}>→</span>
        </Link>
      </div>
    </section>
  )
}
