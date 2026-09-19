// Floor-staff sign-in: a WhatsApp code instead of a password.
//
// The split these tests defend: a cashier / server / cook signs in with a code
// sent to their phone and has no usable password; everyone with company-wide
// scope signs in with a password and CANNOT trade it for a code.
//
// Both halves matter. The obvious one is that the code path works. The one
// worth the test file is the other direction — that adding a phone-based way
// in did not quietly become a way around the password for the accounts that
// reach money, payroll and the ledger.
//
// Requires a disposable database (DATABASE_URL must contain "test") and Redis,
// because the rate limiters are real here and a fake would test nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { findOtpLoginStaff, issueStaffSession, staffLogin } from '../src/modules/auth/service.js'
import { usesOtpLogin, OTP_LOGIN_ROLES, MANAGERS } from '../src/modules/auth/middleware.js'
import { normalisePhone, requestOtp, verifyOtp } from '../src/modules/auth/otp.js'

const CASHIER_PHONE = '03001234567'
const MANAGER_PHONE = '03009998888'
let tenantId: string
let cashierId: string
let managerId: string

async function makeUser(opts: { role: string; email: string; phone: string; password: string }) {
  const u = await prisma.user.create({
    data: {
      name: `Test ${opts.role}`,
      email: opts.email,
      password: await bcrypt.hash(opts.password, 4),
      role: opts.role as never,
      phone: opts.phone,
      isActive: true,
      accountStatus: 'active',
      tenantId,
    },
    select: { id: true },
  })
  return u.id
}

beforeAll(async () => {
  const t = await prisma.tenant.create({
    data: { name: 'OTP Login Test Co', slug: 'otp-login-test-co' },
    select: { id: true },
  })
  tenantId = t.id
  cashierId = await makeUser({ role: 'cashier', email: 'till@gsfoods.pk', phone: CASHIER_PHONE, password: 'CashierPass123!' })
  managerId = await makeUser({ role: 'manager', email: 'boss@gsfoods.pk', phone: MANAGER_PHONE, password: 'ManagerPass123!' })
})

