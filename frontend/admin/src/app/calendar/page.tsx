'use client'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type EventType = 'social_post'|'menu_change'|'seasonal_ingredient'|'deal'|'shoot'|'event_promo'|'reminder'|'task'
type EventStatus = 'draft'|'scheduled'|'live'|'done'|'cancelled'
type Platform = 'instagram'|'facebook'|'tiktok'

interface CalEvent {
  id: string
  title: string
  description?: string
  type: EventType
  startDate: string
  endDate?: string
  allDay: boolean
  status: EventStatus
  conceptId?: string
  assigneeId?: string
  department?: string
  color?: string
  metadata?: Record<string, unknown>
  assignee?: { id: string; name: string } | null
  createdBy?: { id: string; name: string }
  socialPost?: {
    id: string; platform: Platform; caption: string
    mediaUrls: string[]; scheduledFor: string; status: string; publishedAt?: string; error?: string
  } | null
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<EventType, { label: string; color: string; bg: string; emoji: string }> = {
  social_post:         { label: 'Social Post',  color: '#3b82f6', bg: 'bg-blue-500',   emoji: '📱' },
  menu_change:         { label: 'Menu Change',  color: '#f97316', bg: 'bg-orange-500', emoji: '🍽' },
  seasonal_ingredient: { label: 'Seasonal',     color: '#22c55e', bg: 'bg-green-500',  emoji: '🌿' },
  deal:                { label: 'Deal',          color: '#a855f7', bg: 'bg-purple-500', emoji: '🎁' },
  shoot:               { label: 'Shoot',         color: '#ec4899', bg: 'bg-pink-500',   emoji: '📸' },
  event_promo:         { label: 'Event/Promo',   color: '#ef4444', bg: 'bg-red-500',    emoji: '🎉' },
  reminder:            { label: 'Reminder',      color: '#eab308', bg: 'bg-yellow-500', emoji: '🔔' },
  task:                { label: 'Task',           color: '#64748b', bg: 'bg-slate-500',  emoji: '✅' },
}

const DEPT_OPTIONS = ['', 'marketing', 'procurement', 'kitchen', 'ops', 'management']
const STATUS_OPTIONS: EventStatus[] = ['draft','scheduled','live','done','cancelled']

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function calendarGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1)
  const last  = new Date(year, month + 1, 0)
  const grid: (Date | null)[] = Array(first.getDay()).fill(null)
  for (let d = 1; d <= last.getDate(); d++) grid.push(new Date(year, month, d))
  while (grid.length % 7 !== 0) grid.push(null)
  return grid
}

function fmtDate(d: Date) {
  return d.toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })
}

function toInputDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const qc = useQueryClient()
  const today = new Date()
  const [viewMonth, setViewMonth] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [selectedDay, setSelectedDay] = useState<Date | null>(null)
  const [editEvent, setEditEvent] = useState<CalEvent | null>(null)
  const [createOnDay, setCreateOnDay] = useState<Date | null>(null)
  const [filterDept, setFilterDept] = useState('')
  const [filterType, setFilterType] = useState<EventType | ''>('')

  // Fetch events for visible month + one week buffer each side
  const from = new Date(viewMonth.year, viewMonth.month - 1, 24).toISOString()
  const to   = new Date(viewMonth.year, viewMonth.month + 1, 8).toISOString()
  const { data: events = [] } = useQuery<CalEvent[]>({
    queryKey: ['calendar', from, to, filterDept, filterType],
    queryFn:  () => api.get(`/calendar?from=${from}&to=${to}${filterDept ? `&department=${filterDept}` : ''}${filterType ? `&type=${filterType}` : ''}`),
  })

  const grid = useMemo(() => calendarGrid(viewMonth.year, viewMonth.month), [viewMonth])

  const eventsForDay = (day: Date) =>
    events.filter((e) => isSameDay(new Date(e.startDate), day))

  function prevMonth() {
    setViewMonth(({ year, month }) =>
      month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 })
  }
  function nextMonth() {
    setViewMonth(({ year, month }) =>
      month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 })
  }

  const monthLabel = new Date(viewMonth.year, viewMonth.month).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })

  const dayEvents = selectedDay ? eventsForDay(selectedDay) : []

  return (
    <div className="flex h-screen flex-col bg-kds-bg text-kds-text">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kds-border bg-kds-card px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-black">Content Calendar</h1>
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="rounded p-1 hover:bg-kds-border text-lg">‹</button>
            <span className="min-w-36 text-center font-semibold">{monthLabel}</span>
            <button onClick={nextMonth} className="rounded p-1 hover:bg-kds-border text-lg">›</button>
          </div>
          <button
            onClick={() => setViewMonth({ year: today.getFullYear(), month: today.getMonth() })}
            className="rounded border border-kds-border px-2 py-1 text-xs text-kds-subtext hover:text-kds-text"
          >
            Today
          </button>
        </div>
        <div className="flex items-center gap-3">
          {/* Filters */}
          <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}
            className="rounded-lg border border-kds-border bg-kds-bg px-2 py-1 text-xs text-kds-text">
            <option value="">All Departments</option>
            {DEPT_OPTIONS.filter(Boolean).map((d) => (
              <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
            ))}
          </select>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value as EventType | '')}
            className="rounded-lg border border-kds-border bg-kds-bg px-2 py-1 text-xs text-kds-text">
            <option value="">All Types</option>
            {Object.entries(TYPE_CONFIG).map(([k, v]) => (
              <option key={k} value={k}>{v.emoji} {v.label}</option>
            ))}
          </select>
          <button
            onClick={() => setCreateOnDay(today)}
            className="rounded-lg bg-kds-green px-4 py-1.5 text-sm font-bold text-black hover:opacity-90"
          >
            + New Event
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Calendar grid */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-kds-border">
            {DAYS.map((d) => (
              <div key={d} className="py-2 text-center text-xs font-bold uppercase tracking-wider text-kds-subtext">
                {d}
              </div>
            ))}
          </div>

          {/* Weeks */}
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-7" style={{ gridAutoRows: 'minmax(80px, 1fr)' }}>
              {grid.map((day, i) => {
                if (!day) return (
                  <div key={`empty-${i}`} className="border-b border-r border-kds-border bg-kds-bg/30 p-1" />
                )
                const dayEvts = eventsForDay(day)
                const isToday = isSameDay(day, today)
                const isSelected = selectedDay && isSameDay(day, selectedDay)

                return (
                  <div
                    key={day.toISOString()}
                    onClick={() => setSelectedDay(isSelected ? null : day)}
                    className={`cursor-pointer border-b border-r border-kds-border p-1 transition-colors hover:bg-kds-card/60
                      ${isSelected ? 'bg-kds-card ring-1 ring-inset ring-kds-green' : ''}
                    `}
                  >
                    <div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold
                      ${isToday ? 'bg-kds-green text-black' : 'text-kds-subtext'}
                    `}>
                      {day.getDate()}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvts.slice(0, 3).map((e) => {
                        const cfg = TYPE_CONFIG[e.type]
                        return (
                          <div
                            key={e.id}
                            onClick={(ev) => { ev.stopPropagation(); setEditEvent(e) }}
                            className="truncate rounded px-1 py-0.5 text-xs font-medium text-white cursor-pointer hover:opacity-80"
                            style={{ backgroundColor: e.color ?? cfg.color }}
                          >
                            {cfg.emoji} {e.title}
                          </div>
                        )
                      })}
                      {dayEvts.length > 3 && (
                        <div className="text-xs text-kds-subtext pl-1">+{dayEvts.length - 3} more</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Day detail sidebar */}
        {selectedDay && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-kds-border bg-kds-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-bold">{fmtDate(selectedDay)}</h2>
              <button
                onClick={() => setCreateOnDay(selectedDay)}
                className="rounded-lg bg-kds-green px-3 py-1 text-xs font-bold text-black"
              >
                + Add
              </button>
            </div>
            {dayEvents.length === 0 && (
              <p className="text-sm text-kds-subtext">Nothing planned. Click + Add to schedule something.</p>
            )}
            {dayEvents.map((e) => {
              const cfg = TYPE_CONFIG[e.type]
              return (
                <div key={e.id}
                  onClick={() => setEditEvent(e)}
                  className="mb-3 cursor-pointer rounded-xl border border-kds-border p-3 hover:border-kds-green/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">{cfg.emoji}</span>
                    <span className="font-semibold text-sm">{e.title}</span>
                    <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-bold text-white`}
                      style={{ backgroundColor: cfg.color }}>{cfg.label}</span>
                  </div>
                  {e.description && <p className="text-xs text-kds-subtext line-clamp-2">{e.description}</p>}
                  {e.assignee && <p className="text-xs text-kds-subtext mt-1">👤 {e.assignee.name}</p>}
                  {e.socialPost && (
                    <div className="mt-1 text-xs">
                      <span className={`font-bold ${e.socialPost.status === 'published' ? 'text-kds-green' : e.socialPost.status === 'failed' ? 'text-kds-red' : 'text-kds-amber'}`}>
                        {e.socialPost.platform} · {e.socialPost.status}
                      </span>
                    </div>
                  )}
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      e.status === 'done' ? 'border-kds-green text-kds-green' :
                      e.status === 'live' ? 'border-kds-amber text-kds-amber' :
                      e.status === 'cancelled' ? 'border-kds-red text-kds-red' :
                      'border-kds-border text-kds-subtext'
                    }`}>{e.status}</span>
                    {e.department && <span className="text-xs text-kds-subtext">{e.department}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Event type legend */}
      <div className="flex gap-4 border-t border-kds-border bg-kds-card px-6 py-2 overflow-x-auto">
        {Object.entries(TYPE_CONFIG).map(([k, v]) => (
          <button
            key={k}
            onClick={() => setFilterType(filterType === k ? '' : k as EventType)}
            className={`flex items-center gap-1 text-xs whitespace-nowrap transition-opacity ${filterType && filterType !== k ? 'opacity-40' : ''}`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: v.color }} />
            {v.emoji} {v.label}
          </button>
        ))}
      </div>

      {/* Create event drawer */}
      {createOnDay && (
        <EventDrawer
          initialDate={createOnDay}
          onClose={() => setCreateOnDay(null)}
          onSaved={() => { setCreateOnDay(null); void qc.invalidateQueries({ queryKey: ['calendar'] }) }}
        />
      )}

      {/* Edit event drawer */}
      {editEvent && (
        <EventDrawer
          event={editEvent}
          initialDate={new Date(editEvent.startDate)}
          onClose={() => setEditEvent(null)}
          onSaved={() => { setEditEvent(null); void qc.invalidateQueries({ queryKey: ['calendar'] }) }}
        />
      )}
    </div>
  )
}

// ─── Event Drawer ─────────────────────────────────────────────────────────────

interface DrawerProps {
  event?: CalEvent
  initialDate: Date
  onClose: () => void
  onSaved: () => void
}

function EventDrawer({ event, initialDate, onClose, onSaved }: DrawerProps) {
  const qc = useQueryClient()
  const [title, setTitle]       = useState(event?.title ?? '')
  const [description, setDesc]  = useState(event?.description ?? '')
  const [type, setType]         = useState<EventType>(event?.type ?? 'task')
  const [status, setStatus]     = useState<EventStatus>(event?.status ?? 'draft')
  const [startDate, setStart]   = useState(event ? event.startDate.slice(0, 10) : toInputDate(initialDate))
  const [endDate, setEnd]       = useState(event?.endDate?.slice(0, 10) ?? '')
  const [department, setDept]   = useState(event?.department ?? '')
  const [tab, setTab]           = useState<'details'|'social'>('details')

  // Social post fields (only when type = social_post)
  const [platform, setPlatform]     = useState<Platform>(
    (event?.socialPost?.platform as Platform) ?? 'instagram',
  )
  const [caption, setCaption]       = useState(event?.socialPost?.caption ?? '')
  const [mediaUrl, setMediaUrl]     = useState(event?.socialPost?.mediaUrls?.[0] ?? '')
  const [scheduledFor, setSchedFor] = useState(
    event?.socialPost?.scheduledFor?.slice(0, 16) ?? `${startDate}T09:00`,
  )

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        title, description: description || undefined, type, status,
        startDate: new Date(startDate).toISOString(),
        endDate:   endDate ? new Date(endDate).toISOString() : undefined,
        department: department || undefined,
        allDay: true,
      }
      if (event) {
        await api.patch(`/calendar/${event.id}`, payload)
        if (type === 'social_post' && caption) {
          await api.post(`/calendar/${event.id}/social-post`, {
            platform, caption, mediaUrls: mediaUrl ? [mediaUrl] : [],
            scheduledFor: new Date(scheduledFor).toISOString(),
          })
        }
      } else {
        const created = await api.post<CalEvent>('/calendar', payload)
        if (type === 'social_post' && caption) {
          await api.post(`/calendar/${created.id}/social-post`, {
            platform, caption, mediaUrls: mediaUrl ? [mediaUrl] : [],
            scheduledFor: new Date(scheduledFor).toISOString(),
          })
        }
      }
    },
    onSuccess: onSaved,
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/calendar/${event!.id}`),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-xl rounded-t-2xl bg-kds-card p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bold text-lg">{event ? 'Edit Event' : 'New Event'}</h2>
          <div className="flex items-center gap-2">
            {event && (
              <button
                onClick={() => { if (window.confirm('Delete this event?')) deleteMutation.mutate() }}
                className="rounded-lg border border-kds-red px-3 py-1 text-xs text-kds-red hover:bg-kds-red/10"
              >
                Delete
              </button>
            )}
            <button onClick={onClose} className="text-kds-subtext text-2xl leading-none">✕</button>
          </div>
        </div>

        {/* Tabs (only show social tab for social_post type) */}
        {type === 'social_post' && (
          <div className="mb-4 flex gap-1 rounded-lg border border-kds-border p-1 text-xs font-bold">
            <button onClick={() => setTab('details')} className={`flex-1 rounded-md py-1.5 transition-colors ${tab === 'details' ? 'bg-kds-green text-black' : 'text-kds-subtext'}`}>Details</button>
            <button onClick={() => setTab('social')} className={`flex-1 rounded-md py-1.5 transition-colors ${tab === 'social' ? 'bg-kds-green text-black' : 'text-kds-subtext'}`}>📱 Social Post</button>
          </div>
        )}

        {tab === 'details' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-kds-subtext">Title *</label>
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-kds-subtext">Type</label>
                <select value={type} onChange={(e) => setType(e.target.value as EventType)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm">
                  {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>{v.emoji} {v.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext">Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm">
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext">Date</label>
                <input type="date" value={startDate} onChange={(e) => setStart(e.target.value)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm" />
              </div>
              <div>
                <label className="text-xs text-kds-subtext">End Date (optional)</label>
                <input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm" />
              </div>
              <div>
                <label className="text-xs text-kds-subtext">Department</label>
                <select value={department} onChange={(e) => setDept(e.target.value)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm">
                  {DEPT_OPTIONS.map((d) => <option key={d} value={d}>{d || 'None'}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Notes / Description</label>
              <textarea value={description} onChange={(e) => setDesc(e.target.value)} rows={3}
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm resize-none" />
            </div>
          </div>
        )}

        {tab === 'social' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-kds-subtext">Platform</label>
                <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm">
                  <option value="instagram">📸 Instagram</option>
                  <option value="facebook">🤝 Facebook</option>
                  <option value="tiktok">🎵 TikTok</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-kds-subtext">Publish Time</label>
                <input type="datetime-local" value={scheduledFor}
                  onChange={(e) => setSchedFor(e.target.value)}
                  className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Image URL</label>
              <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)}
                placeholder="https://..."
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm" />
              {mediaUrl && (
                <img src={mediaUrl} alt="preview" className="mt-2 h-32 w-full rounded-lg object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />
              )}
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Caption (max 2200 chars)</label>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={5}
                placeholder={`Write your ${platform} caption here…\n\n#hashtags`}
                className="w-full mt-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text focus:border-kds-green focus:outline-none text-sm resize-none font-mono" />
              <p className="mt-1 text-right text-xs text-kds-subtext">{caption.length}/2200</p>
            </div>
            {event?.socialPost?.status === 'failed' && (
              <div className="rounded-lg bg-kds-red/10 border border-kds-red p-3 text-xs text-kds-red">
                ⚠ Last publish failed: {event.socialPost.error}
              </div>
            )}
            {event?.socialPost?.status === 'published' && (
              <div className="rounded-lg bg-kds-green/10 border border-kds-green p-3 text-xs text-kds-green">
                ✓ Published {event.socialPost.publishedAt ? new Date(event.socialPost.publishedAt).toLocaleString('en-PK') : ''}
              </div>
            )}
          </div>
        )}

        {saveMutation.isError && (
          <p className="mt-2 text-sm text-kds-red">Save failed — check required fields.</p>
        )}

        <div className="mt-4 flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext hover:text-kds-text text-sm">
            Cancel
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!title.trim() || saveMutation.isPending}
            className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-black disabled:opacity-50 hover:opacity-90 text-sm"
          >
            {saveMutation.isPending ? 'Saving…' : event ? 'Save Changes' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  )
}
