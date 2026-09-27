'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'
import { formatBrandName } from '../lib/concept'
import { emitPlay, sfx, usePrefersReducedMotion, useQuiet } from '@/lib/play'
import { FooterWave } from './party/footer/FooterWave'
import { ClawMachine } from './party/footer/ClawMachine'
import s from './party/footer/footer.module.css'

// Live brands only — the long historical list (Strata, Craveman, Garnish
// Station, Stackd@Padel) lived in the footer when they had no concept rows,
// promising the customer kitchens they couldn't actually order from. Pulled
// down to match the live state on the home page. Add back when their
// concept rows + microsites land.
// Accents match the canonical per-brand palette (lib/concept BRAND_ACCENT_OVERRIDES).
// "simmer" and "stackd" are lowercase per their brand rules.
const BRANDS = [
  { slug: 'stackd', name: formatBrandName('stackd'), accent: '#FCE8CE' },
  { slug: 'simmer', name: formatBrandName('simmer'), accent: '#E94E1B' },
  { slug: 'flipd',  name: formatBrandName('Flipd'),  accent: '#2092E9' },
]

// Burst colours for a poked doodle: party butter and tomato.
const BURST = ['#FFD447', '#FF5A3C']
// classList needs real strings (an empty token throws).
const POKED = s['poked'] ?? 'poked'
const BURST_BIT = s['burstBit'] ?? 'burstBit'

interface StorefrontFooterProps {
  initialBrandSlug?: string | null
  /**
   * The background colour of whatever section sits directly above the
   * footer on THIS page, so the scalloped top edge reads as that ground
   * dipping onto the plum rather than a mismatched shape. Defaults to the
   * party system's cream (`--servd-*` pages typically end on a cream
   * section — see home's Insiders strip and browse's grid). Pass this when
   * a page's last section is a different colour (e.g. a legacy white
   * surface) instead of the wave staying hardcoded to one page's ground.
   */
  groundColor?: string
}

