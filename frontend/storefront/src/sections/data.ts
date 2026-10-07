// Live data sections read (server-side). Shared by every group so menu
// sections don't each carry their own fetch.

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export interface MenuModifierGroup {
  id: string
  name: string
  modifiers?: { id: string; name: string; priceDeltaCents?: number }[]
}
export interface MenuItem {
  id: string; name: string; description: string | null; priceCents: number
  imageUrl: string | null
  videoUrl: string | null
  isAvailable?: boolean
  modifierGroups?: MenuModifierGroup[]
}
export interface MenuCategory { id: string; name: string; items: MenuItem[] }

/** A brand's published menu ([] when none, or the API is down). */
export async function fetchBrandMenu(conceptSlug: string): Promise<MenuCategory[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(conceptSlug)}/menu`, { cache: 'no-store' })
    if (!res.ok) return []
    // Bare array (legacy) or { concept, categories } (current) — handle both.
    const payload = await res.json() as MenuCategory[] | { categories?: MenuCategory[] }
    return Array.isArray(payload) ? payload : (payload.categories ?? [])
  } catch {
    return []
  }
}

/** True when at least one category has an item. */
export function hasMenuItems(categories: MenuCategory[]): boolean {
  return categories.some((c) => (c.items?.length ?? 0) > 0)
}

export const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
