// Typed client for the storefront content module (owner decision 41):
// pages, pop-ups, drafts, approvals, versions and A/B stats, all under
// /site-layouts. Every edit is a draft; only the CEO (role `admin`) approves,
// rejects, rolls back or deletes. Contract: the scratchpad
// content-module-contract.md the backend and renderers are built against.

import { api } from './api'
import { columnsOf, newBlock, type Block } from './blocks'
import { EDITOR_FRAME_PATH } from './editorProtocol'
import { pageDefaultBlocks } from './sections'

// Where the storefront runs. In development the storefront's own dev server
// (port 3002), never production: the editor's live page is framed from here
// and must show the code being worked on.
export const STOREFRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL']
  ?? (process.env.NODE_ENV === 'production' ? 'https://servd.pk' : 'http://localhost:3002')

/** The storefront's origin ("https://servd.pk"): the only origin the editor
 *  posts to and accepts editor messages from. null when STOREFRONT_URL is not
 *  a valid http(s) URL — the live page then shows as offline. */
export const STOREFRONT_ORIGIN: string | null = (() => {
  try {
    const u = new URL(STOREFRONT_URL)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
})()

/** The storefront route the editor frames (live page in the middle of the
 *  builder). null when the storefront address is not usable. */
export function editorFrameUrl(): string | null {
  return STOREFRONT_ORIGIN ? `${STOREFRONT_ORIGIN}${EDITOR_FRAME_PATH}` : null
}

// ─── Types ─────────────────────────────────────────────────────────────────

// widget = servd chrome that floats over every page (servd:feedback, the
// feedback button): sections only, no SEO or A/B, never in the sitemap.
// kit = a brand's look (colours, images, fonts), kept in settings.kit of the
// row `brand:<slug>:kit`; it has no elements.
export type LayoutKind = 'page' | 'header' | 'footer' | 'widget' | 'popup' | 'kit'
// 'none' = no working copy: what the API answers for a page nobody has edited
// (and for a live page whose draft was published or discarded).
export type DraftStatus = 'none' | 'draft' | 'pending' | 'scheduled'

/** True when there is a saved draft to submit, approve or discard. NOT
 *  `!!draftStatus`: the API's 'none' is a truthy string, and treating it as a
 *  draft sent Submit/Approve on an untouched page straight to a 404. */
export function hasSavedDraft(status: DraftStatus | null | undefined): boolean {
  return status === 'draft' || status === 'pending' || status === 'scheduled'
}
export type Variant = 'a' | 'b'

export interface PopupRules {
  popupKind: 'signup' | 'login' | 'offer' | 'announcement'
  display: 'modal' | 'bar' | 'corner'
  trigger: 'before_page' | 'after_seconds' | 'exit_intent' | 'scroll'
  delaySeconds?: number
  scrollPct?: number
  pages: string[]
  brands: string[]
  audience: 'everyone' | 'signed_out' | 'signed_in' | 'never_ordered'
  frequency: 'once' | 'daily' | 'every_visit'
  startsAt?: string
  endsAt?: string
}

/** A brand's look, as the storefront's brand kit stores it (contract: DESIGN.md
 *  "Storage"). Every field is optional; empty = the brand's built-in default.
 *  Colours are 6-digit hex ONLY. A font is a built-in id or `library:<assetId>`.
 *  An image is an https URL or a site path starting `/brand/`. */
export interface BrandKit {
  v: 1
  palette?: Record<string, string>
  roles?: { accent?: string; surfaceBg?: string; surfaceText?: string; ordering?: string }
  fonts?: { display?: string; body?: string }
  images?: { logo?: string; wordmark?: string; mascot?: string; badge?: string }
}

export const KIT_ROLE_KEYS = ['accent', 'surfaceBg', 'surfaceText', 'ordering'] as const
export const KIT_IMAGE_KEYS = ['logo', 'wordmark', 'mascot', 'badge'] as const
export type KitRoleKey = (typeof KIT_ROLE_KEYS)[number]
export type KitImageKey = (typeof KIT_IMAGE_KEYS)[number]

export interface PageSettings {
  /** Only on a brand kit row (kind 'kit'): the brand's look. */
  kit?: BrandKit
  fonts?: { heading?: string; body?: string }
  ab?: { splitPct: number; blocks: Block[] }
  popup?: PopupRules
  /** Search/share overrides (Page tab): the storefront's <title> and meta
   *  description for this page. Empty = the page's built-in ones. */
  seo?: { title?: string; description?: string }
}

/** Upper bounds the API enforces on settings.seo, and the lengths Google
    shows before it cuts the text off. */
export const SEO_LIMITS = {
  title: { max: 120, shown: 60 },
  description: { max: 300, shown: 155 },
} as const

/** Hints for a page's search title and description. A template — one page
    behind many URLs (servd:location → every /locations/<loc>) — shares them
    across every page it renders, filled in per page from the same
    placeholders its elements take, so a plain title would repeat on all. */
export function seoHints(slug: string | undefined): { title: string; description: string; template: boolean } {
  if (slug === 'servd:location') {
    return {
      template: true,
      title: 'Used on every location page. Use {name}, {area}, {city} so each one gets its own title. Empty = each location\'s built-in title.',
      description: 'Used on every location page. Placeholders: {name} {area} {district} {city} {address} {street} {tagline}. Empty = each location\'s built-in description.',
    }
  }
  return {
    template: false,
    title: 'Shown in Google and when the link is shared. Empty = the page\'s built-in title.',
    description: 'Shown in Google and when the link is shared. Empty = the page\'s built-in description.',
  }
}

export interface UserRef { id: string; name: string }

/** GET /site-layouts row. */
export interface LayoutSummary {
  id: string
  slug: string
  kind: LayoutKind
  title: string | null
  /** The API's display name for a kit row ("Brand kit — <Brand>"). */
  label?: string | null
  tenantId: string | null
  draftStatus: DraftStatus | null
  liveVersion: number | null
  publishedAt: string | null
  publishAt: string | null
  submittedAt: string | null
  submittedBy: UserRef | null
  reviewNote: string | null
  updatedAt: string | null
  draftUpdatedAt: string | null
}

/** GET /site-layouts/:slug/edit */
export interface LayoutEdit {
  id?: string
  slug: string
  kind: LayoutKind
  title: string | null
  tenantId: string | null
  blocks: Block[] | null
  settings: PageSettings | null
  draftBlocks: Block[] | null
  draftSettings: PageSettings | null
  draftStatus: DraftStatus | null
  reviewNote: string | null
  publishAt: string | null
  liveVersion: number | null
  publishedAt: string | null
}

export interface LayoutVersion {
  version: number
  publishedAt: string
  publishedBy: UserRef | null
  approvedBy: UserRef | null
  note: string | null
  blocks: Block[]
  settings: PageSettings | null
}

export interface LayoutStat { version: number; variant: Variant; views: number; conversions: number }

/** The slice of a media-library asset the builder needs (fonts). */
export interface MediaAssetLite {
  id: string
  kind: 'image' | 'video' | 'font' | 'copy'
  name: string
  url: string
  fontFamily: string | null
  text: string | null
  /** The asset's company, when the API sends it (picks the live page's font). */
  tenantId?: string | null
  createdAt?: string
}

export interface ConceptLite {
  id: string; name: string; slug: string; tenantId?: string | null
  /** The brand's ordering / ERP colour and logo (the kit's publish keeps them in step). */
  primaryColor?: string | null
  logoUrl?: string | null
  /** Only present when the brand list carries them (the Brands page does). */
  wordmarkUrl?: string | null
  mascotUrl?: string | null
}

// The Storefront editor's brand list: GET /concepts?view=storefront, which
// answers anyone holding the 'storefront' module (marketing, brand_manager)
// and management, with the narrow brand fields only (id, name, slug, company,
// logo, colour). Its own query key: plain GET /concepts stays management/till
// only, so a narrow row never lands in a page that edits brands (the Brand
// Editor at /ceo/brands would show it as a blank brand).
export const STOREFRONT_BRANDS_KEY = ['concepts', 'storefront'] as const

// ─── API ───────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

export const contentApi = {
  brands: () => api.get<ConceptLite[]>('/concepts?view=storefront'),
  list: (params: { status?: 'pending' | 'draft' | 'scheduled' | 'all'; kind?: LayoutKind } = {}) => {
    const qs = new URLSearchParams({ status: params.status ?? 'all', ...(params.kind ? { kind: params.kind } : {}) })
    return api.get<LayoutSummary[]>(`/site-layouts?${qs.toString()}`)
  },
  edit: (slug: string) => api.get<LayoutEdit>(`/site-layouts/${enc(slug)}/edit`),
  saveDraft: (slug: string, body: { title?: string; kind?: LayoutKind; blocks: Block[]; settings?: PageSettings }) =>
    api.put<LayoutEdit>(`/site-layouts/${enc(slug)}/draft`, body),
  discardDraft: (slug: string) => api.delete<void>(`/site-layouts/${enc(slug)}/draft`),
  submit: (slug: string) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/submit`, {}),
  approve: (slug: string, publishAt?: string) =>
    api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/approve`, publishAt ? { publishAt } : {}),
  reject: (slug: string, note: string) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/reject`, { note }),
  versions: (slug: string) => api.get<LayoutVersion[]>(`/site-layouts/${enc(slug)}/versions`),
  rollback: (slug: string, version: number) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/rollback`, { version }),
  stats: (slug: string) => api.get<LayoutStat[]>(`/site-layouts/${enc(slug)}/stats`),
  previewToken: (slug: string) => api.post<{ token: string }>(`/site-layouts/${enc(slug)}/preview-token`, {}),
  remove: (slug: string) => api.delete<void>(`/site-layouts/${enc(slug)}`),
  fonts: () => api.get<MediaAssetLite[]>('/media?kind=font'),
}

