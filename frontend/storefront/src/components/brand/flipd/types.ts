// Shapes of the live menu API (`/storefront/flipd/menu`) as Flipd reads it.

export interface FlipdModifier {
  id: string
  name: string
  priceDeltaCents?: number
}
export interface FlipdModifierGroup {
  id: string
  name: string
  modifiers?: FlipdModifier[]
}
export interface FlipdMenuItemLive {
  id: string
  name: string
  description: string | null
  priceCents: number
  isAvailable?: boolean
  modifierGroups?: FlipdModifierGroup[]
}
export interface FlipdMenuCategoryLive {
  id: string
  name: string
  items: FlipdMenuItemLive[]
}

export const fmtPkr = (cents: number) =>
  `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

/** Modifier names ("Single / Double / Lettuce wrap"), flat and de-duplicated. */
export function itemOptions(item: FlipdMenuItemLive): string[] {
  return Array.from(
    new Set(
      (item.modifierGroups ?? [])
        .flatMap((g) => (g.modifiers ?? []).map((m) => m.name))
        .filter(Boolean),
    ),
  )
}
