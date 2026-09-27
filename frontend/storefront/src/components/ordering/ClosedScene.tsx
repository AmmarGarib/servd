'use client'

// ClosedScene — what /[concept] shows when a kitchen isn't taking orders
// online (menu API down, not published, or unknown brand). It used to be a
// plain white "Tableside ordering isn't live yet." page; now each brand gets
// a full-viewport set of its own, with copy from voice(slug).closed:
//
//   flipd  → mustard field, blue checker band, a line-drawn diner counter with
//            a cold flat-top, and the burger companion gasping on the counter
//   stackd → plum field, a cream die-cut sticker, and the coffee companion
//            peeking out from behind a paper bag. Cream Playfair, lowercase.
//   simmer → tiber field, bone Amarante lowercase, one lit candle as the single
//            orange signal. No character, no white, no gradient.
//   other  → the servd butter field with fries.
//
// Static by design: it has to read at any scroll offset and with the API down.
// The only motion is small idle loops in CSS, all stopped under reduced motion
// (the companion itself renders a static pose there — P2).

import Link from 'next/link'
import { Companion } from '@/components/characters/Companion'
import { Candle } from '@/components/brand/simmer/Candle'
import { voice } from '@/lib/voice'
import { STACKD_DIE } from '@/lib/stackdDie'
import { orderingBrand } from './theme'
import c from './closed.module.css'

export function ClosedScene({ slug }: { slug: string }) {
  const brand = orderingBrand(slug)
  const copy = voice(slug).closed
  const menuHref = `/brand/${slug}/menu`
  const reserveHref = `/reserve/${slug}`

  return (
    <section className={`${c.scene} ${c[brand]}`} aria-labelledby="closed-title">
      {brand === 'flipd' && <span aria-hidden className={c.checkerBand} />}

      <div className={c.stage}>
        <div className={c.art}>
          {brand === 'flipd' && <FlipdCounter />}
          {brand === 'stackd' && <StackdSticker />}
          {brand === 'simmer' && (
            <div className={c.candleWrap}>
              <Candle lit height={200} />
            </div>
          )}
          {brand === 'servd' && (
            <div className={c.servdArt}>
              <span aria-hidden className={c.servdSpot} />
              <div className={c.servdCast}>
                <Companion kind="fries" placement="inline" size={180} mood="gasp" />
              </div>
            </div>
          )}
        </div>

        <div className={c.copy}>
          {brand === 'flipd' && <p className={c.kicker} aria-hidden>order counter · closed</p>}
          {brand === 'stackd' && <p className={c.kicker} aria-hidden>the market bar</p>}
          {brand === 'simmer' && <p className={c.kicker} aria-hidden>between services</p>}
          {brand === 'servd' && <p className={c.kicker} aria-hidden>servd · kitchen closed</p>}

          <h1 id="closed-title" className={c.title}>{copy.title}</h1>
          <p className={c.body}>{copy.body}</p>

          <div className={c.actions}>
            <Link href={menuHref} className={`${c.btn} ${c.btnPrimary}`}>{copy.menuCta}</Link>
            <Link href={reserveHref} className={`${c.btn} ${c.btnGhost}`}>{copy.reserveCta}</Link>
          </div>
          <Link href="/browse" className={c.other}>
            {brand === 'simmer' ? 'the other kitchens' : 'other kitchens'} <span aria-hidden>→</span>
          </Link>
        </div>
      </div>

      {brand === 'flipd' && <span aria-hidden className={`${c.checkerBand} ${c.checkerBottom}`} />}
    </section>
  )
}

// ─── Flipd: the diner counter, drawn in Flipd Blue line ─────────────────────

