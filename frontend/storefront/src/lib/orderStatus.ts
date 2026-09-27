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
// historically mixed our purple brand colour for the chip background
// with a green text colour — a bug that read as "this chip is broken".
// Ready now lives entirely in the brand purple family.
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
    bg:       'rgba(58,14,105,0.15)',
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
    text:     '#dc2626',
    bar:      '#ef4444',
    headline: 'Order cancelled',
    sub:      'Something went wrong with this order.',
  },
  refunded: {
    label:    'Refunded',
    bg:       'rgba(239,68,68,0.12)',
    text:     '#dc2626',
    bar:      '#ef4444',
    headline: 'Order refunded',
    sub:      'A refund is on its way.',
  },
}

/** Fall back to "received" presentation when an unknown status arrives. */
export function statusFor(s: string | undefined | null): OrderStatusVisual {
  if (!s) return ORDER_STATUS.received
  return ORDER_STATUS[s as OrderStatus] ?? ORDER_STATUS.received
}

// ── Brand-voiced tracker lines ──────────────────────────────────────────────
// The tracker hero speaks in the kitchen's own voice. /orders and /account
// keep the neutral `statusFor` copy; only the live tracker uses these.
//
//   simmer — lowercase, calm, never an exclamation mark.
//   stackd — a warm café and market: bread, pastries, cups on the bar.
//   flipd  — a terse diner counter.
//
// Cancelled and refunded are never played for a joke: they always use the
// neutral copy (lowercased on simmer, which is lowercase everywhere).

export interface TrackerLine { headline: string; sub: string }

type LiveStatus = Exclude<OrderStatus, 'cancelled' | 'refunded'>

const TRACKER_LINES: Record<string, Record<LiveStatus, TrackerLine>> = {
  simmer: {
    received:  { headline: 'we have your order.',  sub: 'the kitchen will confirm it in a moment.' },
    confirmed: { headline: 'confirmed.',           sub: 'the pot is warming.' },
    preparing: { headline: 'on the flame.',        sub: 'the kitchen has it. take your time.' },
    ready:     { headline: 'ready at the pass.',   sub: 'come find us.' },
    completed: { headline: 'that was supper.',     sub: 'thank you for sitting with us.' },
  },
  stackd: {
    received:  { headline: 'got your order',       sub: 'it’s on the rail. confirming now.' },
    confirmed: { headline: 'you’re on the bar',    sub: 'your cups and wraps are being set out.' },
    preparing: { headline: 'stacking it now',      sub: 'bread’s toasting, cups are out.' },
    ready:     { headline: 'ready on the bar',     sub: 'grab it at the counter, by the chiller.' },
    completed: { headline: 'all yours',            sub: 'enjoy it. the cup’s a keeper.' },
  },
  flipd: {
    received:  { headline: 'Ticket in.',           sub: 'Waiting on the grill cook.' },
    confirmed: { headline: 'Confirmed.',           sub: 'Grill’s heating.' },
    preparing: { headline: 'On the grill.',        sub: 'Smashing it now.' },
    ready:     { headline: 'Order up.',            sub: 'Hot at the counter.' },
    completed: { headline: 'Done.',                sub: 'Come back hungry.' },
  },
}

/** Tracker hero copy for a status, in the brand's voice. Unknown brands (and
 *  unknown statuses) fall back to the neutral `statusFor` headline/sub. */
export function trackerLine(status: string, slug: string | null | undefined): TrackerLine {
  const brand = (slug ?? '').trim().toLowerCase()
  const neutral = statusFor(status)
  if (status === 'cancelled' || status === 'refunded') {
    return brand === 'simmer'
      ? { headline: neutral.headline.toLowerCase(), sub: neutral.sub.toLowerCase() }
      : { headline: neutral.headline, sub: neutral.sub }
  }
  const lines = TRACKER_LINES[brand]
  const line = lines?.[status as LiveStatus]
  if (line) return line
  // A known brand with an unknown status still falls back to the neutral
  // copy, lowercased on simmer.
  if (brand === 'simmer') {
    return { headline: neutral.headline.toLowerCase(), sub: neutral.sub.toLowerCase() }
  }
  return { headline: neutral.headline, sub: neutral.sub }
}
