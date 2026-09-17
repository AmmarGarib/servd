'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'

/**
 * FlipdSpecHero — flipd's web entrance: the burger as an exploded parts diagram.
 *
 * Where it comes from, both halves of it from the brand book:
 *
 *   1. The artwork. The signature flipd graphic — on the shirt backs, the
 *      bags, the sticker, the badge itself — is a burger drawn EXPLODED: crown,
 *      fillings and heel floating apart with air between them, in navy line art.
 *      This hero is that drawing, at full size, moving.
 *
 *   2. The first core value: "The spec is the boss. Every burger is built the
 *      same way by whoever is on the line. Recipes are written, weights are
 *      weighed, no one improvises during service."
 *
 * So the page does not show a burger. It shows the SPEC for one — a technical
 * exploded-parts drawing with numbered callouts on leader lines — and then
 * executes it. Scroll and the parts descend and seat in order, each callout
 * stamping in as its part lands. By the time the stack closes you have read the
 * build.
 *
 * The one flourish is earned by the name: at 04 the patty FLIPS as it drops.
 * Once, on one part. The book says "restraint over decoration — if something on
 * the plate isn't earning its place, it comes off", so there is nothing else:
 * no glow, no gradient, no parallax drift, no bounce. The parts move like parts,
 * on straight lines, and stop dead when they seat.
 *
 * Mechanics: one tall section with a pinned child. useScrollProgress writes
 * --scroll-progress on the section and CSS does all the work off it, so
 * scrolling never re-renders React. Each part carries its own --fire (when it
 * starts moving) and --rate (how fast it seats); the shared `seat` expression
 * below turns those into a 0..1 that drives translate, opacity and rotation.
 *
 * prefers-reduced-motion: the whole thing renders assembled and static, with
 * every callout visible. It is a diagram either way — the motion is how it is
 * read, not what it says.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  /** Shown under the wordmark once the stack closes. */
  tagline: string
}

// The parts, crown to heel — the order they appear in the badge.
//
// Every spec line is a fact already published somewhere: the menu sheet's build
// lines, or the brand book's own sentences. Nothing here is written copy. The
// book's voice rule is "plain-spoken: names the ingredient, skips the
// adjective", so where there is no fact to state the line is just the part.
interface Part {
  /** Callout number, as it reads on the diagram. */
  no: string
  name: string
  /** One line, verbatim from the menu sheet or the brand book. */
  spec: string
  /** Which piece of the badge artwork this part is. */
  art: 'crown' | 'lettuce' | 'wing' | 'patty' | 'heel'
  /** Which side the leader line runs to on desktop. */
  side: 'left' | 'right'
  /** Scroll progress at which this part starts to seat. */
  fire: number
  /** How far above its slot the part starts, in px. Deliberately short — a
   *  part that starts further up than the stage is tall piles onto the ones
   *  above it instead of descending into its own slot. */
  drop: number
  /** The patty turns over on the way down. Nothing else does. */
  flip?: boolean
}

const PARTS: Part[] = [
  { no: '01', name: 'Crown',  spec: 'Brioche.',                       art: 'crown',   side: 'left',  fire: 0.05, drop: -120 },
  { no: '02', name: 'Jam',    spec: 'Shroom & onion. House made.',    art: 'lettuce', side: 'right', fire: 0.17, drop: -104 },
  { no: '03', name: 'Aioli',  spec: 'Chimichurri. Roasted garlic.',   art: 'wing',    side: 'left',  fire: 0.29, drop: -88 },
  { no: '04', name: 'Patty',  spec: 'Salt and pepper. Nothing else.', art: 'patty',   side: 'right', fire: 0.41, drop: -72, flip: true },
  { no: '05', name: 'Heel',   spec: 'Brioche.',                       art: 'heel',    side: 'left',  fire: 0.53, drop: -56 },
]

/** 0..1 for one part: how far through its own seating window the scroll is. */
const seat = (fire: number, rate = 5) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${fire}) * ${rate}))`

/**
 * The parts are the BRAND'S OWN ARTWORK, cut out of the badge.
 *
 * These were hand-drawn SVG approximations until the operator pointed out
 * there was no reason to approximate: the badge already contains every one of
 * these pieces, drawn properly, and the exploded versions are how the brand
 * uses them on the shirt backs and the bags. So each part is now a slice of
 * the real plate — segmented off the high-resolution badge by colour distance
 * and connected-component analysis, with a soft alpha so the hand-drawn edge
 * keeps its texture instead of being hard-thresholded into a jaggy silhouette.
 *
 * They are navy line art on transparent, so they sit on the mustard field the
 * way the book draws them. Each is a plain <img>: no filters, no recolouring —
 * the book says the artwork is "stamped, not printed... keep it that way".
 */
function PartArt({ part }: { part: Part }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/brand/parts/${part.art}.png`}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height: 'auto' }}
    />
  )
}

export function FlipdSpecHero({ brandName, orderHref, menuHref, tagline }: Props) {
  const { ref } = useScrollProgress<HTMLElement>()

  // The stack settles tight but stays EXPLODED. That is the brand's own
  // artwork — the shirt backs and the bags all show it pulled apart, never
  // assembled — and it is also the only state in which all six callouts can be
  // read at once. `built` is "every part has seated", not "the burger closed".
  const built = seat(0.62, 3.2)
  // The wordmark holds the patty's slot only until the parts start arriving on
  // top of it. It must be gone before the patty seats at ~0.26, or the two sit
  // on each other — which they did.
  const markGone = seat(0.08, 8)

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

        <div className="flipd-spec-stage">
          {PARTS.map((part) => (
            <div
              key={part.no}
              className={`flipd-spec-part flipd-spec-part--${part.side}`}
              style={{
                // Seating: travels `drop` px down to 0, fading in over the
                // first third of its own window so it never pops.
                ['--t' as string]: seat(part.fire),
                ['--drop' as string]: `${part.drop}px`,
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

          {/* The wordmark lives in the patty's slot until the stack closes. */}
          <p className="flipd-spec-mark" style={{ ['--t' as string]: markGone }}>
            {brandName}
          </p>
        </div>

        {/* Lands once the stack is closed. */}
        <div className="flipd-spec-outro" style={{ ['--t' as string]: built }}>
          <p className="flipd-spec-tagline">{tagline}</p>
          <div className="flipd-spec-cta">
            <Link href={orderHref} className="flipd-btn">Order now</Link>
            <Link href={menuHref} className="flipd-btn flipd-btn-ghost">See the menu</Link>
          </div>
        </div>

        <span className="flipd-spec-hint" style={{ ['--t' as string]: seat(0.02, 12) }} aria-hidden>
          Scroll to build it
        </span>
      </div>
    </section>

    {/* The written build, after the pinned section.
        It is the accessible copy of the diagram — the callouts are aria-hidden
        precisely so a screen reader gets this one and not both — and on a phone
        it is also the visible one, because six parts plus six callouts do not
        fit beside each other at 390px. Desktop hides it. */}
    <ol className="flipd-spec-list">
      {PARTS.map((p) => (
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
