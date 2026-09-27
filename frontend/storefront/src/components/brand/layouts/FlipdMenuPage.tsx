// Flipd — the menu, as its own page (/brand/flipd/menu).
//
// The READ-ONLY menu: what we serve and what it costs. Ordering lives at
// /flipd, which is the same data plus a basket. Both read the same API
// (`/storefront/flipd/menu`, fetched server-side by app/brand/[slug]/menu),
// so there is one menu in the system and admin is the only place it is
// edited. Nothing here is hardcoded — an item renamed in admin is renamed here
// on the next request. Voice rule: "names the ingredient, skips the
// adjective", so each item's description is printed as-is.
//
// Built to be fun AND fast to browse:
//   - a sticky chip bar with scrollspy — the section you are in is lit, and a
//     tap jumps straight to any other
//   - every item is an order ticket clipped to the kitchen rail; each
//     section's tickets swing in as it arrives, straighten and lift on hover,
//     and carry their own Order link
//   - the same burger builds on a loop in the header, and the crowd waits by
//     the order button at the bottom (hover winds them up, click, they cheer)

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { FlipdCrowd, Marquee, OrderLink, Words, DoodleBurst, DoodleSquiggle, DoodleStar } from '../flipd/FlipdBits'
import { tick } from '../../../lib/tactile'
import { ItemTicket } from '../flipd/ItemTicket'
import { MiniBuild } from '../flipd/MiniBuild'
import { useSectionMotion } from '../flipd/useFlipdMotion'
import type { FlipdMenuCategoryLive } from '../flipd/types'
import f from '../flipd/flipd.module.css'
import m from '../flipd/menu.module.css'

// Kept exported from here for anything that imported them before the types
// moved next to the components that share them.
export type {
  FlipdModifier,
  FlipdModifierGroup,
  FlipdMenuItemLive,
  FlipdMenuCategoryLive,
} from '../flipd/types'

interface Props {
  slug: string
  conceptName: string
  categories: FlipdMenuCategoryLive[]
}

const MARQUEE = ['Built to spec', 'Salt and pepper. Nothing else.', 'Same burger, every time', 'Smash burgers']

function Checker() {
  return <div aria-hidden className={f.checker} />
}

function Header({ slug, conceptName }: { slug: string; conceptName: string }) {
  const ref = useSectionMotion<HTMLElement>(0.1)
  return (
    <section ref={ref} className={m.head} aria-labelledby="flipd-menu-title">
      <div className={m.headInner}>
        <div>
          <p className={m.eyebrow}>The menu</p>
          <h1 id="flipd-menu-title" className={m.h1}>
            <Words text="Built to spec." />
          </h1>
          <p className={m.lede}>
            Every burger on a fixed build. Prices and what&rsquo;s on today come
            straight from the kitchen&rsquo;s own list.
          </p>
          <div className={`${f.ctaRow} ${m.ctas}`}>
            <OrderLink href={`/${slug}`}>Order now</OrderLink>
            <Link href={`/brand/${slug}`} className={`${f.btn} ${f.btnGhost}`}>Back to {conceptName}</Link>
          </div>
        </div>
        <div className={m.headArt}>
          <MiniBuild ring="THE MENU · BUILT TO SPEC · THE MENU · BUILT TO SPEC · " />
          <DoodleBurst className={f.float} style={{ top: '-2%', right: '4%', width: 52 }} />
          <DoodleSquiggle className={f.float} style={{ bottom: '2%', left: '0%', width: 80 }} />
        </div>
      </div>
    </section>
  )
}

/**
 * Sticky jump-chips with scrollspy. Plain anchors underneath, so they work
 * before hydration and without JS; with JS the jump is smooth (unless reduced
 * motion), focus moves to the section, and the chip for the section on screen
 * is lit and kept in view inside the bar.
 */
function ChipBar({ cats, active }: { cats: FlipdMenuCategoryLive[]; active: string | null }) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = barRef.current
    if (!bar || !active) return
    const chip = bar.querySelector<HTMLElement>(`[data-cat="${CSS.escape(active)}"]`)
    if (!chip) return
    const target = chip.offsetLeft - bar.clientWidth / 2 + chip.offsetWidth / 2
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    bar.scrollTo({ left: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' })
  }, [active])

  function jump(e: ReactMouseEvent<HTMLAnchorElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    const el = document.getElementById(`cat-${id}`)
    if (!el) return
    e.preventDefault()
    tick('light')
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
    history.replaceState(null, '', `#cat-${id}`)
  }

  return (
    <nav aria-label="Menu sections" className={m.chipBar}>
      <div ref={barRef} className={m.chips}>
        {cats.map((c) => (
          <a
            key={c.id}
            href={`#cat-${c.id}`}
            data-cat={c.id}
            onClick={(e) => jump(e, c.id)}
            className={`${m.chip} ${active === c.id ? m.chipActive : ''}`}
            aria-current={active === c.id ? 'true' : undefined}
          >
            {c.name}
            <span className={m.chipCount} aria-hidden>{c.items.length}</span>
            <span className={f.srOnly}>, {c.items.length} {c.items.length === 1 ? 'item' : 'items'}</span>
          </a>
        ))}
      </div>
    </nav>
  )
}

