// Skeleton for brand microsites — matches the hero + featured-card structure.

export default function BrandLoading() {
  return (
    <div>
      <div style={{ height: 'min(78dvh, 700px)', background: 'linear-gradient(135deg, rgba(0,0,0,0.04) 0%, rgba(0,0,0,0.08) 100%)' }} aria-hidden="true" />
      <div className="container" style={{ padding: '3rem 0', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} aria-hidden="true" style={{
            background: 'rgba(0,0,0,0.04)',
            borderRadius: '1rem',
            height: '320px',
          }} />
        ))}
      </div>
      <span className="sr-only" role="status">Loading brand…</span>
    </div>
  )
}
