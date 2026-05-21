// Mark GS x Viva (Clifton) as a JV with Viva 60% + Garibsons 40%.
// Idempotent — updates the row each run.
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
;(async () => {
  await p.tenant.update({
    where: { slug: 'gs-x-viva-clifton' },
    data: {
      isJointVenture: true,
      jvPartners: [
        { label: 'Viva',      pct: 60 },
        { label: 'Garibsons', pct: 40 },
      ],
    },
  })
  // GS Foods (Bukhari) is wholly-owned — clear any JV flag if it was ever set.
  await p.tenant.update({
    where: { slug: 'gs-foods-bukhari' },
    data: { isJointVenture: false, jvPartners: undefined },
  })
  console.log('OK — GS x Viva flagged as JV with Viva 60 / Garibsons 40 split')
  await p.$disconnect()
})()
