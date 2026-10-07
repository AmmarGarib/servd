// Every section renderer, keyed by variant.

import type { SectionComponent } from './types'
import { renderers as servd } from './servd/renderers'
import { renderers as brand } from './brand/renderers'
import { renderers as stackd } from './stackd/renderers'
import { renderers as simmer } from './simmer/renderers'
import { renderers as flipd } from './flipd/renderers'

export const SECTION_RENDERERS: Record<string, SectionComponent> = {
  ...servd, ...brand, ...stackd, ...simmer, ...flipd,
}
