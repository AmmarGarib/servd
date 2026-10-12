// Mirror of the storefront's block types so the admin page builder is typed.
// The binding shape is the storefront content-module contract (owner decision
// 41): the storefront renderer (frontend/storefront/src/lib/blocks.ts), the
// mobile renderer and the backend validation all read the same Block JSON.
// Keep this in sync when adding block kinds.

export type ButtonStyle = 'primary' | 'secondary' | 'dark' | 'ghost'
export type ButtonSize  = 'sm' | 'md' | 'lg' | 'xl' | 'huge'
export type Align       = 'left' | 'center' | 'right'
export type SectionPad  = 'none' | 'sm' | 'md' | 'lg' | 'xl'
export type Animation   = 'none' | 'fade-up' | 'fade-in' | 'slide-left' | 'slide-right' | 'zoom-in'

// Scroll effects (D4 stage 1). Same order and spelling in all four copies.
// Copies: frontend/storefront/src/lib/blocks.ts, this file,
// mobile/src/content/types.ts and backend/src/modules/siteLayouts/schemas.ts.
export const MOTION_PRESETS = ['parallax', 'fade', 'grow', 'pin-reveal', 'sticky-stack', 'side-pan', 'text-reveal'] as const
export type MotionPreset = (typeof MOTION_PRESETS)[number]
export const MOTION_INTENSITIES = ['subtle', 'medium', 'strong'] as const
export type MotionIntensity = (typeof MOTION_INTENSITIES)[number]

/** A block's scroll effect. Absent = none. intensity absent = 'medium'.
 *  Renderers treat an unknown/invalid value as "none" — never hidden content. */
export interface BlockMotion {
  preset: MotionPreset
  intensity?: MotionIntensity
}

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'
  // content module additions
  | 'columns' | 'video' | 'signup_form'
  // the servd new-brand waitlist opt-in form (contract 2026-10-07)
  | 'waitlist_form'
  // a designed section of a storefront page (variant + fields; the catalogue
  // comes from the storefront — see lib/sections.ts)
  | 'section'

export interface BaseBlock {
  id: string
  type: BlockType
  background?: string
  textColor?: string
  paddingY?: SectionPad
  fullBleed?: boolean
  hidden?: boolean
  animation?: Animation
  animationDelayMs?: number      // 0..3000
  animationDurationMs?: number   // 200..3000, default 600
  fontFamily?: string            // library font family or a built-in stack
  motion?: BlockMotion           // scroll effect; independent of `animation` (entrance, plays once)
}

export interface Block extends BaseBlock {
  // Loose typed payload — editor forms know about each variant by `type`
  [key: string]: unknown
}

export const ANIMATIONS: Array<{ value: Animation; label: string }> = [
  { value: 'none',        label: 'None' },
  { value: 'fade-up',     label: 'Fade up' },
  { value: 'fade-in',     label: 'Fade in' },
  { value: 'slide-left',  label: 'Slide in from right' },
  { value: 'slide-right', label: 'Slide in from left' },
  { value: 'zoom-in',     label: 'Zoom in' },
]

export const isMotionPreset = (v: unknown): v is MotionPreset =>
  typeof v === 'string' && (MOTION_PRESETS as readonly string[]).includes(v)
export const isMotionIntensity = (v: unknown): v is MotionIntensity =>
  typeof v === 'string' && (MOTION_INTENSITIES as readonly string[]).includes(v)

/** What the editor calls each scroll effect (inspector gallery, Layers badge).
 *  The exact behaviour of each preset lives in the storefront's lib/motion.ts. */
export const MOTION_UI: Record<MotionPreset, { label: string; description: string }> = {
  'parallax':     { label: 'Parallax',           description: 'Drifts up slower than the page.' },
  'fade':         { label: 'Fade as you scroll', description: 'Fades in as it scrolls into view.' },
  'grow':         { label: 'Grow as you scroll', description: 'Starts smaller and grows to full size.' },
  'pin-reveal':   { label: 'Pin and reveal',     description: 'Holds at the top while it opens from a card to full size.' },
  'sticky-stack': { label: 'Sticky stack',       description: 'Sticks at the top; the next one slides over it like cards.' },
  'side-pan':     { label: 'Sideways pan',       description: 'Slides in from the right as you scroll down.' },
  'text-reveal':  { label: 'Text reveal',        description: 'Fills in from faint to full, top to bottom.' },
}

export const MOTION_INTENSITY_UI: Record<MotionIntensity, string> = { subtle: 'Subtle', medium: 'Medium', strong: 'Strong' }

/** The block's scroll-effect preset when it is one the editor knows, else null. */
export function motionPresetOf(block: Block): MotionPreset | null {
  const m = block.motion as unknown
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const p = (m as Record<string, unknown>)['preset']
  return isMotionPreset(p) ? p : null
}

