'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'
import { STACKD_DIE } from '../../lib/stackdDie'

/**
 * StackdDropHero — the drop.
 *
 * The joke in the mascot is that you never see his head: a stack of scratch-cut
 * slices sits where it should be, on a plum tray bar, two small hands gripping
 * it, striped trousers below. He IS the stack. That is the whole brand in one
 * drawing, and the page was showing it standing still.
 *
 * So he falls. The entire height of the viewport, bolt upright, deadpan — and
 * the stack never tilts a degree. He lands, the counter takes it, the seals
 * jump off the impact, and not a crumb moves. That is the brand's actual claim
 * rendered as a gag: here the packaging IS the service vessel, so what he is
 * carrying is the product, and it arrives exactly as it left.
 *
 * Deliberately NOT flipd's hero. That one is a technical drawing: parts stop
 * dead where they seat, no bounce, no overshoot, because its book asks for
 * restraint. This brand is hand-drawn ink and warm paper, so this one has
 * weight — acceleration on the way down, a squash on impact, an overshoot and
 * a settle. Same scroll machinery, opposite physics.
 *
 * The mascot is used WHOLE. The flipd hero pulls its badge into five pieces,
 * but this drawing is a single connected stroke — slices, tray and legs all
 * touch — so cutting him into layers would mean slicing through the artwork
 * rather than along it. He falls as one drawing, at size, which is also how
 * the brand uses him everywhere else: on the cups, the wrappers and the pastry
 * bags, never as a corner thumbnail.
 *
 * Mechanics: one tall section with a pinned child. useScrollProgress writes
 * --scroll-progress on the section; CSS reads it and nothing re-renders.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  mascotSrc: string
  /** Intrinsic size, only when the bundled asset is in use. */
  mascotDims: { width?: number; height?: number }
  mascotAlt: string
  /** What the counter actually puts out — shown once he has landed. */
  counterLines: string[]
}

/** 0..1 across a window of the scroll. */
const ramp = (from: number, rate: number) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${rate}))`

/** A 0..1..0 pulse: rises over the first window, falls over the second. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${ramp(up, upRate)} - ${ramp(down, downRate)})`

// Where each seal flies to when the counter takes the hit, as a fraction of
// the stage. They scatter from under his feet and stay where they land — the
// brand applies its stickers off-square and by hand, so a tidy arc would be
// wrong.
const SEALS = [
  { x: -19, y: -1.0, size: 3.4, tilt: -14, fire: 0.545 },
  { x: 17, y: -1.8, size: 2.9, tilt: 11, fire: 0.55 },
  { x: -11, y: -3.4, size: 2.1, tilt: 8, fire: 0.56 },
  { x: 23, y: -0.4, size: 1.8, tilt: -19, fire: 0.55 },
  { x: -25, y: -0.2, size: 1.5, tilt: 16, fire: 0.575 },
  { x: 10, y: -4.2, size: 1.3, tilt: -7, fire: 0.585 },
]

function Seal({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={`${size}rem`} height={`${size}rem`} aria-hidden>
      <path d={STACKD_DIE} fill="var(--stackd-cream)" stroke="var(--stackd-plum-dark)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function StackdDropHero({
  brandName, orderHref, menuHref, mascotSrc, mascotDims, mascotAlt, counterLines,
}: Props) {
  const { ref } = useScrollProgress<HTMLElement>()

  // Gravity. Squaring the ramp turns a constant scroll into an accelerating
  // fall — he creeps at the top of the screen and arrives fast, which is the
  // difference between a drawing sliding down and a body dropping.
  const fall = ramp(0.02, 1.85)
  const landed = ramp(0.52, 9)
  // The counter takes the hit: a short squash, then an overshoot that settles.
  const squash = pulse(0.50, 22, 0.545, 13)
  const rebound = pulse(0.555, 14, 0.60, 9)
  const after = ramp(0.60, 3.4)

  return (
    <section ref={ref} className="stackd-drop" aria-label={`${brandName} — the drop`}>
      <div className="stackd-drop-pin">
        <div className="stackd-drop-stage">

        <span className="stackd-drop-hint" style={{ ['--t' as string]: ramp(0.02, 14) }} aria-hidden>
          Scroll
        </span>

        {/* The counter he lands on. A die-cut seal stretched wide, because this
            brand has no straight-edged boxes anywhere in its collateral. */}
        <div className="stackd-drop-counter" style={{ ['--t' as string]: landed, ['--squash' as string]: squash }} aria-hidden>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
            {/* The counter, as one of the brand's own seals stretched wide.
                At 0.14 it read as a puddle rather than a surface he lands on. */}
            <path d={STACKD_DIE} fill="var(--stackd-cream)" opacity="0.92" />
          </svg>
        </div>

        {/* Seals thrown off the impact. */}
        <div className="stackd-drop-seals" aria-hidden>
          {SEALS.map((s, i) => (
            <span
              key={i}
              className="stackd-drop-seal"
              style={{
                ['--t' as string]: ramp(s.fire, 4.5),
                // rem, not %: a percentage on the seal's own transform is a
                // percentage of the SEAL, which is a couple of rem wide — they
                // all landed in a heap on his shoes.
                ['--x' as string]: `${s.x}rem`,
                ['--y' as string]: `${s.y}rem`,
                ['--tilt' as string]: `${s.tilt}deg`,
              }}
            >
              <Seal size={s.size} />
            </span>
          ))}
        </div>

        {/* Speed marks. Present only while he is actually moving — they fade
            out as he decelerates, so they read as velocity and not decoration. */}
        <div className="stackd-drop-streaks" style={{ ['--t' as string]: pulse(0.12, 6, 0.42, 9) }} aria-hidden>
          {[14, 26, 74, 86, 8, 92].map((left, i) => (
            <span key={i} style={{ left: `${left}%`, ['--d' as string]: `${(i % 3) * 0.9 + 1}` }} />
          ))}
        </div>

        {/* Him. Bolt upright the whole way down: no rotation, no sway, no
            wobble on the stack. The comedy is the deadpan. */}
        <div
          className="stackd-drop-guy"
          style={{
            ['--fall' as string]: fall,
            ['--squash' as string]: squash,
            ['--rebound' as string]: rebound,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mascotSrc} alt={mascotAlt} {...mascotDims} />
        </div>

        </div>

        {/* The payoff, after he has settled. Its own grid row — he lands in the
            row above it, so the two cannot occupy the same space however tall
            the viewport is. */}
        <div className="stackd-drop-after" style={{ ['--t' as string]: after }}>
          <p className="stackd-drop-line">not a crumb moved.</p>
          <p className="stackd-drop-sub">
            scratch cooking, carried steady — {counterLines.map((l) => l.replace(/\.$/, '')).join(', ').toLowerCase()}.
          </p>
          <div className="stackd-drop-cta">
            <Link href={orderHref} className="stackd-btn">Order {brandName}</Link>
            <Link href={menuHref} className="stackd-btn stackd-btn-ghost">See the menu</Link>
          </div>
        </div>
      </div>
    </section>
  )
}
