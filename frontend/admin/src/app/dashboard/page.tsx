'use client'
// /dashboard — the chooser. Three split dashboards live one level
// deeper at /dashboard/ceo, /dashboard/boh, /dashboard/foh. This
// landing presents all three as big tiles so staff (regardless of
// role) can pick the right view. Future iteration: route automatically
// based on staff role on sign-in.

import Link from 'next/link'

interface Tile {
  href:    string
  title:   string
  blurb:   string
  meant:   string
  accent:  string
  dim:     string
}

const TILES: Tile[] = [
  {
    href:   '/dashboard/ceo',
    title:  'CEO',
    blurb:  'how the business is doing this week',
    meant:  'For ownership — revenue, margin, AOV, repeat-rate, per-brand. Glanceable scorecards, daily-cadence.',
    accent: '#00D4B1',
    dim:    'rgba(0,212,177,0.10)',
  },
  {
    href:   '/dashboard/boh',
    title:  'Back of House',
    blurb:  'live view of the kitchen line',
    meant:  'For kitchen lead / chef — live ticket queue, oldest ticket, station load, 86 list, low stock. Refreshes live.',
    accent: '#4F8EF7',
    dim:    'rgba(79,142,247,0.10)',
  },
  {
    href:   '/dashboard/foh',
    title:  'Front of House',
    blurb:  'live view of the floor',
    meant:  'For GM / floor manager — reservations, curbside queue, open complaints, staff on shift. Refreshes live.',
    accent: '#F59E0B',
    dim:    'rgba(245,158,11,0.10)',
  },
]

export default function DashboardChooser() {
  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '2rem 1.25rem 6rem' }}>
      <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
        <p style={{
          fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em',
          textTransform: 'uppercase', color: '#6E7186', margin: 0,
        }}>
          dashboards
        </p>
        <h1 style={{
          fontSize: 'clamp(1.6rem, 4vw, 2.2rem)',
          letterSpacing: '-0.02em', margin: '0.4rem 0 0',
        }}>
          Pick a view.
        </h1>
        <p style={{ color: '#6E7186', margin: '0.6rem 0 0', maxWidth: '36rem', fontSize: '0.92rem', lineHeight: 1.5 }}>
          We split the old single page into three. Each one has its own audience and its own refresh cadence; pick the one that fits what you&rsquo;re doing right now.
        </p>

        <div style={{
          marginTop: 'clamp(2rem, 5vh, 3rem)',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1rem',
        }}>
          {TILES.map((t) => (
            <Link key={t.href} href={t.href}
              style={{
                display: 'block',
                padding: '1.6rem 1.4rem',
                borderRadius: '1.1rem',
                background: t.dim,
                border: `1px solid ${t.accent}30`,
                color: 'inherit',
                textDecoration: 'none',
                transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform   = 'translateY(-2px)'
                e.currentTarget.style.boxShadow   = `0 12px 28px ${t.accent}22`
                e.currentTarget.style.borderColor = `${t.accent}66`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform   = 'translateY(0)'
                e.currentTarget.style.boxShadow   = 'none'
                e.currentTarget.style.borderColor = `${t.accent}30`
              }}
            >
              <p style={{
                fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.32em',
                textTransform: 'uppercase', color: t.accent, margin: 0,
              }}>
                {t.title}
              </p>
              <p style={{
                fontSize: 'clamp(1.3rem, 2.4vw, 1.6rem)',
                fontWeight: 700, letterSpacing: '-0.015em',
                margin: '0.6rem 0 0', lineHeight: 1.15,
              }}>
                {t.blurb}
              </p>
              <p style={{ color: '#6E7186', fontSize: '0.82rem', lineHeight: 1.5, margin: '0.9rem 0 0' }}>
                {t.meant}
              </p>
              <p style={{ marginTop: '1.2rem', fontSize: '0.78rem', fontWeight: 600, color: t.accent }}>
                Open →
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
