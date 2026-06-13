'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../../store/auth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const PAD = ['1','2','3','4','5','6','7','8','9','','0','⌫']

export default function KDSLoginPage() {
  const router = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const token   = useAuthStore((s) => s.token)

  const [pin,     setPin]     = useState('')
  const [name,    setName]    = useState('')   // station operator name, sent with the PIN
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)
  const [shake,   setShake]   = useState(false)

  // Already authenticated — go straight to KDS
  useEffect(() => {
    if (token) router.replace('/kds/all')
  }, [token, router])

  async function submitPin(pinVal: string) {
    if (pinVal.length < 4 || loading) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: name.trim(), pin: pinVal }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: { message?: string } }
        throw new Error(d.error?.message ?? 'Wrong PIN')
      }
      const data = await res.json() as { token: string; user: { id: string; name: string; role: string } }
      setAuth(data.user, data.token)
      router.replace('/kds/all')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wrong PIN')
      setPin('')
      setShake(true)
      setTimeout(() => setShake(false), 600)
    } finally {
      setLoading(false)
    }
  }

  function pressDigit(d: string) {
    if (pin.length >= 8 || loading) return
    const next = pin + d
    setPin(next)
    // PINs are 4–8 digits; don't auto-fire at 4 (that truncated 6-digit
    // manager/CEO PINs and froze the pad). Auto-submit only when full (8);
    // otherwise the user taps "Sign in".
    if (next.length === 8) setTimeout(() => void submitPin(next), 100)
  }

  function pressBack() { setPin((p) => p.slice(0, -1)); setError('') }

  function trySubmit() {
    if (loading || pin.length < 4) return
    void submitPin(pin)
  }

  return (
    <div className="min-h-screen bg-[#080a0d] flex flex-col items-center justify-center px-6 select-none"
      style={{ background: 'radial-gradient(ellipse at 50% 30%, rgba(0,212,177,0.04) 0%, #080a0d 60%)' }}>

      {/* Logo */}
      <div className="mb-10 text-center">
        <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl mb-3"
          style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.2)' }}>
          <span className="text-2xl font-black" style={{ color: '#00D4B1' }}>S</span>
        </div>
        <p className="text-sm font-bold" style={{ color: 'rgba(255,255,255,0.5)' }}>Kitchen Display</p>
      </div>

      {/* Operator name — sent with the PIN so the server checks one hash. */}
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        autoComplete="off"
        className="w-full max-w-xs mb-5 rounded-2xl px-4 py-3 text-center outline-none"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: 'rgba(255,255,255,0.85)' }}
      />

      {/* PIN dots */}
      <div className={`flex gap-4 mb-6 transition-all ${shake ? 'animate-[shake_0.4s_ease]' : ''}`}
        style={{ animation: shake ? 'shake 0.4s ease' : undefined }}>
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <div key={i}
            className="h-4 w-4 rounded-full border-2 transition-all duration-100"
            style={{
              background:   i < pin.length ? '#00D4B1' : 'transparent',
              borderColor:  i < pin.length ? '#00D4B1' : 'rgba(255,255,255,0.15)',
              transform:    i < pin.length ? 'scale(1.15)' : 'scale(1)',
            }}
          />
        ))}
      </div>

      {/* Status line */}
      <div className="h-5 mb-6 text-center">
        {error ? (
          <p className="text-sm font-semibold" style={{ color: '#ef4444' }}>{error}</p>
        ) : loading ? (
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>Verifying…</p>
        ) : (
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.2)' }}>Enter your staff PIN</p>
        )}
      </div>

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-xs">
        {PAD.map((key, idx) => {
          if (key === '') return <div key={idx} />
          if (key === '⌫') return (
            <button key={idx} onClick={pressBack}
              disabled={!pin.length}
              className="h-16 rounded-2xl text-xl font-semibold transition-all active:scale-90 disabled:opacity-20"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.5)',
              }}
              onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)' }}
              onMouseUp={(e)   => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)' }}>
              ⌫
            </button>
          )
          return (
            <button key={idx} onClick={() => pressDigit(key)} disabled={loading}
              className="h-16 rounded-2xl text-2xl font-bold transition-all active:scale-90 disabled:opacity-30"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.09)',
                color: 'rgba(255,255,255,0.85)',
              }}
              onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,212,177,0.1)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(0,212,177,0.3)' }}
              onMouseUp={(e)   => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.09)' }}>
              {key}
            </button>
          )
        })}
      </div>

      {/* Explicit submit — PINs are variable length (4–8), the pad no longer
          auto-fires at 4. Enabled once 4 digits are in. */}
      <button
        onClick={trySubmit}
        disabled={loading || pin.length < 4}
        className="w-full max-w-xs mt-4 rounded-2xl py-4 text-sm font-black transition-all active:scale-[0.98] disabled:opacity-25"
        style={{
          background: (loading || pin.length < 4) ? 'rgba(255,255,255,0.05)' : 'rgba(0,212,177,0.9)',
          color: (loading || pin.length < 4) ? 'rgba(255,255,255,0.4)' : '#001512',
        }}>
        {loading ? 'Verifying…' : 'Sign in'}
      </button>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0) }
          20% { transform: translateX(-8px) }
          40% { transform: translateX(8px) }
          60% { transform: translateX(-6px) }
          80% { transform: translateX(6px) }
        }
      `}</style>
    </div>
  )
}
