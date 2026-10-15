'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  CONSENT_EVENT, CONSENT_OPEN_EVENT, analyticsPathSkipped, gaConfigured, initAnalytics,
  sendPageView, setConsent, track, type ConsentChoice,
} from '../../lib/analytics'
import { useOnBrandMicrosite } from '../../lib/host'

// Google Analytics 4 + the consent notice (SEO round 1, WP5).
//
// - No NEXT_PUBLIC_GA4_ID  → renders nothing, loads nothing, sets no cookie.
// - Consent Mode defaults to denied; gtag.js is only downloaded after the
//   visitor presses "Accept". "Only necessary" keeps GA off for good (the
//   choice is remembered in localStorage under `sv_consent`).
// - Never runs on /editor-frame, /rider or /preview (analyticsPathSkipped).
// - page_view is sent on every route change.
// - whatsapp_click: ONE delegated listener for every wa.me / WhatsApp link on
//   the site (sections, footers, brand pages), so no link file needs editing.
// - The notice is styled per host: servd tokens on servd pages, neutral
//   (no servd colours) on brand microsites. A page can re-open it by
//   dispatching CONSENT_OPEN_EVENT on window.

const WA_HOST = /^(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)$/i

function whatsappAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a) return null
  try {
    const u = new URL(a.href, window.location.href)
    return WA_HOST.test(u.hostname) || u.protocol === 'whatsapp:' ? a : null
  } catch { return null }
}

export function Analytics({ initialBrandSlug = null }: { initialBrandSlug?: string | null }) {
  const pathname = usePathname() ?? '/'
  const onBrandHost = useOnBrandMicrosite(initialBrandSlug)
  const brandLook = onBrandHost || pathname.startsWith('/brand/')
  const skipped = analyticsPathSkipped(pathname)
  const enabled = gaConfigured() && !skipped

  const [choice, setChoice] = useState<ConsentChoice | null>(null)
  const [ready, setReady] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)

  // Defaults denied; reload GA on a returning visitor who accepted before.
  useEffect(() => {
    if (!gaConfigured()) return
    setChoice(initAnalytics())
    setReady(true)
    const onChoice = (e: Event) => { setChoice((e as CustomEvent<ConsentChoice>).detail); setForceOpen(false) }
    const onOpen = () => setForceOpen(true)
    window.addEventListener(CONSENT_EVENT, onChoice)
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener(CONSENT_EVENT, onChoice)
      window.removeEventListener(CONSENT_OPEN_EVENT, onOpen)
    }
  }, [])

  // page_view on every route change (and once when consent is first given).
  useEffect(() => {
    if (enabled && choice === 'granted') sendPageView()
  }, [pathname, enabled, choice])

  // WhatsApp clicks anywhere on the site.
  useEffect(() => {
    if (!enabled) return
    const onClick = (e: MouseEvent) => {
      const a = whatsappAnchor(e.target)
      if (!a) return
      track('whatsapp_click', { link_text: (a.textContent ?? '').trim().slice(0, 40), page_path: window.location.pathname })
    }
    document.addEventListener('click', onClick, { capture: true })
    return () => document.removeEventListener('click', onClick, { capture: true })
  }, [enabled])

  if (!enabled || !ready) return null
  if (choice !== null && !forceOpen) return null

  return (
    <div
      role="dialog"
      aria-label="Cookies and analytics"
      className={`sv-consent ${brandLook ? 'sv-consent--neutral' : 'sv-consent--servd'}`}
    >
      <p className="sv-consent__text">
        We use Google Analytics to see which pages and dishes people use, so we can improve the
        site. It sets cookies only if you accept. Ordering works either way.{' '}
        <a href="https://servd.pk/privacy" className="sv-consent__link">Privacy</a>
      </p>
      <div className="sv-consent__actions">
        <button type="button" className="sv-consent__btn sv-consent__btn--quiet" onClick={() => setConsent('denied')}>
          Only necessary
        </button>
        <button type="button" className="sv-consent__btn sv-consent__btn--primary" onClick={() => setConsent('granted')}>
          Accept
        </button>
      </div>
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
.sv-consent{position:fixed;z-index:45;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));
  display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:space-between;
  max-width:640px;margin-inline:auto;padding:14px 16px;border-radius:14px;font-size:14px;line-height:1.45;
  box-shadow:0 8px 28px rgba(0,0,0,.18);border:1px solid var(--sv-c-line)}
@media(min-width:768px){.sv-consent{left:24px;right:auto;bottom:24px;margin-inline:0}}
.sv-consent__text{margin:0;flex:1 1 260px}
.sv-consent__link{text-decoration:underline;text-underline-offset:2px;color:inherit;font-weight:600}
.sv-consent__actions{display:flex;gap:8px;flex:0 0 auto}
.sv-consent__btn{min-height:44px;padding:0 16px;border-radius:999px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent}
.sv-consent__btn:focus-visible,.sv-consent__link:focus-visible{outline:2px solid var(--sv-c-focus);outline-offset:2px}
.sv-consent--servd{--sv-c-line:var(--servd-line);--sv-c-focus:var(--servd-green-dark);
  background:var(--servd-bg);color:var(--servd-ink);font-family:var(--font-inter),system-ui,sans-serif}
.sv-consent--servd .sv-consent__btn--primary{background:var(--servd-green);color:var(--servd-on-green)}
.sv-consent--servd .sv-consent__btn--primary:hover{background:var(--servd-green-hover)}
.sv-consent--servd .sv-consent__btn--quiet{background:transparent;color:var(--servd-ink);border-color:var(--servd-line)}
/* Brand pages: neutral greys only, so no brand ever shows servd colours (and
   Simmer's no-white / single-accent rules are untouched). */
.sv-consent--neutral{--sv-c-line:rgba(0,0,0,.2);--sv-c-focus:#444;background:#f2f1ee;color:#1d1d1d;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.sv-consent--neutral .sv-consent__btn--primary{background:#1d1d1d;color:#f2f1ee}
.sv-consent--neutral .sv-consent__btn--quiet{background:transparent;color:#1d1d1d;border-color:rgba(0,0,0,.35)}
`
