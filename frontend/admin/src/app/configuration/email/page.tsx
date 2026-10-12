'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import Link from 'next/link'

// Email (SMTP) settings — the SECOND delivery channel.
//
// WhatsApp is a linked web session and those drop. When one does, signup,
// password reset and staff sign-in stop together, because today there is
// nothing else to reach anyone with. This is that something else.
interface Status {
  host: string; port: string; user: string; from: string
  passSet: boolean
  effective: { host: string; port: number; user: string; from: string }
  configured: boolean
}

// Who (mirrors auth/routes.ts): the CEO and IT READ it — IT only while it
// holds module `api_whatsapp` (the sidebar puts Email under it, Dev → API); only the CEO SAVES or sends a test, because
// whoever sets the host receives the stored SMTP password and every company's
// reset mail. Everyone else is never sent here, so the page asks nothing of
// the API and says who to ask instead of a red 403.
export default function EmailSettingsPage() {
  const qc = useQueryClient()
  const { data: me, isLoading: meLoading } = usePermissions()
  const canEdit = me?.role === 'admin'
  const canRead = canEdit || (me?.role === 'it' && me.modules.includes('api_whatsapp'))
  const { data, isLoading } = useQuery({
    queryKey: ['email-config'],
    queryFn: () => api.get<Status>('/auth/integrations/email'),
    enabled: canRead,
  })

  const [f, setF] = useState<Partial<Record<'host'|'port'|'user'|'from'|'pass', string>>>({})
  const [testTo, setTestTo] = useState('')
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const v = (k: 'host'|'port'|'user'|'from') => f[k] ?? (data?.[k] || String(data?.effective?.[k] ?? ''))

  const save = useMutation({
    mutationFn: () => api.put('/auth/integrations/email', {
      host: v('host'), port: v('port'), user: v('user'), from: v('from'),
      // Only send a password when one was typed, so saving a host change does
      // not wipe a password the screen never displays.
      ...(f.pass?.trim() ? { pass: f.pass.trim() } : {}),
    }),
    onSuccess: () => { setF((p) => ({ ...p, pass: '' })); qc.invalidateQueries({ queryKey: ['email-config'] }) },
  })

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/auth/integrations/email/test', { to: testTo }),
    onSuccess: (r) => setResult(r),
    onError: (e: Error) => setResult({ ok: false, error: e.message }),
  })

  const Field = ({ k, label, hint, type = 'text', placeholder }: { k: 'host'|'port'|'user'|'from'|'pass'; label: string; hint?: string; type?: string; placeholder?: string }) => (
    <div>
      <label htmlFor={`smtp-${k}`} className="block text-xs font-semibold text-s-muted mb-1">{label}</label>
      <input
        id={`smtp-${k}`} type={type}
        value={k === 'pass' ? (f.pass ?? '') : v(k)}
        onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded border border-s-border bg-s-surface text-s-text font-mono text-xs"
      />
      {hint && <p className="text-[11px] text-s-muted mt-1">{hint}</p>}
    </div>
  )

  if (!meLoading && !canRead) {
    return (
      <div className="min-h-screen bg-s-bg p-6">
        <Link href="/configuration" className="text-xs text-s-muted hover:text-s-text">← Configuration</Link>
        <h1 className="text-xl font-bold text-s-text">Email</h1>
        <p className="text-sm text-s-muted mt-2">Email delivery is set up by the CEO and IT. Ask them if password-reset emails are not arriving.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/configuration" className="text-xs text-s-muted hover:text-s-text">← Configuration</Link>
        <h1 className="text-xl font-bold text-s-text">Email</h1>
        <p className="text-xs text-s-muted mt-1">
          The backup channel for codes and password resets, used when WhatsApp cannot deliver.
        </p>
      </header>

      <div className="p-6 max-w-2xl mx-auto space-y-4">
        {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
        {data && (
          <div className={`s-card p-4 ${data.configured ? 'border-emerald-300' : 'border-amber-300'}`}>
            <p className="text-sm font-semibold text-s-text">
              {data.configured ? 'Email configured' : 'No backup channel'}
            </p>
            <p className="text-xs text-s-muted mt-1">
              {data.configured
                ? 'If WhatsApp stops, password resets can still reach inboxes.'
                : 'WhatsApp is currently the only way to reach anyone. If its session drops, signup and password reset stop with it.'}
            </p>
          </div>
        )}

        {!canEdit && data && (
          <div className="s-card p-4 space-y-2">
            <p className="text-xs text-s-muted">Read-only. Only the CEO can change these settings or send a test email.</p>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
              <dt className="text-s-muted">SMTP host</dt><dd className="font-mono text-s-text">{v('host') || '—'}</dd>
              <dt className="text-s-muted">Port</dt><dd className="font-mono text-s-text">{v('port') || '—'}</dd>
              <dt className="text-s-muted">Username</dt><dd className="font-mono text-s-text">{v('user') || '—'}</dd>
              <dt className="text-s-muted">Password</dt><dd className="text-s-text">{data.passSet ? 'Saved' : 'Not set'}</dd>
              <dt className="text-s-muted">Send as</dt><dd className="font-mono text-s-text">{v('from') || '—'}</dd>
            </dl>
          </div>
        )}

        {canEdit && (<>
        <div className="s-card p-4 space-y-4">
          <Field k="host" label="SMTP HOST" placeholder="smtp.gmail.com" hint="Your mail provider's server address." />
          <Field k="port" label="PORT" placeholder="587" hint="587 for most providers; 465 if the provider says to use SSL." />
          <Field k="user" label="USERNAME" placeholder="noreply@gsfoods.pk" hint="Usually the full email address." />
          <Field k="pass" label="PASSWORD" type="password"
            placeholder={data?.passSet ? 'Saved — leave blank to keep' : 'app password'}
            hint="For Gmail or Google Workspace this is an app password, not the account password." />
          <Field k="from" label="SEND AS" placeholder="noreply@gsfoods.pk" hint="What customers see in the From line." />

          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="px-4 py-2 rounded bg-secondary text-secondary-on text-sm font-semibold disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span className="ml-3 text-xs text-emerald-700">Saved.</span>}
          {save.isError && <span className="ml-3 text-xs text-red-700">{(save.error as Error).message}</span>}
        </div>

        <div className="s-card p-4 space-y-3">
          <p className="text-sm font-semibold text-s-text">Send a test email</p>
          <div className="flex gap-2">
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com"
              aria-label="Address to test" className="flex-1 px-3 py-2 rounded border border-s-border bg-s-surface text-s-text text-sm" />
            <button onClick={() => { setResult(null); test.mutate() }}
              disabled={test.isPending || !testTo.includes('@')}
              className="px-4 py-2 rounded border border-s-border text-sm font-semibold text-s-text disabled:opacity-50">
              {test.isPending ? 'Sending…' : 'Send test'}
            </button>
          </div>
          {result && (
            <p className={`text-xs ${result.ok ? 'text-emerald-700' : 'text-red-700'}`}>
              {result.ok ? 'Sent. Check the inbox (and spam).' : `Failed — ${result.error}`}
            </p>
          )}
        </div>
        </>)}
      </div>
    </div>
  )
}
