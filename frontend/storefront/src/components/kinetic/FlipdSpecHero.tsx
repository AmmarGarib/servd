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
  { no: '01', name: 'Crown',  spec: 'Brioche.',                        side: 'left',  fire: 0.04, drop: -120 },
  { no: '02', name: 'Cheese', spec: 'American.',                       side: 'right', fire: 0.15, drop: -105 },
  { no: '03', name: 'Patty',  spec: 'Salt and pepper. Nothing else.',  side: 'left',  fire: 0.26, drop: -92, flip: true },
  { no: '04', name: 'Jam',    spec: 'Shroom & onion. House made.',     side: 'right', fire: 0.37, drop: -78 },
  { no: '05', name: 'Aioli',  spec: 'Chimichurri. Roasted garlic.',    side: 'left',  fire: 0.46, drop: -64 },
  { no: '06', name: 'Heel',   spec: 'Brioche.',                        side: 'right', fire: 0.55, drop: -50 },
]

/** 0..1 for one part: how far through its own seating window the scroll is. */
const seat = (fire: number, rate = 5) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${fire}) * ${rate}))`

/** Hand-drawn navy line art, one <g> per part. Cream fill, navy stroke —
 *  the die-cut sticker treatment from the brand book, pulled apart. */
function PartArt({ part }: { part: Part }) {
  const common = {
    fill: 'var(--flipd-bone)',
    stroke: 'var(--flipd-blue)',
    strokeWidth: 5,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  }
  switch (part.no) {
    case '01': // Brioche crown — domed, seeded.
      return (
        <svg viewBox="0 0 320 96" width="100%" aria-hidden>
          <path d="M14 88 C10 40 62 10 160 10 C258 10 310 40 306 88 Z" {...common} />
          {[[92, 52], [136, 38], [186, 42], [230, 56], [116, 70], [204, 70], [160, 56]].map(([x, y], i) => (
            <ellipse key={i} cx={x} cy={y} rx="7" ry="4.5" fill="var(--flipd-blue)"
              transform={`rotate(${(i * 37) % 60 - 30} ${x} ${y})`} />
          ))}
        </svg>
      )
    case '02': // Cheese — square slab, corners hanging over, melted drips.
      return (
        <svg viewBox="0 0 320 60" width="100%" aria-hidden>
          <path d="M28 8 L292 8 L300 30 C270 40 250 26 232 38 C214 50 196 32 174 42
                   C152 52 136 30 114 40 C92 50 74 28 52 38 L20 30 Z" {...common} />
        </svg>
      )
    case '03': // Smash patty — the one part drawn irregular on purpose. A smash
               // patty has a ragged lacy edge where the beef hit the flat top
               // and crisped past the round, so the silhouette is bumpy rather
               // than an ellipse, and the surface carries char speckle.
      return (
        <svg viewBox="0 0 320 78" width="100%" aria-hidden>
          <path d="M16 42 C14 30 24 22 38 20 C44 10 58 8 70 12 C82 4 98 6 108 12
                   C120 4 138 6 150 11 C164 3 182 6 194 12 C208 5 226 8 236 15
                   C252 10 268 16 276 24 C294 26 306 32 304 44
                   C306 58 290 66 274 66 C262 74 244 74 232 68 C218 76 200 74 188 68
                   C174 76 156 74 144 68 C130 76 112 74 100 68 C86 74 68 72 58 65
                   C40 64 18 58 16 42 Z" {...common} />
          {/* Char speckle — the crust, not decoration: it is the whole point of
              a smash patty and the reason the spec line says salt and pepper. */}
          <g fill="var(--flipd-blue)" opacity="0.55">
            {[[62,34],[96,28],[132,38],[168,30],[206,36],[240,30],[268,40],
              [80,52],[118,56],[158,50],[196,56],[232,50],[258,56]].map(([x,y],i)=>(
              <ellipse key={i} cx={x} cy={y} rx="4.5" ry="2.6"
                transform={`rotate(${(i*53)%70-35} ${x} ${y})`} />
            ))}
          </g>
        </svg>
      )
    case '04': // Jam — thin wavy band.
      return (
        <svg viewBox="0 0 320 42" width="100%" aria-hidden>
          <path d="M26 14 C60 2 92 24 126 12 C160 0 192 22 226 10 C258 -1 286 18 296 14
                   L296 28 C286 36 258 20 226 30 C192 42 160 20 126 32 C92 44 60 22 26 30 Z"
            {...common} />
        </svg>
      )
    case '05': // Aioli — a drizzle, not a layer. Drawn as a stroke only.
      return (
        <svg viewBox="0 0 320 38" width="100%" aria-hidden>
          <path d="M34 22 C66 6 84 32 116 18 C148 4 166 30 198 16 C230 2 252 28 286 16"
            fill="none" stroke="var(--flipd-blue)" strokeWidth="7" strokeLinecap="round" />
        </svg>
      )
    default: // 06 — Brioche heel. Flat top, rounded base.
      return (
        <svg viewBox="0 0 320 62" width="100%" aria-hidden>
          <path d="M18 8 L302 8 C306 40 262 54 160 54 C58 54 14 40 18 8 Z" {...common} />
        </svg>
      )
  }
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
