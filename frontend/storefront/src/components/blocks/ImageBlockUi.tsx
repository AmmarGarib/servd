import type { ImageBlock } from '../../lib/blocks'

export function ImageBlockUi(block: ImageBlock) {
  if (!block.url) return null
  // A real <img> (not a CSS background) so the photo is indexable and carries
  // the editor's alt text; '' marks it decorative when no alt was given.
  // object-fit: cover in the fixed aspect box crops exactly as the old
  // `center/cover` background did.
  return (
    <div className="container">
      <figure style={{ margin: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={block.url}
          alt={block.alt?.trim() ?? ''}
          loading="lazy"
          decoding="async"
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            aspectRatio: block.aspect ?? '16/9',
            objectFit: 'cover',
            borderRadius: block.rounded ? '1rem' : 0,
          }}
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
