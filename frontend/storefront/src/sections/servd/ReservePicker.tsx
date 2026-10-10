// servd.reservePicker — the /reserve index: one card per brand that takes
// reservations (live: reservationsEnabled !== false, dine-in), each linking to
// its /reserve/<slug> booking page. Labels are fields; the brands are live.
// Card art is the card-sized crop as a lazy <img> (a CSS background cannot be
// lazy, and the full hero is 1600x2400 for a ~300px card).

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { conceptHeroImage, brandStory, brandAccent, formatBrandName } from '../../lib/concept'
import { OpenNowPill, type PillSkin } from '../../components/brand/parts/OpenNowPill'
import type { SectionProps } from '../types'
import { link, safeHref, str } from '../safe'
import { reservableConcepts } from './reservable'

/**
 * A brand whose rules the servd card (white, the brand colour under a dark
 * fade) would break gets its card in its own palette. Simmer (SKILL rules: no
 * white, no gradients, one orange signal): a tiber card with bone type in its
 * own faces, and its low orange sun as the art — the card's one orange
 * signal, as on its servd home tile. No fade, a bone pill, a bone link.
 */
interface CardSkin {
  card: CSSProperties
  panel: string
  art: ReactNode
  title: CSSProperties
  body: CSSProperties
  cta: string
  pill: PillSkin
}

const SKINS: Record<string, CardSkin> = {
  simmer: {
    card: { background: 'var(--simmer-green)', color: 'var(--simmer-bone)', border: '1px solid var(--simmer-green)' },
    panel: 'var(--simmer-green)',
    art: (
      <span aria-hidden style={{
        position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: 'min(60%, 260px)', aspectRatio: '2 / 1',
        background: 'var(--simmer-orange)', borderRadius: '999px 999px 0 0',
      }} />
    ),
    title: { fontFamily: 'var(--simmer-display)', fontWeight: 400, letterSpacing: '0.01em' },
    body: { fontFamily: 'var(--simmer-body)', color: 'color-mix(in srgb, var(--simmer-bone) 75%, transparent)' },
    cta: 'var(--simmer-bone)',
    pill: { bg: 'var(--simmer-bone)', fg: 'var(--simmer-green)' },
  },
}

export async function ReservePicker({ fields }: SectionProps) {
  // Its own read (not ctx.concepts): with the API down the page says nobody
  // is taking bookings rather than offering the bundled fallback brands.
  const concepts = await reservableConcepts()
  const emptyCta = link(fields.emptyCta)
  const cardCta = str(fields.cardCta)
  const pillFallback = str(fields.pillFallback)

  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
      <div className="container">
        {concepts.length === 0 ? (
          <div className="servd-card" style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--servd-mute)' }}>{str(fields.emptyText)}</p>
            {emptyCta.text && (
              <Link href={safeHref(emptyCta.href)} className="brand-pill" style={{ marginTop: '1.25rem', background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
                {emptyCta.text}
              </Link>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {concepts.map((c) => {
              const story = brandStory(c.slug)
              const accent = brandAccent(c.slug, c.primaryColor)
              const name = formatBrandName(c.name)
              const skin = SKINS[c.slug]
              const art = skin ? null : conceptHeroImage(c, 'card')
              return (
                <Link
                  key={c.id}
                  href={`/reserve/${c.slug}`}
                  aria-label={`Book a table at ${name}`}
                  className="servd-card"
                  style={{
                    textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column',
                    ['--brand-accent' as string]: accent,
                    ...skin?.card,
                  }}>
                  <div style={{
                    aspectRatio: '4/3',
                    background: skin?.panel ?? accent,
                    position: 'relative',
                    overflow: 'hidden',
                  }}>
                    {art && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={art} alt="" loading="lazy" decoding="async" width={640} height={480}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }} />
                    )}
                    {skin
                      ? skin.art
                      : <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.55) 100%)' }} />}
                    <div style={{ position: 'absolute', top: '0.85rem', left: '0.85rem' }}>
                      <OpenNowPill slug={c.slug} fallback={pillFallback} {...(skin && { skin: skin.pill })} />
                    </div>
                  </div>
                  <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', ...skin?.title }}>
                      {name}
                    </h2>
                    <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', lineHeight: 1.45, ...skin?.body }}>
                      {story.oneLiner}
                    </p>
                    {cardCta && (
                      <span style={{ marginTop: '0.6rem', fontSize: '0.85rem', fontWeight: 800, color: skin?.cta ?? accent }}>
                        {cardCta.replace(/\{brand\}/g, name)}
                      </span>
                    )}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
