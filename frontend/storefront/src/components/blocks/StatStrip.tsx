import type { StatStripBlock } from '../../lib/blocks'

export function StatStrip(block: StatStripBlock) {
  if (block.stats.length === 0) return null
  return (
    <div className="container">
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(160px, 1fr))`,
        borderTop: '1px solid var(--servd-line)',
        borderBottom: '1px solid var(--servd-line)',
      }}>
        {block.stats.map((s, i) => (
          <div key={i} style={{
            padding: '1.5rem 1.25rem',
            borderRight: i < block.stats.length - 1 ? '1px solid var(--servd-line)' : undefined,
          }}>
            <p style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, letterSpacing: '-0.04em', marginBottom: '0.2rem' }}>
              {s.value}
            </p>
            <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--servd-mute)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {s.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