export function StorefrontFooter({ initialBrandSlug = null, groundColor }: StorefrontFooterProps) {
  // Brand microsites render their own BrandFooter (via BrandShell); the global
  // servd footer must hide there or those pages show two footers.
  //
  // The /brand/* path test alone was not enough. On a brand's OWN domain the
  // browser's path is "/", so every microsite page was ending with servd's
  // footer stacked under the brand's — 664px of it on desktop, carrying
  // servd's own CTA and named links to the two rival sibling brands, on
  // domains whose entire purpose is to read as an independent restaurant.
  // Both checks are kept: the path one covers servd.pk/brand/<slug>.
  const pathname = usePathname() ?? '/'
  const onBrandMicrosite = useOnBrandMicrosite(initialBrandSlug)
  const hidden = onBrandMicrosite || pathname.startsWith('/brand/')

  const quiet = useQuiet()
  const reduced = usePrefersReducedMotion()
  const footerRef = useRef<HTMLElement>(null)
  const kitchensRef = useRef<HTMLUListElement>(null)

  // Kitchen dots bounce in as the list enters the viewport, once per page.
  // They are only hidden ("armed") after mount and only if the list is still
  // below the fold, so no-JS, reduced motion and an already-visible list all
  // simply show the dots.
  const [dots, setDots] = useState<'idle' | 'armed' | 'in'>('idle')
  useEffect(() => {
    if (hidden || reduced) { setDots('idle'); return }
    const el = kitchensRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const r = el.getBoundingClientRect()
    if (r.top < window.innerHeight && r.bottom > 0) { setDots('idle'); return }
    setDots('armed')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setDots('in')
          io.disconnect()
        }
      },
      { threshold: 0.35 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hidden, reduced, pathname])

  // Poke a doodle: it spins and pops, with a small butter/tomato burst.
  // Inert on quiet routes. Decoration only, so it stays out of the a11y tree.
  const poke = useCallback((e: ReactPointerEvent<HTMLSpanElement>) => {
    if (quiet) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const hit = e.currentTarget
    sfx('pop')
    emitPlay({ type: 'poke', source: 'footer-doodle', x: e.clientX, y: e.clientY })
    hit.classList.remove(POKED)
    void hit.offsetWidth // restart the keyframes on a repeat poke
    hit.classList.add(POKED)
    if (reduced) return
    const footer = footerRef.current
    if (!footer) return
    const fr = footer.getBoundingClientRect()
    const ox = e.clientX - fr.left
    const oy = e.clientY - fr.top
    for (let i = 0; i < 8; i++) {
      const bit = document.createElement('span')
      bit.className = BURST_BIT
      bit.setAttribute('aria-hidden', 'true')
      bit.style.left = `${ox}px`
      bit.style.top = `${oy}px`
      bit.style.background = BURST[i % BURST.length]!
      footer.appendChild(bit)
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.5
      const d = 22 + Math.random() * 20
      if (typeof bit.animate !== 'function') { bit.remove(); continue }
      const anim = bit.animate(
        [
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
          { transform: `translate(calc(-50% + ${(Math.cos(a) * d).toFixed(1)}px), calc(-50% + ${(Math.sin(a) * d).toFixed(1)}px)) scale(0.2)`, opacity: 0 },
        ],
        { duration: 460, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
      anim.onfinish = () => bit.remove()
      anim.oncancel = () => bit.remove()
    }
  }, [quiet, reduced])

  if (hidden) return null

  return (
    <footer
      ref={footerRef}
      className={s.footer}
      style={groundColor ? ({ ['--wave-color' as string]: groundColor } as CSSProperties) : undefined}
    >
      <FooterWave />

      {/* Doodles: decoration you can poke. aria-hidden and never focusable. */}
      <span
        aria-hidden="true"
        className={`${s.doodleHit} ${s.hitStar}`}
        data-quiet={quiet ? 'true' : undefined}
        data-toy={quiet ? undefined : 'poke'}
        onPointerDown={poke}
      >
        <svg className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40" focusable="false">
          <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
        </svg>
      </span>
      <span
        aria-hidden="true"
        className={`${s.doodleHit} ${s.hitDot}`}
        data-quiet={quiet ? 'true' : undefined}
        data-toy={quiet ? undefined : 'poke'}
        onPointerDown={poke}
      >
        <svg className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20" focusable="false">
          <circle cx="10" cy="10" r="8" />
        </svg>
      </span>

      <div className={s.inner}>

        {/* Headline lockup */}
        <div className={s.lockup}>
          <p className={s.eyebrow}>One place for every kitchen</p>
          <h2 className={s.title}>
            Hungry now?<span className={s.titleItalic}> Let's go.</span>
          </h2>
          <Link href="/browse" className={s.cta}>
            Order now
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>

        {/* The claw machine: every page ends with one. Lazy, and hidden on
            quiet routes. */}
        <ClawMachine />

        {/* Link columns */}
        <div className={s.columns}>
          <div>
            <Link href="/" className={s.wordmark}>
              servd<span style={{ color: 'var(--party-butter)' }}>.</span>
            </Link>
            <p className={s.blurb}>
              Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.
            </p>
          </div>

          <div>
            <h3 className={s.columnLabel}>Kitchens</h3>
            <ul ref={kitchensRef} className={s.linkList} data-dots={dots}>
              {BRANDS.map((b, i) => (
                <li key={b.slug}>
                  <Link href={`/brand/${b.slug}`} className={s.linkRow}>
                    <span
                      aria-hidden
                      className={s.dot}
                      style={{ background: b.accent, ['--i' as string]: i } as CSSProperties}
                    />
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className={s.columnLabel}>Customer</h3>
            <ul className={s.linkList}>
              <li><Link href="/browse"  className={s.linkRow}>Browse all brands</Link></li>
              <li><Link href="/account" className={s.linkRow}>My account</Link></li>
              <li><Link href="/orders"  className={s.linkRow}>Order history</Link></li>
              <li><Link href="/login"   className={s.linkRow}>Sign in</Link></li>
            </ul>
          </div>

          <div>
            <h3 className={s.columnLabel}>Company</h3>
            <ul className={s.linkList}>
              <li><span className={s.staticRow}>GS Foods Pvt. Ltd.</span></li>
              <li><span className={s.staticRow}>Karachi · Pakistan</span></li>
              <li><a href="mailto:hello@servd.pk" className={s.linkRow}>hello@servd.pk</a></li>
            </ul>
          </div>
        </div>

        <div className={s.bottomBar}>
          <span>© {new Date().getFullYear()} GS Foods. All rights reserved.</span>
          <span>Made in Karachi. Cooked in Karachi. For Karachi.</span>
        </div>
      </div>
    </footer>
  )
}
