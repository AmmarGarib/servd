// Route-level loading fallback for the whole admin app — Next renders this
// automatically during navigation / Suspense, so the servd spinner shows on
// every route transition without per-page wiring.
import { LoadingScreen } from '../components/ui/Loader'

export default function Loading() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <LoadingScreen label="Loading…" />
    </div>
  )
}
