// backend/entrypoint.sh — the practice copy's boot check runs BEFORE any
// prisma migration (final gate, 2026-10-14). A live DATABASE_URL pasted into
// the practice .env must stop the container before `prisma migrate deploy`
// can apply this image's newer migrations to the live database.
//
// The real script runs against a scratch working directory: dist/src/lib/
// sandbox.js re-exports the real lib/sandbox.ts (through tsx), dist/src/
// index.js is a stub, and `npx` is a stub that records each call.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))
let dir = ''
const calls = () => (existsSync(join(dir, 'npx.log')) ? readFileSync(join(dir, 'npx.log'), 'utf8').trim().split('\n') : [])

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'servd-entrypoint-'))
  mkdirSync(join(dir, 'dist/src/lib'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  // The image's /app holds package.json ("type": "module") beside dist/.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n')
  writeFileSync(join(dir, 'dist/src/lib/sandbox.js'), `export * from ${JSON.stringify(join(backend, 'src/lib/sandbox.ts'))}\n`)
  writeFileSync(join(dir, 'dist/src/index.js'), `console.log('API started')\n`)
  writeFileSync(join(dir, 'bin/npx'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(dir, 'npx.log'))}\nexit 0\n`)
  chmodSync(join(dir, 'bin/npx'), 0o755)
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function run(env: Record<string, string>) {
  rmSync(join(dir, 'npx.log'), { force: true })
  return spawnSync('sh', [join(backend, 'entrypoint.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env['PATH']}`,
      NODE_PATH: join(backend, 'node_modules'),
      NODE_OPTIONS: `--import ${join(backend, 'node_modules/tsx/dist/esm/index.mjs')}`,
      ...env,
    },
  })
}

describe('entrypoint.sh: the practice boot check comes first', () => {
  it('a practice copy pointed at a live database stops before any prisma call', () => {
    const r = run({ SERVD_SANDBOX: '1', SERVD_PROD_HOSTS: 'db.live.example', DATABASE_URL: 'postgresql://u@db.live.example:5432/servd' })
    expect(r.status, r.stdout + r.stderr).not.toBe(0)
    expect(r.stderr).toMatch(/\[sandbox\] FATAL: .*DATABASE_URL points at a live host/)
    expect(calls()).toEqual([])
    expect(r.stdout).not.toMatch(/API started/)
  })

  it('a malformed flag (\'1 \') stops before any prisma call', () => {
    const r = run({ SERVD_SANDBOX: '1 ', DATABASE_URL: 'postgresql://u@db.practice.example/servd' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/must be exactly '1'/)
    expect(calls()).toEqual([])
  })

  it('a practice copy on its own database migrates and starts; live (flag unset) skips the check', () => {
    const ok = run({ SERVD_SANDBOX: '1', SERVD_PROD_HOSTS: 'db.live.example', DATABASE_URL: 'postgresql://u@db.practice.example/servd', REDIS_URL: 'redis://redis.practice.example:6379' })
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/practice-copy boot check[\s\S]*resolving 0_init[\s\S]*applying any new migrations[\s\S]*API started/)
    expect(calls()).toEqual(['prisma migrate resolve --applied 0_init', 'prisma migrate deploy'])
    const live = run({ DATABASE_URL: 'postgresql://u@db.live.example:5432/servd', SERVD_PROD_HOSTS: 'db.live.example' })
    expect(live.status, live.stdout + live.stderr).toBe(0)
    expect(live.stdout).not.toMatch(/practice-copy boot check/)
    expect(calls()).toEqual(['prisma migrate resolve --applied 0_init', 'prisma migrate deploy'])
  })
})
