'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'

/**
 * StaxStackBuilderHero — Stax cinematic.
 *
 * Concept (from the operator):
 *   "Stax is upscale chef-driven, healthy-forward sandwiches and bowls.
 *    Industrial interior. The whole brand is about *stacking* — Smash
 *    Stax, Pub Stax, Flaky Stax, Golden Stax, Stacked Bowls."
 *
 * The hero is a brushed-steel chef's table viewed in 3/4 perspective.
 * As the user scrolls, ingredient layers drop in from above and land on
 * the steel surface, building a chef-style stack layer by layer. Each
 * layer is labelled with one of the menu categories — so by the time
 * the stack is complete, the user has seen the menu in motion.
 *
 * Restrained motion. No cartoon emojis. No spinning chrome bursts.
 * The "wow" comes from the choreography, not decoration.
 */

interface Layer {
  /** Menu category this layer represents — shown as the label. */
  label:   string
  /** Sub-label / what's in that category. */
  sub:     string
  /** Height of this layer in vh on the canvas. */
  height:  number
  /** Background — gradient/solid that reads as "this ingredient". */
  bg:      string
  /** When in scroll progress this layer drops in (0..1). */
  fireAt:  number
  /** Optional darker shadow band at the layer's underside. */
  shadow?: string
  /** Optional text colour for the label inside the layer. */
  textColor?: string
}

interface Props {
  brandName:  string
  /** Primary brand accent — copper / fire-orange for Stax. */
  accent:     string
  /** Industrial steel surface colour. */
  steel?:     string
  /** Ink — text + background outside the steel canvas. */
  ink?:       string
  cream?:     string
  orderHref:  string
  menuHref?:  string
  /** Each layer = one menu category. Default below matches the screenshot. */
  layers?:    Layer[]
}

const DEFAULT_LAYERS: Layer[] = [
  // The stack is rendered bottom-up: bottom bun first (lowest fireAt,
  // lands first), top bun last (highest fireAt, lands last).
  { label: 'Bottom · House Brioche',  sub: 'baked in-house, never frozen',  height: 8.5, bg: 'linear-gradient(180deg, #d4a056 0%, #8a5618 100%)', fireAt: 0.08, shadow: '#6d4413' },
  { label: 'Stacked Bowls',           sub: 'grain · greens · house dressing',
    height: 6, bg: 'linear-gradient(180deg, #b8d870 0%, #4d7a25 100%)',     fireAt: 0.18, shadow: '#356015', textColor: '#0a0a0a' },
  { label: 'Smash Stax',              sub: 'double smash patty, MCD / Smash / build-your-own',
    height: 7, bg: 'linear-gradient(180deg, #5b2f12 0%, #2a1108 100%)',     fireAt: 0.30 },
  { label: 'Pub Stax',                sub: 'thick patty, C-stack, CC-stack',
    height: 6.5, bg: 'linear-gradient(180deg, #6e3a18 0%, #321408 100%)',   fireAt: 0.42 },
  { label: 'Flaky Stax',              sub: 'sandwiches in house-made croissants',
    height: 5.5, bg: 'linear-gradient(180deg, #f4c97a 0%, #b6781f 100%)',   fireAt: 0.54, textColor: '#3a1f08' },
  { label: 'Golden Stax',             sub: 'sandwiches in house-made foccacia',
    height: 5, bg: 'linear-gradient(180deg, #e5b25d 0%, #9c6a16 100%)',     fireAt: 0.64, textColor: '#3a1f08' },
  { label: 'Side Stax · Desserts',    sub: 'pommes stax · roasties · stacked desserts',
    height: 4.5, bg: 'linear-gradient(180deg, #c97d4a 0%, #7a3d18 100%)',   fireAt: 0.74 },
  { label: 'Top · House Brioche',     sub: 'sesame · brushed butter · pressed on the flat-top',
    height: 9, bg: 'linear-gradient(180deg, #e0b367 0%, #a06c20 100%)',     fireAt: 0.86, shadow: '#704812' },
]

