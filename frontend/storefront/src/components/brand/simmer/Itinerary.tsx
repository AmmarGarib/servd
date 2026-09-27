'use client'
// Tonight's service — three walnut-framed pictures hung off one rail, like an
// evening's itinerary: the space, the plate, the pour.
//
// Alive, quietly:
//   • each frame is hung as it arrives — it drops a few pixels and settles
//     off a slight tilt, the way a picture finds its nail;
//   • the picture inside drifts slower than the frame (parallax), so the
//     frames read as windows rather than stickers;
//   • the plate and the coupe are drawn in line by line once hung, then the
//     plate steams and the glass keeps a slow tilt;
//   • one orange ember travels down the rail as you read. It is the only
//     orange on this bone ground — the rail, the stops and the date are ink.
//
// Frames are flat walnut with a hard offset shadow (no wood-grain gradient,
// no blurred shadow). Reduced motion: frames hang still, pictures don't
// drift, the ember sits at the first stop, sketches are drawn already.

import { useRef, type CSSProperties, type ReactNode } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { useLitCandleOnScreen } from './litCandles'
import { Reveal, useReducedMotionAfterMount } from './reveal'
import s from './simmer.module.css'

function Parallax({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const reduce = useReducedMotionAfterMount()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], ['-7%', '7%'])
  return (
    <div ref={ref} className={s.picture}>
      <motion.div className={s.parallax} style={{ y: reduce ? 0 : y }}>
        {children}
      </motion.div>
    </div>
  )
}

function Stop({ side, label, children }: { side: 'left' | 'right', label: string, children: ReactNode }) {
  return (
    <Reveal
      className={s.stop}
      style={{ alignItems: side === 'right' ? 'flex-end' : 'flex-start' }}
    >
      {/* Frame zone is full width so the stop dot (left: 50%) lands on the
          rail and top: 50% centres it on the picture at any frame size. */}
      <div className={s.stopFrameZone} style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: side === 'right' ? 'flex-end' : 'flex-start' }}>
        <span aria-hidden="true" className={s.stopDot} />
        <div className={s.frame}>
          <div className={s.mat}>
            <Parallax>{children}</Parallax>
          </div>
        </div>
      </div>
      {/* Museum label, tucked under the frame's own edge. Tiber ink on bone
          at full strength (10.3:1). */}
      <p className={`${s.utility} ${s.label}`} style={{ textAlign: side === 'right' ? 'right' : 'left' }}>
        {label}
      </p>
    </Reveal>
  )
}

// ─── Top-down plate, drawn in bone line, steaming ───────────────────────
function PlateSketch() {
  const ink = (i: number): CSSProperties => ({ ['--i' as string]: i } as CSSProperties)
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice"
         style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="var(--simmer-green)" />
      <g fill="none" stroke="var(--simmer-bone)" strokeLinecap="round">
        <circle className={s.ink} style={ink(0)} pathLength={1} cx="100" cy="84" r="54" strokeWidth="1.2" strokeOpacity="0.7" />
        <circle className={s.ink} style={ink(1)} pathLength={1} cx="100" cy="84" r="44" strokeWidth="0.6" strokeOpacity="0.4" />
        {/* Sauce swipe */}
        <path className={s.ink} style={ink(2)} pathLength={1} d="M78 98 Q 100 108, 124 98" strokeWidth="2.2" strokeOpacity="0.35" />
        {/* The protein */}
        <ellipse className={s.ink} style={ink(3)} pathLength={1} cx="104" cy="84" rx="17" ry="10" transform="rotate(-18 104 84)" strokeWidth="1" strokeOpacity="0.8" />
        {/* Herb strokes */}
        <path className={s.ink} style={ink(4)} pathLength={1} d="M84 74 l6 -6 M90 78 l5 -5 M86 82 l6 -3" strokeWidth="0.8" strokeOpacity="0.75" />
      </g>
      <circle cx="120" cy="96" r="2" fill="var(--simmer-bone)" opacity="0.7" />
      <circle cx="80" cy="90" r="1.3" fill="var(--simmer-bone)" opacity="0.6" />
      {/* Steam off the plate — flat bone strokes that rise and fade. */}
      <g fill="none" stroke="var(--simmer-bone)" strokeWidth="1.1" strokeLinecap="round">
        <path className={s.steam} style={ink(0)} d="M92 60 C 88 52, 96 46, 92 38" strokeOpacity="0.5" />
        <path className={s.steam} style={ink(1)} d="M104 58 C 100 50, 108 44, 104 34" strokeOpacity="0.5" />
        <path className={s.steam} style={ink(2)} d="M115 61 C 111 54, 118 48, 114 41" strokeOpacity="0.5" />
      </g>
    </svg>
  )
}

