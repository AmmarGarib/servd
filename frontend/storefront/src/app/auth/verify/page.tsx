'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../../store/customerAuth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

function VerifyInner() {
  const router    = useRouter()
  const params    = useSearchParams()
  const token     = params.get('token')
  const setAuth   = useCustomerAuth(s => s.setAuth)
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) { setStatus('error'); setMessage('No login token found.'); return }
    fetch(`${API_URL}/api/v1/auth/customer/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async res => {
        if (!res.ok) {
          const d = await res.json() as { error?: { message?: string } }
          throw new Error(d.error?.message ?? 'Invalid or expired link')
        }
        return res.json() as Promise<{ token: string; customer: { id: string } }>
      })
      .then(({ token: t, customer }) => {
        setAuth(t, customer.id)
        setStatus('success')
        setTimeout(() => router.replace('/account'), 1400)
      })
      .catch((e: Error) => { setStatus('error'); setMessage(e.message) })
  }, [token, setAuth, router])

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: 'transparent' }}>
      <div className="text-center space-y-4 max-w-sm w-full"
        style={{ animationName: 'fadeSlideUp', animationDuration: '0.5s', animationFillMode: 'both' }}>
        {status === 'verifying' && (
          <>
            <div className="relative h-14 w-14 mx-auto">
              <div className="absolute inset-0 rounded-full" style={{ border: '2px solid rgba(0,0,0,0.07)' }} />
              <div className="absolute inset-0 rounded-full animate-spin"
                style={{ border: '2px solid transparent', borderTopColor: 'rgba(0,212,177,0.6)' }} />
            </div>
            <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>Signing you in…</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-6xl">✅</div>
            <p className="font-black text-2xl" style={{ color: '#18160f' }}>You&apos;re in!</p>
            <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>Taking you to your account…</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-6xl">🔗</div>
            <p className="font-black text-2xl" style={{ color: '#18160f' }}>Link expired</p>
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(24,22,15,0.5)' }}>{message}</p>
            <Link href="/login"
              className="inline-block mt-2 rounded-full font-black px-6 py-3 text-sm transition-all hover:scale-[1.02]"
              style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', color: '#fff', boxShadow: '0 4px 16px rgba(0,212,177,0.25)' }}>
              Get a new link →
            </Link>
          </>
        )}
      </div>
    </main>
  )
}

export default function VerifyPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'transparent' }}>
        <div className="relative h-8 w-8">
          <div className="absolute inset-0 rounded-full" style={{ border: '2px solid rgba(0,0,0,0.07)' }} />
          <div className="absolute inset-0 rounded-full animate-spin"
            style={{ border: '2px solid transparent', borderTopColor: 'rgba(0,212,177,0.6)' }} />
        </div>
      </main>
    }>
      <VerifyInner />
    </Suspense>
  )
}
