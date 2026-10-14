// The storefront's brand-kit catalogue, admin side. The storefront owns it
// (every brand's palette entries with their labels and defaults, the role,
// font and image defaults, and the list of built-in fonts) and serves it at
// /api/storefront-brand-kit. The kit editor and the read-only kit card on
// Marketing -> Brands build their forms from it, so there is no second copy of
// a brand's colours here to drift. Fetched like lib/sections.ts fetches the
// section catalogue: with a timeout, and with meta.inlineErrors so the global
// toast (which is about the API) stays out of it.

import { useQuery } from '@tanstack/react-query'
import { STOREFRONT_URL, isHex6, type BrandKit, type KitImageKey, type KitRoleKey } from '../../lib/content'
import { storefrontHost } from '../../lib/sections'

export interface KitCatalogFont { id: string; label: string; stack: string }
export interface KitCatalogPaletteEntry { key: string; label: string; default: string }
export interface KitCatalogBrand {
  palette: KitCatalogPaletteEntry[]
  roles: Partial<Record<KitRoleKey, string>>
  fonts: { display?: string; body?: string }
  images: Partial<Record<KitImageKey, string>>
  note?: string
}
export interface KitCatalog { fonts: KitCatalogFont[]; brands: Record<string, KitCatalogBrand> }

const TIMEOUT_MS = 8_000

export class KitCatalogError extends Error {
  constructor(readonly detail: string) {
    super(`The storefront (${storefrontHost()}) didn't answer, so the brand colours, fonts and pictures can't load.`)
    this.name = 'KitCatalogError'
  }
}

/** A brand the catalogue has no entry for (a new brand): no palette entries,
 *  nothing to fall back on but what the brand itself carries. */
export const EMPTY_KIT_BRAND: KitCatalogBrand = { palette: [], roles: {}, fonts: {}, images: {} }

export function useBrandKitCatalog() {
  return useQuery<KitCatalog>({
    queryKey: ['storefront-brand-kit-catalog'],
    queryFn: async ({ signal }) => {
      const url = `${STOREFRONT_URL}/api/storefront-brand-kit`
      const ctrl = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, TIMEOUT_MS)
      const onAbort = () => ctrl.abort()
      signal?.addEventListener('abort', onAbort)
      try {
        let res: Response
        try {
          res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
        } catch (e) {
          throw new KitCatalogError(timedOut ? `No answer from ${STOREFRONT_URL} within ${TIMEOUT_MS / 1000} seconds` : `No answer from ${STOREFRONT_URL} (${(e as Error).message || 'network error'})`)
        }
        if (!res.ok) throw new KitCatalogError(`${url} answered HTTP ${res.status}`)
        let c: KitCatalog
        try { c = (await res.json()) as KitCatalog } catch { throw new KitCatalogError(`${url} did not return JSON`) }
        if (!c || !Array.isArray(c.fonts) || !c.brands || typeof c.brands !== 'object') {
          throw new KitCatalogError(`${url} returned an unexpected shape`)
        }
        return c
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
    retry: (failures, err) => failures < 1 && err instanceof KitCatalogError && !err.detail.includes('within'),
    meta: { inlineErrors: true },
    staleTime: 5 * 60_000,
  })
}

export function brandCatalog(catalog: KitCatalog | undefined, slug: string): KitCatalogBrand {
  const b = catalog?.brands?.[slug]
  if (!b) return EMPTY_KIT_BRAND
  return {
    palette: Array.isArray(b.palette) ? b.palette : [],
    roles: b.roles ?? {},
    fonts: b.fonts ?? {},
    images: b.images ?? {},
    note: b.note,
  }
}

/** A site path from the catalogue ("/brand/x.png") as an address the admin can show. */
export function storefrontAsset(src: string | undefined | null): string | undefined {
  if (!src) return undefined
  if (/^https:\/\//i.test(src)) return src
  return src.startsWith('/') ? `${STOREFRONT_URL}${src}` : undefined
}

export interface KitLook {
  palette: Array<KitCatalogPaletteEntry & { value: string }>
  roles: Record<KitRoleKey, string | undefined>
  logo: string | undefined
}

/** What a brand looks like with `kit` on top of the catalogue's defaults:
 *  swatches, the four roles and the logo (kit logo, else the brand's own, else
 *  the bundled one). `fallbackOrdering` / `fallbackLogo` come from the brand
 *  itself (primaryColor / logoUrl). */
export function kitLook(cat: KitCatalogBrand, kit: BrandKit | null | undefined, fallbackOrdering?: string | null, fallbackLogo?: string | null): KitLook {
  const pick = (v: string | undefined, d: string | undefined) => (isHex6(v) ? v : d)
  return {
    palette: cat.palette.map((p) => ({ ...p, value: pick(kit?.palette?.[p.key], p.default)! })),
    roles: {
      accent: pick(kit?.roles?.accent, cat.roles.accent),
      surfaceBg: pick(kit?.roles?.surfaceBg, cat.roles.surfaceBg),
      surfaceText: pick(kit?.roles?.surfaceText, cat.roles.surfaceText),
      ordering: pick(kit?.roles?.ordering, cat.roles.ordering ?? (isHex6(fallbackOrdering) ? fallbackOrdering : undefined)),
    },
    logo: storefrontAsset(kit?.images?.logo ?? fallbackLogo ?? cat.images.logo),
  }
}
