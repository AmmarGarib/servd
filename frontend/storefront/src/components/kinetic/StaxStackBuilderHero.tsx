'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
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

// Each layer in the stack is either:
//   - a regular content layer (gradient bar with a label + sub)
//   - the top bun (domed SVG, sesame seeds, glossy gradient)
//   - the bottom bun (flat-domed SVG, deeper crust)
type LayerVariant = 'top-bun' | 'bottom-bun' | 'fill'

interface Layer {
  /** What kind of shape this layer is rendered as. */
  variant?: LayerVariant
  /** Menu category this layer represents — shown as the label.
   *  Buns set their own labels internally. */
  label:   string
  /** Sub-label / what's in that category. */
  sub:     string
  /** Height of this layer in vh on the canvas. */
  height:  number
  /** Background — gradient/solid that reads as "this ingredient".
   *  Buns ignore this; their gradients live in the SVG. */
  bg?:     string
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
  // Bottom-up: bottom bun lands first, top bun lands last. Buns use the
  // dedicated SVG variants so they read as actual bread — flat-domed
  // base, glossy sesame top — not flat coloured bars.
  { variant: 'bottom-bun', label: 'House Brioche', sub: 'baked in-house, never frozen',          height: 10,   fireAt: 0.06 },
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
  { variant: 'top-bun',   label: 'House Brioche', sub: 'sesame · brushed butter · pressed on the flat-top', height: 13, fireAt: 0.86 },
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
            const wrapperStyle: CSSProperties = {
              width: '100%',
              height: `${layer.height}vh`,
              marginTop: '-0.7vh',
              position: 'relative',
              transform: `
                translateY(calc(-100vh * ${invExpr}))
                rotate(calc(-6deg * ${invExpr}))
                scale(calc(0.85 + 0.15 * ${easedExpr}))
              `,
              opacity: `calc(0.2 + ${easedExpr} * 0.8)`,
              transition: 'transform 80ms linear, opacity 80ms linear',
              zIndex: layers.length - i,
            }
            // Buns get their own SVG-rendered shape; the label sits
            // overlaid on top of the bun.
            if (layer.variant === 'top-bun') {
              return (
                <div key={layer.label} style={wrapperStyle}>
                  <TopBun />
                  <BunLabel idx={i + 1} layer={layer} accent={accent} />
                </div>
              )
            }
            if (layer.variant === 'bottom-bun') {
              return (
                <div key={layer.label} style={wrapperStyle}>
                  <BottomBun />
                  <BunLabel idx={i + 1} layer={layer} accent={accent} bottom />
                </div>
              )
            }
            // Regular fill layer — gradient bar with index + label inside.
            return (
              <div
                key={layer.label}
                style={{
                  ...wrapperStyle,
                  borderRadius: '14px',
                  background: layer.bg,
                  boxShadow: layer.shadow
                    ? `0 -6px 0 -2px ${layer.shadow}, 0 18px 36px -8px rgba(0,0,0,0.55)`
                    : '0 18px 36px -8px rgba(0,0,0,0.55)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 1.5rem',
                  gap: '0.85rem',
                }}
              >
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

// ─── SVG buns ────────────────────────────────────────────────────────
//
// Brioche illustrated in SVG so the top dome curves and the bottom flat
// crust read as actual bread — not flat coloured rectangles. Multi-stop
// radial gradients give each bun real-looking depth + a glossy highlight.
// They breathe at idle (subtle CSS keyframe wobble) so the stack feels
// alive even before the user scrolls.

function TopBun() {
  return (
    <svg
      viewBox="0 0 800 220"
      preserveAspectRatio="xMidYMid meet"
      width="100%" height="100%"
      style={{
        display: 'block',
        overflow: 'visible',
        filter: 'drop-shadow(0 14px 24px rgba(0,0,0,0.45))',
        animation: 'staxBunBreath 5.5s ease-in-out infinite alternate',
      }}
    >
      <defs>
        <radialGradient id="staxTopBun" cx="50%" cy="22%" r="80%">
          <stop offset="0%"   stopColor="#FFE3A8" />
          <stop offset="32%"  stopColor="#E0A95C" />
          <stop offset="72%"  stopColor="#B46F2A" />
          <stop offset="100%" stopColor="#7A4318" />
        </radialGradient>
        <radialGradient id="staxTopBunHi" cx="50%" cy="14%" r="40%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.9" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M40 198
           Q 40 70, 210 40
           Q 400 8, 590 40
           Q 760 70, 760 198
           Z"
        fill="url(#staxTopBun)"
      />
      <path
        d="M40 198
           Q 40 70, 210 40
           Q 400 8, 590 40
           Q 760 70, 760 198
           Z"
        fill="url(#staxTopBunHi)"
      />
      {/* Sesame seeds — scattered across the dome with subtle rotation */}
      {SESAME.map((s, i) => (
        <ellipse
          key={i}
          cx={s.x} cy={s.y} rx="7" ry="10"
          fill="#F8E5B0"
          transform={`rotate(${s.r} ${s.x} ${s.y})`}
          opacity="0.92"
        />
      ))}
    </svg>
  )
}

const SESAME = [
  { x: 200, y: 58, r: -10 }, { x: 290, y: 44, r: 8 },  { x: 380, y: 38, r: -4 },
  { x: 460, y: 42, r: 12 },  { x: 540, y: 48, r: -8 }, { x: 610, y: 62, r: 6 },
  { x: 240, y: 78, r: 4 },   { x: 420, y: 66, r: -14 }, { x: 510, y: 82, r: 10 },
  { x: 340, y: 86, r: 18 },
]

function BottomBun() {
  return (
    <svg
      viewBox="0 0 800 130"
      preserveAspectRatio="xMidYMid meet"
      width="100%" height="100%"
      style={{
        display: 'block',
        overflow: 'visible',
        filter: 'drop-shadow(0 18px 32px rgba(0,0,0,0.5))',
        animation: 'staxBunBreath 6s ease-in-out infinite alternate-reverse',
      }}
    >
      <defs>
        <radialGradient id="staxBottomBun" cx="50%" cy="78%" r="80%">
          <stop offset="0%"   stopColor="#E5B976" />
          <stop offset="38%"  stopColor="#C28A3A" />
          <stop offset="78%"  stopColor="#8a541a" />
          <stop offset="100%" stopColor="#4d2810" />
        </radialGradient>
        <linearGradient id="staxBottomBunHi" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.55" />
          <stop offset="35%"  stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M40 14
           L 760 14
           Q 760 100, 600 118
           Q 400 132, 200 118
           Q 40 100, 40 14
           Z"
        fill="url(#staxBottomBun)"
      />
      <path
        d="M40 14
           L 760 14
           Q 760 100, 600 118
           Q 400 132, 200 118
           Q 40 100, 40 14
           Z"
        fill="url(#staxBottomBunHi)"
      />
    </svg>
  )
}

// Tiny label that overlays the bun shapes — sits inside the dome on top,
// or on the visible part of the flat-bottom. Positioned with vertical
// offset depending on which bun it's for.
function BunLabel({
  idx, layer, accent, bottom,
}: { idx: number; layer: Layer; accent: string; bottom?: boolean }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingLeft: 'clamp(2rem, 6vw, 4rem)',
      // Bottom bun is short + flat, so the label sits centered vertically.
      // Top bun is taller + domed, so we nudge the label up into the dome.
      paddingTop: bottom ? 0 : 'clamp(1rem, 3vh, 2rem)',
      gap: '0.85rem',
      pointerEvents: 'none',
    }}>
      <span style={{
        background: 'rgba(60,30,8,0.55)',
        color: '#FFE3A8',
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        fontSize: '0.7rem',
        letterSpacing: '0.18em',
        padding: '0.28rem 0.55rem',
        borderRadius: '4px',
        textTransform: 'uppercase',
        textShadow: '0 1px 1px rgba(0,0,0,0.4)',
      }}>
        {String(idx).padStart(2, '0')}
      </span>
      <div style={{ minWidth: 0 }}>
        <p style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 800,
          fontSize: 'clamp(0.95rem, 1.6vw, 1.25rem)',
          color: '#3a1f08',
          letterSpacing: '-0.015em',
          lineHeight: 1.05,
        }}>
          {bottom ? 'Bottom · ' : 'Top · '}{layer.label}
          <span style={{ color: accent }}>.</span>
        </p>
        <p style={{
          fontSize: 'clamp(0.7rem, 1.1vw, 0.82rem)',
          color: 'rgba(58,31,8,0.78)',
          marginTop: '0.15rem',
        }}>
          {layer.sub}
        </p>
      </div>
    </div>
  )
}
