// A workspace dashboard with nothing on it yet (owner, 2026-10-05: "I'll
// choose what numbers I want to see"). Numbers are added per dashboard once
// the owner picks them; the old dashboards' API endpoints remain as sources.

export function BlankDashboard({ title }: { title: string }) {
  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-7">
        <h1 className="text-2xl font-black text-white/90">{title}</h1>
        <p className="text-sm text-white/40 mt-1">No numbers chosen yet.</p>
      </header>
    </div>
  )
}
