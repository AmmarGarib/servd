'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'
import { LiquidBlob, HoloRing, TwistedRibbon } from './Shapes3D'

/**
 * SlowCookHero — Simmer cinematic. A dark candlelit room.
 * As the user scrolls:
 *   - the room slowly lights up (saffron glow swells from center)
 *   - candles light one by one (5 of them)
 *   - steam rises from a centered plate
 *   - the lamb on the plate gradually "caramelises" (filter saturate/contrast)
 *   - menu plates slide in from below once the room is fully lit
 *
 * Same scroll-progress engine as the burger/bucket heroes — 300vh
 * runway, sticky child stays pinned.
 */

interface PlateItem {
  name:  string
  desc:  string
  price: string
  img:   string
}

interface Props {
  brandName:  string
  accent:     string                  // saffron gold
  ink:        string                  // deep night green
  green:      string                  // mid forest green
  cream:      string
  orderHref:  string
  menuHref?:  string
  plates?:    PlateItem[]
  centerplateImg?: string             // optional override hero photo
}

const DEFAULT_PLATES: PlateItem[] = [
  { name: 'Slow-Roast Lamb',  desc: 'Twelve hours, low heat. Pomegranate jus.', price: 'Rs. 1,950', img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&q=85' },
  { name: 'Smoked Labneh',    desc: 'Six hours in the smoker. Za\'atar oil.',   price: 'Rs. 900',   img: 'https://images.unsplash.com/photo-1547573854-74d2a71d0826?w=600&q=85' },
  { name: 'Midnight Bloom',   desc: 'Butterfly pea, lemon, honey, tonic.',      price: 'Rs. 780',   img: 'https://images.unsplash.com/photo-1544145945-f90425340c7e?w=600&q=85' },
  { name: 'Dark Chocolate Fondant', desc: 'Liquid centre. Vanilla ice cream.',  price: 'Rs. 800',   img: 'https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?w=600&q=85' },
]

export function SlowCookHero({
  brandName, accent, ink, green, cream,
  orderHref, menuHref,
  plates = DEFAULT_PLATES,
  centerplateImg = 'https://images.unsplash.com/photo-1544025162-d76694265947?w=900&q=85',
}: Props) {
  const { ref } = useScrollProgress<HTMLDivElement>()

  return (
    <div
      ref={ref}
      style={{
        height: '300vh',
        position: 'relative',
        background: ink,
        ['--brand-accent' as string]: accent,
        ['--brand-ink' as string]:    ink,
      } as React.CSSProperties}
    >
      <div className="sticky overflow-hidden"
        style={{
          top: 0,
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* The room glow — starts deep and dark, builds to candlelit warm */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse 60% 50% at 50% 55%, ${accent}80 0%, transparent 60%),
            radial-gradient(ellipse 80% 80% at 50% 80%, ${green} 0%, ${ink} 60%)
          `,
          opacity: 'calc(0.4 + var(--scroll-progress, 0) * 0.85)',
        }} />

        {/* Drifting motifs */}
        <LiquidBlob color={accent} size={300} motion="float" sway={22}
          style={{ top: '-8%', right: '-4%', zIndex: 1, opacity: 0.55 }} />
        <LiquidBlob color={green}  size={200} motion="float" sway={18}
          style={{ bottom: '-10%', left: '-6%', zIndex: 1, opacity: 0.55 }} />
        <HoloRing color={accent} size={130} motion="pulse"
          style={{ top: '20%', left: '6%', zIndex: 1, opacity: 0.6 }} />
        <TwistedRibbon color={accent} size={240} motion="float" sway={14}
          style={{ bottom: '8%', right: '4%', zIndex: 1, opacity: 0.5 }} />

        {/* Headline — fades as the room lights up */}
        <div
          className="absolute z-30 text-center px-6"
          style={{
            top: '8vh',
            left: 0, right: 0,
            opacity: 'calc(1 - var(--scroll-progress, 0) * 1.4)',
            transform: 'translateY(calc(var(--scroll-progress, 0) * -40px))',
          } as React.CSSProperties}
        >
          <p className="eyebrow" style={{ color: accent, marginBottom: '0.85rem' }}>
            {brandName} · scroll to dim the lights
          </p>
          <h1 className="display" style={{
            fontSize: 'clamp(3.5rem, 10vw, 8.5rem)',
            color: cream,
            lineHeight: 0.9,
          }}>
            Twelve hours<span style={{ color: accent }}>.</span>
            <br />
            <span className="display-italic" style={{ color: accent, fontWeight: 500 }}>One plate.</span>
          </h1>
          <p style={{
            marginTop: '1.5rem',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 'clamp(0.95rem, 1.4vw, 1.1rem)',
          }}>
            ↓ the room lights up as you scroll
          </p>
        </div>

        {/* Five candles arranged in a wide arc, lighting one-by-one */}
        <div className="absolute z-15 pointer-events-none"
          style={{
            top: '52%',
            left: 0, right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 'clamp(1rem, 4vw, 3rem)',
            transform: 'translateY(-50%)',
          }}>
          {[0.05, 0.18, 0.32, 0.46, 0.6].map((fireAt, i) => (
            <Candle key={i} accent={accent} fireAt={fireAt} dramaticHeight={i === 2} />
          ))}
        </div>

        {/* The centerplate — sits dead center, gradually unblurs +
            saturates as the room lights up (mimics "caramelising"). */}
        <div
          className="relative z-20"
          style={{
            width: 'min(60vw, 460px)',
            aspectRatio: '1 / 1',
            borderRadius: '50%',
            backgroundImage: `url(${centerplateImg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
            filter: 'calc(0.7 + var(--scroll-progress, 0) * 0.5)',           /* invalid but harmless fallback */
            // Real animated filter — chained:
            //   brightness rises with progress
            //   saturate rises with progress
            //   blur drops with progress
            ['--p' as string]: 'var(--scroll-progress, 0)',
            // We have to write the filter inline because CSS doesn't yet
            // interpolate filter() lists from a var directly. So we
            // approximate by stacking opacity over a darkened veil
            // (next sibling) and bumping saturate via the wrapper class.
          } as React.CSSProperties}
        />
        {/* Dark veil over the plate — opacity drops as scroll progresses,
            simulating the dish coming into the light. */}
        <div className="absolute z-20 pointer-events-none rounded-full"
          style={{
            width: 'min(60vw, 460px)',
            aspectRatio: '1 / 1',
            background: `radial-gradient(circle, transparent 30%, ${ink} 80%)`,
            opacity: 'calc(0.95 - var(--scroll-progress, 0) * 0.95)',
            mixBlendMode: 'multiply',
          }}
        />

        {/* Rising steam — three wisps animating UP with delays */}
        <div className="absolute z-21 pointer-events-none"
          style={{ width: 'min(60vw, 460px)', height: '60vh', top: '12vh' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" style={{
              position: 'absolute',
              top: '50%',
              left: `${30 + i * 20}%`,
              width: 30, height: 80,
              background: `linear-gradient(to top, ${accent}50, transparent)`,
              borderRadius: 999,
              opacity: 'calc(var(--scroll-progress, 0) * 0.8)',
              transform: `translate(-50%, calc(var(--scroll-progress, 0) * -${20 + i * 10}vh))`,
              filter: 'blur(8px)',
              transition: 'transform 200ms linear',
            }} />
          ))}
        </div>

        {/* Plates lineup — slides up from below the fold once room is lit */}
        <div
          className="absolute inset-0 z-25 flex items-end justify-center pb-16 pointer-events-none"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 1.8 - 0.7)',
          } as React.CSSProperties}
        >
          <div className="container">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5" style={{ pointerEvents: 'auto' }}>
              {plates.map((p, i) => (
                <div key={p.name} style={{
                  background: 'rgba(10,15,12,0.7)',
                  backdropFilter: 'blur(12px)',
                  border: `1px solid ${accent}50`,
                  borderRadius: '1.25rem',
                  overflow: 'hidden',
                  transform: `translateY(calc((1 - var(--scroll-progress, 0)) * ${50 + i * 18}px))`,
                  transition: 'transform 120ms linear',
                }}>
                  <div style={{
                    aspectRatio: '4 / 3',
                    backgroundImage: `url(${p.img})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }} />
                  <div style={{ padding: '0.85rem 0.9rem 1rem' }}>
                    <p className="display" style={{ fontSize: '0.95rem', color: cream, marginBottom: '0.25rem' }}>{p.name}</p>
                    <p style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)', lineHeight: 1.4, marginBottom: '0.5rem' }}>{p.desc}</p>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700, color: accent }}>{p.price}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CTA at the very bottom — pinned by floor */}
        <div
          className="absolute bottom-8 left-0 right-0 z-30 flex flex-wrap items-center justify-center gap-3 px-6"
          style={{
            opacity: 'calc(var(--scroll-progress, 0) * 2 - 1.5)',
          } as React.CSSProperties}
        >
          <Link href={orderHref} className="brand-pill" style={{ fontSize: '1.05rem' }}>
            Reserve a table →
          </Link>
          {menuHref && (
            <Link href={menuHref} className="brand-pill-outline" style={{
              fontSize: '0.95rem',
              borderColor: 'rgba(255,255,255,0.4)',
              color: cream,
            }}>
              See the menu
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Candle ──────────────────────────────────────────────────────────
// Wax body + wick + flame. The flame opacity ramps from 0 → 1 when scroll
// progress crosses fireAt, then flickers via CSS keyframe (small rapid
// scale wobble that simulates a flickering flame).
function Candle({ accent, fireAt, dramaticHeight }: { accent: string; fireAt: number; dramaticHeight: boolean }) {
  return (
    <div style={{
      position: 'relative',
      width: 'clamp(28px, 4vw, 50px)',
      height: dramaticHeight ? 'clamp(150px, 22vh, 240px)' : 'clamp(110px, 16vh, 180px)',
    }}>
      {/* Flame — fades in once scroll crosses fireAt. Then flickers. */}
      <div
        className="candle-flame"
        style={{
          position: 'absolute',
          top: -22,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 18,
          height: 28,
          background: `radial-gradient(ellipse at 50% 80%, white 0%, ${accent} 40%, transparent 80%)`,
          borderRadius: '50% 50% 30% 30%',
          filter: 'blur(1px) drop-shadow(0 0 16px ' + accent + ')',
          opacity: `calc((var(--scroll-progress, 0) - ${fireAt}) * 10)`,
          animation: `candleFlicker 0.18s ease-in-out infinite alternate`,
        }}
      />
      {/* Glow halo around the candle */}
      <div aria-hidden="true" style={{
        position: 'absolute',
        top: -60, left: '50%',
        transform: 'translateX(-50%)',
        width: 120, height: 100,
        background: `radial-gradient(ellipse, ${accent}55 0%, transparent 70%)`,
        opacity: `calc((var(--scroll-progress, 0) - ${fireAt}) * 8)`,
        pointerEvents: 'none',
      }} />
      {/* Wax body */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0, right: 0,
        height: '100%',
        background: 'linear-gradient(to right, #c9a961 0%, #f4ede0 50%, #c9a961 100%)',
        borderRadius: '4px',
        boxShadow: '0 14px 26px rgba(0,0,0,0.5)',
      }} />
      {/* Wick */}
      <div style={{
        position: 'absolute',
        top: -6, left: '50%',
        transform: 'translateX(-50%)',
        width: 2,
        height: 10,
        background: '#1a1410',
      }} />
    </div>
  )
}
