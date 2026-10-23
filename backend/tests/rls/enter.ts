// Side-effect module: MUST be the first import of tests/setup.ts. Under
// TEST_RLS=1 it points DATABASE_URL at the plain app role and sets
// RLS_ENFORCE=1 before anything imports src/lib/prisma.ts (which reads both
// once, when it is first evaluated — setup's own imports reach it).
import { isRlsMode, enterRlsMode } from './rlsMode.js'

if (isRlsMode()) enterRlsMode()
