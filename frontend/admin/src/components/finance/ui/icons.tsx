'use client'
// Finance's line icons (ERP-7/12): lucide, currentColor, never an emoji.
// ✓ / ✕ / ⚠ used as status marks are these too.
import {
  X, Check, TriangleAlert, Star, Zap, Armchair, Calendar, Gift, Bike, Banknote, BarChart3, Users, Undo2,
  Package, Utensils, Ruler, Factory, TrendingUp, Building2, Megaphone, Shield, Sparkles, Wrench, Landmark,
  Scale, FileText, Laptop, Palette, HardHat, Hammer, ChefHat, Globe, Mail, MessageCircle, Smartphone,
  ClipboardList, Link2, Send, Lightbulb, Inbox, PartyPopper, Leaf, Sun, CloudRain, Snowflake, Moon, Puzzle,
  Tag, Wheat, CupSoda, Egg, Salad, Drumstick, SprayCan, Briefcase, Coins, Layers,
  type LucideIcon,
} from 'lucide-react'

const ICONS = {
  x: X, check: Check, warn: TriangleAlert, star: Star, bolt: Zap, seat: Armchair, calendar: Calendar, gift: Gift,
  bike: Bike, cash: Banknote, chart: BarChart3, users: Users, undo: Undo2, box: Package, plate: Utensils,
  ruler: Ruler, factory: Factory, trend: TrendingUp, building: Building2, megaphone: Megaphone, shield: Shield,
  sparkles: Sparkles, wrench: Wrench, bank: Landmark, scale: Scale, doc: FileText, laptop: Laptop, palette: Palette,
  civil: HardHat, tools: Hammer, chef: ChefHat, globe: Globe, mail: Mail, chat: MessageCircle, phone: Smartphone,
  clipboard: ClipboardList, link: Link2, send: Send, idea: Lightbulb, inbox: Inbox, party: PartyPopper,
  spring: Leaf, summer: Sun, rain: CloudRain, winter: Snowflake, night: Moon, puzzle: Puzzle, tag: Tag,
  grain: Wheat, drink: CupSoda, egg: Egg, produce: Salad, meat: Drumstick, clean: SprayCan, briefcase: Briefcase,
  coins: Coins, layers: Layers,
} satisfies Record<string, LucideIcon>

export type FIconName = keyof typeof ICONS

export function FIcon({ name, size = 16, className = '' }: { name: FIconName; size?: number; className?: string }) {
  const Icon = ICONS[name]
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={`inline-block shrink-0 align-[-0.15em] ${className}`.trim()} />
}

/** An OpEx category's line icon, picked from its name (replaces the typed emoji). */
export function categoryIcon(name: string): FIconName {
  const n = name.toLowerCase()
  const rules: Array<[RegExp, FIconName]> = [
    [/rent|lease/, 'building'], [/payroll|salar|staff|wage/, 'users'], [/util|electric|power|gas|water/, 'bolt'],
    [/software|saas|subscription|it\b/, 'laptop'], [/market|advert|promo/, 'megaphone'], [/insur/, 'shield'],
    [/clean|janitor|hygiene/, 'clean'], [/maint|repair/, 'wrench'], [/bank|fee/, 'bank'], [/profession|legal|audit|consult/, 'scale'],
    [/licen|permit/, 'doc'], [/loan|debt|interest/, 'coins'],
  ]
  for (const [rx, ic] of rules) if (rx.test(n)) return ic
  return 'tag'
}
