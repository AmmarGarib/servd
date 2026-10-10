'use client'

// Confirm/cancel landing page — guest hits this from the SMS or email link
// (no auth needed, the unguessable token is enough).

import { useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { MagneticLink } from '@/components/ui/MagneticButton'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export default function ReserveConfirmPage() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<'idle' | 'confirmed' | 'cancelled' | 'error'>('idle')
  const [busy, setBusy] = useState(false)

  const act = async (action: 'confirm' | 'cancel') => {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/reservations/public/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error('Failed')
      const data = await res.json() as { status: string }
      setStatus(data.status === 'cancelled' ? 'cancelled' : 'confirmed')
    } catch {
      setStatus('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '32rem', width: '100%' }}>
        {status === 'idle' && (
          <>
            <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginBottom: '0.75rem' }}>
              Your reservation
            </h1>
            <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem' }}>
              Confirm you&rsquo;re still coming, or cancel to free up the table.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => act('confirm')} disabled={busy} className="servd-btn-primary" style={{ padding: '0.85rem 2rem' }}>
                {busy ? 'Working…' : 'I’m coming ✓'}
              </button>
              <button onClick={() => act('cancel')} disabled={busy} className="servd-btn-secondary" style={{ padding: '0.85rem 2rem' }}>
                Cancel reservation
              </button>
            </div>
          </>
        )}

        {status === 'confirmed' && (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✓</div>
            <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginBottom: '0.75rem' }}>Confirmed!</h1>
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
              See you soon. We&rsquo;ll send a reminder 2 hours before.
            </p>
            <Link href="/home" className="servd-btn-secondary">Back to servd</Link>
          </>
        )}

        {status === 'cancelled' && (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>○</div>
            <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginBottom: '0.75rem' }}>Cancelled.</h1>
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
              Sorry to miss you. Book again any time.
            </p>
            <MagneticLink href="/home#kitchens" className="servd-btn-primary">See the kitchens</MagneticLink>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>Couldn&rsquo;t process that link.</h1>
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>It may have expired. Call the restaurant if you need help.</p>
            <Link href="/home" className="servd-btn-secondary">Back home</Link>
          </>
        )}
      </div>
    </div>
  )
}
