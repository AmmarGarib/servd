// Brand palettes — admin-side mirror of what the STOREFRONT actually renders.
//
// The storefront paints brand chrome from code, not the DB:
//   • accent      → frontend/storefront/src/lib/concept.ts BRAND_ACCENT_OVERRIDES
//   • surface     → frontend/storefront/src/lib/concept.ts brandSurface()
//   • named set   → frontend/storefront/src/app/globals.css --<brand>-* tokens
// The DB `primaryColor` is ignored for these brands, so the admin would
// otherwise show the wrong colour. This file is the source-of-truth the admin
// displays. Keep it in sync whenever the storefront palette changes.

export interface Swatch { name: string; hex: string }

export interface BrandPalette {
  accent: string        // brand signal / accent (BRAND_ACCENT_OVERRIDES)
  surfaceBg: string     // footer / dark-section background (brandSurface.bg)
  surfaceText: string   // text colour on that surface (brandSurface.text)
  swatches: Swatch[]    // the full named palette
  note?: string
}

export const BRAND_PALETTES: Record<string, BrandPalette> = {
  simmer: {
    accent: '#E94E1B', surfaceBg: '#06392F', surfaceText: '#F3ECDE',
    swatches: [
      { name: 'Tiber green', hex: '#06392F' },
      { name: 'Bone', hex: '#EDE6D3' },
      { name: 'Fiery orange (signal)', hex: '#E94E1B' },
      { name: 'Walnut', hex: '#3D2817' },
    ],
    note: 'Night-mode editorial — forest green + bone, single orange signal per viewport.',
  },
  stax: {
    accent: '#B0B2B8', surfaceBg: '#142834', surfaceText: '#C5C7CC',
    swatches: [
      { name: 'Oceanic noir', hex: '#142834' },
      { name: 'Adept', hex: '#293B47' },
      { name: 'Royal navy', hex: '#45505C' },
      { name: 'Backwater', hex: '#686D77' },
      { name: 'Tulle grey', hex: '#8D8F97' },
      { name: 'Astroscopus grey', hex: '#B0B2B8' },
      { name: 'Flat aluminium', hex: '#C5C7CC' },
    ],
    note: 'Cool industrial navy-grey set (palettepoint).',
  },
  flipd: {
    accent: '#2092E9', surfaceBg: '#090D17', surfaceText: '#EDE6D3',
    swatches: [
      { name: 'Midnight oil (ink)', hex: '#090D17' },
      { name: 'Curious blue', hex: '#2092E9' },
      { name: 'Bone', hex: '#EDE6D3' },
      { name: 'Pale blue', hex: '#E8F4FF' },
    ],
    note: 'Cool diner — curious blue + bone on midnight-oil ink.',
  },
  servd: {
    accent: '#4E2A4F', surfaceBg: '#2D1E2F', surfaceText: '#FFFFFF',
    swatches: [
      { name: 'Plum', hex: '#4E2A4F' },
      { name: 'Obsidian', hex: '#2D1E2F' },
      { name: 'Lavender accent', hex: '#C9A4F2' },
    ],
    note: 'Obsidian plum — the servd house brand.',
  },
}

/** The storefront palette for a brand slug, or null if it has no bespoke one. */
export function brandPalette(slug: string): BrandPalette | null {
  return BRAND_PALETTES[slug] ?? null
}
