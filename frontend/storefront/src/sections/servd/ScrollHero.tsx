'use client'

// servd.scrollHero — the home-page scroll-expansion hero (background fades out
// as the foreground photo/video expands to fill the screen). Every word and
// media URL is a field; the scroll behaviour lives in ui/scroll-expansion-hero.
// The post-expand reveal carries the intro + the primary "Order now" CTA
// (jumps to the kitchens) so the hero still converts.

import ScrollExpandMedia from '../../components/ui/scroll-expansion-hero'
import { openSearch } from '../../components/SearchSheet'
import type { SectionProps } from '../types'
import { link, safeHref, safeSrc, str } from '../safe'
import { Chevron } from './icons'

export function ScrollHero({ fields }: SectionProps) {
  const mediaType = fields.mediaType === 'image' ? 'image' : 'video'
  const mediaSrc = safeSrc(mediaType === 'video' ? fields.mediaSrc : fields.mediaImage)
  const poster = safeSrc(fields.posterSrc)
  const date = str(fields.date)
  const overview = str(fields.overview)
  const conclusion = str(fields.conclusion)
  const primary = link(fields.primaryCta)
  const secondary = link(fields.secondaryCta)

  return (
    <ScrollExpandMedia
      mediaType={mediaType}
      mediaSrc={mediaSrc}
      {...(poster && { posterSrc: poster })}
      bgImageSrc={safeSrc(fields.bgImageSrc)}
      title={str(fields.title)}
      {...(date && { date })}
      scrollToExpand={str(fields.scrollToExpand)}
      textBlend={fields.textBlend === true}
    >
      <div className="container" style={{ maxWidth: '52rem', margin: '0 auto', textAlign: 'center' }}>
        {overview && (
          <p style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.4rem, 3vw, 2.2rem)',
            fontWeight: 700,
            color: 'var(--servd-ink)',
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
            margin: 0,
          }}>
            {overview}
          </p>
        )}
        {conclusion && (
          <p style={{ marginTop: '1.25rem', color: 'var(--servd-mute)', fontSize: '1.05rem', lineHeight: 1.6 }}>
            {conclusion}
          </p>
        )}
        {(primary.text || secondary.text) && (
          <div className="sv-ctas">
            {primary.text && <a href={safeHref(primary.href)} className="sv-btn sv-btn-primary">{primary.text}</a>}
            {secondary.text && (secondary.href.trim() === '#search'
              ? (
                <button type="button" className="sv-link" onClick={() => openSearch('')}
                  style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>
                  {secondary.text}{' '}<Chevron flush />
                </button>
              )
              : <a href={safeHref(secondary.href)} className="sv-link">{secondary.text}{' '}<Chevron flush /></a>)}
          </div>
        )}
      </div>
    </ScrollExpandMedia>
  )
}
