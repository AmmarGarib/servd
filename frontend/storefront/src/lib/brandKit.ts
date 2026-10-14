// Brand kit — THE one definition of each brand's look (owner, 2026-10-14:
// "brand colours should be part of the storefront module").
//
// A brand's kit is a SiteLayout `brand:<slug>:kit` (kind 'kit', settings.kit),
// drafted in Admin → Storefront → Brand kit and published by the CEO like any
// page. This file holds:
//   - KIT_CATALOGUE: every bespoke brand's palette (brand-book names), role
//     colours, fonts and images AS THEY ARE TODAY — the defaults. With no kit
//     published every pixel stays as it was.
//   - resolveKit(): defaults ⊕ the brand's live kit (unknown keys dropped,
//     invalid values ignored).
//   - kitCss(): the ONE definition of the `--simmer-*` / `--stackd-*` /
//     `--flipd-*` tokens (they used to be :root blocks in globals.css) plus
//     the `--kit-<slug>-*` role tokens brandSurface() / brandWordmark() read,
//     and @font-face for Library fonts. The root layout injects it once.
//   - kitImage(): section field → kit image → Concept field → bundled default.
//
// Isomorphic and dependency-free (client components import lib/concept.ts,
// which reads this). The fetch lives in ./brandKitFetch.ts (server).
//
// Values are written so the defaults reproduce today's CSS byte-for-byte:
// derived tokens are computed here from the base colours (rgba of a base hex
// with the same alpha string, the Flipd checker SVG with the two colours
// substituted), so a kit edit reaches them too.

import { fontFaceCss, safeFontFamily, type LibraryFont } from './blocks'

// ── Wire types (the kit as stored in settings.kit) ──────────────────────────

/** `#rrggbb` — 6-digit hex only (code appends alpha / OG images need hex). */
export type Hex = string
/** A built-in font id (BUILTIN_FONTS) or `library:<mediaAssetId>`. */
export type FontRef = string
/** An https URL (≤ 1000 chars) or a site path starting `/brand/`. */
export type Src = string

export type KitImageKey = 'logo' | 'wordmark' | 'mascot' | 'badge'
export const KIT_IMAGE_KEYS: readonly KitImageKey[] = ['logo', 'wordmark', 'mascot', 'badge']

export interface BrandKit {
  v: 1
  palette?: Record<string, Hex>
  roles?: { accent?: Hex; surfaceBg?: Hex; surfaceText?: Hex; ordering?: Hex }
  fonts?: { display?: FontRef; body?: FontRef }
  images?: Partial<Record<KitImageKey, Src>>
}

/** A Library font a kit refers to, as GET /site-layouts/kits/live resolves it. */
export interface KitFontFile { id: string; family: string; url: string; format?: string | null }

/** One brand's live kit (GET /site-layouts/kits/live → kits[slug]). */
export interface LiveKitEntry { kit: BrandKit; version: number; fonts: KitFontFile[] }
export type LiveKits = Record<string, LiveKitEntry>

// ── Validation (shared by the fetch, the editor frame and resolveKit) ───────

export const HEX_RE = /^#[0-9a-fA-F]{6}$/
const PALETTE_KEY_RE = /^[a-z][a-z0-9-]{0,30}$/
export const KIT_BRAND_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/
const LIBRARY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isHex = (v: unknown): v is Hex => typeof v === 'string' && HEX_RE.test(v)

