'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Token {
  id: string
  name: string
  scopes: string[]
  conceptId: string | null
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface CreatedToken extends Token {
  token: string  // plaintext, only on create response
  hint: string
}

const SCOPE_PRESETS: Array<{ scope: string; label: string; desc: string }> = [
  { scope: 'orders:read',    label: 'Read orders',    desc: 'List + get orders, no mutations' },
  { scope: 'orders:write',   label: 'Write orders',   desc: 'Place + update orders (for partner POS)' },
  { scope: 'menu:read',      label: 'Read menu',      desc: 'Browse menu, items, modifiers' },
  { scope: 'inventory:read', label: 'Read inventory', desc: 'Check stock levels' },
  { scope: 'customers:read', label: 'Read customers', desc: 'List customers + loyalty balances' },
  { scope: 'webhooks:emit',  label: 'Emit webhooks',  desc: 'Subscribe to order events' },
  { scope: '*',              label: 'Full access',    desc: '⚠ Bypass all scope checks' },
]

export default function ApiTokensPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null)

  const { data: tokens = [], isLoading } = useQuery<Token[]>({
    queryKey: ['api-tokens'],
    queryFn: () => api.get('/api-tokens'),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">🔑 API Tokens</h1>
            <p className="text-sm text-white/40 mt-1">
              Long-lived bearer tokens for the customer mobile app, partner integrations, and backend automation.
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90"
          >
            + Issue token
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl space-y-5">
        {/* Why-it-matters card */}
        <div
          className="rounded-2xl p-4"
          style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.18)' }}
        >
          <p className="text-xs font-bold text-amber-400 mb-1">⚠ Treat tokens like passwords</p>
          <p className="text-xs text-white/55 leading-relaxed">
            The plaintext is shown only once — at creation. Store it in your secret manager (1Password, env vars). If lost or leaked, revoke immediately and issue a new one.
          </p>
        </div>

        {/* Tokens list */}
        <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {isLoading ? (
            <div className="p-6 text-sm text-white/40">Loading…</div>
          ) : tokens.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-4xl mb-3">🔑</p>
              <p className="font-bold text-white/85">No tokens issued yet</p>
              <p className="text-sm text-white/45 mt-1">
                You'll need one for the customer mobile app and any partner integration.
              </p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90"
              >
                Issue your first token →
              </button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] border-b border-white/[0.05]">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Name</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Scopes</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Last used</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {tokens.map((t) => {
                  const isRevoked = !!t.revokedAt
                  const isExpired = t.expiresAt ? new Date(t.expiresAt) < new Date() : false
                  return (
                    <tr key={t.id} className={isRevoked || isExpired ? 'opacity-50' : ''}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-white/85">{t.name}</p>
                        <p className="text-[10px] text-white/35 font-mono mt-0.5">id: {t.id.slice(0, 8)}…</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {t.scopes.map((s) => (
                            <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-white/60">{s}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-white/50">
                        {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString('en-PK') : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        {isRevoked ? (
                          <span className="text-[10px] font-bold text-kds-red">REVOKED</span>
                        ) : isExpired ? (
                          <span className="text-[10px] font-bold text-amber-400">EXPIRED</span>
                        ) : (
                          <span className="text-[10px] font-bold text-kds-green">ACTIVE</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!isRevoked && (
                          <RevokeButton id={t.id} onDone={() => qc.invalidateQueries({ queryKey: ['api-tokens'] })} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateTokenModal
          onClose={() => setShowCreate(false)}
          onCreated={(t) => {
            setShowCreate(false)
            setCreatedToken(t)
            void qc.invalidateQueries({ queryKey: ['api-tokens'] })
          }}
        />
      )}

      {createdToken && (
        <ShowTokenModal token={createdToken} onClose={() => setCreatedToken(null)} />
      )}
    </div>
  )
}

function RevokeButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const revoke = useMutation({
    mutationFn: () => api.patch(`/api-tokens/${id}/revoke`, {}),
    onSuccess: () => onDone(),
  })
  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-white/40 hover:text-kds-red"
      >
        Revoke
      </button>
    )
  }
  return (
    <div className="flex gap-2 justify-end">
      <button onClick={() => setConfirming(false)} className="text-xs text-white/40 hover:text-white">Cancel</button>
      <button
        onClick={() => revoke.mutate()}
        disabled={revoke.isPending}
        className="text-xs font-bold text-kds-red hover:text-red-400"
      >
        {revoke.isPending ? '…' : 'Confirm revoke'}
      </button>
    </div>
  )
}

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: CreatedToken) => void }) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['orders:read', 'menu:read'])
  const [expiresInDays, setExpiresInDays] = useState<string>('365')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedToken>('/api-tokens', {
        name: name.trim(),
        scopes,
        expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
      }),
    onSuccess: (data) => onCreated(data),
    onError: (err: Error) => setError(err.message ?? 'Failed to create token'),
  })

  function toggleScope(s: string) {
    setScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">Issue API token</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs text-white/55">Token name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Customer mobile app — production"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-white/55">Scopes *</label>
            <div className="grid grid-cols-1 gap-1.5 mt-1">
              {SCOPE_PRESETS.map((s) => (
                <label
                  key={s.scope}
                  className="flex items-start gap-3 rounded-lg p-2.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
                  style={{ border: scopes.includes(s.scope) ? '1px solid rgba(0,212,177,0.4)' : '1px solid rgba(255,255,255,0.05)' }}
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.scope)}
                    onChange={() => toggleScope(s.scope)}
                    className="mt-0.5 accent-kds-green"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white/85 font-mono">{s.scope}</p>
                    <p className="text-[11px] text-white/45">{s.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-white/55">Expires in (days)</label>
            <input
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="365"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none"
            />
            <p className="text-[10px] text-white/35 mt-1">Leave blank for no expiry. Recommended: 365 for prod, 30 for staging.</p>
          </div>

          {error && (
            <div className="rounded-lg p-2.5 text-xs text-kds-red"
              style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.25)' }}>
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">
            Cancel
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim() || scopes.length === 0}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShowTokenModal({ token, onClose }: { token: CreatedToken; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(token.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(0,212,177,0.4)' }}
      >
        <div className="border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-kds-green flex items-center gap-2">✓ Token created</h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="rounded-xl p-3" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
            <p className="text-sm font-bold text-amber-400">⚠ Save this token now</p>
            <p className="text-xs text-white/65 mt-0.5">
              You won&apos;t see it again. If you lose it, revoke and issue a new one.
            </p>
          </div>
          <div>
            <p className="text-xs text-white/55 mb-1">Token name</p>
            <p className="text-sm text-white/85 font-mono">{token.name}</p>
          </div>
          <div>
            <p className="text-xs text-white/55 mb-1">Bearer token</p>
            <div
              className="rounded-lg px-3 py-3 font-mono text-xs text-kds-green break-all"
              style={{ background: '#0a0c11', border: '1px solid rgba(0,212,177,0.25)' }}
            >
              {token.token}
            </div>
          </div>
          <button
            onClick={copy}
            className={`w-full rounded-xl py-2.5 text-sm font-black transition-colors ${
              copied ? 'bg-kds-green text-black' : 'bg-white/5 text-white/85 hover:bg-white/10'
            }`}
          >
            {copied ? '✓ Copied to clipboard' : '📋 Copy token'}
          </button>
        </div>
        <div className="flex justify-end border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90">
            I&apos;ve saved it — close
          </button>
        </div>
      </div>
    </div>
  )
}
