import type { QuoteBlock } from '../../lib/blocks'

const SIZE: Record<NonNullable<QuoteBlock['size']>, string> = {
  md: 'clamp(1.2rem, 2.5vw, 1.75rem)',
  lg: 'clamp(1.4rem, 3vw, 2.25rem)',
  xl: 'clamp(1.5rem, 3.5vw, 2.75rem)',
}

export function Quote(block: QuoteBlock) {
  return (
    <div className="container" style={{ textAlign: 'center', maxWidth: '52rem' }}>
      <p style={{
        fontSize: SIZE[block.size ?? 'lg'],
        fontWeight: 600,
        lineHeight: 1.35,
        letterSpacing: '-0.02em',
        color: 'inherit',
      }}>
        {block.text}
      </p>
      {block.attribution && (
        <p style={{ marginTop: '1.5rem', opacity: 0.55, fontSize: '0.9rem' }}>
          {block.attribution}
        </p>
      )}
    </div>
  )
}
