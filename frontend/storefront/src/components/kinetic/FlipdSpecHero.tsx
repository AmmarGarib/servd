'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'

/**
 * FlipdSpecHero — flipd's web entrance: the burger built to its own spec.
 *
 * Where it comes from, both halves of it from the brand book:
 *
 *   1. The artwork. The signature flipd graphic — on the shirt backs, the
 *      bags, the sticker, the badge itself — is a burger drawn in navy line
 *      art: crown, fillings and heel. This hero is that drawing, moving.
 *
 *   2. The first core value: "The spec is the boss. Every burger is built the
 *      same way by whoever is on the line. Recipes are written, weights are
 *      weighed, no one improvises during service."
 *
 * So the page does not show a burger. It shows the BUILD SHEET for one — a
 * technical drawing with a datum line and numbered callouts on leader lines —
 * and then builds it. Five parts drop in from above the sheet, each landing
 * flush on the one below, and when the last one seats you are looking at a
 * whole burger, not a diagram of one. Then it drops onto the datum and hits.
 *
 * Three things an earlier pass got wrong, all of which this fixes:
 *
 *   - Every part started barely a part-height above its slot, so it emerged
 *     from behind the part above it rather than falling in. They now start
 *     clear of the sheet entirely and accelerate down, because a thing that
 *     falls is not a thing that slides.
 *   - The stack stayed exploded, with air between every layer, so it never
 *     resolved into anything. The slots are flush now: the burger closes.
 *   - It ran over four and a half screens of scroll, which turned a build into
 *     a slideshow: one part per screenful, nothing ever moving at the same
 *     time as anything else. It is 340vh now — cut to 240vh first, which went
 *     too far the other way and was too quick to follow.
 *
 * The one flourish is earned by the name: at 04 the patty FLIPS as it drops.
 * Once, on one part. The book says "restraint over decoration — if something
 * on the plate isn't earning its place, it comes off", so the impact is drawn
 * the way this brand draws everything else: a datum line that flexes and six
 * short navy ticks, struck like register marks. No dust, no glow, no bounce.
 *
 * Mechanics: one tall section with a pinned child. useScrollProgress writes
 * --scroll-progress on the section and CSS does all the work off it, so
 * scrolling never re-renders React. Each part carries its own --t (0 before it
 * moves, 1 when seated) and the stage carries --fall and --hit for the drop.
 *
 * prefers-reduced-motion: the whole thing renders built and static, with every
 * callout visible. It is a build sheet either way — the motion is how it is
 * read, not what it says.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  /** Shown under the wordmark once the burger lands. */
  tagline: string
}

// The parts, crown to heel — the order they appear in the badge.
//
// Every spec line is a fact already published somewhere: the menu sheet's build
// lines, or the brand book's own sentences. Nothing here is written copy. The
// book's voice rule is "plain-spoken: names the ingredient, skips the
// adjective", so where there is no fact to state the line is just the part.
interface Part {
  /** Callout number — the BUILD step, so 01 is the heel at the bottom. */
  no: string
  name: string
  /** One line, verbatim from the menu sheet or the brand book. */
  spec: string
  /** Which piece of the badge artwork this part is. */
  art: 'crown' | 'lettuce' | 'wing' | 'patty' | 'heel'
  /** Which side the leader line runs to on desktop. */
  side: 'left' | 'right'
  /** Scroll progress at which this part starts to fall. */
  fire: number
  /**
   * The part's own width, as a fraction of the widest piece.
   *
   * These are the source PNGs' real pixel widths (crown 918, lettuce 993,
   * wing 1038, patty 834, heel 894) divided by the widest. Forcing all five
   * to 100% — which is what used to happen — stretches the narrow ones to the
   * width of the wide ones, and a burger whose patty is as wide as its lettuce
   * does not read as a burger. This is the whole difference between a stack of
   * shapes and something you recognise.
   */
  w: number
  /**
   * How far above its own slot the part starts, as a multiple of the drawing's
   * width — so the fall scales with the drawing instead of with the window.
   *
   * These are measured against the real laid-out stack, not guessed: each part
   * starts clear above everything already placed under it, and falls a third
   * to three-quarters of the drawing's width. The whole fall is on screen and
   * nothing begins its fall inside another part — which is exactly what the
   * version before this did, with one small fixed drop for everything, and why
   * the parts looked like they were coming out of each other.
   */
  drop: number
  /** The patty turns over on the way down. Nothing else does. */
  flip?: boolean
}

/**
 * Laid out crown-first, because that is top-to-bottom on the page — but BUILT
 * heel-first, because that is how it is built on the line, and the numbers on
 * the sheet are build steps.
 *
 * That ordering is not a detail. Assembling downwards means every part after
 * the first has to fall THROUGH the ones already placed, which looks like a
 * mistake however well it is timed. Assembling upwards, each part lands on
 * what is already there and touches nothing else — and it is what the brand
 * book's first value actually describes.
 */
