'use client'

// The "tasted" passport: a per-browser set of menu item ids the customer has
// tossed into a basket before. Purely cosmetic: it only decides whether a
// card wears a small "tasted" corner sticker. Nothing reads it for pricing,
// ordering or analytics, and it never leaves the browser.
//
// Every storage access is wrapped: private windows, blocked site data and
// thumbnail captures can all throw, and the page must render the same without
// it.

import { useEffect, useState } from 'react'

const KEY = 'servd-tasted'
const EVENT = 'servd:tasted'
/** Oldest ids fall off past this, so the set can't grow without bound. */
const MAX_IDS = 400

function read(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function readTasted(): Set<string> {
  return new Set(read())
}

/** Record an item as tasted. Returns true when it is new to the passport. */
export function markTasted(menuItemId: string): boolean {
  if (typeof window === 'undefined' || !menuItemId) return false
  const ids = read()
  if (ids.includes(menuItemId)) return false
  ids.push(menuItemId)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX_IDS)))
  } catch {
    /* storage unavailable: the sticker simply won't persist */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: menuItemId }))
  } catch {
    /* ignore */
  }
  return true
}

/**
 * The tasted set, read after mount (empty on the server and the first client
 * render, so hydration never mismatches). Updates live when an item is tossed
 * here or in another tab.
 */
export function useTasted(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  useEffect(() => {
    const sync = () => setIds(readTasted())
    sync()
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) sync()
    }
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return ids
}
