'use client'

// KitchenDoors — the scene that replaces the flat white `[concept]` error page.
//
//   mode 'wrong-door'   (an unknown slug such as /checkout): a day-part sky over
//                       three illustrated doors on one floor line. Each door has
//                       a lamp lit by the kitchen's real state, is ajar when the
//                       kitchen is open, and swings wider on hover / focus / tap.
//                       A coffee peeks out of stackd's door and a burger out of
//                       Flipd's; simmer's door has no character, only warm light
//                       spilling through the gap. A closed kitchen's door is shut
//                       and its cast member sleeps on the step instead.
//   mode 'menu-offline' (a known kitchen whose menu API failed): a brand-skinned
//                       counter scene that keeps every useful action (menu,
//                       reserve / visit, the other kitchens) and the live status.
//
// Visual state that depends on the clock (lamps, shut doors, sleepers) is driven
// by CSS on the server-stamped `html[data-k-<slug>]` attributes, so the very
// first paint is already right. React state only swaps poses and copy. The SSR
// render is the final frame; the entrance only moves things (never hides them).
// Reduced motion: doors stay ajar, nothing swings or loops.

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatBrandName } from '../../../lib/concept'
import { useKitchens } from '../../../lib/world/kitchens'
import { useWorld } from '../../../lib/world/useWorld'
import { emptyLine, kitchenLine, openCountLine } from '../../../lib/world/voice'
import type { KitchenSlug, KitchenState } from '../../../lib/world/kitchenCore'
import type { DayPart } from '../../../lib/world/clock'
import type { CharacterKind } from '../../characters/types'
import { Motes, Stars, Steam } from '../Ambient'
import { CrowdCameo, CrowdRow } from '../cast/CrowdCameo'
import s from './doors.module.css'

type Vars = CSSProperties & Record<`--${string}`, string | number>

export type KitchenDoorsMode = 'wrong-door' | 'menu-offline'

const DOOR_ORDER: readonly KitchenSlug[] = ['stackd', 'simmer', 'flipd']

/** Where each kitchen's door leads. simmer orders tableside from the QR card,
 *  so its door opens onto the room, not an order page. */
const DOOR_HREF: Record<KitchenSlug, string> = {
  stackd: '/stackd',
  simmer: '/brand/simmer',
  flipd: '/flipd',
}

/** Who peeks out of each door. simmer never gets a character. */
const PEEKER: Record<KitchenSlug, CharacterKind | null> = {
  stackd: 'coffee',
  simmer: null,
  flipd: 'burger',
}

function isKitchenSlug(v: string | undefined | null): v is KitchenSlug {
  return v === 'stackd' || v === 'simmer' || v === 'flipd'
}

export function KitchenDoors({ mode, slug }: { mode: KitchenDoorsMode; slug?: string }) {
  if (mode === 'menu-offline') return <MenuOffline slug={slug} />
  return <WrongDoor />
}

// ─── Shared: the mini header ────────────────────────────────────────────────
// The global nav hides on /[slug], so the scene carries its own way home.

function MiniHeader({ right }: { right?: ReactNode }) {
  return (
    <header className={s.mini}>
      <Link href="/" className={s.mark} aria-label="servd home">
        servd<span className={s.markDot} aria-hidden>.</span>
      </Link>
      {right}
    </header>
  )
}

function ClockChip() {
  const world = useWorld()
  if (!world.ready || !world.clock) return <span className={s.clock} aria-hidden />
  return <span className={s.clock}>karachi · {world.clock}</span>
}

// ─── mode: wrong-door ───────────────────────────────────────────────────────

function WrongDoor() {
  const { bySlug, openCount, total, ready } = useKitchens()
  const world = useWorld()
  const copy = emptyLine('wrong-door')

  return (
    <main className={s.scene} data-mode="wrong-door">
      <div className={s.sky} aria-hidden>
        <span className={s.orb} />
        <Stars count={28} seed={7} className={s.ambient} />
        <Motes count={14} seed={11} className={s.ambient} />
      </div>

      <MiniHeader right={<ClockChip />} />

      <section className={s.stage} aria-labelledby="doors-title">
        <h1 id="doors-title" className={s.title}>{copy.title}</h1>
        <p className={s.body}>{copy.body}</p>

        <div className={s.street}>
          <span className={s.floor} aria-hidden />
          <ul className={s.doors} aria-label="the kitchens">
            {DOOR_ORDER.map((slug, i) => (
              <Door key={slug} k={bySlug[slug]} dayPart={world.dayPart} index={i} ready={ready} />
            ))}
          </ul>
        </div>

        <div className={s.after}>
          <p className={s.count}>
            <span className={s.countDot} aria-hidden data-open={openCount > 0 ? '1' : '0'} />
            {openCountLine(openCount, total, world.dayPart)}
          </p>
          <Link href="/browse" className={s.cta}>
            browse every kitchen <span aria-hidden>→</span>
          </Link>
        </div>
      </section>
    </main>
  )
}

