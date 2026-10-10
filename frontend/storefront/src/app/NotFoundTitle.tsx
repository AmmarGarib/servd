'use client'

import { useEffect } from 'react'

/**
 * Next 14 answers a notFound() from a page or layout with a 404 and an empty
 * HTML shell (no <title>, no body); the browser then draws app/not-found.tsx.
 * The status and the noindex are right, but the tab would read as the bare
 * URL — so name it once the page is drawn, if nothing else has.
 */
export function NotFoundTitle() {
  useEffect(() => {
    if (!document.title) document.title = 'Not found · servd'
  }, [])
  return null
}
