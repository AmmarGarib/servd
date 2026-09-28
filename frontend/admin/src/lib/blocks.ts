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

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'
  // content module additions
  | 'columns' | 'video' | 'signature' | 'signup_form'
  // single-block "kinds": the servd:hero scroll hero and brand footers
  | 'scrollHero' | 'brandFooter'

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
  { type: 'signature',    label: 'Built-in design', description: 'The page\'s own designed layout. Add elements above or below it.', icon: 'SIG', group: 'Layout',
    default: () => ({ type: 'signature' }) },
  { type: 'columns',      label: 'Columns',        description: '2 to 4 side-by-side columns; drag elements into them', icon: 'COL', group: 'Layout',
    default: () => ({ type: 'columns', columns: [[], []], gap: 'md', stackOnMobile: true }) },
  { type: 'spacer',       label: 'Spacer',         description: 'Vertical breathing room',               icon: 'SP', group: 'Layout',
    default: () => ({ type: 'spacer', size: 'md' }) },
  { type: 'divider',      label: 'Divider',        description: 'A horizontal hairline rule',            icon: 'HR', group: 'Layout',
    default: () => ({ type: 'divider' }) },
  { type: 'hero',         label: 'Hero',           description: 'Big top section with title and image',  icon: 'H', group: 'Content',
    default: () => ({ type: 'hero', kicker: 'A new section', title: 'Headline goes here', subtitle: 'Short paragraph telling visitors what they\'re looking at.', align: 'left', height: 'lg', primaryCta: { text: 'Order now', href: '/browse' } }) },
  { type: 'text',         label: 'Text',           description: 'A paragraph or short body of copy',     icon: 'T', group: 'Content',
    default: () => ({ type: 'text', body: 'Write your copy here.', align: 'left', size: 'md', maxWidth: 'narrow' }) },
  { type: 'cta_button',   label: 'Button',         description: 'A single prominent action button',      icon: 'BTN', group: 'Content',
    default: () => ({ type: 'cta_button', text: 'Order now', href: '/browse', style: 'primary', size: 'lg', align: 'center', trailingArrow: true }) },
  { type: 'banner',       label: 'Banner',         description: 'Wide image strip with overlaid title',   icon: 'BN', group: 'Content',
    default: () => ({ type: 'banner', title: 'Banner headline', subtitle: 'Optional supporting line.', backgroundColor: '#0a0a0a', textColor: '#ffffff', align: 'center', height: 'md' }) },
  { type: 'quote',        label: 'Quote',          description: 'A pull quote on a dark band',           icon: 'QT', group: 'Content',
    default: () => ({ type: 'quote', text: 'A short, memorable line.', attribution: 'Source', size: 'lg', background: '#0a0a0a', textColor: '#ffffff', paddingY: 'xl' }) },
  { type: 'stat_strip',   label: 'Stats',          description: 'A row of numbers with labels',          icon: '123', group: 'Content',
    default: () => ({ type: 'stat_strip', stats: [{ value: '3', label: 'kitchens' }, { value: '1', label: 'one app' }, { value: '0%', label: 'aggregator commission' }] }) },
  { type: 'voices',       label: 'Brand voices',   description: 'Two-column tagline list',               icon: 'VO', group: 'Content',
    default: () => ({ type: 'voices', kicker: 'The line-up', voices: [{ brand: 'simmer', line: 'Slow nights, plated softly.' }, { brand: 'flipd', line: 'A cool diner.' }] }) },
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
  { type: 'scrollHero',   label: 'Scroll hero',    description: 'The expanding hero at the top of the servd home page', icon: 'SH', group: 'Special',
    default: () => ({ type: 'scrollHero', mediaType: 'image', bgImageSrc: '', mediaSrc: '', posterSrc: '', title: '', date: '', scrollToExpand: 'Scroll to explore', textBlend: true, overview: '', conclusion: '' }) },
  { type: 'brandFooter',  label: 'Brand footer',   description: 'Footer copy and social links for a brand microsite', icon: 'FT', group: 'Special',
    default: () => ({ type: 'brandFooter', ctaEyebrow: '', ctaHeadline: '', ctaAccent: '', tagline: '', social: { instagram: '', tiktok: '', facebook: '', whatsapp: '' } }) },
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
  return type !== 'columns' && type !== 'signature' && type !== 'scrollHero' && type !== 'brandFooter'
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
    case 'signature':     return 'The page\'s built-in design renders here'
    case 'signup_form':   return `${block.mode === 'login' ? 'Log in' : 'Sign up'}${block.title ? `: ${s(block.title)}` : ''}`
    case 'scrollHero':    return s(block.title, '(food placeholders)')
    case 'brandFooter':   return s(block.tagline, s(block.ctaHeadline, '(brand defaults)'))
    default:              return ''
  }
}
