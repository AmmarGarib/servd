'use client'
// The Kitchen Pass — the home-page hero as a cinematic, scroll-driven
// tasting menu. A 440vh runway pins a full-viewport kitchen scene; as the
// user scrolls, each brand's dish is "plated" in sequence on a shared
// ceramic plate: the photo irises in, ingredient close-ups drift onto the
// plate from the edges, steam rises, the room's light grades to that
// brand's hue, and a course rail (01/02/03) tracks progress. The final
// beat zooms through the plate into the page content.
//
// All motion is scroll-scrubbed (framer useScroll + useTransform) — no
// timers, fully reversible, 60fps transforms only. Reduced-motion users
// get a static hero with the same content and CTAs.

import Link from 'next/link'
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { useRef } from 'react'
import { formatBrandName } from '../lib/concept'

export interface PassCourse {
  slug: string
  name: string
  accent: string
  img: string
  tagline: string
}

interface Props {
  courses: PassCourse[]     // the three live brands, in pass order
  title: string             // operator headline (Admin → Marketing → Landing Hero)
  sub?: string
}

// Scene lighting per course — very dark, hue-shifted toward the brand.
const COURSE_BG: Record<string, string> = {
  stax:   '#111B23',   // oceanic noir
  simmer: '#08251E',   // deep tiber green
  flipd:  '#10241A',   // court green, after dark
}
const BASE_BG  = '#15101A'   // obsidian plum, lights down
const OUTRO_BG = '#1E1420'

// Phase windows on the 0..1 scroll runway.
const INTRO_END    = 0.14
const COURSES_END  = 0.86
const courseWindow = (i: number, n: number): [number, number] => {
  const span = (COURSES_END - INTRO_END) / n
  return [INTRO_END + i * span, INTRO_END + (i + 1) * span]
}

// Ingredient chips — close-up crops of the course photo that drift onto
// the plate. Angle is where the chip flies in from; zoom + focus give
// each chip a different "ingredient" crop of the same photograph.
const CHIP_LAYOUT = [
  { angle: 210, dist: 46, size: 'clamp(64px, 9vw, 116px)',  focus: '18% 26%', zoom: 2.6 },
  { angle: 330, dist: 52, size: 'clamp(52px, 7.5vw, 96px)', focus: '78% 22%', zoom: 3.1 },
  { angle: 148, dist: 56, size: 'clamp(44px, 6.5vw, 84px)', focus: '55% 80%', zoom: 2.8 },
] as const

