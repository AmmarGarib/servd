'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'
import { formatBrandName } from '../lib/concept'
import type { DayPart } from '../lib/world/clock'
import type { KitchenSlug } from '../lib/world/kitchenCore'
import { useKitchens } from '../lib/world/kitchens'
import { useWorld } from '../lib/world/useWorld'
import { kitchenLine } from '../lib/world/voice'
import { emitCrowd } from './characters/crowdBus'
import type { CharacterKind } from './characters/types'
import { CrowdCameo, type CameoNightPose, type CameoPose } from './world/cast/CrowdCameo'
import { FooterWave, crestY } from './party/footer/FooterWave'
import s from './party/footer/footer.module.css'

// Live brands only — the long historical list (Strata, Craveman, Garnish
// Station, Stackd@Padel) lived in the footer when they had no concept rows,
// promising the customer kitchens they couldn't actually order from. Pulled
// down to match the live state on the home page. Add back when their
// concept rows + microsites land.
// Accents match the canonical per-brand palette (lib/concept BRAND_ACCENT_OVERRIDES).
// "simmer" and "stackd" are lowercase per their brand rules (formatBrandName).
const BRANDS = [
  { slug: 'stackd', name: formatBrandName('stackd'), accent: '#FCE8CE' },
  { slug: 'simmer', name: formatBrandName('simmer'), accent: '#E94E1B' },
  { slug: 'flipd',  name: formatBrandName('Flipd'),  accent: '#2092E9' },
]

/** Where "right now" sends you for each kitchen. */
const NOW_HREF: Record<KitchenSlug, string> = {
  stackd: '/stackd',
  simmer: '/brand/simmer',
  flipd: '/flipd',
}

/* ── The closing shift ───────────────────────────────────────────────────
   Six of the cast sit on the footer's lip with their legs over the edge.
   By day they wave or idle; after dark (html[data-world-dark='1'], pure CSS
   via nightPose) they doze and the coffee keeps a lantern lit. Phones keep
   the first three. Tap or hover one and it hops and says something. */
interface Mate {
  kind: CharacterKind
  name: string
  /** % across, desktop / phone. */
  x: number
  xm: number
  pose: CameoPose
  night: CameoNightPose
  look: 'center' | 'left' | 'right' | 'down'
  tilt: number
  extra?: boolean
}

const CREW: Mate[] = [
  { kind: 'fries', name: 'the fries', x: 8, xm: 16, pose: 'wave', night: 'sleep', look: 'right', tilt: -3 },
  { kind: 'coffee', name: 'the coffee', x: 25, xm: 50, pose: 'sip', night: 'point', look: 'down', tilt: 2 },
  { kind: 'burger', name: 'the burger', x: 43, xm: 83, pose: 'idle', night: 'sleep', look: 'left', tilt: -2 },
  { kind: 'croissant', name: 'the croissant', x: 61, xm: 0, pose: 'wave', night: 'sleep', look: 'center', tilt: 3, extra: true },
  { kind: 'shake', name: 'the shake', x: 78, xm: 0, pose: 'idle', night: 'sleep', look: 'left', tilt: -3, extra: true },
  { kind: 'sandwich', name: 'the sandwich', x: 93, xm: 0, pose: 'idle', night: 'sleep', look: 'left', tilt: 2, extra: true },
]

function crewLines(dayPart: DayPart, grillOpen: boolean): string[] {
  const grill = grillOpen ? "grill's still hot" : "grill's off till noon"
  switch (dayPart) {
    case 'morning': return ['first coffee is on', 'croissants are out', 'see you at lunch', 'morning, you']
    case 'lunch': return ["grill's hot", 'lunch rush, hold on', 'fries are fresh', 'go on, order something']
    case 'afternoon': return ['slow afternoon', 'shake o’clock', 'see you at dinner', 'just resting my legs']
    case 'dinner': return [grill, 'dinner rush', 'one more order?', 'busy night, hi']
    case 'late': return [grill, 'last orders soon', 'closing up', 'see you at lunch']
    case 'night': return ['shh, kitchen is asleep', 'see you at lunch', 'five more minutes', grill]
  }
}

type Vars = CSSProperties & Record<`--${string}`, string | number>

interface StorefrontFooterProps {
  initialBrandSlug?: string | null
  /**
   * The background colour of whatever section sits directly above the
   * footer on THIS page, so the ledge along the top reads as that ground
   * running on under the crew rather than a mismatched shape. Defaults to the
   * party system's cream (`--servd-*` pages typically end on a cream
   * section — see home's Insiders strip and browse's grid). Pass this when
   * a page's last section is a different colour (e.g. a legacy white
   * surface) instead of the wave staying hardcoded to one page's ground.
   */
  groundColor?: string
}

