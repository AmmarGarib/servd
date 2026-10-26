// Correct a guest's phone or email (owner C20, 2026-10-26: "Managers may
// correct a guest's phone or email, with a reason, audited").
//
// POST /crm/customers/:id/contact { phone?, email?, reason ≥10 }
//
//   • Who: the manager tiers (MANAGERS — the CEO included); the '/crm' Module
//     Access rule applies on top. Only a guest the manager's companies have
//     served (ordered or booked at one of their brands; write scope) — any
//     other id is 404, so a foreign id never confirms the account exists.
//   • A customer account is servd-wide; the phone is its sign-in. So on a
//     change: every session of the customer is revoked, the changed
//     contact's verification is cleared (phoneVerifiedAt / emailVerifiedAt —
//     the guest proves the new one themselves next time), and a phone or email
//     already held by ANOTHER customer is refused (409 PHONE_TAKEN /
//     EMAIL_TAKEN). Only the Customer row is written — never a staff User.
//   • Nothing is sent to the old or the new contact.
//   • Audit `customer.contact_change` (category identity) with old → new, the
//     reason and the manager's role, under the manager's active company.
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { normaliseCustomerContact, phoneSpellings } from '../auth/service.js'
import { findCustomerInScope } from './customerScope.js'

export async function contactCorrectionRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/customers/:id/contact',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        phone:  z.string().trim().min(7).max(20).optional(),
        email:  z.string().trim().email().max(200).optional(),
        reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
      }).refine((b) => !!(b.phone || b.email), { message: 'Give the new phone or email' }).parse(req.body)

      const customer = await findCustomerInScope(req, req.params.id, 'write')

      const nextPhone = body.phone ? normaliseCustomerContact(body.phone.replace(/@/g, '')).contact : undefined
      const nextEmail = body.email ? body.email.toLowerCase() : undefined
      const phoneChanges = nextPhone !== undefined && nextPhone !== customer.phone
      const emailChanges = nextEmail !== undefined && nextEmail !== customer.email
      if (!phoneChanges && !emailChanges) {
        throw new AppError('CONTACT_UNCHANGED', 'That is already the guest\'s contact.', 409)
      }

      // Another customer already holds it (any stored spelling of the number;
      // deleted rows too — the unique index still counts them).
      if (phoneChanges) {
        const holder = await prisma.customer.findFirst({
          where: { id: { not: customer.id }, phone: { in: phoneSpellings(nextPhone!) } }, select: { id: true },
        })
        if (holder) throw new AppError('PHONE_TAKEN', 'Another guest account already uses that phone number.', 409)
      }
      if (emailChanges) {
        const holder = await prisma.customer.findFirst({
          where: { id: { not: customer.id }, email: { equals: nextEmail!, mode: 'insensitive' } }, select: { id: true },
        })
        if (holder) throw new AppError('EMAIL_TAKEN', 'Another guest account already uses that email.', 409)
      }

      // Conditional on the values just read, so two corrections never cross.
      let updated
      try {
        const claimed = await prisma.customer.updateMany({
          where: { id: customer.id, deletedAt: null, phone: customer.phone, email: customer.email },
          data: {
            ...(phoneChanges ? { phone: nextPhone, phoneVerifiedAt: null } : {}),
            ...(emailChanges ? { email: nextEmail, emailVerifiedAt: null } : {}),
          },
        })
        if (claimed.count === 0) throw new AppError('CONTACT_CHANGED', 'The guest\'s contact changed meanwhile — reload and try again.', 409)
        updated = await prisma.customer.findUniqueOrThrow({
          where: { id: customer.id },
          select: { id: true, name: true, phone: true, email: true, phoneVerifiedAt: true, emailVerifiedAt: true },
        })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError(phoneChanges ? 'PHONE_TAKEN' : 'EMAIL_TAKEN', 'Another guest account already uses that contact.', 409)
        }
        throw err
      }

      // The phone is the guest's sign-in: every session they hold ends now.
      await revokeAllForSubject(customer.id)

      await audit({
        category: 'identity',
        action: 'customer.contact_change',
        entity: 'Customer',
        entityId: customer.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email ?? null,
        tenantId: req.staffUser!.tenantId ?? null,
        before: { ...(phoneChanges ? { phone: customer.phone } : {}), ...(emailChanges ? { email: customer.email } : {}) },
        after: { ...(phoneChanges ? { phone: nextPhone } : {}), ...(emailChanges ? { email: nextEmail } : {}) },
        metadata: { reason: body.reason, actorRole: req.staffUser!.role, sessionsRevoked: true },
      })
      return updated
    },
  )
}
