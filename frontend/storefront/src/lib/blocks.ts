// Page-builder block schema.
//
// Every storefront page is a `Block[]`. The storefront's PageRenderer maps
// each block.type to a component. The dashboard's content editor exposes
// the same block library to the operator: pick a type, configure props,
// reorder, save → live.
//
// Adding a new block type:
//   1. Add to BlockType union below
//   2. Add a render component to src/components/blocks/
//   3. Map it in PageRenderer.tsx
//   4. Add an editor form in apps/web/src/app/content/[slug]/blockEditors.tsx
//
// The schema is deliberately a discriminated union so TypeScript catches
// missing fields at compile time. JSON validation on the API side mirrors
// this with Zod.

export type ButtonStyle = 'primary' | 'secondary' | 'dark' | 'ghost'
export type ButtonSize  = 'sm' | 'md' | 'lg' | 'xl' | 'huge'
export type Align       = 'left' | 'center' | 'right'
export type SectionPad  = 'none' | 'sm' | 'md' | 'lg' | 'xl'
export type BlockAnimation = 'none' | 'fade-up' | 'fade-in' | 'slide-left' | 'slide-right' | 'zoom-in'

interface BlockBase {
  id: string                  // uuid, stable across edits
  type: BlockType
  background?: string         // CSS color or var(--…); falls back to white
  textColor?: string          // override readable text
  paddingY?: SectionPad       // top/bottom padding band
  fullBleed?: boolean         // bleed to edges (default: container-constrained)
  hidden?: boolean            // toggle off without deleting
  animation?: BlockAnimation  // plays once when the block scrolls into view
  animationDelayMs?: number   // 0..3000
  animationDurationMs?: number // 200..3000, default 600
  fontFamily?: string         // a library font family or a built-in stack
}

export interface HeroBlock extends BlockBase {
  type: 'hero'
  kicker?: string
  title: string
  subtitle?: string
  imageUrl?: string
  imageOverlay?: number
  align?: Align
  height?: 'sm' | 'md' | 'lg' | 'xl' | 'screen'
  primaryCta?: { text: string; href: string }
  secondaryCta?: { text: string; href: string }
}

export interface CtaButtonBlock extends BlockBase {
  type: 'cta_button'
  text: string
  href: string
  style: ButtonStyle
  size: ButtonSize
  align: Align
  fullWidth?: boolean
  trailingArrow?: boolean
}

export interface BannerBlock extends BlockBase {
  type: 'banner'
  title: string
  subtitle?: string
  backgroundUrl?: string
  backgroundColor?: string
  align?: Align
  cta?: { text: string; href: string; style: ButtonStyle; size: ButtonSize }
  height?: 'sm' | 'md' | 'lg'
}

export interface TextBlock extends BlockBase {
  type: 'text'
  body: string
  align?: Align
  size?: 'sm' | 'md' | 'lg' | 'xl'
  emphasized?: boolean
  maxWidth?: 'narrow' | 'wide' | 'full'
}

export interface ImageBlock extends BlockBase {
  type: 'image'
  url: string
  alt?: string
  caption?: string
  rounded?: boolean
  aspect?: '16/9' | '4/3' | '1/1' | '3/4' | '21/9'
}

export interface GalleryBlock extends BlockBase {
  type: 'gallery'
  images: Array<{ url: string; alt?: string }>
  columns?: 2 | 3 | 4
}

export interface StatStripBlock extends BlockBase {
  type: 'stat_strip'
  stats: Array<{ value: string; label: string }>
}

export interface VoicesBlock extends BlockBase {
  type: 'voices'
  kicker?: string
  voices: Array<{ brand: string; line: string }>
}

export interface KitchensBlock extends BlockBase {
  type: 'kitchens'
  kicker?: string
  title?: string
  showAllLink?: boolean
  max?: number
}

export interface FeaturedMenuBlock extends BlockBase {
  type: 'featured_menu'
  conceptSlug?: string
  kicker?: string
  title?: string
  max?: number
}

export interface ReviewsBlock extends BlockBase {
  type: 'reviews'
  conceptSlug?: string
  max?: number
  showRating?: boolean
}

