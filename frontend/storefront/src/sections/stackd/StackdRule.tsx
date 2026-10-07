// stackd.rule — the hairline between the visit block and the cross-brand strip.

import type { SectionProps } from '../types'
import { color } from '../safe'
import { StackdFrame } from './shared'

export function StackdRule({ fields }: SectionProps) {
  const c = color(fields.color)
  return (
    <StackdFrame>
      <hr className="stackd-rule" style={c ? { background: c } : undefined} />
    </StackdFrame>
  )
}
