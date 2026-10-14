'use client'
// The practice copy's warning stripe.
//
// The practice copy is a second, separate servd (its own admin + API web
// addresses, its own database cloned from the real one, nothing sent to the
// outside world). It looks exactly like the live ERP, so every page says so
// at the top: a full-width stripe in the warning colour, and "[PRACTICE] " in
// front of the tab title.
//
// It is on ONLY when the admin image was built with NEXT_PUBLIC_SANDBOX=1
// (deploy/sandbox/build-admin.sh refuses to build a practice image without
// it). Next.js inlines the flag at build time, so on the live admin this is
// the constant `false`: nothing renders and no request is made.
//
// On the practice copy the stripe also checks, once per page load and again
// when the tab regains focus while there is a problem, that the practice API
// answers and says it is in practice mode (GET /api/v1/meta/sandbox, with the
// browser's Cloudflare Access sign-in). Two things it can say:
//   - "not signed in to the practice API": Access lets the admin through but
//     not (yet) the API address — open the API address once to sign in;
//   - "the API is NOT in practice mode": stop, tell IT.
//
// The stripe is fixed to the top and the page is pushed down by its measured
// height (body padding + the viewport-height utilities shortened to match),
// so it never sits over the sidebar's controls or a page header.

import { useEffect, useRef, useState } from 'react'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const BAKED_IN = process.env['NEXT_PUBLIC_SANDBOX'] === '1'
const API_CHECK_URL = `${API_URL}/api/v1/meta/sandbox`

const TITLE_PREFIX = '[PRACTICE] '

/** True on the practice copy (the admin image was built with NEXT_PUBLIC_SANDBOX=1). */
export function useIsPracticeCopy(): boolean {
  return BAKED_IN
}

type ApiState = 'checking' | 'ok' | 'signin' | 'not_practice'

/** Practice copy only: does the practice API answer, and is it in practice mode? */
async function checkPracticeApi(): Promise<ApiState> {
  try {
    const res = await fetch(API_CHECK_URL, { cache: 'no-store', credentials: 'include' })
    // 404: the API answered but has no /meta/sandbox — an image without
    // practice mode is running behind the practice address. That is the STOP
    // case, never "sign in".
    if (res.status === 404) return 'not_practice'
    if (!res.ok) return 'signin'
    const d = (await res.json().catch(() => null)) as { sandbox?: unknown } | null
    if (d?.sandbox === true) return 'ok'
    return d?.sandbox === false ? 'not_practice' : 'signin'
  } catch {
    // Cloudflare Access answered with its sign-in redirect (no CORS) or the
    // API is unreachable: either way, opening the API address shows which.
    return 'signin'
  }
}

// Static CSS (no input from anywhere). The height variable is set from the
// stripe's measured size below; the media-query values only cover the first
// paint before it is measured.
const LAYOUT_CSS = `
:root { --servd-practice-h: 32px; }
@media (max-width: 640px) { :root { --servd-practice-h: 52px; } }
body { padding-top: var(--servd-practice-h); }
html .h-screen { height: calc(100vh - var(--servd-practice-h)); }
html .min-h-screen { min-height: calc(100vh - var(--servd-practice-h)); }
html .max-h-screen { max-height: calc(100vh - var(--servd-practice-h)); }
html .fixed.top-0:not([data-servd-practice]) { top: var(--servd-practice-h); }
`

export function SandboxBanner() {
  const on = useIsPracticeCopy()
  const bar = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [api, setApi] = useState<ApiState>('checking')

  // Practice copy only (never runs on live): check the practice API on load,
  // and again on focus while it is not answering as a practice API.
  useEffect(() => {
    if (!on) return
    let alive = true
    let state: ApiState = 'checking'
    const run = () => { void checkPracticeApi().then((s) => { if (alive) { state = s; setApi(s) } }) }
    const onFocus = () => { if (state !== 'ok') run() }
    run()
    window.addEventListener('focus', onFocus)
    return () => { alive = false; window.removeEventListener('focus', onFocus) }
  }, [on])

  // Push the page down by exactly the stripe's height (it wraps to two or
  // three lines on a phone).
  useEffect(() => {
    if (!on || !bar.current) return
    const el = bar.current
    const measure = () => setHeight(Math.ceil(el.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [on])

  // "[PRACTICE] " in front of every tab title, including the ones pages set
  // after navigation.
  useEffect(() => {
    if (!on) return
    const prefix = () => {
      if (!document.title.startsWith(TITLE_PREFIX)) document.title = TITLE_PREFIX + document.title
    }
    prefix()
    const mo = new MutationObserver(prefix)
    mo.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => {
      mo.disconnect()
      if (document.title.startsWith(TITLE_PREFIX)) document.title = document.title.slice(TITLE_PREFIX.length)
    }
  }, [on])

  if (!on) return null

  const css = LAYOUT_CSS + (height ? `:root { --servd-practice-h: ${height}px; }` : '')

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div
        ref={bar}
        role="note"
        aria-label="Practice copy"
        data-servd-practice=""
        className="fixed top-0 inset-x-0 px-4 py-1.5 text-center text-[12px] leading-snug font-medium"
        style={{
          zIndex: 45,
          background: 'var(--erp-warning)',
          color: 'rgb(var(--surface-rgb))',
          boxShadow: '0 1px 0 color-mix(in srgb, var(--erp-warning) 60%, var(--text))',
          overflowWrap: 'anywhere',
        }}
      >
        <strong className="font-black tracking-[0.12em]">PRACTICE COPY</strong>
        {' '}&mdash; a copy of servd for practice. Nothing here reaches the live ERP, customers, banks or FBR.
        {api === 'signin' && (
          <span className="block font-bold">
            Not signed in to the practice API yet:{' '}
            <a href={API_CHECK_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              open it once to sign in
            </a>
            , then come back to this tab.
          </span>
        )}
        {api === 'not_practice' && (
          <span className="block font-black">
            STOP: this page is talking to a server that is NOT in practice mode. Do not use it; tell IT.
          </span>
        )}
      </div>
    </>
  )
}

/**
 * "Practice copy — your code is 123456": the practice API sends nothing to
 * WhatsApp or email, so after a correct password it returns the 2FA code it
 * would have sent as `practiceCode`, and the sign-in screen shows it here. The
 * live API never returns the field, so on live this is never rendered.
 */
export function PracticeCode({ code, children }: { code: string; children?: React.ReactNode }) {
  return (
    <div
      role="status"
      className="mb-3 rounded-xl px-3 py-2.5 text-xs text-center leading-relaxed"
      style={{
        background: 'color-mix(in srgb, var(--erp-warning) 10%, var(--surface))',
        border: '1px solid color-mix(in srgb, var(--erp-warning) 40%, transparent)',
        color: 'color-mix(in srgb, var(--erp-warning) 80%, var(--text))',
        overflowWrap: 'anywhere',
      }}
    >
      <p>
        Practice copy &mdash; your code is{' '}
        <span className="font-mono font-black text-sm select-all">{code}</span>
      </p>
      <p className="mt-0.5 text-[10px] opacity-80">Nothing was sent to WhatsApp or email.</p>
      {children}
    </div>
  )
}