function Door({ k, dayPart, index, ready }: { k: KitchenState; dayPart: DayPart; index: number; ready: boolean }) {
  const [active, setActive] = useState(false)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kind = PEEKER[k.slug]
  const name = formatBrandName(k.name)

  useEffect(() => () => { if (touchTimer.current) clearTimeout(touchTimer.current) }, [])

  const on = useCallback(() => setActive(true), [])
  const off = useCallback(() => setActive(false), [])

  // Touch has no hover: a tap swings the door (the navigation that follows
  // takes long enough to see it), and a tap that doesn't navigate — a long
  // press, a cancelled tap — lets the door drift back after a beat.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    setActive(true)
    if (touchTimer.current) clearTimeout(touchTimer.current)
    touchTimer.current = setTimeout(() => setActive(false), 2400)
  }, [])

  const statusText = k.label
  const line = kitchenLine(k, dayPart)
  const verb = k.slug === 'simmer' ? 'see the room' : k.open ? 'go in' : 'have a look'

  return (
    <li
      className={s.slot}
      data-door={k.slug}
      data-state={ready ? k.phase : undefined}
      data-active={active ? '1' : undefined}
      style={{ '--i': index } as Vars}
    >
      <Link
        href={DOOR_HREF[k.slug]}
        className={s.door}
        aria-label={`${name}, ${statusText}. ${verb}`}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') on() }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') off() }}
        onPointerDown={onPointerDown}
        onFocus={on}
        onBlur={off}
      >
        <span className={s.bubble} aria-hidden>{line}</span>

        <span className={s.lamp} aria-hidden>
          <span className={s.bracket} />
          <span className={s.shade} />
          <span className={s.bulb} />
        </span>

        <span className={s.frame} aria-hidden>
          <span className={s.way}>
            <span className={s.room}>
              <span className={s.roomLight} />
            </span>
            <span className={s.leaf}>
              <LeafFace slug={k.slug} />
            </span>
            {kind && (
              <span className={s.peek}>
                <span className={s.peekInner}>
                  <CrowdCameo kind={kind} pose={active ? 'wave' : 'peek'} size={124} look="left" delay={index * 420} />
                </span>
              </span>
            )}
          </span>
        </span>

        <span className={s.stoop} aria-hidden />
        {k.slug === 'simmer' && <span className={s.spill} aria-hidden />}
        {kind && (
          <span className={s.sleeper} aria-hidden>
            <span className={s.sleeperInner}>
              <CrowdCameo kind={kind} pose="sleep" size={70} delay={index * 300} />
            </span>
          </span>
        )}

        <span className={s.plate}>
          <span className={s.name} data-brand={k.slug}>{name}</span>
          <span className={s.status}>
            <span className={s.statusDot} aria-hidden />
            {statusText}
          </span>
        </span>
      </Link>
    </li>
  )
}

/** The painted face of each door leaf. Purely decorative. */
function LeafFace({ slug }: { slug: KitchenSlug }) {
  if (slug === 'stackd') {
    return (
      <>
        <span className={s.stackdWindow} />
        <span className={s.stackdSticker}>stackd</span>
        <span className={s.stackdDot} />
        <span className={s.knob} />
      </>
    )
  }
  if (slug === 'simmer') {
    return (
      <>
        <span className={s.simmerHair} />
        <span className={s.simmerWord}>simmer</span>
        <span className={s.simmerPull} />
      </>
    )
  }
  return (
    <>
      <span className={s.flipdPort} />
      <span className={s.flipdSign}>Flipd</span>
      <span className={s.flipdBar} />
      <span className={s.flipdKick} />
    </>
  )
}

// ─── mode: menu-offline ─────────────────────────────────────────────────────

type OfflineVariant = KitchenSlug | 'servd'

interface OfflineCopy {
  help: string
  menu: string
  second: { label: string; href: string }
  orTry: string
  home: string
}

