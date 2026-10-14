'use client'
// One cash request — its steps, its actions, the receipts and the print.
// The approvals inbox and the list link here.

import { useParams } from 'next/navigation'
import { VoucherDetail } from '../VoucherDetail'

export default function CashVoucherPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : ''
  return <VoucherDetail id={id} />
}
