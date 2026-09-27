'use client'
// KitchenBoard: "right now" as a diner departures board, and the heart of
// the living home.
//
// Every row reads the one shared kitchen state (useKitchens, from
// lib/world/kitchenCore). That's the same rule set that drives stackd's lamp,
// Flipd's neon and simmer's candle, so a closed kitchen looks closed
// everywhere. The state is fallback-aware: until the live hours land, it
// shows the posted hours computed on Karachi time, never a pending 'Today'.
//
// Each row's neon sign follows its phase:
//   open     → steady glow, and a rare 90 ms flicker every 7–12 s
//   closing  → amber, with "closing in 25 min" in the brand's voice
//   opening  → a slow warm-up pulse
//   closed   → the tube goes dark. A sleeping cast member curls up at the
//              row end (coffee for stackd, burger for Flipd). simmer gets no
//              character, only a dark row.
// The header line is the live count ("2 of 3 cooking · dinner rush") in
// big neon. The board's ground follows the day: ember-warm at dinner, a
// deeper cool plum after dark.
//
// Reveal hygiene: SSR is final. A board mounted below the fold is armed at
// opacity .4, and it and its split-flap tiles settle within 450 ms.
import Link from 'next/link'
import { ArrowRight, MapPin, MessageCircle } from 'lucide-react'
import type { CSSProperties } from 'react'
import { locationFor, whatsappLink } from '../../../lib/brandLocations'
import { useKitchens } from '../../../lib/world/kitchens'
import { useWorld } from '../../../lib/world/useWorld'
import { kitchenLine, openCountLine } from '../../../lib/world/voice'
import { asKitchenSlug, type KitchenState } from '../../../lib/world/kitchenCore'
import type { CharacterKind } from '../../characters/types'
import { CrowdCameo } from '../../world/cast/CrowdCameo'
import { useReveal } from './Divider'
import s from './home.module.css'
import k from './board.module.css'

export interface BoardBrand {
  id: string
  name: string
  slug: string
  hours: string
}

// Brand signal colours on the ink board (decorative bars only).
const SIGNAL: Record<string, string> = { stackd: '#FCE8CE', simmer: '#E94E1B', flipd: '#3AA8FF' }

// Who sleeps at the end of a closed row. simmer: nobody, ever.
const SLEEPER: Record<string, CharacterKind> = { stackd: 'coffee', flipd: 'burger' }

// Each open sign flickers on its own clock (7–12 s), so the board never
// blinks in unison.
const FLICKER_S: Record<string, number> = { stackd: 7.4, simmer: 11.6, flipd: 9.2 }

function NeonSign({ state, line, slug }: { state: KitchenState | undefined; line: string; slug: string }) {
  const phase = state?.phase ?? 'closed'
  return (
    <span
      className={k.sign}
      data-phase={phase}
      style={{ '--flick': `${FLICKER_S[slug] ?? 9}s` } as CSSProperties}
    >
      <span className={k.bulb} aria-hidden />
      <span className={k.signText}>{line}</span>
    </span>
  )
}

function Tiles({ text }: { text: string }) {
  const chars = Array.from(text)
  return (
    <span className={k.tiles} aria-hidden>
      {chars.map((ch, i) => (
        <span key={`${ch}-${i}`} className={k.tile} style={{ '--ti': Math.min(i, 8) } as CSSProperties}>
          {ch}
        </span>
      ))}
    </span>
  )
}

export function KitchenBoard({ brands }: { brands: BoardBrand[] }) {
  const kitchens = useKitchens()
  const world = useWorld()
  const [boardRef, reveal] = useReveal<HTMLDivElement>()

  // The count line needs the day-part for its label, and the server can't
  // know the visitor's override, so it waits for `ready` (one frame after
  // hydration). Until then the neutral line holds the same slot.
  const countLine = world.ready
    ? openCountLine(kitchens.openCount, kitchens.total, world.dayPart)
    : 'live from each kitchen'

  return (
    <section id="right-now" className={k.section} aria-labelledby="board-title">
      <div className={s.wrap}>
        <div className={k.head}>
          <div>
            <p className={`${s.eyebrow} ${k.eyebrow}`}>Right now</p>
            <h2 id="board-title" className={`${s.h2} ${k.title}`}>
              Who&rsquo;s cooking, <em>live.</em>
            </h2>
          </div>
          <p className={k.count} data-open={kitchens.openCount}>
            <span className={k.liveDot} aria-hidden />
            <span className={k.countText}>{countLine}</span>
          </p>
        </div>

        <div ref={boardRef} className={`${k.board} ${s.rv}`} data-reveal={reveal}>
          <div className={k.boardHead} aria-hidden>
            <span>kitchen</span>
            <span>where</span>
            <span>status</span>
            <span />
          </div>
          <ul className={k.rows}>
            {brands.map((b) => {
              const loc = locationFor(b.slug)
              const ks = asKitchenSlug(b.slug)
              const state = ks ? kitchens.bySlug[ks] : undefined
              const line = state ? (world.ready ? kitchenLine(state, world.dayPart) : state.label) : b.hours
              const phase = state?.phase ?? 'closed'
              const sleeper = phase === 'closed' ? SLEEPER[b.slug] : undefined
              return (
                <li
                  key={b.id}
                  className={k.row}
                  data-phase={phase}
                  data-slug={b.slug}
                  style={{ '--signal': SIGNAL[b.slug] ?? '#FFD447' } as CSSProperties}
                >
                  <h3 className={k.name}>
                    <span className={s.srOnly}>{b.name}</span>
                    <Tiles text={b.name} />
                  </h3>
                  <div className={k.where}>
                    {loc && !loc.area.startsWith('TODO') && (
                      <p className={k.area}><MapPin aria-hidden size={15} strokeWidth={2.4} />{loc.area}</p>
                    )}
                    <p className={k.hours}>{b.hours}</p>
                  </div>
                  <div className={k.status}>
                    <NeonSign state={state} line={line} slug={b.slug} />
                    {sleeper && (
                      <span className={k.sleeper} aria-hidden>
                        <CrowdCameo kind={sleeper} pose="sleep" size={40} />
                      </span>
                    )}
                  </div>
                  {loc && (
                    <div className={k.links}>
                      <Link href={`/${b.slug}`} className={k.orderLink} aria-label={`Order from ${b.name}`}>
                        Order <ArrowRight aria-hidden size={16} strokeWidth={2.6} />
                      </Link>
                      <a
                        href={whatsappLink(loc, `hi ${b.name.toLowerCase()}`)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={k.waLink}
                        aria-label={`WhatsApp ${b.name} (opens in a new tab)`}
                      >
                        <MessageCircle aria-hidden size={16} strokeWidth={2.4} /> WhatsApp
                      </a>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </section>
  )
}
