// Office networks (owner, 2026-10-22: "It should happen only when someone
// open servd on Office wifi"). A browser cannot read the Wi-Fi name, so the
// office network is the public internet address every device on the office
// Wi-Fi shares, as the API sees it (req.ip). HR registers it per company
// (HR settings `officeNetworks`); the automatic check-in runs only from one.
// IPv4 matches the exact address; IPv6 matches the /64 network (each device
// on the same Wi-Fi gets its own address inside it).
import { isIP } from 'node:net'

export interface OfficeNetwork { address: string; label: string }

/** The network an address belongs to: the IPv4 address, or the IPv6 /64 prefix. null = not an address. */
export function networkKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  let ip = raw.trim().toLowerCase()
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7)
  const kind = isIP(ip)
  if (kind === 4) return ip
  if (kind !== 6) return null
  // Expand "::" so the first four groups are always there.
  const [head, tail] = ip.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`
}

export function onOfficeNetwork(ip: string | null | undefined, networks: OfficeNetwork[] | null | undefined): boolean {
  const key = networkKey(ip)
  return !!key && (networks ?? []).some((n) => networkKey(n.address) === key)
}
