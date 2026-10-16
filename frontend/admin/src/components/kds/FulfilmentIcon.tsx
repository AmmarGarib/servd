import { Utensils, ShoppingBag, Bike } from 'lucide-react'

/** Plate / package / delivery icon for a fulfilment type (front-of-house screens; never emoji). */
export function FulfilmentIcon({ type, size = 12, className }: { type: string; size?: number; className?: string }) {
  const props = { size, 'aria-hidden': true as const, className: `inline-block align-[-2px] shrink-0 ${className ?? ''}` }
  if (type === 'takeout') return <ShoppingBag {...props} />
  if (type === 'delivery') return <Bike {...props} />
  return <Utensils {...props} />
}