const PARTS: Part[] = [
  { no: '05', name: 'Crown', spec: 'Brioche.',                       art: 'crown',   side: 'left',  fire: 0.460, w: 0.884, drop: -0.34 },
  { no: '04', name: 'Jam',   spec: 'Shroom & onion. House made.',    art: 'lettuce', side: 'right', fire: 0.355, w: 0.957, drop: -0.50 },
  { no: '03', name: 'Aioli', spec: 'Chimichurri. Roasted garlic.',   art: 'wing',    side: 'left',  fire: 0.250, w: 1.000, drop: -0.61 },
  { no: '02', name: 'Patty', spec: 'Salt and pepper. Nothing else.', art: 'patty',   side: 'right', fire: 0.145, w: 0.803, drop: -0.68, flip: true },
  { no: '01', name: 'Heel',  spec: 'Brioche.',                       art: 'heel',    side: 'left',  fire: 0.040, w: 0.861, drop: -0.75 },
]

/** The same five in the order they are built, for the written list. */
const BUILD_ORDER = [...PARTS].reverse()

/**
 * 0..1 for one part: how far through its own seating window the scroll is.
 *
 * The default rate is the pace of the build. A part's fall spans 1/rate of the
 * scroll, so at rate 6 across a 340vh section each one takes about 40vh of
 * travel — roughly twice what it did at rate 7 in a 240vh section, which read
 * as too quick to follow. Successive parts fire 0.105 apart, closer together
 * than a part's own 0.167 window, so two are in the air at once and the build
 * never stalls between them. The order still resolves correctly: each part
 * lands well before the one above it does.
 */
const seat = (fire: number, rate = 6) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${fire}) * ${rate}))`

/** A 0..1..0 pulse: rises over the first window, falls over the second. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${seat(up, upRate)} - ${seat(down, downRate)})`

/**
 * A smooth 0..1..0 arc across one window — the shape of a thing thrown up and
 * caught. 4x(1-x) is a parabola peaking at the midpoint, which is exactly the
 * height curve of a bounce under gravity.
 */
const hump = (from: number, to: number) => {
  const r = `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${(1 / (to - from)).toFixed(3)}))`
  return `(4 * ${r} * (1 - ${r}))`
}

// The register marks struck at the moment of impact, as angles off the
// vertical. Six, symmetrical, in the brand's own navy — this is a technical
// drawing, so the impact is drawn, not rendered.
const TICKS = [-64, -38, -14, 14, 38, 64]

/**
 * The parts are the BRAND'S OWN ARTWORK, cut out of the badge.
 *
 * These were hand-drawn SVG approximations until the operator pointed out
 * there was no reason to approximate: the badge already contains every one of
 * these pieces, drawn properly. So each part is a slice of the real plate —
 * segmented off the high-resolution badge by colour distance and
 * connected-component analysis, with a soft alpha so the hand-drawn edge keeps
 * its texture instead of being hard-thresholded into a jaggy silhouette.
 *
 * They are navy line art on transparent, so they sit on the mustard field the
 * way the book draws them. Each is a plain <img>: no filters, no recolouring —
 * the book says the artwork is "stamped, not printed... keep it that way".
 */