export interface QuoteBlock extends BlockBase {
  type: 'quote'
  text: string
  attribution?: string
  size?: 'md' | 'lg' | 'xl'
}

export interface SpacerBlock extends BlockBase {
  type: 'spacer'
  size: SectionPad
}

export interface DividerBlock extends BlockBase {
  type: 'divider'
}

export interface ColumnsBlock extends BlockBase {
  type: 'columns'
  columns: Block[][]          // 2..4 columns; nested blocks may not be 'columns'
  gap?: 'sm' | 'md' | 'lg'
  stackOnMobile?: boolean     // default true
}

export interface VideoBlock extends BlockBase {
  type: 'video'
  url: string
  posterUrl?: string
  autoplay?: boolean          // implies muted + playsInline
  loop?: boolean
  muted?: boolean
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5'
}

/** The page's built-in design (brand page → BrandFallback, servd:home →
 *  HomeClient), so the owner can add elements above/below it. */
export interface SignatureBlock extends BlockBase {
  type: 'signature'
}

/** The storefront's existing sign-in / one-code sign-up forms. */
export interface SignupFormBlock extends BlockBase {
  type: 'signup_form'
  mode: 'signup' | 'login'
  title?: string
  subtitle?: string
}

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'
  | 'columns' | 'video' | 'signature' | 'signup_form'

export type Block =
  | HeroBlock | CtaButtonBlock | BannerBlock | TextBlock | ImageBlock | GalleryBlock
  | StatStripBlock | VoicesBlock | KitchensBlock | FeaturedMenuBlock | ReviewsBlock
  | QuoteBlock | SpacerBlock | DividerBlock
  | ColumnsBlock | VideoBlock | SignatureBlock | SignupFormBlock

// ── Page settings, pop-up rules, public read shape ─────────────────────────

export interface PopupRules {
  popupKind: 'signup' | 'login' | 'offer' | 'announcement'
  display: 'modal' | 'bar' | 'corner'
  trigger: 'before_page' | 'after_seconds' | 'exit_intent' | 'scroll'
  delaySeconds?: number       // after_seconds
  scrollPct?: number          // scroll
  pages: string[]             // path patterns, '*' suffix wildcard; [] = every page
  brands: string[]            // concept slugs; [] = all brands
  audience: 'everyone' | 'signed_out' | 'signed_in' | 'never_ordered'
  frequency: 'once' | 'daily' | 'every_visit'
  startsAt?: string
  endsAt?: string
}

export interface PageSettings {
  fonts?: { heading?: string; body?: string }
  ab?: { splitPct: number; blocks: Block[] }
  popup?: PopupRules
}

export interface LibraryFont { family: string; url: string }

/** GET /site-layouts/:slug and GET /site-layouts/preview/:token. */
export interface SiteLayoutRead {
  slug: string
  kind: string
  title: string | null
  version: number
  blocks: Block[] | null      // null when nothing is live
  settings: PageSettings | null
  fonts: LibraryFont[]
  publishedAt: string | null
  updatedAt: string | null
}

/** GET /site-layouts/popups/live */
export interface LivePopup {
  slug: string
  version: number
  title: string | null
  blocks: Block[]
  rules: PopupRules
  fonts: LibraryFont[]
}

const LAYOUT_API = process.env['INTERNAL_API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

function asFonts(v: unknown): LibraryFont[] {
  if (!Array.isArray(v)) return []
  return v.filter((f): f is LibraryFont =>
    !!f && typeof f === 'object' && typeof (f as LibraryFont).family === 'string' && typeof (f as LibraryFont).url === 'string')
}

export function normalizeSiteLayout(raw: unknown): SiteLayoutRead | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const settings = b['settings'] && typeof b['settings'] === 'object' ? b['settings'] as PageSettings : null
  return {
    slug:        typeof b['slug'] === 'string' ? b['slug'] : '',
    kind:        typeof b['kind'] === 'string' ? b['kind'] : 'page',
    title:       typeof b['title'] === 'string' ? b['title'] : null,
    version:     typeof b['version'] === 'number' ? b['version'] : 0,
    blocks:      Array.isArray(b['blocks']) ? b['blocks'] as Block[] : null,
    settings,
    fonts:       asFonts(b['fonts']),
    publishedAt: typeof b['publishedAt'] === 'string' ? b['publishedAt'] : null,
    updatedAt:   typeof b['updatedAt'] === 'string' ? b['updatedAt'] : null,
  }
}

