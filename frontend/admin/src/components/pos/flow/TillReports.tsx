'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, ChevronDown, ChevronRight, Download, Menu, Printer, RotateCcw, Search, Star, ArrowLeft, List } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { Select } from '../../ui/Select'
import { printHtml } from '../tillApi'
import { flowErrorMessage } from './flowApi'
import { ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

// Till -> MANAGER -> Reports (owner, 2026-10-22). Builds against
// backend/src/modules/reports/TILL_REPORTS.md: /reports/till/catalog,
// /lookups and /run/:reportId (?format=pdf|xlsx|csv for downloads). Read only.

type FilterKey = 'users' | 'waiters' | 'orderTypes' | 'categories' | 'subCategories' | 'menuItems' | 'sources' | 'terminals'
  | 'paymentMethods' | 'paymentType' | 'orderBy' | 'settleBy' | 'q' | 'items' | 'sessions'
type OptionKey = 'orderType' | 'session' | 'category' | 'subCategory' | 'menuItem' | 'tax' | 'extraCharge' | 'discount' | 'payment'
  | 'businessSource' | 'waiterWise' | 'userWise' | 'taxableValue' | 'includeNoCharge' | 'vouchers' | 'showCurrency' | 'detail'
type GroupByKey = 'payment_method' | 'payment_type' | 'order_by' | 'settle_by' | 'terminal' | 'order_type'

interface CatalogReport { id: string; title: string; filters: FilterKey[]; options: OptionKey[]; groupBy: GroupByKey[] | null; printable: boolean }
interface Catalog { groups: Array<{ key: string; title: string; reportIds: string[] }>; reports: CatalogReport[] }
interface Named { id: string; name: string }
interface Labelled { id: string; label: string }
interface Lookups {
  outlets: Named[]; users: Named[]; waiters: Named[]; categories: Array<Named & { conceptId?: string }>
  subCategories?: Array<Named & { parentId: string | null; conceptId?: string }>
  sessions?: Array<Named & { conceptId: string; startTime: string; endTime: string }>
  menuItems: Array<Named & { categoryId?: string }>; terminals: Labelled[]; sources: Labelled[]
  paymentMethods: Labelled[]; orderTypes: Labelled[]; items: Named[]
}
interface Col { key: string; label: string; type: 'text' | 'number' | 'cents' }
type Cell = string | number | null
interface Section { title: string | null; columns: Col[]; rows: Array<Record<string, Cell>>; totals: Record<string, Cell> | null }
interface RunResult { id: string; title: string; period: string; outlets: string[]; sections: Section[]; notes: string[]; printedBy?: string; printedAt?: string }

const FILTER_LABEL: Record<FilterKey, string> = {
  users: 'User', waiters: 'Waiter', orderTypes: 'Order type', categories: 'Category', subCategories: 'Sub Category', menuItems: 'Menu item', sessions: 'Session',
  sources: 'Business Source', terminals: 'Terminal', paymentMethods: 'Payment Method', paymentType: 'Payment Type',
  orderBy: 'Order By', settleBy: 'Settle By', q: 'Search text', items: 'Item',
}
const OPTION_LABEL: Record<OptionKey, string> = {
  orderType: 'Order type', session: 'Session', category: 'Category', subCategory: 'Sub Category', menuItem: 'Menu item', tax: 'Tax', extraCharge: 'Extra charge',
  discount: 'Discount', payment: 'Payment', businessSource: 'Business Source', waiterWise: 'Waiter Wise Sales',
  userWise: 'User Wise Sales', taxableValue: 'Show Taxable value of Sales', includeNoCharge: 'Include No Charge',
  vouchers: 'Expense/Income Voucher', showCurrency: 'Show Currency', detail: 'Show detail',
}
const GROUP_LABEL: Record<GroupByKey, string> = {
  payment_method: 'Payment Method', payment_type: 'Payment Type', order_by: 'Order By',
  settle_by: 'Settle By', terminal: 'Terminal', order_type: 'Order Type',
}

const FAV_KEY = 'servd.till.reports.favourites'
function loadFavs(): string[] {
  try { const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
function saveFavs(f: string[]) { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)) } catch { /* private window */ } }

