// Is this request service-to-service traffic from inside our own deployment?
//
// The API publishes no ports: public traffic reaches it only through the
// Cloudflare tunnel (cloudflared on the same Docker network), which stamps
// every request with the visitor's address (CF-Connecting-IP and
// X-Forwarded-For). The storefront's server-side renders call the API
// directly over the private network and carry neither header — so without
// this, every page render on servd.pk and the brand sites shared ONE 200/min
// rate-limit bucket, and a busy minute 429'd the storefront itself (pages fell
// back to their built-in defaults, hiding published editor content).
//
// A request counts as internal only when it has NO forwarding headers AND its
// socket address is loopback or a private range. Anything that came through a
// proxy — ours or a client-supplied header — is public and rate-limited.

import type { FastifyRequest } from 'fastify'

const FORWARDING_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'true-client-ip']

/** Loopback, RFC 1918, IPv6 unique-local, and their IPv4-mapped forms. */
export function isPrivateAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const ip = addr.trim().toLowerCase().replace(/^::ffff:/, '')
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  const m = /^172\.(\d{1,3})\./.exec(ip)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true // fc00::/7
  return false
}

export function isInternalRequest(req: Pick<FastifyRequest, 'headers'> & { socket?: { remoteAddress?: string | undefined } }): boolean {
  for (const h of FORWARDING_HEADERS) if (req.headers[h] !== undefined) return false
  return isPrivateAddress(req.socket?.remoteAddress)
}
