// Generic payment marks: a cash note, a card, a phone wallet. Deliberately
// no third-party logos (JazzCash / EasyPaisa / Keenu marks are theirs, not
// ours); the label next to the mark names the rail.

export type PaymentMarkKind = 'cash' | 'card' | 'wallet'

export function paymentMarkFor(method: string): PaymentMarkKind {
  if (method === 'cash') return 'cash'
  if (method === 'jazzcash' || method === 'easypaisa') return 'wallet'
  return 'card'
}

export function PaymentMark({ kind, size = 26 }: { kind: PaymentMarkKind; size?: number }) {
  const p = {
    width: size, height: size, viewBox: '0 0 28 28', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  if (kind === 'cash') {
    return (
      <svg {...p}>
        <rect x="2.5" y="7" width="23" height="14" rx="2" />
        <circle cx="14" cy="14" r="3.2" />
        <path d="M6 10.5v0M22 17.5v0" strokeWidth="2.6" />
      </svg>
    )
  }
  if (kind === 'wallet') {
    return (
      <svg {...p}>
        <rect x="7.5" y="2.5" width="13" height="23" rx="2.5" />
        <path d="M12 21.5h4" />
        <path d="M11 9.5h6M11 13h4" />
      </svg>
    )
  }
  return (
    <svg {...p}>
      <rect x="2.5" y="6" width="23" height="16" rx="2.5" />
      <path d="M2.5 11h23" strokeWidth="2.6" />
      <path d="M6.5 17h5" />
    </svg>
  )
}

export default PaymentMark
