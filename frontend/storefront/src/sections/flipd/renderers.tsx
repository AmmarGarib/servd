// flipd sections — renderers, keyed by variant. See ../README.md.
import type { SectionComponent } from '../types'
import { FlipdSpecHeroSection } from './SpecHero'
import {
  FlipdChecker, FlipdMission, FlipdValues, FlipdVisit, FlipdCrossBrand, FlipdSignOff,
} from './HomeSections'
import { FlipdMenuSection } from './MenuSection'

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
