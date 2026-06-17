import Link from 'next/link'
import type { HeroBlock } from '../../lib/blocks'

const HEIGHT: Record<NonNullable<HeroBlock['height']>, string> = {
  sm:     'min(40dvh, 320px)',
  md:     'min(60dvh, 520px)',
  lg:     'min(75dvh, 700px)',
  xl:     'min(85dvh, 800px)',
  screen: 'min(92dvh, 820px)',
}

export function Hero(block: HeroBlock) {
  const align = block.align ?? 'left'
  const overlay = block.imageOverlay ?? 0.45
  const txt = block.textColor ?? (block.imageUrl ? '#ffffff' : 'var(--servd-ink)')

  return (
    <div
      style={{
        position: 'relative',
        minHeight: HEIGHT[block.height ?? 'lg'],
        display: 'flex',
        alignItems: 'center',
        background: block.imageUrl
          ? `${block.background ?? '#0a0a0a'} url(${block.imageUrl}) center/cover`
          : block.background ?? '#fff',
        color: txt,
        overflow: 'hidden',
      }}
    >
      {block.imageUrl && (
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(180deg, rgba(0,0,0,${overlay * 0.4}) 0%, rgba(0,0,0,${overlay}) 100%)`,
        }} />
      )}
      {!block.imageUrl && !block.background && (
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(circle at 90% 0%, var(--servd-green-soft) 0%, transparent 40%)',
          pointerEvents: 'none',
        }} />
      )}

      <div
        className="container"
        style={{
          position: 'relative', zIndex: 1,
          paddingTop: 'clamp(2rem, 6vw, 4rem)',
          paddingBottom: 'clamp(2rem, 6vw, 4rem)',
          textAlign: align,
        }}
      >
        <div style={{ maxWidth: '64rem', marginLeft: align === 'center' ? 'auto' : undefined, marginRight: align === 'center' ? 'auto' : undefined }} className="fade-up">
          {block.kicker && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
              <span style={{ width: '3rem', height: '1px', background: txt, opacity: 0.6 }} aria-hidden="true" />
              <p style={{ fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase', opacity: 0.85 }}>
                {block.kicker}
              </p>
            </div>
          )}
          <h1 style={{
            fontSize: 'clamp(2.5rem, 8vw, 6rem)',
            fontWeight: 900,
            letterSpacing: '-0.05em',
            lineHeight: 0.95,
            marginBottom: block.subtitle ? '1.5rem' : '0',
            color: 'inherit',
          }}>
            {block.title}
          </h1>
          {block.subtitle && (
            <p style={{
              fontSize: 'clamp(1.05rem, 1.7vw, 1.4rem)',
              opacity: 0.85,
              maxWidth: '48rem',
              marginInline: align === 'center' ? 'auto' : undefined,
              lineHeight: 1.5,
            }}>
              {block.subtitle}
            </p>
          )}

          {(block.primaryCta || block.secondaryCta) && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginTop: '2.25rem',
              justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
            }}>
              {block.primaryCta && (
                <Link href={block.primaryCta.href} className="servd-cta"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
                    background: 'var(--servd-green)', color: 'white', fontWeight: 900,
                    fontSize: 'clamp(1.1rem, 2.4vw, 1.6rem)',
                    padding: 'clamp(1.1rem, 2.6vw, 1.6rem) clamp(2.5rem, 6vw, 4rem)',
                    borderRadius: '999px', textDecoration: 'none',
                    boxShadow: '0 14px 36px rgba(58,14,105,0.4)',
                  }}>
                  {block.primaryCta.text}
                </Link>
              )}
              {block.secondaryCta && (
                <Link href={block.secondaryCta.href} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '1rem 1.75rem', borderRadius: '999px',
                  border: `1px solid ${block.imageUrl ? 'rgba(255,255,255,0.3)' : 'var(--servd-line)'}`,
                  background: block.imageUrl ? 'rgba(255,255,255,0.12)' : '#fff',
                  color: 'inherit', textDecoration: 'none', fontWeight: 600,
                }}>
                  {block.secondaryCta.text}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
