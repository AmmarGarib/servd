// Head office (D1/D3) plugins in one place: the CEO's head-office pages and
// the one-time setup under /head-offices, and the monthly recharge runs under
// /accounting/intercompany/recharge-runs (inside the '/accounting' module gate).

import type { FastifyInstance } from 'fastify'
import { headOfficeRoutes } from './routes.js'
import { headOfficeSetupRoutes } from './setup.js'
import { rechargeRunRoutes } from './runRoutes.js'

export async function registerHeadOfficePlugins(api: FastifyInstance): Promise<void> {
  await api.register(headOfficeRoutes, { prefix: '/head-offices' })
  await api.register(headOfficeSetupRoutes, { prefix: '/head-offices' })
  await api.register(rechargeRunRoutes, { prefix: '/accounting/intercompany/recharge-runs' })
}
