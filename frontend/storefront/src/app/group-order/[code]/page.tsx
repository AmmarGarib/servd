'use client'

// Live shared cart. Members all see the same list, can add their own items,
// host can lock + submit. Polls every 3s — could be SSE later.
//
// Opening hours and time-limited sections (lunch, breakfast) apply to a group
// exactly as at checkout (ONLINE-R6): the server answers 409 BRAND_CLOSED
// ("<Brand> is closed right now. Opens at …") and 400 ITEM_UNAVAILABLE
// ("<item> is only served 12:00–16:00") on add and submit.
//
// Lock and submit are ONE server step (POST /:code/submit closes the cart
// itself). There is no separate client lock any more: a submit the server
// refuses leaves the group open, so the member who added the line can remove
// it and send again — the old lock-then-submit stranded a locked cart.
//
// The totals are the server's quote (GET /:code → quote, the same priceOrder
// call submit makes: cash GST rate, item tax classes, service charge), never
// computed here.

import { useEffect, useState, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { MagneticLink } from '@/components/ui/MagneticButton'
import { useCustomerAuth } from '../../../store/customerAuth'
import { BlockedNotice } from '../../../components/account/BlockedNotice'
import { formatBrandName } from '../../../lib/concept'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Member { id: string; displayName: string }
interface GroupItem { id: string; memberId: string; menuItemId: string; name: string; quantity: number; unitPriceCents: number; notes: string | null }
interface GroupOrder {
  id: string; status: 'open' | 'locked' | 'submitted' | 'cancelled'
  shareCode: string; initiatorName: string; closingAt: string | null; orderId: string | null
  concept: { id: string; name: string; slug: string }
  members: Member[]
  items: GroupItem[]
  /** Server pricing of the cart as submit will charge it; null when empty. */
  quote: { itemTotalCents: number; taxCents: number; serviceChargeCents: number; totalCents: number } | null
}
interface MenuItem { id: string; name: string; priceCents: number; isAvailable: boolean }
interface Category { id: string; name: string; items: MenuItem[] }
interface Ordering { open: boolean; opensAt: string | null; message: string | null }
interface MenuResponse { categories: Category[]; ordering?: Ordering }
interface ApiError { error?: { code?: string; message?: string } }

/** The server's own words for the cases a customer can act on. */
async function errorMessage(res: Response, fallback: string, onCode?: (code: string | undefined) => void): Promise<string> {
  const body = await res.json().catch(() => null) as ApiError | null
  const code = body?.error?.code
  const message = body?.error?.message
  onCode?.(code)
  if (message && (code === 'BRAND_CLOSED' || code === 'ITEM_UNAVAILABLE' || code === 'GROUP_LOCKED'
    || code === 'GROUP_CANCELLED' || code === 'NO_ITEMS' || code === 'ITEM_NOT_PRICED')) return message
  return fallback
}

async function loadMenu(slug: string): Promise<MenuResponse | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/${slug}/menu`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = await res.json() as MenuResponse | Category[]
    // The endpoint returns { concept, categories, ordering, … }.
    return Array.isArray(body) ? { categories: body } : { categories: body.categories ?? [], ordering: body.ordering }
  } catch {
    return null
  }
}

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
  // A problem with an action (add / submit) — shown above the cart, not in
  // place of the page.
  const [notice, setNotice] = useState<string | null>(null)
  const [ordering, setOrdering] = useState<Ordering | null>(null)
  const [busy, setBusy] = useState(false)
  // The server said BANNED: show the account-wide block + appeal form (nothing while appeals are off).
  const [banned, setBanned] = useState(false)
  const noteBan = (code: string | undefined) => { if (code === 'BANNED') setBanned(true) }

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
          const loaded = await loadMenu(data.concept.slug)
          if (loaded && !cancelled) { setMenu(loaded.categories); setOrdering(loaded.ordering ?? null) }
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

  // The server's figures only. Between an add and the next poll the quote can
  // trail the list by up to 3 s; it is never recomputed here.
  const quote = go?.quote ?? null

  const addItem = async (item: MenuItem) => {
    if (!meId || !go) return
    setNotice(null)
    // memberId is derived server-side from the authenticated customer — no
    // longer accepted in the request body.
    const res = await fetch(`${API_URL}/api/v1/group-orders/${code}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ menuItemId: item.id, quantity: 1 }),
    })
    if (!res.ok) setNotice(await errorMessage(res, `Couldn't add ${item.name}. Please try again.`, noteBan))
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
    setNotice(null)
    try {
      // One call: the server closes the cart, checks hours / sections /
      // prices, and fires the order — or refuses and leaves the group open.
      const res = await fetch(`${API_URL}/api/v1/group-orders/${code}/submit`, { method: 'POST', headers: authHeaders })
      if (!res.ok) {
        const body = await res.clone().json().catch(() => null) as ApiError | null
        const fixable = body?.error?.code === 'ITEM_UNAVAILABLE' || body?.error?.code === 'ITEM_NOT_PRICED'
        const message = await errorMessage(res, "Couldn't send the group order. Please try again.", noteBan)
        setNotice(fixable ? `${message} Whoever added it can remove it, then send the group again.` : message)
        // Refresh the menu and the open/closed line to match what the server said.
        const fresh = await loadMenu(go.concept.slug)
        if (fresh) { setMenu(fresh.categories); setOrdering(fresh.ordering ?? null) }
        return
      }
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
          <p className="text-xs uppercase tracking-widest text-[color:var(--servd-green-dark)] font-bold">{formatBrandName(go.concept.name)}</p>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
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
          {ordering && !ordering.open && !notice && (
            <p className="text-sm mb-3 text-[color:var(--servd-mute)]">{ordering.message ?? `${formatBrandName(go.concept.name)} is closed right now.`}</p>
          )}
          {notice && (
            <p role="alert" className="text-sm font-semibold mb-3 text-[color:var(--servd-ink)] border-l-2 border-[color:var(--servd-green)] pl-2">{notice}</p>
          )}
          {banned && <BlockedNotice conceptSlug={go.concept.slug} className="mb-3" />}
          <div className="border-t border-[color:var(--servd-line)] pt-2 mb-3 text-sm space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{fmt(quote?.itemTotalCents ?? 0)}</span></div>
            <div className="flex justify-between text-[color:var(--servd-mute)]"><span>Tax</span><span>{fmt(quote?.taxCents ?? 0)}</span></div>
            {(quote?.serviceChargeCents ?? 0) > 0 && (
              <div className="flex justify-between text-[color:var(--servd-mute)]"><span>Service charge</span><span>{fmt(quote!.serviceChargeCents)}</span></div>
            )}
            <div className="flex justify-between font-bold"><span>Total</span><span>{fmt(quote?.totalCents ?? 0)}</span></div>
            <p className="text-xs text-[color:var(--servd-mute)] pt-1">Tax at the cash rate. Paying by card is re-priced at the till.</p>
          </div>
          {/* Submit accepts an open group, and a locked one (submit closes the
              cart itself); a refused submit reopens it. */}
          <button onClick={submit} disabled={busy || go.items.length === 0 || (go.status !== 'open' && go.status !== 'locked')} className="servd-btn-primary w-full">
            {busy ? 'Sending…' : 'Send group order'}
          </button>
        </aside>
      </div>
    </div>
  )
}
