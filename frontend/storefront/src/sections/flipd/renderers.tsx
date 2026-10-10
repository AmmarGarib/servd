// flipd sections — renderers, keyed by variant. See ../README.md.
// Server sections are static imports (they never ship to the browser); client
// sections come from ./lazy so each page loads only the ones it renders.
import type { SectionComponent } from '../types'
import { FlipdMenuSection } from './MenuSection'
import {
  FlipdSpecHeroSection,
  FlipdChecker, FlipdMission, FlipdValues, FlipdVisit, FlipdCrossBrand, FlipdSignOff,
} from './lazy'

export const renderers: Record<string, SectionComponent> = {
  'flipd.checker':    FlipdChecker,
  'flipd.specHero':   FlipdSpecHeroSection,
  'flipd.mission':    FlipdMission,
  'flipd.values':     FlipdValues,
  'flipd.visit':      FlipdVisit,
  'flipd.crossBrand': FlipdCrossBrand,
  'flipd.signOff':    FlipdSignOff,
  'flipd.menu':       FlipdMenuSection,
}
