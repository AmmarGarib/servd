// Typed client for the storefront content module (owner decision 41):
// pages, pop-ups, drafts, approvals, versions and A/B stats, all under
// /site-layouts. Every edit is a draft; only the CEO (role `admin`) approves,
// rejects, rolls back or deletes. Contract: the scratchpad
// content-module-contract.md the backend and renderers are built against.

import { api } from './api'
import { newBlock, newId, type Block } from './blocks'

export const STOREFRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL'] ?? 'https://servd.pk'

// ─── Types ─────────────────────────────────────────────────────────────────

export type LayoutKind = 'page' | 'hero' | 'footer' | 'popup'
export type DraftStatus = 'draft' | 'pending' | 'scheduled'
export type Variant = 'a' | 'b'

export interface PopupRules {
  popupKind: 'signup' | 'login' | 'offer' | 'announcement'
  display: 'modal' | 'bar' | 'corner'
  trigger: 'before_page' | 'after_seconds' | 'exit_intent' | 'scroll'
  delaySeconds?: number
  scrollPct?: number
  pages: string[]
  brands: string[]
  audience: 'everyone' | 'signed_out' | 'signed_in' | 'never_ordered'
  frequency: 'once' | 'daily' | 'every_visit'
  startsAt?: string
  endsAt?: string
}

export interface PageSettings {
  fonts?: { heading?: string; body?: string }
  ab?: { splitPct: number; blocks: Block[] }
  popup?: PopupRules
}

export interface UserRef { id: string; name: string }

/** GET /site-layouts row. */
export interface LayoutSummary {
  id: string
  slug: string
  kind: LayoutKind
  title: string | null
  tenantId: string | null
  draftStatus: DraftStatus | null
  liveVersion: number | null
  publishedAt: string | null
  publishAt: string | null
  submittedAt: string | null
  submittedBy: UserRef | null
  reviewNote: string | null
  updatedAt: string | null
  draftUpdatedAt: string | null
}

/** GET /site-layouts/:slug/edit */
export interface LayoutEdit {
  id?: string
  slug: string
  kind: LayoutKind
  title: string | null
  tenantId: string | null
  blocks: Block[] | null
  settings: PageSettings | null
  draftBlocks: Block[] | null
  draftSettings: PageSettings | null
  draftStatus: DraftStatus | null
  reviewNote: string | null
  publishAt: string | null
  liveVersion: number | null
  publishedAt: string | null
}

export interface LayoutVersion {
  version: number
  publishedAt: string
  publishedBy: UserRef | null
  approvedBy: UserRef | null
  note: string | null
  blocks: Block[]
  settings: PageSettings | null
}

export interface LayoutStat { version: number; variant: Variant; views: number; conversions: number }

/** The slice of a media-library asset the builder needs (fonts). */
export interface MediaAssetLite {
  id: string
  kind: 'image' | 'video' | 'font' | 'copy'
  name: string
  url: string
  fontFamily: string | null
  text: string | null
}

export interface ConceptLite { id: string; name: string; slug: string; tenantId?: string | null }

// ─── API ───────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

