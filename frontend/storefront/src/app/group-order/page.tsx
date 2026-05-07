'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export default function GroupOrderEntryPage() {
  const router = useRouter()
  const params = useSearchParams()
  const [mode, setMode] = useState<'start' | 'join'>('start')

  // Start
  const [conceptSlug, setConceptSlug] = useState(params.get('brand') ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Join
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase())
  const [joinName, setJoinName] = useState('')

  const start = async () => {
    if (!conceptSlug || !name) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/group-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conceptSlug, initiatorName: name }),
      })
      if (!res.ok) throw new Error('Could not start group')
      const go = await res.json() as { shareCode: string }
      router.push(`/group-order/${go.shareCode}?me=${encodeURIComponent(name)}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  const join = async () => {
    if (!code || !joinName) return
    router.push(`/group-order/${code.toUpperCase()}?me=${encodeURIComponent(joinName)}`)
  }

  return (
    <div className="container-narrow section">
      <p className="text-xs uppercase tracking-widest text-[color:var(--servd-green-dark)] font-bold mb-2">Group order</p>
      <h1 className="text-3xl font-extrabold mb-3">Eat together. One bill. Or split.</h1>
      <p className="text-[color:var(--servd-mute)] mb-8">Start a shared cart, send the link, everyone adds their own — checkout once.</p>

      <div className="flex gap-2 mb-4">
        <button onClick={() => setMode('start')} aria-pressed={mode === 'start'}
          className={`px-4 py-2 rounded-full font-bold text-sm ${mode === 'start' ? 'bg-[color:var(--servd-green)] text-black' : 'bg-white border'}`}>
          Start a group
        </button>
        <button onClick={() => setMode('join')} aria-pressed={mode === 'join'}
          className={`px-4 py-2 rounded-full font-bold text-sm ${mode === 'join' ? 'bg-[color:var(--servd-green)] text-black' : 'bg-white border'}`}>
          Join with code
        </button>
      </div>

      {mode === 'start' && (
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          <label className="block mb-3">
            <span className="block text-xs text-[color:var(--servd-mute)] font-bold mb-1">Brand slug</span>
            <input value={conceptSlug} onChange={(e) => setConceptSlug(e.target.value)} placeholder="e.g. simmer" className="servd-input" />
          </label>
          <label className="block mb-3">
            <span className="block text-xs text-[color:var(--servd-mute)] font-bold mb-1">Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="servd-input" />
          </label>
          {err && <p className="text-sm text-red-700">{err}</p>}
          <button onClick={start} disabled={busy || !conceptSlug || !name} className="servd-btn-primary w-full mt-2">
            {busy ? 'Creating…' : 'Start group'}
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          <label className="block mb-3">
            <span className="block text-xs text-[color:var(--servd-mute)] font-bold mb-1">Group code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="6 chars" className="servd-input font-mono uppercase tracking-widest" />
          </label>
          <label className="block mb-3">
            <span className="block text-xs text-[color:var(--servd-mute)] font-bold mb-1">Your name</span>
            <input value={joinName} onChange={(e) => setJoinName(e.target.value)} className="servd-input" />
          </label>
          <button onClick={join} disabled={!code || !joinName} className="servd-btn-primary w-full mt-2">
            Join group
          </button>
        </div>
      )}

      <p className="mt-6 text-xs text-[color:var(--servd-mute)]">
        After ordering, host can <Link href="#" className="underline">split the bill</Link> at the POS — each diner pays their own.
      </p>
    </div>
  )
}