function Category({ cat, index, slug }: { cat: FlipdMenuCategoryLive; index: number; slug: string }) {
  const ref = useSectionMotion<HTMLElement>(0.05)
  return (
    <section
      ref={ref}
      id={`cat-${cat.id}`}
      data-spy={cat.id}
      tabIndex={-1}
      className={m.cat}
      aria-labelledby={`cat-title-${cat.id}`}
    >
      <div className={m.catHead}>
        <span className={m.catNo} aria-hidden>{String(index + 1).padStart(2, '0')}</span>
        <h2 id={`cat-title-${cat.id}`} className={m.catTitle}>{cat.name}</h2>
        <span className={`${f.sticker} ${m.catCount}`} style={{ '--r': '3deg', '--i': 0 } as CSSProperties}>
          {cat.items.length} {cat.items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <div className={f.rail} aria-hidden />
      <div className={m.grid}>
        {cat.items.map((item, i) => (
          <ItemTicket key={item.id} item={item} index={i} orderHref={`/${slug}`} label={cat.name} />
        ))}
      </div>
    </section>
  )
}

/**
 * Nothing published yet. Still a ticket on the rail — it swings in like the
 * real ones, a doodle boils beside it, and a small crowd waits on the
 * counter next to it, barely excited, for the kitchen to post something.
 */
function EmptyMenu({ slug }: { slug: string }) {
  const ref = useSectionMotion<HTMLElement>(0.1)
  return (
    <section ref={ref} className={m.cats} aria-labelledby="flipd-menu-empty">
      <div className={m.empty}>
        <div className={m.emptyTicket}>
          <div className={f.ticketWrap} style={{ '--r': '-1.5deg', '--i': 0 } as CSSProperties}>
            <span className={f.clip} aria-hidden />
            <div className={f.ticket}>
              <div className={f.ticketHead}><span>No. 00</span><span>Kitchen</span></div>
              <hr className={f.perf} />
              <h2 id="flipd-menu-empty" className={m.emptyTitle}>The menu isn&rsquo;t up yet.</h2>
              <p className={m.emptyBody}>Call the counter and we&rsquo;ll tell you what&rsquo;s on.</p>
              <Link href={`/${slug}`} className={f.btn}>Go to ordering</Link>
            </div>
          </div>
          <DoodleStar className={`${f.float} ${m.emptyDoodle}`} />
          <DoodleSquiggle className={`${f.float} ${m.emptySquiggle}`} />
        </div>
        <FlipdCrowd className={m.emptyCrowd} excitement={0.08} />
      </div>
    </section>
  )
}

function Close({ slug }: { slug: string }) {
  const [excited, setExcited] = useState(false)
  return (
    <section className={m.close} aria-labelledby="flipd-menu-close">
      <h2 id="flipd-menu-close" className={m.closeTitle}>Same burger, every time.</h2>
      <div className={f.ctaRow}>
        <OrderLink href={`/${slug}`} className={`${f.btn} ${f.btnOnBlue}`} onExcite={setExcited}>
          Order now
        </OrderLink>
      </div>
      <FlipdCrowd className={m.closeCrowd} excitement={excited ? 1 : 0.2} />
    </section>
  )
}

export function FlipdMenuPage({ slug, conceptName, categories }: Props) {
  // A category with no items is a draft as far as a customer is concerned —
  // don't print an empty heading at them.
  const shown = categories.filter((c) => (c.items?.length ?? 0) > 0)
  const [active, setActive] = useState<string | null>(shown[0]?.id ?? null)
  const shownKey = shown.map((c) => c.id).join('|')

  // Scrollspy: whichever section crosses the band just under the sticky bar.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-spy]'))
    if (els.length === 0) return
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const id = hit?.target.getAttribute('data-spy')
        if (id) setActive(id)
      },
      { rootMargin: '-30% 0px -60% 0px' },
    )
    els.forEach((el) => io.observe(el))
    // The last section is often too short to ever reach the spy band, so at
    // the very bottom of the page it wins outright.
    const last = els[els.length - 1]?.getAttribute('data-spy')
    const onScroll = () => {
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      const lastEl = els[els.length - 1]
      if (atEnd && last && lastEl && lastEl.getBoundingClientRect().top < window.innerHeight) setActive(last)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [shownKey])

  return (
    <div className="flipd-page">
      <Checker />

      <Header slug={slug} conceptName={conceptName} />

      <Marquee items={MARQUEE} duration={34} />

      {shown.length > 1 && <ChipBar cats={shown} active={active} />}

      {shown.length === 0 ? (
        // The API answered but nothing is published (or it did not answer).
        // Say so plainly and send them somewhere useful.
        <EmptyMenu slug={slug} />
      ) : (
        <div className={m.cats}>
          {shown.map((cat, i) => (
            <Category key={cat.id} cat={cat} index={i} slug={slug} />
          ))}
        </div>
      )}

      <Checker />

      <Close slug={slug} />

      <Checker />
    </div>
  )
}
