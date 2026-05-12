import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import type {
  KitchenStaffRole,
  SkillLevel,
  EmploymentType,
  KitchenStaffStatus,
  WageSettings,
} from '@prisma/client'

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  minWageUnskilled: 40000,
  minWageSemiSkilled: 41280,
  minWageSkilled: 48910,
  minWageHighlySkilled: 50868,
  workingDaysPerMonth: 26,
  paidHoursPerDay: 8,
  otMultiplierRegular: 2.0,
  otMultiplierFestival: 3.0,
  maxOtHoursPerWeek: 12,
  maxOtHoursPerYear: 624,
  eobiEmployerPct: 0.01,
  sessiEmployerPct: 0.06,
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const staffCreateSchema = z.object({
  fullName: z.string().min(1),
  cnic: z.string().regex(/^\d{5}-\d{7}-\d$/, 'CNIC must be XXXXX-XXXXXXX-X'),
  phone: z.string().min(1),
  kitchenRole: z.enum([
    'head_chef', 'sous_chef', 'cdp', 'demi_chef', 'commis',
    'kitchen_helper', 'dishwasher', 'baker', 'tandoor_grill_cook',
  ]),
  skillLevel: z.enum(['unskilled', 'semi_skilled', 'skilled', 'highly_skilled']),
  employmentType: z.enum(['permanent', 'probationary', 'temporary', 'contract']),
  dateJoined: z.string(),
  dateLeft: z.string().optional().nullable(),
  monthlySalaryCash: z.number().int().min(0),
  mealsProvided: z.boolean().optional(),
  accommodationProvided: z.boolean().optional(),
  accommodationValue: z.number().int().min(0).optional(),
  eobiRegistered: z.boolean().optional(),
  sessiRegistered: z.boolean().optional(),
  bankAccount: z.string().optional().nullable(),
  emergencyContact: z.string().min(1),
  status: z.enum(['active', 'on_leave', 'terminated']).optional(),
  // Stations this cook is assigned to. Empty = head-chef-style "all stations".
  stationIds: z.array(z.string().uuid()).default([]),
})

const staffUpdateSchema = staffCreateSchema.partial()

const shiftCreateSchema = z.object({
  staffId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  scheduledStart: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM'),
  scheduledEnd: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM'),
  breakMinutes: z.number().int().min(0).optional(),
  isWeeklyOff: z.boolean().optional(),
  isFestivalHoliday: z.boolean().optional(),
  notes: z.string().optional().nullable(),
})

const punchSchema = z.object({
  actualStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  actualEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
})

const wageSettingsSchema = z.object({
  minWageUnskilled: z.number().int().min(0).optional(),
  minWageSemiSkilled: z.number().int().min(0).optional(),
  minWageSkilled: z.number().int().min(0).optional(),
  minWageHighlySkilled: z.number().int().min(0).optional(),
  workingDaysPerMonth: z.number().int().min(1).max(31).optional(),
  paidHoursPerDay: z.number().int().min(1).max(24).optional(),
  otMultiplierRegular: z.number().min(1).optional(),
  otMultiplierFestival: z.number().min(1).optional(),
  maxOtHoursPerWeek: z.number().int().min(0).optional(),
  maxOtHoursPerYear: z.number().int().min(0).optional(),
  eobiEmployerPct: z.number().min(0).max(1).optional(),
  sessiEmployerPct: z.number().min(0).max(1).optional(),
})

const payrollGenerateSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
})