export const previewUrl = (token: string) => `${STOREFRONT_URL}/preview/${token}`

// ─── Slug helpers ──────────────────────────────────────────────────────────

export function kindForSlug(slug: string): LayoutKind {
  if (isKitSlug(slug)) return 'kit'
  if (slug.startsWith('popup:')) return 'popup'
  if (slug === 'servd:feedback') return 'widget'
  const last = slug.split(':').pop()
  if ((slug.startsWith('servd:') || slug.startsWith('brand:')) && last === 'header' && slug.split(':').length >= 2) return 'header'
  if ((slug.startsWith('servd:') || slug.startsWith('brand:')) && last === 'footer' && slug.split(':').length >= 2) return 'footer'
  return 'page'
}

/** Built-in brand sub-pages (anything else under brand:<slug>: is the
    owner's own page, served at /brand/<slug>/pages/<page>). */
export const BRAND_BUILTIN_PAGES = ['header', 'footer', 'about', 'visit', 'menu'] as const
const BRAND_RESERVED = new Set<string>([...BRAND_BUILTIN_PAGES, 'qr', 'pages', 'home', 'kit'])
export const isReservedBrandPage = (p: string) => BRAND_RESERVED.has(p)

/** The brand-kit row of a brand: `brand:<slug>:kit`. */
export const kitSlugOf = (brandSlug: string) => `brand:${brandSlug}:kit`
export const isKitSlug = (slug: string) => /^brand:[^:]+:kit$/.test(slug)
/** The brand a kit slug belongs to (null when it is not a kit slug). */
export const brandOfKitSlug = (slug: string) => (isKitSlug(slug) ? slug.split(':')[1]! : null)
export const kitHref = (brandSlug: string) => `/storefront/kit/${encodeURIComponent(brandSlug)}`

