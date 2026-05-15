// SRB (Sindh Revenue Board) Electronic Sales Invoicing.
//
// Mirrors the FBR PRAL adapter shape so the worker plumbing can re-use the
// same patterns. SRB runs a parallel e-invoicing regime for restaurants
// located in Sindh — payable provincial sales tax (currently 13%) goes
// to SRB instead of FBR, and SRB requires real-time invoice submission
// to their API similar to PRAL's.
//
// Credentials needed (env vars):
//   SRB_USERNAME — SRB e-portal username (NTN-based)
//   SRB_PASSWORD — SRB e-portal password
//   SRB_ENV      — "production" | "sandbox" (default: sandbox)
//
// Per-concept:
//   Concept.srbPosId — POSID assigned by SRB at restaurant registration
//
// IMPORTANT: SRB's API documentation isn't as publicly available as FBR's
// — the schema below reflects the published Electronic POS Integration
// spec but field names may differ slightly in practice. Your registered
// dev/finance contact at SRB should be your source of truth. The adapter
// is structured so swapping field names is a 1-line change in
// `buildPayload`, not a re-architecture.

import { redis } from '../../lib/redis.js'
import { prisma } from '../../lib/prisma.js'

const SRB_BASE = process.env['SRB_ENV'] === 'production'
  ? 'https://e.srb.gos.pk/api'
  : 'https://sandbox.e.srb.gos.pk/api'

