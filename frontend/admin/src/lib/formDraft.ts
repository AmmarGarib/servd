'use client'
// Unsaved drafts for manual-entry forms (owner, 2026-11-14: "If someone goes back or refreshes the page, it should
// not lose incomplete data").
//
// useFormDraft keeps a form's typed values in THIS browser (localStorage) while the person types, and puts them back
// when the page is opened again — after a refresh, Back, a crash or a sign-in. Nothing is sent to the server.
//
//   - Keyed per login + company in view + the form's own key, so one person's draft never shows to another login on
//     a shared device, and one company's never in another's.
//   - Saved ~0.4 s after the last change and again when the page is hidden / closed.
//   - Nothing is kept while the form still holds what it opened with (an untouched form leaves no draft).
//   - clear() after a successful save; discard() puts the form back to what it opened with.
//   - A draft older than DRAFT_MAX_AGE_DAYS is dropped.
//   - A blocked or full storage (private window) never breaks the form: the draft is simply not kept.
//
// Use it with <DraftNotice draft={…} /> so the person sees that a draft was put back and can throw it away.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { readLensTenant } from './api'

const PREFIX = 'servd:draft:v1:'
export const DRAFT_MAX_AGE_DAYS = 7
const SAVE_DELAY_MS = 400

interface Stored<T> { v: T; at: number }

export interface FormDraft {
  /** When the draft that was put back had been saved (ms), or null when the form opened clean. */
  restoredAt: number | null
  /** When the current values were last kept (ms), or null. */
  savedAt: number | null
  /** Throw the draft away and put the form back to what it opened with. */
  discard: () => void
  /** Forget the draft (after a successful save). The form keeps its values. */
  clear: () => void
}

function storageKey(userId: string, key: string): string {
  return `${PREFIX}${userId}:${readLensTenant() ?? 'all'}:${key}`
}

function readStored<T>(k: string): Stored<T> | null {
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return null
    const s = JSON.parse(raw) as Stored<T>
    if (!s || typeof s.at !== 'number' || Date.now() - s.at > DRAFT_MAX_AGE_DAYS * 86_400_000) {
      localStorage.removeItem(k)
      return null
    }
    return s
  } catch { return null }
}

function write(k: string, value: unknown): number | null {
  try {
    const at = Date.now()
    localStorage.setItem(k, JSON.stringify({ v: value, at }))
    return at
  } catch { return null }
}

function remove(k: string) {
  try { localStorage.removeItem(k) } catch { /* storage blocked */ }
}

/**
 * Keep a form's values as a draft.
 *
 * @param key    the form's own key, e.g. `recipe:new` or `recipe:<id>`; null = don't keep a draft yet (e.g. while the
 *               record being edited is still loading — pass the key once the form holds the record's values).
 * @param value  everything the person typed, as one JSON-safe object (no File / Date objects).
 * @param apply  puts a saved value back into the form's state.
 * @param opts.isEmpty  true when the form holds nothing worth keeping (e.g. only blank lines with fresh row keys) —
 *               such a value is never kept, whatever the form opened with.
 */
export function useFormDraft<T>(
  key: string | null, value: T, apply: (v: T) => void, opts: { isEmpty?: (v: T) => boolean } = {},
): FormDraft {
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const full = key && userId ? storageKey(userId, key) : null

  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [readyKey, setReadyKey] = useState<string | null>(null)

  const json = JSON.stringify(value ?? null)
  const latest = useRef({ value, json })
  latest.current = { value, json }
  const applyRef = useRef(apply)
  applyRef.current = apply
  const isEmptyRef = useRef(opts.isEmpty)
  isEmptyRef.current = opts.isEmpty
  // What the form opened with (never kept as a draft) and what it held when last cleared.
  const initial = useRef<{ key: string; value: T; json: string } | null>(null)
  const baseline = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Open: remember the starting values, then put a saved draft back.
  useEffect(() => {
    if (!full) return
    initial.current = { key: full, value: latest.current.value, json: latest.current.json }
    baseline.current = null
    const s = readStored<T>(full)
    if (s && JSON.stringify(s.v ?? null) !== latest.current.json && !isEmptyRef.current?.(s.v)) {
      applyRef.current(s.v)
      setRestoredAt(s.at)
      setSavedAt(s.at)
    } else {
      setRestoredAt(null)
      setSavedAt(null)
    }
    setReadyKey(full)
  }, [full])

  const keepNow = useCallback(() => {
    if (!full || readyKey !== full) return
    const cur = latest.current.json
    if (cur === initial.current?.json || cur === baseline.current || isEmptyRef.current?.(latest.current.value)) {
      remove(full)
      return
    }
    const at = write(full, latest.current.value)
    if (at) setSavedAt(at)
  }, [full, readyKey])

  // Save shortly after each change (only once the open step above has run, so it never wipes a draft).
  useEffect(() => {
    if (!full || readyKey !== full) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(keepNow, SAVE_DELAY_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [json, full, readyKey, keepNow])

  // Save at once when the tab is hidden or the page is left (a refresh inside the save delay keeps the last keys).
  useEffect(() => {
    if (!full) return
    const flush = () => keepNow()
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
      flush()
    }
  }, [full, keepNow])

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    baseline.current = latest.current.json
    if (full) remove(full)
    setRestoredAt(null)
    setSavedAt(null)
  }, [full])

  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    if (full) remove(full)
    if (initial.current && initial.current.key === full) applyRef.current(initial.current.value)
    setRestoredAt(null)
    setSavedAt(null)
  }, [full])

  return { restoredAt, savedAt, discard, clear }
}

/**
 * Whether this login has a kept draft for `key` in the company in view — for a page that opens a form in a pop-up,
 * so it can reopen the form after a refresh (the form's own useFormDraft then puts the values back).
 */
export function hasFormDraft(key: string): boolean {
  if (typeof window === 'undefined') return false
  const userId = useAuthStore.getState().user?.id
  return !!userId && readStored(storageKey(userId, key)) !== null
}
