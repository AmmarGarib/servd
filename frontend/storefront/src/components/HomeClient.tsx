'use client'
import { MotionConfig } from 'framer-motion'
import { PartyHero } from './party/PartyHero'
import type { HeroConfig } from '../lib/heroConfig'

import type { Concept } from '../lib/concept'
import { brandAccent, brandStory, conceptHeroImage, formatBrandName } from '../lib/concept'
import { Ticker } from './party/home/Ticker'
import { BrandDeck, type HomeBrand } from './party/home/BrandDeck'
import { KitchenBoard } from './party/home/KitchenBoard'
import { HowItWorks } from './party/home/HowItWorks'
import { InsidersPass } from './party/home/InsidersPass'
import { Divider } from './party/home/Divider'
import s from './party/home/home.module.css'

// servd home — the playful "food crowd" hub.
//
// Flow after the hero, each band a different ground so the page has rhythm
// (butter → cream → plum → butter → cream), joined by drifting wavy /
// scalloped seams:
//   hero (butter)          — the 3D food crowd; "Meet the kitchens" → #brands
//   ticker                 — crossed tapes over the seam, speed with scroll
//   #brands (cream)        — trading-card deck, two links per card
//   right now (plum)       — departures board: live open sign, area, hours,
//                            order + WhatsApp
//   how servd works (butter) — second (last) crowd + 3 steps + the
//                            "Every kitchen, one order" /browse ticket
//   insiders (cream)       — swinging VIP pass + three perk stickers
//
// Graceful degradation: if the api hiccups and concepts comes back empty,
// we render the three live brands from hardcoded data so the home page
// never goes blank. The data is kept in sync with BRAND_STORIES +
// conceptHeroImage in lib/concept.ts.

interface Props {
  concepts: Concept[]
  heroConfig: HeroConfig
}

// Fallback brand cards — used when the live concepts API returns nothing
// (api warmup, network blip, etc.). Order matches the live brand grid.
const FALLBACK_BRANDS = [
  { id: 'fallback-stackd', name: 'stackd', slug: 'stackd', primaryColor: null },
  { id: 'fallback-simmer', name: 'simmer', slug: 'simmer', primaryColor: null },
  { id: 'fallback-flipd',  name: 'Flipd',  slug: 'flipd',  primaryColor: null },
] as Array<Pick<Concept, 'id' | 'name' | 'slug' | 'primaryColor'>>

const ORDER = ['stackd', 'simmer', 'flipd']

const CREAM = '#FFF4D6'
const PLUM = '#4E2A4F'
const BUTTER = '#FFD447'

export function HomeClient({ concepts, heroConfig }: Props) {
  const source = concepts.filter((c) => ORDER.includes(c.slug))
  // If the live concept list came back empty (api blip), fall through
  // to the hardcoded fallback so the home page never looks blank.
  const usable = source.length > 0 ? source : FALLBACK_BRANDS

  const brands: Array<HomeBrand & { hours: string }> = [...usable]
    .sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug))
    .map((c) => {
      const story = brandStory(c.slug)
      return {
        id: c.id,
        // simmer and stackd are always lowercase, whatever admin stored.
        name: formatBrandName(c.name),
        slug: c.slug,
        accent: brandAccent(c.slug, c.primaryColor),
        tagline: story.tagline,
        highlights: story.highlights,
        hours: story.hours,
        img: conceptHeroImage({ ...c, type: 'restaurant', description: null, logoUrl: null } as Concept),
      }
    })

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', display: 'flex', flexDirection: 'column' }}>

      {/* ── HERO ─ the food crowd: 3D food characters on a butter-yellow
            stage that watch the cursor and cheer the order CTA. Headline and
            overview stay operator-editable via Admin → Marketing → Landing
            Hero (SiteLayout slug `servd:hero`). */}
      <PartyHero config={heroConfig} />

      {/* Everything below the hero. reducedMotion="user" makes framer skip
          transform animations for reduced-motion users; each section also
          renders its final state directly in that case. */}
      <MotionConfig reducedMotion="user">
        <div className={s.root}>
          <Ticker />
          <BrandDeck brands={brands} />
          <Divider from={CREAM} to={PLUM} variant="wave" />
          <KitchenBoard brands={brands} />
          <Divider from={PLUM} to={BUTTER} variant="scallop" flip />
          <HowItWorks />
          <Divider from={BUTTER} to={CREAM} variant="wave" />
          <InsidersPass />
        </div>
      </MotionConfig>

      {/* Global StorefrontFooter has its own "Hungry now? Let's go"
          plus order CTA — we don't double up here. */}
    </div>
  )
}