/** The options a multi-select filter offers, from the lookups. */
function optionsFor(k: FilterKey, l: Lookups | undefined): Array<{ id: string; label: string }> {
  if (!l) return []
  const named = (a: Named[]) => a.map((x) => ({ id: x.id, label: x.name }))
  switch (k) {
    case 'users': case 'orderBy': case 'settleBy': return named(l.users)
    case 'waiters': return named(l.waiters)
    case 'categories': return named(l.categories)
    case 'subCategories': {
      // "Burgers › Beef" — the main category first, so subs of the same name read apart.
      const main = new Map(l.categories.map((c) => [c.id, c.name]))
      return (l.subCategories ?? []).map((c) => ({ id: c.id, label: `${main.get(c.parentId ?? '') ?? '—'} › ${c.name}` }))
    }
    case 'sessions': {
      const brand = new Map(l.outlets.map((o) => [o.id, o.name]))
      const many = new Set((l.sessions ?? []).map((x) => x.conceptId)).size > 1
      return (l.sessions ?? []).map((x) => ({ id: x.id, label: `${many ? `${brand.get(x.conceptId) ?? ''} · ` : ''}${x.name} (${x.startTime}–${x.endTime})` }))
    }
    case 'menuItems': return named(l.menuItems)
    case 'items': return named(l.items)
    case 'terminals': return l.terminals
    case 'sources': return l.sources
    case 'paymentMethods': return l.paymentMethods
    case 'orderTypes': return l.orderTypes
    default: return []
  }
}

