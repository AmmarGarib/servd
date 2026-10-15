'use client'

// servd.insiders — the Insiders section (anchor #insiders): a lanyard
// "All-access pass" beside the pitch, and a tilted perk card per kitchen.
// Port of Hasham's InsidersPass (playful-arena/team-b) with CSS-only motion
// (no framer-motion); the game hooks, pass drag/throw, barcode scan and
// sound are dropped. The pass is decorative (aria-hidden): every fact on it
// is also in the text.

import Link from 'next/link'
import { useEffect, useId, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowRight, Coffee, Gem, MessageCircle, Trophy, type LucideIcon } from 'lucide-react'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import { filled, locationFor, locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { color, link, list, safeHref, str } from '../safe'
import v from './insiders.module.css'

const BARS = [2, 6, 9, 14, 17, 19, 24, 29, 31, 35, 40, 42, 47, 50, 55, 57, 61, 66, 68, 73, 77, 80, 84, 89, 91, 96, 99, 103, 108, 111, 115]
const KNOWN = ['simmer', 'stackd', 'flipd']
const TILTS = [-2, 1.5, -1]
const BRAND_ICON: Record<string, LucideIcon> = { simmer: Gem, stackd: Coffee, flipd: Trophy }
const ICONS: Record<string, LucideIcon> = { gem: Gem, coffee: Coffee, trophy: Trophy }

interface PerkField {
  brand?: unknown; icon?: unknown; tag?: unknown; head?: unknown; body?: unknown
  badge?: unknown; stamps?: unknown; stampsFreeText?: unknown
}

/** Undefined → fallback; an explicit '' stays '' (hides the element). */
function strOr(val: unknown, fallback: string): string {
  return typeof val === 'string' ? val : fallback
}

/** Split on newlines; with 2+ lines the last one is the italic accent. */
function twoLine(text: string): ReactNode {
  const parts = text.split('\n').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return parts[0] ?? ''
  const last = parts[parts.length - 1]
  return (
    <>
      {parts.slice(0, -1).map((p, i) => <span key={i}>{p}<br /></span>)}
      <em>{last}</em>
    </>
  )
}

function Pass({ f, kitchens }: { f: { brand: string; tier: string; title: string; foot: string }; kitchens: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const calm = useRef(false)
  const patternId = `strap-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => { calm.current = mq.matches }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (calm.current || e.pointerType !== 'mouse') return
    const el = ref.current
    const r = el?.getBoundingClientRect()
    if (!el || !r || !r.width || !r.height) return
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    el.style.setProperty('--ry', `${(px - 0.5) * 32}deg`)
    el.style.setProperty('--rx', `${(0.5 - py) * 24}deg`)
    el.style.setProperty('--shine', `${px * 100}%`)
  }
  function onLeave() {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--ry', '0deg')
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--shine', '50%')
  }

  return (
    <div className={`${v.lanyard} reveal-on-scroll`} aria-hidden="true">
      <div className={v.swing}>
        <svg className={v.strap} width="30" focusable="false" aria-hidden="true">
          <defs>
            <pattern id={patternId} patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">
              <rect width="10" height="20" fill="var(--servd-green)" />
              <rect x="10" width="10" height="20" fill="var(--servd-black)" />
            </pattern>
          </defs>
          <rect width="30" height="100%" fill={`url(#${patternId})`} />
          <line x1="1.25" x2="1.25" y1="0" y2="100%" stroke="var(--servd-hard-ink, #261038)" strokeWidth="2.5" />
          <line x1="28.75" x2="28.75" y1="0" y2="100%" stroke="var(--servd-hard-ink, #261038)" strokeWidth="2.5" />
        </svg>
        <div ref={ref} className={v.pass} onPointerMove={onMove} onPointerLeave={onLeave}>
          <span className={v.clip} />
          <div className={v.passTop}>
            {f.brand && <span className={v.passBrand}>{f.brand}<span>.</span></span>}
            {f.tier && <span className={v.passTier}>{f.tier}</span>}
          </div>
          {f.title && <p className={v.passTitle}>{twoLine(f.title)}</p>}
          {kitchens.length > 0 && (
            <ul className={v.passKitchens}>
              {kitchens.map((k) => <li key={k}>{k}</li>)}
            </ul>
          )}
          <div className={v.passFoot}>
            <svg viewBox="0 0 120 34" className={v.barcode} preserveAspectRatio="none" focusable="false">
              {BARS.map((bx, i) => <rect key={bx} x={bx} y="0" width={i % 3 === 0 ? 2.6 : 1.3} height="34" />)}
            </svg>
            {f.foot && <span>{f.foot}</span>}
          </div>
          <span className={v.holo} />
        </div>
      </div>
    </div>
  )
}

function PunchCard({ freeText }: { freeText: string }) {
  return (
    <div className={v.punch} role="img" aria-label={`Punch card: five stamps in, the next one is ${freeText}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={v.stamp} style={{ '--i': i } as CSSProperties} aria-hidden="true">
          <Coffee size={15} strokeWidth={2.6} />
        </span>
      ))}
      <span className={`${v.stamp} ${v.stampFree}`} aria-hidden="true">{freeText}</span>
    </div>
  )
}

export function Insiders({ fields, ctx }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const headId = useId()
  const eyebrow = strOr(fields.eyebrow, 'Insiders · free to join')
  const headline = str(fields.headline)
  const sub = str(fields.sub)
  const primary = link(fields.primaryCta)
  const secondary = link(fields.secondaryCta)
  const signIn = link(fields.signIn)
  const finePrint = strOr(fields.finePrint, 'free forever · cancel anytime')
  const showPass = fields.showPass !== false
  const bg = color(fields.bg)
  const rawPerks = list<PerkField>(fields.perks)

  // Same WhatsApp rule as before: explicit link, else the chosen brand's number.
  let waHref = ''
  let waExternal = false
  if (secondary.text) {
    if (secondary.href.trim()) {
      waHref = safeHref(secondary.href)
    } else {
      const slug = str(fields.whatsappBrand, 'simmer').trim() || 'simmer'
      const concept = ctx.concepts.find((c) => c.slug === slug)
      const loc = concept ? locationFromConcept(concept) : locationFor(slug)
      if (loc && filled(loc.whatsapp)) { waHref = whatsappLink(loc, str(fields.whatsappMessage) || undefined); waExternal = true }
    }
  }

  const slugs = Array.from(new Set([...ctx.concepts.map((c) => c.slug), ...KNOWN]))
  const perks = rawPerks.map((p) => {
    let brand = str(p.brand).trim().toLowerCase()
    if (!brand) {
      const tag = str(p.tag).toLowerCase()
      brand = slugs.find((s) => tag.includes(s)) ?? ''
    }
    const iconKey = str(p.icon).trim()
    const Icon = iconKey === 'none' ? null : ICONS[iconKey] ?? BRAND_ICON[brand] ?? null
    return {
      brand,
      Icon,
      tag: str(p.tag),
      head: str(p.head),
      body: str(p.body),
      badge: str(p.badge).trim(),
      stamps: typeof p.stamps === 'boolean' ? p.stamps : brand === 'stackd',
      free: str(p.stampsFreeText).trim() || 'free',
    }
  })

  const kitchens: string[] = []
  for (const p of perks) {
    if (!p.brand) continue
    const name = formatBrandName(ctx.concepts.find((c) => c.slug === p.brand)?.name ?? p.brand)
    if (name && !kitchens.includes(name)) kitchens.push(name)
  }

  const passF = {
    brand: strOr(fields.passBrand, 'servd'),
    tier: strOr(fields.passTier, 'insider'),
    title: strOr(fields.passTitle, 'All-access\npass'),
    foot: strOr(fields.passFoot, 'free forever'),
  }
  const hasCtas = Boolean(waHref || primary.text)

  return (
    <section
      ref={ref}
      id="insiders"
      className={v.section}
      aria-labelledby={headline ? headId : undefined}
      style={{ scrollMarginTop: 64, ...(bg && { background: bg }) }}
    >
      <div className={v.wrap}>
        <div className={`${v.top} ${showPass ? '' : v.solo}`}>
          <div className={`${v.copy} reveal-on-scroll`}>
            {eyebrow && <p className={v.eyebrow}>{eyebrow}</p>}
            {headline && <h2 id={headId} className={v.h2}>{twoLine(headline)}</h2>}
            {sub && <p className={v.lead}>{sub}</p>}
            {hasCtas && (
              <div className={v.ctas}>
                {waHref && (
                  <a href={waHref} className="sv-btn sv-btn-primary"
                    {...(waExternal && { target: '_blank', rel: 'noopener noreferrer' })}>
                    <MessageCircle aria-hidden size={20} strokeWidth={2.5} />
                    {secondary.text}
                    <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
                  </a>
                )}
                {primary.text && (
                  <Link href={safeHref(primary.href)} className={`sv-btn ${v.btnLight}`}>{primary.text}</Link>
                )}
              </div>
            )}
            {(signIn.text || finePrint) && (
              <p className={v.fine}>
                {signIn.text && <Link href={safeHref(signIn.href)} className={v.signin}>{signIn.text}</Link>}
                {finePrint && <span>{signIn.text ? ` · ${finePrint}` : finePrint}</span>}
              </p>
            )}
          </div>
          {showPass && <Pass f={passF} kitchens={kitchens} />}
        </div>

        {perks.length > 0 && (
          <ul className={v.perks}>
            {perks.map((p, i) => {
              const lifted = Boolean(p.badge)
              const cls = [v.perk, 'reveal-on-scroll', (Object.prototype.hasOwnProperty.call(v, p.brand) ? v[p.brand] : ''), lifted ? v.featured : ''].join(' ')
              return (
                <li key={i} className={cls}
                  style={{ '--tilt': `${TILTS[i % TILTS.length]}deg`, '--d': `${i * 100}ms` } as CSSProperties}>
                  {p.badge && <span className={v.badge}>{p.badge}</span>}
                  {p.Icon && <span className={v.perkIcon} aria-hidden="true"><p.Icon size={22} strokeWidth={2.2} /></span>}
                  {p.tag && <p className={v.perkTag}>{p.tag}</p>}
                  {p.head && <h3 className={v.perkHead}>{p.head}</h3>}
                  {p.body && <p className={v.perkBody}>{p.body}</p>}
                  {p.stamps && <PunchCard freeText={p.free} />}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