export const contentApi = {
  list: (params: { status?: 'pending' | 'draft' | 'scheduled' | 'all'; kind?: LayoutKind } = {}) => {
    const qs = new URLSearchParams({ status: params.status ?? 'all', ...(params.kind ? { kind: params.kind } : {}) })
    return api.get<LayoutSummary[]>(`/site-layouts?${qs.toString()}`)
  },
  edit: (slug: string) => api.get<LayoutEdit>(`/site-layouts/${enc(slug)}/edit`),
  saveDraft: (slug: string, body: { title?: string; kind?: LayoutKind; blocks: Block[]; settings?: PageSettings }) =>
    api.put<LayoutEdit>(`/site-layouts/${enc(slug)}/draft`, body),
  discardDraft: (slug: string) => api.delete<void>(`/site-layouts/${enc(slug)}/draft`),
  submit: (slug: string) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/submit`, {}),
  approve: (slug: string, publishAt?: string) =>
    api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/approve`, publishAt ? { publishAt } : {}),
  reject: (slug: string, note: string) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/reject`, { note }),
  versions: (slug: string) => api.get<LayoutVersion[]>(`/site-layouts/${enc(slug)}/versions`),
  rollback: (slug: string, version: number) => api.post<LayoutEdit>(`/site-layouts/${enc(slug)}/rollback`, { version }),
  stats: (slug: string) => api.get<LayoutStat[]>(`/site-layouts/${enc(slug)}/stats`),
  previewToken: (slug: string) => api.post<{ token: string }>(`/site-layouts/${enc(slug)}/preview-token`, {}),
  remove: (slug: string) => api.delete<void>(`/site-layouts/${enc(slug)}`),
  fonts: () => api.get<MediaAssetLite[]>('/media?kind=font'),
}

export const previewUrl = (token: string) => `${STOREFRONT_URL}/preview/${token}`

// ─── Slug helpers ──────────────────────────────────────────────────────────

export function kindForSlug(slug: string): LayoutKind {
  if (slug === 'servd:hero') return 'hero'
  if (slug.startsWith('popup:')) return 'popup'
  if (slug.startsWith('brand:') && slug.endsWith(':footer')) return 'footer'
  return 'page'
}

/** Where the live page is on the storefront (null for pop-ups / fragments). */
export function storefrontPath(slug: string): string | null {
  if (slug === 'servd:home' || slug === 'servd:hero' || slug === 'servd:home-experience') return '/'
  if (slug.startsWith('page:')) return `/pages/${slug.slice(5)}`
  if (slug.startsWith('brand:')) return `/brand/${slug.slice(6).replace(/:footer$/, '')}`
  return null
}

/** Pages whose storefront route has a bespoke built-in design. */
export function hasSignature(slug: string): boolean {
  return slug === 'servd:home' || (slug.startsWith('brand:') && !slug.endsWith(':footer'))
}

export function newPopupKey(): string {
  return Math.random().toString(36).slice(2, 8)
}

export const DEFAULT_POPUP_RULES = (popupKind: PopupRules['popupKind'] = 'offer'): PopupRules => ({
  popupKind,
  display: 'modal',
  trigger: 'after_seconds',
  delaySeconds: 5,
  pages: [],
  brands: [],
  audience: popupKind === 'signup' || popupKind === 'login' ? 'signed_out' : 'everyone',
  frequency: 'once',
})

/** Starting blocks for a slug with nothing live and no draft. */
export function seedBlocks(slug: string, popupKind?: PopupRules['popupKind']): Block[] {
  const kind = kindForSlug(slug)
  if (kind === 'hero') return [{ ...newBlock('scrollHero'), id: 'hero' }]
  if (kind === 'footer') return [{ ...newBlock('brandFooter'), id: 'footer' }]
  if (kind === 'popup') {
    if (popupKind === 'signup' || popupKind === 'login') {
      return [{ ...newBlock('signup_form'), mode: popupKind, title: popupKind === 'login' ? 'Welcome back' : 'Join servd' }]
    }
    return [{ ...newBlock('text'), body: 'Your offer or announcement.', align: 'center', size: 'lg' }, newBlock('cta_button')]
  }
  if (hasSignature(slug)) return [{ id: newId(), type: 'signature' }]
  if (slug === 'servd:home-experience') return [newBlock('gallery')]
  return [newBlock('hero')]
}

// ─── Status display ────────────────────────────────────────────────────────

export interface StatusInfo { label: string; tone: 'teal' | 'amber' | 'blue' | 'red' | 'muted'; note?: string | null }

export function draftStatusInfo(row: { draftStatus: DraftStatus | null; reviewNote: string | null; publishAt: string | null }): StatusInfo {
  switch (row.draftStatus) {
    case 'pending':   return { label: 'Waiting for CEO', tone: 'amber' }
    case 'scheduled': return { label: `Scheduled for ${row.publishAt ? fmtDateTime(row.publishAt) : 'later'}`, tone: 'blue' }
    case 'draft':     return row.reviewNote
      ? { label: 'Rejected', tone: 'red', note: row.reviewNote }
      : { label: 'Draft', tone: 'muted' }
    default:          return { label: 'No draft', tone: 'teal' }
  }
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** ISO -> value for <input type="datetime-local"> (local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** <input type="datetime-local"> value -> ISO (undefined when blank). */
export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
