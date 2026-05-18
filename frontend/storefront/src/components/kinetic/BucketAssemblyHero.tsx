'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'
import { PerforatedSphere, ChromeBurst, SquiggleArrow, TwistedRibbon } from './Shapes3D'

/**
 * BucketAssemblyHero — Stax (chicken) cinematic. A red-and-white striped
 * paper bucket sits at viewport center; pieces of chicken (drumsticks +
 * tenders + a sandwich) fly in from off-screen and stack into the bucket
 * as the user scrolls. Once full, the bucket tilts toward the viewer
 * and the family-bucket lineup fades in behind it.
 *
 * Same skeleton as BurgerSplitHero: 300vh tall, sticky child pinned at
 * viewport center, CSS reads --scroll-progress to drive transforms.
 */

interface FlyInPiece {
  emoji:  string
  // Origin offsets (where the piece starts before flying in). Direction
  // varies so the pieces don't all land from the same corner.
  fromX:  string
  fromY:  string
  // Final rotation when settled in the bucket — slight tumble.
  endRot: number
  // When in scroll progress this piece flies in. Pieces stagger 0..0.6
  // so they don't all arrive at the same instant.
  fireAt: number
}

interface BucketItem {
  name:   string
  feeds:  number
  body:   string
  price:  string
  badge?: string
}

interface Props {
  brandName:  string
  accent:     string
  ink:        string
  cream:      string
  orderHref:  string
  menuHref?:  string
  pieces?:    FlyInPiece[]
  buckets?:   BucketItem[]
}

const DEFAULT_PIECES: FlyInPiece[] = [
  { emoji: '🍗', fromX: '-60vw', fromY: '-40vh', endRot: -18, fireAt: 0.05 },
  { emoji: '🍗', fromX:  '70vw', fromY: '-50vh', endRot:  22, fireAt: 0.15 },
  { emoji: '🍔', fromX:   '0vw', fromY: '-70vh', endRot:  -5, fireAt: 0.28 },
  { emoji: '🍟', fromX: '-80vw', fromY:  '20vh', endRot: -25, fireAt: 0.40 },
  { emoji: '🌶', fromX:  '90vw', fromY:  '30vh', endRot:  35, fireAt: 0.52 },
]

const DEFAULT_BUCKETS: BucketItem[] = [
  { name: 'Solo Bucket',   feeds: 1, body: 'Sandwich + fries + drink.',                           price: 'Rs. 1,200', badge: 'Quick lunch' },
  { name: 'Squad Bucket',  feeds: 3, body: '3 sandwiches · 8 tenders · 2 fries · 4 sauces.',     price: 'Rs. 3,450', badge: 'Most ordered' },
  { name: 'Family Coop',   feeds: 5, body: '5 sandwiches · 16 tenders · large fries · slaw.',    price: 'Rs. 5,800', badge: 'Save Rs. 600' },
  { name: 'Tender Trove',  feeds: 4, body: '20 tenders · 4 sauces · large fries · pickles.',     price: 'Rs. 4,500' },
]

