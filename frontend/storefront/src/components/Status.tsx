// Reusable empty / error / loading state primitives. Lightweight, no design
// opinions baked in beyond the servd black/white/green palette — a designer
// can replace the visuals while keeping the semantics (role/aria) intact.

import type { ReactNode } from 'react'
import { Loader } from './ui/Loader'

interface StatusProps {
  title: string
  message?: string
  action?: ReactNode
  tone?: 'neutral' | 'error'
}

const baseWrap: React.CSSProperties = {
  minHeight: '40vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem',
  gap: '0.75rem',
  textAlign: 'center',
}

export function EmptyState({ title, message, action }: StatusProps) {
  return (
    <div role="status" aria-live="polite" style={baseWrap}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, color: '#0a0a0a' }}>{title}</h2>
      {message && <p style={{ color: 'rgba(0,0,0,0.5)', margin: 0, maxWidth: '28rem' }}>{message}</p>}
      {action && <div style={{ marginTop: '0.5rem' }}>{action}</div>}
    </div>
  )
}

export function ErrorState({ title, message, action }: StatusProps) {
  return (
    <div role="alert" aria-live="assertive" style={baseWrap}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, color: '#b91c1c' }}>{title}</h2>
      {message && <p style={{ color: 'rgba(0,0,0,0.55)', margin: 0, maxWidth: '32rem' }}>{message}</p>}
      {action && <div style={{ marginTop: '0.5rem' }}>{action}</div>}
    </div>
  )
}

// Inline loader — the branded servd ripple, for in-component use rather than
// route-level loading. `size` is the overall footprint; the 3×3 grid scales to fit.
export function Spinner({ size = 24, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span role="status" aria-label={label} style={{ display: 'inline-flex' }}>
      <Loader size={Math.max(8, Math.round(size / 3))} />
      <span className="sr-only">{label}</span>
    </span>
  )
}

// Skeleton block — for content placeholders. Use width/height in the parent
// to size; this just animates the gradient.
export function Skeleton({ height = '1rem', width = '100%', radius = '0.25rem' }: { height?: string | number; width?: string | number; radius?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        height, width,
        borderRadius: radius,
        background: 'linear-gradient(90deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.06) 100%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.6s ease-in-out infinite',
      }}
    >
      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @media (prefers-reduced-motion: reduce) { span[aria-hidden="true"] { animation: none; } }
      `}</style>
    </span>
  )
}
