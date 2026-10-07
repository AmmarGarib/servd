// simmer sections — renderers, keyed by variant. See ../README.md.
import type { SectionComponent } from '../types'
import { FridgeHero } from './FridgeHero'
import { Itinerary } from './Itinerary'
import { Note } from './Note'
import { Rule } from './Rule'
import { Elsewhere } from './Elsewhere'
import { CrossBrand } from './CrossBrand'
import { Signoff } from './Signoff'
import { Menu } from './Menu'

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
