// Block + settings validation for the storefront content module (decision 41).
//
// Blocks are validated LOOSELY: every block needs an id and a known type, the
// shared animation/font fields are range-checked, and the new block types
// (columns, video, signup_form) get their structural fields checked. Anything
// else passes through untouched — the admin editor adds fields per block type
// and the renderers defend with optional chaining.
//
// Settings are validated more strictly: the renderers switch on the pop-up
// enums and on the A/B split, so those must be trustworthy.

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

export const MAX_TOP_LEVEL_BLOCKS = 80
export const MAX_CONTENT_BYTES = 200_000

const blockBase = z.object({
  id:                  z.string().min(1).max(100),
  type:                z.enum(BLOCK_TYPES),
  animation:           z.enum(ANIMATIONS).optional(),
  animationDelayMs:    z.number().int().min(0).max(3000).optional(),
  animationDurationMs: z.number().int().min(200).max(3000).optional(),
  fontFamily:          z.string().max(120).optional(),
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

export const blockSchema = blockBase.superRefine((b, ctx) => {
  if (b.type === 'columns') forward(ctx, columnsFields.safeParse(b))
  else checkLeaf(b, ctx)
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
