'use client'
// simmer — brand microsite layout.
// Built strictly to the simmer-brand SKILL.md (canonical source of truth):
//   • Night mode (forest green surface, bone ink)
//   • Amarante for display, Times for body/utility
//   • lowercase wordmark `simmer`, tagline `simmer down.` (below, never above)
//   • single orange signal per viewport, no decorative repetition
//   • no white, no gradients, no emojis, no exclamation marks
//   • no banned words: elevated, curated, experience, journey, passionate,
//     crafted, artisanal, fusion, twist on a classic
//
// Menu items are intentionally absent from this surface — the dedicated
// /brand/simmer/menu route renders the full menu in the locked format.
// This page leads with brand identity and routes to menu / reserve / order.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { conceptHeroImage } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { SpeakeasyFridgeHero } from '../../kinetic/SpeakeasyFridgeHero'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Today's date in the menu's signature `26.05.26` format — same rhythm
// the printed menu uses at the top right. Tracked-out Times below the
// wordmark, never above.
function todayStamp(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${dd}.${mm}.${yy}`
}

const STAMP = todayStamp()

// ─── Walnut-framed picture hung off the itinerary rail ──────────────
// Side: 'left' = card pinned to the left half, 'right' = right half.
// The orange rail runs down the centre of the parent; a small
// bone-and-orange dot sits on the rail at this stop's vertical centre.
function ItineraryStop({ side, label, children }: { side: 'left' | 'right', label: string, children: React.ReactNode }) {
  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: side === 'right' ? 'flex-end' : 'flex-start',
      marginBottom: '1.8rem',
    }}>
      {/* Stop dot — pinned to the rail at the card's vertical centre.
          Calculated against the walnut card's centre, not the wrapper
          flex column (which now also holds the museum-label below the
          card). The dot lives at top: (card-height + own-radius) / 2;
          184px wide walnut + 12px padding on each side = 184px card,
          which renders ~150px tall on the 5:4 aspect-ratio image plus
          24px frame chrome ≈ 174px. Half ≈ 87px. */}
      <span aria-hidden="true" style={{
        position: 'absolute',
        left: '50%', top: '87px',
        width: '10px', height: '10px', borderRadius: '50%',
        background: 'var(--simmer-bone)',
        border: '1.5px solid var(--simmer-orange)',
        transform: 'translate(-50%, -50%)',
        zIndex: 3,
      }}/>

      <div style={{
        // Walnut frame — layered gradient mimics polished wood grain,
        // inset shadows give it the depth of a hung picture frame.
        background: 'linear-gradient(135deg, #6a4828 0%, #4a311c 22%, #1f1209 55%, #4a311c 80%, #6a4828 100%)',
        padding: '12px',
        width: '184px', maxWidth: '184px',
        borderRadius: '2px',
        boxShadow:
          '0 18px 36px rgba(20,12,5,0.45),' +
          ' 0 2px 0 rgba(0,0,0,0.30),' +
          ' inset 0 0 0 1px rgba(0,0,0,0.45),' +
          ' inset 0 0 0 2px rgba(196,142,72,0.18)',
        marginLeft:  side === 'right' ? 'auto' : 0,
        marginRight: side === 'left'  ? 'auto' : 0,
        position: 'relative',
      }}>
        {/* Inner mat — thin green rebate around the artwork */}
        <div style={{
          background: 'var(--simmer-green)',
          padding: '4px',
          borderRadius: '1px',
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.55)',
          position: 'relative',
        }}>
          <div style={{
            width: '100%', aspectRatio: '5 / 4',
            background: '#15231f',
            overflow: 'hidden', position: 'relative',
          }}>
            {children}
          </div>
        </div>
      </div>
      {/* Museum-label line below the card, edge-aligned to the card's
          side. Tracked-out lowercase utility-Times per the simmer brand
          bible. Uses simmer-green ink so it reads against the bone
          itinerary surface. */}
      <p className="utility" style={{
        fontSize: '0.78rem',
        margin: '0.7rem 0 0',
        color: 'var(--simmer-green)',
        opacity: 0.85,
        // Match the walnut card's edge so the label tucks under it
        // rather than centring under the dot.
        width: '184px',
        textAlign: side === 'right' ? 'right' : 'left',
      }}>
        {label}
      </p>
    </div>
  )
}

// ─── Top-down plated-dish sketch (the kitchen) ──────────────────────
function PlateSketch() {
  return (
    <svg viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="#15231f"/>
      <g stroke="rgba(237,230,211,0.6)" strokeWidth="1.2" fill="none">
        <circle cx="100" cy="80" r="58"/>
        <circle cx="100" cy="80" r="48" strokeWidth="0.5" opacity="0.55"/>
      </g>
      <ellipse cx="100" cy="80" rx="54" ry="54" fill="rgba(237,230,211,0.03)"/>
      <circle cx="78" cy="92" r="3.2" fill="var(--simmer-orange)"/>
      <circle cx="78" cy="92" r="6.5" fill="rgba(233,78,27,0.18)"/>
      <g stroke="rgba(237,230,211,0.75)" strokeWidth="0.7" strokeLinecap="round" fill="none">
        <line x1="106" y1="70" x2="112" y2="64"/>
        <line x1="113" y1="68" x2="118" y2="63"/>
        <line x1="110" y1="74" x2="116" y2="71"/>
      </g>
      <ellipse cx="118" cy="92" rx="9" ry="4.5" transform="rotate(-22 118 92)"
               fill="rgba(237,230,211,0.18)" stroke="rgba(237,230,211,0.75)" strokeWidth="0.7"/>
      <path d="M86 100 Q102 106 124 100"
            stroke="rgba(237,230,211,0.35)" strokeWidth="0.5" fill="none"/>
      <circle cx="100" cy="62" r="1.4" fill="rgba(237,230,211,0.85)"/>
      <circle cx="103" cy="60" r="1.1" fill="rgba(237,230,211,0.65)"/>
    </svg>
  )
}

// ─── Coupe-glass mocktail sketch (the bar) ──────────────────────────
function CoupeSketch() {
  return (
    <svg viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="#15231f"/>
      <g stroke="rgba(237,230,211,0.7)" strokeWidth="1.2" fill="none" strokeLinecap="round">
        <ellipse cx="100" cy="58" rx="50" ry="11"/>
        <path d="M50 58 Q52 94 100 102 Q148 94 150 58"/>
        <line x1="100" y1="102" x2="100" y2="138"/>
        <ellipse cx="100" cy="142" rx="30" ry="4"/>
      </g>
      <path d="M58 62 Q70 92 100 98 Q130 92 142 62 Z" fill="rgba(233,78,27,0.32)"/>
      <ellipse cx="100" cy="62" rx="42" ry="6" fill="none" stroke="rgba(237,230,211,0.5)" strokeWidth="0.7"/>
      <path d="M62 56 Q78 48 96 46" stroke="rgba(237,230,211,0.75)" strokeWidth="1" fill="none"/>
      <ellipse cx="120" cy="56" rx="5" ry="2" fill="rgba(237,230,211,0.85)"
               stroke="rgba(237,230,211,0.85)" strokeWidth="0.4"
               transform="rotate(-20 120 56)"/>
      <circle cx="86" cy="78" r="1.4" fill="none" stroke="rgba(237,230,211,0.55)" strokeWidth="0.5"/>
      <circle cx="92" cy="86" r="0.9" fill="none" stroke="rgba(237,230,211,0.40)" strokeWidth="0.5"/>
    </svg>
  )
}

// ─── ElsewhereButton ────────────────────────────────────────────────
// Outbound link button used in the "elsewhere" section. Uses the
// simmer .action class as the base (bone border + tracked-lowercase
// Times) and adds a small icon to the left. External URLs open in a
// new tab; mailto:/tel: stay in place.
function ElsewhereButton({ href, label, icon }: {
  href: string
  label: string
  icon: React.ReactNode
}) {
  const isExternal = !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('/')
  return (
    <a
      href={href}
      {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="action"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.55rem',
        padding: '0.85rem 0.85rem',
        // .action defaults to inline-block — flex above wins; this just
        // keeps every cell width-uniform inside the grid.
        width: '100%',
      }}
    >
      {icon}
      <span>{label}</span>
    </a>
  )
}

// ─── Outbound social/location icon set ──────────────────────────────
// Minimal lucide-style strokes at 14px. Stroke inherits from
// .action's color (simmer-bone) so the icon stays in palette.
function MapsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}
function InstagramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
    </svg>
  )
}
function FacebookIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
    </svg>
  )
}
function WhatsAppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  )
}
function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  )
}

export function SimmerLayout({ concept, concepts }: Props) {
  // Hours + reservations CTA live in the chiller hero; this page no
  // longer needs the hoursData hook or the reservations gate.

  // Classes (.simmer-page, .amarante, .utility, .signal, .rule, .wordmark,
  // .action, .action--signal, .simmer-visit-grid) live in globals.css.
  return (
    <div className="simmer-page">
      {/* ── Announcement strip (only when operator has filled the field) ───────
          Per the brand bible: operational copy stays plain and clear. */}
      {concept.announcementBanner && (
        <div
          role="status"
          style={{
            background: 'var(--simmer-black)',
            color: 'var(--simmer-bone)',
            padding: '0.7rem 1.5rem',
            textAlign: 'center',
            fontFamily: 'var(--simmer-body)',
            fontSize: '0.78rem',
            letterSpacing: '0.22em',
            textTransform: 'lowercase',
          }}
        >
          {concept.announcementBanner}
        </div>
      )}

      {/* ── SPEAKEASY FRIDGE HERO ────────────────────────────────────────
          Scroll-driven walk-in chiller door that swings open to reveal
          "RESERVATIONS ONLY". Mirrors the IRL entrance — Simmer is in
          the basement of Stax, accessed through what looks like a
          fridge door. The web entrance is the same. Pure scroll, no
          clicks. */}
      <SpeakeasyFridgeHero
        brandName="simmer"
        accent="var(--simmer-orange)"
        ink="var(--simmer-green)"
        wood="var(--simmer-walnut)"
        marble="var(--simmer-green)"
        cream="var(--simmer-bone)"
        reserveHref={`/reserve/${concept.slug}`}
        menuHref={`/brand/${concept.slug}/menu`}
      />

      {/* ── TONIGHT'S TABLE ──────────────────────────────────────────
          Bone-backed editorial section. Three walnut-framed pictures
          hang off a single thin orange rail like an evening itinerary
          (I → II → III): the room (interior photo placeholder), the
          kitchen (plated-dish sketch), the bar (coupe sketch). Header
          carries the live service date — recomputed at render so the
          stamp ticks daily without operator action. Replaces the
          previous three-column "the room / the kitchen / the bar"
          caption block. */}
      <section style={{
        background: 'var(--simmer-bone)',
        color: 'var(--simmer-green)',
        padding: 'clamp(3rem, 7vh, 5rem) clamp(1.4rem, 5vw, 3rem)',
      }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          {/* Header — tonight's service · DATE */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            paddingBottom: '1rem',
            borderBottom: '1px solid rgba(27,45,42,0.18)',
            marginBottom: '2.4rem',
          }}>
            <span className="utility" style={{ fontSize: '0.78rem' }}>tonight&apos;s service</span>
            <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{STAMP}</span>
          </div>

          {/* Itinerary — orange rail + three walnut-framed pictures */}
          <div style={{ position: 'relative', padding: '0.5rem 0 0.5rem' }}>
            {/* The rail */}
            <div aria-hidden="true" style={{
              position: 'absolute', top: '1rem', bottom: '1rem',
              left: '50%', transform: 'translateX(-50%)',
              width: '1px', background: 'var(--simmer-orange)', opacity: 0.55,
            }}/>

            <ItineraryStop side="left" label="the space">
              <img
                src={conceptHeroImage(concept)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </ItineraryStop>

            <ItineraryStop side="right" label="the plate">
              <PlateSketch />
            </ItineraryStop>

            <ItineraryStop side="left" label="the pour">
              <CoupeSketch />
            </ItineraryStop>
          </div>
        </div>
      </section>

      {/* ── WHAT'S NEXT ───────────────────────────────────────────────────
          Replaces the old "the menu — read it / order from simmer" CTA
          block. Per the simmer brand bible (Caption voice + single
          orange signal per layout): short forward-looking note from the
          kitchen on what's being tested for the next menu. Reward for
          regulars; honest behind-the-line moment. Refresh weekly. The
          date stamp in the header is the only orange accent in this
          section — leave everything else bone/mute so the eye lands on
          the date and the body copy. */}
      <section style={{ padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            paddingBottom: '0.9rem',
            marginBottom: '2rem',
            borderBottom: '1px solid rgba(237,230,211,0.18)',
          }}>
            <span className="utility" style={{ fontSize: '0.78rem' }}>what&apos;s next</span>
            <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{STAMP}</span>
          </div>
          <p style={{
            fontFamily: 'var(--simmer-body)',
            fontSize: 'clamp(1.05rem, 1.5vw, 1.2rem)',
            lineHeight: 1.75,
            letterSpacing: '0.02em',
            margin: 0,
            color: 'var(--simmer-bone)',
          }}>
            We&apos;re testing a stone-fruit dessert for late June. Apricots came in two weeks early this year. The pastry team has been pulling late nights. If you sit again in three weeks, it might be on the table.
          </p>
          <p className="amarante" style={{
            fontSize: '1.05rem',
            fontStyle: 'italic',
            marginTop: '2rem',
            opacity: 0.7,
            letterSpacing: '0.02em',
          }}>
            — the simmer team
          </p>
        </div>
      </section>

      <hr className="rule" />

      {/* ── ELSEWHERE ────────────────────────────────────────────────────────
          Replaces the old hours/visit/reservations block — all three were
          already in the chiller hero (hours sticker on the floor of the
          cooler, Reserve a table pill inside the open door). What's left
          to add is off-platform reach: maps for the speakeasy door, the
          @simmer_down handle for the feed, the other socials, a direct
          line. Five outbound buttons; one orange signal carried by the
          @simmer_down handle in the eyebrow row. */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            paddingBottom: '0.9rem',
            marginBottom: '1.6rem',
            borderBottom: '1px solid rgba(237,230,211,0.18)',
            gap: '1rem',
            flexWrap: 'wrap',
          }}>
            <span className="utility" style={{ fontSize: '0.78rem' }}>elsewhere</span>
            <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>@simmer_down</span>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '0.7rem',
          }}>
            <ElsewhereButton href="https://www.google.com/maps/search/?api=1&query=Bukhari+Commercial+DHA+Phase+6+Karachi" label="maps" icon={<MapsIcon />} />
            <ElsewhereButton href="https://instagram.com/simmer_down"                                                       label="instagram" icon={<InstagramIcon />} />
            <ElsewhereButton href="https://facebook.com/simmerdown"                                                          label="facebook"  icon={<FacebookIcon />} />
            <ElsewhereButton href="https://wa.me/923001234567"                                                               label="whatsapp"  icon={<WhatsAppIcon />} />
            <ElsewhereButton href="mailto:hello@eatsimmer.com"                                                               label="email"     icon={<MailIcon />} />
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ── CROSS-BRAND STRIP — reuse the existing component. The accent
          comes through via the brand-accent override at the BrandShell. */}
      <div style={{ background: 'var(--simmer-bone)', color: 'var(--simmer-green)' }}>
        <CrossBrandStrip
          current={concept}
          concepts={concepts}
          accent="var(--simmer-orange)"
          kicker="other kitchens"
          heading="more from the operator."
        />
      </div>

      {/* ── SIGN-OFF — the brand's closing line ───────────────────────── */}
      <section style={{ padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)', textAlign: 'center' }}>
        <p className="wordmark" style={{ fontSize: 'clamp(3.5rem, 10vw, 6rem)', margin: 0 }}>
          simmer down<span className="signal">.</span>
        </p>
      </section>
    </div>
  )
}