// ─── Coupe, drawn in bone line, with a slow tilt and rising bubbles ─────
function CoupeSketch() {
  const ink = (i: number): CSSProperties => ({ ['--i' as string]: i } as CSSProperties)
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 200 160" preserveAspectRatio="xMidYMid slice"
         style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="160" fill="var(--simmer-green)" />
      {/* The pour — flat walnut, so the only orange on the page stays the ember. */}
      <g className={s.surface}>
        <path d="M58 62 Q 70 92, 100 98 Q 130 92, 142 62 Z" fill="var(--simmer-walnut)" />
        <ellipse cx="100" cy="62" rx="42" ry="5.5" fill="none" stroke="var(--simmer-bone)" strokeOpacity="0.5" strokeWidth="0.7" />
      </g>
      <g fill="none" stroke="var(--simmer-bone)" strokeLinecap="round" strokeWidth="1.2" strokeOpacity="0.75">
        <ellipse className={s.ink} style={ink(0)} pathLength={1} cx="100" cy="58" rx="50" ry="11" />
        <path className={s.ink} style={ink(1)} pathLength={1} d="M50 58 Q 52 94, 100 102 Q 148 94, 150 58" />
        <path className={s.ink} style={ink(2)} pathLength={1} d="M100 102 V 138" />
        <ellipse className={s.ink} style={ink(3)} pathLength={1} cx="100" cy="142" rx="30" ry="4" />
        <path className={s.ink} style={ink(4)} pathLength={1} d="M62 56 Q 78 48, 96 46" strokeWidth="1" />
      </g>
      {/* Twist of peel on the rim */}
      <ellipse cx="122" cy="56" rx="6" ry="2" transform="rotate(-20 122 56)" fill="var(--simmer-bone)" opacity="0.85" />
      {/* Bubbles */}
      {[[86, 88], [94, 92], [110, 90]].map(([cx, cy], i) => (
        <circle key={i} className={s.bubble} style={ink(i)} cx={cx} cy={cy} r={i === 1 ? 0.9 : 1.3}
                fill="none" stroke="var(--simmer-bone)" strokeWidth="0.6" />
      ))}
    </svg>
  )
}

export function Itinerary({ spaceImage }: { spaceImage: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const reduce = useReducedMotionAfterMount()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 75%', 'end 45%'] })
  const top = useTransform(scrollYProgress, [0, 1], ['4%', '96%'])
  // The ember burns out at the end of the rail, so it never shares a screen
  // with the candle in the next scene — one orange per viewport.
  const opacity = useTransform(scrollYProgress, [0, 0.04, 0.78, 0.94], [0, 1, 1, 0])
  // And if a lit candle is on screen anyway (a tall phone viewport, a fast
  // fling), the ember sets in ink: the candle keeps the one orange.
  const candleLit = useLitCandleOnScreen()
  return (
    <div ref={ref} style={{ position: 'relative', padding: '0.5rem 0' }}>
      <div aria-hidden="true" className={s.rail} />
      <motion.span aria-hidden="true" className={`${s.railEmber} ${candleLit ? s.railEmberInk : ''}`} style={{ top: reduce ? '4%' : top, opacity: reduce ? 1 : opacity }} />

      <Stop side="left" label="the space">
        {/* Decorative — the label names it. Lazy: it sits below a tall hero. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={spaceImage} alt="" loading="lazy" decoding="async" />
      </Stop>
      <Stop side="right" label="the plate">
        <PlateSketch />
      </Stop>
      <Stop side="left" label="the pour">
        <CoupeSketch />
      </Stop>
    </div>
  )
}
