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

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { MagneticLink } from '@/components/ui/MagneticButton'
import { useCustomerAuth } from '../../../store/customerAuth'
import { BlockedNotice } from '../../../components/account/BlockedNotice'
import { formatBrandName } from '../../../lib/concept'
import { smoothScrollTo } from '../../../lib/scroll'

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
  // Copy / share the invite.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [canShare, setCanShare] = useState(false)
  useEffect(() => { setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function') }, [])
  // A line the member just removed, kept ~5 s so Undo can add it back.
  const [removed, setRemoved] = useState<{ menuItemId: string; name: string; quantity: number; notes: string | null } | null>(null)
  const removedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (removedTimer.current) clearTimeout(removedTimer.current) }, [])
  // Poll plumbing: last payload (to skip no-change renders), the menu-loaded
  // flag (so the menu loading does not restart the poll) and a "fetch now" hook.
  const lastJson = useRef('')
  const menuLoaded = useRef(false)
  const refreshRef = useRef<() => void>(() => {})
  // Phone bar: shown only while the cart itself is off screen.
  const cartRef = useRef<HTMLElement | null>(null)
  const [cartInView, setCartInView] = useState(false)

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

  // Load + poll. Visibility-aware (nothing is fetched while the tab is hidden;
  // coming back refetches at once), never overlapping, and it only touches
  // state when the payload really changed, so the menu does not re-render
  // every 3 s.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    let inflight = false
    async function fetchAll() {
      if (inflight || cancelled) return
      inflight = true
      try {
        const res = await fetch(`${API_URL}/api/v1/group-orders/${code}`, { headers: authHeaders })
        if (!res.ok) throw new Error('Group not found')
        const raw = await res.text()
        const data = JSON.parse(raw) as GroupOrder
        if (cancelled) return
        if (raw !== lastJson.current) {
          lastJson.current = raw
          setGo(data)
        }

        if (!menuLoaded.current) {
          menuLoaded.current = true
          const loaded = await loadMenu(data.concept.slug)
          if (loaded && !cancelled) { setMenu(loaded.categories); setOrdering(loaded.ordering ?? null) }
          else menuLoaded.current = false
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
      } finally {
        inflight = false
      }
    }
    refreshRef.current = () => void fetchAll()
    void fetchAll()
    const iv = setInterval(() => { if (!document.hidden) void fetchAll() }, 3000)
    const onVisible = () => { if (!document.hidden) void fetchAll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVisible)
      refreshRef.current = () => {}
    }
  }, [code, myName, token, authHeaders])

  // Hide the phone bar while the cart is on screen.
  const loaded = go !== null
  useEffect(() => {
    const el = cartRef.current
    if (!loaded || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setCartInView(e?.isIntersecting ?? false), { threshold: 0.15 })
    io.observe(el)
    return () => io.disconnect()
  }, [loaded])

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
    refreshRef.current()
  }
  const removeItem = async (line: GroupItem) => {
    const res = await fetch(`${API_URL}/api/v1/group-orders/${code}/items/${line.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    if (res.ok) {
      setRemoved({ menuItemId: line.menuItemId, name: line.name, quantity: line.quantity, notes: line.notes })
      if (removedTimer.current) clearTimeout(removedTimer.current)
      removedTimer.current = setTimeout(() => setRemoved(null), 5000)
    }
    refreshRef.current()
  }
  const undoRemove = async () => {
    const r = removed
    if (!r) return
    setRemoved(null)
    if (removedTimer.current) clearTimeout(removedTimer.current)
    const res = await fetch(`${API_URL}/api/v1/group-orders/${code}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ menuItemId: r.menuItemId, quantity: r.quantity, ...(r.notes && { notes: r.notes }) }),
    })
    if (!res.ok) setNotice(await errorMessage(res, `Couldn't put ${r.name} back. Please add it again.`, noteBan))
    refreshRef.current()
  }

  const inviteUrl = () => `${window.location.origin}/group-order?code=${go?.shareCode ?? code}`
  const copyInvite = async () => {
    const url = inviteUrl()
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      // No clipboard API (or refused): the old execCommand route, else show
      // the link to copy by hand.
      let ok = false
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { ok = false }
      setCopyState(ok ? 'copied' : 'manual')
    }
  }
  const shareInvite = async () => {
    try {
      await navigator.share({ title: 'Join my group order', text: `Join my group order at ${go ? formatBrandName(go.concept.name) : 'servd'}`, url: inviteUrl() })
    } catch (e) {
      // Closing the share sheet is not an error; anything else falls back to copy.
      if ((e as { name?: string })?.name !== 'AbortError') void copyInvite()
    }
  }
  useEffect(() => {
    if (copyState !== 'copied') return
    const t = setTimeout(() => setCopyState('idle'), 2500)
    return () => clearTimeout(t)
  }, [copyState])
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
  if (!go) return (
    <div className="container section" role="status" aria-label="Loading group">
      <div className="animate-pulse space-y-4">
        <div className="h-4 w-24 rounded" style={{ background: 'var(--servd-surface)' }} />
        <div className="h-8 w-56 rounded" style={{ background: 'var(--servd-surface)' }} />
        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6 mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 rounded-2xl" style={{ background: 'var(--servd-surface)' }} />)}
          </div>
          <div className="h-56 rounded-2xl" style={{ background: 'var(--servd-surface)' }} />
        </div>
      </div>
      <span className="sr-only">Loading group…</span>
    </div>
  )
  if (go.status === 'submitted' && go.orderId) return <div className="container-narrow section text-center"><h1 className="text-2xl font-bold mb-3">Group submitted!</h1><MagneticLink href={`/${go.concept.slug}/order/${go.orderId}`} className="servd-btn-rect servd-btn-primary">Track order →</MagneticLink></div>

  return (
    <div className="container section pb-28 md:pb-12">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <div>
          <p className="text-xs uppercase tracking-widest text-[color:var(--servd-green-dark)] font-bold">{formatBrandName(go.concept.name)}</p>
          <h1 className="text-2xl font-extrabold">Group order</h1>
        </div>
        <div className="text-right">
          <p className="text-xs text-[color:var(--servd-mute)]">Share code</p>
          <p className="font-mono font-extrabold text-2xl tracking-widest">{go.shareCode}</p>
          <div className="flex items-center justify-end gap-1 flex-wrap">
            {canShare && (
              <button type="button" onClick={() => { void shareInvite() }}
                className="text-xs underline min-h-11 px-2">Share invite</button>
            )}
            <button type="button" onClick={() => { void copyInvite() }}
              className="text-xs underline min-h-11 px-2">
              {copyState === 'copied' ? 'Copied' : 'Copy invite link'}
            </button>
          </div>
          <span role="status" className="sr-only">{copyState === 'copied' ? 'Invite link copied' : ''}</span>
          {copyState === 'manual' && (
            <input readOnly value={inviteUrl()} aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className="servd-input servd-field text-xs mt-1 w-full" />
          )}
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
        <aside id="group-cart" ref={cartRef} tabIndex={-1} className="servd-card sticky top-20 self-start" style={{ padding: '1rem 1.25rem', outline: 'none', scrollMarginTop: '5rem' }}>
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
                          <button type="button" onClick={() => { void removeItem(i) }} aria-label={`Remove ${i.name}`}
                            className="inline-flex items-center justify-center text-[color:var(--servd-mute)] text-lg"
                            style={{ minWidth: 44, minHeight: 44, margin: '-0.6rem -0.5rem -0.6rem 0' }}>×</button>
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
          {removed && (
            <div role="status" className="flex items-center justify-between gap-2 text-sm rounded-lg mb-3 pl-3"
              style={{ background: 'var(--servd-ink)', color: 'var(--servd-bg)' }}>
              <span className="truncate">Removed · {removed.name}</span>
              <button type="button" onClick={() => { void undoRemove() }}
                className="font-bold underline px-3" style={{ minHeight: 44 }}>Undo</button>
            </div>
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
          <button type="button" onClick={submit} disabled={busy || go.items.length === 0 || (go.status !== 'open' && go.status !== 'locked')} className="servd-btn-rect servd-btn-primary w-full">
            {busy ? 'Sending…' : 'Send group order'}
          </button>
        </aside>
      </div>

      {/* Phones: the cart is under the whole menu, so keep its total one tap
          away. Hidden while the cart itself is on screen. */}
      {!cartInView && (
        <div className="md:hidden fixed left-0 right-0 bottom-0 z-40 px-4 pt-3"
          style={{ background: 'var(--servd-bg)', borderTop: '1px solid var(--servd-line)', paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={() => { const el = document.getElementById('group-cart'); smoothScrollTo(el); el?.focus({ preventScroll: true }) }}
            className="servd-btn-rect servd-btn-primary w-full flex items-center justify-between"
            aria-label={`Group cart, ${go.items.length} item${go.items.length === 1 ? '' : 's'}, ${fmt(quote?.totalCents ?? 0)}. View cart`}>
            <span>Group cart · {go.items.length} item{go.items.length === 1 ? '' : 's'}</span>
            <span>{fmt(quote?.totalCents ?? 0)} · View</span>
          </button>
        </div>
      )}
    </div>
  )
}