afterAll(async () => {
  await prisma.phoneOtp.deleteMany({ where: { phone: { in: [normalisePhone(CASHIER_PHONE), normalisePhone(MANAGER_PHONE)] } } })
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

beforeEach(async () => {
  await prisma.phoneOtp.deleteMany({ where: { phone: { in: [normalisePhone(CASHIER_PHONE), normalisePhone(MANAGER_PHONE)] } } })
})

describe('which roles sign in how', () => {
  it('puts every floor role on codes and no one else', () => {
    for (const role of OTP_LOGIN_ROLES) expect(usesOtpLogin(role)).toBe(true)
    // The whole point of the split: nobody with company-wide scope is on it.
    for (const role of MANAGERS) expect(usesOtpLogin(role)).toBe(false)
    for (const role of ['finance', 'hr', 'procurement', 'marketing', 'brand_manager']) {
      expect(usesOtpLogin(role)).toBe(false)
    }
  })

  it('treats a missing or unknown role as password-only', () => {
    // Fail CLOSED. A role this code has never heard of must not fall through
    // into the weaker credential.
    expect(usesOtpLogin(null)).toBe(false)
    expect(usesOtpLogin(undefined)).toBe(false)
    expect(usesOtpLogin('some_new_role')).toBe(false)
  })
})

describe('finding the account a code should go to', () => {
  it('resolves a floor-staff phone however it was typed', async () => {
    // The same number is stored three different ways across the admin UI, the
    // signup form and the importer. All three must reach the same cashier.
    for (const written of ['03001234567', '+923001234567', '923001234567']) {
      const found = await findOtpLoginStaff(written)
      expect(found?.id).toBe(cashierId)
    }
  })

  it('refuses to resolve a manager, even though they have a phone on file', async () => {
    // This is the load-bearing one. If this returns the manager, a password
    // account just became reachable with a phone.
    expect(await findOtpLoginStaff(MANAGER_PHONE)).toBeNull()
  })

  it('refuses a number that belongs to nobody', async () => {
    expect(await findOtpLoginStaff('03335556666')).toBeNull()
  })

  it('refuses a suspended or deactivated cashier', async () => {
    await prisma.user.update({ where: { id: cashierId }, data: { accountStatus: 'suspended' } })
    expect(await findOtpLoginStaff(CASHIER_PHONE)).toBeNull()
    await prisma.user.update({ where: { id: cashierId }, data: { accountStatus: 'active', isActive: false } })
    expect(await findOtpLoginStaff(CASHIER_PHONE)).toBeNull()
    await prisma.user.update({ where: { id: cashierId }, data: { isActive: true } })
    expect((await findOtpLoginStaff(CASHIER_PHONE))?.id).toBe(cashierId)
  })

  it('refuses when two staff share one number', async () => {
    // Signing in would have to pick one of them arbitrarily, so it picks
    // neither. A data problem must not become a coin-flip about whose till
    // session it is.
    const twinId = await makeUser({ role: 'foh', email: 'twin@gsfoods.pk', phone: CASHIER_PHONE, password: 'TwinPass123!' })
    expect(await findOtpLoginStaff(CASHIER_PHONE)).toBeNull()
    await prisma.user.delete({ where: { id: twinId } })
    expect((await findOtpLoginStaff(CASHIER_PHONE))?.id).toBe(cashierId)
  })

  it('stops resolving the moment a cashier is promoted out of a floor role', async () => {
    // The code is re-checked against the CURRENT role at verify time, so a
    // promotion mid-shift closes the code path immediately rather than at the
    // end of the five-minute window.
    await prisma.user.update({ where: { id: cashierId }, data: { role: 'manager' } })
    expect(await findOtpLoginStaff(CASHIER_PHONE)).toBeNull()
    await prisma.user.update({ where: { id: cashierId }, data: { role: 'cashier' } })
  })
})

describe('the code itself', () => {
  it('signs a cashier in with a freshly issued code', async () => {
    await requestOtp({ phone: CASHIER_PHONE, purpose: 'staff_login' })
    const row = await prisma.phoneOtp.findFirst({
      where: { phone: normalisePhone(CASHIER_PHONE), purpose: 'staff_login' },
      orderBy: { createdAt: 'desc' },
    })
    expect(row).toBeTruthy()

    await expect(verifyOtp({ phone: CASHIER_PHONE, code: row!.code, purpose: 'staff_login' })).resolves.toBeDefined()

    const staff = await findOtpLoginStaff(CASHIER_PHONE)
    const session = issueStaffSession(staff!)
    expect(session.accessToken).toBeTruthy()
    expect(session.user.role).toBe('cashier')
  })

  it('will not accept a code issued for a different purpose', async () => {
    // A 2FA code, a phone-verification code and a sign-in code are all six
    // digits. Without the purpose check, one could be replayed as another.
    await requestOtp({ phone: CASHIER_PHONE, purpose: 'phone_verify' })
    const row = await prisma.phoneOtp.findFirst({
      where: { phone: normalisePhone(CASHIER_PHONE), purpose: 'phone_verify' },
      orderBy: { createdAt: 'desc' },
    })
    await expect(
      verifyOtp({ phone: CASHIER_PHONE, code: row!.code, purpose: 'staff_login' }),
    ).rejects.toThrow()
  })

  it('will not accept the same code twice', async () => {
    await requestOtp({ phone: CASHIER_PHONE, purpose: 'staff_login' })
    const row = await prisma.phoneOtp.findFirst({
      where: { phone: normalisePhone(CASHIER_PHONE), purpose: 'staff_login' },
      orderBy: { createdAt: 'desc' },
    })
    await expect(verifyOtp({ phone: CASHIER_PHONE, code: row!.code, purpose: 'staff_login' })).resolves.toBeDefined()
    await expect(verifyOtp({ phone: CASHIER_PHONE, code: row!.code, purpose: 'staff_login' })).rejects.toThrow()
  })

  it('will not accept an expired code', async () => {
    await requestOtp({ phone: CASHIER_PHONE, purpose: 'staff_login' })
    const row = await prisma.phoneOtp.findFirst({
      where: { phone: normalisePhone(CASHIER_PHONE), purpose: 'staff_login' },
      orderBy: { createdAt: 'desc' },
    })
    await prisma.phoneOtp.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(verifyOtp({ phone: CASHIER_PHONE, code: row!.code, purpose: 'staff_login' })).rejects.toThrow()
  })

  it('will not accept a wrong code', async () => {
    await requestOtp({ phone: CASHIER_PHONE, purpose: 'staff_login' })
    const row = await prisma.phoneOtp.findFirst({
      where: { phone: normalisePhone(CASHIER_PHONE), purpose: 'staff_login' },
      orderBy: { createdAt: 'desc' },
    })
    const wrong = row!.code === '000000' ? '111111' : '000000'
    await expect(verifyOtp({ phone: CASHIER_PHONE, code: wrong, purpose: 'staff_login' })).rejects.toThrow()
  })
})

describe('the password side stays password-only', () => {
  it('still signs a manager in with their password', async () => {
    const res = await staffLogin('boss@gsfoods.pk', 'ManagerPass123!')
    expect(res.twoFactorRequired).toBe(false)
    if (!res.twoFactorRequired) expect(res.user.role).toBe('manager')
  })

  it('returns a cashier a session object the route then refuses', async () => {
    // staffLogin itself is role-blind by design — the refusal lives in the
    // route so the password is still verified first and a floor address cannot
    // be identified by how fast it is rejected. What this pins down is that the
    // role is PRESENT on the result, because the route's guard reads it: if
    // this ever came back undefined the guard would silently never fire and
    // every cashier would keep a working password.
    const res = await staffLogin('till@gsfoods.pk', 'CashierPass123!')
    expect(res.twoFactorRequired).toBe(false)
    if (!res.twoFactorRequired) {
      expect(res.user.role).toBe('cashier')
      expect(usesOtpLogin(res.user.role)).toBe(true)
    }
  })

  it('rejects a wrong password for both sides', async () => {
    await expect(staffLogin('boss@gsfoods.pk', 'wrong')).rejects.toThrow()
    await expect(staffLogin('till@gsfoods.pk', 'wrong')).rejects.toThrow()
  })
})