export function KitchenPassHero({ courses, title, sub }: Props) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] })

  const n = Math.max(courses.length, 1)

  // Room lighting — grade between course hues across the runway.
  const bgStops  = [0, INTRO_END, ...courses.map((_, i) => {
    const [a, b] = courseWindow(i, n)
    return (a + b) / 2
  }), 0.93, 1]
  const bgColors = [BASE_BG, BASE_BG, ...courses.map((c) => COURSE_BG[c.slug] ?? BASE_BG), OUTRO_BG, OUTRO_BG]
  const bg = useTransform(p, bgStops, bgColors)

  // Intro beat — wordmark + operator headline, gone by INTRO_END.
  const introOpacity = useTransform(p, [0, INTRO_END * 0.7, INTRO_END], [1, 1, 0])
  const introY       = useTransform(p, [0, INTRO_END], [0, -90])
  const introScale   = useTransform(p, [0, INTRO_END], [1, 0.94])

  // The shared plate — arrives with the first course, slowly turns all
  // meal long, then zooms through the camera on the way out.
  const [firstA] = courseWindow(0, n)
  const plateOpacity = useTransform(p, [firstA - 0.05, firstA, COURSES_END, 0.97], [0, 1, 1, 0])
  const plateScale   = useTransform(p, [firstA - 0.05, firstA + 0.06, COURSES_END, 1], [0.72, 1, 1, 2.1])
  const plateRotate  = useTransform(p, [0, 1], [0, 34])

  // Scroll cue — fades the moment the user commits.
  const cueOpacity = useTransform(p, [0, 0.05], [1, 0])

  // Outro beat.
  const outroOpacity = useTransform(p, [COURSES_END, 0.94], [0, 1])
  const outroY       = useTransform(p, [COURSES_END, 0.96], [46, 0])

  if (reduce) {
    // Static hero — same content, no scrubbing.
    return (
      <section style={{
        background: BASE_BG, color: 'white', minHeight: '92vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', textAlign: 'center', padding: '7rem 1.5rem 4rem', gap: '1.25rem',
      }}>
        <h1 className="display" style={{ fontSize: 'clamp(2.8rem, 8vw, 6rem)', maxWidth: '16ch' }}>{title}</h1>
        {sub && <p style={{ color: 'rgba(255,255,255,0.75)', maxWidth: '38rem', lineHeight: 1.6 }}>{sub}</p>}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center', marginTop: '1rem' }}>
          {courses.map((c) => (
            <Link key={c.slug} href={`/${c.slug}`} className="brand-pill"
              style={{ ['--brand-accent' as string]: c.accent, ['--brand-ink' as string]: '#111' }}>
              Order {formatBrandName(c.name)}
            </Link>
          ))}
        </div>
      </section>
    )
  }

  return (
    <div ref={ref} style={{ height: `${180 + n * 90}vh`, position: 'relative' }}>
      <motion.section
        aria-label="The kitchens of servd"
        style={{
          position: 'sticky', top: 0, height: '100vh', overflow: 'hidden',
          backgroundColor: bg, color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {/* Ambient grain + vignette so the scene reads as a lit room, not a flat fill */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 90% 65% at 50% 38%, rgba(255,255,255,0.07) 0%, transparent 55%), radial-gradient(ellipse 120% 90% at 50% 110%, rgba(0,0,0,0.55) 0%, transparent 60%)',
          pointerEvents: 'none', zIndex: 1,
        }} />

        {/* ── INTRO ─ the menu cover ─────────────────────────────────── */}
        <motion.div style={{
          opacity: introOpacity, y: introY, scale: introScale,
          position: 'absolute', inset: 0, zIndex: 4,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '0 1.5rem', pointerEvents: 'none',
        }}>
          <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.55)', marginBottom: '1.2rem' }}>
            servd · karachi · three kitchens, one pass
          </p>
          <h1 className="display" style={{
            fontSize: 'clamp(3rem, 9vw, 7.5rem)', lineHeight: 0.95,
            letterSpacing: '-0.045em', maxWidth: '14ch',
            textShadow: '0 2px 40px rgba(0,0,0,0.5)',
          }}>
            {title}
          </h1>
          {sub && (
            <p style={{ marginTop: '1.5rem', color: 'rgba(255,255,255,0.7)', fontSize: 'clamp(0.98rem, 1.4vw, 1.15rem)', maxWidth: '34rem', lineHeight: 1.6 }}>
              {sub}
            </p>
          )}
        </motion.div>

        {/* ── THE PLATE — shared ceramic, all three courses land on it ── */}
        <motion.div aria-hidden style={{
          opacity: plateOpacity, scale: plateScale,
          position: 'absolute', zIndex: 2,
          width: 'min(56vh, 78vw)', height: 'min(56vh, 78vw)',
          borderRadius: '50%',
        }}>
          {/* rim + well */}
          <motion.div className="kp-plate" style={{ rotate: plateRotate, position: 'absolute', inset: 0, borderRadius: '50%' }}>
            {/* steam — two wisps looping upward above the plate */}
            <span className="kp-steam" style={{ left: '38%', animationDelay: '0s' }} />
            <span className="kp-steam" style={{ left: '56%', animationDelay: '1.6s' }} />
          </motion.div>
          {/* course photos mount inside the plate well */}
          <div style={{ position: 'absolute', inset: '4.5%', borderRadius: '50%', overflow: 'hidden', transform: 'translateZ(0)' }}>
            {courses.map((c, i) => (
              <CourseDish key={c.slug} p={p} window={courseWindow(i, n)} img={c.img} />
            ))}
          </div>
        </motion.div>

        {/* ── COURSE OVERLAYS — name behind, caption + CTA in front ──── */}
        {courses.map((c, i) => (
          <CourseCaption key={c.slug} p={p} window={courseWindow(i, n)} course={c} index={i} total={n} />
        ))}

        {/* ── INGREDIENT CHIPS ───────────────────────────────────────── */}
        {courses.map((c, i) => (
          <CourseChips key={c.slug} p={p} window={courseWindow(i, n)} img={c.img} />
        ))}

        {/* ── COURSE RAIL ────────────────────────────────────────────── */}
        <div aria-hidden style={{
          position: 'absolute', right: 'clamp(0.9rem, 3vw, 2.2rem)', top: '50%',
          transform: 'translateY(-50%)', zIndex: 5,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.9rem',
        }}>
          {courses.map((c, i) => (
            <RailDot key={c.slug} p={p} window={courseWindow(i, n)} label={String(i + 1).padStart(2, '0')} accent={c.accent} />
          ))}
          <motion.div style={{
            width: 1, height: 56, transformOrigin: 'top',
            background: 'rgba(255,255,255,0.25)', scaleY: p,
          }} />
        </div>

        {/* ── SCROLL CUE ─────────────────────────────────────────────── */}
        <motion.div style={{
          opacity: cueOpacity,
          position: 'absolute', bottom: '2rem', left: 0, right: 0, zIndex: 5,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem',
          pointerEvents: 'none',
        }}>
          <span className="eyebrow" style={{ color: 'rgba(255,255,255,0.6)' }}>scroll — dinner is plating</span>
          <span className="kp-chevron" aria-hidden />
        </motion.div>

        {/* ── OUTRO — through the plate, into the page ───────────────── */}
        <motion.div style={{
          opacity: outroOpacity, y: outroY,
          position: 'absolute', inset: 0, zIndex: 6,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '0 1.5rem', gap: '1.4rem',
        }}>
          <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.6)' }}>the pass is yours</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.6rem, 7vw, 5.5rem)', lineHeight: 0.95, letterSpacing: '-0.04em', maxWidth: '15ch' }}>
            Three kitchens.<br />
            <span className="display-italic" style={{ color: 'rgba(255,255,255,0.7)' }}>One checkout.</span>
          </h2>
          <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link href="/browse" className="glass-sheen" style={{
              background: 'rgba(255,255,255,0.94)', color: 'var(--servd-green)',
              fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem',
              padding: '1rem 1.9rem', borderRadius: '999px', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
              boxShadow: '0 16px 44px rgba(0,0,0,0.4)',
            }}>
              Order now <span aria-hidden style={{ opacity: 0.6 }}>→</span>
            </Link>
            <a href="#brands" className="glass-deep" style={{
              color: 'white', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.05rem',
              padding: '1rem 1.9rem', borderRadius: '999px', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
            }}>
              Meet the kitchens
            </a>
          </div>
        </motion.div>
      </motion.section>
    </div>
  )
}

