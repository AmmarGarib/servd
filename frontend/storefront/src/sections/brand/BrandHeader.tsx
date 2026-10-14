'use client'
// brand.header — the brand microsite's top bar (SiteLayout
// `brand:<slug>:header`). The look is per brand, keyed by the concept slug;
// every word, link and image on it is a field.

import { useState, useEffect, type ElementType } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { brandSurface, brandSurfaceTint, brandWordmark } from '../../lib/concept'
import { sectionKitImage } from './kitImage'
import { useBrandSlug } from '../../lib/host'
import type { SectionProps } from '../types'
import { link, list, safeSrc } from '../safe'
import { brandHref, brandNameOf, fill, servdHref } from './util'

/** Flipd's die-cut badge as bundled in this build (760×760). */
const BUNDLED_BADGE = '/brand/flipd-badge.png'
/** The carded pill's type: 0.92rem from ~375px up, down to 0.8rem at 320px. */
const PILL_FONT = 'clamp(0.8rem, 3.9vw, 0.92rem)'

export function BrandHeader({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  // The server knows on the first paint whether this is the brand's own
  // domain; the client re-checks the host after mount (BrandShell did this).
  const onBrandHost = useBrandSlug(ctx.onBrandHost ? (concept?.slug ?? '') : null) !== null
  const pathname = usePathname() ?? ''
  const [open, setOpen] = useState(false)
  const slug = concept?.slug ?? ''
  // All three brand microsites keep their header in view as the page moves.
  //
  // They do it two different ways, and the difference is forced by the layout,
  // not a preference. flipd's bar is out of flow so the hero's checker can run
  // up under it as one unbroken floor — it has to be `fixed`, because `sticky`
  // is in flow and would push the hero down and put a half-tile seam back.
  // simmer and stackd already sit in flow and paint their own band, so `sticky`
  // is right for them: it pins on scroll and changes nothing about the layout.
  const diner = slug === 'flipd'
  const pinnedNav = diner || slug === 'simmer' || slug === 'stackd'
  // Once the page has moved, the bar needs a solid band under it or the content
  // scrolls through it — flipd is transparent over its hero, and stackd's band
  // is a scrim that fades out at the bottom edge.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    if (!pinnedNav) return
    const onScroll = () => setScrolled(window.scrollY > 48)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pinnedNav])

  if (!concept) return null

  const name = brandNameOf(ctx, fields.name)
  const accent = concept.primaryColor || 'var(--servd-green)'
  // The brand's home: the domain root on its own domain (stackd.pk/), its
  // /brand/<slug> page on servd — never a /brand/<slug> copy on the brand
  // domain.
  const base = onBrandHost ? '/' : `/brand/${concept.slug}`
  const to = (href: unknown) => brandHref(href, ctx, { mode: 'host', onBrandHost })
  const servdLink = link(fields.servdLink)
  // servd's home is /home (a stored '/' 308s there, so it is mapped here).
  const servdPath = servdLink.href.trim() === '/' ? '/home' : servdLink.href
  const servdHome = servdHref(to(servdPath)?.href ?? '/home', onBrandHost)
  const surface = brandSurface(concept.slug)
  const wordmark = brandWordmark(concept.slug)
  // flipd paints its checker as a full header band. As its own box it leaves a
  // half-tile SEAM where it meets the hero checker just below, so the header
  // floats as a TRANSPARENT overlay on the hero instead (`fixed`, out of flow):
  // the hero's checker shows through it, and its pinned area pads its top to
  // clear this bar.
  const flipdFixed = diner
  const navBg: React.CSSProperties = concept.slug === 'simmer'
    ? {
        backgroundColor: surface.bg,
        backgroundImage:
          'linear-gradient(rgb(var(--simmer-bone-rgb) / 0.06) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgb(var(--simmer-bone-rgb) / 0.06) 1px, transparent 1px),' +
          'linear-gradient(rgb(var(--simmer-bone-rgb) / 0.1) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgb(var(--simmer-bone-rgb) / 0.1) 1px, transparent 1px)',
        backgroundSize: '40px 40px, 40px 40px, 200px 200px, 200px 200px',
      }
    : diner
    ? {
        backgroundColor: 'var(--flipd-bone)',
        backgroundImage: 'var(--flipd-checker)',
        backgroundSize: '36px 36px',
        backgroundRepeat: 'repeat',
      }
    : { background: `linear-gradient(to bottom, ${brandSurfaceTint(concept.slug, 'bg', 242 / 255)} 0%, ${brandSurfaceTint(concept.slug, 'bg', 0)} 100%)` }
  // The diner checker is high-contrast and shreds plain text, so flipd floats
  // its nav on a bone card outlined in Flipd Blue with a hard blue drop shadow.
  const dinerCard: React.CSSProperties = diner
    ? {
        background: 'var(--flipd-bone)',
        border: '2px solid var(--flipd-blue)',
        borderRadius: '999px',
        boxShadow: '0 3px 0 var(--flipd-blue)',
      }
    : {}

  // Carded-nav brands collapse the bar into ONE rounded pill — the lean links
  // plus Order on a single capsule: flipd keeps its bone/blue card, the dark
  // brands get a faint glass capsule so labels read on their deep backgrounds.
  const pillNav = pinnedNav
  // The pill's glass tint: simmer's surface text (bone), a neutral grey on the rest.
  const pillMix = (pct: number) => concept.slug === 'simmer'
    ? brandSurfaceTint(concept.slug, 'text', pct / 100)
    : `rgba(197,199,204,${pct / 100})`
  const navPill: React.CSSProperties = diner
    ? dinerCard
    : pillNav
    ? { background: pillMix(5), border: `1px solid ${pillMix(18)}`, borderRadius: '999px' }
    : {}
  // Fill behind the active link inside the pill.
  const activeFill = diner ? 'rgba(9,13,23,0.12)' : pillNav ? pillMix(14) : 'transparent'

  // The link list is the owner's; tokens resolve against the live brand
  // (@book disappears when the brand takes no reservations; @visit goes to
  // the kitchen's Google Maps pin in a new tab when there is one).
  const links = list(fields.links).flatMap((item) => {
    const l = link(item)
    const target = to(l.href)
    const label = fill(l.text, ctx, name)
    return target && label ? [{ href: target.href, label, external: target.external }] : []
  })
  const order = link(fields.order)
  const orderTo = to(order.href)
  const orderText = fill(order.text, ctx, name)
  // Section field → kit logo → Concept logo (the kit resolves the last two).
  const logo = safeSrc(fields.logo) || sectionKitImage(ctx, 'logo') || concept.logoUrl
  // The home link is active only on the home page; the others on their page
  // and below it. Absolute links (servd pages) are never this page.
  const isActive = (href: string) => (href === base ? pathname === href : href !== '/' && href.startsWith('/') && pathname.startsWith(href))
  const badge = safeSrc(fields.badge) || sectionKitImage(ctx, 'badge') || concept.wordmarkUrl || BUNDLED_BADGE

  return (
    <nav
      aria-label={`${name} navigation`}
      style={{
        position: flipdFixed ? 'fixed' : pinnedNav ? 'sticky' : 'relative',
        ...(pinnedNav ? { top: 0 } : null),
        ...(flipdFixed ? { left: 0, right: 0 } : null),
        zIndex: 50,
        ...(flipdFixed ? {} : navBg),
        // The scrolled band, each brand in its own colours: flipd's mustard
        // field under a hard blue rule; stackd swaps its fading scrim for a
        // flat panel (backgroundImage cleared explicitly); simmer is already
        // opaque and keeps its blueprint grid, so it only gains the hairline.
        ...(pinnedNav && scrolled
          ? diner
            ? { backgroundColor: 'var(--flipd-mustard)', boxShadow: '0 2px 0 var(--flipd-blue)' }
            : concept.slug === 'stackd'
            ? { backgroundColor: surface.bg, backgroundImage: 'none', boxShadow: `0 1px 0 ${surface.border}` }
            : { boxShadow: `0 1px 0 ${surface.border}` }
          : null),
        transition: 'background-color 160ms linear, box-shadow 160ms linear',
        borderBottom: 'none',
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      {/* Brand-mark — circular logo card + brand name (brand font + colour).
          flipd carries its die-cut badge instead: the badge IS the lockup, so
          it replaces both the disc and the name. The link's name is its
          content (the badge's alt, or the name text), which is also what
          search engines read as its anchor text. */}
      <Link
        href={base}
        style={{ display: 'flex', alignItems: 'center', gap: diner ? 0 : '0.7rem', textDecoration: 'none' }}>
        {diner ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={badge}
            alt={name}
            // The bundled badge's own size, so the bar reserves its width
            // before the file arrives (no layout shift).
            {...(badge === BUNDLED_BADGE && { width: 760, height: 760 })}
            style={{ height: 'clamp(3rem, 5vw, 3.6rem)', width: 'auto', display: 'block' }}
          />
        ) : (
        // Simmer's disc is bone with a tiber letter, not orange: the bar is
        // pinned, so an orange disc sat in every viewport beside the page's
        // own orange signal (SKILL rules: one per viewport).
        <span aria-hidden="true" style={{
          width: '2.5rem', height: '2.5rem',
          borderRadius: '50%',
          overflow: 'hidden',
          flexShrink: 0,
          background: slug === 'simmer' ? 'var(--simmer-bone)' : accent,
          color: slug === 'simmer' ? 'var(--simmer-green)' : '#0a0a0a',
          display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: '1.1rem',
          fontWeight: 900,
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.02em',
          boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        }}>
          {logo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            // The monogram is the first letter of the display name.
            : name.charAt(0)}
        </span>
        )}
        {/* The name next to the disc drops on narrow phones (< 420px) so the
            carded pill fits without the page scrolling sideways. Below that
            width a screen-reader-only copy stands in, so the link keeps the
            name as its text at every width (read out once; also its anchor
            text for search engines). Two spans rather than `sr-only
            min-[420px]:not-sr-only`: globals.css's own .sr-only pins
            position:absolute !important, which not-sr-only cannot undo. */}
        {!diner && (
        <span className={pillNav ? 'hidden min-[420px]:inline' : undefined} style={{
          fontFamily: wordmark.font,
          fontSize: '1.6rem',
          fontWeight: wordmark.weight,
          letterSpacing: '-0.01em',
          lineHeight: 1,
          color: wordmark.color,
        }}>
          {name}
        </span>
        )}
        {!diner && pillNav && <span className="sr-only min-[420px]:hidden">{name}</span>}
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {/* The carded-nav brands keep the PILL at every width (three short
            words fit on a phone); brands without it get the hamburger < sm. */}
        <div
          className={pillNav ? 'flex' : 'hidden sm:flex'}
          style={{
            alignItems: 'center',
            gap: pillNav ? '0.1rem' : '0.2rem',
            ...(pillNav ? { ...navPill, padding: '0.25rem 0.35rem' } : {}),
          }}
        >
          {links.map((l, i) => {
            const active = !l.external && isActive(l.href)
            // External links use a plain anchor so target/rel apply;
            // internal ones keep Next's <Link> for client-side navigation.
            const Tag: ElementType = l.external ? 'a' : Link
            const extra = l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
            return (
              <Tag
                key={`${l.href}-${i}`}
                href={l.href}
                {...extra}
                style={{
                  padding: pillNav ? '0.45rem clamp(0.35rem, 2vw, 0.9rem)' : '0.45rem 0.9rem',
                  color: diner ? 'var(--flipd-blue)' : (active ? surface.text : surface.muted),
                  fontWeight: active ? 700 : (pillNav ? 600 : 500),
                  // The carded pill is the bar's full width on a phone: below
                  // ~375px the type steps down so Menu · Book · Visit · Order
                  // still fit a 320px screen without the page scrolling sideways.
                  fontSize: pillNav ? PILL_FONT : '0.92rem',
                  textDecoration: 'none',
                  borderRadius: pillNav ? '999px' : '0.6rem',
                  background: pillNav && active ? activeFill : 'transparent',
                  borderBottom: !pillNav && active ? `2px solid ${accent}` : '2px solid transparent',
                  transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
                }}
              >
                {l.label}
              </Tag>
            )
          })}

          {/* Order joins the SAME pill as the final, emphasised item. */}
          {pillNav && orderTo && orderText && (
            <Link
              href={orderTo.href}
              aria-label={`Order from ${name}`}
              style={{
                padding: '0.45rem clamp(0.4rem, 2.2vw, 0.95rem)',
                color: diner ? 'var(--flipd-blue)' : surface.text,
                fontWeight: 800,
                fontSize: PILL_FONT,
                textDecoration: 'none',
                borderRadius: '999px',
                whiteSpace: 'nowrap',
              }}
            >
              {/* flipd's system is two colours; the arrow stays ink. Simmer's
                  pinned bar carries no orange at all (the page below has its
                  one signal per viewport), so its arrow takes the text colour. */}
              {orderText} <span style={{ color: diner ? 'var(--flipd-blue)' : slug === 'simmer' ? surface.text : accent }}>→</span>
            </Link>
          )}
        </div>

        {/* Brands without the carded pill keep Order as a standalone pill. */}
        {!pillNav && orderTo && orderText && (
          <Link
            href={orderTo.href}
            aria-label={`Order from ${name}`}
            className="brand-pill"
            style={{ padding: '0.55rem 1.15rem', fontSize: '0.92rem' }}
          >
            {orderText} →
          </Link>
        )}

        {/* servd backlink — kept off the lean carded bars. */}
        {!pillNav && servdLink.text && (
          <Link
            href={servdHome}
            style={{
              color: surface.muted,
              fontSize: '0.78rem',
              fontWeight: 600,
              letterSpacing: '0.02em',
              padding: '0.45rem 0.5rem',
              textDecoration: 'none',
            }}
            className="hidden md:inline-block"
          >
            {servdLink.text}<span style={{ color: accent }}>.</span>
          </Link>
        )}

        {/* Hamburger — the link row is hidden < sm, so phones need this. */}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={pillNav ? 'hidden' : 'inline-flex items-center justify-center sm:hidden'}
          style={{ width: '2.75rem', height: '2.75rem', marginLeft: '0.15rem', background: diner ? 'var(--flipd-bone)' : pillNav ? pillMix(5) : 'transparent', border: diner ? '2px solid var(--flipd-blue)' : pillNav ? `1px solid ${pillMix(18)}` : 'none', borderRadius: pillNav ? '50%' : undefined, boxShadow: diner ? '0 3px 0 var(--flipd-blue)' : undefined, color: diner ? 'var(--flipd-blue)' : surface.text, cursor: 'pointer' }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {open
              ? <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>
              : <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown — full-width sheet below the bar. */}
      {open && !pillNav && (
        <div
          className="sm:hidden flex flex-col"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            background: surface.bg,
            borderBottom: `1px solid ${surface.border}`,
            padding: '0.4rem clamp(1rem, 4vw, 2rem) 0.9rem',
            boxShadow: '0 14px 26px rgba(0,0,0,0.35)',
          }}
        >
          {links.map((l, i) => {
            const active = !l.external && isActive(l.href)
            return (
              <Link
                key={`${l.href}-${i}`}
                href={l.href}
                onClick={() => setOpen(false)}
                style={{
                  padding: '0.85rem 0.4rem',
                  color: active ? surface.text : surface.muted,
                  fontWeight: active ? 700 : 500,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderBottom: `1px solid ${surface.border}`,
                }}
              >
                {l.label}
              </Link>
            )
          })}
          {/* No servd backlink on a brand's own domain — the footer carries
              the one "back to servd" link. */}
          {!onBrandHost && servdLink.text && (
            <Link
              href={servdHome}
              onClick={() => setOpen(false)}
              style={{ padding: '0.85rem 0.4rem', color: surface.muted, fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}
            >
              {servdLink.text}<span style={{ color: accent }}>.</span>
            </Link>
          )}
        </div>
      )}
    </nav>
  )
}
