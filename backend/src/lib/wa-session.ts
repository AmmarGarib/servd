// Redis-backed WhatsApp conversation session
// Key: wa:session:<phone>, TTL: 30 minutes of inactivity

import { redis } from './redis.js'

export type WaStep =
  | 'idle'
  | 'browsing'   // Sent menu categories
  | 'category'   // Browsing items in a category
  | 'cart'       // Has items, reviewing cart
  | 'confirm'    // Confirming order details
  | 'done'       // Order placed

export interface CartItem {
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
}

export interface WaSession {
  phone: string
  conceptId: string
  conceptSlug: string
  step: WaStep
  cart: CartItem[]
  selectedCategoryId?: string
  customerId?: string
  customerName?: string
  orderType: 'pickup' | 'delivery'
}

const TTL = 30 * 60  // 30 minutes

function key(phone: string) {
  return `wa:session:${phone}`
}

export async function getSession(phone: string): Promise<WaSession | null> {
  try {
    const raw = await redis.get(key(phone))
    if (!raw) return null
    return JSON.parse(raw) as WaSession
  } catch {
    return null
  }
}

export async function saveSession(session: WaSession): Promise<void> {
  await redis.set(key(session.phone), JSON.stringify(session), 'EX', TTL)
}

export async function clearSession(phone: string): Promise<void> {
  await redis.del(key(phone))
}

export function newSession(phone: string, conceptId: string, conceptSlug: string): WaSession {
  return {
    phone,
    conceptId,
    conceptSlug,
    step: 'idle',
    cart: [],
    orderType: 'pickup',
  }
}
