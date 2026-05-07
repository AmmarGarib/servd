// JazzCash Payment Gateway Adapter (stub — implement once credentials obtained)
import type { PaymentAdapter, PaymentInitInput, PaymentInitResult, PaymentStatusResult, RefundInput, RefundResult } from './interface.js'

export class JazzCashAdapter implements PaymentAdapter {
  readonly name = 'jazzcash'

  async initiatePayment(_input: PaymentInitInput): Promise<PaymentInitResult> {
    throw new Error('JazzCash integration not yet configured. Obtain credentials from JazzCash merchant portal.')
  }

  async checkStatus(_gatewayRef: string): Promise<PaymentStatusResult> {
    throw new Error('JazzCash integration not yet configured.')
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    throw new Error('JazzCash integration not yet configured.')
  }
}