const templateSchema = z.object({
  template: z.enum(['small_cafe', 'mid_restaurant', 'cloud_kitchen']),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SettingsLike = typeof DEFAULT_SETTINGS

function getMinWage(skillLevel: SkillLevel, settings: SettingsLike): number {
  const map: Record<SkillLevel, number> = {
    unskilled: settings.minWageUnskilled,
    semi_skilled: settings.minWageSemiSkilled,
    skilled: settings.minWageSkilled,
    highly_skilled: settings.minWageHighlySkilled,
  }
  return map[skillLevel]
}

function calcHourlyRate(monthlySalaryCash: number, settings: SettingsLike): number {
  return monthlySalaryCash / settings.workingDaysPerMonth / settings.paidHoursPerDay
}

function shiftHours(start: string, end: string, breakMinutes: number): number {
  const parts1 = start.split(':').map(Number)
  const parts2 = end.split(':').map(Number)
  const sh = parts1[0] ?? 0, sm = parts1[1] ?? 0
  const eh = parts2[0] ?? 0, em = parts2[1] ?? 0
  const totalMins = (eh * 60 + em) - (sh * 60 + sm)
  return Math.max(0, totalMins - breakMinutes) / 60
}

async function getOrCreateWageSettings(tenantId: string): Promise<WageSettings> {
  const existing = await prisma.wageSettings.findUnique({ where: { tenantId } })
  if (existing) return existing
  return prisma.wageSettings.create({
    data: {
      tenantId,
      minWageUnskilled: DEFAULT_SETTINGS.minWageUnskilled,
      minWageSemiSkilled: DEFAULT_SETTINGS.minWageSemiSkilled,
      minWageSkilled: DEFAULT_SETTINGS.minWageSkilled,
      minWageHighlySkilled: DEFAULT_SETTINGS.minWageHighlySkilled,
      workingDaysPerMonth: DEFAULT_SETTINGS.workingDaysPerMonth,
      paidHoursPerDay: DEFAULT_SETTINGS.paidHoursPerDay,
      otMultiplierRegular: DEFAULT_SETTINGS.otMultiplierRegular,
      otMultiplierFestival: DEFAULT_SETTINGS.otMultiplierFestival,
      maxOtHoursPerWeek: DEFAULT_SETTINGS.maxOtHoursPerWeek,
      maxOtHoursPerYear: DEFAULT_SETTINGS.maxOtHoursPerYear,
      eobiEmployerPct: DEFAULT_SETTINGS.eobiEmployerPct,
      sessiEmployerPct: DEFAULT_SETTINGS.sessiEmployerPct,
    },
  })
}

async function runComplianceChecks(staffId: string, tenantId: string) {
  const staff = await prisma.kitchenStaff.findUnique({ where: { id: staffId } })
  if (!staff) return

  const rawSettings = await prisma.wageSettings.findUnique({ where: { tenantId } })
  const settings: SettingsLike = rawSettings ?? DEFAULT_SETTINGS

  const violations: { type: string; description: string }[] = []

  // 1. Min wage check
  const minWage = getMinWage(staff.skillLevel, settings)
  if (staff.monthlySalaryCash < minWage) {
    violations.push({
      type: 'below_min_wage',
      description: `Salary PKR ${staff.monthlySalaryCash.toLocaleString()} is below Sindh minimum wage PKR ${minWage.toLocaleString()} for ${staff.skillLevel} level`,
    })
  }

  // 2. Last 7 days of shifts — weekly off check, consecutive days, OT per week
  const lastWeek = await prisma.kitchenShift.findMany({
    where: {
      staffId,
      date: { gte: new Date(Date.now() - 7 * 86400000) },
      isWeeklyOff: false,
      actualEnd: { not: null },
    },
  })

  if (lastWeek.length >= 7) {
    violations.push({
      type: 'consecutive_days',
      description: `${staff.fullName} has worked 7+ consecutive days without a day off`,
    })
  }

  const weekHoursWorked = lastWeek.reduce((s, sh) => {
    if (sh.actualStart && sh.actualEnd) {
      return s + shiftHours(sh.actualStart, sh.actualEnd, sh.breakMinutes)
    }
    return s
  }, 0)

  const weekOt = Math.max(0, weekHoursWorked - 48)
  if (weekOt > settings.maxOtHoursPerWeek) {
    violations.push({
      type: 'ot_week_exceeded',
      description: `${staff.fullName} has ${weekOt.toFixed(1)} OT hours this week (limit: ${settings.maxOtHoursPerWeek}h)`,
    })
  }

  // Create new violations (skip duplicates within 7 days)
  for (const v of violations) {
    const recent = await prisma.complianceViolation.findFirst({
      where: {
        staffId,
        type: v.type,
        detectedAt: { gte: new Date(Date.now() - 7 * 86400000) },
      },
    })
    if (!recent) {
      await prisma.complianceViolation.create({ data: { staffId, tenantId, ...v } })
    }
  }
}

// ─── Brigade templates ────────────────────────────────────────────────────────

type TemplateEntry = {
  fullName: string
  kitchenRole: KitchenStaffRole
  skillLevel: SkillLevel
  monthlySalaryCash: number
}

const BRIGADE_TEMPLATES: Record<string, TemplateEntry[]> = {
  small_cafe: [
    { fullName: 'Head Cook',      kitchenRole: 'head_chef',       skillLevel: 'skilled',       monthlySalaryCash: 55000 },
    { fullName: 'Commis 1',       kitchenRole: 'commis',          skillLevel: 'semi_skilled',  monthlySalaryCash: 42000 },
    { fullName: 'Commis 2',       kitchenRole: 'commis',          skillLevel: 'semi_skilled',  monthlySalaryCash: 42000 },
    { fullName: 'Kitchen Helper', kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',     monthlySalaryCash: 40000 },
    { fullName: 'Dishwasher',     kitchenRole: 'dishwasher',      skillLevel: 'unskilled',     monthlySalaryCash: 40000 },
  ],
  mid_restaurant: [
    { fullName: 'Head Chef',        kitchenRole: 'head_chef',       skillLevel: 'highly_skilled', monthlySalaryCash: 80000 },
    { fullName: 'Sous Chef',        kitchenRole: 'sous_chef',       skillLevel: 'highly_skilled', monthlySalaryCash: 65000 },
    { fullName: 'CDP 1',            kitchenRole: 'cdp',             skillLevel: 'skilled',        monthlySalaryCash: 50000 },
    { fullName: 'CDP 2',            kitchenRole: 'cdp',             skillLevel: 'skilled',        monthlySalaryCash: 50000 },
    { fullName: 'Commis 1',         kitchenRole: 'commis',          skillLevel: 'semi_skilled',   monthlySalaryCash: 42000 },
    { fullName: 'Commis 2',         kitchenRole: 'commis',          skillLevel: 'semi_skilled',   monthlySalaryCash: 42000 },
    { fullName: 'Commis 3',         kitchenRole: 'commis',          skillLevel: 'semi_skilled',   monthlySalaryCash: 42000 },
    { fullName: 'Kitchen Helper 1', kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',      monthlySalaryCash: 40000 },
    { fullName: 'Kitchen Helper 2', kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',      monthlySalaryCash: 40000 },
    { fullName: 'Dishwasher 1',     kitchenRole: 'dishwasher',      skillLevel: 'unskilled',      monthlySalaryCash: 40000 },
    { fullName: 'Dishwasher 2',     kitchenRole: 'dishwasher',      skillLevel: 'unskilled',      monthlySalaryCash: 40000 },
  ],
  cloud_kitchen: [
    { fullName: 'Production Head', kitchenRole: 'head_chef',       skillLevel: 'skilled',      monthlySalaryCash: 55000 },
    { fullName: 'Cook 1',          kitchenRole: 'commis',          skillLevel: 'semi_skilled', monthlySalaryCash: 42000 },
    { fullName: 'Cook 2',          kitchenRole: 'commis',          skillLevel: 'semi_skilled', monthlySalaryCash: 42000 },
    { fullName: 'Cook 3',          kitchenRole: 'commis',          skillLevel: 'semi_skilled', monthlySalaryCash: 42000 },
    { fullName: 'Cook 4',          kitchenRole: 'commis',          skillLevel: 'semi_skilled', monthlySalaryCash: 42000 },
    { fullName: 'Packer 1',        kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',    monthlySalaryCash: 40000 },
    { fullName: 'Packer 2',        kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',    monthlySalaryCash: 40000 },
    { fullName: 'Dispatcher',      kitchenRole: 'kitchen_helper',  skillLevel: 'unskilled',    monthlySalaryCash: 40000 },
  ],
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function kitchenStaffRoutes(fastify: FastifyInstance) {

  // ──────────────────────────────────────────────────────────────────────────
  // Staff CRUD
  // ──────────────────────────────────────────────────────────────────────────

  // GET /staff
  fastify.get<{ Querystring: { status?: string } }>(
    '/staff',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const statusFilter = req.query.status as KitchenStaffStatus | undefined

      const staff = await prisma.kitchenStaff.findMany({
        where: {
          tenantId,
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: {
          _count: { select: { complianceViolations: { where: { resolvedAt: null } } } },
          payrollRuns: {
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            take: 1,
            select: {
              id: true, month: true, year: true, netPay: true,
              trueCostToCompany: true, status: true,
            },
          },
        },
        orderBy: { fullName: 'asc' },
      })

      return staff.map((s) => ({
        ...s,
        openViolationCount: s._count.complianceViolations,
        latestPayroll: s.payrollRuns[0] ?? null,
        _count: undefined,
        payrollRuns: undefined,
      }))
    },
  )

  // POST /staff
  fastify.post(
    '/staff',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const body = staffCreateSchema.parse(req.body)

      const member = await prisma.kitchenStaff.create({
        data: {
          tenantId,
          fullName: body.fullName,
          cnic: body.cnic,
          phone: body.phone,
          kitchenRole: body.kitchenRole as KitchenStaffRole,
          skillLevel: body.skillLevel as SkillLevel,
          employmentType: body.employmentType as EmploymentType,
          dateJoined: new Date(body.dateJoined),
          dateLeft: body.dateLeft ? new Date(body.dateLeft) : null,
          monthlySalaryCash: body.monthlySalaryCash,
          mealsProvided: body.mealsProvided ?? false,
          accommodationProvided: body.accommodationProvided ?? false,
          accommodationValue: body.accommodationValue ?? 0,
          eobiRegistered: body.eobiRegistered ?? false,
          sessiRegistered: body.sessiRegistered ?? false,
          bankAccount: body.bankAccount ?? null,
          emergencyContact: body.emergencyContact,
          status: (body.status as KitchenStaffStatus) ?? 'active',
          stationIds: body.stationIds ?? [],
        },
      })

      await runComplianceChecks(member.id, tenantId)

      return reply.status(201).send(member)
    },
  )

  // GET /staff/:id
  fastify.get<{ Params: { id: string } }>(
    '/staff/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)

      const member = await prisma.kitchenStaff.findFirst({
        where: { id: req.params.id, tenantId },
        include: {
          kitchenShifts: {
            where: { date: { gte: thirtyDaysAgo } },
            orderBy: { date: 'desc' },
          },
          complianceViolations: {
            orderBy: { detectedAt: 'desc' },
          },
        },
      })

      if (!member) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found' } })
      return member
    },
  )

  // PUT /staff/:id
  fastify.put<{ Params: { id: string } }>(
    '/staff/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const body = staffUpdateSchema.parse(req.body)

      const existing = await prisma.kitchenStaff.findFirst({
        where: { id: req.params.id, tenantId },
      })
      if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found' } })

      const updated = await prisma.kitchenStaff.update({
        where: { id: req.params.id },
        data: {
          ...(body.fullName !== undefined && { fullName: body.fullName }),
          ...(body.cnic !== undefined && { cnic: body.cnic }),
          ...(body.phone !== undefined && { phone: body.phone }),
          ...(body.kitchenRole !== undefined && { kitchenRole: body.kitchenRole as KitchenStaffRole }),
          ...(body.skillLevel !== undefined && { skillLevel: body.skillLevel as SkillLevel }),
          ...(body.employmentType !== undefined && { employmentType: body.employmentType as EmploymentType }),
          ...(body.dateJoined !== undefined && { dateJoined: new Date(body.dateJoined) }),
          ...(body.dateLeft !== undefined && { dateLeft: body.dateLeft ? new Date(body.dateLeft) : null }),
          ...(body.monthlySalaryCash !== undefined && { monthlySalaryCash: body.monthlySalaryCash }),
          ...(body.mealsProvided !== undefined && { mealsProvided: body.mealsProvided }),
          ...(body.accommodationProvided !== undefined && { accommodationProvided: body.accommodationProvided }),
          ...(body.accommodationValue !== undefined && { accommodationValue: body.accommodationValue }),
          ...(body.eobiRegistered !== undefined && { eobiRegistered: body.eobiRegistered }),
          ...(body.sessiRegistered !== undefined && { sessiRegistered: body.sessiRegistered }),
          ...(body.bankAccount !== undefined && { bankAccount: body.bankAccount }),
          ...(body.emergencyContact !== undefined && { emergencyContact: body.emergencyContact }),
          ...(body.status !== undefined && { status: body.status as KitchenStaffStatus }),
        },
      })

      await runComplianceChecks(updated.id, tenantId)

      return updated
    },
  )

  // DELETE /staff/:id  (soft delete)
  fastify.delete<{ Params: { id: string } }>(
    '/staff/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!

      const existing = await prisma.kitchenStaff.findFirst({
        where: { id: req.params.id, tenantId },
      })
      if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found' } })

      const updated = await prisma.kitchenStaff.update({
        where: { id: req.params.id },
        data: { status: 'terminated', dateLeft: new Date() },
      })

      return updated
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Brigade templates
  // ──────────────────────────────────────────────────────────────────────────

  // POST /staff/from-template
  fastify.post(
    '/staff/from-template',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const { template } = templateSchema.parse(req.body)

      const entries = BRIGADE_TEMPLATES[template]
      if (!entries) {
        return reply.status(400).send({ error: { code: 'INVALID_TEMPLATE', message: 'Unknown template' } })
      }

      // Determine CNIC offset from existing count
      const existingCount = await prisma.kitchenStaff.count({ where: { tenantId } })

      const created = await prisma.$transaction(
        entries.map((entry, idx) => {
          const n = existingCount + idx + 1
          const paddedN = String(n).padStart(7, '0')
          const cnic = `00000-${paddedN}-0`
          return prisma.kitchenStaff.create({
            data: {
              tenantId,
              fullName: entry.fullName,
              cnic,
              phone: 'TBD',
              kitchenRole: entry.kitchenRole,
              skillLevel: entry.skillLevel,
              employmentType: 'permanent',
              dateJoined: new Date(),
              monthlySalaryCash: entry.monthlySalaryCash,
              emergencyContact: 'TBD',
              status: 'active',
            },
          })
        }),
      )

      // Run compliance checks for all created staff
      await Promise.all(created.map((s) => runComplianceChecks(s.id, tenantId)))

      return reply.status(201).send(created)
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Shifts
  // ──────────────────────────────────────────────────────────────────────────

  // GET /shifts?week=YYYY-MM-DD
  fastify.get<{ Querystring: { week?: string } }>(
    '/shifts',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const weekParam = req.query.week ?? new Date().toISOString().slice(0, 10)

      // Compute Mon–Sun bounds
      const anchor = new Date(weekParam)
      const dow = anchor.getUTCDay()
      const mon = new Date(anchor)
      mon.setUTCDate(anchor.getUTCDate() - ((dow + 6) % 7))
      mon.setUTCHours(0, 0, 0, 0)
      const sun = new Date(mon)
      sun.setUTCDate(mon.getUTCDate() + 6)
      sun.setUTCHours(23, 59, 59, 999)

      const shifts = await prisma.kitchenShift.findMany({
        where: {
          date: { gte: mon, lte: sun },
          staff: { tenantId },
        },
        include: {
          staff: {
            select: { id: true, fullName: true, kitchenRole: true, skillLevel: true },
          },
        },
        orderBy: [{ date: 'asc' }, { scheduledStart: 'asc' }],
      })

      // Group by staffId
      const byStaff: Record<string, { staff: typeof shifts[0]['staff']; shifts: typeof shifts }> = {}
      for (const shift of shifts) {
        const { staff, ...shiftData } = shift
        if (!byStaff[staff.id]) {
          byStaff[staff.id] = { staff, shifts: [] }
        }
        byStaff[staff.id]!.shifts.push({ staff, ...shiftData })
      }

      return {
        weekStart: mon.toISOString().slice(0, 10),
        weekEnd: sun.toISOString().slice(0, 10),
        grouped: Object.values(byStaff),
      }
    },
  )

  // POST /shifts  (create or upsert)
  fastify.post(
    '/shifts',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const body = shiftCreateSchema.parse(req.body)

      // Verify staff belongs to tenant
      const staff = await prisma.kitchenStaff.findFirst({
        where: { id: body.staffId, tenantId },
      })
      if (!staff) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found' } })
      }

      const shiftDate = new Date(body.date)
      shiftDate.setUTCHours(0, 0, 0, 0)

      const shift = await prisma.kitchenShift.upsert({
        where: { staffId_date: { staffId: body.staffId, date: shiftDate } },
        update: {
          scheduledStart: body.scheduledStart,
          scheduledEnd: body.scheduledEnd,
          breakMinutes: body.breakMinutes ?? 60,
          isWeeklyOff: body.isWeeklyOff ?? false,
          isFestivalHoliday: body.isFestivalHoliday ?? false,
          notes: body.notes ?? null,
        },
        create: {
          staffId: body.staffId,
          date: shiftDate,
          scheduledStart: body.scheduledStart,
          scheduledEnd: body.scheduledEnd,
          breakMinutes: body.breakMinutes ?? 60,
          isWeeklyOff: body.isWeeklyOff ?? false,
          isFestivalHoliday: body.isFestivalHoliday ?? false,
          notes: body.notes ?? null,
        },
      })

      await runComplianceChecks(body.staffId, tenantId)

      return reply.status(201).send(shift)
    },
  )

  // PATCH /shifts/:id/punch
  fastify.patch<{ Params: { id: string } }>(
    '/shifts/:id/punch',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!
      const body = punchSchema.parse(req.body)

      // Verify shift belongs to tenant staff
      const shift = await prisma.kitchenShift.findFirst({
        where: { id: req.params.id, staff: { tenantId } },
      })
      if (!shift) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found' } })
      }

      const updated = await prisma.kitchenShift.update({
        where: { id: req.params.id },
        data: {
          ...(body.actualStart !== undefined && { actualStart: body.actualStart }),
          ...(body.actualEnd !== undefined && { actualEnd: body.actualEnd }),
        },
      })

      await runComplianceChecks(shift.staffId, tenantId)

      return updated
    },
  )

  // GET /attendance?date=YYYY-MM-DD
  fastify.get<{ Querystring: { date?: string } }>(
    '/attendance',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const dateParam = req.query.date ?? new Date().toISOString().slice(0, 10)
      const targetDate = new Date(dateParam)
      targetDate.setUTCHours(0, 0, 0, 0)
      const nextDate = new Date(targetDate)
      nextDate.setUTCDate(targetDate.getUTCDate() + 1)

      const allStaff = await prisma.kitchenStaff.findMany({
        where: { tenantId, status: { not: 'terminated' } },
        orderBy: { fullName: 'asc' },
      })

      const shifts = await prisma.kitchenShift.findMany({
        where: {
          date: { gte: targetDate, lt: nextDate },
          staff: { tenantId },
        },
      })

      const shiftByStaff = new Map(shifts.map((s) => [s.staffId, s]))

      return allStaff.map((member) => ({
        staff: member,
        shift: shiftByStaff.get(member.id) ?? null,
      }))
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Wage settings
  // ──────────────────────────────────────────────────────────────────────────

  // GET /wage-settings
  fastify.get(
    '/wage-settings',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      return getOrCreateWageSettings(tenantId)
    },
  )

  // PUT /wage-settings
  fastify.put(
    '/wage-settings',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const body = wageSettingsSchema.parse(req.body)

      // Ensure row exists first
      await getOrCreateWageSettings(tenantId)

      return prisma.wageSettings.update({
        where: { tenantId },
        data: body,
      })
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Payroll
  // ──────────────────────────────────────────────────────────────────────────

  // POST /payroll/generate
  fastify.post(
    '/payroll/generate',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const { month, year } = payrollGenerateSchema.parse(req.body)

      const settings = await getOrCreateWageSettings(tenantId)
      const activeStaff = await prisma.kitchenStaff.findMany({
        where: { tenantId, status: 'active' },
      })

      // Date range for the month
      const monthStart = new Date(Date.UTC(year, month - 1, 1))
      const monthEnd = new Date(Date.UTC(year, month, 1))

      const runs = await Promise.all(
        activeStaff.map(async (member) => {
          const shifts = await prisma.kitchenShift.findMany({
            where: {
              staffId: member.id,
              date: { gte: monthStart, lt: monthEnd },
              actualEnd: { not: null },
              isWeeklyOff: false,
            },
          })

          let regularHours = 0
          let otRegular = 0
          let otFestival = 0

          for (const shift of shifts) {
            if (!shift.actualStart || !shift.actualEnd) continue
            const hours = shiftHours(shift.actualStart, shift.actualEnd, shift.breakMinutes)
            const scheduledHours = shiftHours(shift.scheduledStart, shift.scheduledEnd, shift.breakMinutes)
            const worked = Math.min(hours, scheduledHours)
            const ot = Math.max(0, hours - scheduledHours)

            regularHours += worked
            if (shift.isFestivalHoliday) {
              otFestival += hours // entire shift on festival is festival OT
            } else {
              otRegular += ot
            }
          }

          const hourlyRate = calcHourlyRate(member.monthlySalaryCash, settings)
          const otPayRegular = otRegular * hourlyRate * settings.otMultiplierRegular
          const otPayFestival = otFestival * hourlyRate * settings.otMultiplierFestival

          const mealValue = member.mealsProvided ? 3000 : 0 // nominal PKR/month
          const accommodationValue = member.accommodationProvided ? member.accommodationValue : 0

          const grossPay = member.monthlySalaryCash + otPayRegular + otPayFestival + mealValue + accommodationValue

          // EOBI: PKR 370/month employee share (fixed 2024 rate); employer 1%
          const eobiEmployee = member.eobiRegistered ? 370 : 0
          const eobiEmployer = member.eobiRegistered ? member.monthlySalaryCash * settings.eobiEmployerPct : 0
          // SESSI: employer 6% of gross
          const sessiEmployer = member.sessiRegistered ? grossPay * settings.sessiEmployerPct : 0

          // Income tax: simplified slab — exempt below PKR 50,000/month
          let incomeTaxWithheld = 0
          const annualised = grossPay * 12
          if (annualised > 600000) {
            incomeTaxWithheld = ((annualised - 600000) * 0.025) / 12
          }

          const netPay = grossPay - eobiEmployee - incomeTaxWithheld
          const trueCostToCompany = grossPay + eobiEmployer + sessiEmployer

          return prisma.kitchenPayrollRun.upsert({
            where: { staffId_month_year: { staffId: member.id, month, year } },
            update: {
              baseSalary: member.monthlySalaryCash,
              regularHoursWorked: regularHours,
              otHoursRegular: otRegular,
              otHoursFestival: otFestival,
              hourlyRate,
              otPayRegular,
              otPayFestival,
              mealValue,
              accommodationValue,
              grossPay,
              eobiEmployee,
              eobiEmployer,
              sessiEmployer,
              incomeTaxWithheld,
              netPay,
              trueCostToCompany,
              status: 'draft',
            },
            create: {
              staffId: member.id,
              tenantId,
              month,
              year,
              baseSalary: member.monthlySalaryCash,
              regularHoursWorked: regularHours,
              otHoursRegular: otRegular,
              otHoursFestival: otFestival,
              hourlyRate,
              otPayRegular,
              otPayFestival,
              mealValue,
              accommodationValue,
              grossPay,
              eobiEmployee,
              eobiEmployer,
              sessiEmployer,
              incomeTaxWithheld,
              netPay,
              trueCostToCompany,
              status: 'draft',
            },
          })
        }),
      )

      return runs
    },
  )

  // GET /payroll/runs?month=N&year=N
  fastify.get<{ Querystring: { month?: string; year?: string } }>(
    '/payroll/runs',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const month = req.query.month ? parseInt(req.query.month, 10) : undefined
      const year = req.query.year ? parseInt(req.query.year, 10) : undefined

      return prisma.kitchenPayrollRun.findMany({
        where: {
          tenantId,
          ...(month !== undefined && { month }),
          ...(year !== undefined && { year }),
        },
        include: {
          staff: { select: { id: true, fullName: true, kitchenRole: true, skillLevel: true } },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }, { staff: { fullName: 'asc' } }],
      })
    },
  )

  // PATCH /payroll/runs/:id/lock
  fastify.patch<{ Params: { id: string } }>(
    '/payroll/runs/:id/lock',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!

      const run = await prisma.kitchenPayrollRun.findFirst({
        where: { id: req.params.id, tenantId },
      })
      if (!run) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payroll run not found' } })
      }

      return prisma.kitchenPayrollRun.update({
        where: { id: req.params.id },
        data: { status: 'locked' },
      })
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Labour cost dashboard
  // ──────────────────────────────────────────────────────────────────────────

  // GET /dashboard?month=N&year=N
  fastify.get<{ Querystring: { month?: string; year?: string } }>(
    '/dashboard',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const month = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1
      const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear()

      const [totalStaff, payrollRuns, violations, allStaff] = await Promise.all([
        prisma.kitchenStaff.count({ where: { tenantId, status: 'active' } }),
        prisma.kitchenPayrollRun.findMany({
          where: { tenantId, month, year },
          include: {
            staff: { select: { kitchenRole: true, skillLevel: true, monthlySalaryCash: true } },
          },
        }),
        prisma.complianceViolation.count({ where: { tenantId, resolvedAt: null } }),
        prisma.kitchenStaff.findMany({
          where: { tenantId, status: 'active' },
          select: { kitchenRole: true, skillLevel: true, monthlySalaryCash: true },
        }),
      ])

      const totalMonthlyCost = payrollRuns.reduce((s, r) => s + r.trueCostToCompany, 0)
      const totalOtPay = payrollRuns.reduce((s, r) => s + r.otPayRegular + r.otPayFestival, 0)
      const otPercent = totalMonthlyCost > 0 ? (totalOtPay / totalMonthlyCost) * 100 : 0

      // Headcount by role
      const headcountByRole: Record<string, number> = {}
      for (const s of allStaff) {
        headcountByRole[s.kitchenRole] = (headcountByRole[s.kitchenRole] ?? 0) + 1
      }

      // Avg salary by skill level
      const salaryBySkill: Record<string, { total: number; count: number }> = {}
      for (const s of allStaff) {
        if (!salaryBySkill[s.skillLevel]) salaryBySkill[s.skillLevel] = { total: 0, count: 0 }
        salaryBySkill[s.skillLevel]!.total += s.monthlySalaryCash
        salaryBySkill[s.skillLevel]!.count += 1
      }
      const avgSalaryBySkillLevel: Record<string, number> = {}
      for (const [level, { total, count }] of Object.entries(salaryBySkill)) {
        avgSalaryBySkillLevel[level] = count > 0 ? Math.round(total / count) : 0
      }

      return {
        month,
        year,
        totalStaff,
        totalMonthlyCost: Math.round(totalMonthlyCost),
        otPercent: Math.round(otPercent * 100) / 100,
        headcountByRole,
        avgSalaryBySkillLevel,
        complianceViolationCount: violations,
      }
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Compliance
  // ──────────────────────────────────────────────────────────────────────────

  // GET /compliance
  fastify.get<{ Querystring: { staffId?: string; resolved?: string } }>(
    '/compliance',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId!
      const { staffId, resolved } = req.query

      const resolvedFilter =
        resolved === 'true' ? { resolvedAt: { not: null } } :
        resolved === 'false' ? { resolvedAt: null } :
        {}

      return prisma.complianceViolation.findMany({
        where: {
          tenantId,
          ...(staffId ? { staffId } : {}),
          ...resolvedFilter,
        },
        include: {
          staff: { select: { id: true, fullName: true, kitchenRole: true } },
        },
        orderBy: [
          { resolvedAt: 'asc' },  // nulls (unresolved) first in Postgres ASC NULLS FIRST
          { detectedAt: 'desc' },
        ],
      })
    },
  )

  // PATCH /compliance/:id/resolve
  fastify.patch<{ Params: { id: string } }>(
    '/compliance/:id/resolve',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId!

      const violation = await prisma.complianceViolation.findFirst({
        where: { id: req.params.id, tenantId },
      })
      if (!violation) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Violation not found' } })
      }

      return prisma.complianceViolation.update({
        where: { id: req.params.id },
        data: {
          resolvedAt: new Date(),
          resolvedBy: req.staffUser!.name ?? req.staffUser!.email,
        },
      })
    },
  )
}
