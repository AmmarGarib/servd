// Storefront sections, admin side. The storefront owns the catalogue (every
// section's fields + defaults and each page's default composition, in
// frontend/storefront/src/sections) and serves it at /api/storefront-sections.
// The editor builds its palette, its forms and a page's starting blocks from
// it, so there is no second copy here to drift. Types mirror
// frontend/storefront/src/sections/types.ts — keep them in step.

import { useQuery } from '@tanstack/react-query'
import { newBlock, newId, type Block, type BlockType } from './blocks'
import { STOREFRONT_URL } from './content'

interface FieldBase { key: string; label: string; hint?: string }

export type FieldSpec =
  | (FieldBase & { kind: 'text' })
  | (FieldBase & { kind: 'textarea'; rows?: number })
  | (FieldBase & { kind: 'image' })
  | (FieldBase & { kind: 'video' })
  | (FieldBase & { kind: 'url' })
  | (FieldBase & { kind: 'link' })
  | (FieldBase & { kind: 'color' })
  | (FieldBase & { kind: 'toggle' })
  | (FieldBase & { kind: 'number'; min?: number; max?: number; step?: number })
  | (FieldBase & { kind: 'select'; options: Array<{ value: string; label: string }> })
  | (FieldBase & { kind: 'list'; item: FieldSpec[]; itemLabel?: string; max?: number })

export interface SectionSpec {
  variant: string
  label: string
  group: string
  description?: string
  icon?: string
  pages: string[]
  fields: FieldSpec[]
  defaults: Record<string, unknown>
  summaryKey?: string
}

export interface PageDefault {
  slug: string
  sections: Array<{ variant: string; fields?: Record<string, unknown> }>
}

export interface SectionCatalog { specs: SectionSpec[]; pages: PageDefault[] }

// The loaded catalogue, for the synchronous helpers (newBlock, summaries).
let CATALOG: SectionCatalog = { specs: [], pages: [] }
let BY_VARIANT = new Map<string, SectionSpec>()
let LOADED = false

function setCatalog(c: SectionCatalog) {
  CATALOG = c
  BY_VARIANT = new Map(c.specs.map((s) => [s.variant, s]))
  LOADED = true
}

/** True once the storefront's catalogue has loaded in this tab. Until then a
 *  section without a spec is "the storefront didn't answer", not "removed". */
export function isCatalogLoaded(): boolean {
  return LOADED
}

/** How long the editor waits for the storefront before calling it down. */
const CATALOG_TIMEOUT_MS = 8_000

/** The storefront host the catalogue comes from, for messages ("servd.pk").
 *  A function, not a constant: content.ts and this file import each other. */
export function storefrontHost(): string {
  try { return new URL(STOREFRONT_URL).host } catch { return STOREFRONT_URL }
}

/** What the editor says when the catalogue can't be fetched. The storefront
 *  host serves it, not the API, so this must never read as "the API is down". */
export function sectionsUnavailableMessage(): string {
  return `The storefront (${storefrontHost()}) didn't answer, so the list of page sections can't load. Pop-ups and the Library still work.`
}

/** The catalogue fetch failed. `message` is the plain-words cause for the
 *  screen; `detail` the technical reason (network error, HTTP status). */
export class SectionCatalogError extends Error {
  /** `timedOut`: the storefront hung past CATALOG_TIMEOUT_MS. That is final
   *  (no automatic retry) so the editor reaches its error state in 8 s. */
  constructor(readonly detail: string, readonly timedOut = false) {
    super(sectionsUnavailableMessage())
    this.name = 'SectionCatalogError'
  }
}

/** The storefront's section catalogue. Errors are shown where it is used
 *  (meta.inlineErrors keeps the global toast out of it — that toast is about
 *  the API, and this request goes to the storefront host). Pop-ups use no
 *  sections: pass `enabled: false` there so they never wait on it. */