const SERVD_PATHS: Record<string, string> = {
  home: '/home', header: '/home', footer: '/home', feedback: '/home', waitlist: '/waitlist', press: '/press', reserve: '/reserve', privacy: '/privacy', terms: '/terms', contact: '/contact',
}

/** Where the live page is on the storefront (null for pop-ups / templates). */
export function storefrontPath(slug: string): string | null {
  const [prefix, a, b] = slug.split(':')
  if (prefix === 'servd' && a) return SERVD_PATHS[a] ?? null
  if (prefix === 'page' && a) return `/pages/${a}`
  if (prefix === 'brand' && a) {
    if (b === 'kit') return `/brand/${a}`
    if (!b || b === 'header' || b === 'footer') return `/brand/${a}`
    if (b === 'about' || b === 'visit' || b === 'menu') return `/brand/${a}/${b}`
    return `/brand/${a}/pages/${b}`
  }
  return null
}

/** A page the storefront ships its own design for: what it shows while the
 *  working copy has no elements. Custom pages (page:<x>, the owner's own
 *  brand pages) and pop-ups have none. */
export function isBuiltInPage(slug: string): boolean {
  const [prefix, a, b] = slug.split(':')
  if (prefix === 'servd') return !!a
  if (prefix === 'brand') return !!a && (!b || (BRAND_BUILTIN_PAGES as readonly string[]).includes(b))
  return false
}

/** What the editor calls a live part of the page that isn't being edited
 *  (the frame's "context" click): its top bar, its footer, or a page. */
export function contextPartName(slug: string): 'top bar' | 'footer' | 'page' | 'feedback button' {
  const k = kindForSlug(slug)
  return k === 'header' ? 'top bar' : k === 'footer' ? 'footer' : k === 'widget' ? 'feedback button' : 'page'
}

