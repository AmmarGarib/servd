// stackd sections — renderers, keyed by variant. See ../README.md.
import type { SectionComponent } from '../types'
import { StackdSlip } from './StackdSlip'
import { StackdHero } from './StackdHero'
import { StackdStickers } from './StackdStickers'
import { StackdRoom } from './StackdRoom'
import { StackdVisit } from './StackdVisit'
import { StackdRule } from './StackdRule'
import { StackdCrossBrand } from './StackdCrossBrand'
import { StackdSignoff } from './StackdSignoff'

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
