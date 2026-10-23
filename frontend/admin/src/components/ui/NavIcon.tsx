import {
  LayoutDashboard, ClipboardList, BarChart3, Calendar, Users, Settings, Contact, Presentation,
  Armchair, Receipt, Bike, Siren, Car, Rocket, Layers, Bell, Plug, Package, Pencil, Ruler, MapPin,
  TrendingUp, Banknote, CreditCard, Wallet, Tag, Factory, Hammer, Ticket, Percent, Gift, Utensils,
  Flame, Thermometer, Star, CircleHelp, Check, Mail, Scale, PanelTop, Trash2, Home, Circle,
  Globe, Lock, Store, QrCode, Clock, BookOpen, ScrollText, Tv, Puzzle, Webhook, Salad, Landmark,
  MessageCircle, X, TriangleAlert, Send, Inbox, Megaphone, Image, Palette, Building2, User, KeyRound,
  Briefcase, Plus, Eye, Ban, ShieldCheck, Smartphone, ChefHat, Search, Phone, Compass, Printer,
  Monitor, Archive, Minus, ShoppingCart, ShoppingBag, FlaskConical, CircleCheck, Ghost, Lightbulb,
  Sparkles, PartyPopper, SlidersHorizontal, Hand, ThumbsUp, Crown, Facebook, Instagram, MailOpen, Coffee, Flag, Truck, BookText, Zap, Mic, Move, Target,
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
  globe: Globe, lock: Lock, store: Store, qr: QrCode, clock: Clock, book: BookOpen, scroll: ScrollText,
  tv: Tv, puzzle: Puzzle, webhook: Webhook, salad: Salad, bank: Landmark, chat: MessageCircle, x: X,
  warn: TriangleAlert, send: Send, inbox: Inbox, megaphone: Megaphone, image: Image, palette: Palette,
  building: Building2, user: User, key: KeyRound, briefcase: Briefcase, plus: Plus, eye: Eye, ban: Ban,
  shield: ShieldCheck, phone: Smartphone, chef: ChefHat, search: Search, call: Phone, compass: Compass,
  printer: Printer, monitor: Monitor, archive: Archive, minus: Minus, cart: ShoppingCart, bag: ShoppingBag,
  flask: FlaskConical, done: CircleCheck, ghost: Ghost, bulb: Lightbulb, sparkle: Sparkles, party: PartyPopper,
  sliders: SlidersHorizontal, wave: Hand, thumbsup: ThumbsUp, crown: Crown, facebook: Facebook,
  instagram: Instagram, mailopen: MailOpen, flag: Flag, truck: Truck, notes: BookText, zap: Zap, mic: Mic,
  move: Move, target: Target, coffee: Coffee,
  help: CircleHelp, check: Check, mail: Mail, scale: Scale, layout: PanelTop, trash: Trash2, home: Home,
} satisfies Record<string, LucideIcon>

export type NavIconName = keyof typeof ICONS

export function NavIcon({ name, size = 16, className = '' }: { name?: string; size?: number; className?: string }) {
  const Icon: LucideIcon = (name && (ICONS as Record<string, LucideIcon>)[name]) || Circle
  const dot = !name || !(name in ICONS)
  return <Icon size={dot ? 6 : size} strokeWidth={dot ? 2.5 : 1.75} aria-hidden="true" className={`shrink-0 ${className}`} />
}
