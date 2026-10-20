import { PaymentsByClassificationCard } from '../../../components/finance/PaymentsByClassificationCard'

// The finance dashboard (owner, 2026-10-05: numbers are added once the owner
// picks them). 2026-10-20: "Payments by classification" (the internal payment
// classification, from the Payments register).
export default function FinanceDashboard() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 py-7 sm:px-7">
        <h1 className="text-2xl font-black text-white/90">Finance dashboard</h1>
      </header>
      <div className="grid grid-cols-1 gap-4 px-4 pb-8 sm:px-7 md:grid-cols-2 xl:grid-cols-3">
        <PaymentsByClassificationCard />
      </div>
    </div>
  )
}
