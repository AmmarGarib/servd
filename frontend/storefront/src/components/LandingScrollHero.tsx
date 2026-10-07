'use client';

// The home-page hero: a scroll-expansion media block (background image fades
// out as the foreground photo/video expands to fill the screen). Content +
// media are operator-editable via Admin → Marketing → Landing Hero; this just
// renders whatever HeroConfig the server resolved (real config or food
// placeholders). The post-expand reveal carries a short intro + the primary
// "Order now" CTA (jumps to the kitchens) so the hero still converts.

import ScrollExpandMedia from './ui/scroll-expansion-hero';
import type { HeroConfig } from '../lib/heroConfig';
import { openSearch } from './SearchSheet';

export function LandingScrollHero({ config }: { config: HeroConfig }) {
  return (
    <ScrollExpandMedia
      mediaType={config.mediaType}
      mediaSrc={config.mediaSrc}
      posterSrc={config.posterSrc}
      bgImageSrc={config.bgImageSrc}
      title={config.title}
      date={config.date}
      scrollToExpand={config.scrollToExpand}
      textBlend={config.textBlend}
    >
      <div
        className="container"
        style={{ maxWidth: '52rem', margin: '0 auto', textAlign: 'center' }}
      >
        {config.overview && (
          <p
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.4rem, 3vw, 2.2rem)',
              fontWeight: 700,
              color: 'var(--servd-ink)',
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            {config.overview}
          </p>
        )}
        {config.conclusion && (
          <p
            style={{
              marginTop: '1.25rem',
              color: 'var(--servd-mute)',
              fontSize: '1.05rem',
              lineHeight: 1.6,
            }}
          >
            {config.conclusion}
          </p>
        )}
        <div className="sv-ctas">
          <a href="#kitchens" className="sv-btn sv-btn-primary">Order now</a>
          <button type="button" className="sv-link" onClick={() => openSearch('')}
            style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>
            Search the menus{' '}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
    </ScrollExpandMedia>
  );
}