function PartArt({ part }: { part: Part }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/brand/parts/${part.art}.png`} alt="" aria-hidden="true" />
  )
}

export function FlipdSpecHero({ brandName, orderHref, menuHref, tagline }: Props) {
  // liveAt matches the outro's own fade-in point exactly, so `past` flips at
  // the same instant its opacity leaves 0 — the links become reachable and
  // visible together, with no visual change from the switch.
  const { ref, past } = useScrollProgress<HTMLElement>({ liveAt: 0.92 })

  // ── THE DROP AND THE BOUNCE ────────────────────────────────────────────
  // The crown seats at 0.627 and nothing moves until 0.76, which leaves a
  // deliberate beat of about 2.5 wheel notches looking at a finished burger.
  // Without it, the last part seating and the whole stack dropping run
  // together into one event and the drop stops reading as something that
  // happens to a burger that is already built.
  //
  // Then it falls, hits, and BOUNCES — three times, each smaller, each with
  // its own squash. A single squash on contact read as a thud; a brioche stack
  // dropped on a counter rebounds. The heights are 38% / 15% / 5.5% of the
  // drop, which is roughly what a real object with this much give does.
  const fall = seat(0.76, 15)
  const b1 = hump(0.8267, 0.868)   // first rebound, the big one
  const b2 = hump(0.868, 0.898)
  const b3 = hump(0.898, 0.918)
  // Height above the datum, as a fraction of the 5vh drop. CSS multiplies it.
  const bounce = `calc(${b1} * 0.38 + ${b2} * 0.15 + ${b3} * 0.055)`
  // Airborne stretch: a bouncing thing elongates on the way up and flattens on
  // contact. Without it the bounce reads as a rigid hop.
  const stretch = `calc(${b1} * 0.55 + ${b2} * 0.3 + ${b3} * 0.12)`
  // One squash per contact, sharp on the way in and slower out, each weaker
  // than the last. The first is the impact; the others are it settling.
  const squash = `calc(${pulse(0.820, 150, 0.8267, 26)} + ${pulse(0.8635, 220, 0.868, 40)} * 0.45 + ${pulse(0.8955, 400, 0.898, 70)} * 0.18)`
  // The struck register marks and the flexing datum rule fire on the FIRST
  // contact only — that is the impact. The rise is deliberately violent and
  // tops out at 0.8267, exactly when the fall completes. This one window does
  // not get slower as the section grows: an impact is fast or it is not an
  // impact, and stretching it turns the strike into a slow bloom.
  const hit = pulse(0.820, 150, 0.8267, 26)
  // Lands once the burger has. The rate is set so it reaches full opacity by
  // the very end of the scroll rather than short of it — at a slower rate the
  // section runs out first and the CTAs never quite arrive.
  const built = seat(0.92, 12.5)
  // The wordmark holds the middle of the sheet until parts start arriving on
  // top of it. It must be gone before the heel — the first part to fall —
  // reaches it.
  const markGone = seat(0.02, 16)

  return (
    <>
    <section ref={ref} className="flipd-spec" aria-label={`${brandName} — how it is built`}>
      <div className="flipd-spec-pin">

        {/* Sheet header — this is a drawing, so it gets a drawing's title block. */}
        <div className="flipd-spec-title">
          <span className="flipd-spec-titleno">Build sheet</span>
          <span className="flipd-spec-titlerule" aria-hidden />
          <span className="flipd-spec-titleno">Same, every time</span>
        </div>

        <div className="flipd-spec-field">
          <div
            className="flipd-spec-stage"
            style={{
              ['--fall' as string]: fall,
              ['--hit' as string]: hit,
              ['--bounce' as string]: bounce,
              ['--stretch' as string]: stretch,
              ['--squash' as string]: squash,
            }}
          >
            {PARTS.map((part, i) => (
              <div
                key={part.no}
                className={`flipd-spec-part flipd-spec-part--${part.side}`}
                style={{
                  ['--t' as string]: seat(part.fire),
                  ['--w' as string]: `${(part.w * 100).toFixed(1)}%`,
                  ['--drop' as string]: part.drop,
                  // Upper layers paint over lower ones, which is what makes the
                  // overlap read as a burger rather than as five cut-outs. DOM
                  // order has to run crown-first for the vertical layout, so
                  // the painting order is set here instead.
                  zIndex: PARTS.length - i,
                }}
              >
                {/* Leader line + callout. Hidden below the diagram on narrow
                    screens, where there is no room beside it. */}
                <div className="flipd-spec-callout" aria-hidden>
                  <span className="flipd-spec-no">{part.no}</span>
                  <span className="flipd-spec-lead" />
                  <span className="flipd-spec-text">
                    <span className="flipd-spec-name">{part.name}</span>
                    <span className="flipd-spec-sub">{part.spec}</span>
                  </span>
                </div>

                {/* The flip lives here rather than on the part, so the callout
                    beside it stays the right way up. */}
                <div
                  className="flipd-spec-art"
                  style={{ ['--flip' as string]: part.flip ? '180deg' : '0deg' }}
                >
                  <PartArt part={part} />
                </div>
              </div>
            ))}

            {/* The wordmark holds the middle of the sheet until the build
                starts — which is exactly where FLIPD sits inside the badge. */}
            <p className="flipd-spec-mark" style={{ ['--t' as string]: markGone }}>
              {brandName}
            </p>
          </div>

          {/* The datum line the build sits on, and what it lands on. It is part
              of the drawing from the first frame, not something that appears
              for the impact — otherwise the burger falls onto nothing. */}
          <div className="flipd-spec-datum" style={{ ['--hit' as string]: hit }} aria-hidden>
            <span className="flipd-spec-datumrule" />
            {TICKS.map((a) => (
              <span key={a} className="flipd-spec-tick" style={{ ['--a' as string]: `${a}deg` }} />
            ))}
          </div>
        </div>

        {/* Lands once the burger has. Hidden outright until then, not merely
            transparent: two full-width buttons that are invisible but still
            clickable sit across the bottom of the first screen of the hero. */}
        <div
          className="flipd-spec-outro"
          style={{ ['--t' as string]: built, visibility: past ? 'visible' : 'hidden' }}
        >
          <p className="flipd-spec-tagline">{tagline}</p>
          <div className="flipd-spec-cta">
            <Link href={orderHref} className="flipd-btn">Order now</Link>
            <Link href={menuHref} className="flipd-btn flipd-btn-ghost">See the menu</Link>
          </div>
        </div>

        <span className="flipd-spec-hint" style={{ ['--t' as string]: seat(0.02, 10) }} aria-hidden>
          Scroll to build it
        </span>
      </div>
    </section>

    {/* The written build, after the pinned section.
        It is the accessible copy of the diagram — the callouts are aria-hidden
        precisely so a screen reader gets this one and not both — and on a phone
        it is also the visible one, because five parts plus five callouts do not
        fit beside each other at 390px. Desktop hides it. */}
    <ol className="flipd-spec-list">
      {BUILD_ORDER.map((p) => (
        <li key={p.no}>
          <span className="flipd-spec-no">{p.no}</span>
          <span className="flipd-spec-name">{p.name}</span>
          <span className="flipd-spec-sub">{p.spec}</span>
        </li>
      ))}
    </ol>
    </>
  )
}
