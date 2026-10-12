'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { canOpenPath } from '../../lib/moduleCatalog'

// ─── Configuration Hub ────────────────────────────────────────────────────────
//
// A single, polished "control panel" landing page that surfaces every
// configurable area in the platform. Each tile shows a configured/setup-needed
// pill so the operator can see at a glance what's still left to wire up.

interface Concept { id: string; name: string; isActive: boolean }
interface Station { id: string; name: string }
interface User    { id: string; name: string; isActive: boolean }
interface SupplierLite { id: string }

type Status = 'ready' | 'incomplete' | 'optional' | 'unknown'

interface Tile {
  href: string
  icon: string
  title: string
  desc: string
  category: 'core' | 'channels' | 'finance' | 'operations' | 'platform'
  status: Status
  hint?: string
}

const STATUS_PILL: Record<Status, { label: string; bg: string; fg: string }> = {
  ready:      { label: 'Ready',         bg: 'rgb(var(--erp-accent-rgb) / 0.2)',  fg: 'var(--erp-success)' },
  incomplete: { label: 'Needs setup',   bg: 'rgba(245,158,11,0.12)', fg: 'var(--erp-warning)' },
  optional:   { label: 'Optional',      bg: 'rgb(var(--fg-rgb) / 0.06)', fg: 'rgb(var(--fg-rgb) / 0.55)' },
  unknown:    { label: '—',             bg: 'rgb(var(--fg-rgb) / 0.04)', fg: 'rgb(var(--fg-rgb) / 0.35)' },
}

const CATEGORY_META = {
  core:       { label: 'Core setup',     desc: 'Brands, kitchens, and the people who run them' },
  channels:   { label: 'Sales channels', desc: 'Where customers reach you' },
  finance:    { label: 'Finance & tax',  desc: 'Money in, money out, compliance' },
  operations: { label: 'Operations',     desc: 'Kitchen floor, scheduling, hardware' },
  platform:   { label: 'Platform',       desc: 'Integrations, language, security' },
}

