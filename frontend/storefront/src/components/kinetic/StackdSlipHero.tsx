'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'
import { STACKD_DIE } from '../../lib/stackdDie'

/**
 * StackdSlipHero — he slips, and the bread goes flying.
 *
 * The mascot is a man carrying a stack of scratch-cut slices on a plum tray
 * where his head should be. So: he goes down, and the stack launches. Scroll
 * DOWN and the bread goes UP — the further you read, the higher it gets, and it
 * never comes back. That inversion is the whole gag.
 *
 * An earlier pass had him land bolt upright with the stack dead level ("not a
 * crumb moved"). That was a different, more po-faced joke and not the one
 * asked for. Slapstick is the right register for a hand-drawn character whose
 * head is a loaf.
 *
 * This needs the drawing in two pieces, which it can be: rows 173-198 of the
 * source PNG are the tray, a solid bar 326px wide at 100% fill, so a cut at
 * y=173 runs exactly along its top edge rather than through any artwork.
 * Above it, the bread. Below it, the tray, both hands, the trousers and the
 * shoes — the guy. See public/brand/stackd/.
 *
 * Choreography, in scroll progress:
 *   0.00-0.12  standing, bread on the tray
 *   0.12-0.34  the slip: heels shoot forward, he rotates back. The bread holds
 *              its place for a beat — inertia is what sells it — then leaves.
 *   0.34-0.58  he goes flat and the seals jump off the impact
 *   0.16-1.00  the bread climbs and tumbles, easing out like a real lob
 *   0.60-1.00  the payoff
 *
 * Deliberately NOT flipd's hero, which is a technical drawing whose parts stop
 * dead where they seat. This brand is hand-drawn ink and warm paper, so this
 * one is all weight and timing.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  mascotAlt: string
  /** What the counter actually puts out. */
  counterLines: string[]
  /**
   * An operator-uploaded mascot, from admin -> Marketing -> Brands.
   *
   * The slip needs the drawing in two pieces and those are cut from the
   * BUNDLED artwork at known pixel rows — an arbitrary upload cannot be split
   * the same way at runtime. So a custom mascot is shown whole and still
   * rather than silently ignored, which is what would otherwise happen: the
   * operator uploads a drawing and nothing on the page changes.
   */
  customMascotSrc?: string | null
  customMascotDims?: { width?: number; height?: number }
}

/** 0..1 across a window of the scroll. */
const ramp = (from: number, rate: number) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${rate}))`

/** A 0..1..0 pulse: rises over the first window, falls over the second. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${ramp(up, upRate)} - ${ramp(down, downRate)})`

// The seals that jump off him hitting the floor. Offsets in rem — a percentage
// on the seal's own transform is a percentage of the SEAL, a couple of rem
// wide, which piles them all in one spot.
const SEALS = [
  { x: -19, y: -1.2, size: 3.2, tilt: -14, fire: 0.40 },
  { x: 16, y: -2.4, size: 2.7, tilt: 11, fire: 0.41 },
  { x: -11, y: -3.6, size: 2.0, tilt: 8, fire: 0.43 },
  { x: 21, y: -0.6, size: 1.7, tilt: -19, fire: 0.42 },
  { x: -23, y: -0.3, size: 1.4, tilt: 16, fire: 0.45 },
]

function Seal({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={`${size}rem`} height={`${size}rem`} aria-hidden>
      <path d={STACKD_DIE} fill="var(--stackd-cream)" stroke="var(--stackd-plum-dark)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function StackdSlipHero({
  brandName, orderHref, menuHref, mascotAlt, counterLines, customMascotSrc, customMascotDims,
}: Props) {
  // Matches the payoff's own fade-in point, so its links become reachable and
  // visible at the same instant. Without it the two CTAs are transparent but
  // still clickable and still in the tab order for the whole fall.
  const { ref, past } = useScrollProgress<HTMLElement>({ liveAt: 0.58 })

  // The slip itself. Eased so the first moment is slow — the wobble — and the
  // rest goes fast, which is how a real slip reads.
  const slip = ramp(0.12, 4.4)
  // The bread leaves slightly AFTER he does. That lag is the whole illusion:
  // the tray is yanked out from under it and it hangs for a frame.
  const toss = ramp(0.16, 1.25)
  const impact = pulse(0.36, 20, 0.40, 12)
  const after = ramp(0.58, 3.0)

  return (
    <section ref={ref} className="stackd-slip" aria-label={`${brandName} — the slip`}>
      <div className="stackd-slip-pin">
        <div className="stackd-slip-stage">

          <span className="stackd-slip-hint" style={{ ['--t' as string]: ramp(0.02, 14) }} aria-hidden>
            Scroll
          </span>

          {/* The floor, as one of the brand's own seals stretched wide — this
              brand has no straight-edged boxes anywhere in its collateral.
              Cream, and it has to stay cream: the mascot is PLUM line art on
              transparent, so on the plum field he is nearly invisible and the
              floor is the only thing he reads against. Trying it as a dark
              shadow instead made the whole lying pose disappear. */}
          <div className="stackd-slip-floor" style={{ ['--impact' as string]: impact }} aria-hidden>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
              <path d={STACKD_DIE} fill="var(--stackd-cream)" opacity="0.92" />
            </svg>
          </div>

          <div className="stackd-slip-seals" aria-hidden>
            {SEALS.map((s, i) => (
              <span
                key={i}
                className="stackd-slip-seal"
                style={{
                  ['--t' as string]: ramp(s.fire, 4.5),
                  ['--x' as string]: `${s.x}rem`,
                  ['--y' as string]: `${s.y}rem`,
                  ['--tilt' as string]: `${s.tilt}deg`,
                }}
              >
                <Seal size={s.size} />
              </span>
            ))}
          </div>

          {customMascotSrc ? (
            /* Uploaded artwork: whole and still. */
            <div className="stackd-slip-custom">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={customMascotSrc} alt={mascotAlt} {...(customMascotDims ?? {})} />
            </div>
          ) : (
          <>
          {/* The bread. Climbs and tumbles for the whole rest of the scroll and
              never comes down: scroll further, it goes higher. */}
          <div className="stackd-slip-bread" style={{ ['--t' as string]: toss }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/stackd/bread.png" alt="" aria-hidden="true" width={197} height={167} />
          </div>

          {/* Him. Heels forward, over he goes. */}
          <div className="stackd-slip-guy" style={{ ['--t' as string]: slip, ['--impact' as string]: impact }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/stackd/guy.png" alt={mascotAlt} width={326} height={274} />
          </div>
          </>
          )}

        </div>

        {/* Its own grid row, so he can never land on the words. Hidden rather
            than transparent until it lands — see liveAt above. */}
        <div
          className="stackd-slip-after"
          style={{ ['--t' as string]: after, visibility: past ? 'visible' : 'hidden' }}
        >
          <p className="stackd-slip-line">we&rsquo;ll make another.</p>
          <p className="stackd-slip-sub">
            everything here is cut, baked and built on site — {counterLines.map((l) => l.replace(/\.$/, '')).join(', ').toLowerCase()}.
          </p>
          <div className="stackd-slip-cta">
            <Link href={orderHref} className="stackd-btn">Order {brandName}</Link>
            <Link href={menuHref} className="stackd-btn stackd-btn-ghost">See the menu</Link>
          </div>
        </div>
      </div>
    </section>
  )
}
