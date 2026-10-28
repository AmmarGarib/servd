// Staff WhatsApp-code sign-in is RETIRED (owner, 2026-10-28: "No WhatsApp code for anyone anymore. Gsfoods.pk email
// and Password for everyone"). This file used to defend the code path for floor staff; it now defends its removal:
//   - no staff role signs in with a code (usesOtpLogin is false for every role, OTP_LOGIN_ROLES is empty)
//   - the code lookup finds nobody, even a cashier with a phone on file
//   - a cashier signs in with their @gsfoods.pk email and password, exactly like a manager
//   - the floor CATEGORY stays (HR's active-at-once invites and approvals read FLOOR_ROLES)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { findOtpLoginStaff, staffLogin } from '../src/modules/auth/service.js'
import { usesOtpLogin, OTP_LOGIN_ROLES, FLOOR_ROLES, isFloorRole } from '../src/modules/auth/middleware.js'
import { ALL_ROLES } from '../src/lib/roles.js'

const CASHIER_PHONE = '03001234567'
let tenantId: string

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Code Retired Co', slug: 'code-retired-co' }, select: { id: true } })).id
  await prisma.user.create({
    data: {
      name: 'Till', email: 'till.retired@gsfoods.pk', password: await bcrypt.hash('CashierPass123!', 4), role: 'cashier',
      phone: CASHIER_PHONE, isActive: true, accountStatus: 'active', tenantId,
    },
  })
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

describe('staff code sign-in is retired', () => {
  it('no role signs in with a code; the floor category is unchanged', () => {
    expect(OTP_LOGIN_ROLES).toEqual([])
    for (const r of ALL_ROLES) expect(usesOtpLogin(r), r).toBe(false)
    expect(FLOOR_ROLES).toEqual(['cashier', 'foh', 'boh', 'kitchen', 'expediter'])
    expect(isFloorRole('cashier')).toBe(true)
    expect(isFloorRole('manager')).toBe(false)
  })

  it('the code lookup finds nobody, even a cashier with that phone', async () => {
    expect(await findOtpLoginStaff(CASHIER_PHONE)).toBeNull()
  })

  it('a cashier signs in with email and password', async () => {
    const s = await staffLogin('till.retired@gsfoods.pk', 'CashierPass123!')
    expect(s.user.role).toBe('cashier')
    await expect(staffLogin('till.retired@gsfoods.pk', 'wrong-password-123')).rejects.toBeTruthy()
  })
})
