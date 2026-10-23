// servd Service Worker — page caching for the till and KDS (the offline order
// queue lives in the page: src/lib/offline-queue.ts)
const CACHE = 'servd-v3'
const POS_CACHE = 'servd-pos-v1'

const PRECACHE = ['/', '/kds', '/kds/all', '/kds/cart', '/pos', '/favicon.ico']

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  )
  self.skipWaiting()
})

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== POS_CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// ── Fetch ─────────────────────────────────────────────────────────────────────
// The till's writes are NOT intercepted here (owner, 2026-10-23: offline orders
// must never vanish). The page keeps an order it could not send in IndexedDB
// (src/lib/offline-queue.ts) and replays it itself with the cashier's session;
// money writes fail loudly offline. This worker never answers a write with a
// made-up success and never deletes a queued order.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return

  // Network first, cache as fallback, for navigation + static assets
  if (e.request.mode === 'navigate' || url.pathname.startsWith('/_next/static')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, clone))
          return res
        })
        .catch(() => caches.match(e.request))
    )
  }
})

// ── Background Sync: wake the open tills so THEY replay (with their session) ──
self.addEventListener('sync', (e) => {
  if (e.tag === 'pos-order-sync') {
    e.waitUntil(askPagesToReplay())
  }
})

// Old pages may still post FLUSH_OFFLINE_QUEUE: the page replays now, so just nudge.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'FLUSH_OFFLINE_QUEUE') askPagesToReplay()
})

async function askPagesToReplay() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  clients.forEach((c) => c.postMessage({ type: 'REPLAY_OFFLINE_QUEUE' }))
}
