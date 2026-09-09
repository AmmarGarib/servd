import { PrismaClient } from './gen/index.js'
const p = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
p.$on('query', e => console.log('SQL:', e.query, '| params:', e.params))
await p.user.deleteMany()
await p.user.createMany({ data: [
  { name: 'Ayesha Khan', email: 'a@x.com', pin: 'h1' },
  { name: 'Bilal Raza', email: 'b@x.com', pin: 'h2' },
  { name: 'Chef Omar', email: 'c@x.com', pin: 'h3' },
]})
for (const id of ['%', 'ayesha khan', '%a%', 'Z']) {
  const rows = await p.user.findMany({
    where: { isActive: true, pin: { not: null }, OR: [ { email: id.toLowerCase() }, { name: { equals: id, mode: 'insensitive' } } ] },
    select: { name: true },
  })
  console.log('IDENT', JSON.stringify(id), '=> matched', rows.length, rows.map(r=>r.name))
}
await p.$disconnect()
