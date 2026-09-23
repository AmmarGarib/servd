'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useBrandFilter } from '../../../store/brandFilter'

interface DnsRecord {
  type: string
  host: string
  value: string
  ttl: number
  hint: string
}

interface DnsInstructions {
  txt: DnsRecord
  cname: DnsRecord
  apexNote: string
  sslNote: string
}

interface Concept { id: string; name: string; slug: string }

interface Domain {
  id: string
  hostname: string
  conceptId: string | null
  purpose: 'order' | 'brand_microsite'
  status: 'pending' | 'verified' | 'active' | 'failed' | 'disabled'
  verificationToken: string
  verifiedAt: string | null
  sslIssuedAt: string | null
  lastCheckedAt: string | null
  notes: string | null
  createdAt: string
  concept: { id: string; name: string; slug: string } | null
  dnsInstructions: DnsInstructions
}

const STATUS_META: Record<Domain['status'], { label: string; color: string; bg: string }> = {
  pending:  { label: 'Pending DNS', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' },
  verified: { label: 'Verified',    color: '#22C55E', bg: 'rgba(34,197,94,0.1)' },
  active:   { label: '✓ Live',      color: '#00D4B1', bg: 'rgba(0,212,177,0.12)' },
  failed:   { label: 'DNS not found', color: '#FF4D4F', bg: 'rgba(255,77,79,0.1)' },
  disabled: { label: 'Disabled',    color: '#94A3B8', bg: 'rgba(255,255,255,0.05)' },
}

export default function DomainsPage() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: domains = [], isLoading } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  })
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">🌐 Custom Domains</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Point your own domains (e.g. <code className="font-mono text-xs text-white/65">order.mubarakbiryani.pk</code>) at servd. Each domain maps to a brand. SSL is automatic once DNS verifies.
            </p>
          </div>
          <button onClick={() => setAdding(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
            + Add domain
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-4">

        {/* Setup flow primer */}
        <div className="rounded-2xl p-5"
          style={{ background: 'linear-gradient(135deg, rgba(0,212,177,0.06), rgba(99,102,241,0.04))', border: '1px solid rgba(0,212,177,0.18)' }}>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-kds-green/70 mb-2">How it works</p>
          <ol className="text-sm text-white/75 space-y-2 leading-relaxed">
            <li><span className="font-bold text-kds-green">1.</span> Add your domain below — we generate a verification token.</li>
            <li><span className="font-bold text-kds-green">2.</span> Copy the two DNS records into your registrar (Cloudflare, Namecheap, GoDaddy).</li>
            <li><span className="font-bold text-kds-green">3.</span> Click <strong>Verify</strong>. Once we see the TXT record, status flips to <strong>Verified</strong>.</li>
            <li><span className="font-bold text-kds-green">4.</span> SSL is auto-provisioned at the edge → status flips to <strong>Live</strong>. Customers can now visit your domain and it serves your brand storefront.</li>
          </ol>
        </div>

        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && domains.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="text-4xl mb-3">🌐</p>
            <p className="font-bold text-white/85">No custom domains yet</p>
            <p className="text-sm text-white/45 mt-1 max-w-sm mx-auto">
              Out of the box, customers reach you at <code className="font-mono text-xs">servd.pk/your-brand</code>. Add a custom domain to get them on your URL.
            </p>
            <button onClick={() => setAdding(true)}
              className="mt-4 rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black">
              Add your first domain →
            </button>
          </div>
        )}

        {/* Domain list */}
        {domains.map((d) => (
          <DomainCard
            key={d.id}
            domain={d}
            concepts={concepts}
            expanded={expandedId === d.id}
            onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
            onChange={() => qc.invalidateQueries({ queryKey: ['domains'] })}
          />
        ))}
      </div>

      {adding && (
        <AddDomainModal
          concepts={concepts}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false); setExpandedId(id)
            void qc.invalidateQueries({ queryKey: ['domains'] })
          }}
        />
      )}
    </div>
  )
}

