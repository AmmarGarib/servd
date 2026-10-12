'use client'
import Link from 'next/link'

// Cross-brand upsell on the checkout page. Surfaces the OTHER live GS Foods
// brands — discovery + a second-order tap that bounces the customer back
// into another brand's menu.
//
// GS Foods runs three live brands: Stackd, Simmer, Flipd. Keep this list in
// sync with BrandFallback.tsx + lib/concept.ts whenever a brand is added or
// retired. Phantom/wishlist brands (Strata, Craveman, Bukhari, Garnish
// Station, Stackd @ Padel) were removed in May 2026 — none of them are real
// operations, so the upsell was previously sending customers to brands that
// don't exist.
//
// Why links, not add-to-cart: the cart store scopes items to a single
// conceptSlug, so adding cross-brand items here would break the order API.
// When the backend supports multi-kitchen orders, swap each <Link> for an
// addItem(...) call.

interface UpsellPick {
  brandSlug: string
  brandName: string
  dish: string
  price: string
  emoji: string
  color: string
  blurb: string
}

const PICKS: UpsellPick[] = [
  { brandSlug: 'stackd',   brandName: 'Stackd',   dish: 'The Stackd Classic',  price: 'Rs. 1,800', emoji: '🍔', color: '#293B47', blurb: 'Double smash, aged cheddar, special sauce, brioche.' },
  { brandSlug: 'simmer', brandName: 'Simmer', dish: 'Burrata',           price: 'Rs. 1,400', emoji: '🫒', color: '#06392F', blurb: 'Blistered tomato, olive oil cracker, basil.' },
  { brandSlug: 'flipd',  brandName: 'Flipd',  dish: 'The Court Classic',  price: 'Rs. 1,200', emoji: '🍔', color: '#2092E9', blurb: 'Dry-aged smash, brioche, sauce. Court-side cast-iron.' },
]

interface Props {
  currentSlug: string
  max?: number
}

export function CrossBrandUpsell({ currentSlug, max = 3 }: Props) {
  const others = PICKS.filter((p) => p.brandSlug !== currentSlug).slice(0, max)
  if (others.length === 0) return null

  return (
    <div className="rounded-2xl p-4"
      style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em]"
            style={{ color: 'var(--servd-mute)' }}>
            From our other kitchens
          </p>
          <p className="font-black text-base mt-1" style={{ color: 'var(--servd-ink)' }}>Want to add a side from another GS Foods brand?</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--servd-mute)' }}>
            One operator, three kitchens. Tap to browse — we&rsquo;ll save your current cart.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.6rem' }}>
        {others.map((p) => (
          <Link
            key={p.brandSlug}
            href={`/${p.brandSlug}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              textDecoration: 'none',
              color: 'inherit',
              borderRadius: '0.85rem',
              overflow: 'hidden',
              border: '1px solid rgba(0,0,0,0.07)',
              transition: 'transform 140ms ease, box-shadow 140ms ease',
            }}
          >
            <div style={{
              aspectRatio: '4/3',
              background: `linear-gradient(135deg, ${p.color} 0%, ${p.color}cc 100%)`,
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 800,
              fontSize: '3.2rem', color: 'white',
              letterSpacing: '-0.04em', lineHeight: 1,
            }}>
              <span aria-hidden="true">{p.brandName[0]}</span>
            </div>
            <div style={{ padding: '0.7rem 0.85rem 0.85rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <p style={{ fontSize: '0.65rem', fontWeight: 700, color: p.color, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {p.brandName}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.92rem', fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--servd-ink)' }}>{p.dish}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: p.color, whiteSpace: 'nowrap' }}>{p.price}</span>
              </div>
              <p style={{ fontSize: '0.74rem', color: 'var(--servd-mute)', lineHeight: 1.35 }}>{p.blurb}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
