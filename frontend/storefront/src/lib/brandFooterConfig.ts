// Per-brand footer configuration.
//
// The brand-microsite footer (BrandShell → BrandFooter) is operator-editable
// from the admin (Storefront → Brand Footers). Stored — like the landing hero —
// as a SiteLayout under the slug `brand:<slug>:footer`, holding a single
// `brandFooter` block. Until the operator sets one, we derive sensible defaults
// from the concept (name + description). The brand colour is handled separately
// (BrandShell already themes the footer with the concept accent).

export interface BrandFooterConfig {
  ctaEyebrow: string   // small line above the CTA, e.g. "simmer · ready when you are"
  ctaHeadline: string  // big line, e.g. "Hungry?"
  ctaAccent: string    // accented continuation, e.g. "Let's eat."
  tagline: string      // the short blurb under the wordmark
  social: {
    instagram?: string
    tiktok?: string
    facebook?: string
    whatsapp?: string
  }
}

// Defaults derived from the concept — matches what the footer rendered before
// it became editable, so an un-configured brand looks identical to today.
export function defaultBrandFooter(concept: { name: string; slug?: string; description?: string | null }): BrandFooterConfig {
  // simmer's bible bans question and exclamation marks and title case, so the
  // generic "Hungry? Let's eat." can never be its default.
  if (concept.slug === 'simmer') {
    return {
      ctaEyebrow: 'simmer · the room is set',
      ctaHeadline: 'the kitchen is on.',
      ctaAccent: 'come down.',
      tagline: concept.description ?? '',
      social: {},
    }
  }
  return {
    ctaEyebrow: `${concept.name.toLowerCase()} · ready when you are`,
    ctaHeadline: 'Hungry?',
    ctaAccent: "Let's eat.",
    tagline: concept.description ?? '',
    social: {},
  }
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback
}

function url(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// Merge a SiteLayout `blocks` payload over the concept-derived defaults.
export function parseBrandFooterBlock(blocks: unknown, fallback: BrandFooterConfig): BrandFooterConfig {
  const arr = Array.isArray(blocks) ? (blocks as Array<Record<string, unknown>>) : []
  const b = arr.find((x) => x?.['type'] === 'brandFooter')
  if (!b) return fallback
  const social = (b['social'] && typeof b['social'] === 'object') ? (b['social'] as Record<string, unknown>) : {}
  return {
    ctaEyebrow:  str(b['ctaEyebrow'],  fallback.ctaEyebrow),
    ctaHeadline: str(b['ctaHeadline'], fallback.ctaHeadline),
    ctaAccent:   str(b['ctaAccent'],   fallback.ctaAccent),
    tagline:     str(b['tagline'],     fallback.tagline),
    social: {
      instagram: url(social['instagram']),
      tiktok:    url(social['tiktok']),
      facebook:  url(social['facebook']),
      whatsapp:  url(social['whatsapp']),
    },
  }
}
