import type { TextBlock } from '../../lib/blocks'

const SIZE: Record<NonNullable<TextBlock['size']>, string> = {
  sm: '0.9rem', md: '1.05rem', lg: '1.25rem', xl: 'clamp(1.4rem, 3vw, 2rem)',
}

export function TextBody(block: TextBlock) {
  const containerClass = block.maxWidth === 'full' ? 'container' : block.maxWidth === 'wide' ? 'container' : 'container-narrow'
  return (
    <div className={containerClass}>
      <p style={{
        fontSize: SIZE[block.size ?? 'md'],
        textAlign: block.align ?? 'left',
        lineHeight: 1.6,
        fontWeight: block.emphasized ? 600 : 400,
        whiteSpace: 'pre-wrap',
        color: 'inherit',
      }}>
        {block.body}
      </p>
    </div>
  )
}
