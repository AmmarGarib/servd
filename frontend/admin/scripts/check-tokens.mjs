// Fails when a page uses an `s-*` colour that tailwind.config.ts does not define (owner, 2026-10-26:
// `bg-s-card` was used everywhere but never defined, so dropdown menus had no background and the page
// showed through them). Run: node scripts/check-tokens.mjs  (docs/UI_CHECKLIST.md, CI).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const cfg = readFileSync('tailwind.config.ts', 'utf8')
let blk = cfg.slice(cfg.indexOf('        s: {'))
blk = blk.slice(0, blk.indexOf('\n        },'))
const keys = new Set([...blk.matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]))
const files = []
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(f)) files.push(p) } }
walk('src')
const bad = []
const re = /\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|placeholder|accent|decoration)-s-([a-z]+(?:-[a-z]+)*)/g
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(re)) if (!keys.has(m[1])) bad.push(`${f}: ${m[0]}`)
if (bad.length) { console.error('Undefined s-* colours (add them to tailwind.config.ts or use an existing token):\n' + bad.join('\n')); process.exit(1) }
console.log(`s-* colours OK (${files.length} files)`)
