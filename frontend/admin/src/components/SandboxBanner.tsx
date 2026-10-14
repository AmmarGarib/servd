'use client'
// The practice copy's warning stripe.
//
// The practice copy is a second, separate servd (its own admin + API web
// addresses, its own database cloned from the real one, nothing sent to the
// outside world). It looks exactly like the live ERP, so every page says so
// at the top: a full-width stripe in the warning colour, and "[PRACTICE] " in
// front of the tab title.
//
// It is on when EITHER
//   - the admin image was built with NEXT_PUBLIC_SANDBOX=1 (baked at build,
//     so it shows on the very first paint, before any request), OR
//   - GET /api/v1/meta/sandbox answers { sandbox: true } — the API's own
//     SERVD_SANDBOX switch, a backstop for an image built without the flag.
// The live admin (flag unset, API answers false or has no such route)
// renders nothing and changes nothing.
//
// The stripe is fixed to the top and the page is pushed down by its measured
// height (body padding + the viewport-height utilities shortened to match),
// so it never sits over the sidebar's controls or a page header.

import { useEffect, useRef, useState } from 'react'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const BAKED_IN = process.env['NEXT_PUBLIC_SANDBOX'] === '1'

const TITLE_PREFIX = '[PRACTICE] '

// One question per page load, shared by every caller. Only a real answer is
// kept; a failure (API down, route missing) is not cached as "live".
let apiAnswer: Promise<boolean> | null = null
function askApi(): Promise<boolean> {
  if (!apiAnswer) {
    apiAnswer = fetch(`${API_URL}/api/v1/meta/sandbox`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`meta/sandbox ${res.status}`)
        const d = (await res.json()) as { sandbox?: unknown } | null
        return d?.sandbox === true
      })
      .catch(() => {
        apiAnswer = null
        return false
      })
  }
  return apiAnswer
}

/** True on the practice copy (baked-in flag, or the API says so). */
export function useIsPracticeCopy(): boolean {
  const [fromApi, setFromApi] = useState(false)
  useEffect(() => {
    if (BAKED_IN) return
    let alive = true
    void askApi().then((yes) => { if (alive && yes) setFromApi(true) })
    return () => { alive = false }
  }, [])
  return BAKED_IN || fromApi
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
      </div>
    </>
  )
}

/**
 * "Practice copy — your code is 123456": the practice API sends nothing to
 * WhatsApp or email, so where the live API would send a code it returns it as
 * `practiceCode` instead, and the sign-in screens show it here. The live API
 * never returns the field, so on live this is never rendered.
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
