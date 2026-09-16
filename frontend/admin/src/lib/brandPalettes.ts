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
  // Keyed `stackd`, not `stax`. The brand was renamed and the lookup is by
  // slug, so the old key meant brandPalette('stackd') returned null and the
  // admin showed no palette at all for it — while the swatches it did hold
  // were the dead navy-grey stax set.
  stackd: {
    accent: '#FCE8CE', surfaceBg: '#7C2946', surfaceText: '#FCE8CE',
    swatches: [
      { name: 'Red Plum (Pantone 19-2025)', hex: '#7C2946' },
      { name: 'Plum dark', hex: '#3D1122' },
      { name: 'Cream (Pantone 9180)', hex: '#FCE8CE' },
      { name: 'Pale blue (Pantone 635)', hex: '#9BD3DD' },
      { name: 'Cement', hex: '#2E1922' },
    ],
    note: 'Warm industrial — red plum field, cream type, one cool pale-blue accent.',
  },
  flipd: {
    accent: '#294375', surfaceBg: '#294375', surfaceText: '#FED561',
    swatches: [
      { name: 'Flipd Blue (Pantone 19-4057)', hex: '#294375' },
      { name: 'Blue deep', hex: '#1D3159' },
      { name: 'Smash Mustard (Pantone 13-0840)', hex: '#FED561' },
      { name: 'Bone (Pantone 9180)', hex: '#F9F0E1' },
    ],
    note: 'Blue + mustard with a navy/bone checker. Not padel — the court is never borrowed.',
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
