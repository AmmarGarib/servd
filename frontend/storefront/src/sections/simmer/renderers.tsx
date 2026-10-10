// simmer sections — renderers, keyed by variant. See ../README.md.
// Server sections are static imports (they never ship to the browser); client
// sections come from ./lazy so each page loads only the ones it renders.
import type { SectionComponent } from '../types'
import { Itinerary } from './Itinerary'
import { Note } from './Note'
import { Rule } from './Rule'
import { CrossBrand } from './CrossBrand'
import { Signoff } from './Signoff'
import { Menu } from './Menu'
import { FridgeHero, Elsewhere } from './lazy'

export const renderers: Record<string, SectionComponent> = {
  'simmer.fridgeHero': FridgeHero,
  'simmer.itinerary': Itinerary,
  'simmer.note': Note,
  'simmer.rule': Rule,
  'simmer.elsewhere': Elsewhere,
  'simmer.crossBrand': CrossBrand,
  'simmer.signoff': Signoff,
  'simmer.menu': Menu,
}