export function StaxStackBuilderHero({
  brandName, accent,
  steel = '#3a3f42',
  ink   = '#0d0a09',
  cream = '#f6f1e8',
  orderHref, menuHref,
  layers = DEFAULT_LAYERS,
}: Props) {
  const { ref } = useScrollProgress<HTMLDivElement>()

  return (
    <div
      ref={ref}
      style={{
        height: '380vh',          // generous runway — 8 layers, each needs ~45vh
        position: 'relative',
        background: ink,
        color: cream,
        ['--brand-accent' as string]: accent,
        ['--brand-ink' as string]:    ink,
      } as React.CSSProperties}
    >
      <div className="sticky overflow-hidden"
        style={{
          top: 0,
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          alignItems: 'center',
        }}
      >
        {/* Exposed brick wall background — top half */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse 80% 60% at 50% 30%, ${accent}22 0%, transparent 60%),
            linear-gradient(180deg, #1a1410 0%, #0a0807 100%)
          `,
        }} />
        {/* Brick pattern overlay — faint */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          opacity: 0.18,
          background: `
            repeating-linear-gradient(90deg, rgba(180,90,50,0.15) 0 80px, transparent 80px 82px),
            repeating-linear-gradient(0deg,  rgba(180,90,50,0.10) 0 38px, transparent 38px 40px)
          `,
        }} />

        {/* Brushed steel chef's table — bottom 28% of viewport, in 3/4
            perspective. The stack lands on the front edge of this table. */}
        <div aria-hidden="true" style={{
          position: 'absolute',
          left: 0, right: 0, bottom: 0,
          height: '32%',
          background: `
            linear-gradient(180deg, ${steel} 0%, #1d2022 100%),
            repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 3px)
          `,
          backgroundBlendMode: 'overlay',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          boxShadow: 'inset 0 28px 56px rgba(0,0,0,0.5)',
        }} />
        {/* Front edge of the table — slight highlight for the lip */}
        <div aria-hidden="true" style={{
          position: 'absolute',
          left: 0, right: 0,
          bottom: 'calc(32% - 2px)',
          height: 2,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)',
        }} />

        {/* Headline — slowly recedes as the stack builds */}
        <div
          style={{
            position: 'absolute',
            top: '8vh', left: 0, right: 0,
            textAlign: 'center', padding: '0 1rem',
            opacity: 'calc(1 - var(--scroll-progress, 0) * 1.3)',
            transform: 'translateY(calc(var(--scroll-progress, 0) * -30px))',
          } as React.CSSProperties}
        >
          <p className="eyebrow" style={{ color: accent, marginBottom: '0.85rem' }}>
            {brandName} · scroll to build the stack
          </p>
          <h1 className="display" style={{
            fontSize: 'clamp(3.5rem, 9vw, 7.5rem)',
            color: cream,
            lineHeight: 0.9,
            maxWidth: '900px',
            margin: '0 auto',
          }}>
            Chef-driven<span style={{ color: accent }}>.</span>
            <br />
            <span className="display-italic" style={{ color: accent, fontWeight: 600 }}>House-made everything.</span>
          </h1>
        </div>

        {/* THE STACK — layers stacked bottom-up on the table edge.
            Each layer translates from above (negative Y) into its
            resting position as scroll progress crosses fireAt. */}
        <div
          style={{
            position: 'relative',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column-reverse',   // bottom layer at the bottom of the flex
            alignItems: 'center',
            width: 'min(85vw, 720px)',
            paddingBottom: '12vh',             // sits just above the table lip
          }}
        >
          {layers.map((layer, i) => {
            const easedExpr = `min(1, max(0, (var(--scroll-progress, 0) - ${layer.fireAt}) * 6))`
            const invExpr   = `(1 - ${easedExpr})`
            return (
              <div
                key={layer.label}
                style={{
                  width: '100%',
                  height: `${layer.height}vh`,
                  marginTop: '-0.7vh',                  // overlap so layers butt against each other
                  borderRadius: '14px',
                  background: layer.bg,
                  boxShadow: layer.shadow
                    ? `0 -6px 0 -2px ${layer.shadow}, 0 18px 36px -8px rgba(0,0,0,0.55)`
                    : '0 18px 36px -8px rgba(0,0,0,0.55)',
                  position: 'relative',
                  // Each layer flies in from -100vh above + spinning slightly
                  // toward 0. Scale from 0.85 → 1 so it "settles".
                  transform: `
                    translateY(calc(-100vh * ${invExpr}))
                    rotate(calc(-6deg * ${invExpr}))
                    scale(calc(0.85 + 0.15 * ${easedExpr}))
                  `,
                  opacity: `calc(0.2 + ${easedExpr} * 0.8)`,
                  transition: 'transform 80ms linear, opacity 80ms linear',
                  zIndex: layers.length - i,             // higher layers on top
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 1.5rem',
                  gap: '0.85rem',
                }}
              >
                {/* Category index — copper tag, sits inside the layer */}
                <span style={{
                  background: 'rgba(0,0,0,0.45)',
                  color: accent,
                  fontFamily: 'var(--font-display)',
                  fontWeight: 800,
                  fontSize: '0.72rem',
                  letterSpacing: '0.18em',
                  padding: '0.3rem 0.6rem',
                  borderRadius: '4px',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div style={{ minWidth: 0 }}>
                  <p style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 800,
                    fontSize: 'clamp(0.95rem, 1.6vw, 1.25rem)',
                    color: layer.textColor ?? 'white',
                    letterSpacing: '-0.015em',
                    lineHeight: 1.05,
                    textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                  }}>
                    {layer.label}
                  </p>
                  <p style={{
                    fontSize: 'clamp(0.7rem, 1.1vw, 0.82rem)',
                    color: layer.textColor ? `${layer.textColor}cc` : 'rgba(255,255,255,0.78)',
                    marginTop: '0.15rem',
                  }}>
                    {layer.sub}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Final CTA — only visible once the top bun has landed */}
        <div
          style={{
            position: 'absolute', bottom: '4vh', left: 0, right: 0,
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
            gap: '0.7rem', padding: '0 1rem',
            opacity: 'calc(var(--scroll-progress, 0) * 2.6 - 2.2)',
            transform: 'translateY(calc((1 - var(--scroll-progress, 0)) * 20px))',
            zIndex: 20,
          } as React.CSSProperties}
        >
          <Link href={orderHref} className="brand-pill">
            Build your stack →
          </Link>
          {menuHref && (
            <Link href={menuHref} className="brand-pill-outline" style={{ borderColor: cream, color: cream }}>
              Browse the menu
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