function FlipdCounter() {
  return (
    <div className={c.diner}>
      <svg className={c.dinerSvg} viewBox="0 0 420 300" aria-hidden focusable="false">
        <g fill="none" stroke="#294375" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          {/* pendant lamps */}
          <path d="M92 0 V34" />
          <path d="M72 50 Q92 26 112 50 Z" fill="#F9F0E1" />
          <path d="M328 0 V34" />
          <path d="M308 50 Q328 26 348 50 Z" fill="#F9F0E1" />
          {/* the closed sign — flickers like a tired neon */}
          <g className={c.neon}>
            <rect x="150" y="18" width="120" height="44" rx="22" fill="#F9F0E1" />
            <text x="210" y="47" textAnchor="middle" fill="#294375" stroke="none"
              style={{ font: "400 19px var(--flipd-display, 'Alfa Slab One', Georgia, serif)", letterSpacing: '0.04em' }}>
              closed
            </text>
          </g>
          {/* the cold flat-top: a griddle plate, a spatula resting on it */}
          <rect x="226" y="148" width="150" height="16" rx="3" fill="#F9F0E1" />
          <path d="M236 164 V178 M366 164 V178" />
          <path d="M252 140 L300 140 M300 140 L336 124" />
          <rect x="250" y="134" width="30" height="10" rx="2" fill="#F9F0E1" />
          {/* frost ticks: the flat-top is cold */}
          <path className={c.frost} d="M262 116 v-8 M258 112 h8 M318 108 v-8 M314 104 h8 M350 118 v-8 M346 114 h8" />
          {/* the counter top + front */}
          <path d="M16 180 H404" strokeWidth="5" />
          <rect x="30" y="186" width="360" height="54" rx="6" fill="#F9F0E1" />
          <path d="M30 206 H390" />
          {/* stools */}
          <g>
            <ellipse cx="96" cy="258" rx="26" ry="7" fill="#FED561" />
            <path d="M96 265 V296 M80 296 H112" />
            <ellipse cx="210" cy="258" rx="26" ry="7" fill="#FED561" />
            <path d="M210 265 V296 M194 296 H226" />
            <ellipse cx="324" cy="258" rx="26" ry="7" fill="#FED561" />
            <path d="M324 265 V296 M308 296 H340" />
          </g>
          {/* the order bell nobody is ringing */}
          <path d="M156 178 Q156 160 172 160 Q188 160 188 178 Z" fill="#F9F0E1" />
          <path d="M172 160 v-5" />
        </g>
      </svg>
      {/* The burger stands on the counter top (y=180 of 300 → 60%). */}
      <div className={c.dinerCast}>
        <Companion kind="burger" placement="inline" size={132} mood="gasp" />
      </div>
    </div>
  )
}

// ─── stackd: cream die-cut sticker, a paper bag, coffee peeking out ─────────

function StackdSticker() {
  return (
    <div className={c.sticker}>
      <svg className={c.stickerDie} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
        <path d={STACKD_DIE} fill="#FCE8CE" />
        <path d={STACKD_DIE} fill="none" stroke="#7C2946" strokeWidth="1.4" strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke" transform="translate(50 50) scale(0.9) translate(-50 -50)" />
      </svg>
      <div className={c.stickerInner}>
        {/* The coffee sits BEHIND the bag and peeks over its fold. */}
        <div className={c.peek}>
          <Companion kind="coffee" placement="inline" size={140} mood="wave" />
        </div>
        <svg className={c.bag} viewBox="0 0 180 200" aria-hidden focusable="false">
          <g stroke="#3D1122" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
            {/* folded top */}
            <path d="M22 44 L40 22 H140 L158 44 Z" fill="#E9CFAE" />
            {/* body */}
            <path d="M22 44 H158 L150 192 H30 Z" fill="#F3DCBC" />
            {/* side gusset creases */}
            <path d="M40 44 L36 192 M140 44 L144 192" fill="none" strokeOpacity="0.35" />
          </g>
          {/* the brand stamp on the bag */}
          <g transform="translate(90 118)">
            <circle r="34" fill="#7C2946" />
            <text y="7" textAnchor="middle" fill="#FCE8CE"
              style={{ font: "700 20px var(--stackd-display, 'Playfair Display', Georgia, serif)" }}>
              stackd
            </text>
          </g>
        </svg>
      </div>
    </div>
  )
}
