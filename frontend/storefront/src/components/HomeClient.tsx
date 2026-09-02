'use client'
import Link from 'next/link'
import { MagneticLink } from './ui/MagneticButton'
import { KitchenPassHero } from './KitchenPassHero'
import type { HeroConfig } from '../lib/heroConfig'

import type { Concept } from '../lib/concept'
import { brandAccent, brandStory, conceptHeroImage, formatBrandName } from '../lib/concept'
import { Reveal, Parallax } from './motion/Motion'
import { OpenNowPill } from './brand/parts/OpenNowPill'
import { BRAND_LOCATIONS, locationFor, whatsappLink } from '../lib/brandLocations'

// servd home — the FOOD hub, liquid-glass edition.
//
// The visual hierarchy stays FOOD FIRST: full-bleed photography leads,
// but every chrome surface is now frosted glass with a specular edge,
// sections enter with blur-up reveals, and the brand-card photography
// drifts on scroll (parallax) and swells on hover.
//
// Graceful degradation: if the api hiccups and concepts comes back
// empty, we render the three live brands from hardcoded data so the
// home page never goes blank. The data is kept in sync with
// BRAND_STORIES + conceptHeroImage in lib/concept.ts.

interface Props {
  concepts: Concept[]
  heroConfig: HeroConfig
}

// Fallback brand cards — used when the live concepts API returns nothing
// (api warmup, network blip, etc.). Order matches the live brand grid.
const FALLBACK_BRANDS = [
  { id: 'fallback-stax',   name: 'Stax',   slug: 'stax',   primaryColor: null },
  { id: 'fallback-simmer', name: 'simmer', slug: 'simmer', primaryColor: null },
  { id: 'fallback-flipd',  name: 'Flipd',  slug: 'flipd',  primaryColor: null },
] as Array<Pick<Concept, 'id' | 'name' | 'slug' | 'primaryColor'>>

