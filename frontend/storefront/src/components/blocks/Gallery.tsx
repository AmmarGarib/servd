import type { GalleryBlock } from '../../lib/blocks'

export function Gallery(block: GalleryBlock) {
  if (block.images.length === 0) return null
  return (
    <div className="container">
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${block.columns ?? 3}, minmax(0, 1fr))`,
        gap: '0.75rem',
      }}>
        {block.images.map((img, i) => (
          <div key={i} style={{
            aspectRatio: '1/1',
            borderRadius: '0.75rem',
            background: img.url ? `url(${img.url}) center/cover` : 'var(--servd-line)',
          }} role="img" aria-label={img.alt ?? ''} />
        ))}
      </div>
    </div>
  )
}
