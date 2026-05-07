// Notification template renderer.
// Looks up a NotificationTemplate by (event, channel, language, conceptId)
// from the DB. Falls back to global default for the same event/channel/language.
// Substitutes {{var}} placeholders in subject + body.
//
// Used as an override layer in front of hardcoded notify.ts copy: if a template
// exists for the (event, channel, language) tuple, it wins; otherwise the
// caller's default copy is used.

import { prisma } from './prisma.js'

export interface RenderedTemplate {
  subject: string | null
  body: string
}

export type TemplateChannel = 'email' | 'sms' | 'whatsapp' | 'push'

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: RenderedTemplate | null; expiresAt: number }>()

function cacheKey(event: string, channel: string, language: string, conceptId: string | null): string {
  return `${event}:${channel}:${language}:${conceptId ?? 'global'}`
}

export function invalidateTemplateCache(): void { cache.clear() }

/**
 * Render a template by (event, channel, language). Checks for a concept-scoped
 * template first, falls back to global. Returns null if no template found —
 * caller should then use its hardcoded default.
 */
export async function renderTemplate(opts: {
  event: string
  channel: TemplateChannel
  language?: 'en' | 'ur'
  conceptId?: string | null
  vars: Record<string, string | number | undefined | null>
}): Promise<RenderedTemplate | null> {
  const language = opts.language ?? 'en'
  const conceptId = opts.conceptId ?? null
  const key = cacheKey(opts.event, opts.channel, language, conceptId)
  const cached = cache.get(key)
  let template = cached && cached.expiresAt > Date.now() ? cached.value : null

  if (!cached || cached.expiresAt <= Date.now()) {
    // Try concept-scoped first, then global.
    template =
      (conceptId
        ? await prisma.notificationTemplate.findFirst({
            where: { conceptId, channel: opts.channel, event: opts.event, language, isActive: true },
          })
        : null) ??
      (await prisma.notificationTemplate.findFirst({
        where: { conceptId: null, channel: opts.channel, event: opts.event, language, isActive: true },
      }))
    cache.set(key, { value: template ? { subject: template.subject, body: template.body } : null, expiresAt: Date.now() + CACHE_TTL_MS })
  }

  if (!template) return null

  return {
    subject: template.subject ? interpolate(template.subject, opts.vars) : null,
    body: interpolate(template.body, opts.vars),
  }
}

function interpolate(text: string, vars: Record<string, string | number | undefined | null>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const v = vars[key]
    if (v == null) return ''
    return String(v)
  })
}
