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
        {block.images.map((img, i) => img.url ? (
          // A real <img> with the item's alt ('' = decorative), so gallery
          // photos are indexable; cover-cropped into the square like the old
          // `center/cover` background.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={img.url} alt={img.alt?.trim() ?? ''} loading="lazy" decoding="async"
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
              aspectRatio: '1/1',
              objectFit: 'cover',
              borderRadius: '0.75rem',
            }} />
        ) : (
          // An item with no image yet: the empty tile, nothing to announce.
          <div key={i} aria-hidden="true" style={{
            aspectRatio: '1/1',
            borderRadius: '0.75rem',
            background: 'var(--servd-line)',
          }} />
        ))}
      </div>
    </div>
  )
}