function offlineCopy(variant: OfflineVariant, slug: string, name: string): OfflineCopy {
  switch (variant) {
    case 'stackd':
      return {
        help: 'the counter still takes orders in person — flag down the barista, they’ll take it from the printed card.',
        menu: 'see the menu',
        second: { label: 'find the café', href: '/brand/stackd#visit' },
        orTry: 'or try',
        home: 'the café',
      }
    case 'simmer':
      return {
        help: 'flag down your server — they’ll take the order from the printed card.',
        menu: 'the menu',
        second: { label: 'reserve a table', href: '/reserve/simmer' },
        orTry: 'or try',
        home: 'the room',
      }
    case 'flipd':
      return {
        help: 'Dining in? Flag down your server — they’ll take the order from the printed card.',
        menu: 'See the menu',
        second: { label: 'Book a table', href: '/reserve/flipd' },
        orTry: 'Or try',
        home: 'The diner',
      }
    default:
      return {
        help: 'Flag down your server — they’ll take the order from the printed card. Reservations are open.',
        menu: 'See the menu',
        second: { label: 'Reserve a table', href: `/reserve/${slug}` },
        orTry: 'Or try',
        home: name,
      }
  }
}

function prettify(slug: string): string {
  if (isKitchenSlug(slug)) return slug === 'flipd' ? 'Flipd' : formatBrandName(slug)
  return formatBrandName(slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
}

function MenuOffline({ slug: rawSlug }: { slug?: string | undefined }) {
  const slug = (rawSlug ?? '').toLowerCase()
  const variant: OfflineVariant = isKitchenSlug(slug) ? slug : 'servd'
  const { bySlug, ready } = useKitchens()
  const world = useWorld()
  const k = isKitchenSlug(slug) ? bySlug[slug] : null
  const name = k ? formatBrandName(k.name) : prettify(slug)
  const voiced = emptyLine('menu-offline', variant)
  // simmer's line is fixed by the brand brief: it names the real situation
  // (the QR card at the table), terse and lowercase.
  const copy = variant === 'simmer'
    ? { title: 'tableside ordering isn’t live yet.', body: voiced.body }
    : voiced
  const words = offlineCopy(variant, slug, name)
  const others = DOOR_ORDER.filter((x) => x !== slug)

  return (
    <main className={s.offline} data-brand={variant}>
      {variant === 'servd' && (
        <div className={s.sky} aria-hidden>
          <span className={s.orb} />
          <Stars count={24} seed={5} className={s.ambient} />
          <Motes count={12} seed={9} className={s.ambient} />
        </div>
      )}

      <MiniHeader
        right={
          slug ? (
            <Link href={`/brand/${slug}`} className={s.miniLink}>
              {words.home} <span aria-hidden>→</span>
            </Link>
          ) : undefined
        }
      />

      <section className={s.counter} aria-labelledby="offline-title">
        <div className={s.copy}>
          {k && (
            <p className={s.statusLine} data-state={ready ? k.phase : undefined}>
              <span className={s.liveDot} aria-hidden />
              <span>
                <span className={s.statusName}>{name}</span>
                <span aria-hidden> · </span>
                {kitchenLine(k, world.dayPart)}
              </span>
            </p>
          )}
          <h1 id="offline-title" className={s.offTitle}>{copy.title}</h1>
          <p className={s.offBody}>{copy.body}</p>
          <p className={s.help}>{words.help}</p>

          <div className={s.actions}>
            <Link href={`/brand/${slug}/menu`} className={`${s.btn} ${s.btnPrimary}`}>
              {words.menu}
            </Link>
            <Link href={words.second.href} className={`${s.btn} ${s.btnGhost}`}>
              {words.second.label}
            </Link>
          </div>

          <nav className={s.orTry} aria-label="other kitchens">
            <span className={s.orTryLabel}>{words.orTry}</span>
            {others.map((o) => (
              <Link key={o} href={DOOR_HREF[o]} className={s.tryPill} data-door={o}>
                <span className={s.tryDot} aria-hidden />
                {formatBrandName(bySlug[o].name)}
              </Link>
            ))}
          </nav>
        </div>

        <div className={s.art} aria-hidden>
          {variant === 'stackd' && <StackdCounter />}
          {variant === 'flipd' && <FlipdPass />}
          {variant === 'simmer' && <SimmerCard />}
          {variant === 'servd' && <ServdCounter />}
        </div>
      </section>
    </main>
  )
}

// ─── Brand counters ─────────────────────────────────────────────────────────

/** stackd: a cream counter, the packaging on it is the service vessel, a
 *  coffee sipping its own brew and a croissant keeping it company. */
function StackdCounter() {
  return (
    <div className={s.stackdArt}>
      <span className={s.stackdSun}>cooked here.<br />wrapped, not plated.</span>
      <div className={s.stackdCast}>
        <span className={s.stackdCoffee}>
          <Steam count={3} seed={3} className={s.stackdSteam} color="rgba(252,232,206,.7)" />
          <span className={s.castScale}><CrowdCameo kind="coffee" pose="sip" size={150} look="right" /></span>
        </span>
        <span className={s.stackdCroissant}>
          <span className={s.castScale}><CrowdCameo kind="croissant" pose="idle" size={112} look="left" delay={600} /></span>
        </span>
        <svg className={s.vessels} viewBox="0 0 150 110">
          {/* cup: cream body, plum band, sky lid */}
          <g transform="translate(8 18)">
            <path d="M4 14h34l-4 74a6 6 0 0 1-6 5H14a6 6 0 0 1-6-5z" fill="#FCE8CE" stroke="#2E1922" strokeWidth="2" />
            <rect x="6" y="40" width="30" height="16" fill="#7C2946" />
            <rect x="0" y="6" width="42" height="10" rx="4" fill="#9BD3DD" stroke="#2E1922" strokeWidth="2" />
            <rect x="15" y="0" width="12" height="8" rx="3" fill="#9BD3DD" stroke="#2E1922" strokeWidth="2" />
          </g>
          {/* sandwich parcel: kraft wrap, plum sticker */}
          <g transform="translate(58 58)">
            <rect x="0" y="0" width="48" height="34" rx="6" fill="#D9B48A" stroke="#2E1922" strokeWidth="2" />
            <path d="M0 12h48" stroke="#2E1922" strokeWidth="1.5" opacity=".35" />
            <circle cx="24" cy="18" r="8" fill="#7C2946" stroke="#2E1922" strokeWidth="1.5" />
          </g>
          {/* pastry bag: cream, folded top, sky twine */}
          <g transform="translate(110 28)">
            <path d="M2 10h34v58a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="#FCE8CE" stroke="#2E1922" strokeWidth="2" />
            <path d="M2 10l6-8h22l6 8" fill="#F1D9B8" stroke="#2E1922" strokeWidth="2" />
            <path d="M8 22h22" stroke="#9BD3DD" strokeWidth="3" strokeLinecap="round" />
            <circle cx="19" cy="44" r="7" fill="#7C2946" />
          </g>
        </svg>
      </div>
      <div className={s.stackdTop} />
      <div className={s.stackdFront}>
        <span className={s.stackdChalk}>back on the app soon</span>
      </div>
    </div>
  )
}

/** Flipd: mustard field, a blue ticket rail with the one ticket that matters,
 *  and a burger flipping a patty on the flat-top while the fries cheer on. */
function FlipdPass() {
  return (
    <div className={s.flipdArt}>
      <div className={s.rail}>
        <span className={s.clip} style={{ left: '14%' }} />
        <span className={s.clip} style={{ left: '52%' }} />
        <span className={s.clip} style={{ left: '82%' }} />
        <span className={`${s.ticket} ${s.ticketMain}`}>
          <span className={s.ticketNo}>No. 001</span>
          ONLINE ORDERS
          <span className={s.ticketBig}>· SOON ·</span>
        </span>
        <span className={`${s.ticket} ${s.ticketSide}`}>
          <span className={s.ticketNo}>DINE-IN</span>
          ASK YOUR SERVER
        </span>
      </div>
      <div className={s.flipdCast}>
        <span className={s.flipdBurger}>
          <svg className={s.patty} viewBox="0 0 60 26">
            <ellipse cx="30" cy="13" rx="27" ry="10" fill="#6B3A1E" stroke="#1D3159" strokeWidth="2.5" />
            <path d="M10 10q20 -6 40 0" stroke="#8C5230" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
          <span className={s.castScale}><CrowdCameo kind="burger" pose="cheer" size={150} /></span>
        </span>
        <span className={s.flipdFries}>
          <span className={s.castScale}><CrowdCameo kind="fries" pose="idle" size={120} look="left" delay={500} /></span>
        </span>
      </div>
      <div className={s.flatTop} />
      <div className={s.checkerBand} />
    </div>
  )
}

/** simmer: no characters, no gradient, no white. A hairline printed card —
 *  the thing the server will take your order from. */
function SimmerCard() {
  return (
    <div className={s.simmerArt}>
      <div className={s.simmerCardBack} />
      <div className={s.simmerCard}>
        <span className={s.simmerCardMark}>simmer</span>
        <span className={s.simmerCardTag}>simmer down.</span>
        <span className={s.simmerRule} />
        {[72, 58, 80, 46, 66, 54].map((w, i) => (
          <span key={i} className={s.simmerLine} style={{ width: `${w}%` }} />
        ))}
        <span className={s.simmerCardFoot}>table service</span>
      </div>
    </div>
  )
}

/** Any other kitchen: the servd sky and a slightly worried crowd. */
function ServdCounter() {
  return (
    <div className={s.servdArt}>
      <CrowdRow kinds={['fries', 'coffee', 'burger']} size={110} pose="worried" gap={8} stagger={180} />
      <div className={s.servdFloor} />
    </div>
  )
}