export default function ConfigurationHubPage() {
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })
  const { data: stations = [] } = useQuery<Station[]>({
    queryKey: ['stations'],
    queryFn: () => api.get('/stations'),
  })
  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/auth/users'),
  })
  const { data: suppliers = [] } = useQuery<SupplierLite[]>({
    queryKey: ['procurement-suppliers'],
    queryFn: () => api.get('/procurement/suppliers'),
  })

  const conceptsReady  = concepts.length > 0 && concepts.some((c) => c.isActive)
  const stationsReady  = stations.length > 0
  const staffReady     = users.length > 1
  const suppliersReady = suppliers.length > 0

  const tiles: Tile[] = [
    // ── Core ──────────────────────────────────────────────────────────────
    { href: '/marketing/brands',  icon: '🏷', title: 'Brands',
      desc: 'The one brand editor — identity, contact, brief, storefront copy, cash / card GST, tax registration.',
      category: 'core', status: conceptsReady ? 'ready' : 'incomplete',
      hint: conceptsReady ? `${concepts.length} concepts configured` : 'Add at least one concept' },

    { href: '/kds/config',  icon: '🍳', title: 'Kitchen Stations',
      desc: 'Stations that show up on KDS — grill, fryer, expediter.',
      category: 'core', status: stationsReady ? 'ready' : 'incomplete',
      hint: stationsReady ? `${stations.length} stations` : 'Define your kitchen layout' },

    { href: '/workforce',  icon: '👥', title: 'Staff & Roles',
      desc: 'Accounts, companies, override PINs, pending signups.',
      category: 'core', status: staffReady ? 'ready' : 'incomplete',
      hint: staffReady ? `${users.length} users` : 'Add team members' },

    { href: '/configuration/locations',  icon: '📍', title: 'Locations',
      desc: 'Physical kitchens: the address and map pin customers see, the delivery origin and the clock-in anchor. One kitchen can run many brands.',
      category: 'core', status: 'incomplete', hint: 'Set up locations to filter accounting per branch' },

    { href: '/configuration/domains',  icon: '🌐', title: 'Custom Domains',
      desc: 'Point your own URLs (e.g. order.yourbrand.pk) to brand storefronts.',
      category: 'channels', status: 'optional', hint: 'DNS-verified, SSL automatic' },

    { href: '/configuration/role-modules',  icon: '🔒', title: 'Module Access',
      desc: 'Which areas each role can open — enforced by the API.',
      category: 'core', status: 'ready', hint: 'Per-role defaults, CEO-editable' },

    { href: '/configuration/operations',  icon: '📍', title: 'Clock-in geofence',
      desc: 'Force on-site clock-in for floor staff (anchored on each location\'s map pin).',
      category: 'core', status: 'optional', hint: 'Optional but recommended' },

    { href: '/menu',  icon: '📝', title: 'Menu & Pricing',
      desc: 'Items, modifiers, allergens, photos, instructions.',
      category: 'core', status: 'unknown' },

    { href: '/scheduling',  icon: '📅', title: 'Shift Schedule',
      desc: 'Weekly roster — who works which shift.',
      category: 'core', status: 'unknown' },

    // ── Channels ──────────────────────────────────────────────────────────
    { href: '/storefront',  icon: '🛍', title: 'Online Storefront',
      desc: 'Library, pages (landing hero, brand pages, brand footers and social links), pop-ups and approvals.',
      category: 'channels', status: 'unknown' },

    // One tile for Dev → API: the WhatsApp gateway and the POS connector
    // (fiscal POS for FBR / SRB + the card machine). Replaces the separate
    // "WhatsApp" and "Tax Rates & FBR" tiles.
    { href: '/connectors',  icon: '⇄', title: 'API connectors',
      desc: 'The WhatsApp gateway (codes, resets, customer messages) and the POS connector — the fiscal POS that files FBR / SRB, and the card machine.',
      category: 'platform', status: 'unknown' },

    { href: '/qrcodes',  icon: '📱', title: 'QR Codes / Table Ordering',
      desc: 'Per-table scan-to-order links.',
      category: 'channels', status: 'optional' },

    // ── Finance ───────────────────────────────────────────────────────────
    { href: '/configuration/payment-methods',  icon: '💳', title: 'Payment Methods',
      desc: 'Cash, Keenu, JazzCash, EasyPaisa toggles + processing fees.',
      category: 'finance', status: 'incomplete' },

    { href: '/procurement',  icon: '🏭', title: 'Suppliers & Vendors',
      desc: 'Vendor list, payment terms, lead times, opening balances.',
      category: 'finance', status: suppliersReady ? 'ready' : 'incomplete',
      hint: suppliersReady ? `${suppliers.length} suppliers` : 'Add your first supplier' },

    { href: '/configuration/loyalty',  icon: '⭐', title: 'Loyalty Program',
      desc: 'Earn rate, redemption rate, expiry, tiers.',
      category: 'finance', status: 'incomplete' },

    // ── Operations ────────────────────────────────────────────────────────
    { href: '/configuration/hours',  icon: '🕒', title: 'Hours of Operation',
      desc: 'Per-brand open / close windows (split service supported). Closures live in Reservations → Closures.',
      category: 'operations', status: 'incomplete' },

    { href: '/inventory',  icon: '📦', title: 'Inventory & Reorder',
      desc: 'Par levels, reorder points, suppliers per item.',
      category: 'operations', status: 'unknown' },

    { href: '/configuration/email',  icon: '✉️', title: 'Email',
      desc: 'SMTP for every email servd sends — the backup channel for codes and password resets when WhatsApp is down.',
      category: 'channels', status: 'unknown' },

    // ── Platform ──────────────────────────────────────────────────────────
    { href: '/settings/integrations',  icon: '🔌', title: 'Integrations',
      desc: 'Meta (Facebook + Instagram), email, webhooks, the supplier portal. WhatsApp and the POS connector are in API connectors.',
      category: 'platform', status: 'incomplete', hint: 'Most are optional' },

    // B07: API tokens tile removed — no third-party integrations need them in v1.

    { href: '/help',  icon: '❓', title: 'Help & Support',
      desc: 'FAQ, WhatsApp support, email, docs.',
      category: 'platform', status: 'ready', hint: 'WhatsApp reply within 1h business hours' },

    { href: '/configuration/language',  icon: '🌐', title: 'Language & Localisation',
      desc: 'English / اردو for this browser.',
      category: 'platform', status: 'ready', hint: 'Bilingual KDS active' },

    { href: '/configuration/audit-log',  icon: '📜', title: 'Audit Log',
      desc: 'Who did what, when — compliance + investigations.',
      category: 'platform', status: 'optional' },

    // ── Newly shipped (18 setup gaps) ─────────────────────────────────────
    { href: '/configuration/modifiers', icon: '🍔', title: 'Modifier templates',
      desc: 'Reusable option groups (sauces, sizes, spice level) attached to menu items.',
      category: 'core', status: 'incomplete', hint: 'Define once, attach in menu editor' },

    { href: '/configuration/refund-policy', icon: '⚖️', title: 'Refund / void / comp policy',
      desc: 'Per-role caps. Manager override above threshold.',
      category: 'finance', status: 'ready', hint: 'Defaults active — review limits' },

    { href: '/configuration/operations', icon: '⚙️', title: 'Service charge & tip pool',
      desc: 'Service fee %, tip pool distribution, invoice numbering, withholding tax.',
      category: 'finance', status: 'incomplete', hint: 'Configure platform-wide ops rules' },

    { href: '/configuration/delivery-zones', icon: '🛵', title: 'Delivery zones',
      desc: 'Radius bands with per-zone fees, minimum order, free-above thresholds. Beyond the last zone, delivery is refused.',
      category: 'channels', status: 'incomplete' },

    { href: '/configuration/receipts', icon: '🧾', title: 'Receipt + cash drawer',
      desc: 'Header/footer, paper width, ESC/POS printer IP, drawer kick, variance limit.',
      category: 'operations', status: 'incomplete', hint: 'Replaces the basic Printer config' },

    { href: '/configuration/kds-devices', icon: '📺', title: 'KDS device registry',
      desc: 'Register each kitchen tablet/TV — bind to station + concept, monitor connectivity.',
      category: 'operations', status: 'incomplete' },

    { href: '/configuration/templates', icon: '✉️', title: 'Email / SMS / WhatsApp templates',
      desc: 'Edit the actual text customers receive. Per-concept + per-language overrides.',
      category: 'operations', status: 'incomplete' },

    { href: '/configuration/bank-accounts', icon: '🏦', title: 'Bank accounts',
      desc: 'Operating accounts for reconciliation against card payouts and rider COD handoffs.',
      category: 'finance', status: 'incomplete' },

    { href: '/configuration/reservation-policy', icon: '📅', title: 'Reservation policy',
      desc: 'Deposits, no-show buffer, advance windows, party caps, walk-in handling.',
      category: 'operations', status: 'ready', hint: 'Defaults active' },

    { href: '/configuration/chart-of-accounts', icon: '📒', title: 'Chart of accounts',
      desc: 'Add/edit ledger codes to mirror your accountant\'s tree.',
      category: 'finance', status: 'ready' },

    { href: '/configuration/webhooks', icon: '🪝', title: 'Outbound webhooks',
      desc: 'Push order events to your accountant\'s software, BI tool, or Slack bot. HMAC-signed, with a test ping and delivery log.',
      category: 'platform', status: 'optional' },

    { href: '/configuration/custom-fields', icon: '🧩', title: 'Custom fields',
      desc: 'Add fields to customers, orders, items, suppliers — without touching code.',
      category: 'platform', status: 'optional' },

    { href: '/configuration/scheduled-reports', icon: '📊', title: 'Scheduled reports',
      desc: 'Daily/weekly digests delivered to your inbox. P&L, low stock, AP aging.',
      category: 'platform', status: 'optional' },

    { href: '/configuration/dietary-tags', icon: '🥗', title: 'Dietary tags & allergens',
      desc: 'Taxonomy your menu items pick from — Vegan, Halal, Gluten-free, etc.',
      category: 'core', status: 'incomplete', hint: 'Defaults included; edit to match your menu' },

    { href: '/reservations/blockouts', icon: '📅', title: 'Holidays & closures',
      desc: 'Block out dates the brand is closed or running reduced capacity.',
      category: 'operations', status: 'optional' },
  ]

  // Only the tiles this login can open (UI-15): the same module test as the
  // sidebar and the page guard (lib/moduleCatalog.ts canOpenPath). Email is a
  // Dev → API page (CONNECTOR_ADMINS: admin, it), so management and the
  // co-owner no longer see a tile that answers 403; Module Access is the
  // CEO's. Nothing shows until GET /permissions/me answers.
  const { data: me } = usePermissions()
  const visible = me ? tiles.filter((t) => canOpenPath(t.href, me.role, me.modules ?? [])) : []

  // ── Counts for the header summary ──────────────────────────────────────
  const totalCount = visible.length
  const readyCount = visible.filter((t) => t.status === 'ready').length
  const incompleteCount = visible.filter((t) => t.status === 'incomplete').length
  const setupPct = totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <div className="flex items-start justify-between gap-6 max-w-[1200px] mx-auto">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-success">Setup</p>
            <h1 className="text-2xl font-black text-white/90 mt-1">Configuration Hub</h1>
            <p className="text-sm text-white/40 mt-1.5">
              One place to wire up brands, channels, finance, kitchen, and the platform itself.
            </p>
          </div>

          {/* Setup progress card */}
          <div className="rounded-2xl p-4 min-w-[220px]"
            style={{
              background: 'linear-gradient(135deg, rgb(var(--erp-accent-rgb) / 0.16), rgb(var(--erp-accent-rgb) / 0.04))',
              border: '1px solid rgb(var(--erp-accent-rgb) / 0.45)',
            }}>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/40">Setup progress</p>
            <p className="text-3xl font-black mt-1" style={{ color: 'var(--erp-success)' }}>{setupPct}%</p>
            <div className="h-1.5 rounded-full mt-2 overflow-hidden bg-white/5">
              <div className="h-full" style={{ width: `${setupPct}%`, background: 'var(--erp-accent)' }} />
            </div>
            <p className="text-[11px] text-white/40 mt-2">
              {readyCount} ready · {incompleteCount} pending
            </p>
          </div>
        </div>
      </header>

      {/* Categories */}
      <div className="px-7 py-7 space-y-9 max-w-[1200px] mx-auto">
        {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map((cat) => {
          const catTiles = visible.filter((t) => t.category === cat)
          if (catTiles.length === 0) return null
          const meta = CATEGORY_META[cat]
          return (
            <section key={cat}>
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/65">{meta.label}</h2>
                  <p className="text-xs text-white/35 mt-0.5">{meta.desc}</p>
                </div>
                <span className="text-[10px] text-white/25 font-mono">{catTiles.length} sections</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {catTiles.map((tile) => (
                  <ConfigTile key={tile.href + tile.title} tile={tile} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function ConfigTile({ tile }: { tile: Tile }) {
  const pill = STATUS_PILL[tile.status]
  return (
    <Link
      href={tile.href}
      className="group relative rounded-2xl p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background: 'rgb(var(--fg-rgb) / 0.02)',
        border: '1px solid rgb(var(--fg-rgb) / 0.06)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgb(var(--erp-accent-rgb) / 0.55)'; e.currentTarget.style.background = 'rgb(var(--erp-accent-rgb) / 0.05)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgb(var(--fg-rgb) / 0.06)'; e.currentTarget.style.background = 'rgb(var(--fg-rgb) / 0.02)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <span className="text-2xl shrink-0">{tile.icon}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider"
          style={{ background: pill.bg, color: pill.fg }}
        >
          {pill.label}
        </span>
      </div>
      <p className="font-bold text-sm text-white/85">{tile.title}</p>
      <p className="text-xs text-white/45 mt-1 leading-relaxed">{tile.desc}</p>
      {tile.hint && (
        <p className="text-[11px] text-white/30 mt-2 italic">{tile.hint}</p>
      )}
      <div className="mt-3 text-[11px] font-bold text-white/40 group-hover:text-primary-ink transition-colors">
        Configure →
      </div>
    </Link>
  )
}
