'use client'
// servd home hero — a food-forward scroll experience.
//
// Food cards on a clean deep-royal-purple gradient (NO starfield / "space"
// look). As you scroll the band, the cards drift outward, scale up and fade —
// a calm "fly through the kitchens" feel — while the wordmark stays legible
// over a soft scrim. Pure DOM/CSS (no WebGL/three.js): SSR-safe so the food is
// painted on first render, lighter, and robust. Honours prefers-reduced-motion
// (cards sit still). Admin-editable: pass `images` (CMS slug
// `servd:home-experience`); falls back to placeholder food photos.

import { useEffect, useRef, useState } from 'react'
import { MagneticLink } from './MagneticButton'

// Placeholder food photos (Unsplash). Swapped out the moment the operator adds
// images in the admin block editor.
const PLACEHOLDER_FOODS = [
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=700&q=75&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=700&q=75&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=700&q=75&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=700&q=75&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=700&q=75&auto=format&fit=crop',
]

// Base layout + per-card drift vector (applied × scroll progress). Positions are
// percentages of the sticky viewport; drift is in px.
const CARDS = [
  { left: '11%', top: '24%', rot: -7, dx: -190, dy: -60, z: 1 },
  { left: '55%', top: '22%', rot:  6, dx:  210, dy: -70, z: 1 },
  { left: '18%', top: '54%', rot:  3, dx: -150, dy:  150, z: 1 },
  { left: '40%', top: '58%', rot:  4, dx:    0, dy:  200, z: 1 },
  { left: '60%', top: '54%', rot: -5, dx:  180, dy:  140, z: 1 },
]

interface Props {
  images?: string[]
  heading?: string
  sublines?: string[]
}

export default function FoodScrollExperience({
  images,
  heading = 'servd',
  sublines = ['Real food, from real kitchens — delivered.'],
}: Props) {
  const imgs = images && images.length > 0 ? images : PLACEHOLDER_FOODS
  const sectionRef = useRef<HTMLDivElement>(null)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const isReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    setReduced(isReduced)
    const section = sectionRef.current
    if (isReduced || !section) return

    let raf = 0
    const update = () => {
      raf = 0
      const rect = section.getBoundingClientRect()
      const total = rect.height - window.innerHeight
      const scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1))
      const p = total > 0 ? scrolled / total : 0
      section.style.setProperty('--p', p.toFixed(4))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return (
    <section
      ref={sectionRef}
      aria-label="servd — the food"
      style={{
        // --p is driven by scroll (0→1). Default 0 so SSR / reduced-motion is static.
        ['--p' as string]: 0,
        position: 'relative',
        height: reduced ? '100vh' : '200vh',
        // Clean brand-purple gradient — no stars, no space.
        background: 'radial-gradient(120% 100% at 50% 0%, #6B3A6B 0%, #4E2A4F 42%, #1E1420 100%)',
      }}
    >
      <div style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden' }}>
        {/* Food cards — drift outward, scale up and fade as --p grows. */}
        {CARDS.map((c, i) => {
          const src = imgs[i % imgs.length]!
          return (
            <div
              key={i}
              aria-hidden
              style={{
                position: 'absolute',
                left: c.left,
                top: c.top,
                width: 'clamp(150px, 22vw, 300px)',
                height: 'clamp(190px, 28vw, 380px)',
                borderRadius: '16px',
                backgroundImage: `url(${src})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
                border: '1px solid rgba(255,255,255,0.08)',
                zIndex: c.z,
                transformOrigin: 'center',
                transform: `translate(calc(${c.dx}px * var(--p)), calc(${c.dy}px * var(--p))) rotate(${c.rot}deg) scale(calc(1 + 0.55 * var(--p)))`,
                opacity: `calc(1 - max(0, var(--p) - 0.5) * 2)`,
                willChange: 'transform, opacity',
              }}
            />
          )
        })}

        {/* Soft scrim so the wordmark stays legible over the food. */}
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(46% 36% at 50% 47%, rgba(27,8,56,0.86), rgba(27,8,56,0.12) 78%)', pointerEvents: 'none' }} />

        {/* Hero overlay — wordmark (Syne) + tagline + CTAs. Container is
            click-through; the CTA row opts back into pointer events. */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem', pointerEvents: 'none' }}>
          <div style={{ transform: 'scale(calc(1 + 0.1 * var(--p)))', transformOrigin: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h1 style={{ fontFamily: 'var(--font-wordmark)', fontWeight: 800, color: '#EDE6D3', fontSize: 'clamp(3.2rem, 12vw, 9rem)', letterSpacing: '-0.04em', lineHeight: 0.88, textShadow: '0 12px 60px rgba(0,0,0,0.7)', margin: 0 }}>
              {heading}<span style={{ color: '#E94E1B' }}>.</span>
            </h1>
            {sublines.map((s, i) => (
              <p key={i} style={{ fontFamily: 'var(--font-wordmark)', color: 'rgba(237,230,211,0.94)', fontSize: 'clamp(1.05rem, 2.6vw, 1.6rem)', fontWeight: 600, letterSpacing: '0.01em', margin: '1rem 0 0', textShadow: '0 2px 16px rgba(0,0,0,0.7)' }}>{s}</p>
            ))}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center', marginTop: '2rem', pointerEvents: 'auto' }}>
              <MagneticLink href="/browse" style={{ background: 'white', color: '#4E2A4F', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(1rem, 1.4vw, 1.15rem)', padding: '1.05rem 2rem', borderRadius: '999px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.6rem', boxShadow: '0 12px 32px rgba(0,0,0,0.35)' }}>
                Order now <span aria-hidden style={{ opacity: 0.65 }}>→</span>
              </MagneticLink>
              <MagneticLink href="#brands" style={{ color: 'white', fontWeight: 700, fontSize: '0.95rem', padding: '1.05rem 1.5rem', borderRadius: '999px', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.35)', textDecoration: 'none', backdropFilter: 'blur(6px)' }}>
                See the kitchens
              </MagneticLink>
            </div>
          </div>
        </div>

        {/* Scroll progress bar. */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '3px', background: 'rgba(237,230,211,0.12)' }}>
          <div style={{ height: '100%', width: 'calc(var(--p) * 100%)', background: 'linear-gradient(90deg, #6D28D9, #E94E1B)' }} />
        </div>
      </div>
    </section>
  )
}
