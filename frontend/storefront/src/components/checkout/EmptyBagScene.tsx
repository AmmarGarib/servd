'use client'
import { useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { voice } from '../../lib/voice'
import { Companion, companionKindFor } from '../characters/Companion'
import { finaleTheme, brandName, PILL_ACCENT } from './brandTheme'
import s from './emptyBag.module.css'

// The empty bag: a brand-themed full-viewport scene instead of a grey
// "your cart is empty" line. An open paper bag sits centre stage; the
// brand's sidekick leans over the rim and gasps into it. simmer has no
// character (brand bible): its bag is drawn in bone line on tiber with a
// single orange dot.
//
// Everything renders from the first byte (no API, no WebGL needed for the
// frame to read), and every entrance is a lean, never a fade from zero.

const KITCHENS = ['stackd', 'simmer', 'flipd'] as const
type Kitchen = (typeof KITCHENS)[number]

export function EmptyBagScene({ slug }: { slug?: string | null }) {
  const t = finaleTheme(slug)
  const v = voice(slug)
  const [accent, setAccent] = useState<string | null>(null)

  const kind = t.brand === 'simmer' ? null : companionKindFor(t.brand)
  const primaryHref = t.brand === 'servd' ? '/browse' : `/${t.brand}`
  const others = KITCHENS.filter((k) => k !== t.brand)

  const vars = {
    '--eb-bg': t.bg,
    '--eb-ink': t.ink,
    '--eb-mute': t.mute,
    '--eb-accent': accent ?? t.accent,
    '--eb-cta-bg': t.ctaBg,
    '--eb-cta-ink': t.ctaInk,
    '--eb-bag-fill': t.bagFill,
    '--eb-bag-line': t.bagLine,
    '--eb-display': t.display,
    '--eb-body': t.body,
  } as CSSProperties

  const hover = (k: Kitchen | null) => () => setAccent(k ? PILL_ACCENT[k] : null)

  return (
    <main className={s.scene} data-brand={t.brand} style={vars}>
      <div className={s.inner}>
        <div className={s.stage} aria-hidden="true">
          <span className={s.disc} />
          <div className={s.bag}>
            <BagBack brand={t.brand} />
            {kind && (
              <div className={s.peek}>
                <Companion kind={kind} placement="inline" mood="gasp" size={128} />
              </div>
            )}
            <BagFront brand={t.brand} />
          </div>
          <span className={s.shadow} />
        </div>

        <div className={s.copy}>
          <p className={s.kicker}>
            <span className={s.kickerDot} />
            {t.name} &middot; checkout
          </p>
          <h1 className={s.title}>{v.emptyBag.title}</h1>
          <p className={s.body}>{v.emptyBag.body}</p>

          <Link href={primaryHref} className={s.cta}>
            <span>{v.emptyBag.cta}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>

          <nav className={s.others} aria-label="other kitchens">
            <p className={s.othersLabel}>or pick a different kitchen</p>
            <ul className={s.pills}>
              {others.map((k) => (
                <li key={k}>
                  <Link
                    href={`/${k}`}
                    className={s.pill}
                    style={{ '--pill-accent': PILL_ACCENT[k] } as CSSProperties}
                    onMouseEnter={hover(k)}
                    onMouseLeave={hover(null)}
                    onFocus={hover(k)}
                    onBlur={hover(null)}
                  >
                    <span className={s.pillDot} aria-hidden="true" />
                    {brandName(k)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </main>
  )
}

export default EmptyBagScene

// ── The bag, in two layers so the sidekick stands inside it ────────────────

function zigzag(x0: number, x1: number, yTop: number, yLow: number, step: number): string {
  let d = ''
  let hi = true
  for (let x = x0; x <= x1 + 0.01; x += step) {
    d += ` L${x.toFixed(1)} ${hi ? yTop : yLow}`
    hi = !hi
  }
  return d
}

function BagBack({ brand }: { brand: string }) {
  const line = brand === 'simmer'
  const d = `M44 104${zigzag(44, 176, 44, 53, 11)} L176 104 Z`
  return (
    <svg className={s.bagSvg} viewBox="0 0 220 240" fill="none" aria-hidden="true">
      <path d={d} fill={line ? 'none' : 'var(--eb-bag-fill)'} stroke="var(--eb-bag-line)" strokeWidth="3" strokeLinejoin="round" />
      {!line && <path d={d} fill="var(--eb-bag-line)" opacity="0.16" />}
    </svg>
  )
}

function BagFront({ brand }: { brand: string }) {
  const line = brand === 'simmer'
  const body = 'M30 100 H190 L181 224 Q180.5 232 172 232 H48 Q39.5 232 39 224 Z'
  return (
    <svg className={s.bagSvg} viewBox="0 0 220 240" fill="none" aria-hidden="true">
      <path d={body} fill={line ? 'var(--eb-bg)' : 'var(--eb-bag-fill)'} stroke="var(--eb-bag-line)" strokeWidth="3" strokeLinejoin="round" />
      {/* folded lip */}
      <path d="M30 100 H190 L189 116 H31 Z" fill={line ? 'none' : 'var(--eb-bag-line)'} opacity={line ? 1 : 0.14}
        stroke={line ? 'var(--eb-bag-line)' : 'none'} strokeWidth="1.5" />
      {/* gusset creases */}
      <path d="M58 116 L64 224 M162 116 L156 224" stroke="var(--eb-bag-line)" strokeWidth="1.5" strokeLinecap="round" opacity="0.35" />

      {brand === 'servd' && (
        <g>
          <circle cx="110" cy="170" r="24" fill="var(--eb-cta-bg)" />
          <text x="110" y="177" textAnchor="middle" fontSize="20" fontWeight="800"
            fill="var(--eb-cta-ink)" style={{ fontFamily: 'var(--eb-display)' }}>s.</text>
        </g>
      )}
      {brand === 'stackd' && (
        <g transform="rotate(-6 110 168)">
          <rect x="68" y="150" width="84" height="36" rx="18" fill="#9BD3DD" stroke="#3D1122" strokeWidth="2" />
          <text x="110" y="174" textAnchor="middle" fontSize="16" fontWeight="700"
            fill="#7C2946" style={{ fontFamily: 'var(--eb-display)' }}>stackd</text>
        </g>
      )}
      {brand === 'flipd' && (
        <g>
          {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x={41 + i * 11.5} y={i % 2 === 0 ? 136 : 147} width="11.5" height="11" fill="#294375" />
          ))}
          <text x="110" y="196" textAnchor="middle" fontSize="20"
            fill="#294375" style={{ fontFamily: 'var(--eb-display)' }}>Flipd</text>
        </g>
      )}
      {brand === 'simmer' && (
        /* the one orange signal on the page */
        <circle cx="110" cy="170" r="5" fill="#E94E1B" />
      )}
    </svg>
  )
}