const SLUG_PART = /^[a-z0-9][a-z0-9_-]{0,79}$/i

/** The SiteLayout slug grammar (backend parseSlug): servd:<p>, page:<p>,
 *  brand:<b>[:<p>], popup:<k>. */
export function isValidSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string' || slug.length > 200) return false
  const parts = slug.split(':')
  const [prefix, ...rest] = parts
  if (!rest.every((p) => SLUG_PART.test(p))) return false
  if (prefix === 'servd' || prefix === 'page' || prefix === 'popup') return rest.length === 1
  if (prefix === 'brand') return rest.length === 1 || rest.length === 2
  return false
}

/** The settings as saved (and as the live frame is sent them): empty parts
 *  dropped, the split rounded, pop-up page patterns trimmed. */
export function cleanSettings(s: PageSettings, isPopup: boolean): PageSettings {
  const out: PageSettings = {}
  if (s.kit) out.kit = cleanKit(s.kit)
  if (s.fonts && (s.fonts.heading || s.fonts.body)) out.fonts = s.fonts
  if (s.ab) out.ab = { splitPct: Math.max(0, Math.min(100, Math.round(s.ab.splitPct))), blocks: s.ab.blocks }
  if (isPopup && s.popup) out.popup = { ...s.popup, pages: s.popup.pages.map((p) => p.trim()).filter(Boolean) }
  if (!isPopup && s.seo) {
    const title = s.seo.title?.trim()
    const description = s.seo.description?.trim()
    if (title || description) out.seo = { ...(title && { title }), ...(description && { description }) }
  }
  return out
}

const HEX6 = /^#[0-9a-fA-F]{6}$/
export const isHex6 = (v: unknown): v is string => typeof v === 'string' && HEX6.test(v)
/** An image the kit may hold: an https URL (<= 1000 chars) or a site path under /brand/. */
export const isKitSrc = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1000 && (/^https:\/\/\S+$/i.test(v) || /^\/brand\/\S+$/.test(v))
export const isKitFontRef = (v: unknown): v is string =>
  typeof v === 'string' && /^(library:[A-Za-z0-9_-]{1,64}|[a-z][a-z0-9-]{0,40})$/.test(v)

/** A kit as saved: blank fields dropped (blank = the brand's default), values
 *  trimmed, empty groups removed. Invalid values are KEPT so Save can refuse
 *  them (see kitProblems) rather than silently dropping what was typed. */
export function cleanKit(kit: BrandKit): BrandKit {
  const out: BrandKit = { v: 1 }
  const pick = (src: Record<string, string | undefined> | undefined) => {
    const o: Record<string, string> = {}
    for (const [k, v] of Object.entries(src ?? {})) {
      const t = typeof v === 'string' ? v.trim() : ''
      if (t) o[k] = t
    }
    return o
  }
  const palette = pick(kit.palette)
  if (Object.keys(palette).length) out.palette = palette
  const roles = pick(kit.roles)
  if (Object.keys(roles).length) out.roles = roles
  const fonts = pick(kit.fonts)
  if (Object.keys(fonts).length) out.fonts = fonts
  const images = pick(kit.images)
  if (Object.keys(images).length) out.images = images
  return out
}

/** Plain-words problems that stop a kit being saved (the API would refuse it
 *  with a 422), each naming the field's label. Empty = fine. */
export function kitProblems(kit: BrandKit, paletteLabels: Record<string, string> = {}): string[] {
  const k = cleanKit(kit)
  const out: string[] = []
  // A palette colour is named by its form label ("Fiery orange (signal)"), never its key.
  for (const [key, v] of Object.entries(k.palette ?? {})) if (!isHex6(v)) out.push(`${paletteLabels[key] ?? `The colour "${key}"`} must look like #1a2b3c (six digits).`)
  const roleName: Record<string, string> = { accent: 'Website signal colour', surfaceBg: 'Band / footer background', surfaceText: 'Band / footer text', ordering: 'Ordering & ERP colour' }
  for (const [key, v] of Object.entries(k.roles ?? {})) if (!isHex6(v)) out.push(`${roleName[key] ?? key} must look like #1a2b3c (six digits).`)
  const imgName: Record<string, string> = { logo: 'Logo', wordmark: 'Wordmark', mascot: 'Mascot', badge: 'Badge' }
  for (const [key, v] of Object.entries(k.images ?? {})) if (!isKitSrc(v)) out.push(`${imgName[key] ?? key} must be a https:// address or pick one from the Library.`)
  for (const [key, v] of Object.entries(k.fonts ?? {})) if (!isKitFontRef(v)) out.push(`The ${key === 'display' ? 'heading' : 'body'} font is not recognised.`)
  return out
}

