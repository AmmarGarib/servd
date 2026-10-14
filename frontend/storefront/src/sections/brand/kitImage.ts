// A brand section's image from the brand kit: kit image → Concept field →
// bundled default (resolveKit does the chain; lib/brandKit.ts is the one
// definition). A section's own field is checked by the caller BEFORE this.
//
// `ctx.kits` carries the live kits — and, inside the editor frame, the DRAFT
// kit laid over its brand — so a draft logo shows in the preview. Without it
// the live-kit snapshot (server) and the Concept's synced fields answer.
import { kitImage, liveEntry, liveKitsSnapshot, resolveKit, type KitImageKey } from '../../lib/brandKit'
import type { Concept } from '../../lib/concept'
import type { SectionContext } from '../types'

export function sectionKitImage(ctx: SectionContext, key: KitImageKey, fallbackConcept?: Concept): string | null {
  const c = ctx.concept ?? fallbackConcept
  if (!c) return null
  return kitImage(resolveKit(c.slug, c, liveEntry(ctx.kits ?? liveKitsSnapshot(), c.slug)), key)
}
