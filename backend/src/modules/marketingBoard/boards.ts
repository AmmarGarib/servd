// Marketing boards (owner, 2026-11-03): "Boards are divided by branch: Simmer, Stackd, Flipd Burgers" — each a BRAND
// board linked to its Concept, in that brand's company — plus beanzbakes, Abeer's home-baking Instagram account,
// which is NOT a brand, company or business entity (owner correction, 2026-11-03: "a separate platform"): a board of
// kind PLATFORM with no brand, kept in the company named "GS Foods" (whose servd it lives in — tenantId only stamps
// company separation; it appears in no brand list, menu, storefront or finance screen).
//
// Seeded once per board at boot (ensureMarketingBoards): a Setting marker per seed key makes it idempotent and
// survives a rename or an archive (an archived board is never re-created). A brand that does not exist yet is
// seeded on a later boot, once it does.

import { serviceClient as prisma } from '../../lib/prisma.js'

/** Brand boards: the board name and the brand names (case-insensitive) it links to. */
export const BRAND_BOARD_SEEDS: ReadonlyArray<{ name: string; sort: number; brandNames: readonly string[] }> = [
  { name: 'Simmer', sort: 10, brandNames: ['simmer'] },
  { name: 'Stackd', sort: 20, brandNames: ['stackd', 'stax'] },
  { name: 'Flipd Burgers', sort: 30, brandNames: ['flipd burgers', 'flipd'] },
]

/** Platform boards (not a brand): the name, and the company (by exact name) whose servd it lives in. */
export const PLATFORM_BOARD_SEEDS: ReadonlyArray<{ key: string; name: string; sort: number; companyName: string }> = [
  { key: 'beanzbakes', name: 'beanzbakes (Instagram)', sort: 100, companyName: 'GS Foods' },
]

const markerKey = (k: string) => `marketingBoard.seeded:${k}`

async function claimed(key: string): Promise<boolean> {
  return !!(await prisma.setting.findUnique({ where: { key: markerKey(key) }, select: { key: true } }))
}
async function mark(key: string, boardId: string): Promise<void> {
  await prisma.setting.createMany({ data: [{ key: markerKey(key), value: boardId }], skipDuplicates: true })
}

/** A board name free in the company (`name`, else `name (2)` …). */
async function freeName(tenantId: string, name: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`
    const taken = await prisma.marketingBoard.findUnique({ where: { tenantId_name: { tenantId, name: candidate } }, select: { id: true } })
    if (!taken) return candidate
  }
  return `${name} ${Date.now() % 100000}`
}

/** Seed the brand and platform boards (idempotent; never throws past a log line). */
export async function ensureMarketingBoards(log: (msg: string) => void = (m) => console.info(m)): Promise<{ created: number }> {
  let created = 0
  for (const seed of BRAND_BOARD_SEEDS) {
    const brands = await prisma.concept.findMany({
      where: { deletedAt: null, tenantId: { not: null }, OR: seed.brandNames.map((n) => ({ name: { equals: n, mode: 'insensitive' as const } })) },
      select: { id: true, tenantId: true, tenant: { select: { kind: true, deletedAt: true } } },
    })
    for (const b of brands) {
      if (!b.tenantId || b.tenant?.deletedAt || b.tenant?.kind !== 'company') continue
      const key = `brand:${b.id}`
      if (await claimed(key)) continue
      const existing = await prisma.marketingBoard.findFirst({ where: { tenantId: b.tenantId, conceptId: b.id }, select: { id: true } })
      const board = existing ?? await prisma.marketingBoard.create({
        data: { tenantId: b.tenantId, name: await freeName(b.tenantId, seed.name), kind: 'brand', conceptId: b.id, sort: seed.sort },
        select: { id: true },
      })
      if (!existing) created++
      await mark(key, board.id)
    }
  }
  for (const seed of PLATFORM_BOARD_SEEDS) {
    const company = await prisma.tenant.findFirst({ where: { name: seed.companyName, kind: 'company', deletedAt: null }, select: { id: true } })
    if (!company) { log(`[marketing-board] no company named "${seed.companyName}" — the ${seed.name} board was not seeded`); continue }
    const key = `platform:${seed.key}:${company.id}`
    if (await claimed(key)) continue
    const existing = await prisma.marketingBoard.findFirst({ where: { tenantId: company.id, name: seed.name }, select: { id: true } })
    const board = existing ?? await prisma.marketingBoard.create({
      data: { tenantId: company.id, name: seed.name, kind: 'platform', conceptId: null, sort: seed.sort },
      select: { id: true },
    })
    if (!existing) created++
    await mark(key, board.id)
  }
  if (created > 0) log(`[marketing-board] seeded ${created} board(s)`)
  return { created }
}