/**
 * Every font family a page refers to: settings.fonts.heading/body and every
 * block's fontFamily, inside columns and variant B too. The same walk as the
 * backend's fontFamiliesUsed (siteLayouts/schemas.ts), which picks the fonts
 * the live page loads.
 */
export function fontFamiliesUsed(blocks: Block[], settings: PageSettings | null | undefined): string[] {
  const out = new Set<string>()
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.add(v.trim()) }
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const b of list as Block[]) {
      if (!b || typeof b !== 'object') continue
      add(b.fontFamily)
      for (const col of columnsOf(b) ?? []) walk(col)
    }
  }
  walk(blocks)
  add(settings?.fonts?.heading)
  add(settings?.fonts?.body)
  walk(settings?.ab?.blocks)
  return [...out]
}

/**
 * The Library font the live page would load for each family, mirroring the
 * backend's resolveFonts: a company's page reads its own company's fonts
 * (shared servd pages any company's), and the newest upload wins.
 */
export function resolveLibraryFonts(families: string[], library: MediaAssetLite[], tenantId: string | null): Array<{ family: string; url: string }> {
  if (families.length === 0) return []
  const time = (a: MediaAssetLite) => { const t = a.createdAt ? Date.parse(a.createdAt) : NaN; return Number.isNaN(t) ? 0 : t }
  const candidates = library
    .filter((a) => a.kind === 'font' && a.fontFamily && a.url)
    // Only filter by company when the API says whose the asset is.
    .filter((a) => !tenantId || a.tenantId === undefined || a.tenantId === tenantId)
    .slice()
    .sort((x, y) => time(y) - time(x))
  const out: Array<{ family: string; url: string }> = []
  for (const family of families) {
    const hit = candidates.find((a) => a.fontFamily === family)
    if (hit) out.push({ family, url: hit.url })
  }
  return out
}

export function newPopupKey(): string {
  return Math.random().toString(36).slice(2, 8)
}

export const DEFAULT_POPUP_RULES = (popupKind: PopupRules['popupKind'] = 'offer'): PopupRules => ({
  popupKind,
  display: 'modal',
  trigger: 'after_seconds',
  delaySeconds: 5,
  pages: [],
  brands: [],
  audience: popupKind === 'signup' || popupKind === 'login' ? 'signed_out' : 'everyone',
  frequency: 'once',
})

/** Starting blocks for a slug with nothing live and no draft: the page's
    design from the storefront's section catalogue (load it first with
    useSectionCatalog), a pop-up template, or a plain hero for a new page. */
export function seedBlocks(slug: string, popupKind?: PopupRules['popupKind']): Block[] {
  if (kindForSlug(slug) === 'popup') {
    if (popupKind === 'signup' || popupKind === 'login') {
      return [{ ...newBlock('signup_form'), mode: popupKind, title: popupKind === 'login' ? 'Welcome back' : 'Join servd' }]
    }
    return [{ ...newBlock('text'), body: 'Your offer or announcement.', align: 'center', size: 'lg' }, newBlock('cta_button')]
  }
  const designed = pageDefaultBlocks(slug)
  return designed.length ? designed : [newBlock('hero')]
}

// ─── Status display ────────────────────────────────────────────────────────

export interface StatusInfo { label: string; tone: 'teal' | 'amber' | 'blue' | 'red' | 'muted'; note?: string | null }

export function draftStatusInfo(row: { draftStatus: DraftStatus | null; reviewNote: string | null; publishAt: string | null }): StatusInfo {
  switch (row.draftStatus) {
    case 'pending':   return { label: 'Waiting for CEO', tone: 'amber' }
    case 'scheduled': return { label: `Scheduled for ${row.publishAt ? fmtDateTime(row.publishAt) : 'later'}`, tone: 'blue' }
    case 'draft':     return row.reviewNote
      ? { label: 'Rejected', tone: 'red', note: row.reviewNote }
      : { label: 'Draft', tone: 'muted' }
    default:          return { label: 'No draft', tone: 'teal' }
  }
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** ISO -> value for <input type="datetime-local"> (local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** <input type="datetime-local"> value -> ISO (undefined when blank). */
export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
