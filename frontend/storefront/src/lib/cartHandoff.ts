'use client'
import type { CartItem } from '../store/cart'

// Cart handoff between brand custom domains and the servd canonical host.
// The brand site builds the cart in its own localStorage, then encodes it
// into a URL-safe token at checkout time. The servd checkout page decodes
// the token and rehydrates Zustand. Items are server-validated at order
// placement, so this token is integrity-only — not authenticated. A short
// TTL guards against stale links.

interface CartPayload {
  cartId: string
  conceptSlug: string | null
  items: CartItem[]
  ts: number
}

const TTL_MS = 1000 * 60 * 60 // 1h

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(token: string): string {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(token.length / 4) * 4, '=')
  return atob(padded)
}

export function encodeCartToken(cart: {
  cartId: string
  conceptSlug: string | null
  items: CartItem[]
}): string {
  const payload: CartPayload = {
    cartId:      cart.cartId,
    conceptSlug: cart.conceptSlug,
    items:       cart.items,
    ts:          Date.now(),
  }
  return toBase64Url(JSON.stringify(payload))
}

export function decodeCartToken(token: string): CartPayload | null {
  try {
    const payload = JSON.parse(fromBase64Url(token)) as CartPayload
    if (typeof payload.ts !== 'number') return null
    if (Date.now() - payload.ts > TTL_MS) return null
    if (!Array.isArray(payload.items)) return null
    return payload
  } catch {
    return null
  }
}
