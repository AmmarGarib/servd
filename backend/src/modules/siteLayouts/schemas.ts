// Block + settings validation for the storefront content module (decision 41).
//
// Blocks are validated LOOSELY: every block needs an id and a known type, the
// shared animation/motion/font fields are range-checked, and the new block types
// (columns, video, signup_form) get their structural fields checked. Anything
// else passes through untouched — the admin editor adds fields per block type
// and the renderers defend with optional chaining.
//
// Settings are validated more strictly: the renderers switch on the pop-up
// enums and on the A/B split, so those must be trustworthy; the SEO title and
// description go straight into <head>, so they are length-bounded.

import { z } from 'zod'

export const BLOCK_TYPES = [
  'hero', 'cta_button', 'banner', 'text', 'image', 'gallery', 'stat_strip', 'voices',
  'kitchens', 'featured_menu', 'reviews', 'quote', 'spacer', 'divider',
  'columns', 'video', 'signup_form', 'waitlist_form',
  // A designed section of a storefront page: `variant` picks the renderer in
  // frontend/storefront/src/sections, `fields` hold its content (owner,
  // 2026-10-07: every element of every page is edited here).
  'section',
] as const

export const ANIMATIONS = ['none', 'fade-up', 'fade-in', 'slide-left', 'slide-right', 'zoom-in'] as const

// Scroll effects (D4 stage 1). Same order and spelling in all four copies:
// frontend/storefront/src/lib/blocks.ts, frontend/admin/src/lib/blocks.ts,
// mobile/src/content/types.ts and here. A block's `motion` is independent of
// its one-shot entrance `animation`. Keys reserved for later stages (do not
// use them for anything else): keyframes, devices, range, delayMs.
export const MOTION_PRESETS = ['parallax', 'fade', 'grow', 'pin-reveal', 'sticky-stack', 'side-pan', 'text-reveal'] as const
export const MOTION_INTENSITIES = ['subtle', 'medium', 'strong'] as const

/** `{ preset, intensity? }` — intensity absent = 'medium'. Strict: an extra
 *  key, an unknown preset/intensity or a non-object is a validation error. */
export const motionSchema = z.object({
  preset:    z.enum(MOTION_PRESETS),
  intensity: z.enum(MOTION_INTENSITIES).optional(),
}).strict()

export const MAX_TOP_LEVEL_BLOCKS = 80
export const MAX_CONTENT_BYTES = 200_000

const blockBase = z.object({
  id:                  z.string().min(1).max(100),
  type:                z.enum(BLOCK_TYPES),
  animation:           z.enum(ANIMATIONS).optional(),
  animationDelayMs:    z.number().int().min(0).max(3000).optional(),
  animationDurationMs: z.number().int().min(200).max(3000).optional(),
  fontFamily:          z.string().max(120).optional(),
  // Scroll effect. null (a cleared field) means "none" and is dropped.
  motion:              z.preprocess((v) => (v === null ? undefined : v), motionSchema.optional()),
}).passthrough()

const videoFields = z.object({
  url:         z.string().min(1).max(2000),
  posterUrl:   z.string().max(2000).optional(),
  autoplay:    z.boolean().optional(),
  loop:        z.boolean().optional(),
  muted:       z.boolean().optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
}).passthrough()

const signupFields = z.object({
  mode:     z.enum(['signup', 'login']),
  title:    z.string().max(200).optional(),
  subtitle: z.string().max(500).optional(),
}).passthrough()

// `<group>.<name>`, e.g. stackd.hero. Field values are free JSON (bounded by
// MAX_CONTENT_BYTES); the storefront checks every link/media/colour value
// before it reaches an href, src or style (src/sections/safe.ts).
const sectionFields = z.object({
  variant: z.string().regex(/^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9_-]{0,60}$/, 'Unknown section'),
  fields:  z.record(z.unknown()).optional(),
}).passthrough()

function forward(ctx: z.RefinementCtx, r: z.SafeParseReturnType<unknown, unknown>) {
  if (r.success) return
  for (const issue of r.error.issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path })
  }
}

function checkLeaf(b: { type: string }, ctx: z.RefinementCtx) {
  if (b.type === 'video') forward(ctx, videoFields.safeParse(b))
  else if (b.type === 'signup_form') forward(ctx, signupFields.safeParse(b))
  else if (b.type === 'section') forward(ctx, sectionFields.safeParse(b))
}

