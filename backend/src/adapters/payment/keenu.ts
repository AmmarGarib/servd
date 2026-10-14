// Keenu Payment Gateway Adapter
// Contact: keenu.com.pk for merchant onboarding + sandbox credentials
// API docs: provided after merchant onboarding

import type { PaymentAdapter, PaymentInitInput, PaymentInitResult, PaymentStatusResult, RefundInput, RefundResult } from './interface.js'
import { AppError } from '../../lib/errors.js'
import { sandboxBlocks } from '../../lib/sandbox.js'

const BASE_URL = process.env['KEENU_BASE_URL'] ?? 'https://api.keenu.com.pk/v1'
const API_KEY = process.env['KEENU_API_KEY'] ?? ''
const MERCHANT_ID = process.env['KEENU_MERCHANT_ID'] ?? ''

async function keenuFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (sandboxBlocks('payment', { summary: 'keenu' })) throw new AppError('SANDBOX_NO_PAYMENTS', 'Practice copy: no payment gateway is called', 422)
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
      'X-Merchant-Id': MERCHANT_ID,
      ...options.headers,
    },
  })

  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Keenu API error ${res.status}: ${error}`)
  }

  return res.json() as Promise<T>
}

export class KeenuAdapter implements PaymentAdapter {
  readonly name = 'keenu'

  async initiatePayment(input: PaymentInitInput): Promise<PaymentInitResult> {
    // Keenu API shape — adjust once actual API docs are received
    const response = await keenuFetch<{
      transaction_id: string
      qr_code?: string
      payment_url?: string
      expires_at?: string
    }>('/payments/initiate', {
      method: 'POST',
      body: JSON.stringify({
        merchant_id: MERCHANT_ID,
        amount: input.amountCents, // Keenu uses paisa (smallest unit of PKR)
        currency: 'PKR',
        order_id: input.orderId,
        customer_phone: input.customerPhone ?? '',
        description: input.description ?? 'servd order',
        callback_url: input.callbackUrl,
      }),
    })

    return {
      gatewayRef: response.transaction_id,
      redirectUrl: response.payment_url,
      qrCode: response.qr_code,
      expiresAt: response.expires_at,
    }
  }

  async checkStatus(gatewayRef: string): Promise<PaymentStatusResult> {
    const response = await keenuFetch<{
      transaction_id: string
      status: string
      amount: number
      paid_at?: string
    }>(`/payments/${gatewayRef}`)

    const statusMap: Record<string, PaymentStatusResult['status']> = {
      SUCCESS: 'paid',
      PENDING: 'pending',
      FAILED: 'failed',
      REFUNDED: 'refunded',
    }

    return {
      gatewayRef,
      status: statusMap[response.status] ?? 'pending',
      paidAt: response.paid_at,
      amountCents: response.amount,
      rawResponse: response,
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const response = await keenuFetch<{ refund_id: string; status: string; amount: number }>(
      '/refunds',
      {
        method: 'POST',
        body: JSON.stringify({
          transaction_id: input.gatewayRef,
          amount: input.amountCents,
          reason: input.reason ?? 'Customer refund',
        }),
      },
    )

    return {
      refundRef: response.refund_id,
      status: response.status === 'PROCESSED' ? 'processed' : 'pending',
      amountCents: response.amount,
    }
  }
}
