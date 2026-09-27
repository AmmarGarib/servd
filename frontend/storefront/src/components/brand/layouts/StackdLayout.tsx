'use client'
// stackd — brand microsite layout: a living café and market.
//
// Brand book (Sept 2026 deck), unchanged:
//   Palette   Pantone 19-2025 Red Plum field, 9180 cream type, 635 pale blue
//             as the one cool accent (--stackd-* in globals.css). No yellow.
//   Wordmark  lowercase "stackd." didone, cream on plum, "stackd & servd" in
//             italic beneath. Operator-uploadable; bundled PNG is the fallback.
//   Mascot    the hand-drawn bread-stack character. He is what goes on the
//             cups, wrappers and bags, so he does the work a plate would.
//   Seals     the die-cut coaster (lib/stackdDie.ts) — every sticker, stamp,
//             coaster and sign is stamped from it. No straight-edged boxes.
//
// "Cooked here. Wrapped, not plated." — the page walks through the room:
//   1. the slip       — he breathes, leans after you, steams; scroll, he slips
//   2. stickers       — what we do, slapped on as they arrive, each one moving;
//                       pick one up, peel one; the coffee peeks over an edge
//   3. the pastry case — this morning's bake on lit shelves; lift to look
//   4. the chiller    — grab-and-go; the door swings open on scroll, the fog
//                       clears, and the food crowd is inside
//   5. wrapped        — a parcel that unwraps as you read the story
//   6. visit          — the door sign (the croissant leaning on it), the hours
//                       on a till receipt, the map pin
//   7. other brands, then the sign-off: the crowd peeking out of a stackd bag
//
// The café keeps real hours. The server stamps html[data-k-stackd] (open ·
// closing · opening · closed) and WorldSync keeps it live, so the case lamp,
// the chiller LED, the sign and the crowd's sleep all read one truth
// (lib/world/kitchenCore) from the first paint. Between the set-pieces the
// room is never still: cream crumbs drift through the air by day, and at
// night a few stars show through the plum.
//
// Component CSS lives in components/brand/stackd/*.module.css. globals.css
// still owns the --stackd-* tokens and the fixed plum field (.stackd-bg-fixed).

import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, formatBrandName } from '../../../lib/concept'
import { StackdSlipHero } from '../../kinetic/StackdSlipHero'
import { useOpenStatus } from '../stackd/hours'
import { OpenSign } from '../stackd/OpenSign'
import { StickerWall } from '../stackd/StickerWall'
import { PastryCase } from '../stackd/PastryCase'
import { Chiller } from '../stackd/Chiller'
import { Parcel } from '../stackd/Parcel'
import { Visit } from '../stackd/Visit'
import { SignOff } from '../stackd/SignOff'
import { Motes, Stars } from '../../world/Ambient'
import ui from '../stackd/ui.module.css'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Bundled artwork. Used until the operator uploads a replacement in
// admin -> Marketing -> Brands -> Storefront. These ship in public/brand/ so
// the page never depends on the uploads host being up.
const FALLBACK_WORDMARK = '/brand/stackd-wordmark-tagline.png'

export function StackdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const status = useOpenStatus(hoursData)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false
  const brandName = formatBrandName(concept.name)
  const orderHref = `/${concept.slug}`
  const menuHref = `/brand/${concept.slug}/menu`

  // `|| fallback` rather than `??`: a cleared admin field sends "", which must
  // fall back too rather than render a broken image.
  const wordmarkSrc = concept.wordmarkUrl || FALLBACK_WORDMARK
  // Intrinsic size hints only for the bundled files — stating them for an
  // upload of a different shape would reserve the wrong box.
  const wordmarkDims = concept.wordmarkUrl ? {} : { width: 599, height: 195 }
  const mascotDims = concept.mascotUrl ? {} : { width: 338, height: 453 }
  const mascotAlt = concept.mascotUrl
    ? `${brandName} brand character`
    : 'The stackd character — a stack of bread slices carried on a plum tray, striped trousers below'

  return (
    <div className="stackd-page">
      {/* The plum field: fixed, full-bleed, soft pool of light at the top. */}
      <div aria-hidden className="stackd-bg-fixed" />

      <div style={{ position: 'relative', zIndex: 1, overflowX: 'clip' }}>
        {concept.announcementBanner && (
          <div
            role="status"
            style={{
              background: 'var(--stackd-plum-dark)',
              color: 'var(--stackd-cream)',
              padding: '0.7rem 1.5rem',
              textAlign: 'center',
              fontFamily: 'var(--stackd-mono)',
              fontSize: '0.74rem',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
            }}
          >
            {concept.announcementBanner}
          </div>
        )}

        <StackdSlipHero
          brandName={brandName}
          orderHref={orderHref}
          menuHref={menuHref}
          mascotAlt={mascotAlt}
          wordmarkSrc={wordmarkSrc}
          wordmarkDims={wordmarkDims}
          tagline={story.tagline}
          oneLiner={story.oneLiner}
          status={<OpenSign status={status} variant="pill" />}
          customMascotSrc={concept.mascotUrl}
          customMascotDims={mascotDims}
        />

        {/* One room: the stickers on the wall and the case beneath them, with
            crumbs in the air between (stars instead, after dark). */}
        <div className={ui.room}>
          <div className={ui.ambient} aria-hidden>
            <Motes count={12} seed={7} color="#FCE8CE" />
            <Stars count={14} seed={11} />
          </div>
          <StickerWall highlights={story.highlights} />
          <PastryCase menuHref={menuHref} />
        </div>

        <Chiller orderHref={orderHref} />

        <Parcel story={story.long} />

        <Visit
          slug={concept.slug}
          hoursData={hoursData}
          status={status}
          fallbackHours={story.hours}
          address={concept.address ?? null}
          locality={concept.addressLocality ?? null}
          latitude={concept.latitude ?? null}
          longitude={concept.longitude ?? null}
          phone={concept.phone ?? null}
          reservations={reservations}
        />

        {/* ── CROSS-BRAND STRIP ───────────────────────────────────────────── */}
        <CrossBrandStrip
          current={concept}
          concepts={concepts}
          accent="var(--stackd-cream)"
          kicker="Also from the same kitchen group"
          heading="Other lines coming out of the same kitchen group."
        />

        {/* The sign-off closes the brand; BrandShell's own CTA right below it
            closes the sale, so there is no order button here. */}
        <SignOff wordmarkSrc={wordmarkSrc} wordmarkDims={wordmarkDims} address={concept.address ?? 'Karachi'} />
      </div>
    </div>
  )
}
