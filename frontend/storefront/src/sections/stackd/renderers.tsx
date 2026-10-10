// stackd sections — renderers, keyed by variant. See ../README.md.
// Server sections are static imports (they never ship to the browser); client
// sections come from ./lazy so each page loads only the ones it renders.
import type { SectionComponent } from '../types'
import { StackdRule } from './StackdRule'
import { StackdSignoff } from './StackdSignoff'
import {
  StackdSlip, StackdHero, StackdStickers, StackdRoom, StackdVisit, StackdCrossBrand,
} from './lazy'

export const renderers: Record<string, SectionComponent> = {
  'stackd.slip': StackdSlip,
  'stackd.hero': StackdHero,
  'stackd.stickers': StackdStickers,
  'stackd.room': StackdRoom,
  'stackd.visit': StackdVisit,
  'stackd.rule': StackdRule,
  'stackd.crossBrand': StackdCrossBrand,
  'stackd.signoff': StackdSignoff,
}
