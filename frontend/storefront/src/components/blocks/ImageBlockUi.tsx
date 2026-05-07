import type { ImageBlock } from '../../lib/blocks'

export function ImageBlockUi(block: ImageBlock) {
  if (!block.url) return null
  return (
    <div className="container">
      <figure style={{ margin: 0 }}>
        <div style={{
          aspectRatio: block.aspect ?? '16/9',
          background: `url(${block.url}) center/cover`,
          borderRadius: block.rounded ? '1rem' : 0,
        }}
          role="img"
          aria-label={block.alt ?? ''}
        />
        {block.caption && (
          <figcaption style={{ marginTop: '0.75rem', textAlign: 'center', fontSize: '0.85rem', color: 'var(--servd-mute)' }}>
            {block.caption}
          </figcaption>
        )}
      </figure>
    </div>
  )
}
