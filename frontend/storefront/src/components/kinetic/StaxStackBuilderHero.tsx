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

// Each layer in the stack is a drawn ingredient. Buns bookend the stack;
// the fills are organic SVG shapes (greens, patties, cheese, crust,
// tomato + pickles) so the stack reads as an actual burger. Category
// labels move OUT of the food into spec-sheet callouts beside it.
type LayerVariant =
  | 'top-bun' | 'bottom-bun'
  | 'lettuce' | 'smash-patty' | 'thick-patty' | 'cheese' | 'golden' | 'tomato'
type FillVariant = Exclude<LayerVariant, 'top-bun' | 'bottom-bun'>

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
  /** Wall texture tint (the faint brick/panel grid behind the stack).
   *  Defaults to the original warm brick; pass a cool grey for the
   *  navy-industrial direction. */
  wallTint?:  string
  /** Each layer = one menu category. Default below matches the screenshot. */
  layers?:    Layer[]
}

const DEFAULT_LAYERS: Layer[] = [
  // Bottom-up: bottom bun lands first, top bun lands last. Every layer
  // is a drawn ingredient; the menu-category labels annotate from the
  // side like a parts diagram.
  { variant: 'bottom-bun',  label: 'House Brioche',        sub: 'baked in-house, never frozen',                      height: 10,  fireAt: 0.06 },
  { variant: 'lettuce',     label: 'Stacked Bowls',        sub: 'grain · greens · house dressing',                   height: 5.5, fireAt: 0.18 },
  { variant: 'smash-patty', label: 'Smash Stax',           sub: 'double smash patty · MCD / Smash / build-your-own', height: 6.5, fireAt: 0.30 },
  { variant: 'thick-patty', label: 'Pub Stax',             sub: 'thick patty · C-stack · CC-stack',                  height: 8,   fireAt: 0.42 },
  { variant: 'cheese',      label: 'Flaky Stax',           sub: 'sandwiches in house-made croissants',               height: 5,   fireAt: 0.54 },
  { variant: 'golden',      label: 'Golden Stax',          sub: 'sandwiches in house-made foccacia',                 height: 5.5, fireAt: 0.64 },
  { variant: 'tomato',      label: 'Side Stax · Desserts', sub: 'pommes stax · roasties · stacked desserts',         height: 5,   fireAt: 0.74 },
  { variant: 'top-bun',     label: 'House Brioche',        sub: 'sesame · brushed butter · pressed on the flat-top', height: 13,  fireAt: 0.86 },
]

