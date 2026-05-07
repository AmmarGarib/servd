import Link from 'next/link'
import type { BannerBlock } from '../../lib/blocks'

const HEIGHT: Record<NonNullable<BannerBlock['height']>, string> = {
  sm: '180px', md: '280px', lg: '420px',
}

export function Banner(block: BannerBlock) {
  const txt = block.textColor ?? '#fff'
  return (
    <div style={{
      minHeight: HEIGHT[block.height ?? 'md'],
      display: 'flex', alignItems: 'center',
      background: block.backgroundUrl
        ? `${block.backgroundColor ?? '#0a0a0a'} url(${block.backgroundUrl}) center/cover`
        : block.backgroundColor ?? '#0a0a0a',
      color: txt,
      position: 'relative',
    }}>
      {block.backgroundUrl && (
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      )}
      <div className="container" style={{
        position: 'relative', zIndex: 1,
        textAlign: block.align ?? 'center',
        paddingTop: '2rem', paddingBottom: '2rem',
      }}>
        <h2 style={{
          fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)',
          fontWeight: 800, letterSpacing: '-0.03em',
          marginBottom: block.subtitle ? '0.5rem' : '0',
        }}>
          {block.title}
        </h2>
        {block.subtitle && (
          <p style={{ fontSize: '1rem', opacity: 0.85, maxWidth: '40rem', marginInline: block.align === 'center' ? 'auto' : undefined }}>
            {block.subtitle}
          </p>
        )}
        {block.cta && (
          <Link href={block.cta.href} style={{
            display: 'inline-flex', marginTop: '1.5rem',
            background: 'var(--servd-green)', color: '#000',
            padding: '0.85rem 1.75rem', borderRadius: '999px',
            fontWeight: 900, textDecoration: 'none',
          }}>
            {block.cta.text}
          </Link>
        )}
      </div>
    </div>
  )
}
