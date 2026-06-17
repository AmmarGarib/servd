'use client'

// Live shared cart. Members all see the same list, can add their own items,
// host can lock + submit. Polls every 3s — could be SSE later.

import { useEffect, useState, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { MagneticLink } from '@/components/ui/MagneticButton'
import { useCustomerAuth } from '../../../store/customerAuth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Member { id: string; displayName: string }
interface GroupItem { id: string; memberId: string; menuItemId: string; name: string; quantity: number; unitPriceCents: number; notes: string | null }
interface GroupOrder {
  id: string; status: 'open' | 'locked' | 'submitted' | 'cancelled'
  shareCode: string; initiatorName: string; closingAt: string | null; orderId: string | null
  concept: { id: string; name: string; slug: string; taxRate: number }
  members: Member[]
  items: GroupItem[]
}
interface MenuItem { id: string; name: string; priceCents: number; isAvailable: boolean }
interface Category { id: string; name: string; items: MenuItem[] }

function fmt(cents: number) { return `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}` }

export default function GroupOrderRoom() {
  const router = useRouter()
  const { code } = useParams<{ code: string }>()
  const searchParams = useSearchParams()
  const myName = searchParams.get('me') ?? ''
  const token = useCustomerAuth((s) => s.token)

  const [go, setGo] = useState<GroupOrder | null>(null)
  const [menu, setMenu] = useState<Category[]>([])
  const [meId, setMeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Group orders are auth-gated server-side (anonymous submit was an unpaid-
  // kitchen-ticket primitive). If we don't have a token, bounce to login and
  // resume here after sign-in.
  useEffect(() => {
    if (!token) {
      const next = encodeURIComponent(`/group-order/${code}?me=${encodeURIComponent(myName)}`)
      router.replace(`/login?next=${next}`)
    }
  }, [token, code, myName, router])

  const authHeaders = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {}),
    [token],
  )

  // Load + poll
  useEffect(() => {
    if (!token) return
    let cancelled = false
    async function fetchAll() {
      try {
        const res = await fetch(`${API_URL}/api/v1/group-orders/${code}`, { headers: authHeaders })
        if (!res.ok) throw new Error('Group not found')
        const data = await res.json() as GroupOrder
        if (cancelled) return
        setGo(data)

        if (menu.length === 0) {
          const m = await fetch(`${API_URL}/api/v1/storefront/${data.concept.slug}/menu`)
          if (m.ok && !cancelled) setMenu(await m.json() as Category[])
        }

        // Auto-join as the named member if not already in (idempotent server-side)
        if (myName && !data.members.some((m) => m.displayName === myName)) {
          await fetch(`${API_URL}/api/v1/group-orders/${code}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ displayName: myName }),
          })
        }
        const me = data.members.find((m) => m.displayName === myName)
        if (me) setMeId(me.id)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void fetchAll()
    const iv = setInterval(() => void fetchAll(), 3000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [code, myName, menu.length, token, authHeaders])

  const subtotal = useMemo(() => go?.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0) ?? 0, [go])
  const tax = go ? Math.round(subtotal * (go.concept.taxRate / 100)) : 0
  const total = subtotal + tax

  const addItem = async (item: MenuItem) => {
    if (!meId || !go) return
    // memberId is derived server-side from the authenticated customer — no
    // longer accepted in the request body.
    await fetch(`${API_URL}/api/v1/group-orders/${code}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ menuItemId: item.id, quantity: 1 }),
    })
  }
  const removeItem = async (id: string) => {
    await fetch(`${API_URL}/api/v1/group-orders/${code}/items/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  }
  const submit = async () => {
    if (!go) return
    setBusy(true)
    try {
      await fetch(`${API_URL}/api/v1/group-orders/${code}/lock`, { method: 'POST', headers: authHeaders })
      const res = await fetch(`${API_URL}/api/v1/group-orders/${code}/submit`, { method: 'POST', headers: authHeaders })
      const data = await res.json() as { orderId: string }
      router.push(`/${go.concept.slug}/order/${data.orderId}`)
    } finally { setBusy(false) }
  }

  if (error) return <div className="container-narrow section text-center"><h1 className="text-2xl font-bold">{error}</h1><Link href="/group-order" className="text-[color:var(--servd-green-dark)] underline">Try again</Link></div>
  if (!go) return <div className="container-narrow section">Loading group…</div>
  if (go.status === 'submitted' && go.orderId) return <div className="container-narrow section text-center"><h1 className="text-2xl font-bold mb-3">Group submitted!</h1><MagneticLink href={`/${go.concept.slug}/order/${go.orderId}`} className="servd-btn-primary">Track order →</MagneticLink></div>

  return (
    <div className="container section">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <div>
          <p className="text-xs uppercase tracking-widest text-[color:var(--servd-green-dark)] font-bold">{go.concept.name}</p>
          <h1 className="text-2xl font-extrabold">Group order</h1>
        </div>
        <div className="text-right">
          <p className="text-xs text-[color:var(--servd-mute)]">Share code</p>
          <p className="font-mono font-extrabold text-2xl tracking-widest">{go.shareCode}</p>
          <button
            onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/group-order?code=${go.shareCode}`)}
            className="text-xs underline"
          >Copy invite link</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6 mt-4">
        {/* Menu */}
        <div className="space-y-4">
          {menu.map((cat) => (
            <section key={cat.id}>
              <h2 className="text-lg font-bold mb-2">{cat.name}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {cat.items.filter((i) => i.isAvailable).map((it) => (
                  <button key={it.id} onClick={() => addItem(it)} disabled={go.status !== 'open'}
                    className="text-left servd-card disabled:opacity-50" style={{ padding: '0.75rem 1rem' }}>
                    <p className="font-semibold">{it.name}</p>
                    <p className="text-sm text-[color:var(--servd-green-dark)] font-bold">{fmt(it.priceCents)}</p>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Cart */}
        <aside className="servd-card sticky top-20 self-start" style={{ padding: '1rem 1.25rem' }}>
          <h2 className="font-bold mb-2">Group cart · {go.items.length} item{go.items.length === 1 ? '' : 's'}</h2>
          <ul className="space-y-1.5 mb-3 max-h-[40dvh] overflow-y-auto">
            {go.members.map((m) => {
              const items = go.items.filter((i) => i.memberId === m.id)
              return (
                <li key={m.id}>
                  <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--servd-mute)] mt-2">
                    {m.displayName} {m.id === meId && '(you)'}
                  </p>
                  {items.length === 0 && <p className="text-xs text-[color:var(--servd-dim)]">— nothing yet —</p>}
                  {items.map((i) => (
                    <div key={i.id} className="flex justify-between text-sm">
                      <span>{i.quantity}× {i.name}</span>
                      <span className="flex items-center gap-2">
                        <span>{fmt(i.unitPriceCents * i.quantity)}</span>
                        {i.memberId === meId && go.status === 'open' && (
                          <button onClick={() => removeItem(i.id)} aria-label="Remove" className="text-[color:var(--servd-mute)]">×</button>
                        )}
                      </span>
                    </div>
                  ))}
                </li>
              )
            })}
          </ul>
          <div className="border-t border-[color:var(--servd-line)] pt-2 mb-3 text-sm space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
            <div className="flex justify-between text-[color:var(--servd-mute)]"><span>Tax</span><span>{fmt(tax)}</span></div>
            <div className="flex justify-between font-bold"><span>Total</span><span>{fmt(total)}</span></div>
          </div>
          <button onClick={submit} disabled={busy || go.items.length === 0 || go.status !== 'open'} className="servd-btn-primary w-full">
            {busy ? 'Submitting…' : 'Lock & submit group order'}
          </button>
        </aside>
      </div>
    </div>
  )
}
