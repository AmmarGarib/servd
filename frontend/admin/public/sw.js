// servd Service Worker — offline POS queue + KDS caching
const CACHE = 'servd-v2'
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
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Intercept POS order POST — queue offline, return synthetic success
  if (e.request.method === 'POST' && url.pathname.endsWith('/pos/orders')) {
    e.respondWith(
      fetch(e.request.clone()).catch(async () => {
        // Network failed — queue in IndexedDB and respond with a pending placeholder
        const body = await e.request.clone().json().catch(() => null)
        if (body) await queueOfflineOrder(body)
        return new Response(
          JSON.stringify({ id: `offline_${Date.now()}`, status: 'queued_offline' }),
          { status: 202, headers: { 'Content-Type': 'application/json', 'X-Offline': '1' } }
        )
      })
    )
    return
  }

  // Cache-first for navigation + static assets
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

// ── Background Sync ───────────────────────────────────────────────────────────
self.addEventListener('sync', (e) => {
  if (e.tag === 'pos-order-sync') {
    e.waitUntil(flushOfflineQueue())
  }
})

// ── Message from page ─────────────────────────────────────────────────────────
self.addEventListener('message', (e) => {
  if (e.data?.type === 'FLUSH_OFFLINE_QUEUE') {
    flushOfflineQueue().then((flushed) => {
      e.source?.postMessage({ type: 'FLUSH_COMPLETE', flushed })
    })
  }
})

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('servd-offline', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pos_queue', { keyPath: 'localId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function queueOfflineOrder(body) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pos_queue', 'readwrite')
    const store = tx.objectStore('pos_queue')
    const entry = { localId: `offline_${Date.now()}`, body, queuedAt: Date.now() }
    const req = store.put(entry)
    req.onsuccess = () => resolve(entry)
    req.onerror = () => reject(req.error)
  })
}

async function getAllQueued() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pos_queue', 'readonly')
    const req = tx.objectStore('pos_queue').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function deleteQueued(localId) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pos_queue', 'readwrite')
    const req = tx.objectStore('pos_queue').delete(localId)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function flushOfflineQueue() {
  const entries = await getAllQueued()
  let flushed = 0
  for (const entry of entries) {
    try {
      const res = await fetch('/api/v1/pos/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.body),
      })
      if (res.ok || res.status < 500) {
        await deleteQueued(entry.localId)
        flushed++
      }
    } catch {
      // Still offline — leave in queue
    }
  }
  if (flushed > 0) {
    self.clients.matchAll().then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'ORDERS_SYNCED', count: flushed }))
    })
  }
  return flushed
}
