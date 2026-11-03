// Test helper — walk a draft PO through the approval chain (owner, 2026-11-03: buyer → finance → the CEO) with the
// service functions directly (the routes' rights are tested in poApprovalChain.test.ts). Bought on the supplier's
// credit by default (no cash voucher); `payByCash: true` raises the PO's cash voucher as the CEO's approval does.
import { submitPo, passPoStep, approvePo } from '../src/modules/procurement/service.js'

export async function approvePoChain(poId: string, by: string, o: { payByCash?: boolean; buyerId?: string; financeId?: string } = {}) {
  const s = await submitPo(poId, by)
  if (s.status === 'buyer_check') await passPoStep(poId, o.buyerId ?? by, 'buyer_check')
  await passPoStep(poId, o.financeId ?? by, 'finance_check')
  return approvePo(poId, by, undefined, { payByCash: o.payByCash ?? false })
}
