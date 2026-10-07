'use client'
// simmer.fridgeHero — Simmer's web entrance, mirroring the physical one.
// Ported from components/kinetic/SpeakeasyFridgeHero.tsx (which SimmerLayout
// still imports until the orchestrator removes it). The drawing, the scroll
// choreography and the door stay code; every word on it, the two buttons and
// the optional cooler photo are fields.
//
// IRL: Simmer is in the basement of Stackd. The entrance — inside Stackd —
// looks like a walk-in fridge door. On the web the first thing you see is the
// closed door drawn as a blueprint; scrolling swings it open on its hinge and
// "RESERVATIONS only." lands on the back wall, then the tagline and the
// Reserve / Menu buttons. Pure scroll, no clicks. The whole hero is a sticky
// 260vh section; CSS reads --scroll-progress to choreograph it.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { useScrollProgress } from '../../components/kinetic/motionHooks'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { link, safeHref, safeSrc } from '../safe'
import { simmerConcept, simmerText } from './shared'

// The palette, fixed: the hero is the brand's own entrance, so its colours are
// the SKILL.md tokens rather than owner fields (no white, single orange).
const ACCENT = 'var(--simmer-orange)'
const INK = 'var(--simmer-green)'
const WOOD = 'var(--simmer-walnut)'
const MARBLE = 'var(--simmer-green)'
const CREAM = 'var(--simmer-bone)'

/** Every label drawn on the blueprint. */
interface Drawing {
  plateTitle: string; plateModel: string; plateBuilt: string
  handle: string
  pane: string; paneNote: string
  hinge: string; hingeNote: string
  kick: string; kickNote: string
  height: string; width: string
  release: string; releaseNote: string
  evap: string; evapNote: string
  led: string
  rack: string; rackNote: string
  floor: string
}

