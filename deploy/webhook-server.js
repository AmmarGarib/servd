'use strict';
/**
 * Servd auto-deploy webhook server.
 *
 * Runs on the Windows host (not inside Docker).
 * Start it with:  start-webhook.bat
 *
 * Trigger a redeploy (same as running deploy.bat):
 *   POST https://servd-deploy.garibsons.app/deploy?secret=<WEBHOOK_SECRET>
 *   POST https://servd-deploy.garibsons.app/deploy  + header X-Deploy-Secret: <secret>
 *
 * Check status:
 *   GET https://servd-deploy.garibsons.app/health
 */

const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Constant-time secret comparison — `!==` leaks where the mismatch occurs,
// letting an attacker brute-force the secret character-by-character.
function secretMatches(incoming, expected) {
  const a = Buffer.from(String(incoming), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const PORT       = parseInt(process.env.WEBHOOK_PORT || '9000', 10);
const SECRET     = (process.env.WEBHOOK_SECRET || '').trim();
const DEPLOY_DIR = __dirname;                        // deploy/
const PROJECT_DIR = path.resolve(__dirname, '..');   // project root

let deploying        = false;
let lastDeployTime   = null;
let lastDeployStatus = 'never';

// ─── Run a shell command, stream output to this console ──────────────────────
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`\n  > ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: true,   // required on Windows for git / docker
    });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`exit code ${code}`))
    );
    proc.on('error', err => reject(new Error(`spawn error: ${err.message}`)));
  });
}

// ─── Deploy sequence — mirrors deploy.bat exactly ────────────────────────────
async function runDeploy() {
  deploying      = true;
  lastDeployTime = new Date().toISOString();

  console.log('\n' + '═'.repeat(56));
  console.log(`  DEPLOY STARTED  ${lastDeployTime}`);
  console.log('═'.repeat(56));

  try {
    // Step 1: sync root .env → deploy/.env.production
    const rootEnv   = path.join(PROJECT_DIR, '.env');
    const prodEnv   = path.join(DEPLOY_DIR,  '.env.production');
    if (fs.existsSync(rootEnv)) {
      fs.copyFileSync(rootEnv, prodEnv);
      console.log('\n  [OK] .env synced to deploy/.env.production');
    }

    // Step 2: hard-reset working tree to origin/main. Using `git pull` left
    // us stuck when the local checkout was on a different branch or had a
    // dirty state — silently "up to date" while origin/main had new commits.
    console.log('\n  [1/2] git fetch + reset --hard origin/main...');
    await run('git', ['fetch', 'origin', 'main'], PROJECT_DIR);
    await run('git', ['reset', '--hard', 'origin/main'], PROJECT_DIR);
    await run('git', ['log', '--oneline', '-1'], PROJECT_DIR);

    // Step 3: rebuild + force-recreate so env changes and source updates
    // both take effect, even if docker would otherwise reuse a cached image
    // or skip a container restart.
    console.log('\n  [2/2] docker compose up --build --force-recreate...');
    await run('docker', ['compose', 'up', '-d', '--build', '--force-recreate'], DEPLOY_DIR);

    lastDeployStatus = 'success';
    console.log('\n' + '═'.repeat(56));
    console.log('  DEPLOY COMPLETE');
    console.log('═'.repeat(56) + '\n');
  } catch (err) {
    lastDeployStatus = `failed: ${err.message}`;
    console.error('\n' + '═'.repeat(56));
    console.error(`  DEPLOY FAILED: ${err.message}`);
    console.error('═'.repeat(56) + '\n');
  } finally {
    deploying = false;
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', deploying, lastDeployTime, lastDeployStatus }, null, 2));
    return;
  }

  // POST /deploy
  if (req.method === 'POST' && url.pathname === '/deploy') {
    const incoming = (
      (req.headers['x-deploy-secret'] || '') ||
      // Deprecated: query-string secrets leak into proxy/access logs. Send
      // X-Deploy-Secret instead; this fallback remains only until the CI
      // secret is rotated to the header form.
      (url.searchParams.get('secret')  || '')
    ).trim();

    // Fail CLOSED: no configured secret means no deploys — previously an
    // unset WEBHOOK_SECRET silently disabled auth entirely.
    if (!SECRET) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('503 — WEBHOOK_SECRET not configured; refusing deploys\n');
      return;
    }
    if (!secretMatches(incoming, SECRET)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden — wrong or missing secret\n');
      return;
    }

    if (deploying) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('409 — deploy already running, try again shortly\n');
      return;
    }

    res.writeHead(202, { 'Content-Type': 'text/plain' });
    res.end('202 — deploy started! Check GET /health for status.\n');
    runDeploy().catch(() => {});
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not found\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(56));
  console.log('  Servd Webhook Server');
  console.log('═'.repeat(56));
  console.log(`  Port    : ${PORT}`);
  console.log(`  Secret  : ${SECRET ? '(set ✓)' : 'NOT SET — unprotected!'}`);
  console.log('');
  console.log('  POST /deploy?secret=<secret>   trigger redeploy');
  console.log('  GET  /health                   check status');
  console.log('═'.repeat(56) + '\n');
});
