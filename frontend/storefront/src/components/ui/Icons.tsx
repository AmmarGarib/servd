// Small inline SVG icons that replace emoji / text glyphs used as icons.
// They take their colour from `currentColor` and their size from `size`.

const STAR = 'M12 2.5l2.95 6.1 6.7.9-4.9 4.6 1.2 6.6L12 17.5 6.05 20.7l1.2-6.6-4.9-4.6 6.7-.9L12 2.5z'

export function StarRating({ value, max = 5, size = 16, color = 'currentColor', emptyColor = 'rgba(0,0,0,0.15)' }: {
  value: number; max?: number; size?: number; color?: string; emptyColor?: string
}) {
  const full = Math.max(0, Math.min(max, Math.round(value)))
  return (
    <span role="img" aria-label={`${full} out of ${max} stars`} style={{ display: 'inline-flex', gap: '0.1em', verticalAlign: 'middle' }}>
      {Array.from({ length: max }, (_, i) => (
        <svg key={i} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={i < full ? color : emptyColor}>
          <path d={STAR} />
        </svg>
      ))}
    </span>
  )
}

export function StarIcon({ size = 12 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: '-0.1em' }}><path d={STAR} /></svg>
}

export function CheckIcon({ size = 16, strokeWidth = 3 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-0.15em' }}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function TicketIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-0.2em' }}>
      <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4V8z" />
      <path d="M13 6v12" strokeDasharray="2 3" />
    </svg>
  )
}