export function BucketAssemblyHero({
  brandName, accent, ink, cream,
  orderHref, menuHref,
  pieces = DEFAULT_PIECES,
  buckets = DEFAULT_BUCKETS,
}: Props) {
  const { ref } = useScrollProgress<HTMLDivElement>()

  return (
    <div
      ref={ref}
      style={{
        height: '300vh',
        position: 'relative',
        background: ink,
        ['--brand-accent' as string]: accent,
        ['--brand-ink' as string]:    ink,
      } as React.CSSProperties}
    >
      <div className="sticky overflow-hidden"
        style={{
          top: 0,
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Warm room glow that brightens as the bucket fills */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 50% 60%, ${accent}55 0%, transparent 50%)`,
          opacity: 'calc(0.3 + var(--scroll-progress, 0) * 0.7)',
        }} />

        <PerforatedSphere color={accent} size={280} motion="float" sway={24}
          style={{ top: '-12%', right: '-6%', zIndex: 1, opacity: 0.7 }} />
        <ChromeBurst color={accent} size={140} motion="spin"
          style={{ top: '14%', left: '6%', zIndex: 1, opacity: 0.7 }} />
        <TwistedRibbon color={accent} size={260} motion="float" sway={18}
          style={{ bottom: '-15%', left: '-8%', zIndex: 1, opacity: 0.75 }} />
        <SquiggleArrow color={cream} size={120} motion="float" sway={8}
          style={{ bottom: '20%', right: '8%', zIndex: 1, opacity: 0.55 }} />

        {/* Headline that fades out as bucket fills */}
        <div
          className="absolute z-30 text-center px-6"
          style={{
            top: '8vh',
            left: 0, right: 0,
            opacity: 'calc(1 - var(--scroll-progress, 0) * 1.4)',
            transform: 'translateY(calc(var(--scroll-progress, 0) * -40px))',
          } as React.CSSProperties}
        >
          <p className="eyebrow" style={{ color: accent, marginBottom: '0.85rem' }}>
            {brandName} · scroll to fill
          </p>
          <h1 className="display" style={{
            fontSize: 'clamp(3.5rem, 11vw, 9rem)',
            color: 'white',
            lineHeight: 0.85,
          }}>
            Hand-bread<span style={{ color: accent }}>.</span>
            <br />
            <span className="display-italic" style={{ color: accent, fontWeight: 600 }}>Never reheated.</span>
          </h1>
          <p style={{
            marginTop: '1.5rem',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 'clamp(0.95rem, 1.4vw, 1.1rem)',
          }}>
            ↓ load up the bucket
          </p>
        </div>

        {/* Bucket lineup — fades in once the bucket is full */}
        <div
          className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 1.6 - 0.4)',
          } as React.CSSProperties}
        >
          <div className="container">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5" style={{ pointerEvents: 'auto' }}>
              {buckets.map((b, i) => (
                <div key={b.name} style={{
                  background: 'rgba(0,0,0,0.6)',
                  backdropFilter: 'blur(12px)',
                  border: `1px solid ${accent}40`,
                  borderRadius: '1.25rem',
                  padding: '1.25rem 1.1rem',
                  transform: `translateY(calc((1 - var(--scroll-progress, 0)) * ${70 + i * 20}px))`,
                  transition: 'transform 120ms linear',
                }}>
                  {b.badge && (
                    <span style={{
                      display: 'inline-block',
                      background: accent, color: ink,
                      fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.15em',
                      textTransform: 'uppercase',
                      padding: '0.25rem 0.55rem',
                      borderRadius: '999px',
                      marginBottom: '0.65rem',
                    }}>{b.badge}</span>
                  )}
                  <p className="display" style={{ fontSize: '1.15rem', color: 'white', marginBottom: '0.35rem' }}>
                    {b.name}
                  </p>
                  <p style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)', marginBottom: '0.5rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    Feeds {b.feeds}
                  </p>
                  <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.4, marginBottom: '0.6rem' }}>
                    {b.body}
                  </p>
                  <p style={{ fontSize: '0.95rem', fontWeight: 800, color: accent }}>
                    {b.price}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* THE BUCKET — center of the canvas. Tilts toward viewer as
            scroll progress climbs. */}
        <div
          className="relative z-20"
          style={{
            width: 'min(70vw, 480px)',
            transform: 'perspective(900px) rotateX(calc(var(--scroll-progress, 0) * -10deg)) rotateY(calc(var(--scroll-progress, 0) * 4deg))',
            transformStyle: 'preserve-3d',
          } as React.CSSProperties}
        >
          <PaperBucket accent={accent} cream={cream} brandName={brandName} />
        </div>

        {/* THE PIECES — each one flies from its origin into the bucket
            center, then settles with a small rotation. Stagger fireAt
            so they don't arrive simultaneously. */}
        <div className="absolute inset-0 z-25 pointer-events-none">
          {pieces.map((p, i) => (
            <FlyingPiece key={i} {...p} />
          ))}
        </div>

        {/* Bottom CTA — appears once the bucket is full */}
        <div
          className="absolute bottom-8 left-0 right-0 z-30 flex flex-wrap items-center justify-center gap-3 px-6"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 2 - 1.4)',
            transform: 'translateY(calc((1 - var(--scroll-progress, 0)) * 40px))',
            transition: 'opacity 120ms linear, transform 120ms linear',
          } as React.CSSProperties}
        >
          <Link href={orderHref} className="brand-pill" style={{ fontSize: '1.05rem' }}>
            Build your bucket →
          </Link>
          {menuHref && (
            <Link href={menuHref} className="brand-pill-outline" style={{
              fontSize: '0.95rem',
              borderColor: 'rgba(255,255,255,0.4)',
              color: 'white',
            }}>
              See full menu
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Paper bucket SVG ────────────────────────────────────────────────
// Red-and-white striped paper bucket with a folded rim. Reads
// classic-takeout-chicken-bucket from across the room.
function PaperBucket({ accent, cream, brandName }: { accent: string; cream: string; brandName: string }) {
  return (
    <svg viewBox="0 0 400 460" width="100%" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="bucketStripes" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor={cream} />
          <stop offset="100%" stopColor="#E5DDC8" />
        </linearGradient>
        <radialGradient id="bucketShade" cx="50%" cy="100%" r="60%">
          <stop offset="0%"   stopColor="rgba(0,0,0,0.4)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <filter id="bucketDrop" x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="20" stdDeviation="14" floodOpacity="0.45" />
        </filter>
      </defs>

      {/* Bucket body — slight perspective trapezoid */}
      <path
        d="M70 100
           L 330 100
           L 360 420
           L 40 420 Z"
        fill="url(#bucketStripes)"
        filter="url(#bucketDrop)"
      />

      {/* Vertical red stripes — classic takeout pattern */}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const t = 100  // top y
        const b = 420  // bottom y
        const tx = 70 + i * 47
        const bx = 40 + i * 53
        return (
          <path key={i}
            d={`M ${tx} ${t} L ${tx + 18} ${t} L ${bx + 22} ${b} L ${bx} ${b} Z`}
            fill={accent}
            opacity="0.92"
          />
        )
      })}

      {/* Folded rim — thicker band at the top */}
      <rect x="60" y="86" width="280" height="32" rx="6" fill="#FFFFFF" stroke="#1d1d1d" strokeWidth="2" filter="url(#bucketDrop)" />
      <rect x="60" y="86" width="280" height="14" fill={accent} opacity="0.95" />

      {/* Brand label — uppercase, sits across the bucket front */}
      <text
        x="200" y="280"
        fontFamily="var(--font-display), Inter, sans-serif"
        fontSize="62" fontWeight="900" textAnchor="middle"
        fill="#1a1410" letterSpacing="-0.04em"
      >
        {brandName.toUpperCase()}
      </text>
      <text
        x="200" y="318"
        fontFamily="var(--font-display), Inter, sans-serif"
        fontSize="18" fontWeight="600" textAnchor="middle"
        fill="#1a1410" letterSpacing="0.4em"
        opacity="0.7"
      >
        FAMILY · BUCKET
      </text>

      {/* Inside-bucket shadow at the bottom — sells the depth */}
      <path
        d="M70 100
           L 330 100
           L 360 420
           L 40 420 Z"
        fill="url(#bucketShade)"
      />
    </svg>
  )
}

// ─── A single flying piece ───────────────────────────────────────────
// Origin + tumble + final settle, all driven by --scroll-progress. The
// per-piece `fireAt` shifts when in progress the piece is "fully landed"
// — pieces with lower fireAt land earlier in the scroll.
function FlyingPiece({ emoji, fromX, fromY, endRot, fireAt }: FlyInPiece) {
  // CSS calc(): we want the piece to interpolate from (fromX, fromY) to
  // (0, 0) as progress goes from 0 to fireAt. We do this with:
  //   eased = min(1, progress / fireAt)
  //   x = fromX * (1 - eased)
  //   y = fromY * (1 - eased)
  //   rot = (1 - eased) * 360 + endRot * eased
  //
  // Encoded inline via CSS calc so no JS reflows.
  const easedExpr = `min(1, var(--scroll-progress, 0) / ${fireAt})`
  const invExpr   = `(1 - ${easedExpr})`
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%', left: '50%',
        transform: `
          translate(
            calc(-50% + ${fromX} * ${invExpr}),
            calc(-50% + ${fromY} * ${invExpr})
          )
          rotate(calc(${endRot}deg * ${easedExpr} + 320deg * ${invExpr}))
          scale(calc(0.5 + ${easedExpr} * 0.5))
        `,
        fontSize: 'clamp(3rem, 7vw, 5rem)',
        filter: 'drop-shadow(0 18px 22px rgba(0,0,0,0.4))',
        transition: 'transform 80ms linear',
      }}
    >
      {emoji}
    </div>
  )
}
