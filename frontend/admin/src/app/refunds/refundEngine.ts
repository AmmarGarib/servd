// The ONE refund engine, from the admin side: POST /pos/orders/:id/refund
// (backend pos/service.ts refundOrder). Refund-policy caps apply; above the
// signed-in user's cap the server answers 403 MANAGER_OVERRIDE_REQUIRED and
// we ask for a manager PIN and resend. A cash refund comes out of the drawer
// open now (owner decision 3) — the refunder's own open shift unless one is
// named. Used by /refunds and the order page.
import { api, ApiError } from '../../lib/api'

export interface RefundRequest {
  amountCents: number
  reason: string
  method?: 'cash' | 'card' | 'keenu_qr'
  shiftId?: string
}

export interface RefundResult {
  id: string
  amountCents: number
  shiftId: string | null
  entryId: string
  orderRefunded: boolean
  srbReturnInvoiceNo: string | null
}

const PIN_CODES = new Set(['MANAGER_OVERRIDE_REQUIRED', 'INVALID_MANAGER_PIN'])

export async function refundThroughEngine(orderId: string, req: RefundRequest): Promise<RefundResult> {
  let pin: string | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.post<RefundResult>(`/pos/orders/${orderId}/refund`, {
        amountCents: req.amountCents,
        reason: req.reason,
        ...(req.method && { method: req.method }),
        ...(req.shiftId && { shiftId: req.shiftId }),
        ...(pin && { managerOverridePin: pin }),
      })
    } catch (err) {
      if (!(err instanceof ApiError) || !PIN_CODES.has(err.code) || typeof window === 'undefined') throw err
      const entered = window.prompt(
        err.code === 'INVALID_MANAGER_PIN'
          ? 'That PIN did not match a manager. Manager PIN:'
          : 'This refund is above your limit. Manager PIN:',
      )
      if (!entered) throw err
      pin = entered.trim()
    }
  }
  throw new Error('Manager PIN not accepted')
}
