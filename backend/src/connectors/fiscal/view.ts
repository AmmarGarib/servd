// What people see of a fiscal document (spec §6.5): the till, the receipt,
// the order page and the POS connector page all read this one shape.

import type { FiscalDocStatus, FiscalDocument } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

export interface FiscalView {
  documentId: string
  kind: 'sale' | 'refund'
  status: 'filed' | 'pending' | 'failed' | 'not_required' | 'test'
  rawStatus: FiscalDocStatus
  statusReason: string | null
  fiscalNumber: string | null
  authority: string | null
  qrPayload: string | null
  verifyUrl: string | null
  fiscalAt: string | null
  isTest: boolean
  attempts: number
  /** Only in staff (manager) responses; null otherwise. */
  lastError: string | null
}

type ViewRow = Pick<FiscalDocument,
  'id' | 'kind' | 'status' | 'statusReason' | 'fiscalNumber' | 'authority' | 'qrPayload' | 'verifyUrl' | 'fiscalAt'
  | 'isTest' | 'attempts' | 'lastError' | 'driver'>

export const FISCAL_VIEW_SELECT = {
  id: true, kind: true, status: true, statusReason: true, fiscalNumber: true, authority: true, qrPayload: true,
  verifyUrl: true, fiscalAt: true, isTest: true, attempts: true, lastError: true, driver: true,
} as const

export function viewStatusOf(row: Pick<ViewRow, 'status' | 'isTest' | 'driver'>): FiscalView['status'] {
  if (row.isTest || row.driver === 'test') return 'test'
  switch (row.status) {
    case 'filed':
    case 'manual_filed':
      return 'filed'
    case 'failed':
    case 'rejected':
      return 'failed'
    case 'skipped':
      return 'not_required'
    default:
      return 'pending'
  }
}

export function toFiscalView(row: ViewRow, opts: { staff?: boolean } = {}): FiscalView {
  return {
    documentId: row.id,
    kind: row.kind,
    status: viewStatusOf(row),
    rawStatus: row.status,
    statusReason: row.statusReason,
    fiscalNumber: row.fiscalNumber,
    authority: row.authority,
    qrPayload: row.qrPayload,
    verifyUrl: row.verifyUrl,
    fiscalAt: row.fiscalAt ? row.fiscalAt.toISOString() : null,
    isTest: row.isTest || row.driver === 'test',
    attempts: row.attempts,
    lastError: opts.staff ? row.lastError : null,
  }
}

/**
 * The order's sale document view (kind 'sale', default) or its latest refund
 * document. Null when the order has none. The caller has already resolved the
 * order in scope; the document is read by order id (one order, one company).
 */
export async function fiscalViewForOrder(orderId: string, kind: 'sale' | 'refund' = 'sale', opts: { staff?: boolean } = {}): Promise<FiscalView | null> {
  const row = await prisma.fiscalDocument.findFirst({
    where: { orderId, kind },
    orderBy: { createdAt: kind === 'sale' ? 'asc' : 'desc' },
    select: FISCAL_VIEW_SELECT,
  })
  return row ? toFiscalView(row, opts) : null
}

/** Every document of an order (sale first, then refunds oldest → newest). */
export async function fiscalViewsForOrder(orderId: string, opts: { staff?: boolean } = {}): Promise<FiscalView[]> {
  const rows = await prisma.fiscalDocument.findMany({
    where: { orderId },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
    select: FISCAL_VIEW_SELECT,
  })
  return rows.map((r) => toFiscalView(r, opts))
}

/**
 * The deprecated `srb` field some till responses still carry for one release
 * (spec §8.4): only a FILED, non-test SRB number.
 */
export function legacySrbAlias(fiscal: FiscalView | null | undefined): { srbInvoiceId: string; qrCodeLink: string | null } | null {
  if (!fiscal || fiscal.status !== 'filed' || fiscal.authority !== 'srb' || !fiscal.fiscalNumber) return null
  return { srbInvoiceId: fiscal.fiscalNumber, qrCodeLink: fiscal.verifyUrl ?? fiscal.qrPayload }
}
