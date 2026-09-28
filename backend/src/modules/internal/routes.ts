// Internal scheduler endpoints — the serverless replacement for the always-on
// BullMQ workers (see workers/registry.ts). Registered under /api/v1/internal.
//
//   GET|POST /cron/tick    run due tasks + drain the db job queues (45s budget)
//   GET      /cron/status  task last-run table + job counts per queue
//   GET|POST /cron/:name   run one task now (or drain one queue by name)
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends) or
// `x-cron-secret: <CRON_SECRET>`. With CRON_SECRET unset every route answers
// 503 — the scheduler is never open to the internet.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { runTick, runTask, cronStatus } from '../../workers/registry.js'
import { getJobsDriver } from '../../lib/jobs.js'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// Async hook: after sending, return the reply so Fastify stops the chain.
async function requireCronSecret(req: FastifyRequest, reply: FastifyReply) {
  const secret = process.env['CRON_SECRET']
  if (!secret) {
    return reply.code(503).send({
      error: 'CRON_NOT_CONFIGURED',
      message: 'CRON_SECRET is not set on this deployment, so the internal scheduler endpoints are disabled.',
    })
  }
  const auth = req.headers['authorization']
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
  const header = req.headers['x-cron-secret']
  const given = bearer ?? (typeof header === 'string' ? header : null)
  if (!given || !safeEqual(given, secret)) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or missing cron secret.' })
  }
}

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  const opts = { config: { rateLimit: false }, preHandler: requireCronSecret } as const

  // Under the bullmq driver (Docker) the always-on workers own scheduling; a
  // tick would run every sweep a second time. Single tasks may still be run.
  const tick = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (getJobsDriver() !== 'db') {
      return reply.code(409).send({
        error: 'WRONG_JOBS_DRIVER',
        message: 'This deployment runs the BullMQ workers (JOBS_DRIVER=bullmq); the scheduler tick is for the db driver only.',
      })
    }
    return runTick({ budgetMs: 45_000 })
  }
  fastify.get('/cron/tick', opts, tick)
  fastify.post('/cron/tick', opts, tick)

  fastify.get('/cron/status', opts, async () => cronStatus())

  const one = async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    try {
      return await runTask(req.params.name)
    } catch (err) {
      if ((err as { code?: string }).code === 'UNKNOWN_TASK') {
        return reply.code(404).send({ error: 'UNKNOWN_TASK', message: (err as Error).message })
      }
      throw err
    }
  }
  fastify.get<{ Params: { name: string } }>('/cron/:name', opts, one)
  fastify.post<{ Params: { name: string } }>('/cron/:name', opts, one)
}
