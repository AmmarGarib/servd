// IndexedDB offline order queue — mirrors SW logic for reads from the page

const DB_NAME = 'servd-offline'
const STORE = 'pos_queue'

export interface OfflineOrder {
  localId: string
  body: Record<string, unknown>
  queuedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'localId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getQueuedOrders(): Promise<OfflineOrder[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll() as IDBRequest<OfflineOrder[]>
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function requestSync(): void {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    navigator.serviceWorker.ready.then((reg) => {
      ;(reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } })
        .sync?.register('pos-order-sync')
        .catch(() => {
          // Background sync not available — trigger manual flush via message
          navigator.serviceWorker.controller?.postMessage({ type: 'FLUSH_OFFLINE_QUEUE' })
        })
    })
  } else if ('serviceWorker' in navigator) {
    navigator.serviceWorker.controller?.postMessage({ type: 'FLUSH_OFFLINE_QUEUE' })
  }
}

export function listenForSync(cb: (count: number) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {}
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'ORDERS_SYNCED') cb(e.data.count as number)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}
