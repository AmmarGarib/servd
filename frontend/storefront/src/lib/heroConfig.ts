// Landing-hero configuration.
//
// The scroll-expansion hero on the home page is operator-editable from the
// admin dashboard (Marketing → Landing Hero). It's stored — like the rest of
// the storefront CMS — as a SiteLayout under the slug `servd:hero`, holding a
// single `scrollHero` block. Until the operator sets one, we render the
// defaults below (no stock photography: the background is a token surface).

export interface HeroConfig {
  mediaType: 'video' | 'image';
  mediaSrc: string;
  posterSrc?: string;
  /** '' → the hero paints a plain servd-purple token background. */
  bgImageSrc: string;
  title: string;
  date?: string;
  scrollToExpand: string;
  textBlend?: boolean;
  overview?: string;
  conclusion?: string;
}

// Defaults. The expanding media is a cooking clip operators swap for their own
// via Admin → Storefront; the background is a token surface, not a stock photo.
export const FOOD_HERO_DEFAULTS: HeroConfig = {
  mediaType: 'video',
  mediaSrc:
    'https://videos.pexels.com/video-files/854565/854565-hd_1920_1080_25fps.mp4',
  bgImageSrc: '',
  title: 'Every kitchen, one place',
  date: 'order · explore · insiders',
  scrollToExpand: 'Scroll to explore',
  // mix-blend-difference turns the title muddy over a busy video; solid white +
  // drop-shadow reads far better. Operators can re-enable blend in the editor.
  textBlend: false,
  overview:
    'Order from any of our kitchens in one place. Pick what you are craving, add something from another brand if you like, and check out once.',
  conclusion:
    'simmer, stackd, Flipd — explore the brands, then join Insiders for rewards on every order.',
};

interface RawBlock {
  id?: string;
  type?: string;
  [k: string]: unknown;
}

// Map the stored `scrollHero` block onto a HeroConfig, falling back to the
// food defaults for any field the operator left blank. Defensive against
// malformed JSON — the CMS block schema is intentionally relaxed.
export function parseHeroBlock(
  blocks: readonly unknown[] | null | undefined,
): HeroConfig {
  const list = Array.isArray(blocks) ? (blocks as RawBlock[]) : [];
  const block = list.find(
    (b) => b && typeof b === 'object' && b.type === 'scrollHero',
  );
  if (!block) return FOOD_HERO_DEFAULTS;

  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback;
  const strOpt = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;

  return {
    mediaType: block.mediaType === 'video' ? 'video' : 'image',
    mediaSrc: str(block.mediaSrc, FOOD_HERO_DEFAULTS.mediaSrc),
    posterSrc: strOpt(block.posterSrc),
    bgImageSrc: str(block.bgImageSrc, FOOD_HERO_DEFAULTS.bgImageSrc),
    title: str(block.title, FOOD_HERO_DEFAULTS.title),
    date: strOpt(block.date),
    scrollToExpand: str(block.scrollToExpand, FOOD_HERO_DEFAULTS.scrollToExpand),
    textBlend: typeof block.textBlend === 'boolean' ? block.textBlend : true,
    overview: strOpt(block.overview),
    conclusion: strOpt(block.conclusion),
  };
}
