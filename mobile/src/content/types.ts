// Storefront content module — block + settings types for the mobile renderer.
//
// Mirrors frontend/storefront/src/lib/blocks.ts plus the additions in the
// content-module contract (decision 41): per-block animation + font, and the
// columns / video / signature / signup_form block types. Keep these in step
// with the backend's modules/siteLayouts/schemas.ts; the API validates loosely,
// so every renderer reads optional fields defensively.

export type ButtonStyle = 'primary' | 'secondary' | 'dark' | 'ghost'
export type ButtonSize  = 'sm' | 'md' | 'lg' | 'xl' | 'huge'
export type Align       = 'left' | 'center' | 'right'
export type SectionPad  = 'none' | 'sm' | 'md' | 'lg' | 'xl'
export type Animation   = 'none' | 'fade-up' | 'fade-in' | 'slide-left' | 'slide-right' | 'zoom-in'

export interface BlockBase {
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
  columns: LeafBlock[][]         // 2..4 columns; never nested columns
  gap?: 'sm' | 'md' | 'lg'
  stackOnMobile?: boolean        // default true (phones always stack here)
}

export interface VideoBlock extends BlockBase {
  type: 'video'
  url: string
  posterUrl?: string
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5'
}

export interface SignatureBlock extends BlockBase {
  type: 'signature'
}

export interface SignupFormBlock extends BlockBase {
  type: 'signup_form'
  mode: 'signup' | 'login'
  title?: string
  subtitle?: string
}

/** The servd new-brand waitlist form. The app shows a card that opens the web /waitlist. */
export interface WaitlistFormBlock extends BlockBase {
  type: 'waitlist_form'
  title?: string
  subtitle?: string
  buttonText?: string
}

export type BlockType =
  | 'hero' | 'cta_button' | 'banner' | 'text' | 'image' | 'gallery'
  | 'stat_strip' | 'voices' | 'kitchens' | 'featured_menu' | 'reviews'
  | 'quote' | 'spacer' | 'divider'
  | 'columns' | 'video' | 'signature' | 'signup_form' | 'waitlist_form'
  | 'siteLogo'   // servd:header (the web nav logo) — not rendered in the app

export type LeafBlock =
  | HeroBlock | CtaButtonBlock | BannerBlock | TextBlock | ImageBlock | GalleryBlock
  | StatStripBlock | VoicesBlock | KitchensBlock | FeaturedMenuBlock | ReviewsBlock
  | QuoteBlock | SpacerBlock | DividerBlock
  | VideoBlock | SignatureBlock | SignupFormBlock | WaitlistFormBlock

export type Block = LeafBlock | ColumnsBlock

// ── Settings ────────────────────────────────────────────────────────────────

export type PopupKind      = 'signup' | 'login' | 'offer' | 'announcement'
export type PopupDisplay   = 'modal' | 'bar' | 'corner'
export type PopupTrigger   = 'before_page' | 'after_seconds' | 'exit_intent' | 'scroll'
export type PopupAudience  = 'everyone' | 'signed_out' | 'signed_in' | 'never_ordered'
export type PopupFrequency = 'once' | 'daily' | 'every_visit'

export interface PopupRules {
  popupKind: PopupKind
  display: PopupDisplay
  trigger: PopupTrigger
  delaySeconds?: number
  scrollPct?: number
  pages: string[]        // path patterns, '*' suffix wildcard; [] = every page
  brands: string[]       // concept slugs; [] = all brands
  audience: PopupAudience
  frequency: PopupFrequency
  startsAt?: string
  endsAt?: string
}

export interface PageSettings {
  fonts?: { heading?: string; body?: string }
  ab?: { splitPct: number; blocks: Block[] }
  popup?: PopupRules
}

// ── Public API shapes ───────────────────────────────────────────────────────

export interface LibraryFont { family: string; url: string }

export interface SiteLayout {
  slug: string
  kind?: string
  title: string | null
  version: number
  blocks: Block[] | null
  settings: PageSettings | null
  fonts: LibraryFont[]
  publishedAt: string | null
  updatedAt: string | null
}

export interface LivePopup {
  slug: string
  version: number
  title: string | null
  blocks: Block[] | null
  rules: PopupRules
  fonts: LibraryFont[]
}

export type Variant = 'a' | 'b'
export type TrackEvent = 'view' | 'convert'
