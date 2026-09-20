'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import Link from 'next/link'

// WhatsApp gateway settings.
//
// This screen exists because these two values used to live only in an env file
// on the production box. While they were blank, customer signup, password
// reset and staff code sign-in were all down at once — and the person who owned
// the credentials could not apply them without a text editor on a Windows
// machine. Config the operator owns should be changeable by the operator.
interface Status {
  apiUrl: string
  apiKeyHint: string
  source: 'database' | 'environment' | 'unset'
  configured: boolean
}

export default function WhatsappSettingsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: () => api.get<Status>('/auth/integrations/whatsapp'),
  })

  const [apiUrl, setApiUrl] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; sentTo?: string } | null>(null)

  // null means "not edited yet" so the field can show the saved value without
  // fighting the user's typing once they start.
  const urlValue = apiUrl ?? data?.apiUrl ?? ''

  const save = useMutation({
    mutationFn: () => api.put('/auth/integrations/whatsapp', {
      apiUrl: urlValue,
      // Only send the key when one was typed — otherwise saving a URL change
      // would wipe a key the screen never displays.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }),
    onSuccess: () => { setApiKey(''); qc.invalidateQueries({ queryKey: ['whatsapp-config'] }) },
  })

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; sentTo?: string }>(
      '/auth/integrations/whatsapp/test', { phone: testPhone },
    ),
    onSuccess: (r) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, error: e.message }),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/configuration" className="text-xs text-s-muted hover:text-s-text">← Configuration</Link>
        <h1 className="text-xl font-bold text-s-text">WhatsApp</h1>
        <p className="text-xs text-s-muted mt-1">
          The gateway that sends signup codes, password resets and staff sign-in codes.
          Without it, nobody can create an account.
        </p>
      </header>

      <div className="p-6 max-w-2xl mx-auto space-y-4">
        {isLoading && <p className="text-xs text-s-muted">Loading…</p>}

        {data && (
          <div className={`s-card p-4 ${data.configured ? 'border-emerald-300' : 'border-red-300'}`}>
            <p className="text-sm font-semibold text-s-text">
              {data.configured ? 'Gateway configured' : 'Not configured — signup is down'}
            </p>
            <p className="text-xs text-s-muted mt-1">
              {data.source === 'database' && 'Set here, in admin.'}
              {data.source === 'environment' && 'Set in the server environment. Saving below overrides it.'}
              {data.source === 'unset' && 'No endpoint anywhere. Customers cannot sign up and nobody can reset a password.'}
            </p>
          </div>
        )}

        <div className="s-card p-4 space-y-4">
          <div>
            <label htmlFor="wa-url" className="block text-xs font-semibold text-s-muted mb-1">ENDPOINT</label>
            <input
              id="wa-url"
              value={urlValue}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://whatsapp.garibsons.app/webhook/xxxxxxxx/send"
              className="w-full px-3 py-2 rounded border border-s-border bg-white text-s-text font-mono text-xs"
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
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.apiKeyHint ? `Saved (${data.apiKeyHint}) — leave blank to keep` : 'sk-…'}
              className="w-full px-3 py-2 rounded border border-s-border bg-white text-s-text font-mono text-xs"
            />
            <p className="text-[11px] text-s-muted mt-1">
              Never shown again once saved. Leave blank to change the endpoint without re-typing it.
            </p>
          </div>

          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-4 py-2 rounded bg-black text-white text-sm font-semibold disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span className="ml-3 text-xs text-emerald-700">Saved. Takes effect within 30 seconds.</span>}
          {save.isError && <span className="ml-3 text-xs text-red-700">{(save.error as Error).message}</span>}
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
              className="flex-1 px-3 py-2 rounded border border-s-border bg-white text-s-text text-sm"
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
            <p className={`text-xs ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
              {testResult.ok
                ? `Sent to …${testResult.sentTo?.slice(-4) ?? ''}. Check the phone.`
                /* The gateway's own words: "not ready (INITIALIZING)" means scan
                   the QR; "Invalid API key" means the key is wrong. */
                : `Failed — ${testResult.error}`}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
