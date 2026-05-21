// Seed the workforce position catalogue from the operator's payroll spec.
//
// Layout (matches the screenshots the CEO walked us through):
//   GS Foods (Bukhari) tenant
//     ├── Head Office (no concept)  ← shared, GS Foods bears ~37.5% of gross
//     │     Procurement, Finance, Marketing teams
//     ├── 42C Commissary (no concept; commissary is multi-brand support)
//     ├── Stax     (concept = Stax)
//     └── Simmer   (concept = Simmer)
//   GS x Viva (Clifton) tenant
//     └── Flipd / Viva ops (concept = Flipd; JV tenant pays 100% of combined)
//
// Idempotent: re-running won't duplicate. Uses upsert on (tenantId, name).
//
// Run with:  npx tsx scripts/seed-positions.ts

import { PrismaClient, PositionStatus } from '@prisma/client'

const prisma = new PrismaClient()

// Head office GS Foods cost-share. From the spec:
//   Total HO staff cost: PKR 800,000 / month
//   GS Foods bears:       PKR 300,000 / month (the rest sits with AG personal
//                                              + other ventures)
// → 37.5% per position. Operator can adjust per-role from the UI later.
const HEAD_OFFICE_GS_SHARE_PCT = 300 / 800

interface PositionSeed {
  title: string
  monthlySalaryPkr: number
  headcount?: number
  shiftBand?: string
  department: string
}

function pkr(n: number): number {
  return n * 100 // PKR → paisa (cents)
}

async function ensureTenants() {
  const gs = await prisma.tenant.findFirst({ where: { slug: 'gs-foods-bukhari' } })
  const viva = await prisma.tenant.findFirst({ where: { slug: 'gs-x-viva-clifton' } })
  if (!gs || !viva) throw new Error('Expected tenants gs-foods-bukhari + gs-x-viva-clifton')
  return { gs, viva }
}

async function ensureConcept(tenantId: string, slug: string) {
  const c = await prisma.concept.findFirst({ where: { slug, tenantId, deletedAt: null } })
  if (!c) throw new Error(`Concept ${slug} not found under tenant ${tenantId}`)
  return c
}

async function upsertDepartment(
  tenantId: string,
  name: string,
  opts: { emoji?: string; isHeadOffice?: boolean; order?: number } = {},
) {
  return prisma.department.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: { tenantId, name, ...opts },
    update: { ...opts },
  })
}

async function upsertShiftBand(tenantId: string, name: string, startTime: string, endTime: string, order = 0) {
  return prisma.shiftBand.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: { tenantId, name, startTime, endTime, order },
    update: { startTime, endTime, order },
  })
}

async function seedPosition(p: {
  tenantId: string
  conceptId: string | null
  departmentId: string
  shiftBandId: string | null
  title: string
  monthlySalaryCents: number
  tenantCostShareCents: number
  costShareNote?: string
  headcount?: number
}) {
  // No natural unique key for positions (you might budget two "Commis 1"
  // slots intentionally) — dedupe by (tenant, concept, dept, shiftBand, title)
  // to keep the seed idempotent.
  const existing = await prisma.position.findFirst({
    where: {
      tenantId: p.tenantId,
      conceptId: p.conceptId,
      departmentId: p.departmentId,
      shiftBandId: p.shiftBandId,
      title: p.title,
      status: { not: PositionStatus.archived },
    },
  })
  if (existing) {
    return prisma.position.update({
      where: { id: existing.id },
      data: {
        monthlySalaryCents: p.monthlySalaryCents,
        tenantCostShareCents: p.tenantCostShareCents,
        costShareNote: p.costShareNote ?? null,
        headcount: p.headcount ?? existing.headcount,
      },
    })
  }
  return prisma.position.create({
    data: {
      tenantId: p.tenantId,
      conceptId: p.conceptId,
      departmentId: p.departmentId,
      shiftBandId: p.shiftBandId,
      title: p.title,
      monthlySalaryCents: p.monthlySalaryCents,
      tenantCostShareCents: p.tenantCostShareCents,
      costShareNote: p.costShareNote ?? null,
      headcount: p.headcount ?? 1,
      status: PositionStatus.open,
    },
  })
}

