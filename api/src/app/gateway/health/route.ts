// Gateway's own health — distinct from the legacy /health, which still
// proxies through so existing monitoring keeps watching the real API.
import { hasDatabase } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({
    ok: true,
    service: 'servd-api-gateway (next.js)',
    database: hasDatabase ? 'configured' : 'absent — ported routes fall back to legacy',
    legacy: process.env.LEGACY_API_URL ?? 'https://servd-api.garibsons.app',
    time: new Date().toISOString(),
  })
}