/** A block that may sit inside a column: anything but another `columns`. */
export const leafBlockSchema = blockBase.superRefine((b, ctx) => {
  if (b.type === 'columns') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'columns cannot be nested inside columns', path: ['type'] })
    return
  }
  checkLeaf(b, ctx)
})

const columnsFields = z.object({
  columns:       z.array(z.array(leafBlockSchema).max(40)).min(2).max(4),
  gap:           z.enum(['sm', 'md', 'lg']).optional(),
  stackOnMobile: z.boolean().optional(),
}).passthrough()

// A `columns` block returns its PARSED children, so the column children get the
// same output rules as top-level blocks (e.g. `motion: null` is dropped from
// the stored JSON, not kept as null).
export const blockSchema = blockBase.transform((b, ctx) => {
  if (b.type !== 'columns') {
    checkLeaf(b, ctx)
    return b
  }
  const r = columnsFields.safeParse(b)
  if (!r.success) {
    forward(ctx, r)
    return b
  }
  return { ...b, columns: r.data.columns }
})

export const blocksSchema = z.array(blockSchema).max(MAX_TOP_LEVEL_BLOCKS)

// '' / null from a cleared form field means "not set".
const optionalIso = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().datetime({ offset: true }).optional(),
)

export const POPUP_KINDS = ['signup', 'login', 'offer', 'announcement'] as const
export const POPUP_DISPLAYS = ['modal', 'bar', 'corner'] as const
export const POPUP_TRIGGERS = ['before_page', 'after_seconds', 'exit_intent', 'scroll'] as const
export const POPUP_AUDIENCES = ['everyone', 'signed_out', 'signed_in', 'never_ordered'] as const
export const POPUP_FREQUENCIES = ['once', 'daily', 'every_visit'] as const

export const popupRulesSchema = z.object({
  popupKind:    z.enum(POPUP_KINDS),
  display:      z.enum(POPUP_DISPLAYS),
  trigger:      z.enum(POPUP_TRIGGERS),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
  scrollPct:    z.number().min(0).max(100).optional(),
  pages:        z.array(z.string().min(1).max(200)).max(50).default([]),
  brands:       z.array(z.string().min(1).max(80)).max(50).default([]),
  audience:     z.enum(POPUP_AUDIENCES),
  frequency:    z.enum(POPUP_FREQUENCIES),
  startsAt:     optionalIso,
  endsAt:       optionalIso,
}).strip().superRefine((r, ctx) => {
  if (r.startsAt && r.endsAt && new Date(r.endsAt) <= new Date(r.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endsAt must be after startsAt', path: ['endsAt'] })
  }
})

export const pageSettingsSchema = z.object({
  fonts: z.object({
    heading: z.string().max(120).optional(),
    body:    z.string().max(120).optional(),
  }).strip().optional(),
  ab: z.object({
    splitPct: z.number().min(0).max(100),
    blocks:   blocksSchema,
  }).strip().optional(),
  popup: popupRulesSchema.optional(),
  // Search/share overrides from the editor's Page tab: the storefront uses
  // them for <title> / meta description / og tags in place of the page's
  // built-in ones. Empty = the built-in one.
  seo: z.object({
    title:       z.string().trim().max(120).optional(),
    description: z.string().trim().max(300).optional(),
  }).strict().optional(),
}).passthrough()

export type PopupRules = z.infer<typeof popupRulesSchema>
export type PageSettings = z.infer<typeof pageSettingsSchema>
export type Block = z.infer<typeof blockSchema>

/**
 * Every font family a page refers to: settings.fonts.heading/body, and the
 * fontFamily of every block — including blocks inside columns and the A/B
 * variant's blocks.
 */
export function fontFamiliesUsed(blocks: unknown, settings: unknown): string[] {
  const out = new Set<string>()
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.add(v.trim()) }
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const b of list) {
      if (!b || typeof b !== 'object') continue
      const blk = b as Record<string, unknown>
      add(blk['fontFamily'])
      if (blk['type'] === 'columns' && Array.isArray(blk['columns'])) {
        for (const col of blk['columns'] as unknown[]) walk(col)
      }
    }
  }
  walk(blocks)
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>
    const fonts = s['fonts'] as Record<string, unknown> | undefined
    if (fonts && typeof fonts === 'object') { add(fonts['heading']); add(fonts['body']) }
    const ab = s['ab'] as Record<string, unknown> | undefined
    if (ab && typeof ab === 'object') walk(ab['blocks'])
  }
  return [...out]
}

