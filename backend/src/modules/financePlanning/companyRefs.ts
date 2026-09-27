// Company-reference guards for the finance planning modules (allocations,
// projections, capex / capital ledger / pro-forma, fixed assets, opex).
//
// Every one of these screens takes ids from the client that point at rows
// owned by a company: a brand, a location, a staff member, a capex project, a
// bank account. The row being written belongs to exactly ONE company, and each
// referenced id must belong to that same company — otherwise GS Foods' capex
// ends up carrying a GSX Viva location, or an opex line gets paid from another
// company's bank account.
//
// Status codes follow CLAUDE.md's company-scope rules: a foreign row the caller
// is trying to READ or EDIT is a 404 (handled by the scoped lookups in each
// route), a foreign id being ATTACHED to a row is a 422.
//
// Candidates for lib/tenantScope.ts once that file is free to edit; they live
// here so the finance modules share one implementation.

import type { FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'

/** The operator's active company, or 422 — new rows must bind to one company. */
export function requireActiveCompany(req: FastifyRequest): string {
  const t = req.staffUser?.tenantId
  if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
  return t
}

/**
 * A brand being attached to a NEW row: it must belong to the operator's
 * ACTIVE company ('create' scope). 422 rather than the helper's 404 — the
 * row being created is the caller's own; the reference is what's wrong.
 */
export async function assertConceptAttachable(req: FastifyRequest, conceptId: string): Promise<{ id: string; tenantId: string | null }> {
  try {
    return await assertConceptOwned(req, conceptId, 'create')
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand does not belong to the active company', 422)
    }
    throw err
  }
}

/** 422 unless `conceptId` is a live brand of `tenantId`. */
export async function assertConceptOfCompany(tenantId: string | null, conceptId: string): Promise<void> {
  const ok = tenantId
    ? await prisma.concept.findFirst({ where: { id: conceptId, tenantId, deletedAt: null }, select: { id: true } })
    : null
  if (!ok) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand does not belong to this company', 422)
}

/** 422 unless `locationId` is a live location of `tenantId`. */
export async function assertLocationOfCompany(tenantId: string | null, locationId: string): Promise<void> {
  const ok = tenantId
    ? await prisma.location.findFirst({ where: { id: locationId, tenantId, deletedAt: null }, select: { id: true } })
    : null
  if (!ok) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location does not belong to this company', 422)
}

/** 422 unless `userId` is a (non-deleted) member of `tenantId`. */
export async function assertMemberOfCompany(tenantId: string | null, userId: string): Promise<void> {
  const ok = tenantId
    ? await prisma.user.findFirst({
        where: {
          id: userId,
          deletedAt: null,
          OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
        },
        select: { id: true },
      })
    : null
  if (!ok) throw new AppError('USER_NOT_IN_COMPANY', 'That person is not a member of this company', 422)
}

/** 422 unless `projectId` is a live capex project of `tenantId`. */
export async function assertCapexProjectOfCompany(tenantId: string | null, projectId: string): Promise<void> {
  const ok = tenantId
    ? await prisma.capexProject.findFirst({ where: { id: projectId, tenantId, deletedAt: null }, select: { id: true } })
    : null
  if (!ok) throw new AppError('PROJECT_NOT_IN_COMPANY', 'That capex project does not belong to this company', 422)
}

/** 422 unless `bankAccountId` is a bank account of `tenantId`. */
export async function assertBankAccountOfCompany(tenantId: string | null, bankAccountId: string): Promise<void> {
  const ok = tenantId
    ? await prisma.bankAccount.findFirst({ where: { id: bankAccountId, tenantId }, select: { id: true } })
    : null
  if (!ok) throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account does not belong to this company', 422)
}
