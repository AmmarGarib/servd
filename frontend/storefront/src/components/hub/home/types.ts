import type { brandStory } from '../../../lib/concept'

/** One live kitchen as the home sections see it — already ordered
 *  (stackd, simmer, flipd) and with the display name brand-cased. */
export interface HomeBrand {
  id: string
  slug: string
  /** Stored name — used for WhatsApp prefill, which lowercases it anyway. */
  rawName: string
  /** User-visible name via formatBrandName (simmer/stackd always lowercase). */
  name: string
  accent: string
  story: ReturnType<typeof brandStory>
  img: string
}
