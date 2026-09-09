// Staff email policy.
//
// Staff accounts must live on the company domain. One helper so the rule is
// enforced identically at creation AND at sign-in — enforcing it only at
// creation would leave every pre-existing row able to sign in, which is not a
// rule, it is a suggestion.
//
// Customers are NOT subject to this. It is staff-only.

/** The one domain staff accounts may use. */
export const STAFF_EMAIL_DOMAIN = 'gsfoods.pk'

/**
 * True when this is a valid staff address on the company domain.
 *
 * Deliberately an EXACT domain match, not a suffix test: `endsWith('gsfoods.pk')`
 * would also accept `evil-gsfoods.pk`, and a naive `includes` would accept
 * `gsfoods.pk.attacker.com`. Splitting on the last '@' and comparing the whole
 * domain is the only form that rejects both.
 */
export function isStaffEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return false
  // No local-part or domain-part whitespace, and exactly one '@'.
  if (/\s/.test(trimmed) || trimmed.indexOf('@') !== at) return false
  return trimmed.slice(at + 1) === STAFF_EMAIL_DOMAIN
}

/** Normalised form to store. Lowercased and trimmed, matching the login lookup. */
export function normaliseStaffEmail(email: string): string {
  return email.trim().toLowerCase()
}

export const STAFF_EMAIL_MESSAGE =
  `Staff accounts must use an @${STAFF_EMAIL_DOMAIN} email address.`