async function main() {
  const { gs, viva } = await ensureTenants()
  const stax   = await ensureConcept(gs.id, 'stax')
  const simmer = await ensureConcept(gs.id, 'simmer')
  const flipd  = await ensureConcept(viva.id, 'flipd')

  // ─── GS Foods (Bukhari) tenant ──────────────────────────────────────────────

  // Shift bands (shared across GS Foods units)
  const sb_10_18    = await upsertShiftBand(gs.id, '10am-6pm',   '10:00', '18:00', 1)
  const sb_17_25    = await upsertShiftBand(gs.id, '5pm-1am',    '17:00', '25:00', 2)  // 25 = next-day 01
  const sb_18_26    = await upsertShiftBand(gs.id, '6pm-2am',    '18:00', '26:00', 3)
  const sb_10_18_p  = await upsertShiftBand(gs.id, '10am-6pm (prep)', '10:00', '18:00', 4)

  // ─── Head Office (shared cost-bearer) ────────────────────────────────────
  const procurement = await upsertDepartment(gs.id, 'Procurement',  { emoji: '📦', isHeadOffice: true, order: 1 })
  const finance     = await upsertDepartment(gs.id, 'Finance',      { emoji: '🧾', isHeadOffice: true, order: 2 })
  const marketing   = await upsertDepartment(gs.id, 'Marketing',    { emoji: '📣', isHeadOffice: true, order: 3 })

  const headOfficeRoles: Array<{ dept: string; title: string; pkr: number }> = [
    { dept: 'Procurement', title: 'Procurement Manager',           pkr: 100_000 },
    { dept: 'Procurement', title: 'Veg + Fruit Procurement',       pkr:  50_000 },
    { dept: 'Procurement', title: 'Meat Procurement',              pkr:  50_000 },
    { dept: 'Procurement', title: 'Seafood Procurement',           pkr:  50_000 },
    { dept: 'Finance',     title: 'Finance Officer',               pkr: 100_000 },
    { dept: 'Marketing',   title: 'Brand Manager',                 pkr: 150_000 },
    { dept: 'Marketing',   title: 'Content Creation + Editing',    pkr: 100_000 },
    { dept: 'Marketing',   title: 'Graphic Design',                pkr: 100_000 },
    { dept: 'Marketing',   title: 'Content + Community Management', pkr: 100_000 },
  ]
  const deptMap = { Procurement: procurement, Finance: finance, Marketing: marketing }
  for (const r of headOfficeRoles) {
    const gross  = pkr(r.pkr)
    const share  = Math.round(gross * HEAD_OFFICE_GS_SHARE_PCT)
    await seedPosition({
      tenantId: gs.id,
      conceptId: null, // head office is tenant-level, not concept-level
      departmentId: deptMap[r.dept as keyof typeof deptMap].id,
      shiftBandId: null,
      title: r.title,
      monthlySalaryCents: gross,
      tenantCostShareCents: share,
      costShareNote: `Head office: GS Foods bears ${Math.round(HEAD_OFFICE_GS_SHARE_PCT * 100)}% (PKR ${(share / 100).toLocaleString()}) of gross ${r.pkr.toLocaleString()}.`,
    })
  }

  // ─── 42C Commissary ──────────────────────────────────────────────────────
  const commDish42  = await upsertDepartment(gs.id, '42C · Dish Team',   { emoji: '🧽', order: 10 })
  const commMgmt42  = await upsertDepartment(gs.id, '42C · Management',  { emoji: '👨‍🍳', order: 11 })
  const commFloat42 = await upsertDepartment(gs.id, '42C · Float Team',  { emoji: '🛻', order: 12 })
  const commPrep42  = await upsertDepartment(gs.id, '42C · Prep Staff',  { emoji: '🔪', order: 13 })

  const commissary: Array<{ dept: typeof commDish42; title: string; pkr: number; shift: typeof sb_10_18 | null }> = [
    // Dish — 2 shifts
    { dept: commDish42,  title: 'Dish 1', pkr: 30_000, shift: sb_10_18 },
    { dept: commDish42,  title: 'Dish 2', pkr: 30_000, shift: sb_10_18 },
    { dept: commDish42,  title: 'Dish 1', pkr: 30_000, shift: sb_18_26 },
    { dept: commDish42,  title: 'Dish 2', pkr: 30_000, shift: sb_18_26 },
    // Management
    { dept: commMgmt42,  title: 'Head Pastry Chef', pkr: 100_000, shift: null },
    { dept: commMgmt42,  title: 'Executive Chef',   pkr: 100_000, shift: null },
    { dept: commMgmt42,  title: 'General Manager',  pkr: 150_000, shift: null },
    // Float
    { dept: commFloat42, title: 'Food Runner 1',    pkr: 30_000,  shift: sb_10_18 },
    { dept: commFloat42, title: 'Food Runner 2',    pkr: 30_000,  shift: sb_10_18 },
    { dept: commFloat42, title: 'Food Runner 1',    pkr: 35_000,  shift: sb_18_26 },
    { dept: commFloat42, title: 'Food Runner 2',    pkr: 35_000,  shift: sb_18_26 },
    // Prep
    { dept: commPrep42,  title: 'Meat Prep',        pkr: 35_000,  shift: sb_10_18_p },
    { dept: commPrep42,  title: 'Bakery Prep 1',    pkr: 35_000,  shift: sb_10_18_p },
    { dept: commPrep42,  title: 'Savory Prep 1',    pkr: 35_000,  shift: sb_10_18_p },
    { dept: commPrep42,  title: 'Bakery Prep 2',    pkr: 35_000,  shift: sb_10_18_p },
    { dept: commPrep42,  title: 'Savory Prep 2',    pkr: 35_000,  shift: sb_10_18_p },
  ]
  for (const r of commissary) {
    await seedPosition({
      tenantId: gs.id,
      conceptId: null, // commissary serves multiple brands
      departmentId: r.dept.id,
      shiftBandId: r.shift?.id ?? null,
      title: r.title,
      monthlySalaryCents: pkr(r.pkr),
      tenantCostShareCents: pkr(r.pkr),
    })
  }

  // ─── Simmer ──────────────────────────────────────────────────────────────
  const simGarde   = await upsertDepartment(gs.id, 'Simmer · Garde Manger', { emoji: '🥗', order: 20 })
  const simMain    = await upsertDepartment(gs.id, 'Simmer · Main Kitchen', { emoji: '🔥', order: 21 })
  const simFoh     = await upsertDepartment(gs.id, 'Simmer · FOH',          { emoji: '🍸', order: 22 })

  const simmerRoles = [
    // Garde Manger
    { dept: simGarde, title: 'Chef de Partie',  pkr: 60_000 },
    { dept: simGarde, title: 'Commis 1',        pkr: 35_000 },
    // Main Kitchen
    { dept: simMain,  title: 'Chef de Partie',  pkr: 60_000 },
    { dept: simMain,  title: 'Commis 1',        pkr: 35_000 },
    { dept: simMain,  title: 'Commis 2',        pkr: 35_000 },
    // FOH
    { dept: simFoh,   title: 'Bartender',       pkr: 55_000 },
    { dept: simFoh,   title: 'Senior Server',   pkr: 50_000 },
    { dept: simFoh,   title: 'Junior Server',   pkr: 35_000 },
    { dept: simFoh,   title: 'Host',            pkr: 30_000 },
  ]
  for (const r of simmerRoles) {
    await seedPosition({
      tenantId: gs.id,
      conceptId: simmer.id,
      departmentId: r.dept.id,
      shiftBandId: sb_18_26.id, // all Simmer roles are 6pm-2am
      title: r.title,
      monthlySalaryCents: pkr(r.pkr),
      tenantCostShareCents: pkr(r.pkr),
    })
  }

  // ─── Stax ────────────────────────────────────────────────────────────────
  const staxAssemblyDay   = await upsertDepartment(gs.id, 'Stax · Assembly Bar (day)',   { emoji: '🥪', order: 30 })
  const staxMain          = await upsertDepartment(gs.id, 'Stax · Main Kitchen',          { emoji: '🥩', order: 31 })
  const staxAssemblyNight = await upsertDepartment(gs.id, 'Stax · Assembly Bar (night)', { emoji: '🥪', order: 32 })

  const staxRoles: Array<{ dept: typeof staxAssemblyDay; title: string; pkr: number; shift: typeof sb_10_18 }> = [
    { dept: staxAssemblyDay,   title: 'Commis 1',                    pkr: 30_000, shift: sb_10_18 },
    { dept: staxAssemblyDay,   title: 'Commis 2',                    pkr: 30_000, shift: sb_10_18 },
    { dept: staxMain,          title: 'Chef de Partie',              pkr: 55_000, shift: sb_18_26 },
    { dept: staxMain,          title: 'Commis 1',                    pkr: 30_000, shift: sb_18_26 },
    { dept: staxMain,          title: 'Commis 2',                    pkr: 30_000, shift: sb_18_26 },
    { dept: staxAssemblyNight, title: 'Commis 1',                    pkr: 30_000, shift: sb_18_26 },
    { dept: staxAssemblyNight, title: 'Assembly Bar Cashier + Expo', pkr: 30_000, shift: sb_18_26 },
  ]
  for (const r of staxRoles) {
    await seedPosition({
      tenantId: gs.id,
      conceptId: stax.id,
      departmentId: r.dept.id,
      shiftBandId: r.shift.id,
      title: r.title,
      monthlySalaryCents: pkr(r.pkr),
      tenantCostShareCents: pkr(r.pkr),
    })
  }

  // ─── GS x Viva (Clifton) tenant — Flipd brand ────────────────────────────
  // Combined GS+Viva salaries (JV pays the full combined amount, internal split
  // is just for AG's reporting and tracked in costShareNote for context).
  const sb_18_26_v = await upsertShiftBand(viva.id, '6pm-2am', '18:00', '26:00', 1)
  const sb_17_25_v = await upsertShiftBand(viva.id, '5pm-1am', '17:00', '25:00', 2)

  const vivaMgmt    = await upsertDepartment(viva.id, 'Management',      { emoji: '🧑‍💼', order: 1 })
  const vivaKitchen = await upsertDepartment(viva.id, 'Kitchen Service', { emoji: '🍳', order: 2 })
  const vivaService = await upsertDepartment(viva.id, 'Service Team',    { emoji: '🛎', order: 3 })

  // Format: (gs_share_pkr + viva_share_pkr) → combined gross
  const vivaSplit = (gsPkr: number, vivaPkr: number) => {
    const combined = gsPkr + vivaPkr
    const note = `JV split (combined PKR ${combined.toLocaleString()}): GS Foods ${gsPkr.toLocaleString()} (${Math.round(gsPkr / combined * 100)}%) + Viva ${vivaPkr.toLocaleString()} (${Math.round(vivaPkr / combined * 100)}%). JV tenant pays 100% of combined.`
    return { gross: pkr(combined), share: pkr(combined), note }
  }

  const vivaRoles = [
    // Management
    { dept: vivaMgmt,    shift: null,        title: 'F&B Manager',     gs: 40_000, viva: 60_000 },
    // Kitchen Service (5pm-1am Service Team)
    { dept: vivaKitchen, shift: sb_17_25_v,  title: 'Chef de Partie',  gs: 24_000, viva: 36_000 },
    { dept: vivaKitchen, shift: sb_17_25_v,  title: 'Commis 1',        gs: 14_000, viva: 21_000 },
    { dept: vivaKitchen, shift: sb_17_25_v,  title: 'Commis 2',        gs: 14_000, viva: 21_000 },
    // Service Team
    { dept: vivaService, shift: sb_17_25_v,  title: 'Food Runner 1',   gs: 14_000, viva: 21_000 },
    { dept: vivaService, shift: sb_17_25_v,  title: 'Food Runner 2',   gs: 14_000, viva: 21_000 },
  ]
  for (const r of vivaRoles) {
    const { gross, share, note } = vivaSplit(r.gs, r.viva)
    await seedPosition({
      tenantId: viva.id,
      conceptId: flipd.id,
      departmentId: r.dept.id,
      shiftBandId: r.shift?.id ?? null,
      title: r.title,
      monthlySalaryCents: gross,
      tenantCostShareCents: share,
      costShareNote: note,
    })
  }

  const total = await prisma.position.count()
  console.log(`✅ seed-positions complete — ${total} active positions now in DB`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
