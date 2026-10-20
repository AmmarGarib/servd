'use client'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../../store/auth'
import { useIsManager } from '../managerRole'
import { fmtPkr } from '../../../lib/money'
import { flowErrorMessage, fetchShiftSummary } from './flowApi'

// Order Summary (owner's flow, step 9): the current shift's figures —
// GET /pos/shifts/current then GET /pos/shifts/:id/zreport (the one shift summary).
export function OrderSummary({ onMenu }: { onMenu: () => void }) {
  const isManager = useIsManager()
  const role = useAuthStore((st) => st.user?.role ?? null)
  const fullReport = isManager || role === 'finance'
  const q = useQuery({ queryKey: ['pos', 'shift-summary'], queryFn: fetchShiftSummary, refetchInterval: 30_000 })
  const r = q.data?.shift ?? null

  const row = (label: string, v: string, strong?: boolean) => (
    <div className={`flex items-baseline justify-between gap-3 py-2 ${strong ? 'text-lg font-bold text-kds-text' : 'text-base text-kds-subtext'}`}>
      <dt>{label}</dt><dd className={strong ? 'text-kds-green' : 'font-semibold text-kds-text'}>{v}</dd>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">Order Summary</h1>
        <div className="ml-auto flex items-center gap-2">
          {fullReport && <Link href="/pos/shift" className="flex min-h-11 items-center rounded-lg border border-kds-border px-4 text-sm font-semibold text-kds-text hover:border-kds-green">Full Z-report</Link>}
          <Link href="/pos/shift" className="flex min-h-11 items-center rounded-lg border border-kds-border px-4 text-sm font-semibold text-kds-text hover:border-kds-green">Shift / close shift</Link>
        </div>
      </div>
      <div className="mx-auto w-full max-w-xl flex-1 overflow-y-auto p-4">
        {q.isLoading && <p className="text-sm text-kds-subtext">Loading your shift…</p>}
        {q.isError && <p role="alert" className="text-sm font-semibold text-kds-red">{flowErrorMessage(q.error)}</p>}
        {q.data && !r && <p className="rounded-xl border border-kds-amber p-4 text-sm font-semibold text-kds-amber">You have no open shift. Open one from Shift / close shift to start taking orders.</p>}
        {r && (
          <>
            <p className="mb-2 text-sm text-kds-subtext">Your drawer, opened {new Date(r.openedAt).toLocaleString()}</p>
            <dl className="divide-y divide-kds-border rounded-xl border border-kds-border bg-kds-card px-4">
              {row('Sales (before tips)', fmtPkr(r.salesExTipsCents), true)}
              {row('Gross takings', fmtPkr(r.grossCents))}
              {row('Orders', String(r.ordersCount))}
              {row('Tax', fmtPkr(r.taxCents))}
              {r.serviceChargeCents > 0 && row('Service charge', fmtPkr(r.serviceChargeCents))}
              {r.tipsCents > 0 && row('Tips', fmtPkr(r.tipsCents))}
              {r.discountCents > 0 && row('Discounts', `−${fmtPkr(r.discountCents)}`)}
              {r.compCents > 0 && row('No Charge', fmtPkr(r.compCents))}
              {r.refundsCents > 0 && row('Refunds', `−${fmtPkr(r.refundsCents)}`)}
              {r.openTickets && r.openTickets.count > 0 && row(`Open tickets (${r.openTickets.count})`, fmtPkr(r.openTickets.dueCents))}
            </dl>
            <h2 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wider text-kds-subtext">By tender</h2>
            <dl className="divide-y divide-kds-border rounded-xl border border-kds-border px-4">
              {row('Cash', fmtPkr(r.byTender.cashCents))}
              {row('Card', fmtPkr(r.byTender.cardCents))}
              {row('Raast QR', fmtPkr(r.byTender.raastCents))}
              {r.byTender.onAccountCents > 0 && row('On account', fmtPkr(r.byTender.onAccountCents))}
              {r.byTender.walletCents > 0 && row('Wallet', fmtPkr(r.byTender.walletCents))}
              {r.byTender.giftCardCents > 0 && row('Gift card', fmtPkr(r.byTender.giftCardCents))}
            </dl>
            <h2 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wider text-kds-subtext">By how it was closed</h2>
            <dl className="divide-y divide-kds-border rounded-xl border border-kds-border px-4">
              {row(`Keenu · ${r.bySettlement.keenu.orders}`, fmtPkr(r.bySettlement.keenu.amountCents))}
              {row(`servd · ${r.bySettlement.servd.orders}`, fmtPkr(r.bySettlement.servd.amountCents))}
              {r.bySettlement.none.orders > 0 && row(`Other · ${r.bySettlement.none.orders}`, fmtPkr(r.bySettlement.none.amountCents))}
            </dl>
          </>
        )}
      </div>
    </div>
  )
}
