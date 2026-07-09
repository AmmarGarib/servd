// Mirror of the storefront's block types so the dashboard editor is typed.
// Keep this in sync with apps/storefront/src/lib/blocks.ts when adding new
// block kinds. The shared types could also live in @servd/types if you want
// to extract them later.

export type ButtonStyle = 'primary' | 'secondary' | 'dark' | 'ghost'
export type ButtonSize  = 'sm' | 'md' | 'lg' | 'xl' | 'huge'
export type Align       = 'left' | 'center' | 'right'
export type SectionPad  = 'none' | 'sm' | 'md' | 'lg' | 'xl'

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'

export interface BaseBlock {
  id: string
  type: BlockType
  background?: string
  textColor?: string
  paddingY?: SectionPad
  fullBleed?: boolean
  hidden?: boolean
}

export interface Block extends BaseBlock {
  // Loose typed payload — editor forms know about each variant by `type`
  [key: string]: unknown
}

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export interface BlockSpec {
  type: BlockType
  label: string
  description: string
  icon: string
  default: () => Omit<Block, 'id'>
}

export const BLOCK_CATALOG: BlockSpec[] = [
  { type: 'hero',         label: 'Hero',           description: 'Big top section with title and image',  icon: '🎯',
    default: () => ({ type: 'hero', kicker: 'A new section', title: 'Headline goes here', subtitle: 'Short paragraph telling visitors what they\'re looking at.', align: 'left', height: 'lg', primaryCta: { text: 'Order Now', href: '/browse' } }) },
  { type: 'cta_button',   label: 'CTA Button',     description: 'A single prominent action button',      icon: '🔘',
    default: () => ({ type: 'cta_button', text: 'Order Now', href: '/browse', style: 'primary', size: 'lg', align: 'center', trailingArrow: true }) },
  { type: 'banner',       label: 'Banner',         description: 'Wide image strip with overlaid title',   icon: '🎫',
    default: () => ({ type: 'banner', title: 'Banner headline', subtitle: 'Optional supporting line.', backgroundColor: '#0a0a0a', textColor: '#ffffff', align: 'center', height: 'md' }) },
  { type: 'text',         label: 'Text',           description: 'A paragraph or short body of copy',     icon: '📝',
    default: () => ({ type: 'text', body: 'Write your copy here.', align: 'left', size: 'md', maxWidth: 'narrow' }) },
  { type: 'image',        label: 'Image',          description: 'A single image block',                  icon: '🖼️',
    default: () => ({ type: 'image', url: '', alt: '', rounded: true, aspect: '16/9' }) },
  { type: 'gallery',      label: 'Gallery',        description: 'A grid of images',                      icon: '🎞️',
    default: () => ({ type: 'gallery', images: [], columns: 3 }) },
  { type: 'stat_strip',   label: 'Stats',          description: 'A row of numbers with labels',          icon: '📊',
    default: () => ({ type: 'stat_strip', stats: [{ value: '7', label: 'kitchens' }, { value: '1', label: 'one app' }, { value: '0%', label: 'aggregator commission' }] }) },
  { type: 'voices',       label: 'Brand voices',   description: 'Two-column tagline list',               icon: '🗣️',
    default: () => ({ type: 'voices', kicker: 'The line-up', voices: [{ brand: 'Stax', line: 'Smashed, stacked, sauced.' }, { brand: 'Flipd', line: 'Buttermilk-brined, hand-breaded, hot.' }] }) },
  { type: 'kitchens',     label: 'Kitchens grid',  description: 'Live grid of brand cards',              icon: '🍽️',
    default: () => ({ type: 'kitchens', kicker: 'Tonight on servd', title: 'Pick your kitchen', showAllLink: true, max: 6 }) },
  { type: 'featured_menu',label: 'Featured menu',  description: 'Live menu items from a brand',          icon: '🍔',
    default: () => ({ type: 'featured_menu', kicker: 'Eat with us', title: "What everyone's ordering", max: 6 }) },
  { type: 'reviews',      label: 'Reviews',        description: 'Latest customer reviews for a brand',   icon: '⭐',
    default: () => ({ type: 'reviews', max: 6, showRating: true }) },
  { type: 'quote',        label: 'Quote',          description: 'A pull quote on a dark band',           icon: '💬',
    default: () => ({ type: 'quote', text: 'A short, memorable line.', attribution: 'Source', size: 'lg', background: '#0a0a0a', textColor: '#ffffff', paddingY: 'xl' }) },
  { type: 'spacer',       label: 'Spacer',         description: 'Vertical breathing room',               icon: '⬜',
    default: () => ({ type: 'spacer', size: 'md' }) },
  { type: 'divider',      label: 'Divider',        description: 'A horizontal hairline rule',            icon: '➖',
    default: () => ({ type: 'divider' }) },
]

export function newBlock(type: BlockType): Block {
  const spec = BLOCK_CATALOG.find((s) => s.type === type)
  if (!spec) throw new Error(`Unknown block type: ${type}`)
  return { ...spec.default(), id: newId() } as Block
}
