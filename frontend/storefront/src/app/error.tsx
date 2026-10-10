'use client'

// Global error boundary for the storefront. Renders when any client-side
// rendering throws below the layout. Don't drop the user on a blank page —
// give them something to click and a way to recover.

import { useEffect } from 'react'
import Link from 'next/link'
import { SERVD_LINK_ORIGIN } from '../lib/brandDomains'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // In production this is where we'd ship the error to Sentry / Datadog.
    console.error('[storefront] uncaught error:', error)
  }, [error])

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1.25rem',
        textAlign: 'center',
        background: 'var(--servd-bg)',
        color: 'var(--servd-ink)',
      }}
    >
      <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, margin: 0 }}>
        Something broke
      </h1>
      <p style={{ color: 'var(--servd-mute)', maxWidth: '32rem', margin: 0 }}>
        We&rsquo;re sorry — that wasn&rsquo;t supposed to happen. You can try again, or head back to the menu.
        {error.digest && (
          <span style={{ display: 'block', fontSize: '0.75rem', marginTop: '0.5rem', opacity: 0.5 }}>
            Reference: {error.digest}
          </span>
        )}
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={reset}
          style={{
            background: 'var(--servd-green)',
            color: 'var(--servd-on-green)',
            fontWeight: 800,
            padding: '0.75rem 2rem',
            borderRadius: '999px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Try again
        </button>
        <Link
          href={`${SERVD_LINK_ORIGIN}/home#kitchens`}
          style={{
            background: 'var(--servd-purple)',
            color: 'var(--servd-on-purple)',
            fontWeight: 600,
            padding: '0.75rem 2rem',
            borderRadius: '999px',
            border: '1px solid var(--servd-purple)',
            textDecoration: 'none',
            fontSize: '1rem',
          }}
        >
          Back to brands
        </Link>
      </div>
    </div>
  )
}