function DomainCard({ domain, concepts, expanded, onToggle, onChange }: {
  domain: Domain
  concepts: Concept[]
  expanded: boolean
  onToggle: () => void
  onChange: () => void
}) {
  const status = STATUS_META[domain.status]
  const verify = useMutation({
    mutationFn: () => api.post(`/domains/${domain.id}/verify`, {}),
    onSuccess: () => onChange(),
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/domains/${domain.id}`),
    onSuccess: () => onChange(),
  })

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <button onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-white/[0.015] transition-colors text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-mono text-base font-bold text-white/90 truncate">{domain.hostname}</p>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{ background: status.bg, color: status.color }}>
              {status.label}
            </span>
          </div>
          <p className="text-xs text-white/45 mt-0.5">
            {domain.concept ? <>Routes to <strong className="text-white/75">{domain.concept.name}</strong> · </> : 'No concept linked · '}
            {domain.purpose === 'order' ? 'order flow' : 'brand microsite'}
            {domain.verifiedAt && <> · verified {new Date(domain.verifiedAt).toLocaleDateString('en-PK')}</>}
          </p>
        </div>
        <span className="text-xs text-white/45 shrink-0">{expanded ? 'Hide' : 'DNS records'} ▾</span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-white/[0.04] pt-4">
          {/* DNS records */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/55 mb-2">DNS records to add</p>
            <div className="space-y-2">
              <DnsRecordCard label="Verification (TXT)" record={domain.dnsInstructions.txt} />
              <DnsRecordCard label="Traffic routing (CNAME)" record={domain.dnsInstructions.cname} />
            </div>
            <p className="text-[11px] text-white/35 mt-2 leading-relaxed">{domain.dnsInstructions.apexNote}</p>
            <p className="text-[11px] text-white/35 mt-1 leading-relaxed">🔒 {domain.dnsInstructions.sslNote}</p>
          </div>

          {/* Verify + manage */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/[0.04]">
            <div className="flex items-center gap-2">
              <button
                onClick={() => verify.mutate()}
                disabled={verify.isPending}
                className="rounded-xl bg-kds-green text-black px-4 py-2 text-xs font-black hover:opacity-90 disabled:opacity-50"
              >
                {verify.isPending ? 'Checking DNS…' : '🔍 Verify now'}
              </button>
              {domain.lastCheckedAt && (
                <span className="text-[10px] text-white/35">
                  Last check: {new Date(domain.lastCheckedAt).toLocaleString('en-PK')}
                </span>
              )}
            </div>
            <button
              onClick={() => { if (confirm(`Remove ${domain.hostname}?`)) remove.mutate() }}
              className="text-xs text-white/40 hover:text-kds-red"
            >
              Remove
            </button>
          </div>

          {/* Concept assignment */}
          <ConceptAssignment domain={domain} concepts={concepts} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

function DnsRecordCard({ label, record }: { label: string; record: DnsRecord }) {
  const [copied, setCopied] = useState<'host' | 'value' | null>(null)
  function copy(text: string, which: 'host' | 'value') {
    navigator.clipboard.writeText(text)
    setCopied(which); setTimeout(() => setCopied(null), 1500)
  }
  return (
    <div className="rounded-xl p-3 space-y-2"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-white/85">{label}</p>
        <span className="text-[10px] font-mono uppercase font-black tracking-wider text-amber-400 px-1.5 py-0.5 rounded bg-amber-400/10">
          {record.type}
        </span>
      </div>
      <p className="text-[11px] text-white/45 leading-relaxed">{record.hint}</p>
      <div className="grid grid-cols-1 sm:grid-cols-[max-content_1fr_max-content] gap-2 text-xs items-center">
        <span className="text-white/40 uppercase font-bold tracking-wider">Host:</span>
        <code className="font-mono text-white/85 truncate">{record.host}</code>
        <button onClick={() => copy(record.host, 'host')}
          className="text-[10px] font-bold text-kds-green hover:underline">
          {copied === 'host' ? '✓ Copied' : 'Copy'}
        </button>
        <span className="text-white/40 uppercase font-bold tracking-wider">Value:</span>
        <code className="font-mono text-white/85 truncate">{record.value}</code>
        <button onClick={() => copy(record.value, 'value')}
          className="text-[10px] font-bold text-kds-green hover:underline">
          {copied === 'value' ? '✓ Copied' : 'Copy'}
        </button>
        <span className="text-white/40 uppercase font-bold tracking-wider">TTL:</span>
        <code className="font-mono text-white/85">{record.ttl}</code>
        <span></span>
      </div>
    </div>
  )
}

function ConceptAssignment({ domain, concepts, onChange }: { domain: Domain; concepts: Concept[]; onChange: () => void }) {
  const [conceptId, setConceptId] = useState(domain.conceptId ?? '')
  const [purpose, setPurpose] = useState(domain.purpose)
  const save = useMutation({
    mutationFn: () => api.patch(`/domains/${domain.id}`, {
      conceptId: conceptId || null,
      purpose,
    }),
    onSuccess: () => onChange(),
  })
  const dirty = conceptId !== (domain.conceptId ?? '') || purpose !== domain.purpose

  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/55 mb-2">Routing</p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_max-content] gap-2">
        <select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}>
          <option value="">Tenant landing (no specific brand)</option>
          {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={purpose} onChange={(e) => setPurpose(e.target.value as Domain['purpose'])}
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}>
          <option value="order">Order flow (customers place orders)</option>
          <option value="brand_microsite">Brand microsite (about / story / contact)</option>
        </select>
        <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}
          className="rounded-lg bg-kds-green text-black px-4 py-2 text-xs font-black hover:opacity-90 disabled:opacity-40">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function AddDomainModal({ concepts, onClose, onCreated }: {
  concepts: Concept[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [hostname, setHostname] = useState('')
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [purpose, setPurpose] = useState<'order' | 'brand_microsite'>('order')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/domains', {
      hostname: hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      conceptId: conceptId || undefined,
      purpose,
    }),
    onSuccess: (data) => onCreated(data.id),
    onError: (err: Error) => setError(err.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">Add custom domain</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-white/55 block mb-1">Hostname *</label>
            <input value={hostname} onChange={(e) => setHostname(e.target.value)}
              placeholder="order.mubarakbiryani.pk"
              className="w-full rounded-lg px-3 py-2.5 text-sm font-mono"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}
              autoFocus />
            <p className="text-[10px] text-white/35 mt-1">No https:// or trailing slash. Subdomain or apex both work.</p>
          </div>

          <div>
            <label className="text-xs text-white/55 block mb-1">Routes to</label>
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}>
              <option value="">No specific brand (tenant landing)</option>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-white/55 block mb-1">Purpose</label>
            <div className="flex gap-2">
              {[
                { key: 'order',           label: '🛍 Order flow',     desc: 'Customers place orders' },
                { key: 'brand_microsite', label: '📖 Brand microsite', desc: 'About / story page' },
              ].map((opt) => (
                <button key={opt.key} onClick={() => setPurpose(opt.key as 'order' | 'brand_microsite')}
                  className="flex-1 rounded-lg px-3 py-2 text-left transition-colors"
                  style={{
                    background: purpose === opt.key ? 'rgba(0,212,177,0.08)' : 'rgba(255,255,255,0.03)',
                    border: purpose === opt.key ? '1px solid rgba(0,212,177,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  }}>
                  <p className="text-xs font-bold text-white/85">{opt.label}</p>
                  <p className="text-[10px] text-white/45 mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg px-3 py-2 text-xs text-kds-red"
              style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.25)' }}>
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">
            Cancel
          </button>
          <button onClick={() => create.mutate()} disabled={!hostname.trim() || create.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            {create.isPending ? 'Creating…' : 'Add domain'}
          </button>
        </div>
      </div>
    </div>
  )
}
