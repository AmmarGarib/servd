'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Template {
  key: string
  emoji: string
  label: string
  blurb: string
  primaryColor: string
  stationCount: number
  categoryCount: number
  itemCount: number
}

export default function SignupPage() {
  const router = useRouter()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [selectedTpl, setSelectedTpl] = useState<string>('')
  const [restaurantName, setRestaurantName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Lazy-load templates on first render
  if (!templates) {
    fetch(`${API_URL}/api/v1/tenants/templates`)
      .then((r) => r.json())
      .then((d: Template[]) => setTemplates(d))
      .catch(() => setTemplates([]))
  }

  async function handleSignup() {
    setError(null); setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/tenants/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName, ownerEmail, password,
          restaurantName, templateKey: selectedTpl,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error?.message ?? 'Signup failed')
        return
      }
      setSuccess(data.message)
      setTimeout(() => router.push('/login'), 2200)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selected = templates?.find((t) => t.key === selectedTpl)

  return (
    <main className="min-h-screen flex items-center justify-center p-4" style={{ background: '#090a0e' }}>
      <div className="w-full max-w-3xl">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-1.5 rounded-full transition-all"
              style={{
                width: n === step ? 32 : 16,
                background: n <= step ? '#00D4B1' : 'rgba(255,255,255,0.1)',
              }} />
          ))}
        </div>

        {/* ── Step 1: pick a template ─────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black text-white/95">Pick your starting point</h1>
              <p className="text-sm text-white/50 mt-2 max-w-md mx-auto">
                We'll seed a real menu, stations, and recipes — you'll be taking orders in 60 seconds. Edit anything later.
              </p>
            </div>

            {!templates && <p className="text-center text-white/40">Loading templates…</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {templates?.map((t) => {
                const active = selectedTpl === t.key
                return (
                  <button key={t.key} onClick={() => setSelectedTpl(t.key)}
                    className="rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5"
                    style={{
                      background: active ? `${t.primaryColor}15` : 'rgba(255,255,255,0.025)',
                      border: active ? `1.5px solid ${t.primaryColor}` : '1px solid rgba(255,255,255,0.06)',
                      boxShadow: active ? `0 0 18px ${t.primaryColor}30` : 'none',
                    }}>
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-3xl">{t.emoji}</span>
                      {active && <span className="text-[10px] font-black text-white/85 bg-white/10 px-1.5 py-0.5 rounded">PICKED</span>}
                    </div>
                    <p className="font-black text-white/90">{t.label}</p>
                    <p className="text-xs text-white/55 mt-1 leading-relaxed">{t.blurb}</p>
                    <p className="text-[11px] text-white/35 mt-3">
                      {t.itemCount} items · {t.stationCount} stations · {t.categoryCount} categories
                    </p>
                  </button>
                )
              })}
            </div>

            <div className="flex justify-between gap-2">
              <Link href="/welcome" className="text-sm text-white/45 hover:text-white">← Back to home</Link>
              <button
                onClick={() => setStep(2)}
                disabled={!selectedTpl}
                className="rounded-xl bg-kds-green px-6 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
                Next →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: restaurant + owner details ──────────────────────── */}
        {step === 2 && (
          <div className="space-y-5 max-w-md mx-auto">
            <div className="text-center">
              <h1 className="text-3xl font-black text-white/95">Tell us about you</h1>
              <p className="text-sm text-white/50 mt-2">
                14-day free trial. No credit card. You can cancel any time.
              </p>
            </div>

            <div className="rounded-2xl p-5 space-y-4"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Field label="Restaurant name *">
                <input value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)}
                  placeholder="e.g. Mubarak Biryani Co." className="signup-input" autoFocus />
              </Field>
              <Field label="Your name *">
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Ali Khan" className="signup-input" />
              </Field>
              <Field label="Email *">
                <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} type="email"
                  placeholder="ali@mubarakbiryani.pk" className="signup-input" />
              </Field>
              <Field label="Password *" hint="Minimum 8 characters.">
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password"
                  className="signup-input" />
              </Field>
              {selected && (
                <div className="text-xs text-white/45 rounded-lg px-3 py-2"
                  style={{ background: `${selected.primaryColor}10`, border: `1px solid ${selected.primaryColor}40` }}>
                  Template: <span className="font-bold" style={{ color: selected.primaryColor }}>{selected.emoji} {selected.label}</span>
                </div>
              )}
            </div>

            <div className="flex justify-between gap-2">
              <button onClick={() => setStep(1)} className="rounded-xl border border-white/10 px-5 py-3 text-sm text-white/55 hover:text-white">
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={!restaurantName.trim() || !ownerName.trim() || !ownerEmail.includes('@') || password.length < 8}
                className="rounded-xl bg-kds-green px-6 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
                Review →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: confirm + create ────────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-5 max-w-md mx-auto">
            <div className="text-center">
              <h1 className="text-3xl font-black text-white/95">Ready to launch?</h1>
              <p className="text-sm text-white/50 mt-2">We'll set up your restaurant in 5 seconds flat.</p>
            </div>

            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Row label="Restaurant" value={restaurantName} />
              <Row label="Owner"      value={`${ownerName} · ${ownerEmail}`} />
              <Row label="Template"   value={selected ? `${selected.emoji} ${selected.label}` : '—'} />
              <Row label="Trial"      value="14 days free, then choose a plan" />
            </div>

            {error && (
              <div className="rounded-lg px-4 py-3 text-sm text-kds-red"
                style={{ background: 'rgba(255,77,79,0.1)', border: '1px solid rgba(255,77,79,0.3)' }}>
                {error}
              </div>
            )}

            {success && (
              <div className="rounded-lg px-4 py-3 text-sm text-kds-green text-center"
                style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.3)' }}>
                ✓ {success}<br/>
                <span className="text-xs text-white/55">Redirecting to login…</span>
              </div>
            )}

            {!success && (
              <div className="flex justify-between gap-2">
                <button onClick={() => setStep(2)} className="rounded-xl border border-white/10 px-5 py-3 text-sm text-white/55 hover:text-white">
                  ← Back
                </button>
                <button onClick={handleSignup} disabled={busy}
                  className="rounded-xl bg-kds-green px-8 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
                  {busy ? 'Creating your restaurant…' : 'Launch restaurant 🚀'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <style jsx>{`
        .signup-input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.9);
          border-radius: 0.625rem;
          padding: 0.625rem 0.875rem;
          font-size: 0.875rem;
          outline: none;
        }
        .signup-input:focus {
          border-color: #00D4B1;
        }
      `}</style>
    </main>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55 block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/35 mt-1">{hint}</p>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-white/45 shrink-0">{label}</span>
      <span className="text-white/85 text-right">{value}</span>
    </div>
  )
}
