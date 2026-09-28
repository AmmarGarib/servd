// Server → client push, independent of transport.
//
// Two drivers, chosen by env:
//   socketio  — the in-process socket.io server (Docker deployment). ws.ts
//               registers itself here once the server is up.
//   supabase  — Supabase Realtime private broadcast channels, published over
//               its REST endpoint. This is the only driver that works on
//               Vercel, where nothing stays alive between requests.
// REALTIME_DRIVER=socketio|supabase|both. Default: both drivers that are
// configured — so during the migration a Docker box can keep serving socket.io
// clients while the same box also feeds the Supabase channels the Vercel
// previews listen on.
//
// Topic names are the historical room names (tenant:{id}:orders, station:{id},
// …) and event names are unchanged, so clients only swap the transport.
//
// Publishing is best-effort and never throws into a request: an order must
// never fail because a kitchen screen could not be told about it. Clients
// keep their polling fallback for the gap.

type Publisher = (topic: string, event: string, payload: unknown) => void

let socketIoPublisher: Publisher | null = null

/** Called by ws.ts once socket.io is listening. */
export function setSocketIoPublisher(fn: Publisher | null): void {
  socketIoPublisher = fn
}

// Read per call, not at import: the Docker box flips REALTIME_DRIVER /
// SUPABASE_* on a restart, and tests set them after the module loads.
const supabaseUrl = () => (process.env['SUPABASE_URL'] ?? '').replace(/\/+$/, '')
const serviceRoleKey = () => process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

export function supabaseRealtimeConfigured(): boolean {
  return Boolean(supabaseUrl() && serviceRoleKey())
}

function driversEnabled(): { socketio: boolean; supabase: boolean } {
  const mode = process.env['REALTIME_DRIVER'] ?? 'both'
  return {
    socketio: (mode === 'socketio' || mode === 'both') && socketIoPublisher !== null,
    supabase: (mode === 'supabase' || mode === 'both') && supabaseRealtimeConfigured(),
  }
}

/**
 * The transport clients should use. Supabase wins whenever it is configured:
 * a Vercel-hosted API has no socket server at all, and a Docker box that has
 * Supabase configured is mid-migration and wants clients moved over.
 */
export function clientRealtimeDriver(): 'supabase' | 'socketio' {
  const mode = process.env['REALTIME_DRIVER'] ?? 'both'
  if (mode !== 'socketio' && supabaseRealtimeConfigured()) return 'supabase'
  return 'socketio'
}

// ─── Supabase driver: batched REST broadcast ─────────────────────────────────
//
// One order fans out to two or three topics; batching per tick turns that into
// a single HTTP call. `private: true` on every message — the channels are
// guarded by the RLS policy in backend/supabase/realtime-policy.sql.

interface Message { topic: string; event: string; payload: unknown; private: true }

let batch: Message[] = []
let batchScheduled = false
const inFlight = new Set<Promise<void>>()

async function sendBatch(messages: Message[]): Promise<void> {
  const key = serviceRoleKey()
  const res = await fetch(`${supabaseUrl()}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`broadcast ${res.status}: ${text.slice(0, 200)}`)
  }
}

function scheduleFlush(): void {
  if (batchScheduled) return
  batchScheduled = true
  queueMicrotask(() => {
    batchScheduled = false
    const messages = batch
    batch = []
    if (messages.length === 0) return
    const p = sendBatch(messages)
      .catch((err: Error) => console.error('[realtime] supabase broadcast failed:', err.message))
      .finally(() => { inFlight.delete(p) })
    inFlight.add(p)
  })
}

/**
 * Publish one event to one topic on every enabled driver.
 */
export function publish(topic: string, event: string, payload: unknown): void {
  const on = driversEnabled()
  if (on.socketio) {
    try {
      socketIoPublisher!(topic, event, payload)
    } catch (err) {
      console.error(`[realtime] socket.io publish ${event}→${topic} failed:`, (err as Error).message)
    }
  }
  if (on.supabase) {
    batch.push({ topic, event, payload, private: true })
    scheduleFlush()
  }
  if (!on.socketio && !on.supabase) {
    // Visible so a misconfigured deployment is not silent — but never a throw.
    console.warn(`[realtime] ${event}→${topic} dropped: no realtime driver configured`)
  }
}

/**
 * Wait for pending Supabase broadcasts. A serverless function may be frozen
 * the moment its response is sent, which would strand a fire-and-forget fetch;
 * the app awaits this in an onSend hook when running on Vercel.
 */
export async function flushRealtime(): Promise<void> {
  if (batch.length > 0) {
    batchScheduled = false
    const messages = batch
    batch = []
    const p = sendBatch(messages)
      .catch((err: Error) => console.error('[realtime] supabase broadcast failed:', err.message))
    inFlight.add(p)
    p.finally(() => { inFlight.delete(p) })
  }
  if (inFlight.size > 0) await Promise.allSettled(Array.from(inFlight))
}