async function readLayout(path: string): Promise<SiteLayoutRead | null> {
  try {
    // no-store: a cached failure would stick until restart (CLAUDE.md).
    const res = await fetch(`${LAYOUT_API}/api/v1/site-layouts/${path}`, { cache: 'no-store' })
    if (!res.ok) return null
    return normalizeSiteLayout(await res.json())
  } catch {
    return null
  }
}

/** The LIVE copy of a SiteLayout. null when the API is down or the slug is unknown. */
export function fetchSiteLayout(slug: string): Promise<SiteLayoutRead | null> {
  return readLayout(encodeURIComponent(slug))
}

/** The DRAFT behind a preview token. */
export function fetchSiteLayoutPreview(token: string): Promise<SiteLayoutRead | null> {
  return readLayout(`preview/${encodeURIComponent(token)}`)
}

/** Live pop-ups. Used client-side by PopupHost. */
export async function fetchLivePopups(apiBase: string): Promise<LivePopup[]> {
  try {
    const res = await fetch(`${apiBase}/api/v1/site-layouts/popups/live`, { cache: 'no-store' })
    if (!res.ok) return []
    const body = await res.json() as unknown
    if (!Array.isArray(body)) return []
    return body
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .filter((p) => typeof p['slug'] === 'string' && Array.isArray(p['blocks']) && !!p['rules'] && typeof p['rules'] === 'object')
      .map((p) => ({
        slug:    p['slug'] as string,
        version: typeof p['version'] === 'number' ? p['version'] : 0,
        title:   typeof p['title'] === 'string' ? p['title'] : null,
        blocks:  p['blocks'] as Block[],
        rules:   p['rules'] as PopupRules,
        fonts:   asFonts(p['fonts']),
      }))
  } catch {
    return []
  }
}

