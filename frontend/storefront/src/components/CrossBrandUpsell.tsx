'use client'
import Link from 'next/link'

// Cross-brand upsell shown on the checkout page. Surfaces 3 popular dishes
// from *other* GS Foods kitchens — the point is discovery and a second-order
// tap that moves the customer back into another brand's menu.
//
// Why links, not add-to-cart: the cart store currently scopes items to a
// single conceptSlug, so adding cross-brand items here would break the order
// API. Once the backend supports multi-kitchen orders, swap each <Link> for
// an `addItem(...)` call. (TODO: when multi-kitchen carts ship.)

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
  { brandSlug: 'stax',            brandName: 'Stax',            dish: 'The Stax Classic',       price: 'Rs. 1,200', emoji: '🍔', color: '#D4581A', blurb: 'Double smash, aged cheddar, special sauce, brioche.' },
  { brandSlug: 'flipd',           brandName: 'Flipd',           dish: 'Hot Honey Tenders',      price: 'Rs. 950',   emoji: '🍗', color: '#E5A100', blurb: 'Buttermilk-brined, hand-breaded, hot honey drizzle.' },
  { brandSlug: 'strata',          brandName: 'Strata',          dish: 'Performance Bowl',       price: 'Rs. 1,100', emoji: '🥗', color: '#2D6A4F', blurb: 'Quinoa, grilled chicken, roasted veg, tahini. 45g protein.' },
  { brandSlug: 'craveman',        brandName: 'Craveman',        dish: 'Seekh Kebab Bowl',       price: 'Rs. 1,300', emoji: '🥘', color: '#F5A623', blurb: 'Charred seekh, saffron rice, green chutney, naan crisps.' },
  { brandSlug: 'simmer',          brandName: 'Simmer',          dish: 'Smoked Labneh',          price: 'Rs. 900',   emoji: '🫙', color: '#2D4A3E', blurb: 'Wood-smoked labneh, za\'atar oil, warm pita, olives.' },
  { brandSlug: 'garnish-station', brandName: 'Garnish Station', dish: 'Loaded Bowl',            price: 'Rs. 900',   emoji: '🥙', color: '#C4A24A', blurb: 'Grain base, 5 toppings, protein, premium sauce.' },
  { brandSlug: 'stax-padel',      brandName: 'Stax @ Padel',   dish: 'Burger + Fries Combo',   price: 'Rs. 1,450', emoji: '🎾', color: '#DC2626', blurb: 'Any burger, regular fries, can. Court-side pickup.' },
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
            style={{ color: 'rgba(24,22,15,0.38)' }}>
            🍽️ &nbsp;From our other kitchens
          </p>
          <p className="font-black text-base mt-1" style={{ color: '#18160f' }}>Want to add a side from another GS Foods brand?</p>
          <p className="text-xs mt-0.5" style={{ color: 'rgba(24,22,15,0.55)' }}>
            One operator, seven kitchens. Tap to browse — we&rsquo;ll save your current cart.
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
              fontSize: '2.6rem',
            }}>
              <span aria-hidden="true">{p.emoji}</span>
            </div>
            <div style={{ padding: '0.7rem 0.85rem 0.85rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <p style={{ fontSize: '0.65rem', fontWeight: 700, color: p.color, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {p.brandName}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.92rem', fontWeight: 800, letterSpacing: '-0.01em', color: '#18160f' }}>{p.dish}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: p.color, whiteSpace: 'nowrap' }}>{p.price}</span>
              </div>
              <p style={{ fontSize: '0.74rem', color: 'rgba(24,22,15,0.55)', lineHeight: 1.35 }}>{p.blurb}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
