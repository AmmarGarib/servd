'use client'
import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Dashboard error boundary caught:', error)
  }, [error])

  return (
    <div className="min-h-screen bg-kds-bg p-6 text-kds-text">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-black text-kds-red mb-4">Client error</h1>
        <p className="mb-2 text-kds-subtext">{error.name}: {error.message}</p>
        {error.digest && <p className="mb-4 text-xs text-kds-subtext">digest: {error.digest}</p>}
        <pre className="text-xs bg-kds-card border border-kds-border rounded p-4 overflow-auto whitespace-pre-wrap">
          {error.stack}
        </pre>
        <button
          onClick={reset}
          className="mt-4 rounded-xl bg-kds-green px-4 py-2 font-bold text-black"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
