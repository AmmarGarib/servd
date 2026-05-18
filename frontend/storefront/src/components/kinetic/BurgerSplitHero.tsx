'use client'
import Link from 'next/link'
import { BurgerStack } from './BurgerLayers'
import { useScrollProgress } from './motionHooks'
import { ChromeBurst, SquiggleArrow, PerforatedSphere } from './Shapes3D'

/**
 * BurgerSplitHero — cinematic scroll-driven opener for the Flipd (burger)
 * brand. A sticky 300vh-tall section pins the burger at viewport center
 * while the user scrolls; CSS reads --scroll-progress (driven by
 * useScrollProgress) and animates the six burger layers apart. Behind
 * the burger, four menu cards fade up into view as the gap widens. When
 * progress hits ~0.9 the headline above re-resolves into a CTA.
 *
 * This is "the wild shit" — a single hero that takes ~3 vertical screens
 * of scroll, but each scroll-tick rewards with motion. After it the
 * normal page resumes.
 */

interface MenuItem {
  name:   string
  desc:   string
  price:  string
  emoji:  string
}

interface Props {
  brandName:   string
  accent:      string                  // brand primary — fires gradients
  ink:         string                  // brand dark — background
  orderHref:   string                  // CTA destination ("/<slug>")
  menuHref?:   string
  menuItems?:  MenuItem[]              // the reveal — what shows up behind the split burger
  headline?:   string                  // optional override for the hero copy
  tagline?:    string
}

const DEFAULT_MENU: MenuItem[] = [
  { name: 'The Classic',    desc: 'Smash patty, american cheese, lettuce, tomato, pickle, our sauce.', price: 'Rs. 950',  emoji: '🍔' },
  { name: 'Double Smoke',   desc: 'Two patties, smoked cheddar, crispy onion, BBQ glaze, brioche.',     price: 'Rs. 1,250', emoji: '🔥' },
  { name: 'Hot Honey Crunch', desc: 'Buttermilk-brined chicken, hot honey, pickles, slaw, sesame brioche.', price: 'Rs. 1,150', emoji: '🌶' },
  { name: 'Garden Stack',   desc: 'Lentil-mushroom patty, smashed avocado, sun-dried tomato, sourdough.',    price: 'Rs. 1,050', emoji: '🥗' },
]

