// simmer.itinerary — "tonight's service". Walnut-framed pictures hung off a
// single thin orange rail like an evening itinerary (I → II → III). Header
// carries the live service date. Ported from SimmerLayout; the stops are a
// list field (label + photo, or one of the drawn sketches when no photo).

import type { ReactNode } from 'react'
import type { SectionProps } from '../types'
import { list, safeSrc } from '../safe'
import { HEADING_RESET, simmerText, stampOr, surface, type Surface } from './shared'

interface Stop { label?: unknown; image?: unknown; alt?: unknown; art?: unknown }

export function Itinerary({ fields: f }: SectionProps) {
  const s = surface(f['surface'], 'bone')
  const stamp = stampOr(f['stamp'])
  const stops = list<Stop>(f['stops'])
  const eyebrow = simmerText(f['eyebrow'])

  return (
    <div className="simmer-page">
      <section style={{
        background: s.background,
        color: s.color,
        padding: 'clamp(3rem, 7vh, 5rem) clamp(1.4rem, 5vw, 3rem)',
      }}>
        <div style={{ maxWidth: 'clamp(42rem, 72vw, 60rem)', margin: '0 auto' }}>
          {/* Header — tonight's service · DATE */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            paddingBottom: '1rem',
            borderBottom: `1px solid ${s.line}`,
            marginBottom: '2.4rem',
          }}>
            {/* The section's heading, set as the eyebrow it always was. */}
            {eyebrow.trim()
              ? <h2 className="utility" style={{ ...HEADING_RESET, fontSize: '0.78rem' }}>{eyebrow}</h2>
              : <span />}
            <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{stamp}</span>
          </div>

          {/* Itinerary — orange rail + the framed pictures */}
          {stops.length > 0 && (
            <div style={{ position: 'relative', padding: '0.5rem 0 0.5rem' }}>
              <div aria-hidden="true" style={{
                position: 'absolute', top: '1rem', bottom: '1rem',
                left: '50%', transform: 'translateX(-50%)',
                width: '1px', background: 'var(--simmer-orange)', opacity: 0.55,
              }}/>
              {stops.map((stop, i) => {
                const src = safeSrc(stop.image)
                const art = stop.art === 'plate' ? <PlateSketch /> : stop.art === 'coupe' ? <CoupeSketch /> : (
                  // No stock photography: until a photo is set, the tiber surface.
                  <div aria-hidden="true" style={{ width: '100%', height: '100%', background: 'var(--simmer-green)' }} />
                )
                return (
                  <ItineraryStop key={i} side={i % 2 === 0 ? 'left' : 'right'} label={simmerText(stop.label)} surface={s}>
                    {src
                      // Below the fold: lazy, so it doesn't compete with the hero.
                      ? <img src={src} alt={simmerText(stop.alt)} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      : art}
                  </ItineraryStop>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ─── Walnut-framed picture hung off the itinerary rail ──────────────
function ItineraryStop({ side, label, surface: s, children }: { side: 'left' | 'right'; label: string; surface: Surface; children: ReactNode }) {
  // Frame scales with the column; shared by the frame and its label.
  const frameWidth = 'clamp(176px, 48%, 340px)'
  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: side === 'right' ? 'flex-end' : 'flex-start',
      marginBottom: 'clamp(1.8rem, 3vw, 2.6rem)',
    }}>
      {/* Frame zone — full width so the rail dot (left:50%) lands on the
          rail, and as tall as the frame so top:50% centres the dot on it. */}
      <div style={{ position: 'relative', width: '100%' }}>
        <span aria-hidden="true" style={{
          position: 'absolute',
          left: '50%', top: '50%',
          width: '10px', height: '10px', borderRadius: '50%',
          background: 'var(--simmer-bone)',
          border: '1.5px solid var(--simmer-orange)',
          transform: 'translate(-50%, -50%)',
          zIndex: 3,
        }}/>

        <div style={{
          // Walnut frame — layered wood grain, inset shadows for depth.
          background: 'linear-gradient(135deg, #6a4828 0%, #4a311c 22%, #1f1209 55%, #4a311c 80%, #6a4828 100%)',
          padding: '12px',
          width: frameWidth, maxWidth: frameWidth,
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
              background: '#06392F',
              overflow: 'hidden', position: 'relative',
            }}>
              {children}
            </div>
          </div>
        </div>
      </div>
      {/* Museum-label line, edge-aligned to the card's side. */}
      {label && (
        <p className="utility" style={{
          fontSize: '0.78rem',
          margin: '0.7rem 0 0',
          color: s.color,
          opacity: 0.85,
          width: frameWidth,
          textAlign: side === 'right' ? 'right' : 'left',
        }}>
          {label}
        </p>
      )}
    </div>
  )
}

// ─── Top-down plated-dish sketch (the kitchen) ──────────────────────
function PlateSketch() {
  return (
    <svg viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="#06392F"/>
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
    <svg viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="#06392F"/>
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
