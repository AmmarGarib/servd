// Facebook / Instagram page connection PER BRAND (owner C18, 2026-10-26:
// "Approval goes thru me, marketing can connect").
//
//  - A brand (Concept) has at most ONE approved and ONE pending connection
//    (partial unique indexes social_connections_one_approved / _one_pending).
//    The row's tenantId is the BRAND's company.
//  - Marketing (MARKETING_TEAM holding `calendar` or `brands`) connects a
//    brand's page through Meta OAuth → a `pending` row. Nothing posts with it.
//    The CEO approves it in the approvals inbox (type social_connection, CEO
//    only, never handed over) → `approved`, and the brand's previous approved
//    row → `superseded`. Until then the previous approved one keeps posting.
//    A CEO's own connect is the approval (applied at once, audited).
//  - The page token is sealed with lib/secretBox.ts like the WhatsApp key and
//    the SMTP password: encrypted when SERVD_SECRET_KEY is set, plain
//    otherwise (saving is never blocked), and a plain one is encrypted on the
//    next read once the key exists. /health `socialTokensAtRest`. Responses
//    carry `tokenHint` only — never the token.
//  - The OLD global connection (settings fb_page_id / fb_page_name /
//    fb_page_token / ig_user_id) is moved ONCE at boot
//    (migrateLegacySocialConnection): it cannot be tied to a brand by guessing,
//    so it becomes a `legacy` row used for nobody (posts with it stop) and the
//    CEO is told in the bell to reconnect each brand — EXCEPT when servd has
//    exactly ONE live brand (not deleted, active, not a test company): then it
//    becomes that brand's PENDING connection, so the CEO only has to approve it
//    (nothing posts before that approval either).

import { serviceClient } from '../../lib/prisma.js'
import { decryptSecret, encryptSecret, isEncrypted, secretHint, secretKeyConfigured } from '../../lib/secretBox.js'
import { notifyStaffMany } from '../../lib/staffNotify.js'
import { audit } from '../../lib/audit.js'
import type { SocialPage } from '../../lib/meta-social.js'

export const LEGACY_SETTING_KEYS = ['fb_page_id', 'fb_page_name', 'fb_page_token', 'ig_user_id'] as const

export type TokenAtRest = 'encrypted' | 'plaintext' | 'unreadable'

/** The stored value for a new token: encrypted when SERVD_SECRET_KEY is set, else as given — never refused. */
export function sealToken(plain: string): { value: string; hint: string; atRest: TokenAtRest } {
  const hint = secretHint(plain)
  if (!secretKeyConfigured()) return { value: plain, hint, atRest: 'plaintext' }
  return { value: encryptSecret(plain), hint, atRest: 'encrypted' }
}

/**
 * The usable token of a row, encrypting a plain one when the key is available
 * (conditional on the value read, so a reconnect made meanwhile is never
 * overwritten). Never throws: an unreadable token is null.
 */
export async function readToken(row: { id: string; token: string }): Promise<{ plain: string | null; atRest: TokenAtRest }> {
  if (isEncrypted(row.token)) {
    try { return { plain: decryptSecret(row.token), atRest: 'encrypted' } } catch { return { plain: null, atRest: 'unreadable' } }
  }
  if (!secretKeyConfigured()) return { plain: row.token, atRest: 'plaintext' }
  try {
    await serviceClient.socialConnection.updateMany({ where: { id: row.id, token: row.token }, data: { token: encryptSecret(row.token) } })
    return { plain: row.token, atRest: 'encrypted' }
  } catch {
    return { plain: row.token, atRest: 'plaintext' }
  }
}

/** The brand's APPROVED page, or null. The only connection anything posts with. */
export async function approvedConnectionFor(conceptId: string | null | undefined): Promise<SocialPage | null> {
  if (!conceptId) return null
  const row = await serviceClient.socialConnection.findFirst({
    where: { conceptId, status: 'approved' },
    select: { id: true, token: true, pageId: true, igUserId: true },
  })
  if (!row) return null
  const t = await readToken(row)
  return t.plain ? { pageId: row.pageId, igUserId: row.igUserId, token: t.plain } : null
}

/** A row as screens and the inbox see it: no token, its hint only. */
export function connectionView<R extends { token?: string } & Record<string, unknown>>(row: R): Omit<R, 'token'> {
  const { token: _t, ...rest } = row
  return rest
}