export function FridgeHero({ fields: f, ctx }: SectionProps) {
  const { ref } = useScrollProgress<HTMLDivElement>()
  const t = (k: string) => simmerText(f[k])
  const concept = simmerConcept(ctx)

  const brandName = t('projectName').trim() || formatBrandName(concept.name)
  const projectNote = t('projectNote').trim()
  const revision = t('revision').replace(/\{year\}/g, String(new Date().getFullYear()))
  const reserve = link(f['reserve'])
  const menu = link(f['menu'])
  const coolerImageUrl = safeSrc(f['coolerImage'])

  const d: Drawing = {
    plateTitle: t('plateTitle'), plateModel: t('plateModel'), plateBuilt: t('plateBuilt'),
    handle: t('handleLabel'),
    pane: t('paneLabel'), paneNote: t('paneNote'),
    hinge: t('hingeLabel'), hingeNote: t('hingeNote'),
    kick: t('kickLabel'), kickNote: t('kickNote'),
    height: t('heightLabel'), width: t('widthLabel'),
    release: t('releaseLabel'), releaseNote: t('releaseNote'),
    evap: t('evapLabel'), evapNote: t('evapNote'),
    led: t('ledLabel'),
    rack: t('rackLabel'), rackNote: t('rackNote'),
    floor: t('floorLabel'),
  }

  return (
    <div className="simmer-page">
      <div
        ref={ref}
        style={{
          height: '260vh',                       // generous runway for the open
          position: 'relative',
          background: INK,
          color: CREAM,
          ['--brand-accent' as string]: ACCENT,
          ['--simmer-wood' as string]:  WOOD,
          ['--simmer-marble' as string]: MARBLE,
        } as CSSProperties}
      >
        <div className="sticky overflow-hidden"
          style={{
            top: 0,
            height: '100vh',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* BLUEPRINT BACKDROP — deep ink paper with a faint grid + cream
              technical lines drawing the cooler. Reads as "schematic of the
              entrance". */}
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: '#06392F' }} />
          {/* Faint blueprint grid — 40px squares, thin cream stroke */}
          <div aria-hidden="true" style={{
            position: 'absolute', inset: 0,
            backgroundImage: `
              linear-gradient(rgba(237,230,211,0.06) 1px, transparent 1px),
              linear-gradient(90deg, rgba(237,230,211,0.06) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px, 40px 40px',
          }} />
          {/* Heavier major grid every 200px */}
          <div aria-hidden="true" style={{
            position: 'absolute', inset: 0,
            backgroundImage: `
              linear-gradient(rgba(237,230,211,0.10) 1px, transparent 1px),
              linear-gradient(90deg, rgba(237,230,211,0.10) 1px, transparent 1px)
            `,
            backgroundSize: '200px 200px, 200px 200px',
          }} />
          {/* Vignette, kept off the top edge so the surround stays #06392F
              where it meets the header. */}
          <div aria-hidden="true" style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse 120% 85% at 50% 24%, transparent 0%, transparent 52%, rgba(0,0,0,0.28) 100%)',
          }} />

          {/* TITLE BLOCK — top-left: project name + drawing number */}
          <div style={{
            position: 'absolute', top: '3vh', left: '4vw',
            color: 'rgba(237,230,211,0.7)',
            fontFamily: 'var(--font-display)',
            fontSize: '0.62rem',
            letterSpacing: '0.32em',
            lineHeight: 1.55,
            zIndex: 6,
            textTransform: 'uppercase',
          }}>
            <p style={{ color: 'rgba(237,230,211,0.45)' }}>{t('projectEyebrow')}</p>
            <p style={{ color: '#EDE6D3', fontWeight: 700 }}>
              {brandName.toUpperCase()}{projectNote && ` · ${projectNote}`}
            </p>
            <p style={{ color: 'rgba(237,230,211,0.45)', marginTop: '0.6rem' }}>{t('sheet')}</p>
          </div>
          {/* TITLE BLOCK — top-right: scale + revision */}
          <div style={{
            position: 'absolute', top: '3vh', right: '4vw',
            color: 'rgba(237,230,211,0.7)',
            fontFamily: 'var(--font-display)',
            fontSize: '0.62rem',
            letterSpacing: '0.32em',
            lineHeight: 1.55,
            zIndex: 6,
            textTransform: 'uppercase',
            textAlign: 'right',
          }}>
            <p style={{ color: 'rgba(237,230,211,0.45)' }}>{t('scale')}</p>
            <p style={{ color: 'rgba(237,230,211,0.45)' }}>{revision}</p>
            <p style={{ color: '#EDE6D3', fontWeight: 700, marginTop: '0.6rem' }}>{t('scrollCue')}</p>
          </div>

          {/* THE DOOR ASSEMBLY — interior (behind), door (rotates), frame. */}
          <div
            style={{
              position: 'relative',
              width: 'min(680px, 90vw)',
              aspectRatio: '3 / 4.6',
              perspective: 1800,
              zIndex: 2,
            }}
          >
            {/* INTERIOR — an empty walk-in cooler; the speakeasy hint is the
                headline on the back wall. */}
            <div
              aria-hidden={true}
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '4px',
                overflow: 'hidden',
                opacity: 'calc(var(--scroll-progress, 0) * 1.8)',
                transition: 'opacity 80ms linear',
              } as CSSProperties}>
              <CoolerInterior
                accent={ACCENT}
                cream={CREAM}
                imageUrl={coolerImageUrl || null}
                headline={t('headline')}
                headlineAccent={t('headlineAccent')}
                hours={t('hours')}
                d={d}
              />
            </div>

            {/* THE DOOR — rotates 0 → -120deg on its left hinge. Two faces
                with backface-visibility hidden so the front never shows
                mirrored past 90°. */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transformOrigin: 'left center',
                transform: 'rotateY(calc(var(--scroll-progress, 0) * -120deg))',
                transformStyle: 'preserve-3d',
                transition: 'transform 80ms linear',
                zIndex: 3,
                boxShadow: 'calc(var(--scroll-progress, 0) * 30px) 0 60px rgba(0,0,0,0.6)',
              } as CSSProperties}
            >
              {/* Front face — the blueprint drawing */}
              <div style={{
                position: 'absolute', inset: 0,
                backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
              }}>
                <BlueprintCoolerDoor accent={ACCENT} d={d} />
              </div>
              {/* Inner face — same blueprint sheet, pre-rotated 180°. */}
              <div aria-hidden="true" style={{
                position: 'absolute', inset: 0,
                transform: 'rotateY(180deg)',
                backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
                background: '#06392F',
                overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', inset: 0,
                  backgroundImage: `
                    linear-gradient(rgba(237,230,211,0.06) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(237,230,211,0.06) 1px, transparent 1px),
                    linear-gradient(rgba(237,230,211,0.10) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(237,230,211,0.10) 1px, transparent 1px)
                  `,
                  backgroundSize: '40px 40px, 40px 40px, 200px 200px, 200px 200px',
                }} />
                <BlueprintDoorInside d={d} />
              </div>
            </div>

            {/* DIGITAL THERMOMETER — mounted above the door frame. */}
            <div aria-hidden="true" style={{
              position: 'absolute',
              top: '-86px', left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: '10px',
              zIndex: 5,
            }}>
              <div style={{
                background: 'linear-gradient(180deg, #1f2326 0%, #0d0f10 100%)',
                borderRadius: '4px',
                padding: '6px 10px',
                boxShadow: '0 3px 8px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.08)',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}>
                <span style={{
                  fontFamily: 'monospace',
                  fontSize: '0.62rem',
                  color: '#7a8489',
                  letterSpacing: '0.18em',
                }}>{t('unitCode')}</span>
                <span style={{
                  background: '#050708',
                  padding: '2px 6px',
                  borderRadius: '2px',
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  fontSize: '0.92rem',
                  color: '#3fda86',
                  textShadow: '0 0 6px rgba(63,218,134,0.65)',
                  letterSpacing: '0.04em',
                }}>{t('temperature')}</span>
              </div>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#3fda86',
                boxShadow: '0 0 8px rgba(63,218,134,0.8)',
              }} />
            </div>

            {/* FRAME — slim stainless ring around the doorway. */}
            <div aria-hidden="true" style={{
              position: 'absolute',
              inset: '-12px',
              border: '12px solid transparent',
              borderImage: 'linear-gradient(135deg, #e5ebee 0%, #989fa4 25%, #6a7077 50%, #989fa4 75%, #e5ebee 100%) 1',
              borderRadius: '4px',
              boxShadow: '0 28px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.18), 0 0 0 1px rgba(0,0,0,0.25)',
              pointerEvents: 'none',
              zIndex: 4,
            }}>
              {[['6px', '6px'], ['6px', 'auto', '6px', 'auto'], [null, '6px', '6px', 'auto'], [null, 'auto', '6px', '6px']].map((coords, i) => {
                const [top, right, bottom, left] = coords as Array<string | null | undefined>
                return (
                  <div key={i} style={{
                    position: 'absolute',
                    top: top ?? undefined,
                    right: right ?? undefined,
                    bottom: bottom ?? undefined,
                    left: left ?? undefined,
                    width: 8, height: 8,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 30% 30%, #e5ebee 0%, #898f94 60%, #2a2e30 100%)',
                    boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.4)',
                  }} />
                )
              })}
            </div>
          </div>

          {/* Reveal layer — once the door is mostly open the tagline and the
              Reserve / Menu buttons fade in inside the cooler. */}
          <div
            style={{
              position: 'absolute',
              top: '48%', left: 0, right: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: '0.9rem',
              opacity: 'calc(max(0, var(--scroll-progress, 0) - 0.65) * 3)',
              transform: 'translateY(calc((1 - var(--scroll-progress, 0)) * 20px))',
              transition: 'opacity 100ms linear',
              zIndex: 10,
              pointerEvents: 'auto',
            } as CSSProperties}
          >
            {t('tagline') && (
              <p
                className="display-italic"
                style={{
                  fontSize: 'clamp(1.5rem, 3vw, 2.2rem)',
                  color: ACCENT,
                }}
              >
                {t('tagline')}
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.7rem', justifyContent: 'center' }}>
              {reserve.text && (
                <Link href={safeHref(reserve.href)} className="brand-pill">
                  {simmerText(reserve.text)}
                </Link>
              )}
              {menu.text && (
                <Link href={safeHref(menu.href)} className="brand-pill-outline" style={{ borderColor: CREAM, color: CREAM }}>
                  {simmerText(menu.text)}
                </Link>
              )}
            </div>
          </div>

          {/* Bottom annotation row — engineering-drawing footer. */}
          <div style={{
            position: 'absolute',
            bottom: '3vh', left: '4vw', right: '4vw',
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            color: 'rgba(237,230,211,0.55)',
            fontFamily: 'var(--font-display)',
            fontSize: '0.6rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            zIndex: 6,
            pointerEvents: 'none',
          }}>
            <span>{t('footLeft')}</span>
            <span style={{ opacity: 'calc(1 - var(--scroll-progress, 0) * 2)' } as CSSProperties}>
              {t('footCentre')}
            </span>
            <span>{t('footRight')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── The door's INSIDE face ─────────────────────────────────────────
// Plain insulated panel, gasket, and the interior safety release. Same
// 600×880 viewbox as the front so the faces align.
function BlueprintDoorInside({ d }: { d: Drawing }) {
  const line  = 'rgba(237,230,211,0.85)'
  const fine  = 'rgba(237,230,211,0.45)'
  const label = '#EDE6D3'
  return (
    <svg
      viewBox="0 0 600 880"
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      <rect x="40" y="40" width="520" height="800" fill="rgba(237,230,211,0.03)" stroke={line} strokeWidth="1.5" />
      <rect x="62" y="62" width="476" height="756" fill="none" stroke={fine} strokeWidth="1" strokeDasharray="6 4" rx="3" />
      <rect x="86" y="86" width="428" height="708" fill="none" stroke={fine} strokeWidth="0.7" strokeDasharray="2 3" />
      <circle cx="120" cy="446" r="22" fill="none" stroke={line} strokeWidth="1.5" />
      <circle cx="120" cy="446" r="9"  fill="rgba(237,230,211,0.10)" stroke={line} strokeWidth="1" />
      <line x1="142" y1="446" x2="200" y2="446" stroke={fine} strokeWidth="0.8" />
      <text x="206" y="442" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
        {d.release}
      </text>
      <text x="206" y="454" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
        {d.releaseNote}
      </text>
    </svg>
  )
}

// ─── Blueprint cooler door (front face) ─────────────────────────────
// Clean architectural schematic: thin cream strokes on ink, every part
// labelled with a callout line + dimension annotations.
function BlueprintCoolerDoor({ accent, d }: { accent: string; d: Drawing }) {
  const line   = 'rgba(237,230,211,0.85)'
  const fine   = 'rgba(237,230,211,0.45)'
  const dim    = 'rgba(237,230,211,0.35)'
  const label  = '#EDE6D3'
  return (
    <svg
      viewBox="0 0 600 880"
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      {/* DOOR PANEL */}
      <rect x="40" y="40" width="520" height="800" fill="rgba(237,230,211,0.04)" stroke={line} strokeWidth="2" rx="4" />
      <rect x="56" y="56" width="488" height="768" fill="none" stroke={line} strokeWidth="1.2" rx="3" />
      {([[60, 60], [528, 60], [60, 808], [528, 808]] as Array<[number, number]>).map(([x, y], i) => (
        <g key={i} stroke={fine} strokeWidth="0.7">
          <line x1={x} y1={y} x2={x + 12} y2={y + 12} />
          <line x1={x + 4} y1={y} x2={x + 12} y2={y + 8} />
          <line x1={x} y1={y + 4} x2={x + 8} y2={y + 12} />
        </g>
      ))}

      {/* HINGES — three on the left edge */}
      {[150, 440, 690].map((y, i) => (
        <g key={i}>
          <rect x="24" y={y} width="40" height="56" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="2" />
          <circle cx="44" cy={y + 16} r="6" fill="none" stroke={line} strokeWidth="1.2" />
          <circle cx="44" cy={y + 40} r="6" fill="none" stroke={line} strokeWidth="1.2" />
          <line x1="44" y1={y + 4} x2="44" y2={y + 52} stroke={fine} strokeWidth="0.7" strokeDasharray="2 2" />
          {i === 0 && (
            <>
              <line x1="22" y1={y + 28} x2="-30" y2={y + 28} stroke={fine} strokeWidth="0.7" />
              <text x="-34" y={y + 26} fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" textAnchor="end">
                {d.hinge}
              </text>
              <text x="-34" y={y + 38} fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2" textAnchor="end">
                {d.hingeNote}
              </text>
            </>
          )}
        </g>
      ))}

      {/* VIEWING WINDOW */}
      <g>
        <rect x="140" y="160" width="320" height="160" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.6" rx="3" />
        <rect x="150" y="170" width="300" height="140" fill="none" stroke={fine} strokeWidth="1" rx="2" strokeDasharray="3 2" />
        <line x1="160" y1="180" x2="190" y2="180" stroke={fine} strokeWidth="0.7" />
        <line x1="160" y1="180" x2="160" y2="210" stroke={fine} strokeWidth="0.7" />
        <line x1="460" y1="240" x2="540" y2="240" stroke={fine} strokeWidth="0.7" />
        <text x="546" y="238" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          {d.pane}
        </text>
        <text x="546" y="250" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          {d.paneNote}
        </text>
      </g>

      {/* PADDLE HANDLE */}
      <g>
        <rect x="320" y="430" width="220" height="80" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="3" />
        <rect x="336" y="454" width="188" height="28" rx="14" fill="rgba(237,230,211,0.10)" stroke={accent} strokeWidth="1.6" />
        <circle cx="358" cy="468" r="6" fill={accent} />
        <circle cx="358" cy="468" r="3" fill="#06392F" />
        <rect x="436" y="490" width="40" height="14" fill="none" stroke={fine} strokeWidth="1" rx="2" />
        <circle cx="456" cy="497" r="2.5" fill={fine} />
        <line x1="540" y1="468" x2="600" y2="468" stroke={fine} strokeWidth="0.7" />
        <text x="-540" y="466" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" transform="scale(-1,1)">
          {d.handle}
        </text>
      </g>

      {/* MANUFACTURER PLATE */}
      <g>
        <rect x="80" y="80" width="180" height="46" fill="rgba(237,230,211,0.04)" stroke={line} strokeWidth="1" rx="2" />
        <text x="90" y="98" fill={label} fontFamily="var(--font-display)" fontSize="9" letterSpacing="3.2" fontWeight="700">
          {d.plateTitle}
        </text>
        <text x="90" y="114" fill={fine} fontFamily="var(--font-display)" fontSize="8" letterSpacing="2.5">
          {d.plateModel}
        </text>
        <text x="90" y="124" fill={fine} fontFamily="var(--font-display)" fontSize="7" letterSpacing="2.5">
          {d.plateBuilt}
        </text>
      </g>

      {/* KICK PLATE */}
      <g>
        <rect x="80" y="720" width="440" height="100" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="2" />
        {[745, 760, 775, 790, 805].map((y) => (
          <line key={y} x1="100" y1={y} x2="500" y2={y} stroke={fine} strokeWidth="0.5" strokeDasharray="2 4" />
        ))}
        {[[95, 735], [505, 735], [95, 805], [505, 805]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="none" stroke={line} strokeWidth="0.9" />
        ))}
        <line x1="520" y1="770" x2="580" y2="770" stroke={fine} strokeWidth="0.7" />
        <text x="586" y="768" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          {d.kick}
        </text>
        <text x="586" y="780" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          {d.kickNote}
        </text>
      </g>

      {/* DIMENSION LINES */}
      <g stroke={dim} strokeWidth="0.7" fontFamily="var(--font-display)">
        <line x1="-18" y1="40" x2="-18" y2="840" />
        <line x1="-22" y1="40" x2="-14" y2="40" />
        <line x1="-22" y1="840" x2="-14" y2="840" />
        <text x="-30" y="446" fill={label} fontSize="11" letterSpacing="2" textAnchor="middle" transform="rotate(-90, -30, 446)">
          {d.height}
        </text>
        <line x1="40" y1="858" x2="560" y2="858" />
        <line x1="40" y1="854" x2="40" y2="862" />
        <line x1="560" y1="854" x2="560" y2="862" />
        <text x="300" y="876" fill={label} fontSize="11" letterSpacing="2" textAnchor="middle">
          {d.width}
        </text>
      </g>
    </svg>
  )
}

// ─── CoolerInterior ─────────────────────────────────────────────────
// Behind the door. The owner's cooler photo (field `coolerImage`) with a
// cool-tone wash, else the blueprint interior drawing. The headline and the
// hours sticker fade in over it as the door opens.
function CoolerInterior({ accent, cream, imageUrl, headline, headlineAccent, hours, d }: {
  accent: string
  cream: string
  imageUrl: string | null
  headline: string
  headlineAccent: string
  hours: string
  d: Drawing
}) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {imageUrl ? (
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url("${imageUrl.replace(/["\\]/g, '')}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: 'brightness(0.72) saturate(0.85) contrast(1.05) hue-rotate(-6deg)',
            }}
          />
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `
                radial-gradient(ellipse 75% 55% at 50% 40%, transparent 0%, transparent 40%, rgba(0,0,0,0.55) 100%),
                linear-gradient(180deg, rgba(0,0,0,0.20) 0%, transparent 25%, transparent 75%, rgba(0,0,0,0.45) 100%)
              `,
            }}
          />
        </>
      ) : (
        <CoolerInteriorSVG d={d} />
      )}

      {/* HEADLINE — "RESERVATIONS only." as one phrase */}
      {(headline || headlineAccent) && (
        <div
          style={{
            position: 'absolute',
            top: '38%', left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-display)',
            lineHeight: 1,
            opacity: 'calc(max(0, var(--scroll-progress, 0) - 0.50) * 6)',
            transition: 'opacity 80ms linear',
            zIndex: 2,
          } as CSSProperties}
        >
          <span style={{
            color: cream,
            fontSize: 'clamp(2rem, 4.8vw, 3.6rem)',
            letterSpacing: '0.06em',
            fontWeight: 800,
            textShadow: '0 2px 4px rgba(0,0,0,0.85), 0 6px 16px rgba(0,0,0,0.65)',
          }}>
            {headline}
          </span>
          {headlineAccent && (
            <span style={{
              color: accent,
              fontSize: 'clamp(1.7rem, 4.2vw, 3rem)',
              fontStyle: 'italic',
              letterSpacing: '-0.01em',
              fontWeight: 500,
              marginLeft: headline ? '0.32em' : 0,
            }}>
              {headlineAccent}
            </span>
          )}
        </div>
      )}

      {/* Operating hours — etched along the cooler floor like a vinyl
          sticker, clear of the Reserve / Menu buttons. Bone at 55% (was
          white at 55%: the SKILL.md allows no white). */}
      {hours && (
        <FridgeWord
          text={hours}
          fireAt={0.78}
          color="rgba(237,230,211,0.55)"
          heavyShadow
          style={{
            bottom: '4%', left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 'clamp(0.65rem, 1.2vw, 0.85rem)',
            letterSpacing: '0.42em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            fontWeight: 700,
          }}
        />
      )}
    </div>
  )
}

// Staggered fade-in for a word on the cooler wall.
function FridgeWord({ text, fireAt, color, heavyShadow, style }: {
  text: string
  fireAt: number
  color: string
  heavyShadow?: boolean
  style?: CSSProperties
}) {
  const shadow = heavyShadow
    ? '0 2px 4px rgba(0,0,0,0.85), 0 6px 16px rgba(0,0,0,0.65)'
    : '0 1px 2px rgba(0,0,0,0.6)'
  return (
    <p
      className="display"
      style={{
        position: 'absolute',
        margin: 0,
        color,
        textShadow: shadow,
        opacity: `calc(max(0, var(--scroll-progress, 0) - ${fireAt}) * 6)`,
        ['--lift' as string]: `calc((1 - max(0, min(1, (var(--scroll-progress, 0) - ${fireAt}) * 6))) * 14px)`,
        transition: 'opacity 80ms linear',
        ...style,
      } as CSSProperties}
    >
      <span style={{ display: 'inline-block', transform: 'translateY(var(--lift, 0))' }}>
        {text}
      </span>
    </p>
  )
}

// ─── Blueprint cooler interior ──────────────────────────────────────
// The "view inside the cooler" as an architectural drawing: back wall, side
// walls receding to a vanishing point, two wire racks, ceiling evaporator,
// LED strip, floor dimension.
function CoolerInteriorSVG({ d }: { d: Drawing }) {
  const line  = 'rgba(237,230,211,0.85)'
  const fine  = 'rgba(237,230,211,0.42)'
  const dim   = 'rgba(237,230,211,0.28)'
  const label = '#EDE6D3'
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      <g stroke={dim} strokeWidth="0.6" strokeDasharray="3 4">
        <line x1="0"    y1="0"    x2="800" y2="460" />
        <line x1="1600" y1="0"    x2="800" y2="460" />
        <line x1="0"    y1="1000" x2="800" y2="460" />
        <line x1="1600" y1="1000" x2="800" y2="460" />
      </g>
      <g stroke={fine} strokeWidth="0.8">
        <line x1="788" y1="460" x2="812" y2="460" />
        <line x1="800" y1="448" x2="800" y2="472" />
      </g>
      <text x="816" y="456" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">VP</text>

      <polygon points="0,0 1600,0 1080,240 520,240" fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="0,0 520,240 520,680 0,1000" fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="1600,0 1600,1000 1080,680 1080,240" fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="0,1000 1600,1000 1080,680 520,680" fill="none" stroke={line} strokeWidth="1.6" />
      <rect x="520" y="240" width="560" height="440" fill="rgba(237,230,211,0.03)" stroke={line} strokeWidth="1.6" />
      <line x1="708" y1="240" x2="708" y2="680" stroke={fine} strokeWidth="0.8" />
      <line x1="892" y1="240" x2="892" y2="680" stroke={fine} strokeWidth="0.8" />

      {/* Ceiling evaporator */}
      <g transform="translate(800, 120)">
        <rect x="-160" y="-30" width="320" height="70" fill="rgba(237,230,211,0.04)" stroke={line} strokeWidth="1.4" rx="2" />
        <line x1="-140" y1="-36" x2="140" y2="-36" stroke={fine} strokeWidth="1" />
        {[-70, 70].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy="14" r="20" fill="none" stroke={line} strokeWidth="1.2" />
            <circle cx={cx} cy="14" r="4" fill={line} />
            {Array.from({ length: 4 }).map((_, i) => (
              <line key={i}
                x1={cx} y1="14"
                x2={cx + Math.cos((i * Math.PI) / 2) * 16}
                y2={14 + Math.sin((i * Math.PI) / 2) * 16}
                stroke={fine} strokeWidth="0.8" />
            ))}
          </g>
        ))}
        <line x1="170" y1="0" x2="240" y2="0" stroke={fine} strokeWidth="0.7" />
        <text x="246" y="-2" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          {d.evap}
        </text>
        <text x="246" y="10" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          {d.evapNote}
        </text>
      </g>

      {/* LED ceiling strip */}
      <line x1="600" y1="50" x2="1000" y2="50" stroke={line} strokeWidth="3" strokeLinecap="round" />
      <line x1="540" y1="200" x2="600" y2="50" stroke={fine} strokeWidth="0.7" />
      <text x="430" y="200" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
        {d.led}
      </text>

      <BlueprintRack side="left"  lineColor={line} fineColor={fine} labelColor={label} label={d.rack} note={d.rackNote} />
      <BlueprintRack side="right" lineColor={line} fineColor={fine} labelColor={label} label={d.rack} note={d.rackNote} />

      {/* Floor width dimension */}
      <g stroke={dim} strokeWidth="0.7">
        <line x1="40" y1="970" x2="1560" y2="970" />
        <line x1="40" y1="965" x2="40" y2="975" />
        <line x1="1560" y1="965" x2="1560" y2="975" />
      </g>
      <text x="800" y="990" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" textAnchor="middle">
        {d.floor}
      </text>

      {/* North arrow */}
      <g transform="translate(1500, 920)">
        <circle cx="0" cy="0" r="24" fill="none" stroke={fine} strokeWidth="0.8" />
        <line x1="0" y1="-22" x2="0" y2="22" stroke={fine} strokeWidth="0.6" />
        <line x1="-22" y1="0" x2="22" y2="0" stroke={fine} strokeWidth="0.6" />
        <polygon points="0,-22 -5,-8 5,-8" fill={label} />
        <text x="0" y="-30" fill={label} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2" textAnchor="middle">
          N
        </text>
      </g>
    </svg>
  )
}

// Wire-rack schematic — poles + four foreshortened shelves.
function BlueprintRack({ side, lineColor, fineColor, labelColor, label, note }: {
  side: 'left' | 'right'
  lineColor: string
  fineColor: string
  labelColor: string
  label: string
  note: string
}) {
  const isLeft = side === 'left'
  const fx1 = isLeft ? 70   : 1130
  const fx2 = isLeft ? 240  : 1300
  const bx1 = isLeft ? 470  : 1150
  const bx2 = isLeft ? 530  : 1090
  const shelves: Array<[number, number]> = [
    [200, 320],
    [400, 440],
    [600, 560],
    [820, 660],
  ]
  return (
    <g>
      <line x1={fx1} y1="80"  x2={fx1} y2="940" stroke={lineColor} strokeWidth="1.4" />
      <line x1={fx2} y1="120" x2={fx2} y2="900" stroke={lineColor} strokeWidth="1.4" />
      <line x1={bx1} y1="260" x2={bx1} y2="680" stroke={fineColor} strokeWidth="1.1" />
      <line x1={bx2} y1="270" x2={bx2} y2="670" stroke={fineColor} strokeWidth="1.1" />
      {[fx1, fx2].map((x) => (
        <line key={x} x1={x - 6} y1="945" x2={x + 6} y2="945" stroke={lineColor} strokeWidth="2" />
      ))}
      {shelves.map(([fy, by], i) => (
        <polygon
          key={i}
          points={`${fx1},${fy} ${fx2},${fy} ${bx2},${by} ${bx1},${by}`}
          fill="rgba(237,230,211,0.03)"
          stroke={lineColor}
          strokeWidth="1.2"
        />
      ))}
      {shelves.map(([fy, by], i) => (
        <g key={i} stroke={fineColor} strokeWidth="0.5">
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.25} x2={fx2 - 10} y2={fy + (by - fy) * 0.25} />
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.5}  x2={fx2 - 10} y2={fy + (by - fy) * 0.5} />
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.75} x2={fx2 - 10} y2={fy + (by - fy) * 0.75} />
        </g>
      ))}
      {isLeft && (
        <>
          <line x1="240" y1="200" x2="380" y2="160" stroke={fineColor} strokeWidth="0.7" />
          <text x="386" y="158" fill={labelColor} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
            {label}
          </text>
          <text x="386" y="170" fill={fineColor} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
            {note}
          </text>
        </>
      )}
    </g>
  )
}