/**
 * The scroll effects the editor offers for a layout. Only pages and footers
 * scroll with the page (a header is sticky, a widget fixed, a pop-up does not
 * scroll). Pin and reveal and sticky stack need room below them, which a
 * footer never has, so they are pages only. Simmer pages leave out Text
 * reveal: its soft fade reads as a gradient, which Simmer bans (owner to
 * confirm).
 */
export function motionPresetsFor(kind: string, slug: string): MotionPreset[] {
  if (kind !== 'page' && kind !== 'footer') return []
  return MOTION_PRESETS.filter((p) => {
    if (kind === 'footer' && (p === 'pin-reveal' || p === 'sticky-stack')) return false
    if (isSimmerSlug(slug) && p === 'text-reveal') return false
    return true
  })
}

export const isSimmerSlug = (slug: string) => slug === 'brand:simmer' || slug.startsWith('brand:simmer:')

/** Built-in font stacks offered next to the library's uploaded fonts. */
export const BUILTIN_FONTS: Array<{ label: string; value: string }> = [
  { label: 'Sans (system)', value: 'system-ui, sans-serif' },
  { label: 'Serif',         value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',          value: 'ui-monospace, monospace' },
]

export const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export type PaletteGroup = 'Layout' | 'Content' | 'Media' | 'Live data' | 'Forms' | 'Special'

export interface BlockSpec {
  type: BlockType
  label: string
  description: string
  /** Short text badge shown in the palette (no emoji). */
  icon: string
  group: PaletteGroup
  default: () => Omit<Block, 'id'>
}

export const BLOCK_CATALOG: BlockSpec[] = [
  { type: 'columns',      label: 'Columns',        description: '2 to 4 side-by-side columns; drag elements into them', icon: 'COL', group: 'Layout',
    default: () => ({ type: 'columns', columns: [[], []], gap: 'md', stackOnMobile: true }) },
  { type: 'spacer',       label: 'Spacer',         description: 'Vertical breathing room',               icon: 'SP', group: 'Layout',
    default: () => ({ type: 'spacer', size: 'md' }) },
  { type: 'divider',      label: 'Divider',        description: 'A horizontal hairline rule',            icon: 'HR', group: 'Layout',
    default: () => ({ type: 'divider' }) },
  { type: 'hero',         label: 'Hero',           description: 'Big top section with title and image',  icon: 'H', group: 'Content',
    default: () => ({ type: 'hero', kicker: 'A new section', title: 'Headline goes here', subtitle: 'Short paragraph telling visitors what they\'re looking at.', align: 'left', height: 'lg', primaryCta: { text: 'Order now', href: '/home#kitchens' } }) },
  { type: 'text',         label: 'Text',           description: 'A paragraph or short body of copy',     icon: 'T', group: 'Content',
    default: () => ({ type: 'text', body: 'Write your copy here.', align: 'left', size: 'md', maxWidth: 'narrow' }) },
  { type: 'cta_button',   label: 'Button',         description: 'A single prominent action button',      icon: 'BTN', group: 'Content',
    default: () => ({ type: 'cta_button', text: 'Order now', href: '/home#kitchens', style: 'primary', size: 'lg', align: 'center', trailingArrow: true }) },
  { type: 'banner',       label: 'Banner',         description: 'Wide image strip with overlaid title',   icon: 'BN', group: 'Content',
    default: () => ({ type: 'banner', title: 'Banner headline', subtitle: 'Optional supporting line.', backgroundColor: '#6a0dad', textColor: '#ffffff', align: 'center', height: 'md' }) },
  { type: 'quote',        label: 'Quote',          description: 'A pull quote on a dark band',           icon: 'QT', group: 'Content',
    default: () => ({ type: 'quote', text: 'A short, memorable line.', attribution: 'Source', size: 'lg', background: '#6a0dad', textColor: '#ffffff', paddingY: 'xl' }) },
  { type: 'stat_strip',   label: 'Stats',          description: 'A row of numbers with labels',          icon: '123', group: 'Content',
    default: () => ({ type: 'stat_strip', stats: [{ value: '3', label: 'kitchens' }, { value: '1', label: 'one app' }, { value: '0%', label: 'aggregator commission' }] }) },
  { type: 'voices',       label: 'Brand voices',   description: 'Two-column tagline list',               icon: 'VO', group: 'Content',
    default: () => ({ type: 'voices', kicker: 'The line-up', voices: [{ brand: 'Simmer', line: 'Slow nights, plated softly.' }, { brand: 'Flipd', line: 'A cool diner.' }] }) },
  { type: 'image',        label: 'Image',          description: 'A single image',                        icon: 'IMG', group: 'Media',
    default: () => ({ type: 'image', url: '', alt: '', rounded: true, aspect: '16/9' }) },
  { type: 'gallery',      label: 'Gallery',        description: 'A grid of images',                      icon: 'GAL', group: 'Media',
    default: () => ({ type: 'gallery', images: [], columns: 3 }) },
  { type: 'video',        label: 'Video',          description: 'An uploaded or linked video',           icon: 'VID', group: 'Media',
    default: () => ({ type: 'video', url: '', autoplay: true, loop: true, muted: true, aspectRatio: '16:9' }) },
  { type: 'kitchens',     label: 'Kitchens grid',  description: 'Live grid of brand cards',              icon: 'KIT', group: 'Live data',
    default: () => ({ type: 'kitchens', kicker: 'Tonight on servd', title: 'Pick your kitchen', showAllLink: true, max: 6 }) },
  { type: 'featured_menu',label: 'Featured menu',  description: 'Live menu items from a brand',          icon: 'MNU', group: 'Live data',
    default: () => ({ type: 'featured_menu', kicker: 'Eat with us', title: "What everyone's ordering", max: 6 }) },
  { type: 'reviews',      label: 'Reviews',        description: 'Latest customer reviews for a brand',   icon: 'REV', group: 'Live data',
    default: () => ({ type: 'reviews', max: 6, showRating: true }) },
  { type: 'signup_form',  label: 'Sign-up form',   description: 'The storefront\'s one-code sign-in / sign-up', icon: 'OTP', group: 'Forms',
    default: () => ({ type: 'signup_form', mode: 'signup', title: 'Join servd', subtitle: 'One code to your phone. No passwords.' }) },
  { type: 'waitlist_form', label: 'Waitlist form', description: 'Join the new-brand waitlist (WhatsApp-verified opt-in)', icon: 'WL', group: 'Forms',
    default: () => ({ type: 'waitlist_form', title: 'Be first in line.', subtitle: 'We\'ll message you when servd opens a new brand.', buttonText: 'Join the waitlist' }) },
]

export function blockSpec(type: string): BlockSpec | undefined {
  return BLOCK_CATALOG.find((s) => s.type === type)
}

export function blockLabel(type: string): string {
  return blockSpec(type)?.label ?? type
}

export function newBlock(type: BlockType): Block {
  const spec = blockSpec(type)
  if (!spec) throw new Error(`Unknown block type: ${type}`)
  return { ...spec.default(), id: newId() } as Block
}

/** Types that may sit inside a columns element. */
export function canNest(type: string): boolean {
  return type !== 'columns' && type !== 'section' && !type.startsWith('section:')
}

/** The children of a columns element (gallery also has a numeric `columns`). */
export function columnsOf(block: Block): Block[][] | null {
  if (block.type !== 'columns' || !Array.isArray(block.columns)) return null
  return (block.columns as unknown[]).map((c) => (Array.isArray(c) ? (c as Block[]) : []))
}

/** Deep copy with fresh ids (columns children included). */
export function cloneBlock(block: Block): Block {
  const copy = JSON.parse(JSON.stringify(block)) as Block
  const reId = (b: Block): Block => {
    const cols = columnsOf(b)
    return { ...b, id: newId(), ...(cols ? { columns: cols.map((col) => col.map(reId)) } : {}) }
  }
  return reId(copy)
}

export function cloneBlocks(blocks: Block[]): Block[] {
  return blocks.map(cloneBlock)
}

export function blockSummary(block: Block): string {
  const s = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
  switch (block.type) {
    case 'hero':          return s(block.title, '(no title)')
    case 'cta_button':    return `${s(block.text)} -> ${s(block.href)}`
    case 'banner':        return s(block.title, '(no title)')
    case 'text':          return s(block.body).slice(0, 80)
    case 'image':         return s(block.url, '(no image)')
    case 'gallery':       return `${(block.images as unknown[] | undefined)?.length ?? 0} images`
    case 'stat_strip':    return `${(block.stats as unknown[] | undefined)?.length ?? 0} stats`
    case 'voices':        return `${(block.voices as unknown[] | undefined)?.length ?? 0} voices`
    case 'kitchens':      return s(block.title, 'Kitchens grid')
    case 'featured_menu': return s(block.title, 'Featured items')
    case 'reviews':       return `latest ${(block.max as number | undefined) ?? 6}`
    case 'quote':         return s(block.text).slice(0, 80)
    case 'spacer':        return `size: ${s(block.size, 'md')}`
    case 'divider':       return 'hairline rule'
    case 'columns':       return `${columnsOf(block)?.length ?? 0} columns`
    case 'video':         return s(block.url, '(no video)')
    case 'signup_form':   return `${block.mode === 'login' ? 'Log in' : 'Sign up'}${block.title ? `: ${s(block.title)}` : ''}`
    case 'waitlist_form': return s(block.title, 'New-brand waitlist')
    default:              return ''
  }
}
