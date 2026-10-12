// The admin origins (Admin → Storefront) the storefront talks to: the CORS
// allow-list of /api/storefront-sections, the CSP frame-ancestors of
// /editor-frame and the origins the frame accepts postMessage from. One
// definition, read at RUNTIME (bracket access, so it is never inlined at
// build) — set ADMIN_ORIGINS on the storefront container, comma-separated.
// Edge-safe: no Node APIs (the middleware imports it).

const PRODUCTION_DEFAULT = ['https://admin.servd.pk']
const DEV_DEFAULT = ['https://admin.servd.pk', 'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002']

/** Only a bare http(s) origin: drops '*', paths, credentials, header junk. */
function isOrigin(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === s
  } catch {
    return false
  }
}

/** ADMIN_ORIGINS when set; otherwise admin.servd.pk in production, plus the
 *  localhost dev ports elsewhere. */
export function adminOrigins(): string[] {
  const raw = process.env['ADMIN_ORIGINS']
  const list = raw && raw.trim()
    ? raw.split(',')
    : process.env.NODE_ENV === 'production' ? PRODUCTION_DEFAULT : DEV_DEFAULT
  return [...new Set(list.map((s) => s.trim()).filter(isOrigin))]
}

/** The CSP frame-ancestors source list for /editor-frame. */
export function frameAncestors(): string {
  const list = adminOrigins()
  return list.length ? list.join(' ') : "'none'"
}
