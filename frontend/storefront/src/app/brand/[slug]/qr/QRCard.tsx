'use client'
// Tabletop QR card. SVG so it's print-friendly. Designed to be
// opened on a laptop, printed letter-size (or a quarter sheet, since
// the design is centred), folded, and clipped to the table card.
//
// The QR encodes the full https://… menu URL. Customers scan with
// their phone camera and land on /brand/<slug>/menu without any
// app-install or login friction.

import { QRCodeSVG } from 'qrcode.react'

interface Props {
  slug:  string
  brand: string
  url:   string
}

export function QRCard({ slug: _slug, brand, url }: Props) {
  // White-card-on-grey. Prints well on a black-and-white printer because
  // the QR's foreground stays dark + the surround stays light.
  const surface = '#f5f5f5'
  const ink     = '#0e0e0e'
  const muted   = 'rgba(14,14,14,0.6)'

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: surface,
        color: ink,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2.5rem 1.25rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: '24rem',
        background: 'white',
        border: `1px solid ${ink}`,
        padding: 'clamp(1.6rem, 5vw, 2.4rem)',
        textAlign: 'center',
        boxShadow: '0 12px 40px rgba(0,0,0,0.10)',
      }}>
        <p style={{
          color: muted, fontSize: '0.66rem',
          letterSpacing: '0.4em', textTransform: 'lowercase',
          margin: 0,
        }}>
          scan to order
        </p>

        <p style={{
          fontFamily: 'system-ui',
          fontSize: '2.2rem',
          lineHeight: 1,
          margin: '0.8rem 0 0.4rem',
          color: ink,
        }}>
          {brand}
        </p>

        <p style={{
          color: muted, fontSize: '0.74rem',
          letterSpacing: '0.18em', textTransform: 'lowercase',
          margin: '0.6rem 0 1.8rem',
        }}>
          tonight&apos;s menu — at your seat
        </p>

        <div style={{
          display: 'inline-block',
          padding: '1rem',
          background: 'white',
          border: `1px solid ${ink}`,
        }}>
          <QRCodeSVG
            value={url}
            size={220}
            level="M"
            includeMargin={false}
            fgColor={ink}
            bgColor="#ffffff"
          />
        </div>

        <p style={{
          fontFamily: 'monospace',
          fontSize: '0.72rem',
          color: muted,
          letterSpacing: '0.04em',
          margin: '1.5rem 0 0',
          wordBreak: 'break-all',
        }}>
          {url.replace(/^https?:\/\//, '')}
        </p>

        <hr style={{
          border: 0,
          borderTop: `1px solid ${muted}`,
          opacity: 0.35,
          margin: '1.4rem 0 1rem',
        }} />

        <p style={{
          color: muted, fontSize: '0.66rem',
          letterSpacing: '0.35em', textTransform: 'lowercase',
          margin: 0,
        }}>
          point camera · tap link
        </p>
      </div>
    </div>
  )
}
