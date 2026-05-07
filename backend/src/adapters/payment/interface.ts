// Payment adapter interface — swappable per spec §7.2
// Implement this interface for Keenu, JazzCash, Easypaisa, etc.

export interface PaymentInitInput {
  orderId: string
  amountCents: number
  currency?: string       // default 'PKR'
  customerPhone?: string
  customerEmail?: string
  description?: string
  callbackUrl: string     // where gateway POSTs result
  successUrl?: string     // for redirect-based flows
  failureUrl?: string
}

export interface PaymentInitResult {
  gatewayRef: string      // gateway's transaction reference
  redirectUrl?: string    // for redirect flows (web checkout)
  qrCode?: string         // for QR payment flows
  deepLink?: string       // for wallet app deep links
  expiresAt?: string      // ISO 8601
}

export interface PaymentStatusResult {
  gatewayRef: string
  status: 'paid' | 'pending' | 'failed' | 'refunded'
  paidAt?: string
  amountCents: number
  rawResponse: unknown
}

export interface RefundInput {
  gatewayRef: string
  amountCents: number
  reason?: string
}

export interface RefundResult {
  refundRef: string
  status: 'processed' | 'pending'
  amountCents: number
}

export interface PaymentAdapter {
  readonly name: string
  initiatePayment(input: PaymentInitInput): Promise<PaymentInitResult>
  checkStatus(gatewayRef: string): Promise<PaymentStatusResult>
  refund(input: RefundInput): Promise<RefundResult>
}
