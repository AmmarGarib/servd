// Prisma client singleton — reused across hot reloads in dev and across
// invocations of a warm serverless function in prod.
//
// The schema lives in ../backend/prisma/schema.prisma (single source of
// truth); `postinstall` runs `prisma generate` against it, so this app
// never carries its own schema copy.
//
// DATABASE_URL should be the POOLED Neon connection string on Vercel
// (transaction pooling), not the direct one.
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/** True when this deployment has a database wired up. Ported routes fall
 *  back to the legacy API when it isn't (e.g. a preview deploy without
 *  secrets), so a half-configured gateway never breaks a surface. */
export const hasDatabase = Boolean(process.env.DATABASE_URL)
