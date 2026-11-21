// A sign-in page that repairs itself (owner, 2026-11-20: sign-in said "Failed to fetch" on 4G and on Wi-Fi while the
// server answered every check; it worked only after the browser's site data for admin.servd.pk was deleted — "Yes,
// build it").
//
// Two steps, both only on THIS device and both best-effort (a browser that refuses one never breaks the sign-in):
//   clearSavedPages — throws away the pages the service worker saved (Cache Storage) and unregisters the worker, so
//                     the next load comes fresh from the server. Done by itself before the one automatic retry.
//   resetDevice     — the button: that, plus this site's local settings, session storage and the cookies a page may
//                     clear, then reloads the sign-in page.
// NEVER touched: the till's unsent orders (IndexedDB, lib/offline-queue.ts — offline orders must never vanish) and
// unsaved form drafts (lib/formDraft.ts, keys `servd:draft:v1:`). A cookie set as HttpOnly by the API cannot be
// removed by a page — when the button does not help, the screen says how to clear site data in the browser.

const KEEP_PREFIXES = ['servd:draft:v1:']

/** A fetch that never reached the server (the browser reports it as a TypeError: "Failed to fetch"). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

export async function clearSavedPages(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch { /* best-effort */ }
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch { /* best-effort */ }
}

export async function resetDevice(): Promise<void> {
  await clearSavedPages()
  try {
    const drop: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && !KEEP_PREFIXES.some((p) => k.startsWith(p))) drop.push(k)
    }
    drop.forEach((k) => localStorage.removeItem(k))
  } catch { /* best-effort */ }
  try { sessionStorage.clear() } catch { /* best-effort */ }
  try {
    const host = window.location.hostname
    const parent = host.split('.').slice(-2).join('.')
    for (const part of document.cookie.split(';')) {
      const name = part.split('=')[0]?.trim()
      if (!name) continue
      for (const domain of ['', `; domain=${host}`, `; domain=.${parent}`]) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`
      }
    }
  } catch { /* best-effort */ }
  window.location.replace(`/login?reset=${Date.now()}`)
}
