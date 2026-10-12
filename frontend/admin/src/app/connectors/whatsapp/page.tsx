'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { ApiError } from '../../../lib/api'
import { connectorsApi, connectorErrorText, fetchHealth, type WhatsappStatus } from '../../../lib/connectorsApi'
import { Badge, Banner, Dot, fmtWhen } from '../../../components/connectors/ui'

// Dev → API → WhatsApp connector (moved here from /configuration/whatsapp,
// which now redirects; same endpoints: /auth/integrations/whatsapp*).
//
// This screen exists because these two values used to live only in an env file
// on the production box. While they were blank, customer signup, password
// reset and staff code sign-in were all down at once — and the person who owned
// the credentials could not apply them without a text editor on a Windows
// machine. Config the operator owns should be changeable by the operator.
//
// PLATFORM-WIDE: GS Foods runs one WhatsApp gateway for every company (owner
// flag c). It is deliberately not per company.

// How the saved gateway key is held (GET /auth/integrations/whatsapp
// `keyAtRest`, backend lib/whatsapp.ts): sealed with SERVD_SECRET_KEY, still
// plaintext (the server has no SERVD_SECRET_KEY — it is sealed on the first
// read once the key is set), or sealed but unreadable here (the server lost
// the key it was sealed with). Absent on an API from before W2.
type KeyAtRest = 'none' | 'encrypted' | 'plaintext' | 'unreadable'
type WhatsappView = WhatsappStatus & { keyAtRest?: KeyAtRest }

const KEY_AT_REST: Record<KeyAtRest, { tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string; detail: string }> = {
  none: { tone: 'muted', label: 'No key saved here', detail: 'No API key is saved in admin; the server environment’s key is used if it has one.' },
  encrypted: { tone: 'ok', label: 'Key encrypted at rest', detail: 'The saved API key is encrypted with the server’s secret key.' },
  plaintext: {
    tone: 'warn',
    label: 'Key stored unencrypted',
    detail: 'The server has no SERVD_SECRET_KEY, so the saved API key is held in plain text. Ask IT to set SERVD_SECRET_KEY on the box; the key is encrypted on the next read. Sending still works.',
  },
  unreadable: {
    tone: 'bad',
    label: 'Key unreadable on this server',
    detail: 'The saved key was encrypted with a SERVD_SECRET_KEY this server does not have. Codes only send if the server environment has its own WHATSAPP_API_KEY. Restore the original SERVD_SECRET_KEY on the box, or set a SERVD_SECRET_KEY and then re-enter the API key here (saving needs SERVD_SECRET_KEY).',
  },
}

/**
 * Which 'unreadable' case applies, from /health `connectorSecretKey` (backend
 * connectors/health.ts): 'ok' = this server HAS a SERVD_SECRET_KEY, just not
 * the one the key was sealed with, so re-entering the key here works; any
 * other answer = the box has no usable SERVD_SECRET_KEY, so a save would fail
 * with 503 SECRET_KEY_MISSING until IT sets one. null = cannot tell.
 */
function unreadableCase(checks: Record<string, string> | undefined): string | null {
  const c = checks?.['connectorSecretKey']
  if (!c) return null
  return c === 'ok'
    ? 'This server has a different SERVD_SECRET_KEY: re-enter the API key below to seal it with the current one (or restore the original key on the box).'
    : 'This server has no usable SERVD_SECRET_KEY, so saving a key here will fail until IT sets SERVD_SECRET_KEY on the box (ideally the original one, which makes the saved key readable again).'
}

// /health checks that depend on the gateway (backend/src/index.ts).
const HEALTH_CHECKS: Array<{ key: string; label: string }> = [
  { key: 'customerSignup', label: 'Customer signup (storefront codes)' },
  { key: 'staffCodeLogin', label: 'Staff code sign-in' },
  { key: 'passwordRecovery', label: 'Password recovery' },
]

