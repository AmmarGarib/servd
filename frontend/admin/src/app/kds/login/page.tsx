'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../../store/auth'

/**
 * The KDS PIN pad is gone.
 *
 * It existed because a kitchen display was a shared screen and typing an email
 * on it was unreasonable. Every member of staff now has their own tablet, so
 * the screen signs in the same way everything else does, and a four-digit code
 * no longer mints a session that reaches the rest of the system.
 *
 * The route is kept as a redirect rather than deleted: it is bookmarked on
 * kitchen screens and pinned to home screens, and a 404 mid-service is a worse
 * outcome than a hop. Anyone already signed in goes straight to the board.
 */
export default function KDSLoginRedirect() {
  const router = useRouter()
  const user   = useAuthStore((s) => s.user)

  useEffect(() => {
    router.replace(user ? '/kds' : '/login')
  }, [user, router])

  return (
    <div className="min-h-screen bg-s-bg flex items-center justify-center">
      <p className="text-sm text-s-dim">Taking you to sign in…</p>
    </div>
  )
}
