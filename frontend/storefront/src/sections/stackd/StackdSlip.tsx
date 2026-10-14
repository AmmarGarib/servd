'use client'
// stackd.slip — he slips, and the bread goes flying. Ported from
// components/kinetic/StackdSlipHero.tsx; the choreography is unchanged, every
// word, image and link is now a field.
//
// The mascot is a man carrying a stack of scratch-cut slices on a plum tray
// where his head should be. So: he goes down, and the stack launches. Scroll
// DOWN and the bread goes UP — the further you read, the higher it gets, and it
// never comes back. That inversion is the whole gag.
//
// This needs the drawing in two pieces: rows 173-198 of the source PNG are the
// tray, a solid bar 326px wide, so a cut at y=173 runs exactly along its top
// edge. Above it, the bread. Below it, the tray, both hands, the trousers and
// the shoes — the guy. See public/brand/stackd/.
//
// Choreography, in scroll progress:
//   0.00-0.12  standing, bread on the tray
//   0.12-0.34  the slip: heels shoot forward, he rotates back. The bread holds
//              its place for a beat — inertia is what sells it — then leaves.
//   0.34-0.58  he goes flat and the seals jump off the impact
//   0.16-1.00  the bread climbs and tumbles, easing out like a real lob
//   0.60-1.00  the payoff

import Link from 'next/link'
import type { SectionProps } from '../types'
import { safeSrc, str, link, list } from '../safe'
import { useScrollProgress } from '../../components/kinetic/motionHooks'
import { STACKD_DIE } from '../../lib/stackdDie'
import { StackdFrame, stackdConcept, brandName, fill, stackdHref, FALLBACK_MASCOT } from './shared'
import { sectionKitImage } from '../brand/kitImage'

const BUNDLED_BREAD = '/brand/stackd/bread.png'
const BUNDLED_GUY = '/brand/stackd/guy.png'

/** 0..1 across a window of the scroll. */
const ramp = (from: number, rate: number) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${rate}))`

/** A 0..1..0 pulse: rises over the first window, falls over the second. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${ramp(up, upRate)} - ${ramp(down, downRate)})`

// The seals that jump off him hitting the floor. Offsets in rem — a percentage
// on the seal's own transform is a percentage of the SEAL, a couple of rem
// wide, which piles them all in one spot. Motion, so it stays code.
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

export function StackdSlip({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const name = brandName(concept)

  // An uploaded mascot (the section's own, else admin -> Brands) can't be cut
  // into bread + guy at known pixel rows, so it is shown whole and still
  // rather than silently ignored.
  // Section field → brand kit mascot → Concept mascot. The kit's bundled
  // default (the full mascot art) is NOT a custom upload: the cut bread + guy
  // below stay the default look.
  const kitMascot = sectionKitImage(ctx, 'mascot', concept)
  const customMascot = safeSrc(fields.customMascot) || (kitMascot && kitMascot !== FALLBACK_MASCOT ? safeSrc(kitMascot) : '')
  const breadSrc = safeSrc(fields.breadImage) || BUNDLED_BREAD
  const guySrc = safeSrc(fields.guyImage) || BUNDLED_GUY
  const mascotAlt = customMascot ? fill(fields.customMascotAlt, concept) : str(fields.mascotAlt)

  const counter = list<{ text?: unknown }>(fields.counterLines)
    .map((l) => str(l.text).trim())
    .filter(Boolean)
  const subLead = str(fields.subLead).trim()
  const order = link(fields.orderCta)
  const menu = link(fields.menuCta)
  const orderTo = stackdHref(order.href, ctx, concept)
  const menuTo = stackdHref(menu.href, ctx, concept)

  // Matches the payoff's own fade-in point, so its links become reachable and
  // visible at the same instant.
  const { ref, past } = useScrollProgress<HTMLElement>({ liveAt: 0.58 })

  const slip = ramp(0.12, 4.4)
  // The bread leaves slightly AFTER he does — the tray is yanked out from
  // under it and it hangs for a frame.
  const toss = ramp(0.16, 1.25)
  const impact = pulse(0.36, 20, 0.40, 12)
  const after = ramp(0.58, 3.0)

  return (
    <StackdFrame>
      <section ref={ref} className="stackd-slip" aria-label={`${name} — the slip`}>
        <div className="stackd-slip-pin">
          <div className="stackd-slip-stage">

            {str(fields.hint) && (
              <span className="stackd-slip-hint" style={{ ['--t' as string]: ramp(0.02, 14) }} aria-hidden>
                {str(fields.hint)}
              </span>
            )}

            {/* The floor, as one of the brand's own seals stretched wide. Cream,
                and it has to stay cream: the mascot is PLUM line art, so the
                floor is the only thing he reads against. */}
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

            {/* The first screen. He is the page's largest paint (the measured
                LCP), so his image is fetched at high priority; everything below
                the slip loads lazily and stays out of his way. */}
            {customMascot ? (
              <div className="stackd-slip-custom">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={customMascot} alt={mascotAlt} fetchPriority="high" />
              </div>
            ) : (
              <>
                {/* The bread. Climbs and tumbles for the rest of the scroll and
                    never comes down. */}
                <div className="stackd-slip-bread" style={{ ['--t' as string]: toss }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={breadSrc} alt="" aria-hidden="true" {...(breadSrc === BUNDLED_BREAD && { width: 197, height: 167 })} />
                </div>

                {/* Him. Heels forward, over he goes. */}
                <div className="stackd-slip-guy" style={{ ['--t' as string]: slip, ['--impact' as string]: impact }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={guySrc} alt={mascotAlt} fetchPriority="high" {...(guySrc === BUNDLED_GUY && { width: 326, height: 274 })} />
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
            {str(fields.line) && <p className="stackd-slip-line">{fill(fields.line, concept)}</p>}
            {(subLead || counter.length > 0) && (
              <p className="stackd-slip-sub">
                {fill(subLead, concept)}
                {counter.length > 0 && <>{subLead ? ' ' : ''}{counter.map((l) => l.replace(/\.$/, '')).join(', ').toLowerCase()}.</>}
              </p>
            )}
            {((order.text && orderTo) || (menu.text && menuTo)) && (
              <div className="stackd-slip-cta">
                {order.text && orderTo && <Link href={orderTo} className="stackd-btn">{fill(order.text, concept)}</Link>}
                {menu.text && menuTo && <Link href={menuTo} className="stackd-btn stackd-btn-ghost">{fill(menu.text, concept)}</Link>}
              </div>
            )}
          </div>
        </div>
      </section>
    </StackdFrame>
  )
}
