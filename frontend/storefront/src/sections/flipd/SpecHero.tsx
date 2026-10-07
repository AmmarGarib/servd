'use client'
// flipd.specHero — the build sheet. Ported from components/kinetic/FlipdSpecHero.tsx
// (read that file's header for why the hero is a build sheet and how the
// timings were tuned). The motion is code; every word, image and spec line is
// a field.
//
// Mechanics: one tall section with a pinned child. useScrollProgress writes
// --scroll-progress on the section and CSS does all the work off it, so
// scrolling never re-renders React. Each part carries its own --t (0 before it
// moves, 1 when seated) and the stage carries --fall and --hit for the drop.

import Link from 'next/link'
import { useScrollProgress } from '../../components/kinetic/motionHooks'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { safeHref, safeSrc, str, link, list } from '../safe'

interface PartField {
  no?: unknown; name?: unknown; spec?: unknown; image?: unknown
  width?: unknown; side?: unknown; flip?: unknown
}

/**
 * Per BUILD step (0 = the bottom part, built first): when the part starts to
 * fall, and how far above its slot it starts (× the drawing's width). Measured
 * against the real five-part stack — see FlipdSpecHero.tsx. Fewer parts use
 * the first N; the timeline after the build (drop, bounce, outro) is fixed.
 */
const FIRE = [0.040, 0.145, 0.250, 0.355, 0.460]
const DROP = [-0.75, -0.68, -0.61, -0.50, -0.34]

const seat = (fire: number, rate = 6) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${fire}) * ${rate}))`

const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${seat(up, upRate)} - ${seat(down, downRate)})`

const hump = (from: number, to: number) => {
  const r = `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${(1 / (to - from)).toFixed(3)}))`
  return `(4 * ${r} * (1 - ${r}))`
}

// The register marks struck at the moment of impact, as angles off the vertical.
const TICKS = [-64, -38, -14, 14, 38, 64]

function clampWidth(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(1, Math.max(0.1, n)) : 1
}

export function FlipdSpecHeroSection({ fields, ctx }: SectionProps) {
  const { ref, past } = useScrollProgress<HTMLElement>({ liveAt: 0.92 })

  const brandName = formatBrandName(ctx.concept?.name ?? 'flipd')
  const mark = str(fields.mark).trim() || brandName
  const ariaLabel = str(fields.ariaLabel).trim() || `${brandName} — how it is built`
  const primary = link(fields.primary)
  const secondary = link(fields.secondary)

  const raw = list<PartField>(fields.parts).slice(0, FIRE.length)
  const n = raw.length
  const parts = raw.map((p, i) => {
    const build = n - 1 - i   // laid out crown-first, built heel-first
    return {
      no: str(p.no),
      name: str(p.name),
      spec: str(p.spec),
      src: safeSrc(p.image),
      w: clampWidth(p.width),
      side: p.side === 'right' ? 'right' : 'left',
      flip: p.flip === true,
      fire: FIRE[build]!,
      drop: DROP[build]!,
    }
  })
  const buildOrder = [...parts].reverse()

  const fall = seat(0.76, 15)
  const b1 = hump(0.8267, 0.868)
  const b2 = hump(0.868, 0.898)
  const b3 = hump(0.898, 0.918)
  const bounce = `calc(${b1} * 0.38 + ${b2} * 0.15 + ${b3} * 0.055)`
  const stretch = `calc(${b1} * 0.55 + ${b2} * 0.3 + ${b3} * 0.12)`
  const squash = `calc(${pulse(0.820, 150, 0.8267, 26)} + ${pulse(0.8635, 220, 0.868, 40)} * 0.45 + ${pulse(0.8955, 400, 0.898, 70)} * 0.18)`
  const hit = pulse(0.820, 150, 0.8267, 26)
  const built = seat(0.92, 12.5)
  const markGone = seat(0.02, 16)

  return (
    <div className="flipd-page">
      <section ref={ref} className="flipd-spec" aria-label={ariaLabel}>
        <div className="flipd-spec-pin">

          <div className="flipd-spec-title">
            <span className="flipd-spec-titleno">{str(fields.titleLeft)}</span>
            <span className="flipd-spec-titlerule" aria-hidden />
            <span className="flipd-spec-titleno">{str(fields.titleRight)}</span>
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
              {parts.map((part, i) => (
                <div
                  key={`${part.no}-${i}`}
                  className={`flipd-spec-part flipd-spec-part--${part.side}`}
                  style={{
                    ['--t' as string]: seat(part.fire),
                    ['--w' as string]: `${(part.w * 100).toFixed(1)}%`,
                    ['--drop' as string]: part.drop,
                    // Upper layers paint over lower ones.
                    zIndex: parts.length - i,
                  }}
                >
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
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {part.src && <img src={part.src} alt="" aria-hidden="true" />}
                  </div>
                </div>
              ))}

              <p className="flipd-spec-mark" style={{ ['--t' as string]: markGone }}>
                {mark}
              </p>
            </div>

            <div className="flipd-spec-datum" style={{ ['--hit' as string]: hit }} aria-hidden>
              <span className="flipd-spec-datumrule" />
              {TICKS.map((a) => (
                <span key={a} className="flipd-spec-tick" style={{ ['--a' as string]: `${a}deg` }} />
              ))}
            </div>
          </div>

          {/* Hidden outright until the burger lands, not merely transparent. */}
          <div
            className="flipd-spec-outro"
            style={{ ['--t' as string]: built, visibility: past ? 'visible' : 'hidden' }}
          >
            {str(fields.tagline) && <p className="flipd-spec-tagline">{str(fields.tagline)}</p>}
            {(primary.text || secondary.text) && (
              <div className="flipd-spec-cta">
                {primary.text && <Link href={safeHref(primary.href)} className="flipd-btn">{primary.text}</Link>}
                {secondary.text && <Link href={safeHref(secondary.href)} className="flipd-btn flipd-btn-ghost">{secondary.text}</Link>}
              </div>
            )}
          </div>

          {str(fields.hint) && (
            <span className="flipd-spec-hint" style={{ ['--t' as string]: seat(0.02, 10) }} aria-hidden>
              {str(fields.hint)}
            </span>
          )}
        </div>
      </section>

      {/* The written build: the accessible copy of the diagram (the callouts
          are aria-hidden), and the visible one on a phone. Desktop hides it. */}
      <ol className="flipd-spec-list">
        {buildOrder.map((p, i) => (
          <li key={`${p.no}-${i}`}>
            <span className="flipd-spec-no">{p.no}</span>
            <span className="flipd-spec-name">{p.name}</span>
            <span className="flipd-spec-sub">{p.spec}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
