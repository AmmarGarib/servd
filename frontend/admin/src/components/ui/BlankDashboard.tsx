// A workspace dashboard (owner, 2026-10-05: "I'll choose what numbers I want to see"). 2026-10-26 (C4): the owner
// picked a starter set per dashboard; the tiles read GET /dashboards/:id/numbers. Changes are the owner's to ask for.
import { DashboardTiles, type DashboardId } from './DashboardTiles'

export function BlankDashboard({ title, id }: { title: string; id: DashboardId }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 py-7 sm:px-7">
        <h1 className="text-2xl font-black text-white/90">{title}</h1>
      </header>
      <div className="px-4 pb-8 sm:px-7"><DashboardTiles id={id} /></div>
    </div>
  )
}
