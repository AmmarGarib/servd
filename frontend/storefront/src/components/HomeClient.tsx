'use client'
import type { HeroConfig } from '../lib/heroConfig'
import type { Concept } from '../lib/concept'
import { brandAccent, brandStory, conceptHeroImage, formatBrandName } from '../lib/concept'
import { HomeHero } from './hub/home/HomeHero'
import { KitchensBento } from './hub/home/KitchensBento'
import { RightNow } from './hub/home/RightNow'
import { Insiders } from './hub/home/Insiders'
import type { HomeBrand } from './hub/home/types'

// servd home — the FOOD hub, on the dark-premium hub system
// (design-system/servd/MASTER.md): Hero → Bento (the three kitchens) →
// Right now → Insiders. The global StorefrontFooter carries the closing
// "Hungry now?" CTA, so the page doesn't add its own.
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
  { id: 'fallback-stackd', name: 'stackd', slug: 'stackd', primaryColor: null },
  { id: 'fallback-simmer', name: 'simmer', slug: 'simmer', primaryColor: null },
  { id: 'fallback-flipd',  name: 'Flipd',  slug: 'flipd',  primaryColor: null },
] as Array<Pick<Concept, 'id' | 'name' | 'slug' | 'primaryColor'>>

const BRAND_ORDER = ['stackd', 'simmer', 'flipd']

export function HomeClient({ concepts, heroConfig }: Props) {
  const source = concepts.filter((c) => BRAND_ORDER.includes(c.slug))
  const usable = source.length > 0 ? source : FALLBACK_BRANDS

  const brands: HomeBrand[] = [...usable]
    .sort((a, b) => BRAND_ORDER.indexOf(a.slug) - BRAND_ORDER.indexOf(b.slug))
    .map((c) => ({
      id:      c.id,
      slug:    c.slug,
      rawName: c.name,
      name:    formatBrandName(c.name),
      accent:  brandAccent(c.slug, c.primaryColor),
      story:   brandStory(c.slug),
      img:     conceptHeroImage({ ...c, type: 'restaurant', description: null, logoUrl: null } as Concept),
    }))

  return (
    <div className="hub">
      <HomeHero config={heroConfig} brands={brands} />
      <KitchensBento brands={brands} />
      <RightNow brands={brands} />
      <Insiders />
    </div>
  )
}