export function HomeClient({ concepts, heroConfig }: Props) {
  const source = concepts.filter((c) => ['simmer', 'stax', 'flipd'].includes(c.slug))
  // If the live concept list came back empty (api blip), fall through
  // to the hardcoded fallback so the home page never looks blank.
  const usable = source.length > 0 ? source : FALLBACK_BRANDS

  const brands = usable
    .sort((a, b) => ['stax', 'simmer', 'flipd'].indexOf(a.slug) - ['stax', 'simmer', 'flipd'].indexOf(b.slug))
    .map((c) => ({
      id: c.id,
      name: formatBrandName(c.name),
      slug: c.slug,
      accent: brandAccent(c.slug, c.primaryColor),
      story:  brandStory(c.slug),
      img:    conceptHeroImage({ ...c, type: 'restaurant', description: null, logoUrl: null } as Concept),
    }))

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', display: 'flex', flexDirection: 'column' }}>

      {/* ── HERO ─ the Kitchen Pass: a pinned scroll-driven tasting menu.
            Each brand's dish is plated in sequence as the user scrolls —
            photo irises onto a shared ceramic plate, ingredient close-ups
            drift in, the room's light grades to the brand hue. Headline +
            subcopy stay operator-editable via Admin → Marketing → Landing
            Hero (SiteLayout slug `servd:hero`). */}
      <KitchenPassHero
        title={heroConfig.title}
        sub={heroConfig.overview}
        courses={brands.map((b) => ({
          slug: b.slug, name: b.name, accent: b.accent,
          img: b.img, tagline: b.story.tagline,
        }))}
      />

      {/* ── BRAND CARDS ─ Each one is a full-bleed food block leading
            into the order flow. Media drifts on scroll and swells on
            hover; the caption rides on a dark glass panel. */}
      <section id="brands" style={{ background: 'var(--servd-bg)', order: 2 }}>
        <div className="container" style={{ paddingTop: 'clamp(4rem, 8vw, 6rem)', paddingBottom: '2rem' }}>
          <Reveal blur>
            <p className="eyebrow eyebrow-accent">The kitchens</p>
            <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
              Pick one. Pick two.<br />
              <span className="display-italic">Pick all of them.</span>
            </h2>
            <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
              One bag, one delivery. We hold the slowest dish so the salad stays cold and the burger stays hot.
            </p>
          </Reveal>
        </div>

        <div className="container" style={{ paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
          <div style={{ display: 'grid', gap: '1.5rem' }}>
            {brands.map((b, i) => (
              // Card wrapper — the card body links to the brand microsite
              // at /brand/${slug} (CEO direction); the "Order from X" pill
              // is its own click target into the ordering flow. Two
              // stacked Links so each surface keeps its navigation intent.
              <Reveal key={b.id} delay={i * 0.1} y={44}>
                <div className="brand-card" style={{ minHeight: 'clamp(340px, 44vw, 480px)', background: b.accent }}>
                  {/* Media — parallax drift on scroll + zoom on hover. */}
                  <Parallax speed={0.12} style={{ position: 'absolute', inset: 0 }}>
                    <div
                      className="brand-card-media"
                      style={{ backgroundImage: `url(${b.img})` }}
                      aria-hidden
                    />
                  </Parallax>
                  <div aria-hidden style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.02) 38%, rgba(0,0,0,0.28) 62%, rgba(0,0,0,0.78) 100%)',
                    pointerEvents: 'none', zIndex: 1,
                  }} />

                  {/* Full-card hit-area Link to the brand landing page */}
                  <Link href={`/brand/${b.slug}`}
                    aria-label={`Visit ${b.name}'s landing page`}
                    style={{ position: 'absolute', inset: 0, zIndex: 2, borderRadius: 'inherit' }}
                  />
                  <span className="brand-card-arrow" aria-hidden>→</span>

                  <div style={{
                    position: 'relative', zIndex: 3, height: '100%',
                    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                    padding: 'clamp(1.25rem, 3vw, 2rem)', color: 'white',
                    minHeight: 'clamp(340px, 44vw, 480px)',
                    pointerEvents: 'none',
                  }}>
                    <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.85)', textShadow: '0 1px 8px rgba(0,0,0,0.4)' }}>
                      /{b.slug}
                    </p>

                    {/* Caption — type straight on the scrim (a blurred glass
                        panel here smears the photography into mud). */}
                    <div style={{ maxWidth: '38rem' }}>
                      <h3 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', color: 'white', lineHeight: 0.98, letterSpacing: '-0.04em', textShadow: '0 2px 18px rgba(0,0,0,0.55)' }}>
                        {b.name}
                      </h3>
                      <p style={{ marginTop: '0.65rem', fontSize: 'clamp(0.98rem, 1.3vw, 1.15rem)', color: 'rgba(255,255,255,0.92)', maxWidth: '28rem', lineHeight: 1.45, textShadow: '0 1px 10px rgba(0,0,0,0.6)' }}>
                        {b.story.tagline}
                      </p>
                      {/* "Order from X" pill — independent Link to the
                          ordering surface; pointer-events restored + higher
                          z-index so it beats the full-card cover Link. */}
                      <Link href={`/${b.slug}`}
                        aria-label={`Order from ${b.name}`}
                        style={{
                          marginTop: '1.15rem',
                          display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                          background: 'rgba(255,255,255,0.92)', color: 'var(--servd-ink)',
                          fontFamily: 'var(--font-display)', fontWeight: 800,
                          fontSize: '0.95rem',
                          padding: '0.7rem 1.3rem', borderRadius: '999px',
                          textDecoration: 'none',
                          position: 'relative', zIndex: 4,
                          pointerEvents: 'auto',
                          boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
                          transition: 'transform 220ms cubic-bezier(0.22,1,0.36,1)',
                        }}
                      >
                        Order from {b.name} <span aria-hidden style={{ opacity: 0.6 }}>→</span>
                      </Link>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── OPEN NOW STRIP ─ Live status + address per brand as glass
            chips. Hours wrong on Google is the #1 Karachi mistake;
            surface them on the home so the customer never has to wonder
            which one's open. */}
      <section style={{ background: 'var(--servd-surface)', borderBlock: '1px solid var(--servd-line)', order: 3 }}>
        <div className="container" style={{ paddingTop: '2.25rem', paddingBottom: '2.25rem' }}>
          <Reveal>
            <p className="eyebrow eyebrow-accent" style={{ marginBottom: '1rem' }}>Right now</p>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            {brands.map((b, i) => {
              const loc = locationFor(b.slug)
              return (
                <Reveal key={b.id} delay={i * 0.08} y={20}>
                  <div className="glass glass-lift glass-sheen" style={{
                    padding: '1.1rem 1.2rem',
                    display: 'flex', flexDirection: 'column', gap: '0.45rem',
                    height: '100%',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem', color: 'var(--servd-ink)' }}>
                        {b.name}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        <OpenNowPill slug={b.slug} fallback="Today" />
                      </span>
                    </div>
                    {loc && !loc.area.startsWith('TODO') && (
                      <p style={{ color: 'var(--servd-mute)', fontSize: '0.82rem', lineHeight: 1.4, margin: 0 }}>
                        {loc.area}
                      </p>
                    )}
                    {loc && (
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                        <Link href={`/${b.slug}`} style={{ color: b.accent, fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>
                          Order →
                        </Link>
                        <span style={{ color: 'var(--servd-dim)', fontSize: '0.78rem' }}>·</span>
                        <a href={whatsappLink(loc, `hi ${b.name.toLowerCase()}`)}
                          target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--servd-mute)', fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>
                          WhatsApp
                        </a>
                      </div>
                    )}
                  </div>
                </Reveal>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── EXPLORE STRIP ─ Aurora band inviting customers to browse
            every brand in one place. No delivery / aggregator messaging. */}
      <section className="aurora-field" style={{ background: 'linear-gradient(135deg, #4E2A4F 0%, #2D1E2F 100%)', color: 'white', padding: '3rem 0', order: 4 }}>
        <div className="container" style={{ position: 'relative', zIndex: 1, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '1.25rem' }}>
          <Reveal>
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.15rem, 2vw, 1.5rem)', fontWeight: 700, lineHeight: 1.3, margin: 0, maxWidth: '38rem' }}>
              Every kitchen, one order.<br />
              <span style={{ opacity: 0.7 }}>Explore the brands and check out once.</span>
            </p>
          </Reveal>
          <Reveal delay={0.12}>
            <MagneticLink href="/browse" className="glass-sheen" style={{
              background: 'rgba(255,255,255,0.92)', color: 'var(--servd-green)',
              fontWeight: 800, fontSize: '0.92rem',
              padding: '0.85rem 1.5rem', borderRadius: '999px', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              boxShadow: '0 10px 32px rgba(0,0,0,0.3)',
            }}>
              Explore the brands <span aria-hidden style={{ opacity: 0.6 }}>→</span>
            </MagneticLink>
          </Reveal>
        </div>
      </section>

      {/* ── INSIDERS — servd loyalty membership pitch. Aurora field +
            true glass tier cards. Single CTA: become a member. ──── */}
      <section className="aurora-field" style={{ background: 'var(--servd-green)', color: 'white', padding: 'clamp(4rem, 8vh, 7rem) 0', order: 1 }}>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          {/* Header — eyebrow + bricolage display + sub */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'clamp(2rem, 5vw, 4rem)',
            marginBottom: 'clamp(2.5rem, 5vw, 3.5rem)',
            alignItems: 'baseline',
          }}>
            <Reveal blur>
              <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '1rem' }}>
                Insiders · free to join
              </p>
              <h2 className="display" style={{
                fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
                color: 'white',
                margin: 0,
                lineHeight: 0.95,
                letterSpacing: '-0.04em',
              }}>
                The best stuff<br />
                <span className="display-italic" style={{ color: '#C9A4F2' }}>doesn&rsquo;t get listed.</span>
              </h2>
            </Reveal>
            <Reveal delay={0.15}>
              <p style={{
                color: 'rgba(255,255,255,0.82)',
                fontSize: '1.05rem',
                lineHeight: 1.55,
                maxWidth: '32rem',
              }}>
                Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
              </p>
            </Reveal>
          </div>

          {/* Per-brand Insiders perks. Per the loyalty-program skill:
              simmer (premium) gets exclusive recognition framing — no
              points, no "buy N get 1," no coupony language; stax + flipd
              (casual, higher-frequency) get a clean generous points
              mechanic. Same brand-keyed card pattern as the brand grid
              above so the section reads as "Insiders at each kitchen,
              tuned to the kitchen." */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1rem',
            alignItems: 'stretch',
          }}>
            {[
              {
                slug: 'simmer',
                badge: '◇', tag: 'simmer · regulars',
                head: 'The regulars’ list',
                body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
                featured: false,
              },
              {
                slug: 'stax',
                badge: '★', tag: 'Stax · stack club',
                head: 'Stack five, the sixth’s on us',
                body: 'Order five from Stax, the sixth burger’s on the house. Insiders also get first dibs on Friday-only stacks before they go public.',
                featured: true,
              },
              {
                slug: 'flipd',
                badge: '+', tag: 'Flipd · points',
                head: 'Points on every box',
                body: 'Earn 1 point per Rs. 10 spent at Flipd. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.',
                featured: false,
              },
            ].map((p, i) => (
              <Reveal key={p.head} delay={i * 0.12} y={36} style={{ height: '100%' }}>
                <div className="glass-deep glass-lift glass-sheen" style={{
                  background: p.featured ? 'rgba(255,255,255,0.16)' : undefined,
                  borderColor: p.featured ? 'rgba(255,255,255,0.4)' : undefined,
                  borderRadius: '1.25rem',
                  padding: '1.5rem 1.4rem',
                  color: 'white',
                  transform: p.featured ? 'translateY(-12px)' : undefined,
                  height: '100%',
                }}>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    width: '2.4rem', height: '2.4rem',
                    background: p.featured ? 'white' : 'rgba(255,255,255,0.12)',
                    color: p.featured ? 'var(--servd-green)' : 'white',
                    borderRadius: '999px',
                    fontFamily: 'var(--font-display)', fontWeight: 800,
                    fontSize: '0.95rem',
                    marginBottom: '1rem',
                  }}>{p.badge}</div>
                  <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '0.5rem' }}>
                    {p.tag}
                  </p>
                  <h3 className="display" style={{
                    fontSize: 'clamp(1.35rem, 2.3vw, 1.65rem)',
                    color: 'white',
                    margin: '0 0 0.6rem',
                    lineHeight: 1.05,
                    letterSpacing: '-0.02em',
                  }}>
                    {p.head}
                  </h3>
                  <p style={{
                    color: 'rgba(255,255,255,0.78)',
                    fontSize: '0.92rem',
                    lineHeight: 1.55,
                    margin: 0,
                  }}>
                    {p.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Insiders CTAs — two routes per the WhatsApp-marketing skill:
              the regulars' list is a WhatsApp-first asset (the dominant
              channel in PK; broadcasts beat email open rates 4-5x). The
              web signup stays as the backup route so guests who don't
              want WhatsApp aren't shut out. */}
          <Reveal delay={0.2}>
            <div style={{
              marginTop: 'clamp(2.5rem, 5vw, 3.5rem)',
              display: 'flex', flexWrap: 'wrap',
              alignItems: 'center', gap: '1rem',
            }}>
              <a
                href={whatsappLink(BRAND_LOCATIONS['simmer']!, 'add me to servd insiders')}
                target="_blank" rel="noopener noreferrer"
                className="glass-sheen"
                style={{
                  background: '#25D366',
                  color: 'white',
                  fontFamily: 'var(--font-display)', fontWeight: 800,
                  fontSize: '1.05rem',
                  padding: '1rem 1.85rem',
                  borderRadius: '999px',
                  textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
                }}>
                Join on WhatsApp <span aria-hidden style={{ opacity: 0.7 }}>→</span>
              </a>
              <MagneticLink href="/signup?insider=1" style={{
                background: 'rgba(255,255,255,0.92)',
                color: 'var(--servd-green)',
                fontFamily: 'var(--font-display)', fontWeight: 800,
                fontSize: '1.05rem',
                padding: '1rem 1.85rem',
                borderRadius: '999px',
                textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
              }}>
                Or sign up with email
              </MagneticLink>
              <Link href="/login" style={{
                color: 'rgba(255,255,255,0.85)',
                fontWeight: 700, fontSize: '0.95rem',
                textDecoration: 'underline',
                textUnderlineOffset: '4px',
                textDecorationColor: 'rgba(255,255,255,0.4)',
                padding: '0.6rem 0.4rem',  // 44pt min touch height
                display: 'inline-block', lineHeight: 1,
              }}>
                Already a member? Sign in
              </Link>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem' }}>
                · free forever · cancel anytime
              </span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Global StorefrontFooter has its own "Hungry now? Let's go"
          plus order CTA — we don't double up here. */}
    </div>
  )
}
