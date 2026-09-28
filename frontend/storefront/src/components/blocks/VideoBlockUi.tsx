'use client'
import { useEffect, useRef } from 'react'
import type { VideoBlock } from '../../lib/blocks'

const RATIO: Record<NonNullable<VideoBlock['aspectRatio']>, string> = {
  '16:9': '16 / 9', '9:16': '9 / 16', '1:1': '1 / 1', '4:5': '4 / 5',
}

// Client component because React does not write the `muted` attribute into
// server HTML, and browsers only autoplay muted video — so the property is set
// here and play() is kicked once mounted.
export function VideoBlockUi(block: VideoBlock) {
  const ref = useRef<HTMLVideoElement>(null)
  const autoplay = !!block.autoplay
  const muted = autoplay || !!block.muted

  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.muted = muted
    if (autoplay) void v.play().catch(() => { /* blocked: poster stays */ })
  }, [autoplay, muted, block.url])

  if (!block.url) return null
  return (
    <div className="container">
      <video
        ref={ref}
        src={block.url}
        poster={block.posterUrl || undefined}
        autoPlay={autoplay}
        muted={muted}
        loop={!!block.loop}
        playsInline
        controls={!autoplay}
        preload={autoplay ? 'auto' : 'metadata'}
        style={{
          display: 'block',
          // Portrait clips stay phone-sized instead of filling a desktop row.
          width: block.aspectRatio === '9:16' || block.aspectRatio === '4:5' ? 'min(100%, 420px)' : '100%',
          aspectRatio: RATIO[block.aspectRatio ?? '16:9'],
          objectFit: 'cover', borderRadius: '1rem',
          background: 'var(--servd-black)',
          marginInline: 'auto',
        }}
      />
    </div>
  )
}