/** A kit image source: https URL ≤ 1000 chars, or a bundled `/brand/…` path. */
export function isKitSrc(v: unknown): v is Src {
  if (typeof v !== 'string' || v.length < 1 || v.length > 1000) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f"'()<>\\]/.test(v)) return false
  if (v.startsWith('/brand/')) return !v.includes('..') && !v.startsWith('/brand//')
  return /^https:\/\/[^/]/i.test(v)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A kit as the storefront will read it: only well-formed fields survive.
 *  Unknown palette keys are kept here (the catalogue drops them per brand in
 *  resolveKit); anything malformed is dropped = "use the default". */
export function normalizeKit(v: unknown): BrandKit {
  const out: BrandKit = { v: 1 }
  if (!isObj(v)) return out
  if (isObj(v['palette'])) {
    const p: Record<string, Hex> = {}
    for (const [k, c] of Object.entries(v['palette']).slice(0, 24)) if (PALETTE_KEY_RE.test(k) && isHex(c)) p[k] = c
    if (Object.keys(p).length) out.palette = p
  }
  if (isObj(v['roles'])) {
    const r = v['roles']
    const roles: NonNullable<BrandKit['roles']> = {}
    for (const k of ['accent', 'surfaceBg', 'surfaceText', 'ordering'] as const) if (isHex(r[k])) roles[k] = r[k] as Hex
    if (Object.keys(roles).length) out.roles = roles
  }
  if (isObj(v['fonts'])) {
    const f = v['fonts']
    const fonts: NonNullable<BrandKit['fonts']> = {}
    for (const k of ['display', 'body'] as const) if (isFontRef(f[k])) fonts[k] = f[k] as FontRef
    if (Object.keys(fonts).length) out.fonts = fonts
  }
  if (isObj(v['images'])) {
    const i = v['images']
    const images: NonNullable<BrandKit['images']> = {}
    for (const k of KIT_IMAGE_KEYS) if (isKitSrc(i[k])) images[k] = i[k] as Src
    if (Object.keys(images).length) out.images = images
  }
  return out
}

/** Library fonts as the API (or the editor) sends them: bounded, safe-looking. */
export function normalizeKitFonts(v: unknown): KitFontFile[] {
  if (!Array.isArray(v)) return []
  const out: KitFontFile[] = []
  for (const f of v.slice(0, 10)) {
    if (!isObj(f)) continue
    const id = typeof f['id'] === 'string' ? f['id'].replace(/^library:/, '') : ''
    const family = safeFontFamily(f['family'])
    const url = typeof f['url'] === 'string' ? f['url'].trim() : ''
    if (!LIBRARY_ID_RE.test(id) || !family || url.length > 2000 || !/^(https:\/\/|\/(?!\/))/i.test(url)) continue
    out.push({ id, family, url, format: typeof f['format'] === 'string' ? f['format'].slice(0, 20) : null })
  }
  return out
}

/** One live-kit entry, or null when it isn't one. */
export function normalizeLiveEntry(v: unknown): LiveKitEntry | null {
  if (!isObj(v) || !isObj(v['kit'])) return null
  const version = typeof v['version'] === 'number' && Number.isFinite(v['version']) ? v['version'] : 0
  return { kit: normalizeKit(v['kit']), version, fonts: normalizeKitFonts(v['fonts']) }
}

/** The `{ kits: { [slug]: entry } }` body of GET /site-layouts/kits/live. */
export function normalizeLiveKits(body: unknown): LiveKits {
  const kits = isObj(body) && isObj(body['kits']) ? body['kits'] : {}
  const out: LiveKits = {}
  for (const [slug, e] of Object.entries(kits)) {
    if (!KIT_BRAND_SLUG_RE.test(slug)) continue
    const entry = normalizeLiveEntry(e)
    if (entry) out[slug] = entry
  }
  return out
}

// ── Fonts ───────────────────────────────────────────────────────────────────

export interface BuiltinFont { id: string; label: string; stack: string }

/** Built-in fonts: the next/font families loaded in app/layout.tsx (by their
 *  CSS variables) plus two system faces. The stacks are exactly the strings
 *  the brand tokens used before the kit existed. */
export const BUILTIN_FONTS: readonly BuiltinFont[] = [
  { id: 'amarante',       label: 'Amarante',             stack: "var(--font-amarante), serif" },
  { id: 'playfair',       label: 'Playfair Display',     stack: "var(--font-playfair), 'Bodoni Moda', Georgia, serif" },
  { id: 'inter',          label: 'Inter',                stack: 'var(--font-inter), system-ui, sans-serif' },
  { id: 'poppins',        label: 'Poppins',              stack: 'var(--font-poppins), system-ui, sans-serif' },
  { id: 'alfa-slab',      label: 'Alfa Slab One',        stack: "var(--font-alfa-slab), 'Bevan', Georgia, serif" },
  { id: 'bricolage',      label: 'Bricolage Grotesque',  stack: 'var(--font-bricolage), var(--font-inter), system-ui, sans-serif' },
  { id: 'syne',           label: 'Syne',                 stack: 'var(--font-syne), var(--font-bricolage), system-ui, sans-serif' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono',       stack: "var(--font-jetbrains-mono), 'Courier New', monospace" },
  { id: 'times',          label: 'Times (system)',       stack: "'Times New Roman', Times, serif" },
  { id: 'georgia',        label: 'Georgia (system)',     stack: "Georgia, 'Times New Roman', serif" },
]
const BUILTIN_BY_ID = new Map(BUILTIN_FONTS.map((f) => [f.id, f]))
export const isBuiltinFont = (id: string): boolean => BUILTIN_BY_ID.has(id)

export function isFontRef(v: unknown): v is FontRef {
  if (typeof v !== 'string') return false
  if (BUILTIN_BY_ID.has(v)) return true
  return v.startsWith('library:') && LIBRARY_ID_RE.test(v.slice('library:'.length))
}

// ── The catalogue (today's look) ────────────────────────────────────────────

export interface KitPaletteEntry { key: string; label: string; default: Hex }

/** A role colour: a fixed hex, or "follow this palette entry". */
type RoleDefault = Hex | { follow: string }

export interface KitCatalogueEntry {
  /** Base colours, emitted as `--<slug>-<key>` (names exactly as before). */
  palette: KitPaletteEntry[]
  /** Tokens computed from the palette (`--<slug>-<name>`), in emit order. */
  derived: Array<{ name: string; value: (p: Record<string, Hex>) => string }>
  /** Tokens that are not part of the kit (emitted as is). */
  fixed: Array<{ name: string; value: string }>
  roles: { accent: RoleDefault; surfaceBg: RoleDefault; surfaceText: RoleDefault }
  /** Alpha strings of the surface's muted text and hairlines, over surfaceText. */
  surfaceAlpha: { muted: string; border: string }
  fonts: { display: string; body: string }
  images: Partial<Record<KitImageKey, string>>
  /** One line for the admin form (what the kit drives on this brand). */
  note: string
}

/** `rgba(r,g,b,<alpha>)` of a 6-digit hex, alpha kept as written. */
export function rgbaOf(hex: Hex, alpha: string): string {
  const h = hex.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return `rgba(${n(0)},${n(2)},${n(4)},${alpha})`
}

/** `r g b` channels of a 6-digit hex — the value of a `--x-rgb` token, read
 *  as `rgb(var(--x-rgb) / <alpha>)` (the admin's channel-token pattern): the
 *  same colour as rgbaOf() and it needs no color-mix(). */
export function channelsOf(hex: Hex): string {
  const h = hex.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return `${n(0)} ${n(2)} ${n(4)}`
}

/** A variable colour (section field, primaryColor, a var()) at a two-digit
 *  hex alpha (`'22'`, `'cc'`): a 6-digit hex gets the alpha appended, exactly
 *  as the code did before the kit (same pixels, and no color-mix() needed);
 *  anything else is tinted with color-mix(). For a kit palette colour use its
 *  channel token instead: rgb(var(--<brand>-<key>-rgb) / <alpha>). */
export function tintColor(color: string, hexAlpha: string): string {
  if (isHex(color)) return `${color}${hexAlpha}`
  const pct = Math.round((parseInt(hexAlpha, 16) / 255) * 1000) / 10
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/** The Flipd checker tile: navy and bone squares, 36px, as an SVG data URL. */
function checker(light: Hex, dark: Hex): string {
  const l = light.replace('#', '%23')
  const d = dark.replace('#', '%23')
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='${l}'/%3E%3Crect width='18' height='18' fill='${d}'/%3E%3Crect x='18' y='18' width='18' height='18' fill='${d}'/%3E%3C/svg%3E")`
}

export const KIT_CATALOGUE: Record<string, KitCatalogueEntry> = {
  // Simmer (simmer-brand SKILL.md): forest green surface ("tiber"), bone ink,
  // fiery orange signal. Night mode is the web default. Amarante display,
  // Times body.
  simmer: {
    palette: [
      { key: 'green',  label: 'Tiber green',            default: '#06392F' },
      { key: 'bone',   label: 'Bone',                   default: '#EDE6D3' },
      { key: 'walnut', label: 'Walnut',                 default: '#3D2817' },
      { key: 'black',  label: 'Black',                  default: '#0E0E0E' },
      { key: 'orange', label: 'Fiery orange (signal)',  default: '#E94E1B' },
    ],
    derived: [],
    fixed: [],
    roles: { accent: { follow: 'orange' }, surfaceBg: { follow: 'green' }, surfaceText: '#F3ECDE' },
    surfaceAlpha: { muted: '0.62', border: '0.14' },
    fonts: { display: 'amarante', body: 'times' },
    images: {},
    note: 'Simmer has no image assets: its wordmark is the name set in the display font. One orange signal per screen.',
  },
  // Stackd: Pantone 19-2025 Red Plum field, 9180 cream type, 635 pale blue as
  // the one cool accent. Warm greys only.
  stackd: {
    palette: [
      { key: 'plum',      label: 'Red Plum (Pantone 19-2025)',  default: '#7C2946' },
      { key: 'plum-dark', label: 'Deep plum',                   default: '#3D1122' },
      { key: 'cream',     label: 'Cream (Pantone 9180)',        default: '#FCE8CE' },
      { key: 'sky',       label: 'Pale blue (Pantone 635)',     default: '#9BD3DD' },
      { key: 'cement',    label: 'Warm cement',                 default: '#2E1922' },
    ],
    derived: [
      { name: 'cream-dim',   value: (p) => rgbaOf(p['cream']!, '0.72') },
      { name: 'cream-faint', value: (p) => rgbaOf(p['cream']!, '0.42') },
      { name: 'line',        value: (p) => rgbaOf(p['cream']!, '0.22') },
      { name: 'line-faint',  value: (p) => rgbaOf(p['cream']!, '0.10') },
    ],
    fixed: [{ name: 'mono', value: "var(--font-jetbrains-mono), 'Courier New', monospace" }],
    roles: { accent: { follow: 'cream' }, surfaceBg: { follow: 'plum' }, surfaceText: { follow: 'cream' } },
    surfaceAlpha: { muted: '0.72', border: '0.20' },
    fonts: { display: 'playfair', body: 'inter' },
    images: { wordmark: '/brand/stackd-wordmark-tagline.png', mascot: '/brand/stackd-mascot.png' },
    note: 'Dim / faint cream and the line colours follow Cream. The mono face stays JetBrains Mono.',
  },
  // Flipd (GS Foods brand book, Sept 2026): three colours — Flipd Blue ink,
  // Smash Mustard field, Bone surface.
  flipd: {
    palette: [
      { key: 'blue',      label: 'Flipd Blue (Pantone 19-4057)',      default: '#294375' },
      { key: 'blue-deep', label: 'Deep blue',                         default: '#1D3159' },
      { key: 'mustard',   label: 'Smash Mustard (Pantone 13-0840)',   default: '#FED561' },
      { key: 'bone',      label: 'Bone (Pantone 9180)',               default: '#F9F0E1' },
    ],
    derived: [
      { name: 'blue-dim',   value: (p) => rgbaOf(p['blue']!, '0.72') },
      { name: 'blue-faint', value: (p) => rgbaOf(p['blue']!, '0.42') },
      { name: 'checker',    value: (p) => checker(p['bone']!, p['blue']!) },
    ],
    fixed: [],
    roles: { accent: { follow: 'blue' }, surfaceBg: { follow: 'blue' }, surfaceText: { follow: 'mustard' } },
    surfaceAlpha: { muted: '0.72', border: '0.22' },
    fonts: { display: 'alfa-slab', body: 'poppins' },
    images: { badge: '/brand/flipd-badge.png' },
    note: 'Dim / faint blue follow Flipd Blue; the checker edge is drawn from Bone and Flipd Blue.',
  },
}

/** Brands with no bespoke entry: role colours as before the kit. */
const GENERIC_SURFACES: Record<string, { bg: Hex; text: Hex; muted: string; border: string }> = {
  servd: { bg: '#6a0dad', text: '#ffffff', muted: '0.72', border: '0.16' },
}
const GENERIC_SURFACE = { bg: '#0B0B0E', text: '#FFFFFF', muted: '0.60', border: '0.10' }
/** The accent a brand with no colour at all falls back to (as before). */
export const GENERIC_ACCENT = '#22c55e'

// ── Resolving ───────────────────────────────────────────────────────────────

export interface ResolvedSurface { bg: string; text: string; muted: string; border: string }

export interface ResolvedKit {
  slug: string
  /** True when the brand has a bespoke catalogue entry (its own tokens). */
  bespoke: boolean
  /** Base colours by key (catalogue keys only). */
  palette: Record<string, Hex>
  /** The website signal colour. */
  accent: string
  /** The ordering / ERP colour the kit sets (null = the Concept's own). */
  ordering: Hex | null
  surface: ResolvedSurface
  fonts: { display: string; body: string }
  /** True when the live kit set that font (generic brands emit a token only then). */
  fontSet: { display: boolean; body: boolean }
  /** @font-face sources for Library fonts the kit uses. */
  fontFaces: LibraryFont[]
  /** Kit image → Concept field → bundled default (null = none). */
  images: Record<KitImageKey, string | null>
  /** The live kit's version (null = nothing published, all defaults). */
  version: number | null
}

/** The Concept fields a kit falls back to. */
export interface KitConceptFields {
  primaryColor?: string | null
  logoUrl?: string | null
  wordmarkUrl?: string | null
  mascotUrl?: string | null
}

function fontStack(ref: FontRef | undefined, dflt: string, files: KitFontFile[], faces: LibraryFont[]): { stack: string; set: boolean } {
  const base = BUILTIN_BY_ID.get(dflt)?.stack ?? 'system-ui, sans-serif'
  if (!ref) return { stack: base, set: false }
  const builtin = BUILTIN_BY_ID.get(ref)
  if (builtin) return { stack: builtin.stack, set: true }
  if (ref.startsWith('library:')) {
    const id = ref.slice('library:'.length)
    const file = files.find((f) => f.id === id)
    const family = file ? safeFontFamily(file.family) : null
    if (file && family) {
      faces.push({ family, url: file.url })
      return { stack: `"${family}", ${base}`, set: true }
    }
  }
  return { stack: base, set: false }
}

/** A brand's look: the catalogue defaults ⊕ its live (or draft) kit. */
export function resolveKit(slug: string, concept?: KitConceptFields | null, live?: LiveKitEntry | null): ResolvedKit {
  const cat = Object.prototype.hasOwnProperty.call(KIT_CATALOGUE, slug) ? KIT_CATALOGUE[slug] : undefined
  const kit = live ? normalizeKit(live.kit) : { v: 1 as const }
  const files = live?.fonts ?? []

  const palette: Record<string, Hex> = {}
  for (const e of cat?.palette ?? []) palette[e.key] = kit.palette?.[e.key] ?? e.default
  const role = (d: RoleDefault): Hex => (typeof d === 'string' ? d : palette[d.follow]!)

  let accent: string
  let surface: ResolvedSurface
  if (cat) {
    accent = kit.roles?.accent ?? role(cat.roles.accent)
    const text = kit.roles?.surfaceText ?? role(cat.roles.surfaceText)
    surface = {
      bg: kit.roles?.surfaceBg ?? role(cat.roles.surfaceBg),
      text, muted: rgbaOf(text, cat.surfaceAlpha.muted), border: rgbaOf(text, cat.surfaceAlpha.border),
    }
  } else {
    accent = kit.roles?.accent ?? concept?.primaryColor ?? GENERIC_ACCENT
    const g = (Object.prototype.hasOwnProperty.call(GENERIC_SURFACES, slug) ? GENERIC_SURFACES[slug] : undefined) ?? GENERIC_SURFACE
    const text = kit.roles?.surfaceText ?? g.text
    surface = { bg: kit.roles?.surfaceBg ?? g.bg, text, muted: rgbaOf(text, g.muted), border: rgbaOf(text, g.border) }
  }

  const fontFaces: LibraryFont[] = []
  const display = fontStack(kit.fonts?.display, cat?.fonts.display ?? 'syne', files, fontFaces)
  const body = fontStack(kit.fonts?.body, cat?.fonts.body ?? 'inter', files, fontFaces)

  const fromConcept: Record<KitImageKey, string | null | undefined> = {
    logo: concept?.logoUrl, wordmark: concept?.wordmarkUrl, mascot: concept?.mascotUrl,
    // The badge has always fallen back to the uploaded wordmark (flipd).
    badge: concept?.wordmarkUrl,
  }
  const images = {} as Record<KitImageKey, string | null>
  for (const k of KIT_IMAGE_KEYS) images[k] = kit.images?.[k] || fromConcept[k] || cat?.images[k] || null

  return {
    slug, bespoke: !!cat, palette, accent, ordering: kit.roles?.ordering ?? null, surface,
    fonts: { display: display.stack, body: body.stack },
    fontSet: { display: display.set, body: body.set },
    fontFaces, images, version: live ? live.version : null,
  }
}

/** Every brand that gets tokens: the bespoke ones, plus any brand with a live kit. */
export function resolveAllKits(live: LiveKits, concepts?: Record<string, KitConceptFields>): ResolvedKit[] {
  const slugs = new Set([...Object.keys(KIT_CATALOGUE), ...Object.keys(live)])
  return [...slugs]
    .filter((s) => KIT_BRAND_SLUG_RE.test(s))
    .map((s) => resolveKit(s, concepts?.[s] ?? null, Object.prototype.hasOwnProperty.call(live, s) ? live[s] : null))
}

/** The image a brand shows when no section field sets one: kit → Concept → bundled. */
export function kitImage(resolved: ResolvedKit | null | undefined, key: KitImageKey): string | null {
  return resolved?.images[key] ?? null
}

// ── CSS ─────────────────────────────────────────────────────────────────────

/** The role-token name of a brand: `--kit-<slug>-<role>`. */
export const kitVar = (slug: string, role: 'accent' | 'surface-bg' | 'surface-text' | 'surface-muted' | 'surface-border' | 'display' | 'body') =>
  `--kit-${slug}-${role}`

/** Declarations (no selector) for one resolved brand. */
export function kitDeclarations(k: ResolvedKit): string[] {
  if (!KIT_BRAND_SLUG_RE.test(k.slug)) return []
  const out: string[] = []
  const cat = k.bespoke ? KIT_CATALOGUE[k.slug]! : null
  if (cat) {
    for (const e of cat.palette) out.push(`--${k.slug}-${e.key}:${k.palette[e.key]}`)
    // Channel tokens (`--<slug>-<key>-rgb: r g b`) for translucent uses:
    // rgb(var(--simmer-bone-rgb) / 0.2) — never color-mix() of the colour.
    for (const e of cat.palette) out.push(`--${k.slug}-${e.key}-rgb:${channelsOf(k.palette[e.key]!)}`)
    for (const d of cat.derived) out.push(`--${k.slug}-${d.name}:${d.value(k.palette)}`)
    out.push(`--${k.slug}-display:${k.fonts.display}`, `--${k.slug}-body:${k.fonts.body}`)
    for (const f of cat.fixed) out.push(`--${k.slug}-${f.name}:${f.value}`)
  }
  // Role tokens (brandSurface / brandWordmark read these with a fallback).
  // Generic brands only get them when a live kit exists, so nothing new is
  // emitted for a brand nobody has edited.
  if (cat || k.version !== null) {
    if (cat || isHex(k.accent)) out.push(`${kitVar(k.slug, 'accent')}:${k.accent}`)
    if (isHex(k.accent)) out.push(`${kitVar(k.slug, 'accent')}-rgb:${channelsOf(k.accent)}`)
    out.push(
      `${kitVar(k.slug, 'surface-bg')}:${k.surface.bg}`,
      `${kitVar(k.slug, 'surface-text')}:${k.surface.text}`,
      `${kitVar(k.slug, 'surface-muted')}:${k.surface.muted}`,
      `${kitVar(k.slug, 'surface-border')}:${k.surface.border}`,
    )
    if (isHex(k.surface.bg)) out.push(`${kitVar(k.slug, 'surface-bg')}-rgb:${channelsOf(k.surface.bg)}`)
    if (isHex(k.surface.text)) out.push(`${kitVar(k.slug, 'surface-text')}-rgb:${channelsOf(k.surface.text)}`)
    if (!cat && k.fontSet.display) out.push(`${kitVar(k.slug, 'display')}:${k.fonts.display}`)
    if (!cat && k.fontSet.body) out.push(`${kitVar(k.slug, 'body')}:${k.fonts.body}`)
  }
  return out
}

/** Never let a value close the <style> element it is injected into. */
const styleSafe = (css: string) => css.replace(/</g, '\\3c ')

/** `:root{…}` for the given brands plus @font-face for their Library fonts. */
export function kitCss(kits: ResolvedKit[] | Record<string, ResolvedKit>): string {
  const list = Array.isArray(kits) ? kits : Object.values(kits)
  const decls = list.flatMap(kitDeclarations)
  const faces = fontFaceCss(list.flatMap((k) => k.fontFaces))
  return styleSafe(`${faces}:root{${decls.join(';')}}`)
}

/** The whole-site kit stylesheet: every brand, defaults ⊕ live kits. */
export function allKitsCss(live: LiveKits): string {
  return kitCss(resolveAllKits(live))
}

// ── The live-kit snapshot (server) ──────────────────────────────────────────
// brandKitFetch.ts stores the latest live kits here so the synchronous
// helpers in lib/concept.ts (brandAccent) can read them. On the client it is
// always empty; client code reads the brand through CSS tokens instead.

let snapshot: LiveKits = {}
export function setLiveKitsSnapshot(kits: LiveKits): void { snapshot = kits }
export function liveKitsSnapshot(): LiveKits { return snapshot }

/** One brand's live entry from a map (own-property safe). */
export function liveEntry(kits: LiveKits | null | undefined, slug: string): LiveKitEntry | null {
  return kits && Object.prototype.hasOwnProperty.call(kits, slug) ? kits[slug]! : null
}

// ── The catalogue the admin builds its form from ────────────────────────────

/** GET /api/storefront-brand-kit body. */
export function kitCatalogueJson() {
  const roleHex = (cat: KitCatalogueEntry, d: RoleDefault) =>
    typeof d === 'string' ? d : cat.palette.find((e) => e.key === d.follow)!.default
  const follows = (d: RoleDefault) => (typeof d === 'string' ? null : d.follow)
  const brands: Record<string, unknown> = {}
  for (const [slug, cat] of Object.entries(KIT_CATALOGUE)) {
    brands[slug] = {
      palette: cat.palette.map(({ key, label, default: d }) => ({ key, label, default: d })),
      roles: {
        accent: roleHex(cat, cat.roles.accent),
        surfaceBg: roleHex(cat, cat.roles.surfaceBg),
        surfaceText: roleHex(cat, cat.roles.surfaceText),
        ordering: null,   // = the brand's own primaryColor until a kit sets it
      },
      // Which palette entry a role follows when the kit leaves it empty.
      roleFollows: {
        accent: follows(cat.roles.accent), surfaceBg: follows(cat.roles.surfaceBg), surfaceText: follows(cat.roles.surfaceText),
      },
      fonts: { ...cat.fonts },
      images: { logo: null, wordmark: null, mascot: null, badge: null, ...cat.images },
      note: cat.note,
    }
  }
  return {
    fonts: BUILTIN_FONTS.map(({ id, label, stack }) => ({ id, label, stack })),
    brands,
    // Any brand without a bespoke entry: no palette, these role defaults
    // (accent = the brand's primaryColor, else this), Syne / Inter.
    generic: {
      palette: [],
      roles: { accent: GENERIC_ACCENT, surfaceBg: GENERIC_SURFACE.bg, surfaceText: GENERIC_SURFACE.text, ordering: null },
      roleFollows: { accent: null, surfaceBg: null, surfaceText: null },
      fonts: { display: 'syne', body: 'inter' },
      images: { logo: null, wordmark: null, mascot: null, badge: null },
      note: 'This brand uses the shared brand pages: the signal colour, the footer band and the logo drive its look.',
    },
  }
}