/** Fire-and-forget A/B + conversion beacon: POST /site-layouts/:slug/track. */
export function trackLayout(apiBase: string, slug: string, version: number, variant: 'a' | 'b', event: 'view' | 'convert'): void {
  try {
    void fetch(`${apiBase}/api/v1/site-layouts/${encodeURIComponent(slug)}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, variant, event }),
      keepalive: true,
    }).catch(() => { /* stats are best-effort */ })
  } catch { /* ignore */ }
}

// ── Fonts ──────────────────────────────────────────────────────────────────

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit'])

/** A CSS font-family value for a library family name or a built-in stack. */
export function cssFontFamily(name: string | undefined | null): string | undefined {
  const n = (name ?? '').replace(/[<>{};\\]/g, '').trim()
  if (!n) return undefined
  if (n.includes(',') || n.startsWith('var(') || GENERIC_FAMILIES.has(n)) return n
  return `"${n.replace(/["']/g, '')}", system-ui, sans-serif`
}

/** @font-face rules for library fonts (font-display: swap). */
export function fontFaceCss(fonts: LibraryFont[]): string {
  return fonts
    .map((f) => {
      const family = f.family.replace(/["'<>{};\\]/g, '').trim()
      const url = f.url.trim()
      if (!family || !/^(https?:\/\/|\/)/.test(url)) return ''
      const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase()
      const format = ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : null
      const safeUrl = url.replace(/["'()<>\s\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      return `@font-face{font-family:"${family}";src:url("${safeUrl}")${format ? ` format("${format}")` : ''};font-display:swap;}`
    })
    .join('')
}

// ── Catalogue ──────────────────────────────────────────────────────────────

export interface BlockSpec {
  type: BlockType
  label: string
  description: string
  icon: string
  default: () => Omit<Block, 'id'>
}

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export const BLOCK_CATALOG: BlockSpec[] = [
  {
    type: 'hero', label: 'Hero', description: 'Big top section with title and image', icon: '🎯',
    default: () => ({
      type: 'hero',
      kicker: 'A new section',
      title: 'Headline goes here',
      subtitle: "Short paragraph telling visitors what they're looking at.",
      align: 'left', height: 'lg',
      primaryCta: { text: 'Order Now', href: '/browse' },
    }),
  },
  {
    type: 'cta_button', label: 'CTA Button', description: 'A single prominent action button', icon: '🔘',
    default: () => ({
      type: 'cta_button',
      text: 'Order Now', href: '/browse',
      style: 'primary', size: 'lg', align: 'center', trailingArrow: true,
    }),
  },
  {
    type: 'banner', label: 'Banner', description: 'Wide image strip with overlaid title + CTA', icon: '🎫',
    default: () => ({
      type: 'banner',
      title: 'Banner headline',
      subtitle: 'Optional supporting line.',
      backgroundColor: '#0a0a0a', textColor: '#ffffff',
      align: 'center', height: 'md',
    }),
  },
  {
    type: 'text', label: 'Text', description: 'A paragraph or short body of copy', icon: '📝',
    default: () => ({
      type: 'text',
      body: 'Write your copy here.',
      align: 'left', size: 'md', maxWidth: 'narrow',
    }),
  },
  {
    type: 'image', label: 'Image', description: 'A single image block', icon: '🖼️',
    default: () => ({
      type: 'image', url: '', alt: '',
      rounded: true, aspect: '16/9',
    }),
  },
  {
    type: 'gallery', label: 'Gallery', description: 'A grid of images', icon: '🎞️',
    default: () => ({ type: 'gallery', images: [], columns: 3 }),
  },
  {
    type: 'stat_strip', label: 'Stats', description: 'A row of numbers with labels', icon: '📊',
    default: () => ({
      type: 'stat_strip',
      stats: [
        { value: '100%', label: 'cooked fresh' },
        { value: '1',  label: 'one checkout' },
        { value: '0',  label: 'hidden fees' },
      ],
    }),
  },
  {
    type: 'voices', label: 'Brand voices', description: 'Two-column tagline list', icon: '🗣️',
    default: () => ({
      type: 'voices',
      kicker: 'The line-up',
      voices: [
        { brand: 'simmer', line: 'Slow nights, plated softly.' },
        { brand: 'stackd', line: 'Cooked here. Wrapped, not plated.' },
      ],
    }),
  },
  {
    type: 'kitchens', label: 'Kitchens grid', description: 'Live grid of brand cards', icon: '🍽️',
    default: () => ({
      type: 'kitchens',
      kicker: 'Tonight on servd', title: 'Pick your kitchen',
      showAllLink: true, max: 6,
    }),
  },
  {
    type: 'featured_menu', label: 'Featured menu', description: 'Live menu items from a brand', icon: '🍔',
    default: () => ({
      type: 'featured_menu',
      kicker: 'Eat with us', title: "What everyone's ordering", max: 6,
    }),
  },
  {
    type: 'reviews', label: 'Reviews', description: 'Latest customer reviews for a brand', icon: '⭐',
    default: () => ({ type: 'reviews', max: 6, showRating: true }),
  },
  {
    type: 'quote', label: 'Quote', description: 'A pull quote on a dark band', icon: '💬',
    default: () => ({
      type: 'quote',
      text: 'A short, memorable line that captures something true.',
      attribution: 'Source', size: 'lg',
      background: 'var(--servd-black)', textColor: '#ffffff',
      paddingY: 'xl',
    }),
  },
  {
    type: 'spacer', label: 'Spacer', description: 'Vertical breathing room', icon: '⬜',
    default: () => ({ type: 'spacer', size: 'md' }),
  },
  {
    type: 'divider', label: 'Divider', description: 'A horizontal hairline rule', icon: '➖',
    default: () => ({ type: 'divider' }),
  },
]

export function newBlock(type: BlockType): Block {
  const spec = BLOCK_CATALOG.find((s) => s.type === type)
  if (!spec) throw new Error(`Unknown block type: ${type}`)
  return { ...spec.default(), id: newId() } as Block
}

// ── Default layouts (fallback when DB has no row) ──────────────────────────

export function defaultServdHomeLayout(): Block[] {
  return [
    {
      id: 'h-1', type: 'hero',
      kicker: 'One place for every kitchen',
      title: 'Every kitchen, one place.',
      subtitle: 'Explore the brands, order what you are craving, and join Insiders for rewards on every order.',
      align: 'left', height: 'screen',
      primaryCta: { text: 'Order Now', href: '/browse' },
    },
    {
      id: 's-1', type: 'stat_strip',
      stats: [
        { value: '100%', label: 'cooked fresh' },
        { value: '1',  label: 'one checkout' },
        { value: '0',  label: 'hidden fees' },
      ],
    },
    {
      id: 'v-1', type: 'voices',
      kicker: 'The line-up',
      voices: [
        { brand: 'simmer', line: 'Slow nights, plated softly.' },
        { brand: 'stackd', line: 'Cooked here. Wrapped, not plated.' },
        { brand: 'Flipd', line: 'Same burger, every time.' },
      ],
    },
    {
      id: 'k-1', type: 'kitchens',
      kicker: 'Tonight on servd', title: 'Pick your kitchen',
      showAllLink: true, max: 6,
    },
    {
      id: 'q-1', type: 'quote',
      text: '"Everything I am craving in one place, one checkout. I order, I track it, done."',
      attribution: '— An Insider · Karachi',
      size: 'xl',
      background: 'var(--servd-green)', textColor: '#ffffff',
      paddingY: 'xl',
    },
    {
      id: 'c-1', type: 'cta_button',
      text: 'Browse all kitchens', href: '/browse',
      style: 'primary', size: 'huge', align: 'center',
      trailingArrow: true, paddingY: 'xl',
    },
  ]
}

export function defaultBrandLayout(slug: string): Block[] {
  return [
    {
      id: 'h-1', type: 'hero',
      title: '{{brand.name}}',
      subtitle: '{{brand.description}}',
      align: 'left', height: 'lg',
      primaryCta:   { text: 'Order Now', href: `/${slug}` },
      secondaryCta: { text: 'See menu',  href: `/brand/${slug}/menu` },
    },
    {
      id: 'fm-1', type: 'featured_menu',
      conceptSlug: slug,
      kicker: 'Eat with us', title: "What everyone's ordering", max: 6,
    },
    {
      id: 'r-1', type: 'reviews',
      conceptSlug: slug, max: 6, showRating: true,
    },
    {
      id: 'c-1', type: 'cta_button',
      text: 'Order from this brand', href: `/${slug}`,
      style: 'primary', size: 'huge', align: 'center',
      trailingArrow: true, paddingY: 'xl',
    },
  ]
}

// ── Style helpers used by both renderer and editor ──────────────────────────

export const PADDING_PX: Record<SectionPad, string> = {
  none: '0',
  sm:   'clamp(1rem, 2vw, 1.5rem)',
  md:   'clamp(2rem, 4vw, 3rem)',
  lg:   'clamp(3rem, 6vw, 5rem)',
  xl:   'clamp(4rem, 8vw, 7rem)',
}

export const BUTTON_SIZE_PX: Record<ButtonSize, { px: string; py: string; fz: string }> = {
  sm:   { px: '1rem',                      py: '0.5rem',                   fz: '0.85rem' },
  md:   { px: '1.5rem',                    py: '0.75rem',                  fz: '0.95rem' },
  lg:   { px: '2.25rem',                   py: '1rem',                     fz: '1.05rem' },
  xl:   { px: 'clamp(2.5rem, 5vw, 3.5rem)',py: 'clamp(1rem, 2vw, 1.25rem)',fz: 'clamp(1.05rem, 2vw, 1.25rem)' },
  huge: { px: 'clamp(2.75rem, 6vw, 4.5rem)',py:'clamp(1.15rem, 2.6vw, 1.6rem)',fz:'clamp(1.15rem, 2.4vw, 1.6rem)' },
}
