'use client'
import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenEntry {
  userId: string
  staffName: string
  tokens: Array<{
    id: string
    deviceType: 'tablet' | 'mobile' | 'kiosk'
    registeredAt: string
  }>
}

interface Location {
  id: string
  name: string
}

type DeviceType = 'tablet' | 'mobile' | 'kiosk'

interface BroadcastFilters {
  device?: string[]
  locationId?: string
  userIds?: string[]
}

interface BroadcastBody {
  title: string
  body: string
  data?: Record<string, string>
  filters?: BroadcastFilters
}

interface BroadcastResult {
  sent: number
  failed: number
}

interface BroadcastHistoryEntry {
  id: string
  title: string
  body: string
  filters?: BroadcastFilters
  sentAt: string
  sent: number
  failed: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sel =
  'rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'

const DEVICE_TYPES: DeviceType[] = ['tablet', 'mobile', 'kiosk']

const DEVICE_ICONS: Record<DeviceType, string> = {
  tablet: '🖥',
  mobile: '📱',
  kiosk: '🖨',
}

function useLocalHistory(): [
  BroadcastHistoryEntry[],
  (entry: BroadcastHistoryEntry) => void,
] {
  const KEY = 'servd_broadcast_history'
  const [history, setHistory] = useState<BroadcastHistoryEntry[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) setHistory(JSON.parse(raw) as BroadcastHistoryEntry[])
    } catch {
      /* ignore */
    }
  }, [])

  function push(entry: BroadcastHistoryEntry) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 5)
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return [history, push]
}

// ─── Registered Devices Section ───────────────────────────────────────────────

