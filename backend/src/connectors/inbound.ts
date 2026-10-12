// Inbound vendor events (spec §5 "Inbound webhooks"). Parsed from the
// published body shape into the frozen InboundEvent type and applied to rows
// of ONE company — the connector's. A foreign or unknown id is ignored, never
// applied across companies. Shared by POST /webhooks/pos/:token and the test
// driver's simulate route, so both run the same path end to end.

import type { InboundEvent } from './types.js'
import { parseChargeBody, parseFiscalBody } from './drivers/http.js'
import { applyTerminalEvent } from './terminal/service.js'
import { applyFiscalWebhook } from './fiscal/outbox.js'

export function parseInboundEvent(body: unknown): InboundEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { id?: unknown; type?: unknown; data?: unknown }
  if (typeof b.id !== 'string' || !b.id || b.id.length > 200) return null
  if (!b.data || typeof b.data !== 'object') return null
  const d = b.data as Record<string, unknown>
  if (b.type === 'terminal.charge.updated') {
    if (typeof d['chargeId'] !== 'string' || !d['chargeId']) return null
    const state = parseChargeBody(d)
    if (!state) return null
    return { id: b.id, type: 'terminal.charge.updated', chargeId: d['chargeId'], state }
  }
  if (b.type === 'fiscal.document.updated') {
    if (typeof d['documentId'] !== 'string' || !d['documentId']) return null
    const status = d['status']
    if (status === 'rejected') {
      return {
        id: b.id, type: 'fiscal.document.updated', documentId: d['documentId'],
        value: { state: 'rejected', code: typeof d['code'] === 'string' ? d['code'].slice(0, 64) : 'REJECTED', message: typeof d['message'] === 'string' ? d['message'].slice(0, 500) : 'rejected' },
      }
    }
    const parsed = parseFiscalBody(d, status === 'processing' ? 202 : 200)
    if (!parsed || parsed.state === 'rejected') return null
    const value = parsed.state === 'filed'
      ? { state: 'filed' as const, result: parsed.result }
      : { state: 'processing' as const, ...(parsed.retryAfterMs !== undefined && { retryAfterMs: parsed.retryAfterMs }) }
    return { id: b.id, type: 'fiscal.document.updated', documentId: d['documentId'], value }
  }
  return null
}

export async function handleInboundEvent(tenantId: string, event: InboundEvent, via: 'webhook' | 'simulate' = 'webhook'): Promise<'applied' | 'ignored'> {
  if (event.type === 'terminal.charge.updated') {
    return applyTerminalEvent(tenantId, event.chargeId, event.state, via === 'simulate' ? 'simulate' : 'webhook')
  }
  return applyFiscalWebhook(tenantId, event.documentId, event.value)
}

