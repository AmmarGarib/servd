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

// servd home: the playful "food crowd" hub, one inhabited place that runs on
// Karachi time.
//
// After the hero, each band has a different ground so the page has rhythm
// (sky → cream → plum → butter → cream). The bands are joined by slowly
// drifting wavy or scalloped seams:
//   hero (sky)             the sky knows the hour (sun/moon, stars/motes).
//                          An instant SVG crowd cross-fades into the 3D one,
//                          and it dozes at night. "Meet the kitchens" → #brands,
//                          or "see who opens first" → #right-now once every
//                          kitchen is closed.
//   ticker                 crossed tapes over the seam, with the food words
//                          of the hour; speed follows scroll.
//   #brands (cream)        trading-card deck, live status stickers, cast
//                          cameos peeking over stackd and Flipd.
//   #right-now (plum)      the kitchen board: live neon per phase and the
//                          live count. Its ground follows the day
//                          (--home-board).
//   how servd works (butter) the second crowd, 3 steps acted out by the cast,
//                          and the "Every kitchen, one order" /browse ticket.
//   insiders (cream)       swinging VIP pass (tap to flash) and three perk
//                          stickers, fronted by cast faces.
//
// Every section follows the same reveal hygiene (useReveal): the SSR state is
// the final state, and only blocks below the fold are armed at opacity .4,
// settling in ≤ 450 ms.
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
// The board's ground follows the day-part (home.module.css), so the seams
// either side of it read the same token.
const BOARD = 'var(--home-board)'
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

      {/* HERO: the food crowd under a sky that knows the hour. The
            characters watch the cursor and cheer the order CTA. The headline
            and overview stay operator-editable via Admin → Marketing →
            Landing Hero (SiteLayout slug `servd:hero`). */}
      <PartyHero config={heroConfig} />

      {/* Everything below the hero. reducedMotion="user" makes framer skip
          transform animations for reduced-motion users, and useReveal never
          arms anything for them either. */}
      <MotionConfig reducedMotion="user">
        <div className={s.root}>
          <Ticker />
          <BrandDeck brands={brands} />
          <Divider from={CREAM} to={BOARD} variant="wave" />
          <KitchenBoard brands={brands} />
          <Divider from={BOARD} to={BUTTER} variant="scallop" flip />
          <HowItWorks />
          <Divider from={BUTTER} to={CREAM} variant="wave" />
          <InsidersPass />
        </div>
      </MotionConfig>

      {/* The global StorefrontFooter has its own "Hungry now? Let's go" and
          order CTA, so we don't double up here. */}
    </div>
  )
}
