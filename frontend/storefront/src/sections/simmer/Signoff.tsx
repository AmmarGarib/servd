// simmer.signoff — the brand's closing line, set in the wordmark face with the
// full stop as the orange signal. Ported from SimmerLayout.
import type { SectionProps } from '../types'
import { simmerText, surface } from './shared'

export function Signoff({ fields: f }: SectionProps) {
  const s = surface(f['surface'], 'green')
  const text = simmerText(f['text'])
  const mark = simmerText(f['mark'])
  if (!text && !mark) return null
  return (
    <div className="simmer-page">
      <section style={{ background: s.background, color: s.color, padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)', textAlign: 'center' }}>
        <p className="wordmark" style={{ fontSize: 'clamp(3.5rem, 10vw, 6rem)', margin: 0 }}>
          {text}{mark && <span className="signal">{mark}</span>}
        </p>
      </section>
    </div>
  )
}
