// FBR PRAL POS Integration — Pakistan Federal Board of Revenue
// Real-time invoice submission to PRAL's Electronic POS system.
// Required for Tier-1 businesses under SRO 1307(I)/2022.
//
// Credentials needed (env vars):
//   FBR_USERNAME   — PRAL portal username (NTN-based)
//   FBR_PASSWORD   — PRAL portal password
//   FBR_ENV        — "production" | "sandbox" (default: sandbox)
//
// Per-concept:
//   Concept.fbrPosId — the POSID assigned by FBR at POS registration

import { redis } from '../../lib/redis.js'
import { serviceClient as prisma } from '../../lib/prisma.js'

const PRAL_BASE = process.env['FBR_ENV'] === 'production'
  ? 'https://esp.pral.com.pk/FBRIntegration/api'
  : 'https://sandbox.esp.pral.com.pk/FBRIntegration/api'

const TOKEN_CACHE_KEY = 'fbr:auth_token'
const TOKEN_TTL_S = 3500 // PRAL tokens expire after ~1 hour; refresh a bit earlier

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthToken(): Promise<string> {
  const cached = await redis.get(TOKEN_CACHE_KEY)
  if (cached) return cached

  const username = process.env['FBR_USERNAME']
  const password = process.env['FBR_PASSWORD']
  if (!username || !password) throw new Error('FBR credentials not configured (FBR_USERNAME / FBR_PASSWORD)')

  const res = await fetch(`${PRAL_BASE}/Login/Authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ UserName: username, Password: password }),
  })

  if (!res.ok) throw new Error(`PRAL auth failed: ${res.status} ${await res.text()}`)

  const body = (await res.json()) as { StatusCode: number; Token?: string; Message?: string }
  if (body.StatusCode !== 0 || !body.Token) {
    throw new Error(`PRAL auth error: ${body.Message ?? JSON.stringify(body)}`)
  }

  await redis.setex(TOKEN_CACHE_KEY, TOKEN_TTL_S, body.Token)
  return body.Token
}

// ─── Invoice payload builder ───────────────────────────────────────────────────

interface FbrItem {
  ItemCode: string
  ItemName: string
  Quantity: number
  PCTCode: string       // HS code — restaurants use 9963.1100 for food service
  TaxRate: number
  SaleValue: number     // ex-tax
  Discount: number
  FurtherTax: number
  TaxCharged: number
  TotalAmount: number   // inc-tax
  InvoiceType: number
  RefUSIN: string
}

interface FbrInvoicePayload {
  InvoiceNumber: string
  POSID: number
  USIN: string
  DateTime: string      // DDMMYYYYHHmmss
  BuyerNTN: string
  BuyerCNIC: string
  BuyerName: string
  BuyerPhoneNumber: string
  TotalBillAmount: number
  TotalQuantity: number
  TotalSaleValue: number
  TotalTaxCharged: number
  Discount: number
  FurtherTax: number
  PaymentMode: number   // 1=Card 2=Cash 3=Wallet/Other
  RefNumber: string
  Latitude: string
  Longitude: string
  InvoiceType: number   // 1=Normal 3=Credit note
  Items: FbrItem[]
}

const HS_RESTAURANT = '9963.1100'

function fmtPralDate(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function mapPaymentMode(methods: string[]): number {
  if (methods.includes('cash')) return 2
  if (methods.includes('keenu_qr')) return 3                   // F-PAY02: wallets retired
  return 1 // card default
}

export interface FbrOrderData {
  orderId: string
  invoiceNumber: string   // our internal invoice ref
  posId: number
  taxRate: number         // % e.g. 17
  items: Array<{
    name: string
    quantity: number
    unitPriceCents: number   // ex-tax
    taxCents: number
    discountCents: number
  }>
  discountCents: number
  taxCents: number
  totalCents: number
  paymentMethods: string[]
  placedAt: Date
  buyerNTN?: string
  buyerCNIC?: string
  buyerName?: string
  buyerPhone?: string
}

function buildPayload(data: FbrOrderData): FbrInvoicePayload {
  const totalQty = data.items.reduce((s, i) => s + i.quantity, 0)
  const saleValueCents = data.totalCents - data.taxCents
  const toPkr = (cents: number) => parseFloat((cents / 100).toFixed(2))

  const items: FbrItem[] = data.items.map((item) => {
    const itemSaleValue = item.unitPriceCents * item.quantity - item.discountCents
    const itemTax = item.taxCents
    return {
      ItemCode: 'POS-ITEM',
      ItemName: item.name.slice(0, 100),
      Quantity: item.quantity,
      PCTCode: HS_RESTAURANT,
      TaxRate: data.taxRate,
      SaleValue: toPkr(itemSaleValue),
      Discount: toPkr(item.discountCents),
      FurtherTax: 0,
      TaxCharged: toPkr(itemTax),
      TotalAmount: toPkr(itemSaleValue + itemTax),
      InvoiceType: 1,
      RefUSIN: '',
    }
  })

  return {
    InvoiceNumber: data.invoiceNumber,
    POSID: data.posId,
    USIN: data.orderId,
    DateTime: fmtPralDate(data.placedAt),
    BuyerNTN: data.buyerNTN ?? '',
    BuyerCNIC: data.buyerCNIC ?? '',
    BuyerName: data.buyerName ?? '',
    BuyerPhoneNumber: data.buyerPhone ?? '',
    TotalBillAmount: toPkr(data.totalCents),
    TotalQuantity: totalQty,
    TotalSaleValue: toPkr(saleValueCents),
    TotalTaxCharged: toPkr(data.taxCents),
    Discount: toPkr(data.discountCents),
    FurtherTax: 0,
    PaymentMode: mapPaymentMode(data.paymentMethods),
    RefNumber: data.invoiceNumber,
    Latitude: process.env['FBR_LATITUDE'] ?? '',
    Longitude: process.env['FBR_LONGITUDE'] ?? '',
    InvoiceType: 1,
    Items: items,
  }
}

// ─── Submission ───────────────────────────────────────────────────────────────

interface PralResponse {
  StatusCode: number
  InvoiceNumber?: string   // FBR-assigned USIN returned on success
  Errors?: string[]
  Message?: string
}

export async function submitFbrInvoice(data: FbrOrderData): Promise<string> {
  const token = await getAuthToken()
  const payload = buildPayload(data)

  const res = await fetch(`${PRAL_BASE}/Pos/PosInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Token: token },
    body: JSON.stringify(payload),
  })

  if (res.status === 401) {
    // Token expired — clear cache and retry once
    await redis.del(TOKEN_CACHE_KEY)
    const freshToken = await getAuthToken()
    const retry = await fetch(`${PRAL_BASE}/Pos/PosInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Token: freshToken },
      body: JSON.stringify(payload),
    })
    if (!retry.ok) throw new Error(`PRAL submission failed after token refresh: ${retry.status}`)
    const retryBody = (await retry.json()) as PralResponse
    if (retryBody.StatusCode !== 0) throw new Error(`PRAL error: ${retryBody.Errors?.join(', ') ?? retryBody.Message}`)
    return retryBody.InvoiceNumber ?? data.invoiceNumber
  }

  if (!res.ok) throw new Error(`PRAL submission failed: ${res.status} ${await res.text()}`)

  const body = (await res.json()) as PralResponse
  if (body.StatusCode !== 0) {
    throw new Error(`PRAL rejected invoice: ${body.Errors?.join(', ') ?? body.Message ?? JSON.stringify(body)}`)
  }

  return body.InvoiceNumber ?? data.invoiceNumber
}

// ─── Order loader (called by worker) ──────────────────────────────────────────

export async function buildFbrDataForOrder(orderId: string): Promise<FbrOrderData | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { taxRate: true, fbrPosId: true } },
      items: {
        where: { status: { not: 'voided' } },
        include: { modifiers: true },
      },
      payments: { where: { status: 'paid' } },
      customer: { select: { name: true, phone: true, ntn: true, cnic: true } },
    },
  })

  if (!order) return null
  if (!order.concept.fbrPosId) return null    // concept not registered with FBR — skip silently

  const invoiceNumber = `INV-${order.id.slice(-10).toUpperCase()}`

  const items = order.items.map((item) => {
    const modTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents * item.quantity, 0)
    const lineCents = item.unitPriceCents * item.quantity + modTotal
    const taxRate = order.concept.taxRate / 100
    const taxCents = Math.round(lineCents * taxRate)
    return {
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxCents,
      discountCents: 0,
    }
  })

  return {
    orderId: order.id,
    invoiceNumber,
    posId: order.concept.fbrPosId,
    taxRate: order.concept.taxRate,
    items,
    discountCents: order.discountCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    paymentMethods: order.payments.map((p) => p.method),
    placedAt: order.placedAt,
    buyerNTN: (order.customer as { ntn?: string } | null)?.ntn,
    buyerCNIC: (order.customer as { cnic?: string } | null)?.cnic,
    buyerName: order.customer?.name ?? order.customerName ?? undefined,
    buyerPhone: order.customer?.phone ?? undefined,
  }
}
