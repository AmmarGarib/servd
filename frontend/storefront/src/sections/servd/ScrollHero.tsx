'use client'

// servd.scrollHero — the home-page scroll-expansion hero (background fades out
// as the foreground photo/video expands to fill the screen). Every word and
// media URL is a field; the scroll behaviour lives in ui/scroll-expansion-hero.
// The title is the page's h1 by default (one heading, both sliding halves);
// headingLevel drops it to h2 on a page that has its own h1.
// The post-expand reveal carries the intro + the primary "Order now" CTA
// (jumps to the kitchens) so the hero still converts.

import ScrollExpandMedia from '../../components/ui/scroll-expansion-hero'
import { openSearch } from '../../components/SearchSheet'
import type { SectionProps } from '../types'
import { link, list, safeHref, safeSrc, str } from '../safe'
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
  const title = str(fields.title)
  const Heading = fields.headingLevel === 'h2' ? 'h2' : 'h1'
  // Hidden title: nothing over the media, but the page keeps its heading for
  // search engines and screen readers. Saved layouts from before the toggle
  // had the title on show.
  const showTitle = fields.showTitle !== false

  return (
    <ScrollExpandMedia
      mediaType={mediaType}
      mediaSrc={mediaSrc}
      {...(poster && { posterSrc: poster })}
      bgImageSrc={safeSrc(fields.bgImageSrc)}
      bgSlides={list<{ src?: unknown; alt?: unknown }>(fields.bgSlides)
        .map((p) => ({ src: safeSrc(p.src), alt: str(p.alt).trim() }))
        .filter((p) => p.src)}
      bgSlideSeconds={Number(fields.bgSlideSeconds) || 6}
      title={showTitle ? title : ''}
      headingLevel={Heading}
      mediaAlt={str(fields.mediaAlt).trim()}
      {...(date && { date })}
      scrollToExpand={str(fields.scrollToExpand)}
      textBlend={fields.textBlend === true}
      revealPadded={Boolean(overview || conclusion || primary.text || secondary.text)}
    >
      {!showTitle && title && <Heading className="sr-only">{title}</Heading>}
      {(overview || conclusion || primary.text || secondary.text) && (
      <div className="container" style={{ maxWidth: '52rem', margin: '0 auto', textAlign: 'center' }}>
        {overview && (
          <p style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.4rem, 3vw, 2.2rem)',
            fontWeight: 800,
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
      )}
    </ScrollExpandMedia>
  )
}
