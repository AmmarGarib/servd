// Skeleton for the brand hub. Mirrors the card grid the real page renders so
// the user sees layout immediately, not a spinner over a white page.

export default function OrderHubLoading() {
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--servd-bg)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1.25rem clamp(1.25rem, 5vw, 2.5rem)',
          borderBottom: '1px solid rgba(0,0,0,0.07)',
        }}
      >
        <span style={{ fontSize: '1.6rem', fontWeight: 900, letterSpacing: '-0.04em' }}>servd</span>
      </header>
      <div style={{ padding: 'clamp(2rem, 5vw, 4rem) clamp(1.25rem, 5vw, 2.5rem)', maxWidth: '60rem', margin: '0 auto' }}>
        <div
          aria-hidden="true"
          style={{ height: '2.5rem', width: '14rem', borderRadius: '0.5rem', background: 'rgba(0,0,0,0.06)', marginBottom: '0.5rem' }}
        />
        <div
          aria-hidden="true"
          style={{ height: '0.95rem', width: '20rem', borderRadius: '0.25rem', background: 'rgba(0,0,0,0.06)', marginBottom: '2.5rem' }}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '1.25rem',
          }}
          role="status"
          aria-label="Loading brands"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                background: 'rgba(0,0,0,0.04)',
                borderRadius: '20px',
                height: '200px',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