export function StaxStackBuilderHero({
  brandName, accent,
  steel = '#3a3f42',
  ink   = '#0d0a09',
  cream = '#f6f1e8',
  orderHref, menuHref,
  wallTint = '180,90,50',
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
        {/* Wall background — top half. Tinted by the brand: warm brick by
            default, cool panel grid when wallTint is a grey. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse 80% 60% at 50% 30%, ${accent}22 0%, transparent 60%),
            linear-gradient(180deg, color-mix(in srgb, ${ink} 86%, white) 0%, ${ink} 100%)
          `,
        }} />
        {/* Wall pattern overlay — faint panel/brick grid */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          opacity: 0.18,
          background: `
            repeating-linear-gradient(90deg, rgba(${wallTint},0.15) 0 80px, transparent 80px 82px),
            repeating-linear-gradient(0deg,  rgba(${wallTint},0.10) 0 38px, transparent 38px 40px)
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

        {/* Steam rising off the pass — the kitchen is live. */}
        <div aria-hidden style={{
          position: 'absolute', bottom: '36%', left: '50%',
          width: 'min(40vw, 420px)', height: '24vh',
          transform: 'translateX(-50%)',
          pointerEvents: 'none', zIndex: 9,
        }}>
          <span className="kp-steam" style={{ left: '28%', animationDelay: '0.4s' }} />
          <span className="kp-steam" style={{ left: '52%', animationDelay: '1.9s' }} />
          <span className="kp-steam" style={{ left: '72%', animationDelay: '3.1s' }} />
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
            // Narrow enough that the layers read as a thick-cut burger,
            // not stretched pancakes; callouts annotate from the sides.
            width: 'min(66vw, 520px)',
            paddingBottom: '12vh',             // sits just above the table lip
          }}
        >
          {layers.map((layer, i) => {
            const easedExpr = `min(1, max(0, (var(--scroll-progress, 0) - ${layer.fireAt}) * 6))`
            const invExpr   = `(1 - ${easedExpr})`
            const wrapperStyle: CSSProperties = {
              width: '100%',
              height: `${layer.height}vh`,
              marginTop: '-1.5vh',   // layers press into each other like a real build
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
            const inner =
              layer.variant === 'top-bun'    ? <TopBun /> :
              layer.variant === 'bottom-bun' ? <BottomBun /> :
              <IngredientSvg variant={layer.variant as FillVariant} />
            return (
              <div key={layer.label} style={wrapperStyle}>
                {inner}
                <Callout idx={i + 1} layer={layer} side={i % 2 ? 'left' : 'right'} cream={cream} />
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
        <radialGradient id="staxTopBun" cx="42%" cy="18%" r="92%">
          <stop offset="0%"   stopColor="#FFEDBE" />
          <stop offset="22%"  stopColor="#F3C377" />
          <stop offset="46%"  stopColor="#D99B44" />
          <stop offset="70%"  stopColor="#B06A26" />
          <stop offset="88%"  stopColor="#8A4C1B" />
          <stop offset="100%" stopColor="#6B3A13" />
        </radialGradient>
        <radialGradient id="staxTopBunHi" cx="44%" cy="12%" r="38%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.85" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        {/* organic edge — turbulence-displaced outline so the crust
            isn't a perfect bezier */}
        <filter id="staxTopRough" x="-8%" y="-15%" width="116%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.013 0.045" numOctaves="3" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="9" />
        </filter>
        <filter id="staxBunSpeck" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.2  0 0 0 0 0.05  0 0 0 0.28 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>
      {/* contact shadow under the dome */}
      <ellipse cx="400" cy="204" rx="330" ry="12" fill="#000" opacity="0.32" />
      <g filter="url(#staxTopRough)">
        <path
          d="M40 198
             Q 40 70, 210 40
             Q 400 8, 590 40
             Q 760 70, 760 198
             Z"
          fill="url(#staxTopBun)"
        />
        {/* baked speckle clipped to the dome */}
        <path
          d="M40 198
             Q 40 70, 210 40
             Q 400 8, 590 40
             Q 760 70, 760 198
             Z"
          fill="url(#staxTopBun)" filter="url(#staxBunSpeck)"
        />
        <path
          d="M40 198
             Q 40 70, 210 40
             Q 400 8, 590 40
             Q 760 70, 760 198
             Z"
          fill="url(#staxTopBunHi)"
        />
      </g>
      {/* Sesame seeds — each with a tiny cast shadow so they sit ON the dome */}
      {SESAME.map((s, i) => (
        <g key={i} transform={`rotate(${s.r} ${s.x} ${s.y})`}>
          <ellipse cx={s.x + 1.5} cy={s.y + 2} rx="7" ry="10" fill="#8A5A20" opacity="0.45" />
          <ellipse cx={s.x} cy={s.y} rx="7" ry="10" fill="#F8E5B0" opacity="0.95" />
          <ellipse cx={s.x - 1.5} cy={s.y - 2.5} rx="3" ry="4.5" fill="#FFF6DC" opacity="0.9" />
        </g>
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
        <radialGradient id="staxBottomBun" cx="46%" cy="72%" r="88%">
          <stop offset="0%"   stopColor="#F0C67F" />
          <stop offset="30%"  stopColor="#D29B48" />
          <stop offset="58%"  stopColor="#A96E28" />
          <stop offset="82%"  stopColor="#7A4517" />
          <stop offset="100%" stopColor="#48250C" />
        </radialGradient>
        <linearGradient id="staxBottomBunHi" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.6" />
          <stop offset="38%"  stopColor="white" stopOpacity="0" />
        </linearGradient>
        <filter id="staxBotRough" x="-8%" y="-15%" width="116%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.014 0.05" numOctaves="3" seed="3" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="8" />
        </filter>
        <filter id="staxBotCrumb" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.26  0 0 0 0 0.1  0 0 0 0.3 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>
      <g filter="url(#staxBotRough)">
        <path
          d="M40 14
             L 760 14
             Q 760 100, 600 118
             Q 400 132, 200 118
             Q 40 100, 40 14
             Z"
          fill="url(#staxBottomBun)"
        />
        {/* crumb texture — the cut face of the bun */}
        <path
          d="M40 14
             L 760 14
             Q 760 100, 600 118
             Q 400 132, 200 118
             Q 40 100, 40 14
             Z"
          fill="url(#staxBottomBun)" filter="url(#staxBotCrumb)"
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
      </g>
    </svg>
  )
}

// ─── Spec callout — the category label, annotating from beside the
// burger like a parts diagram. Hairline leader + mono tag. Hidden on
// narrow screens (a compact chip takes over via .stax-callout-mini).
function Callout({ idx, layer, side, cream }: {
  idx: number; layer: Layer; side: 'left' | 'right'; cream: string
}) {
  return (
    <>
      <div className="stax-callout" style={{
        position: 'absolute', top: '50%',
        ...(side === 'right' ? { left: 'calc(100% + 0.4rem)' } : { right: 'calc(100% + 0.4rem)' }),
        transform: 'translateY(-50%)',
        alignItems: 'center', gap: '0.7rem',
        flexDirection: side === 'right' ? 'row' : 'row-reverse',
        width: 'max-content', maxWidth: '24vw',
        pointerEvents: 'none',
      }}>
        <span aria-hidden style={{ width: '2.6rem', height: 1, background: 'rgba(234,236,239,0.35)', flexShrink: 0 }} />
        <div style={{ textAlign: side === 'right' ? 'left' : 'right' }}>
          <p style={{
            fontFamily: 'var(--stax-mono, monospace)', fontSize: '0.72rem',
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: cream, margin: 0, whiteSpace: 'nowrap',
          }}>
            {String(idx).padStart(2, '0')} / {layer.label}
          </p>
          <p style={{
            fontFamily: 'var(--stax-mono, monospace)', fontSize: '0.64rem',
            letterSpacing: '0.04em', color: 'rgba(234,236,239,0.55)',
            margin: '0.25rem 0 0', maxWidth: '24ch',
          }}>
            {layer.sub}
          </p>
        </div>
      </div>
      {/* Narrow screens — tiny index chip in the layer's corner. */}
      <span className="stax-callout-mini" aria-hidden style={{
        position: 'absolute', top: '50%', left: '0.6rem',
        transform: 'translateY(-50%)',
        fontFamily: 'var(--stax-mono, monospace)', fontSize: '0.6rem',
        letterSpacing: '0.14em',
        color: 'rgba(234,236,239,0.9)',
        background: 'rgba(13,27,36,0.6)',
        padding: '0.2rem 0.45rem', borderRadius: 3,
        pointerEvents: 'none',
      }}>
        {String(idx).padStart(2, '0')}
      </span>
    </>
  )
}

// ─── Drawn ingredients ───────────────────────────────────────────────
// Organic SVG shapes — ruffled greens, char-textured patties, drooping
// cheese, dimpled focaccia crust, tomato + pickles — so the stack reads
// as food, not UI bars. Stretch to the layer box (preserveAspectRatio
// "none"); textures come from turbulence filters, depth from gradients.

function IngredientSvg({ variant }: { variant: FillVariant }) {
  switch (variant) {
    case 'lettuce':     return <Lettuce />
    case 'smash-patty': return <Patty thick={false} />
    case 'thick-patty': return <Patty thick />
    case 'cheese':      return <Cheese />
    case 'golden':      return <GoldenCrust />
    case 'tomato':      return <TomatoPickles />
  }
}

const ING_SVG_STYLE: CSSProperties = {
  display: 'block', width: '100%', height: '100%', overflow: 'visible',
  filter: 'drop-shadow(0 12px 22px rgba(0,0,0,0.45))',
}

function Lettuce() {
  return (
    <svg viewBox="0 0 800 100" preserveAspectRatio="none" style={ING_SVG_STYLE} aria-hidden>
      <defs>
        <linearGradient id="stxLet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D4EE94" />
          <stop offset="35%" stopColor="#9CC450" />
          <stop offset="70%" stopColor="#6B9A30" />
          <stop offset="100%" stopColor="#42691A" />
        </linearGradient>
        <filter id="stxLetRough" x="-8%" y="-30%" width="116%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.025 0.09" numOctaves="3" seed="5" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="12" />
        </filter>
      </defs>
      <g filter="url(#stxLetRough)">
        {/* back ruffle — darker, offset for depth */}
        <path d="M18 46 Q70 22 140 40 Q210 18 290 38 Q370 16 450 36 Q530 16 610 38 Q690 20 782 44 L782 66 Q720 92 660 70 Q590 96 520 72 Q450 98 380 72 Q310 96 240 70 Q170 94 100 68 Q50 88 18 62 Z"
          fill="#3E6218" opacity="0.9" transform="translate(0 6)" />
        <path d="M12 42 Q64 16 134 34 Q204 12 284 32 Q364 10 444 30 Q524 10 604 32 Q684 14 788 40 L788 62 Q724 90 662 66 Q594 94 522 68 Q452 96 380 68 Q308 94 236 66 Q168 92 98 64 Q46 86 12 58 Z"
          fill="url(#stxLet)" />
        {/* water-crisp rib highlights */}
        <g stroke="#EAF8C0" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" fill="none">
          <path d="M120 40 Q150 52 178 44" />
          <path d="M330 34 Q362 48 396 38" />
          <path d="M560 36 Q596 50 630 40" />
          <path d="M220 52 Q244 60 268 54" />
          <path d="M460 50 Q484 60 508 52" />
        </g>
      </g>
    </svg>
  )
}

function Patty({ thick }: { thick: boolean }) {
  const id = thick ? 'stxPatT' : 'stxPatS'
  return (
    <svg viewBox="0 0 800 100" preserveAspectRatio="none" style={ING_SVG_STYLE} aria-hidden>
      <defs>
        <radialGradient id={id} cx="44%" cy="30%" r="98%">
          <stop offset="0%" stopColor={thick ? '#A0603A' : '#AB6A3E'} />
          <stop offset="28%" stopColor={thick ? '#7A4222' : '#874A26'} />
          <stop offset="55%" stopColor={thick ? '#57290F' : '#5E2E12'} />
          <stop offset="80%" stopColor="#3A1A0A" />
          <stop offset="100%" stopColor="#241005" />
        </radialGradient>
        <filter id={`${id}Char`} x="-5%" y="-20%" width="110%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.05  0 0 0 0 0.02  0 0 0 0 0  0 0 0 0.6 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
        <filter id={`${id}Rough`} x="-8%" y="-30%" width="116%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.09" numOctaves="3" seed={thick ? 11 : 4} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="16" />
        </filter>
        <filter id={`${id}Fat`} x="-5%" y="-20%" width="110%" height="140%">
          <feTurbulence type="turbulence" baseFrequency="0.14" numOctaves="2" seed="9" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.78  0 0 0 0 0.58  0 0 0 0 0.4  0 0 0 0.22 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>
      {/* contact shadow pressed into the layer below */}
      <ellipse cx="400" cy="92" rx="360" ry="8" fill="#000" opacity="0.35" />
      <g filter={`url(#${id}Rough)`}>
        {/* irregular char-edged slab */}
        <path
          d="M16 34 Q44 14 96 22 Q170 8 250 20 Q336 6 424 18 Q512 8 592 20 Q672 10 744 24 Q788 32 786 54 Q766 86 700 78 Q636 94 556 82 Q468 96 380 84 Q292 96 204 82 Q124 92 62 78 Q16 68 16 46 Z"
          fill={`url(#${id})`} />
        {/* char + rendered-fat texture clipped to the slab */}
        <path d="M16 34 Q44 14 96 22 Q170 8 250 20 Q336 6 424 18 Q512 8 592 20 Q672 10 744 24 Q788 32 786 54 Q766 86 700 78 Q636 94 556 82 Q468 96 380 84 Q292 96 204 82 Q124 92 62 78 Q16 68 16 46 Z"
          fill={`url(#${id})`} filter={`url(#${id}Char)`} opacity="0.85" />
        <path d="M16 34 Q44 14 96 22 Q170 8 250 20 Q336 6 424 18 Q512 8 592 20 Q672 10 744 24 Q788 32 786 54 Q766 86 700 78 Q636 94 556 82 Q468 96 380 84 Q292 96 204 82 Q124 92 62 78 Q16 68 16 46 Z"
          fill={`url(#${id})`} filter={`url(#${id}Fat)`} opacity="0.7" />
      </g>
      {/* sear glisten */}
      <g fill="white" opacity="0.14">
        <ellipse cx="220" cy="30" rx="46" ry="6" />
        <ellipse cx="520" cy="26" rx="60" ry="7" />
        <ellipse cx="680" cy="36" rx="30" ry="4" />
      </g>
      {thick && (
        // juice drips off a thick pub patty
        <g fill="#241006">
          <path d="M180 92 q6 26 14 0 z" />
          <path d="M470 94 q7 30 16 0 z" />
        </g>
      )}
    </svg>
  )
}

function Cheese() {
  return (
    <svg viewBox="0 0 800 100" preserveAspectRatio="none" style={ING_SVG_STYLE} aria-hidden>
      <defs>
        <linearGradient id="stxChz" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFE79A" />
          <stop offset="35%" stopColor="#F7C453" />
          <stop offset="72%" stopColor="#E5A32C" />
          <stop offset="100%" stopColor="#C4841A" />
        </linearGradient>
        <filter id="stxChzRough" x="-8%" y="-30%" width="116%" height="170%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.06" numOctaves="2" seed="2" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="6" />
        </filter>
      </defs>
      <g filter="url(#stxChzRough)">
        {/* melted slice — two tips droop over the layer below */}
        <path d="M22 24 L778 24 Q790 24 788 40 L784 56 L566 56 L544 108 Q530 126 516 106 L498 56 L268 56 L250 96 Q236 114 222 94 L208 56 L16 56 L12 40 Q10 24 22 24 Z"
          fill="url(#stxChz)" />
        {/* melt bubbles */}
        <g fill="#FFF0B8" opacity="0.5">
          <ellipse cx="180" cy="40" rx="12" ry="4" />
          <ellipse cx="430" cy="44" rx="16" ry="5" />
          <ellipse cx="660" cy="38" rx="10" ry="4" />
        </g>
        {/* sheen */}
        <path d="M40 32 Q400 20 760 32 L756 40 Q400 30 44 40 Z" fill="white" opacity="0.4" />
      </g>
    </svg>
  )
}

function GoldenCrust() {
  return (
    <svg viewBox="0 0 800 100" preserveAspectRatio="none" style={ING_SVG_STYLE} aria-hidden>
      <defs>
        <linearGradient id="stxGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F8DA8C" />
          <stop offset="30%" stopColor="#E3B455" />
          <stop offset="65%" stopColor="#C29032" />
          <stop offset="100%" stopColor="#8F5E18" />
        </linearGradient>
        <filter id="stxGoldRough" x="-8%" y="-25%" width="116%" height="150%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.07" numOctaves="3" seed="6" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="8" />
        </filter>
        <filter id="stxGoldCrumb" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.45" numOctaves="2" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.38  0 0 0 0 0.12  0 0 0 0.25 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>
      <g filter="url(#stxGoldRough)">
      <path d="M28 52 Q28 16 110 16 L690 16 Q772 16 772 52 Q772 86 690 86 L110 86 Q28 86 28 52 Z"
        fill="url(#stxGold)" />
      <path d="M28 52 Q28 16 110 16 L690 16 Q772 16 772 52 Q772 86 690 86 L110 86 Q28 86 28 52 Z"
        fill="url(#stxGold)" filter="url(#stxGoldCrumb)" />
      {/* focaccia dimples */}
      <g fill="#7E5214" opacity="0.5">
        <ellipse cx="150" cy="44" rx="14" ry="9" />
        <ellipse cx="310" cy="56" rx="13" ry="8" />
        <ellipse cx="470" cy="42" rx="15" ry="9" />
        <ellipse cx="630" cy="54" rx="13" ry="8" />
      </g>
      <g fill="#FBE7AE" opacity="0.7">
        <ellipse cx="146" cy="40" rx="7" ry="4" />
        <ellipse cx="306" cy="52" rx="6" ry="4" />
        <ellipse cx="466" cy="38" rx="7" ry="4" />
        <ellipse cx="626" cy="50" rx="6" ry="4" />
      </g>
      {/* rosemary flecks */}
      <g stroke="#5E7A2E" strokeWidth="3" strokeLinecap="round">
        <line x1="230" y1="30" x2="244" y2="24" />
        <line x1="540" y1="66" x2="554" y2="60" />
        <line x1="700" y1="34" x2="712" y2="28" />
      </g>
      </g>
    </svg>
  )
}

function TomatoPickles() {
  return (
    <svg viewBox="0 0 800 100" preserveAspectRatio="none" style={ING_SVG_STYLE} aria-hidden>
      <defs>
        <radialGradient id="stxTom" cx="46%" cy="36%" r="82%">
          <stop offset="0%" stopColor="#F58468" />
          <stop offset="40%" stopColor="#E1503A" />
          <stop offset="75%" stopColor="#C03220" />
          <stop offset="100%" stopColor="#8E1E10" />
        </radialGradient>
        <filter id="stxTomRough" x="-8%" y="-30%" width="116%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.03 0.08" numOctaves="2" seed="8" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="6" />
        </filter>
      </defs>
      <g filter="url(#stxTomRough)">
        {/* pickles peeking behind */}
        <g>
          <circle cx="140" cy="34" r="30" fill="#6B8A32" stroke="#465F1A" strokeWidth="6" strokeDasharray="7 5" />
          <circle cx="410" cy="28" r="26" fill="#6B8A32" stroke="#465F1A" strokeWidth="6" strokeDasharray="7 5" />
          <circle cx="668" cy="34" r="28" fill="#6B8A32" stroke="#465F1A" strokeWidth="6" strokeDasharray="7 5" />
        </g>
        {/* tomato slices — flesh ring + seed pockets */}
        <ellipse cx="270" cy="56" rx="240" ry="38" fill="url(#stxTom)" />
        <ellipse cx="270" cy="56" rx="196" ry="28" fill="#F5A794" opacity="0.6" />
        <g fill="#FBD3C4" opacity="0.75">
          <ellipse cx="180" cy="52" rx="26" ry="9" transform="rotate(-18 180 52)" />
          <ellipse cx="300" cy="64" rx="24" ry="8" transform="rotate(14 300 64)" />
        </g>
        <ellipse cx="560" cy="58" rx="220" ry="36" fill="url(#stxTom)" />
        <ellipse cx="560" cy="58" rx="178" ry="26" fill="#F5A794" opacity="0.55" />
        <g fill="#FBD3C4" opacity="0.7">
          <ellipse cx="500" cy="54" rx="24" ry="8" transform="rotate(-12 500 54)" />
          <ellipse cx="620" cy="66" rx="22" ry="7" transform="rotate(16 620 66)" />
        </g>
        {/* wet glisten */}
        <ellipse cx="200" cy="44" rx="50" ry="8" fill="white" opacity="0.3" />
        <ellipse cx="520" cy="46" rx="44" ry="7" fill="white" opacity="0.26" />
      </g>
    </svg>
  )
}
