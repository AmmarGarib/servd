'use client'
// One cash voucher — its chain, its actions, the print and the signed photo.
// The approvals inbox and the list link here.

import { useParams } from 'next/navigation'
import { VoucherDetail } from '../VoucherDetail'

export default function CashVoucherPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : ''
  return <VoucherDetail id={id} />
}
