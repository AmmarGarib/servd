// The rate-limit exemption for the storefront's own server-side calls
// (lib/internalRequest.ts) must never cover anything that came through a
// proxy or carries a client-supplied forwarding header.
import { describe, it, expect } from 'vitest'
import { isInternalRequest, isPrivateAddress } from '../src/lib/internalRequest.js'

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } })

describe('isPrivateAddress', () => {
  it('accepts loopback, RFC 1918 and unique-local, incl. IPv4-mapped', () => {
    for (const ip of ['127.0.0.1', '::1', '10.0.3.7', '172.16.0.2', '172.31.255.1', '192.168.1.20', '::ffff:172.18.0.5', 'fd12:3456::1', 'fc00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('rejects public and look-alike addresses', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '2606:4700::1', '', undefined]) {
      expect(isPrivateAddress(ip as string), String(ip)).toBe(false)
    }
  })
})

describe('isInternalRequest', () => {
  it('is true for a private-network call with no forwarding headers (the storefront SSR)', () => {
    expect(isInternalRequest(req('172.18.0.4'))).toBe(true)
  })
  it('is false for anything that came through the tunnel / a proxy', () => {
    expect(isInternalRequest(req('172.18.0.9', { 'cf-connecting-ip': '39.40.1.2' }))).toBe(false)
    expect(isInternalRequest(req('172.18.0.9', { 'x-forwarded-for': '39.40.1.2' }))).toBe(false)
    expect(isInternalRequest(req('127.0.0.1', { forwarded: 'for=39.40.1.2' }))).toBe(false)
    expect(isInternalRequest(req('10.0.0.5', { 'x-real-ip': '39.40.1.2' }))).toBe(false)
  })
  it('is false for a public socket address even without headers', () => {
    expect(isInternalRequest(req('39.40.1.2'))).toBe(false)
  })
})
