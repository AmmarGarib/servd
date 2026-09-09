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

interface BlockBase {
  id: string                  // uuid, stable across edits
  type: BlockType
  background?: string         // CSS color or var(--…); falls back to white
  textColor?: string          // override readable text
  paddingY?: SectionPad       // top/bottom padding band
  fullBleed?: boolean         // bleed to edges (default: container-constrained)
  hidden?: boolean            // toggle off without deleting
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

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'

export type Block =
  | HeroBlock | CtaButtonBlock | BannerBlock | TextBlock | ImageBlock | GalleryBlock
  | StatStripBlock | VoicesBlock | KitchensBlock | FeaturedMenuBlock | ReviewsBlock
  | QuoteBlock | SpacerBlock | DividerBlock

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
        { brand: 'stackd', line: 'Smashed, stacked, sauced.' },
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
        { brand: 'stackd', line: 'Smashed, stacked, sauced.' },
        { brand: 'Flipd',   line: 'Buttermilk-brined, hand-breaded, hot.' },
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
