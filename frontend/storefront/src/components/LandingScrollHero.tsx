'use client';

// The home-page hero: a scroll-expansion media block (background image fades
// out as the foreground photo/video expands to fill the screen). Content +
// media are operator-editable via Admin → Marketing → Landing Hero; this just
// renders whatever HeroConfig the server resolved (real config or food
// placeholders). The post-expand reveal carries a short intro + the primary
// "Order now" CTA so the hero still converts.

import Link from 'next/link';
import ScrollExpandMedia from './ui/scroll-expansion-hero';
import type { HeroConfig } from '../lib/heroConfig';

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
        <Link
          href="/browse"
          style={{
            marginTop: '2rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'var(--servd-green)',
            color: 'var(--servd-on-green)',
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: '1rem',
            padding: '0.9rem 1.6rem',
            borderRadius: '999px',
            textDecoration: 'none',
          }}
        >
          Order now{' '}
          <span aria-hidden style={{ opacity: 0.7 }}>
            →
          </span>
        </Link>
      </div>
    </ScrollExpandMedia>
  );
}