function MultiPick({ label, options, value, onChange, allLabel = 'All', required }: {
  label: string; options: Array<{ id: string; label: string }>; value: string[]; onChange: (v: string[]) => void; allLabel?: string; required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])
  const shown = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
  const names = value.map((id) => options.find((o) => o.id === id)?.label ?? id)
  const summary = value.length === 0 ? allLabel : value.length <= 2 ? names.join(', ') : `${value.length} selected`
  return (
    <div ref={ref} className="relative">
      <span className={labelCls}>{label}{required ? ' *' : ''}</span>
      <button type="button" aria-label={`${label}: ${summary}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between gap-2 text-left`}>
        <span className="truncate">{summary}</span><ChevronDown size={16} aria-hidden="true" className="shrink-0 text-kds-subtext" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-kds-border bg-kds-card p-2 shadow-lg">
          {options.length > 6 && (
            <input type="search" aria-label={`Search ${label}`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" className={`${inputCls} mb-2`} />
          )}
          <div role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-56 overflow-y-auto">
            {shown.length === 0 && <p className="px-2 py-3 text-sm text-kds-subtext">Nothing to pick.</p>}
            {shown.map((o) => {
              const on = value.includes(o.id)
              return (
                <label key={o.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm text-kds-text hover:bg-kds-border/40">
                  <input type="checkbox" checked={on} className="h-4 w-4 accent-kds-green"
                    onChange={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])} />
                  <span className="min-w-0 truncate">{o.label}</span>
                </label>
              )
            })}
          </div>
          {value.length > 0 && <button type="button" onClick={() => onChange([])} className="mt-1 min-h-11 w-full rounded-md text-sm font-semibold text-kds-subtext hover:text-kds-text">Clear</button>}
        </div>
      )}
    </div>
  )
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function showCell(c: Col, v: Cell | undefined, currency: boolean): string {
  if (v == null || v === '') return '—'
  if (c.type === 'cents') return currency ? fmtPkr(Number(v)) : fmtPkr(Number(v)).replace(/^PKR\s*/i, '')
  // Whole counts plain; a figure with paisa (Sales Per Pax) to 2 decimals, like the printout.
  if (c.type === 'number') { const n = Number(v); return Number.isInteger(n) ? n.toLocaleString('en-PK') : n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
  return String(v)
}

function resultHtml(r: RunResult, currency: boolean): string {
  const body = r.sections.map((s) => `
    ${s.title ? `<h3>${esc(s.title)}</h3>` : ''}
    <table>${s.columns.some((c) => c.label) ? `<thead><tr>${s.columns.map((c) => `<th class="${c.type !== 'text' ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>` : ''}<tbody>
    ${s.rows.map((row) => `<tr>${s.columns.map((c) => `<td class="${c.type !== 'text' ? 'n' : ''}">${esc(showCell(c, row[c.key], currency))}</td>`).join('')}</tr>`).join('')}
    ${s.totals ? `<tr class="t">${s.columns.map((c) => `<td class="${c.type !== 'text' ? 'n' : ''}">${s.totals![c.key] == null ? '' : esc(showCell(c, s.totals![c.key], currency))}</td>`).join('')}</tr>` : ''}
    </tbody></table>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
    body{font-family:sans-serif;font-size:12px;padding:16px} h1{font-size:18px;margin:0} h3{margin:16px 0 4px}
    p{margin:2px 0;color:#444} table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #ccc;padding:4px 6px;text-align:left}
    .n{text-align:right} .t td{font-weight:bold;border-top:2px solid #000}</style></head><body>
    <h1>${esc(r.title)}</h1>${r.printedBy ? `<p>Printed By : ${esc(r.printedBy)} at ${esc(r.printedAt ?? '')}</p>` : ''}<p>Date: ${esc(r.period.replace(' to ', ' To '))}; Outlet: ${esc(r.outlets.join(', '))}</p>${body}<p style="text-align:center">---- End ----</p>
    ${r.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</body></html>`
}

export function TillReports({ conceptId, brands, onMenu }: { conceptId: string | null; brands: Array<{ id: string; name: string }>; onMenu: () => void }) {
  const catalogQ = useQuery<Catalog>({ queryKey: ['pos', 'till-reports', 'catalog'], queryFn: () => api.get('/reports/till/catalog'), staleTime: 5 * 60_000 })
  const catalog = catalogQ.data
  const byId = useMemo(() => new Map((catalog?.reports ?? []).map((r) => [r.id, r])), [catalog])

  const [favs, setFavs] = useState<string[]>([])
  useEffect(() => { setFavs(loadFavs()) }, [])
  const toggleFav = (id: string) => setFavs((f) => { const n = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]; saveFavs(n); return n })
  const [favOnly, setFavOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [listOpen, setListOpen] = useState(false)

  const [reportId, setReportId] = useState<string | null>(null)
  const report = reportId ? byId.get(reportId) ?? null : null
  useEffect(() => { if (!reportId && catalog?.reports[0]) setReportId(catalog.groups[0]?.reportIds[0] ?? catalog.reports[0].id) }, [catalog, reportId])

  const [from, setFrom] = useState(() => todayPktIso())
  const [to, setTo] = useState(() => todayPktIso())
  const [outlets, setOutlets] = useState<string[] | null>(null)
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [text, setText] = useState('')
  const [opts, setOpts] = useState<OptionKey[]>([])
  const [groupBy, setGroupBy] = useState<GroupByKey | ''>('')
  const [result, setResult] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [dlOpen, setDlOpen] = useState(false)
  const dlRef = useRef<HTMLDivElement>(null)

  const outletQ = useQuery<Lookups>({ queryKey: ['pos', 'till-reports', 'outlets'], queryFn: () => api.get('/reports/till/lookups'), staleTime: 5 * 60_000 })
  const outletList = outletQ.data?.outlets ?? []
  const selectedOutlets = useMemo(() => outlets ?? (conceptId ? [conceptId] : (brands[0] ? [brands[0].id] : [])), [outlets, conceptId, brands])
  const lookupQs = useMemo(() => new URLSearchParams({ conceptIds: selectedOutlets.join(','), dateFrom: from, dateTo: to }).toString(), [selectedOutlets, from, to])
  const lookupQ = useQuery<Lookups>({
    queryKey: ['pos', 'till-reports', 'lookups', lookupQs],
    queryFn: () => api.get(`/reports/till/lookups?${lookupQs}`),
    enabled: selectedOutlets.length > 0,
  })
  const lookups = lookupQ.data

  useEffect(() => {
    if (!dlOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !dlRef.current?.contains(e.target as Node)) setDlOpen(false)
    }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [dlOpen])

  function resetForm(r: CatalogReport | null) {
    setFrom(todayPktIso()); setTo(todayPktIso()); setOutlets(null); setFilters({}); setText(''); setOpts([])
    setGroupBy((r?.groupBy?.[0] ?? '')); setResult(null); setErr('')
  }
  function pick(id: string) {
    setReportId(id); setListOpen(false); resetForm(byId.get(id) ?? null)
  }
  useEffect(() => { if (report && groupBy === '' && report.groupBy) setGroupBy(report.groupBy[0] ?? '') }, [report, groupBy])

  const params = useMemo(() => {
    const p = new URLSearchParams({ conceptIds: selectedOutlets.join(','), dateFrom: from, dateTo: to })
    if (!report) return p
    for (const k of report.filters) {
      if (k === 'q') { if (text.trim()) p.set('q', text.trim()) } else {
        const v = filters[k] ?? []
        if (v.length) p.set(k, v.join(','))
      }
    }
    if (report.groupBy && groupBy) p.set('groupBy', groupBy)
    if (opts.length) p.set('opts', opts.join(','))
    return p
  }, [report, selectedOutlets, from, to, filters, text, groupBy, opts])

  const valid = !!report && selectedOutlets.length > 0 && !!from && !!to && from <= to && (!report.groupBy || !!groupBy)

  async function run() {
    if (!report || !valid) return
    setBusy(true); setErr('')
    try { setResult(await api.get<RunResult>(`/reports/till/run/${report.id}?${params.toString()}`)) }
    catch (e) { setErr(flowErrorMessage(e)) }
    finally { setBusy(false) }
  }
  async function download(format: 'pdf' | 'xlsx' | 'csv') {
    if (!report || !valid) return
    setDlOpen(false); setErr('')
    try { await api.download(`/reports/till/run/${report.id}?${params.toString()}&format=${format}`, `${report.id}-${from}-to-${to}.${format}`) }
    catch (e) { setErr(flowErrorMessage(e, 'Download failed')) }
  }
  async function print() {
    if (!result) return
    try { await printHtml(async () => resultHtml(result, result.id !== 'cashier_sales_detail'), { width: 900, height: 700 }) }
    catch (e) { setErr(flowErrorMessage(e, 'Could not print')) }
  }

  const q = search.trim().toLowerCase()
  const visible = (id: string) => {
    const r = byId.get(id); if (!r) return false
    if (favOnly && !favs.includes(id)) return false
    return !q || r.title.toLowerCase().includes(q)
  }
  const toggleOpt = (o: OptionKey) => setOpts((x) => x.includes(o) ? x.filter((y) => y !== o) : [...x, o])
  const setFilter = (k: FilterKey, v: string[]) => setFilters((f) => ({ ...f, [k]: v }))

  const list = (
    <nav aria-label="Reports" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 p-3">
        <div className="relative min-w-0 flex-1">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kds-subtext" />
          <input type="search" aria-label="Search reports" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} pl-9`} />
        </div>
        <button type="button" aria-label="Show favourites only" aria-pressed={favOnly} onClick={() => setFavOnly((v) => !v)}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${favOnly ? 'border-kds-green text-kds-green' : 'border-kds-border text-kds-subtext'}`}>
          <Star size={18} aria-hidden="true" fill={favOnly ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {catalogQ.isLoading && <p className="px-4 text-sm text-kds-subtext">Loading…</p>}
        {catalogQ.isError && <div className="px-4"><ErrorLine text={flowErrorMessage(catalogQ.error)} /></div>}
        {catalog?.groups.map((g) => {
          const ids = g.reportIds.filter(visible)
          if (ids.length === 0) return null
          const open = q || favOnly ? true : !closed[g.key]
          return (
            <section key={g.key}>
              <button type="button" aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [g.key]: open }))}
                className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-xs font-bold uppercase tracking-wider text-kds-subtext hover:text-kds-text">
                {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{g.title}
              </button>
              {open && ids.map((id) => {
                const r = byId.get(id)!
                const sel = id === reportId
                return (
                  <div key={id} className={`flex items-center ${sel ? 'bg-kds-green/20' : ''}`}>
                    <button type="button" aria-current={sel ? 'page' : undefined} onClick={() => pick(id)}
                      className={`min-h-11 min-w-0 flex-1 truncate px-4 text-left text-sm ${sel ? 'font-bold text-kds-green' : 'text-kds-text hover:text-kds-green'}`}>{r.title}</button>
                    <button type="button" aria-label={favs.includes(id) ? `Remove ${r.title} from favourites` : `Add ${r.title} to favourites`} aria-pressed={favs.includes(id)} onClick={() => toggleFav(id)}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center ${favs.includes(id) ? 'text-kds-green' : 'text-kds-subtext'}`}>
                      <Star size={16} aria-hidden="true" fill={favs.includes(id) ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </nav>
  )

  // The Cashier Sales Report prints plain figures (owner's printout); the others show PKR.
  const currency = result?.id !== 'cashier_sales_detail'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">Report</h1>
        <button type="button" onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen}
          className="ml-auto flex min-h-11 items-center gap-2 rounded-lg border border-kds-border px-3 text-sm font-semibold text-kds-text min-[900px]:hidden">
          <List size={16} aria-hidden="true" />Reports
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className={`${listOpen ? 'block' : 'hidden'} w-full shrink-0 border-r border-kds-border bg-kds-card min-[900px]:block min-[900px]:w-72`}>{list}</aside>
        <section className={`${listOpen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col min-[900px]:flex`} aria-label="Report">
          {!report ? (
            <p className="p-6 text-sm text-kds-subtext">{catalogQ.isLoading ? 'Loading…' : 'Pick a report.'}</p>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-4">
                <div className="flex items-center gap-3">
                  <BarChart3 size={22} aria-hidden="true" className="text-kds-green" />
                  <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-kds-text">{report.title}</h2>
                  <button type="button" aria-label={favs.includes(report.id) ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={favs.includes(report.id)} onClick={() => toggleFav(report.id)}
                    className={`flex h-11 w-11 items-center justify-center ${favs.includes(report.id) ? 'text-kds-green' : 'text-kds-subtext'}`}>
                    <Star size={20} aria-hidden="true" fill={favs.includes(report.id) ? 'currentColor' : 'none'} />
                  </button>
                </div>

                {result ? (
                  <div className="mt-3">
                    <button type="button" onClick={() => setResult(null)} className="flex min-h-11 items-center gap-2 text-sm font-semibold text-kds-green"><ArrowLeft size={16} aria-hidden="true" />Back to filters</button>
                    {result.printedBy && <p className="text-sm text-kds-subtext">Printed By : {result.printedBy} at {result.printedAt}</p>}
                    <p className="text-sm text-kds-subtext">Date: {result.period.replace(' to ', ' To ')}; Outlet: {result.outlets.join(', ')}</p>
                    {result.sections.length === 0 && <p className="mt-4 text-sm text-kds-subtext">Nothing in these dates.</p>}
                    {result.sections.map((s, si) => (
                      <div key={si} className="mt-4">
                        {s.title && <h3 className="mb-1 text-sm font-bold text-kds-text">{s.title}</h3>}
                        <div className="overflow-x-auto rounded-xl border border-kds-border">
                          <table className="w-full min-w-[32rem] text-sm">
                            {s.columns.some((c) => c.label) && <thead className="bg-kds-card text-left text-xs uppercase tracking-wider text-kds-subtext">
                              <tr>{s.columns.map((c) => <th key={c.key} scope="col" className={`px-3 py-2 font-semibold ${c.type !== 'text' ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
                            </thead>}
                            <tbody>
                              {s.rows.length === 0 && <tr><td colSpan={s.columns.length} className="px-3 py-6 text-center text-kds-subtext">No rows.</td></tr>}
                              {s.rows.map((row, i) => (
                                <tr key={i} className="border-t border-kds-border text-kds-text">
                                  {s.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${c.type !== 'text' ? 'text-right font-mono' : ''}`}>{showCell(c, row[c.key], currency)}</td>)}
                                </tr>
                              ))}
                              {s.totals && (
                                <tr className="border-t-2 border-kds-border font-bold text-kds-text">
                                  {s.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${c.type !== 'text' ? 'text-right font-mono' : ''}`}>{s.totals![c.key] == null ? '' : showCell(c, s.totals![c.key], currency)}</td>)}
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                    {result.notes.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-kds-subtext">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                  </div>
                ) : (
                  <>
                    <h3 className="mt-4 text-xs font-bold uppercase tracking-wider text-kds-subtext">Mandatory Fields</h3>
                    <div className="mt-2 grid gap-3 md:grid-cols-3">
                      <div>
                        <span className={labelCls}>Date *</span>
                        <div className="flex items-center gap-2">
                          <input type="date" aria-label="From date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
                          <span aria-hidden="true" className="text-kds-subtext">–</span>
                          <input type="date" aria-label="To date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                        </div>
                      </div>
                      <MultiPick label="Outlet" required allLabel="Pick an outlet" options={outletList.map((o) => ({ id: o.id, label: o.name }))}
                        value={selectedOutlets} onChange={(v) => setOutlets(v)} />
                      {report.groupBy && (
                        <div>
                          <label className={labelCls} htmlFor="tr-groupby">Select Payment *</label>
                          <Select id="tr-groupby" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupByKey)} className={inputCls}>
                            {report.groupBy.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
                          </Select>
                        </div>
                      )}
                    </div>
                    {selectedOutlets.length === 0 && <div className="mt-2"><ErrorLine text="Pick at least one outlet." /></div>}

                    {report.filters.length > 0 && (
                      <>
                        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-kds-subtext">Filter Options</h3>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2 min-[1100px]:grid-cols-3">
                          {report.filters.map((k) => {
                            if (k === 'q') return (
                              <div key={k}>
                                <label className={labelCls} htmlFor="tr-q">{FILTER_LABEL[k]}</label>
                                <input id="tr-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Order no, receipt no or guest" className={inputCls} />
                              </div>
                            )
                            if (k === 'paymentType') return (
                              <div key={k}>
                                <label className={labelCls} htmlFor="tr-ptype">{FILTER_LABEL[k]}</label>
                                <Select id="tr-ptype" value={filters.paymentType?.[0] ?? ''} onChange={(e) => setFilter('paymentType', e.target.value ? [e.target.value] : [])} className={inputCls}>
                                  <option value="">All</option><option value="sale">Sale</option><option value="refund">Refund</option>
                                </Select>
                              </div>
                            )
                            return <MultiPick key={k} label={FILTER_LABEL[k]} options={optionsFor(k, lookups)} value={filters[k] ?? []} onChange={(v) => setFilter(k, v)} />
                          })}
                        </div>
                        {lookupQ.isError && <div className="mt-2"><ErrorLine text={flowErrorMessage(lookupQ.error)} /></div>}
                      </>
                    )}

                    {report.options.length > 0 && (
                      <div className="mt-4 grid gap-1 sm:grid-cols-2 min-[1100px]:grid-cols-3" role="group" aria-label="Options">
                        {report.options.map((o) => (
                          <label key={o} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-kds-text">
                            <input type="checkbox" checked={opts.includes(o)} onChange={() => toggleOpt(o)} className="h-5 w-5 accent-kds-green" />{OPTION_LABEL[o]}
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-kds-border bg-kds-card p-3">
                <div className="min-w-0 flex-1"><ErrorLine text={err} /></div>
                {report.printable && (
                  <button type="button" onClick={() => void print()} disabled={!result} className={`${ghostBtn} flex items-center gap-2`}><Printer size={16} aria-hidden="true" />Print</button>
                )}
                <button type="button" onClick={() => void run()} disabled={!valid || busy} className={primaryBtn}>{busy ? 'Running…' : 'Report'}</button>
                <div ref={dlRef} className="relative">
                  <button type="button" aria-haspopup="menu" aria-expanded={dlOpen} disabled={!valid} onClick={() => setDlOpen((o) => !o)} className={`${ghostBtn} flex items-center gap-2`}>
                    <Download size={16} aria-hidden="true" />Download<ChevronDown size={14} aria-hidden="true" />
                  </button>
                  {dlOpen && (
                    <div role="menu" className="absolute bottom-full right-0 z-30 mb-1 min-w-[10rem] rounded-lg border border-kds-border bg-kds-card py-1 shadow-lg">
                      {([['pdf', 'PDF'], ['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']] as const).map(([f, l]) => (
                        <button key={f} type="button" role="menuitem" onClick={() => void download(f)} className="block min-h-11 w-full px-4 text-left text-sm text-kds-text hover:bg-kds-border/40">{l}</button>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => resetForm(report)} className={`${ghostBtn} flex items-center gap-2`}><RotateCcw size={16} aria-hidden="true" />Reset</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
