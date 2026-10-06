import type { VoicesBlock } from '../../lib/blocks'
import { formatBrandName } from '../../lib/concept'

export function Voices(block: VoicesBlock) {
  return (
    <div className="container">
      {block.kicker && (
        <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '1.5rem' }}>
          {block.kicker}
        </p>
      )}
      <div>
        {block.voices.map((v, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(140px, 0.3fr) 1fr',
            gap: '1.5rem', alignItems: 'baseline',
            padding: '1rem 0',
            borderTop: '1px solid var(--servd-line)',
          }}>
            <h3 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 800, letterSpacing: '-0.03em', color: 'inherit' }}>
              {formatBrandName(v.brand)}.
            </h3>
            <p style={{ fontSize: 'clamp(1rem, 2vw, 1.4rem)', color: 'var(--servd-mute)', fontStyle: 'italic', lineHeight: 1.4 }}>
              {v.line}
            </p>
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--servd-line)' }} />
      </div>
    </div>
  )
}