export function useSectionCatalog(opts: { enabled?: boolean } = {}) {
  return useQuery<SectionCatalog>({
    queryKey: ['storefront-section-catalog'],
    queryFn: async ({ signal }) => {
      // A storefront that hangs must not hold the editor: give up after 8 s
      // (the editor opens without sections and says why).
      const url = `${STOREFRONT_URL}/api/storefront-sections`
      const ctrl = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, CATALOG_TIMEOUT_MS)
      const onAbort = () => ctrl.abort()
      signal?.addEventListener('abort', onAbort)
      const late = () => new SectionCatalogError(`No answer from ${STOREFRONT_URL} within ${CATALOG_TIMEOUT_MS / 1000} seconds`, true)
      try {
        let res: Response
        try {
          res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
        } catch (e) {
          throw timedOut ? late() : new SectionCatalogError(`No answer from ${STOREFRONT_URL} (${(e as Error).message || 'network error'})`)
        }
        if (!res.ok) throw new SectionCatalogError(`${url} answered HTTP ${res.status}`)
        let c: SectionCatalog
        try {
          c = (await res.json()) as SectionCatalog
        } catch {
          throw timedOut ? late() : new SectionCatalogError(`${url} did not return JSON`)
        }
        if (!c || !Array.isArray(c.specs) || !Array.isArray(c.pages)) {
          throw new SectionCatalogError(`${url} returned an unexpected shape`)
        }
        setCatalog(c)
        return c
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
    enabled: opts.enabled ?? true,
    // The app-wide `retry: 1` would turn the 8 s timeout into ~17 s. A hang
    // is final (the banner has its own Retry); a quick failure such as a
    // refused connection or a 5xx may still be retried once.
    retry: (failures, err) => failures < 1 && !(err instanceof SectionCatalogError && err.timedOut),
    meta: { inlineErrors: true },
    staleTime: 5 * 60_000,
  })
}

export function sectionSpec(variant: string | undefined): SectionSpec | undefined {
  return variant ? BY_VARIANT.get(variant) : undefined
}

/** `brand:*:about` / `servd:*` / `*` against a slug. */
export function slugMatches(pattern: string, slug: string): boolean {
  if (pattern === '*' || pattern === slug) return true
  const p = pattern.split(':')
  const s = slug.split(':')
  return p.length === s.length && p.every((part, i) => part === '*' || part === s[i])
}

/** The sections the palette offers on this page. */
export function sectionsForPage(slug: string): SectionSpec[] {
  return CATALOG.specs.filter((s) => s.pages.some((p) => slugMatches(p, slug)))
}

/** The page's starting blocks (its design with today's content). */
export function pageDefaultBlocks(slug: string): Block[] {
  const def = CATALOG.pages.find((p) => p.slug === slug)
    ?? CATALOG.pages.find((p) => p.slug !== slug && slugMatches(p.slug, slug))
  return (def?.sections ?? []).map((s) => ({
    id: newId(), type: 'section', variant: s.variant, ...(s.fields && { fields: structuredClone(s.fields) }),
  } as Block))
}

/** True when the storefront ships a design for this page. */
export function hasPageDefault(slug: string): boolean {
  return CATALOG.pages.some((p) => p.slug === slug || slugMatches(p.slug, slug))
}

/** A fresh section element. Fields stay empty: the section shows its
    defaults until a field is edited, so later design updates still reach it. */
export function newSectionBlock(variant: string): Block {
  return { id: newId(), type: 'section', variant } as Block
}

/** A field's current value: the block's own, else the section default. */
export function fieldValue(block: Block, spec: SectionSpec, key: string): unknown {
  const own = (block.fields as Record<string, unknown> | undefined)?.[key]
  return own !== undefined && own !== null ? own : spec.defaults[key]
}

export function sectionSummary(block: Block): string {
  const spec = sectionSpec(block.variant as string | undefined)
  if (!spec) {
    return isCatalogLoaded()
      ? `Unknown section (${String(block.variant ?? '')})`
      : `${String(block.variant ?? 'Section')} (its form loads from the storefront)`
  }
  const v = spec.summaryKey ? fieldValue(block, spec, spec.summaryKey) : undefined
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 90)
  if (v && typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text ?? '')
  return spec.description ?? ''
}

/** Palette keys: a built-in block type, or `section:<variant>`. */
export const SECTION_KEY = 'section:'
export const isSectionKey = (k: string) => k.startsWith(SECTION_KEY)

/** A new element for a palette key. */
export function makeBlock(key: string): Block {
  return isSectionKey(key) ? newSectionBlock(key.slice(SECTION_KEY.length)) : newBlock(key as BlockType)
}

/** What the palette shows for one key. */
export interface PaletteItem { key: string; label: string; description: string; icon: string; group: string }

export function sectionPaletteItems(slug: string): PaletteItem[] {
  // The page's own sections (named for this exact page, e.g. brand:flipd)
  // first, then the shared ones (brand:*, *).
  const own = (s: SectionSpec) => (s.pages.includes(slug) ? 0 : 1)
  return sectionsForPage(slug).slice().sort((a, b) => own(a) - own(b)).map((s) => ({
    key: `${SECTION_KEY}${s.variant}`,
    label: s.label,
    description: s.description ?? '',
    icon: (s.icon ?? s.label.slice(0, 2)).slice(0, 3).toUpperCase(),
    group: s.group,
  }))
}
