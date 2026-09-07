// Generate the Prisma client INTO THIS app's node_modules.
//
// `prisma generate --schema ../backend/prisma/schema.prisma` writes the
// client next to the schema's own node_modules (backend/), leaving this
// app with the untyped stub. So: copy the schema in here (untracked —
// backend/prisma/schema.prisma stays the single source of truth), then
// generate against the local copy so output resolves to our node_modules.
import { cpSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const source = join(appRoot, '..', 'backend', 'prisma', 'schema.prisma')
const localDir = join(appRoot, 'prisma')

mkdirSync(localDir, { recursive: true })
cpSync(source, join(localDir, 'schema.prisma'))
execSync('npx prisma generate', { cwd: appRoot, stdio: 'inherit' })