// ─── Course dish — the photo irising onto the shared plate ──────────────

function CourseDish({ p, window: [a, b], img }: {
  p: MotionValue<number>; window: [number, number]; img: string
}) {
  const opacity = useTransform(p, [a - 0.02, a + 0.05, b - 0.045, b], [0, 1, 1, 0])
  const scale   = useTransform(p, [a - 0.02, a + 0.1, b], [1.35, 1, 1.06])
  const rotate  = useTransform(p, [a - 0.02, a + 0.12], [14, 0])
  return (
    <motion.img
      src={img}
      alt=""
      style={{
        opacity, scale, rotate,
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', borderRadius: '50%',
      }}
    />
  )
}

// ─── Course caption — giant name behind the plate, details in front ─────

function CourseCaption({ p, window: [a, b], course, index, total }: {
  p: MotionValue<number>; window: [number, number]
  course: PassCourse; index: number; total: number
}) {
  const opacity  = useTransform(p, [a, a + 0.05, b - 0.045, b], [0, 1, 1, 0])
  const nameX    = useTransform(p, [a, b], ['4%', '-4%'])
  const infoY    = useTransform(p, [a, a + 0.07], [34, 0])
  const display  = formatBrandName(course.name)
  return (
    <>
      {/* The name — a wall of type the plate sits in front of. */}
      <motion.p aria-hidden style={{
        opacity, x: nameX,
        position: 'absolute', zIndex: 1, margin: 0,
        top: '13%', left: 0, right: 0, textAlign: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 800,
        fontSize: 'clamp(4.5rem, 17vw, 15rem)',
        lineHeight: 0.9, letterSpacing: '-0.05em',
        color: 'rgba(255,255,255,0.95)',
        textShadow: '0 4px 60px rgba(0,0,0,0.45)',
        pointerEvents: 'none', whiteSpace: 'nowrap',
      }}>
        {display}<span style={{ color: course.accent }}>.</span>
      </motion.p>

      {/* The docket — course number, tagline, order CTA. */}
      <motion.div style={{
        opacity, y: infoY,
        position: 'absolute', zIndex: 4,
        bottom: 'clamp(3.4rem, 9vh, 6rem)', left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.7rem',
        textAlign: 'center', padding: '0 1.25rem',
      }}>
        <p className="eyebrow" style={{ color: course.accent, margin: 0 }}>
          course {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </p>
        <p style={{
          margin: 0, color: 'rgba(255,255,255,0.88)',
          fontFamily: 'var(--font-display)', fontWeight: 600,
          fontSize: 'clamp(1.05rem, 2vw, 1.4rem)', maxWidth: '30rem',
          textShadow: '0 2px 20px rgba(0,0,0,0.5)',
        }}>
          {course.tagline}
        </p>
        <Link href={`/${course.slug}`} style={{
          marginTop: '0.35rem',
          display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
          background: 'rgba(255,255,255,0.94)', color: '#141014',
          fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '0.95rem',
          padding: '0.75rem 1.5rem', borderRadius: '999px', textDecoration: 'none',
          boxShadow: '0 12px 34px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
        }}>
          Order from {display} <span aria-hidden style={{ opacity: 0.55 }}>→</span>
        </Link>
      </motion.div>
    </>
  )
}

// ─── Ingredient chips — close-up crops drifting onto the plate ──────────

function CourseChips({ p, window: w, img }: {
  p: MotionValue<number>; window: [number, number]; img: string
}) {
  return (
    <>
      {CHIP_LAYOUT.map((chip, j) => (
        <IngredientChip key={j} p={p} window={w} img={img} {...chip} order={j} />
      ))}
    </>
  )
}

function IngredientChip({ p, window: [a, b], img, angle, dist, size, focus, zoom, order }: {
  p: MotionValue<number>; window: [number, number]; img: string
  angle: number; dist: number; size: string; focus: string; zoom: number; order: number
}) {
  const rad = (angle * Math.PI) / 180
  const settleIn = a + 0.06 + order * 0.025
  // Fly in from outside the frame to a resting orbit near the plate,
  // then keep drifting slowly for the rest of the course.
  const x = useTransform(p, [a, settleIn, b], [
    `${Math.cos(rad) * (dist + 60)}vmin`,
    `${Math.cos(rad) * dist * 0.62}vmin`,
    `${Math.cos(rad) * dist * 0.54}vmin`,
  ])
  const y = useTransform(p, [a, settleIn, b], [
    `${Math.sin(rad) * (dist + 60) * 0.7}vmin`,
    `${Math.sin(rad) * dist * 0.5}vmin`,
    `${Math.sin(rad) * dist * 0.42}vmin`,
  ])
  const opacity = useTransform(p, [a + 0.015, settleIn, b - 0.05, b - 0.01], [0, 1, 1, 0])
  const rotate  = useTransform(p, [a, b], [order % 2 ? -26 : 22, order % 2 ? 8 : -6])
  return (
    <motion.div aria-hidden style={{
      x, y, opacity, rotate,
      position: 'absolute', zIndex: 3,
      width: size, height: size, borderRadius: '50%',
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.28)',
      boxShadow: '0 14px 34px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.3)',
      pointerEvents: 'none',
    }}>
      <img src={img} alt="" style={{
        width: '100%', height: '100%', objectFit: 'cover',
        objectPosition: focus, transform: `scale(${zoom})`,
      }} />
    </motion.div>
  )
}

// ─── Course rail dot ────────────────────────────────────────────────────

function RailDot({ p, window: [a, b], label, accent }: {
  p: MotionValue<number>; window: [number, number]; label: string; accent: string
}) {
  const active = useTransform(p, [a - 0.02, a + 0.03, b - 0.03, b + 0.02], [0.35, 1, 1, 0.35])
  const scale  = useTransform(p, [a - 0.02, a + 0.03, b - 0.03, b + 0.02], [1, 1.25, 1.25, 1])
  return (
    <motion.span style={{
      opacity: active, scale,
      fontFamily: 'var(--font-display)', fontWeight: 700,
      fontSize: '0.68rem', letterSpacing: '0.2em',
      color: accent,
    }}>
      {label}
    </motion.span>
  )
}
