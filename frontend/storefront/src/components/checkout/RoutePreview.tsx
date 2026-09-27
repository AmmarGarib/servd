'use client'
import s from './checkout.module.css'

// A 64px route line from the kitchen to wherever the order ends up: the
// customer's table, bag, car or door. The line redraws (stroke-dashoffset,
// 400ms) every time the fulfilment type changes, because the path is keyed
// on the type. Under reduced motion it renders the finished line.
//
// Colours come from the page's --servd-* tokens, so the brand skin
// (.simmer-ordering / .stackd-ordering / .flipd-ordering) themes it for free.

export type RouteDestination = 'dine-in' | 'pickup' | 'curbside' | 'delivery'

const DEST_LABEL: Record<RouteDestination, string> = {
  'dine-in': 'your table',
  pickup: 'your bag',
  curbside: 'your car',
  delivery: 'your door',
}

// Each destination gets its own road shape so the redraw reads as a new route.
const ROUTE: Record<RouteDestination, string> = {
  'dine-in': 'M4 32 C 50 32, 70 14, 120 14 S 196 50, 236 32',
  pickup: 'M4 32 C 60 32, 80 32, 120 32 S 180 32, 236 32',
  curbside: 'M4 32 C 40 52, 90 52, 120 32 S 200 12, 236 32',
  delivery: 'M4 32 C 30 10, 70 54, 110 32 S 170 8, 200 34 S 226 40, 236 32',
}

export function RoutePreview({ type, lineColor }: { type: RouteDestination; lineColor?: string }) {
  const stroke = lineColor ?? 'var(--servd-green-dark)'
  return (
    <div className={s.route} role="img" aria-label={`from the kitchen to ${DEST_LABEL[type]}`}>
      <div className={s.routeEnd}>
        <KitchenMark />
        <span className={s.routeLabel}>kitchen</span>
      </div>
      <svg className={s.routeLine} viewBox="0 0 240 64" preserveAspectRatio="none" fill="none" aria-hidden="true">
        {/* faint road underneath */}
        <path d={ROUTE[type]} stroke="var(--servd-line)" strokeWidth="6" strokeLinecap="round" />
        {/* the drawn route, keyed so it redraws on every change */}
        <path
          key={type}
          className={s.routeDraw}
          d={ROUTE[type]}
          pathLength={1}
          stroke={stroke}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <div className={s.routeEnd}>
        <span key={type} className={s.routeDest}><DestMark type={type} /></span>
        <span className={s.routeLabel}>{DEST_LABEL[type]}</span>
      </div>
    </div>
  )
}

export default RoutePreview

const markProps = {
  width: 30, height: 30, viewBox: '0 0 32 32', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

function KitchenMark() {
  // a pot on a burner
  return (
    <svg {...markProps}>
      <path d="M6 14h20v7a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z" />
      <path d="M3 14h26" />
      <path d="M12 9c0-2 2-2 2-4M18 9c0-2 2-2 2-4" />
    </svg>
  )
}

function DestMark({ type }: { type: RouteDestination }) {
  switch (type) {
    case 'dine-in':
      // a table with a plate
      return (
        <svg {...markProps}>
          <path d="M4 15h24" />
          <path d="M8 15v11M24 15v11" />
          <path d="M11 12a5 3 0 0 1 10 0" />
        </svg>
      )
    case 'pickup':
      // a paper bag
      return (
        <svg {...markProps}>
          <path d="M7 11h18l-1.5 16h-15z" />
          <path d="M12 11V9a4 4 0 0 1 8 0v2" />
        </svg>
      )
    case 'curbside':
      // a car
      return (
        <svg {...markProps}>
          <path d="M4 19l3-7h18l3 7v5H4z" />
          <path d="M4 19h24" />
          <circle cx="10" cy="24" r="2.5" />
          <circle cx="22" cy="24" r="2.5" />
        </svg>
      )
    case 'delivery':
      // a front door
      return (
        <svg {...markProps}>
          <path d="M9 28V5h14v23" />
          <path d="M5 28h22" />
          <circle cx="19" cy="17" r="1" />
        </svg>
      )
  }
}