function RegisteredDevices({ tokens }: { tokens: TokenEntry[] }) {
  if (tokens.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-s-border py-12 text-center">
        <p className="text-3xl mb-3">📱</p>
        <p className="font-semibold text-s-text">No devices registered</p>
        <p className="text-sm text-s-muted mt-1 max-w-xs mx-auto">
          Install the tablet app and sign in to register a device for push
          notifications.
        </p>
      </div>
    )
  }

  const totalDevices = tokens.reduce((acc, t) => acc + t.tokens.length, 0)

  return (
    <div className="space-y-3">
      <p className="text-sm text-s-muted">
        {tokens.length} staff member{tokens.length !== 1 ? 's' : ''} &mdash;{' '}
        {totalDevices} device{totalDevices !== 1 ? 's' : ''} registered
      </p>
      <div className="rounded-xl border border-s-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-s-surface border-b border-s-border">
            <tr>
              {['Staff', 'Devices', 'Last registered'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left font-semibold text-s-muted"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-s-border">
            {tokens.map((row) => {
              // Count per device type
              const counts: Record<string, number> = {}
              for (const t of row.tokens) {
                counts[t.deviceType] = (counts[t.deviceType] ?? 0) + 1
              }
              const latest = row.tokens.reduce(
                (acc, t) =>
                  new Date(t.registeredAt) > new Date(acc) ? t.registeredAt : acc,
                row.tokens[0]!.registeredAt,
              )

              return (
                <tr key={row.userId} className="hover:bg-s-surface/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-s-text">
                    {row.staffName}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {DEVICE_TYPES.map((dt) =>
                        counts[dt] ? (
                          <span
                            key={dt}
                            className="flex items-center gap-1 text-xs text-s-muted"
                          >
                            <span>{DEVICE_ICONS[dt]}</span>
                            <span className="font-semibold text-s-text">
                              {counts[dt]}
                            </span>
                            <span className="capitalize">{dt}</span>
                          </span>
                        ) : null,
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-s-muted text-xs">
                    {formatDistanceToNowStrict(new Date(latest))} ago
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// ─── Send Broadcast Section ────────────────────────────────────────────────────

function SendBroadcast({
  tokens,
  locations,
  onSent,
}: {
  tokens: TokenEntry[]
  locations: Location[]
  onSent: (entry: BroadcastHistoryEntry) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [deviceFilter, setDeviceFilter] = useState<Set<DeviceType>>(new Set())
  const [locationId, setLocationId] = useState('')
  const [lastResult, setLastResult] = useState<BroadcastResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const hasFilters = deviceFilter.size > 0 || locationId !== ''

  // Compute recipient count from token data + current filters
  const recipientCount = useMemo(() => {
    let allTokens = tokens.flatMap((u) => u.tokens)
    if (deviceFilter.size > 0) {
      allTokens = allTokens.filter((t) => deviceFilter.has(t.deviceType as DeviceType))
    }
    // locationId filter can't be client-side-evaluated (it's a server concern),
    // so we only apply the device filter locally and show a note for location.
    return allTokens.length
  }, [tokens, deviceFilter])

  const broadcast = useMutation({
    mutationFn: (payload: BroadcastBody) =>
      api.post<BroadcastResult>('/notifications/broadcast', payload),
    onSuccess: (result) => {
      setLastResult(result)
      setErrorMsg(null)
      onSent({
        id: crypto.randomUUID(),
        title,
        body,
        filters: buildFilters(),
        sentAt: new Date().toISOString(),
        sent: result.sent,
        failed: result.failed,
      })
      setTitle('')
      setBody('')
      setDeviceFilter(new Set())
      setLocationId('')
    },
    onError: (e: Error) => {
      setErrorMsg(e.message)
    },
  })

  function buildFilters(): BroadcastFilters | undefined {
    const f: BroadcastFilters = {}
    if (deviceFilter.size > 0) f.device = Array.from(deviceFilter)
    if (locationId) f.locationId = locationId
    return Object.keys(f).length > 0 ? f : undefined
  }

  function handleSend() {
    if (!title.trim() || !body.trim()) return
    const filters = buildFilters()
    broadcast.mutate({ title: title.trim(), body: body.trim(), ...(filters && { filters }) })
  }

  function toggleDevice(dt: DeviceType) {
    setDeviceFilter((prev) => {
      const next = new Set(prev)
      if (next.has(dt)) next.delete(dt)
      else next.add(dt)
      return next
    })
  }

  return (
    <div className="space-y-4 max-w-xl">
      {/* Title */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-s-text">Title</label>
          <span
            className={`text-xs ${title.length > 70 ? 'text-s-red' : 'text-s-muted'}`}
          >
            {title.length}/80
          </span>
        </div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 80))}
          placeholder="e.g. Kitchen — shift update"
          className="w-full rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none placeholder:text-s-muted/50"
        />
      </div>

      {/* Body */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-s-text">Message</label>
          <span
            className={`text-xs ${body.length > 280 ? 'text-s-red' : 'text-s-muted'}`}
          >
            {body.length}/300
          </span>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 300))}
          rows={4}
          placeholder="Enter your broadcast message…"
          className="w-full rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none placeholder:text-s-muted/50 resize-none"
        />
      </div>

      {/* Filters collapsible */}
      <div className="rounded-xl border border-s-border overflow-hidden">
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-s-text hover:bg-s-surface/50 transition-colors"
        >
          <span className="flex items-center gap-2">
            Filters
            {hasFilters && (
              <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-ink">
                {deviceFilter.size + (locationId ? 1 : 0)} active
              </span>
            )}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: filtersOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
              color: 'rgb(var(--fg-rgb) / 0.3)',
            }}
          >
            <path d="M2 4l4 4 4-4" />
          </svg>
        </button>

        {filtersOpen && (
          <div className="border-t border-s-border px-4 py-4 space-y-4 bg-s-surface/20">
            {/* Device type */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">
                Device type
              </p>
              <div className="flex flex-wrap gap-2">
                {DEVICE_TYPES.map((dt) => (
                  <button
                    key={dt}
                    onClick={() => toggleDevice(dt)}
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors capitalize ${
                      deviceFilter.has(dt)
                        ? 'border-primary bg-primary/10 text-primary-ink'
                        : 'border-s-border bg-s-surface text-s-muted hover:border-primary/50'
                    }`}
                  >
                    <span>{DEVICE_ICONS[dt]}</span>
                    {dt}
                  </button>
                ))}
              </div>
            </div>

            {/* Location */}
            {locations.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">
                  Location
                </p>
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className={sel + ' w-full'}
                >
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {hasFilters && (
              <button
                onClick={() => {
                  setDeviceFilter(new Set())
                  setLocationId('')
                }}
                className="text-xs text-s-muted hover:text-s-red transition-colors"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recipient preview */}
      <div
        className={`rounded-lg px-4 py-2.5 text-sm flex items-center gap-2 ${
          hasFilters
            ? 'bg-s-amber/10 border border-s-amber/30 text-s-amber'
            : 'bg-primary/10 border border-primary/20 text-primary-ink'
        }`}
      >
        <span className="font-black">{recipientCount}</span>
        <span>
          {hasFilters
            ? `device${recipientCount !== 1 ? 's' : ''} match the current filters`
            : `device${recipientCount !== 1 ? 's' : ''} registered (sending to all)`}
        </span>
        {locationId && (
          <span className="text-s-muted text-xs">
            (location filter applied server-side)
          </span>
        )}
      </div>

      {/* Feedback */}
      {lastResult && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
          <p className="font-semibold text-primary-ink">
            Broadcast sent — {lastResult.sent} delivered
            {lastResult.failed > 0 && (
              <span className="text-s-amber">, {lastResult.failed} failed</span>
            )}
          </p>
        </div>
      )}
      {errorMsg && (
        <div className="rounded-lg border border-s-red/30 bg-s-red/10 px-4 py-3 text-sm text-s-red">
          {errorMsg}
        </div>
      )}

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={!title.trim() || !body.trim() || broadcast.isPending}
        className="w-full rounded-xl bg-primary py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {broadcast.isPending
          ? 'Sending…'
          : hasFilters
            ? 'Send to filtered devices'
            : 'Send to all devices'}
      </button>
    </div>
  )
}

// ─── Broadcast History ────────────────────────────────────────────────────────

function BroadcastHistory({ history }: { history: BroadcastHistoryEntry[] }) {
  if (history.length === 0) return null

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-s-muted uppercase tracking-wider">
        Recent broadcasts
      </h3>
      <div className="space-y-2">
        {history.map((entry) => {
          const deviceLabel =
            entry.filters?.device?.join(', ') ?? 'all devices'
          const hasFilters =
            (entry.filters?.device?.length ?? 0) > 0 || entry.filters?.locationId

          return (
            <div
              key={entry.id}
              className="rounded-xl border border-s-border bg-s-surface/50 px-4 py-3 flex items-start gap-4"
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-s-text text-sm truncate">
                  {entry.title}
                </p>
                <p className="text-xs text-s-muted mt-0.5 line-clamp-2">
                  {entry.body}
                </p>
                {hasFilters && (
                  <p className="text-xs text-s-muted/60 mt-1">
                    Sent to {deviceLabel}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0 space-y-0.5">
                <p className="text-xs text-s-muted">
                  {formatDistanceToNowStrict(new Date(entry.sentAt))} ago
                </p>
                <p className="text-xs font-semibold text-primary-ink">
                  {entry.sent} sent
                  {entry.failed > 0 && (
                    <span className="text-s-amber"> / {entry.failed} failed</span>
                  )}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const [history, pushHistory] = useLocalHistory()

  const { data: tokens = [], isLoading: tokensLoading } = useQuery({
    queryKey: ['notification-tokens'],
    queryFn: () => api.get<TokenEntry[]>('/notifications/tokens'),
  })

  const { data: locations = [] } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<Location[]>('/locations'),
    // Locations endpoint may not exist on all setups — don't error loudly
    retry: false,
  })

  return (
    <div className="h-screen flex flex-col bg-s-bg overflow-hidden">
      <header className="border-b border-s-border px-6 py-4 shrink-0">
        <h1 className="text-2xl font-black text-s-text">Notifications</h1>
        <p className="text-sm text-s-muted">
          Manage registered devices and send push broadcasts to staff
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-10">
        {/* ── Section 1: Registered Devices ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-black text-s-text">Registered Devices</h2>
            <p className="text-sm text-s-muted mt-0.5">
              Staff devices that have the app installed and notifications enabled
            </p>
          </div>

          {tokensLoading ? (
            <div className="rounded-xl border border-s-border py-10 text-center text-s-muted text-sm">
              Loading devices…
            </div>
          ) : (
            <RegisteredDevices tokens={tokens} />
          )}
        </section>

        {/* ── Section 2: Send Broadcast ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-black text-s-text">Send Broadcast</h2>
            <p className="text-sm text-s-muted mt-0.5">
              Push a message to all staff devices, or filter by device type or
              location
            </p>
          </div>

          <SendBroadcast
            tokens={tokens}
            locations={locations}
            onSent={pushHistory}
          />
        </section>

        {/* ── Section 3: History ── */}
        <section>
          <BroadcastHistory history={history} />
        </section>
      </div>
    </div>
  )
}
