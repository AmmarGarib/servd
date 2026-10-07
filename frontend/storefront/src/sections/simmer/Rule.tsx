// simmer.rule — the thin bone hairline Simmer uses between sections.
import type { SectionProps } from '../types'

export function Rule(_props: SectionProps) {
  return (
    <div className="simmer-page">
      <hr className="rule" />
    </div>
  )
}
