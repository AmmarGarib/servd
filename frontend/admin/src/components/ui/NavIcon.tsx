import {
  LayoutDashboard, ClipboardList, BarChart3, Calendar, Users, Settings, Contact, Presentation,
  Armchair, Receipt, Bike, Siren, Car, Rocket, Layers, Bell, Plug, Package, Pencil, Ruler, MapPin,
  TrendingUp, Banknote, CreditCard, Wallet, Tag, Factory, Hammer, Ticket, Percent, Gift, Utensils,
  Flame, Thermometer, Star, CircleHelp, Check, Mail, Scale, PanelTop, Trash2, Home, Circle,
  type LucideIcon,
} from 'lucide-react'

/**
 * The ONE line-icon set for the ERP sidebar (ERP-12, owner 2026-10-16): lucide
 * (already a dependency), 1.75 stroke, `currentColor`. `ModulePage.icon` in
 * lib/moduleCatalog.ts holds one of these names — never an emoji. A page with
 * no icon (or an unknown name) gets a small dot.
 */
const ICONS = {
  dashboard: LayoutDashboard, clipboard: ClipboardList, chart: BarChart3, calendar: Calendar,
  users: Users, cog: Settings, idcard: Contact, sign: Presentation, seat: Armchair, receipt: Receipt,
  bike: Bike, alert: Siren, car: Car, rocket: Rocket, folders: Layers, bell: Bell, plug: Plug,
  box: Package, edit: Pencil, ruler: Ruler, pin: MapPin, trend: TrendingUp, cash: Banknote,
  card: CreditCard, wallet: Wallet, tag: Tag, factory: Factory, hammer: Hammer, ticket: Ticket,
  percent: Percent, gift: Gift, utensils: Utensils, flame: Flame, thermo: Thermometer, star: Star,
  help: CircleHelp, check: Check, mail: Mail, scale: Scale, layout: PanelTop, trash: Trash2, home: Home,
} satisfies Record<string, LucideIcon>

export type NavIconName = keyof typeof ICONS

export function NavIcon({ name, size = 16 }: { name?: string; size?: number }) {
  const Icon: LucideIcon = (name && (ICONS as Record<string, LucideIcon>)[name]) || Circle
  const dot = !name || !(name in ICONS)
  return <Icon size={dot ? 6 : size} strokeWidth={dot ? 2.5 : 1.75} aria-hidden="true" className="shrink-0" />
}
