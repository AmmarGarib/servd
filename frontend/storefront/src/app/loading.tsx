// Default route-level loading state — shown by Next.js while a route's data
// is being fetched on the server. Quiet pulse, no jank.

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div
        style={{
          width: '2.5rem',
          height: '2.5rem',
          border: '3px solid rgba(0,0,0,0.08)',
          borderTopColor: '#4ade80',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          [role="status"] > div { animation: none; opacity: 0.5; }
        }
      `}</style>
      <span className="sr-only">Loading…</span>
    </div>
  )
}
