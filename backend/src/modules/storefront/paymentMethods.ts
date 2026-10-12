// Which payment methods the storefront checkout may offer (ONL-02).
//
// Keenu, JazzCash and EasyPaisa orders used to be accepted with a pending
// 'card' payment and NO gateway call: no redirect, no hosted page, nothing
// ever charged — while the ticket went to the kitchen and the ledger booked a
// card receivable (and 8% card-rate GST) that no gateway would ever settle.
//
// An online method is offered only when BOTH are true:
//   1. its gateway is configured — the adapter's credentials are present in
//      the environment (the same secrets admin → Payment gateways checks);
//   2. the storefront checkout actually takes money through it — a payment is
//      started at checkout, the customer is sent to the gateway, and the
//      order is held until the gateway's callback settles it. That is the
//      WIRED flag below, and it is code, not configuration: flipping it on
//      without that flow is exactly the bug this file exists to stop.
//
// Today no online method is wired, so checkout (POST /storefront/orders) and
// GET /storefront/quote answer 422 PAYMENT_METHOD_UNAVAILABLE for them, and
// the public endpoints list only cash. 'wallet' (servd stored value) is not a
// gateway: checkout accepts it only when the wallet and gift card leave
// nothing to collect.

import { AppError } from '../../lib/errors.js'

export type StorefrontPaymentMethod = 'cash' | 'keenu' | 'jazzcash' | 'easypaisa' | 'wallet'
export type OnlineGateway = 'keenu' | 'jazzcash' | 'easypaisa'

const ONLINE_GATEWAYS: readonly OnlineGateway[] = ['keenu', 'jazzcash', 'easypaisa']

// The credentials each adapter (src/adapters/payment/*) needs to talk to its
// gateway at all.
const GATEWAY_ENV: Record<OnlineGateway, readonly string[]> = {
  keenu:     ['KEENU_MERCHANT_ID', 'KEENU_API_KEY'],
  jazzcash:  ['JAZZCASH_MERCHANT_ID', 'JAZZCASH_PASSWORD', 'JAZZCASH_HASH_KEY'],
  easypaisa: ['EASYPAISA_STORE_ID', 'EASYPAISA_HASH_KEY'],
}

// Set to true ONLY in the change that makes POST /storefront/orders start a
// payment with this gateway, return its redirect, and keep the order away
// from the kitchen until the gateway confirms it.
const WIRED: Record<OnlineGateway, boolean> = {
  keenu:     false,
  jazzcash:  false,
  easypaisa: false,
}

const LABEL: Record<OnlineGateway, string> = { keenu: 'Card (Keenu)', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa' }

function isOnlineGateway(method: string): method is OnlineGateway {
  return (ONLINE_GATEWAYS as readonly string[]).includes(method)
}

export function gatewayConfigured(gateway: OnlineGateway, env: NodeJS.ProcessEnv = process.env): boolean {
  return GATEWAY_ENV[gateway].every((name) => !!env[name]?.trim())
}

/** An online gateway the checkout can really take money through right now. */
export function gatewayAvailable(gateway: OnlineGateway, env: NodeJS.ProcessEnv = process.env): boolean {
  return WIRED[gateway] && gatewayConfigured(gateway, env)
}

/**
 * The methods a customer may pick at checkout, for the storefront to render.
 * Cash is always offered (cash on delivery / at pickup / at the counter).
 * 'wallet' is not listed: it is the "use my wallet" toggle, not a method.
 */
export function availablePaymentMethods(env: NodeJS.ProcessEnv = process.env): StorefrontPaymentMethod[] {
  return ['cash', ...ONLINE_GATEWAYS.filter((g) => gatewayAvailable(g, env))]
}

/** 422 PAYMENT_METHOD_UNAVAILABLE for an online method checkout cannot charge. */
export function assertPaymentMethodAvailable(method: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isOnlineGateway(method)) return
  if (gatewayAvailable(method, env)) return
  throw new AppError(
    'PAYMENT_METHOD_UNAVAILABLE',
    `${LABEL[method]} isn't available for online orders yet. Please pay with cash.`,
    422,
    { available: availablePaymentMethods(env) },
  )
}