function ClosingShift({ crew }: { crew: boolean }) {
  const world = useWorld()
  const { bySlug } = useKitchens()
  const crewRef = useRef<HTMLDivElement>(null)
  const [hop, setHop] = useState<number | null>(null)
  const [bubble, setBubble] = useState<{ i: number; text: string } | null>(null)
  const taps = useRef(0)
  const timers = useRef<number[]>([])

  // Tell the buddy when the crew is on screen, so it can go "home".
  useEffect(() => {
    const el = crewRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let visible = false
    const io = new IntersectionObserver(
      ([entry]) => {
        const now = !!entry && entry.isIntersecting && entry.intersectionRatio >= 0.3
        if (now === visible) return
        visible = now
        emitCrowd({ type: 'stage', id: 'footer', visible: now })
      },
      { threshold: [0, 0.3, 0.6] },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (visible) emitCrowd({ type: 'stage', id: 'footer', visible: false })
    }
  }, [])

  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t) }, [])

  const poke = useCallback((i: number) => {
    if (hop === i) return
    const lines = crewLines(world.dayPart, !!bySlug.flipd?.open)
    const text = lines[(i + taps.current) % lines.length] ?? lines[0] ?? ''
    taps.current += 1
    for (const t of timers.current) window.clearTimeout(t)
    timers.current = [
      window.setTimeout(() => setHop((h) => (h === i ? null : h)), 720),
      window.setTimeout(() => setBubble((b) => (b?.i === i ? null : b)), 2600),
    ]
    setHop(i)
    setBubble({ i, text })
  }, [hop, world.dayPart, bySlug.flipd?.open])

  if (!crew) return <div ref={crewRef} aria-hidden="true" />
  return (
    <div className={s.crew} ref={crewRef}>
      {CREW.map((m, i) => {
        const hopping = hop === i
        const y = crestY(m.x)
        const ym = crestY(m.xm)
        const style: Vars = { '--x': `${m.x}%`, '--y': y.toFixed(2), '--xm': `${m.xm}%`, '--ym': ym.toFixed(2), '--tilt': `${m.tilt}deg` }
        return (
          <button
            key={m.kind}
            type="button"
            className={`${s.mate} ${m.extra ? s.extra : ''} ${hopping ? s.hopping : ''} ${m.x > 60 ? s.flip : ''} ${m.xm > 60 ? s.flipM : ''}`}
            style={style}
            aria-label={`say hi to ${m.name}`}
            onClick={() => poke(i)}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') poke(i) }}
          >
            {bubble?.i === i && <span className={s.bubble} aria-hidden="true">{bubble.text}</span>}
            <CrowdCameo
              kind={m.kind}
              size={64}
              // Poked: jolted awake mid-hop (drops the night pose for the hop).
              pose={hopping ? 'cheer' : m.pose}
              nightPose={hopping ? undefined : m.night}
              lantern={m.night === 'point'}
              look={m.look}
              delay={i * 410}
              className={s.mateCast}
            />
          </button>
        )
      })}
      <span className="sr-only" aria-live="polite">{bubble?.text ?? ''}</span>
    </div>
  )
}

function RightNow() {
  const world = useWorld()
  const { list } = useKitchens()
  return (
    <section className={s.now} aria-labelledby="footer-right-now">
      <h3 id="footer-right-now" className={s.columnLabel}>Right now</h3>
      <ul className={s.nowList}>
        {list.map((k) => (
          <li key={k.slug}>
            <Link href={NOW_HREF[k.slug]} className={s.nowRow}>
              <span aria-hidden className={s.pip} data-phase={k.phase} />
              <span className={s.nowName}>{formatBrandName(k.name)}</span>
              <span className={s.nowLine} suppressHydrationWarning>{kitchenLine(k, world.dayPart)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
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
  if (onBrandMicrosite || pathname.startsWith('/brand/')) return null
  // simmer never gets a character, including on its ordering pages.
  const crew = !/^\/simmer(\/|$)/.test(pathname)

  return (
    <footer
      className={s.footer}
      style={groundColor ? ({ ['--wave-color' as string]: groundColor } as CSSProperties) : undefined}
    >
      <div className={s.top}>
        <FooterWave />
        <ClosingShift crew={crew} />
      </div>

      <div className={s.inner}>

        {/* Headline lockup + what's cooking right now */}
        <div className={s.lockupRow}>
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
          <RightNow />
        </div>

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
            <ul className={s.linkList}>
              {BRANDS.map((b) => (
                <li key={b.slug}>
                  <Link href={`/brand/${b.slug}`} className={s.linkRow}>
                    <span aria-hidden className={s.dot} style={{ background: b.accent }} />
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
