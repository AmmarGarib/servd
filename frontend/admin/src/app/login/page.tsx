'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'
const STOREFRONT_URL  = process.env['NEXT_PUBLIC_STOREFRONT_URL']  ?? 'http://localhost:3002'

export default function StaffLoginPage() {
  const router  = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [pin,     setPin]     = useState('')
  const [error,   setError]   = useState('')
  const [status,  setStatus]  = useState('')   // status line shown while loading
  const [loading, setLoading] = useState(false)

  async function getCoords(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        ()    => resolve(null),   // denied or unavailable — let API decide
        { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: true },
      )
    })
  }

  async function submitPin(pinVal: string) {
    setError(''); setLoading(true)

    // Try to get location (non-blocking — API enforces if config requires it)
    setStatus('Getting your location…')
    const coords = await getCoords()

    setStatus('Signing in…')
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/pin`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pin: pinVal, ...coords }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: { message?: string } }
        throw new Error(d.error?.message ?? 'Invalid PIN')
      }
      const data = await res.json() as { token: string; user: { id: string; name: string; role: string } }
      setAuth(data.user, data.token)
      router.replace('/dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid PIN')
      setPin('')
    } finally {
      setLoading(false); setStatus('')
    }
  }

  function pressDigit(d: string) {
    if (pin.length >= 8 || loading) return
    const next = pin + d
    setPin(next)
    if (next.length >= 4) setTimeout(() => void submitPin(next), 120)
  }

  function pressBack() { if (!loading) setPin((p) => p.slice(0, -1)) }

  const PAD = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div className="min-h-screen bg-s-bg flex flex-col">

      {/* Brand bar */}
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg flex items-center justify-center font-black text-white text-xs"
            style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', boxShadow: '0 0 14px rgba(0,212,177,0.3)' }}>
            S
          </div>
          <span className="text-sm font-black tracking-tight text-s-text">servd</span>
        </div>
        <a href={STOREFRONT_URL} className="text-xs text-s-dim hover:text-s-muted transition-colors">
          Order food →
        </a>
      </div>

      {/* Centre card */}
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-xs">

          {/* Title */}
          <div className="text-center mb-8">
            <p className="text-[11px] font-bold text-s-muted uppercase tracking-[0.25em] mb-2">
              Staff Portal
            </p>
            <h1 className="text-2xl font-black text-s-text">Enter your PIN</h1>
            <p className="text-xs text-s-dim mt-1">Authorized personnel only</p>
          </div>

          {/* PIN dots */}
          <div className="flex justify-center gap-3 mb-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}
                className="h-3 w-3 rounded-full border-2 transition-all duration-100"
                style={{
                  background:   i < pin.length ? '#00D4B1'             : 'transparent',
                  borderColor:  i < pin.length ? '#00D4B1'             : 'rgba(255,255,255,0.15)',
                  transform:    i < pin.length ? 'scale(1.15)'         : 'scale(1)',
                  boxShadow:    i < pin.length ? '0 0 8px rgba(0,212,177,0.5)' : 'none',
                }} />
            ))}
          </div>

          {/* Status / error */}
          <div className="h-6 flex items-center justify-center mb-4">
            {error ? (
              <p className="text-xs text-s-red font-semibold text-center px-2">{error}</p>
            ) : status ? (
              <p className="text-xs text-s-muted">{status}</p>
            ) : null}
          </div>

          {/* Numpad */}
          <div className="grid grid-cols-3 gap-2.5">
            {PAD.map((key, idx) => {
              if (key === '') return <div key={idx} />
              if (key === '⌫') return (
                <button key={idx} onClick={pressBack} disabled={loading || pin.length === 0}
                  className="h-16 rounded-2xl border transition-all active:scale-95 select-none"
                  style={{
                    background:   'rgba(255,255,255,0.04)',
                    borderColor:  'rgba(255,255,255,0.08)',
                    color:        'rgba(255,255,255,0.35)',
                    fontSize:     '18px',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = 'rgba(255,255,255,0.65)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}>
                  ⌫
                </button>
              )
              return (
                <button key={idx} onClick={() => pressDigit(key)} disabled={loading}
                  className="h-16 rounded-2xl border font-bold text-xl transition-all active:scale-95 select-none disabled:opacity-30"
                  style={{
                    background:  'rgba(255,255,255,0.04)',
                    borderColor: 'rgba(255,255,255,0.08)',
                    color:       'rgba(255,255,255,0.82)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background   = 'rgba(0,212,177,0.08)'
                    e.currentTarget.style.borderColor  = 'rgba(0,212,177,0.25)'
                    e.currentTarget.style.color        = '#00D4B1'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background   = 'rgba(255,255,255,0.04)'
                    e.currentTarget.style.borderColor  = 'rgba(255,255,255,0.08)'
                    e.currentTarget.style.color        = 'rgba(255,255,255,0.82)'
                  }}>
                  {key}
                </button>
              )
            })}
          </div>

        </div>
      </div>
    </div>
  )
}