export default function WhatsappSettingsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<WhatsappView>({
    queryKey: ['whatsapp-config'],
    queryFn: connectorsApi.whatsapp,
    retry: false,
  })
  const delivery = useQuery({ queryKey: ['delivery-status'], queryFn: connectorsApi.deliveryStatus, retry: false })
  const health = useQuery({ queryKey: ['public-health'], queryFn: fetchHealth, refetchInterval: 60_000 })

  const [apiUrl, setApiUrl] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; sentTo?: string } | null>(null)

  // null means "not edited yet" so the field can show the saved value without
  // fighting the user's typing once they start.
  const urlValue = apiUrl ?? data?.apiUrl ?? ''

  const save = useMutation({
    mutationFn: () => connectorsApi.saveWhatsapp({
      apiUrl: urlValue,
      // Only send the key when one was typed — otherwise saving a URL change
      // would wipe a key the screen never displays.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }),
    onSuccess: () => {
      setApiKey('')
      void qc.invalidateQueries({ queryKey: ['whatsapp-config'] })
      void qc.invalidateQueries({ queryKey: ['public-health'] })
    },
  })

  const test = useMutation({
    mutationFn: () => connectorsApi.testWhatsapp(testPhone),
    onSuccess: (r) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, error: e.message }),
  })

  const check = useMutation({
    mutationFn: connectorsApi.checkDelivery,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['delivery-status'] }),
  })

  const forbidden = error instanceof ApiError && error.status === 403

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4">
        <Link href="/connectors" className="text-xs text-s-muted hover:text-s-text">← API</Link>
        <h1 className="text-xl font-bold text-s-text">WhatsApp connector</h1>
        <p className="text-xs text-s-muted mt-1">
          The gateway that sends signup codes, password resets, staff sign-in codes and order messages.
          Without it, nobody can create an account.
        </p>
      </header>

      <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-4">
        <Banner tone="info" title="Platform-wide: one gateway for every company">
          <p>Every company on servd sends through this one GS Foods gateway. Changing it here changes it for all of them.</p>
        </Banner>

        {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
        {error && (
          <Banner tone="bad" title={forbidden ? 'The CEO and IT configure the WhatsApp gateway' : 'Could not load the gateway settings'}>
            {!forbidden && <p>{connectorErrorText(error)}</p>}
          </Banner>
        )}

        {data && (
          <div className={`s-card p-4 ${data.configured ? 'border-s-green/40' : 'border-s-red/40'}`}>
            <p className={`text-sm font-semibold ${data.configured ? 'text-s-text' : 'text-s-red'}`}>
              {data.configured ? 'Gateway configured' : 'Not configured — signup is down'}
            </p>
            <p className="text-xs text-s-muted mt-1">
              {data.source === 'database' && 'Set here, in admin.'}
              {data.source === 'environment' && 'Set in the server environment. Saving below overrides it.'}
              {data.source === 'unset' && 'No endpoint anywhere. Customers cannot sign up and nobody can reset a password.'}
            </p>
            {data.keyAtRest && (
              <div className="mt-2 text-xs">
                <Badge tone={KEY_AT_REST[data.keyAtRest].tone}>{KEY_AT_REST[data.keyAtRest].label}</Badge>
                {data.keyAtRest !== 'encrypted' && <p className="mt-1 text-s-muted">{KEY_AT_REST[data.keyAtRest].detail}</p>}
                {data.keyAtRest === 'unreadable' && unreadableCase(health.data?.checks) && (
                  <p className="mt-1 text-s-text">{unreadableCase(health.data?.checks)}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="s-card p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-s-text">Delivery check</p>
              <p className="text-xs text-s-muted">A watchdog sends a probe every few minutes and alerts when codes stop arriving.</p>
            </div>
            <button onClick={() => check.mutate()} disabled={check.isPending} className="s-btn-secondary text-xs">
              {check.isPending ? 'Checking…' : 'Check now'}
            </button>
          </div>
          {delivery.data && (
            <div className="text-xs space-y-1">
              <Dot tone={delivery.data.ok ? 'ok' : 'bad'} label={delivery.data.ok ? 'Codes are sending' : 'Delivery problem'} />
              <p className="text-s-text">{delivery.data.detail}</p>
              {delivery.data.fix && <p className="text-s-text"><strong>Fix:</strong> {delivery.data.fix}</p>}
              <p className="text-s-muted">Last checked {fmtWhen(delivery.data.checkedAt)}.</p>
            </div>
          )}
          {delivery.error && <p className="text-xs text-s-muted">{connectorErrorText(delivery.error)}</p>}
          {check.error && <p className="text-xs text-s-red">{connectorErrorText(check.error)}</p>}
        </div>

        <div className="s-card p-4 space-y-2">
          <p className="text-sm font-semibold text-s-text">What depends on it (live server checks)</p>
          {health.data === null && <p className="text-xs text-s-muted">The server health check could not be reached.</p>}
          {health.data && HEALTH_CHECKS.map((c) => {
            const v = health.data?.checks[c.key]
            const tone = v === 'ok' ? 'ok' : v === 'warn' ? 'warn' : v ? 'bad' : 'muted'
            return (
              <div key={c.key} className="text-xs">
                <div className="flex items-center gap-2">
                  <Badge tone={tone}>{v ?? 'unknown'}</Badge>
                  <span className="text-s-text">{c.label}</span>
                </div>
                {health.data?.details[c.key] && <p className="mt-0.5 text-s-muted">{health.data.details[c.key]}</p>}
              </div>
            )
          })}
        </div>

        <div className="s-card p-4 space-y-4">
          <div>
            <label htmlFor="wa-url" className="block text-xs font-semibold text-s-muted mb-1">ENDPOINT</label>
            <input
              id="wa-url"
              value={urlValue}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://whatsapp.garibsons.app/webhook/xxxxxxxx/send"
              className="w-full px-3 py-2 rounded border border-s-border bg-s-surface text-s-text font-mono text-xs"
            />
            <p className="text-[11px] text-s-muted mt-1">
              Copy from the gateway&rsquo;s <strong>API Info</strong> tab. The app there must show
              <strong> Connected</strong> — if it says Connecting, scan its QR code first or no code will send.
            </p>
          </div>

          <div>
            <label htmlFor="wa-key" className="block text-xs font-semibold text-s-muted mb-1">API KEY</label>
            <input
              id="wa-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.apiKeyHint ? `Saved (${data.apiKeyHint}) — leave blank to keep` : 'sk-…'}
              className="w-full px-3 py-2 rounded border border-s-border bg-s-surface text-s-text font-mono text-xs"
            />
            <p className="text-[11px] text-s-muted mt-1">
              Never shown again once saved (encrypted when the server has SERVD_SECRET_KEY). Leave blank to change the endpoint without re-typing it.
            </p>
          </div>

          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || forbidden}
            className="px-4 py-2 rounded bg-secondary text-secondary-on text-sm font-semibold disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span className="ml-3 text-xs text-s-green">Saved. Takes effect within 30 seconds.</span>}
          {save.isError && <span className="ml-3 text-xs text-s-red">{connectorErrorText(save.error)}</span>}
        </div>

        <div className="s-card p-4 space-y-3">
          <p className="text-sm font-semibold text-s-text">Send a test message</p>
          <p className="text-xs text-s-muted">
            Proves the whole chain before a customer finds out it is broken.
          </p>
          <div className="flex gap-2">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="03001234567"
              aria-label="Phone number to test"
              className="flex-1 min-w-0 px-3 py-2 rounded border border-s-border bg-s-surface text-s-text text-sm"
            />
            <button
              onClick={() => { setTestResult(null); test.mutate() }}
              disabled={test.isPending || testPhone.trim().length < 7}
              className="px-4 py-2 rounded border border-s-border text-sm font-semibold text-s-text disabled:opacity-50"
            >
              {test.isPending ? 'Sending…' : 'Send test'}
            </button>
          </div>
          {testResult && (
            <p className={`text-xs ${testResult.ok ? 'text-s-green' : 'text-s-red'}`}>
              {testResult.ok
                ? `Sent to …${testResult.sentTo?.slice(-4) ?? ''}. Check the phone.`
                /* The gateway's own words: "not ready (INITIALIZING)" means scan
                   the QR; "Invalid API key" means the key is wrong. */
                : `Failed — ${testResult.error}`}
            </p>
          )}
        </div>

        <p className="text-[11px] text-s-muted px-1">
          Inbound WhatsApp (customers and suppliers messaging you on the Meta Cloud API) is separate and not configured here: it is verified with
          <code className="bg-s-border px-1 rounded mx-1">WHATSAPP_VERIFY_TOKEN</code> and
          <code className="bg-s-border px-1 rounded mx-1">APP_SECRET</code> in the backend environment.
        </p>
      </div>
    </div>
  )
}
