// "The servd name" — a customer's nickname (owner, 2026-10-26: "when they hop
// into servd first time after logging in, ask them to pick a nickname/username").
//
// Customers are servd-wide accounts (no tenantId, deliberately), so a nickname
// is unique across servd, case-insensitive: the unique index is on
// lower("nickname") (migration 20261027100000). It is stored as typed.
// The storefront mirrors these rules for instant feedback; this file judges.

import { AppError } from './errors.js'

export const NICKNAME_MIN = 3
export const NICKNAME_MAX = 20

/** Names nobody may take: servd / brand / staff words that would let a customer pass as us. */
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'staff', 'team', 'official',
  'servd', 'servdpk', 'servd.pk', 'servd_pk', 'gsfoods', 'gs_foods', 'gs.foods', 'garibsons',
  'simmer', 'stackd', 'stax', 'flipd', 'gskitchen', 'gs_kitchen',
  'ceo', 'owner', 'manager', 'cashier', 'kitchen', 'chef', 'rider', 'moderator', 'mod',
  'null', 'undefined', 'anonymous', 'guest', 'host', 'me', 'you', 'everyone', 'api', 'www', 'mail', 'info',
])

export type NicknameProblem = 'invalid' | 'reserved'

/** The trimmed nickname, or why it cannot be one. */
export function checkNickname(raw: string): { nickname: string; problem: NicknameProblem | null; message: string | null } {
  const nickname = raw.trim()
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    return { nickname, problem: 'invalid', message: `Use ${NICKNAME_MIN} to ${NICKNAME_MAX} characters.` }
  }
  if (!/^[A-Za-z0-9._]+$/.test(nickname)) {
    return { nickname, problem: 'invalid', message: 'Use letters, numbers, dots and underscores only.' }
  }
  if (!/^[A-Za-z0-9]/.test(nickname) || nickname.endsWith('.') || nickname.includes('..')) {
    return { nickname, problem: 'invalid', message: 'Start with a letter or number, and no dot at the end or two dots in a row.' }
  }
  const key = nickname.toLowerCase()
  // A reserved word, or one dressed up with digits / separators ("servd_1", "simmer.official").
  const bare = key.replace(/[._0-9]/g, '')
  if (RESERVED.has(key) || RESERVED.has(bare) || /^(servd|simmer|stackd|flipd|admin|support)/.test(bare)) {
    return { nickname, problem: 'reserved', message: 'That name is reserved. Pick another.' }
  }
  return { nickname, problem: null, message: null }
}

/** Throws 422 NICKNAME_INVALID for a nickname that breaks the rules. */
export function assertNickname(raw: string): string {
  const c = checkNickname(raw)
  if (c.problem) throw new AppError('NICKNAME_INVALID', c.message ?? 'That name cannot be used.', 422, { reason: c.problem })
  return c.nickname
}