/** /health: how the stored page tokens sit at rest (no names, no counts of brands — counts only). */
export async function socialTokenHealth(): Promise<{ check: 'ok' | 'warn' | 'off'; detail: string }> {
  const rows = await serviceClient.socialConnection.findMany({
    where: { status: { in: ['approved', 'pending', 'legacy'] } },
    select: { token: true },
  })
  if (rows.length === 0) return { check: 'off', detail: 'No social page connected.' }
  const plain = rows.filter((r) => !isEncrypted(r.token)).length
  const enc = rows.length - plain
  if (plain > 0) return { check: 'warn', detail: `${plain} social page token(s) stored in plain text because SERVD_SECRET_KEY is not set on this server. Set it and they are encrypted on the next read.` }
  if (!secretKeyConfigured()) return { check: 'warn', detail: `${enc} social page token(s) are encrypted but SERVD_SECRET_KEY is missing or wrong on this server, so they cannot be used.` }
  return { check: 'ok', detail: 'Social page tokens are encrypted at rest.' }
}

/**
 * Boot, once: move the old global connection out of `settings`. Idempotent —
 * nothing to do once the token setting is gone. See the header for the rule.
 */
export async function migrateLegacySocialConnection(): Promise<{ moved: 'none' | 'legacy' | 'pending'; conceptId?: string }> {
  const db = serviceClient
  const rows = await db.setting.findMany({ where: { key: { in: [...LEGACY_SETTING_KEYS] } }, select: { key: true, value: true } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const token = map.get('fb_page_token')?.trim()
  const pageId = map.get('fb_page_id')?.trim()
  if (!token || !pageId) {
    // Half a connection never posted; clear the leftovers so the old keys are gone everywhere.
    if (rows.length > 0) await db.setting.deleteMany({ where: { key: { in: [...LEGACY_SETTING_KEYS] } } })
    return { moved: 'none' }
  }
  const live = await db.concept.findMany({
    where: { deletedAt: null, isActive: true, tenantId: { not: null }, NOT: { tenant: { isTest: true } } },
    select: { id: true, tenantId: true, name: true },
  })
  const only = live.length === 1 ? live[0]! : null
  const sealed = sealToken(token)
  const result = await db.$transaction(async (tx) => {
    // Claim: the settings row is deleted in the same transaction, so two booting processes move it once.
    const claimed = await tx.setting.deleteMany({ where: { key: 'fb_page_token', value: map.get('fb_page_token')! } })
    if (claimed.count === 0) return null
    await tx.setting.deleteMany({ where: { key: { in: [...LEGACY_SETTING_KEYS] } } })
    const pendingTaken = only ? await tx.socialConnection.findFirst({ where: { conceptId: only.id, status: 'pending' }, select: { id: true } }) : null
    const asPending = !!only && !pendingTaken
    return tx.socialConnection.create({
      data: {
        tenantId: asPending ? only!.tenantId : null,
        conceptId: asPending ? only!.id : null,
        status: asPending ? 'pending' : 'legacy',
        pageId, pageName: map.get('fb_page_name') ?? null, igUserId: map.get('ig_user_id') ?? null,
        token: sealed.value, tokenHint: sealed.hint,
      },
      select: { id: true, status: true, conceptId: true, tenantId: true, requestedAt: true },
    })
  })
  if (!result) return { moved: 'none' }
  await audit({
    category: 'identity', action: 'social_connection.legacy_moved', entity: 'SocialConnection', entityId: result.id,
    userId: null, userEmail: null, tenantId: result.tenantId,
    metadata: { status: result.status, conceptId: result.conceptId },
  })
  // Tell the CEO (every active admin, in each admin's own company).
  try {
    const admins = await db.user.findMany({
      where: { role: 'admin', isActive: true, accountStatus: 'active', deletedAt: null },
      select: { id: true, tenantId: true },
    })
    await notifyStaffMany(admins.map((a) => ({
      userId: a.id,
      tenantId: result.tenantId ?? a.tenantId,
      kind: 'task.next' as const,
      severity: 'warning' as const,
      title: result.status === 'pending'
        ? `Approve the Facebook / Instagram page for ${only!.name}`
        : 'Reconnect Facebook / Instagram for each brand',
      body: result.status === 'pending'
        ? 'The old servd-wide page connection now belongs to your only live brand. Nothing posts until you approve it in the approvals inbox.'
        : 'Social pages are now connected per brand. The old servd-wide page is kept but used for no brand, so scheduled posts stop until each brand is connected and you approve it.',
      link: result.status === 'pending' ? '/ceo/approvals?type=social_connection' : '/calendar/social',
      entityType: 'SocialConnection', entityId: result.id,
      dedupeKey: `social_connection.legacy:${result.id}`,
    })))
  } catch (err) {
    console.warn('[social] legacy notice failed:', (err as Error).message)
  }
  return { moved: result.status === 'pending' ? 'pending' : 'legacy', ...(result.conceptId ? { conceptId: result.conceptId } : {}) }
}
