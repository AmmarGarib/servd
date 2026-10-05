// Shared order-status presentation. Previously each of /orders,
// /account, /[concept]/order/[id] hand-rolled its own status palette
// + label map and they drifted (Ready had a purple bg + green text in
// orders; Completed read "Delivered" in one place and "Done" in
// another). This is the one source of truth — change once, all three
// surfaces stay aligned.

export type OrderStatus =
  | 'received'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'refunded'

export interface OrderStatusVisual {
  /** Short label for badge chips. */
  label:    string
  /** Background colour for the badge surface. */
  bg:       string
  /** Foreground text colour — paired with `bg` so they read as one chip. */
  text:     string
  /** Solid-colour accent bar used on order cards in /account. */
  bar:      string
  /** Conversational headline for the order tracker hero. */
  headline: string
  /** One-line subhead under the tracker headline. */
  sub:      string
}

// Palette discipline: each status picks a single hue. The "ready" status
// historically mixed a purple chip background with a green text colour —
// a bug that read as "this chip is broken". Ready now lives entirely in the
// servd green family (green wash, text-safe dark green #4f7a1c).
export const ORDER_STATUS: Record<OrderStatus, OrderStatusVisual> = {
  received: {
    label:    'Received',
    bg:       'rgba(59,130,246,0.12)',
    text:     '#1d4ed8',
    bar:      '#3b82f6',
    headline: 'Order received',
    sub:      'Waiting for the kitchen to confirm.',
  },
  confirmed: {
    label:    'Confirmed',
    bg:       'rgba(99,102,241,0.12)',
    text:     '#4338ca',
    bar:      '#6366f1',
    headline: 'Order confirmed',
    sub:      'Getting ready to cook.',
  },
  preparing: {
    label:    'In the kitchen',
    bg:       'rgba(234,179,8,0.15)',
    text:     '#a16207',
    bar:      '#eab308',
    headline: 'In the kitchen',
    sub:      'Your order is being prepared.',
  },
  ready: {
    label:    'Ready',
    bg:       'rgba(135,197,64,0.15)',
    text:     'var(--servd-green-dark)',
    bar:      'var(--servd-green)',
    headline: 'Ready',
    sub:      'Head to the counter to collect.',
  },
  completed: {
    label:    'Completed',
    bg:       'rgba(0,0,0,0.06)',
    text:     'var(--servd-mute)',
    bar:      'rgba(0,0,0,0.18)',
    headline: 'Order complete',
    sub:      'Enjoy your meal.',
  },
  cancelled: {
    label:    'Cancelled',
    bg:       'rgba(239,68,68,0.12)',
    text:     'var(--servd-danger)',
    bar:      'var(--servd-danger)',
    headline: 'Order cancelled',
    sub:      'Something went wrong with this order.',
  },
  refunded: {
    label:    'Refunded',
    bg:       'rgba(239,68,68,0.12)',
    text:     'var(--servd-danger)',
    bar:      'var(--servd-danger)',
    headline: 'Order refunded',
    sub:      'A refund is on its way.',
  },
}

/** Fall back to "received" presentation when an unknown status arrives. */
export function statusFor(s: string | undefined | null): OrderStatusVisual {
  if (!s) return ORDER_STATUS.received
  return ORDER_STATUS[s as OrderStatus] ?? ORDER_STATUS.received
}