// ── Brand kit (owner, 2026-10-14) ────────────────────────────────────────────
// One SiteLayout row per brand at `brand:<slug>:kit` (kind 'kit') holds the
// brand's look: palette, role colours, two fonts and four images. It lives in
// settings.kit / draftSettings.kit; blocks are always []. Same draft → submit
// → CEO approve / schedule / reject / rollback as a page. The storefront owns
// the catalogue of palette keys per brand (src/lib/brandKit.ts) and drops
// keys it does not know; this schema is the strict shape gate.
//
// Colours are 6-digit hex ONLY: the storefront mixes them with color-mix,
// OG images need hex, and 3/8-digit or rgb() forms would break those.

export const KIT_HEX = /^#[0-9a-fA-F]{6}$/
/** Built-in font ids the storefront maps to its next/font stacks. Keep in
 *  step with the storefront kit catalogue (`/api/storefront-brand-kit`). */
export const KIT_BUILTIN_FONTS = [
  'amarante', 'playfair', 'inter', 'poppins', 'alfa-slab', 'bricolage', 'syne', 'jetbrains-mono', 'times', 'georgia',
] as const
export const KIT_LIBRARY_FONT = /^library:([A-Za-z0-9_-]{1,64})$/
export const KIT_PALETTE_KEY = /^[a-z][a-z0-9-]{0,30}$/
export const KIT_MAX_PALETTE_KEYS = 24
export const KIT_IMAGE_SLOTS = ['logo', 'wordmark', 'mascot', 'badge'] as const

// A cleared form field ('' / null) means "use today's default" = absent.
const unset = (v: unknown) => (v === '' || v === null ? undefined : v)

const kitHex = z.string().regex(KIT_HEX, 'Use a 6-digit hex colour like #06392F')

const kitFont = z.string().max(80).refine(
  (v) => (KIT_BUILTIN_FONTS as readonly string[]).includes(v) || KIT_LIBRARY_FONT.test(v),
  'Unknown font — pick a built-in font or a Library font',
)

/** An https URL (≤ 1000 chars) or a bundled site path under /brand/. */
export function isKitSrc(v: string): boolean {
  if (v.length === 0 || v.length > 1000) return false
  if (v.startsWith('/brand/')) {
    return /^\/brand\/[A-Za-z0-9._\/-]+$/.test(v) && !v.includes('..') && !v.includes('//')
  }
  if (!v.startsWith('https://')) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password
  } catch {
    return false
  }
}
const kitSrc = z.string().refine(isKitSrc, 'Use an https:// link or a /brand/ path')

const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(unset, s.optional())

const kitPalette = z.preprocess(
  (v) => {
    if (v === null) return undefined
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    // Drop cleared entries; the rest must be valid.
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== '' && x !== null))
  },
  z.record(z.string().regex(KIT_PALETTE_KEY, 'Bad palette key'), kitHex)
    .refine((r) => Object.keys(r).length <= KIT_MAX_PALETTE_KEYS, `At most ${KIT_MAX_PALETTE_KEYS} palette colours`)
    .optional(),
)

export const brandKitSchema = z.object({
  v: z.literal(1),
  palette: kitPalette,
  roles: opt(z.object({
    accent:      opt(kitHex),
    surfaceBg:   opt(kitHex),
    surfaceText: opt(kitHex),
    ordering:    opt(kitHex),
  }).strict()),
  fonts: opt(z.object({
    display: opt(kitFont),
    body:    opt(kitFont),
  }).strict()),
  images: opt(z.object({
    logo:     opt(kitSrc),
    wordmark: opt(kitSrc),
    mascot:   opt(kitSrc),
    badge:    opt(kitSrc),
  }).strict()),
}).strict()

/** A kit row's settings: `{ kit }` and nothing else (no fonts/ab/popup/seo). */
export const kitSettingsSchema = z.object({ kit: brandKitSchema }).strict()

export type BrandKit = z.infer<typeof brandKitSchema>

/** MediaAsset ids of the `library:` fonts a kit names. */
export function kitLibraryFontIds(kit: BrandKit): string[] {
  const ids = new Set<string>()
  for (const ref of [kit.fonts?.display, kit.fonts?.body]) {
    const m = ref ? KIT_LIBRARY_FONT.exec(ref) : null
    if (m) ids.add(m[1]!)
  }
  return [...ids]
}