export function BurgerSplitHero({
  brandName, accent, ink, orderHref, menuHref,
  menuItems = DEFAULT_MENU,
  headline = 'Stack it',
  tagline  = 'as wild as you want',
}: Props) {
  const { ref } = useScrollProgress<HTMLDivElement>()

  return (
    <div
      ref={ref}
      className="burger-split-hero"
      style={{
        // 300vh tall — enough scroll runway for the layers to fully
        // separate. The sticky child stays pinned for the whole travel.
        height: '300vh',
        position: 'relative',
        background: ink,
        color: 'white',
        ['--brand-accent' as string]: accent,
        ['--brand-ink' as string]:    ink,
      } as React.CSSProperties}
    >
      {/* Sticky stage — pinned at viewport top for the full 300vh of
          parent scroll. Every animated element lives inside this. */}
      <div
        className="sticky overflow-hidden"
        style={{
          top: 0,
          height: '100vh',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Ambient brand glow — radial wash sized off scroll progress so
            the room "lights up" as the burger comes apart. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 50% 50%, ${accent}55 0%, transparent calc(40% + var(--scroll-progress, 0) * 30%))`,
          opacity: 'calc(0.4 + var(--scroll-progress, 0) * 0.6)',
        }} />

        {/* Drifting kinetic decorations behind the burger */}
        <PerforatedSphere color={accent} size={260} motion="float" sway={26}
          style={{ top: '-8%', right: '-4%', zIndex: 1, opacity: 0.7 }} />
        <ChromeBurst color={accent} size={140} motion="spin"
          style={{ bottom: '10%', left: '4%', zIndex: 1, opacity: 0.7 }} />
        <SquiggleArrow color="white" size={120} motion="float" sway={10}
          style={{ top: '14%', left: '6%', zIndex: 1, opacity: 0.5 }} />

        {/* Headline — fades + shrinks as scroll progresses so the burger
            takes over the canvas. */}
        <div
          className="absolute z-30 text-center px-6"
          style={{
            top: '8vh',
            left: 0, right: 0,
            opacity: 'calc(1 - var(--scroll-progress, 0) * 1.4)',
            transform: 'translateY(calc(var(--scroll-progress, 0) * -40px)) scale(calc(1 - var(--scroll-progress, 0) * 0.15))',
            transition: 'opacity 60ms linear',
          } as React.CSSProperties}
        >
          <p className="eyebrow" style={{ color: accent, marginBottom: '0.85rem' }}>
            {brandName} · scroll
          </p>
          <h1 className="display" style={{
            fontSize: 'clamp(3.5rem, 11vw, 9rem)',
            color: 'white',
            lineHeight: 0.85,
          }}>
            {headline}<span style={{ color: accent }}>.</span>
            <br />
            <span className="display-italic" style={{ color: accent, fontWeight: 600 }}>{tagline}</span>
          </h1>
          <p style={{
            marginTop: '1.5rem',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 'clamp(0.95rem, 1.4vw, 1.1rem)',
          }}>
            ↓ keep scrolling
          </p>
        </div>

        {/* Menu cards — sit behind the burger, fade UP into view as the
            burger separates. Grid of 4 dishes. The cards animate
            independently so they cascade in. */}
        <div
          className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 1.4 - 0.2)',
          } as React.CSSProperties}
        >
          <div className="container">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5"
              style={{ pointerEvents: 'auto' }}>
              {menuItems.map((m, i) => (
                <div
                  key={m.name}
                  style={{
                    background: 'rgba(0,0,0,0.55)',
                    backdropFilter: 'blur(12px)',
                    border: `1px solid ${accent}40`,
                    borderRadius: '1.25rem',
                    padding: '1.25rem 1.1rem',
                    transform: `translateY(calc((1 - var(--scroll-progress, 0)) * ${60 + i * 18}px))`,
                    transition: 'transform 120ms linear',
                  }}>
                  <div style={{
                    fontSize: '2rem',
                    marginBottom: '0.5rem',
                    filter: 'drop-shadow(0 6px 12px rgba(0,0,0,0.45))',
                  }}>
                    {m.emoji}
                  </div>
                  <p className="display" style={{ fontSize: '1.15rem', color: 'white', marginBottom: '0.35rem' }}>
                    {m.name}
                  </p>
                  <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', lineHeight: 1.4, marginBottom: '0.55rem' }}>
                    {m.desc}
                  </p>
                  <p style={{ fontSize: '0.85rem', fontWeight: 700, color: accent }}>
                    {m.price}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* THE BURGER — sits front-and-center, layers fly apart on scroll */}
        <div
          className="relative z-20 flex items-center justify-center"
          style={{
            width: 'min(80vw, 720px)',
            transform: 'scale(calc(0.85 + var(--scroll-progress, 0) * 0.15))',
          } as React.CSSProperties}
        >
          <BurgerStack />
        </div>

        {/* Bottom CTA strip — appears once the burger is fully open
            (progress >= 0.8). Order pill + menu link. */}
        <div
          className="absolute bottom-8 left-0 right-0 z-30 flex flex-wrap items-center justify-center gap-3 px-6"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 2 - 1.4)',
            transform: 'translateY(calc((1 - var(--scroll-progress, 0)) * 40px))',
            transition: 'opacity 120ms linear, transform 120ms linear',
          } as React.CSSProperties}
        >
          <Link href={orderHref} className="brand-pill" style={{ fontSize: '1.05rem' }}>
            Build yours →
          </Link>
          {menuHref && (
            <Link href={menuHref} className="brand-pill-outline" style={{
              fontSize: '0.95rem',
              borderColor: 'rgba(255,255,255,0.4)',
              color: 'white',
            }}>
              See full menu
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