const TOKEN_CACHE_KEY = 'srb:auth_token'
const TOKEN_TTL_S = 3500     // tokens expire ~1h; refresh slightly early

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthToken(): Promise<string> {
  const cached = await redis.get(TOKEN_CACHE_KEY)
  if (cached) return cached

  const username = process.env['SRB_USERNAME']
  const password = process.env['SRB_PASSWORD']
  if (!username || !password) throw new Error('SRB credentials not configured (SRB_USERNAME / SRB_PASSWORD)')

  const res = await fetch(`${SRB_BASE}/Login/Authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ UserName: username, Password: password }),
  })

  if (!res.ok) throw new Error(`SRB auth failed: ${res.status} ${await res.text()}`)

  const body = (await res.json()) as { StatusCode: number; Token?: string; Message?: string }
  if (body.StatusCode !== 0 || !body.Token) {
    throw new Error(`SRB auth error: ${body.Message ?? JSON.stringify(body)}`)
  }

  await redis.setex(TOKEN_CACHE_KEY, TOKEN_TTL_S, body.Token)
  return body.Token
}

// ─── Invoice payload ─────────────────────────────────────────────────────────

interface SrbItem {
  ItemCode:    string
  ItemName:    string
  Quantity:    number
  HSCode:      string       // 9963.1100 for food service
  TaxRate:     number       // % e.g. 13 for Sindh
  SaleValue:   number       // ex-tax
  Discount:    number
  TaxCharged:  number
  TotalAmount: number       // inc-tax
}

interface SrbInvoicePayload {
  InvoiceNumber:   string
  POSID:           number
  USIN:            string   // our internal order id
  DateTime:        string   // DDMMYYYYHHmmss
  BuyerNTN:        string
  BuyerCNIC:       string
  BuyerName:       string
  BuyerPhone:      string
  TotalBillAmount: number
  TotalQuantity:   number
  TotalSaleValue:  number
  TotalTaxCharged: number
  Discount:        number
  PaymentMode:     number   // 1=Card 2=Cash 3=Other
  InvoiceType:     number   // 1=Normal 3=Credit note
  Items:           SrbItem[]
}

const HS_RESTAURANT = '9963.1100'

function fmtSrbDate(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function mapPaymentMode(methods: string[]): number {
  if (methods.includes('cash')) return 2
  if (methods.includes('keenu_qr')) return 3
  return 1 // card default
}

export interface SrbOrderData {
  orderId:        string
  invoiceNumber:  string   // our internal invoice ref
  posId:          number
  taxRate:        number   // % e.g. 13 for SRB provincial GST on services
  items: Array<{
    name:           string
    quantity:       number
    unitPriceCents: number
    taxCents:       number
    discountCents:  number
  }>
  discountCents:  number
  taxCents:       number
  totalCents:     number
  paymentMethods: string[]
  placedAt:       Date
  buyerNTN?:      string
  buyerCNIC?:     string
  buyerName?:     string
  buyerPhone?:    string
}

function buildPayload(data: SrbOrderData): SrbInvoicePayload {
  const totalQty = data.items.reduce((s, i) => s + i.quantity, 0)
  const saleValueCents = data.totalCents - data.taxCents
  const toPkr = (cents: number) => parseFloat((cents / 100).toFixed(2))

  const items: SrbItem[] = data.items.map((item) => {
    const itemSaleValue = item.unitPriceCents * item.quantity - item.discountCents
    return {
      ItemCode:    'POS-ITEM',
      ItemName:    item.name.slice(0, 100),
      Quantity:    item.quantity,
      HSCode:      HS_RESTAURANT,
      TaxRate:     data.taxRate,
      SaleValue:   toPkr(itemSaleValue),
      Discount:    toPkr(item.discountCents),
      TaxCharged:  toPkr(item.taxCents),
      TotalAmount: toPkr(itemSaleValue + item.taxCents),
    }
  })

  return {
    InvoiceNumber:   data.invoiceNumber,
    POSID:           data.posId,
    USIN:            data.orderId,
    DateTime:        fmtSrbDate(data.placedAt),
    BuyerNTN:        data.buyerNTN  ?? '',
    BuyerCNIC:       data.buyerCNIC ?? '',
    BuyerName:       data.buyerName ?? '',
    BuyerPhone:      data.buyerPhone ?? '',
    TotalBillAmount: toPkr(data.totalCents),
    TotalQuantity:   totalQty,
    TotalSaleValue:  toPkr(saleValueCents),
    TotalTaxCharged: toPkr(data.taxCents),
    Discount:        toPkr(data.discountCents),
    PaymentMode:     mapPaymentMode(data.paymentMethods),
    InvoiceType:     1,
    Items:           items,
  }
}

// ─── Submission ───────────────────────────────────────────────────────────────

interface SrbResponse {
  StatusCode:    number
  InvoiceNumber?: string   // SRB-assigned ref returned on success
  Errors?:       string[]
  Message?:      string
}

export async function submitSrbInvoice(data: SrbOrderData): Promise<string> {
  const token = await getAuthToken()
  const payload = buildPayload(data)

  const res = await fetch(`${SRB_BASE}/Pos/PosInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Token: token },
    body: JSON.stringify(payload),
  })

  if (res.status === 401) {
    // Token expired — clear cache and retry once with a fresh token.
    await redis.del(TOKEN_CACHE_KEY)
    const freshToken = await getAuthToken()
    const retry = await fetch(`${SRB_BASE}/Pos/PosInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Token: freshToken },
      body: JSON.stringify(payload),
    })
    if (!retry.ok) throw new Error(`SRB submission failed after token refresh: ${retry.status}`)
    const retryBody = (await retry.json()) as SrbResponse
    if (retryBody.StatusCode !== 0) throw new Error(`SRB error: ${retryBody.Errors?.join(', ') ?? retryBody.Message}`)
    return retryBody.InvoiceNumber ?? data.invoiceNumber
  }

  if (!res.ok) throw new Error(`SRB submission failed: ${res.status} ${await res.text()}`)

  const body = (await res.json()) as SrbResponse
  if (body.StatusCode !== 0) {
    throw new Error(`SRB rejected invoice: ${body.Errors?.join(', ') ?? body.Message ?? JSON.stringify(body)}`)
  }

  return body.InvoiceNumber ?? data.invoiceNumber
}

// ─── Order loader (called by worker) ──────────────────────────────────────────
//
// Why not just share the FBR loader? Two reasons:
//   1. SRB applies to provincial tax (currently 13%), FBR applies to federal
//      GST on goods. Restaurants in Sindh report to both — same order, two
//      submissions, two POSIDs, two invoice numbers. Per-tax separation in
//      the adapter keeps these from cross-contaminating.
//   2. SRB-only deployments (or future jurisdictions like PRA, KPRA, BRA)
//      will want to swap the adapter without touching FBR plumbing.

export async function buildSrbDataForOrder(orderId: string): Promise<SrbOrderData | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { taxRate: true, srbPosId: true } },
      items: {
        where: { status: { not: 'voided' } },
        include: { modifiers: true },
      },
      payments: { where: { status: 'paid' } },
      customer: { select: { name: true, phone: true, ntn: true, cnic: true } },
    },
  })

  if (!order) return null
  if (!order.concept.srbPosId) return null    // concept not SRB-registered — skip silently

  const invoiceNumber = `SRB-${order.id.slice(-10).toUpperCase()}`

  const items = order.items.map((item) => {
    const modTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents * item.quantity, 0)
    const lineCents = item.unitPriceCents * item.quantity + modTotal
    const taxRate = order.concept.taxRate / 100
    const taxCents = Math.round(lineCents * taxRate)
    return {
      name:           item.name,
      quantity:       item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxCents,
      discountCents:  0,
    }
  })

  return {
    orderId:        order.id,
    invoiceNumber,
    posId:          order.concept.srbPosId,
    taxRate:        order.concept.taxRate,
    items,
    discountCents:  order.discountCents,
    taxCents:       order.taxCents,
    totalCents:     order.totalCents,
    paymentMethods: order.payments.map((p) => p.method),
    placedAt:       order.placedAt,
    buyerNTN:       (order.customer as { ntn?: string }  | null)?.ntn,
    buyerCNIC:      (order.customer as { cnic?: string } | null)?.cnic,
    buyerName:      order.customer?.name  ?? order.customerName ?? undefined,
    buyerPhone:     order.customer?.phone ?? undefined,
  }
}
