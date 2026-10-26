'use client'
// CEO → Backups (owner S13, 2026-10-26: "make it a weekly file i can download
// and save to my pc.. ceo only.."). API /backups (CEO only): the list, "Make a
// backup now", Download (the ENCRYPTED file; audited), the backup passphrase
// (never stored by servd) and the opener script. Plain-language restore steps.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from '../../../lib/api'
import { Modal } from '../../../components/ui/Modal'
import { PasswordInput } from '../../../components/ui/PasswordInput'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { useAuthStore } from '../../../store/auth'

interface BackupRow {
  id: string
  status: 'running' | 'done' | 'failed'
  trigger: 'weekly' | 'manual'
  fileName: string | null
  sizeBytes: number | null
  currentKey: boolean
  error: string | null
  startedAt: string
  finishedAt: string | null
  fileOnServer: boolean
}
interface BackupStatus {
  passphraseSet: boolean
  passphraseSetAt: string | null
  minPassphrase: number
  keep: number
  schedule: string
  weeklyOn: boolean
  practiceCopy: boolean
  openerAvailable: boolean
  backups: BackupRow[]
}

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong')
const when = (iso: string) => new Date(iso).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' })
function size(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function BackupsPage() {
  const role = useAuthStore((s) => s.user?.role)
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<BackupStatus>('/backups'),
    enabled: role === 'admin',
    // While one is being made, look again every few seconds.
    refetchInterval: (query) => (query.state.data?.backups.some((b) => b.status === 'running') ? 4000 : false),
  })
  const [passOpen, setPassOpen] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: () => api.post<{ id: string }>('/backups/run', {}),
    onSuccess: () => { toast.success('Backup started. It is ready to download in a few minutes.'); void qc.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (e) => toast.error(errText(e)),
  })

  async function download(b: BackupRow) {
    if (!b.fileName || downloading) return
    setDownloading(b.id)
    try { await api.download(`/backups/${b.id}/download`, b.fileName) }
    catch (e) { toast.error(errText(e)) }
    finally { setDownloading(null) }
  }

  if (role && role !== 'admin') {
    return <div className="p-4 sm:p-6"><CompactEmptyState message="Backups are the CEO's only." /></div>
  }

  const d = q.data
  const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
  const running = d?.backups.some((b) => b.status === 'running') ?? false

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <p className="text-[11px] font-bold uppercase tracking-wider text-success">CEO</p>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-black text-white/90">Backups</h1>
        <div className="ml-auto flex gap-2 flex-wrap">
          <button type="button" className="s-btn-secondary text-xs" onClick={() => setPassOpen(true)} disabled={!d}>
            {d?.passphraseSet ? 'Change passphrase' : 'Set passphrase'}
          </button>
          <button type="button" className="s-btn-primary text-xs"
            disabled={!d?.passphraseSet || run.isPending || running || d?.practiceCopy}
            onClick={() => run.mutate()}>
            {running ? 'Making a backup…' : 'Make a backup now'}
          </button>
        </div>
      </div>
      <p className="text-sm text-white/50 mt-1 max-w-2xl">
        A copy of the whole database — every company — made {d?.schedule.toLowerCase() ?? 'every Sunday at 03:00'}.
        Download it and keep it on your computer. The file is locked with your backup passphrase: without it
        nobody can open it, servd included.
      </p>

      {q.isLoading && <p className="mt-5 text-sm text-white/40">Loading…</p>}
      {q.isError && <p className="mt-5 text-sm" style={{ color: 'var(--erp-danger)' }}>{errText(q.error)}</p>}

      {d && !d.passphraseSet && (
        <div className="mt-5 rounded-2xl p-4" style={{ ...card, borderColor: 'rgb(var(--erp-primary-rgb) / 0.35)' }}>
          <p className="text-sm font-bold text-white/90">No backup is made until you set a backup passphrase.</p>
          <p className="text-xs text-white/55 mt-1">Choose a sentence you will remember and write it down somewhere safe, away from the computer. servd never stores it, so it cannot be recovered.</p>
          <button type="button" className="s-btn-primary text-xs mt-3" onClick={() => setPassOpen(true)}>Set passphrase</button>
        </div>
      )}
      {d?.practiceCopy && <p className="mt-4 text-xs text-white/55">This is the practice copy: it makes no backups.</p>}
      {d && !d.practiceCopy && !d.weeklyOn && <p className="mt-4 text-xs text-white/55">The weekly run is off on this server (background jobs are off). &ldquo;Make a backup now&rdquo; still works.</p>}

      {d && (
        <div className="mt-5 rounded-2xl overflow-hidden" style={card}>
          <div className="px-4 py-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-bold text-white/90">Backup files</span>
            <span className="text-xs text-white/45">The last {d.keep} are kept on the server.</span>
          </div>
          {d.backups.length === 0 ? (
            <div className="p-4"><CompactEmptyState message="No backups yet." detail={d.passphraseSet ? 'The first one is made on Sunday — or make one now.' : undefined} /></div>
          ) : (
            <ul>
              {d.backups.map((b) => (
                <li key={b.id} className="px-4 py-3 flex items-center gap-3 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-white/85">{when(b.startedAt)}</p>
                    <p className="text-xs text-white/50">
                      {b.trigger === 'weekly' ? 'Weekly' : 'Made by hand'}
                      {b.status === 'done' && <> · {size(b.sizeBytes)}{!b.currentKey && ' · opens with your previous passphrase'}</>}
                    </p>
                    {b.status === 'failed' && b.error && <p className="text-xs mt-1 break-words" style={{ color: 'var(--erp-danger)' }}>{b.error}</p>}
                  </div>
                  <span className={b.status === 'done' ? 's-badge-green' : b.status === 'running' ? 's-badge-purple' : 's-badge-red'}>
                    {b.status === 'done' ? 'Ready' : b.status === 'running' ? 'Being made' : 'Failed'}
                  </span>
                  {b.status === 'done' && b.fileOnServer && (
                    <button type="button" className="s-btn-secondary text-xs" disabled={downloading !== null} onClick={() => void download(b)}>
                      {downloading === b.id ? 'Downloading…' : 'Download'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {d && (
        <div className="mt-5 rounded-2xl p-4" style={card}>
          <h2 className="text-sm font-bold text-white/90">How to restore from a backup</h2>
          <p className="text-xs text-white/55 mt-1">Your IT person does this on a computer with Node.js and the PostgreSQL tools installed.</p>
          <ol className="mt-3 space-y-2 text-sm text-white/75 list-decimal pl-5">
            <li>
              Download the backup file you want, and the opener
              {d.openerAvailable
                ? <> (<button type="button" className="underline" style={{ color: 'var(--erp-primary)' }} onClick={() => void api.download('/backups/opener', 'decrypt-backup.mjs').catch((e) => toast.error(errText(e)))}>decrypt-backup.mjs</button>)</>
                : ' (decrypt-backup.mjs, from the servd code: backend/scripts)'}
              {' '}into the same folder.
            </li>
            <li>
              Open it: <code className="text-xs break-all">node decrypt-backup.mjs servd-backup-….servdbackup</code> and type the
              backup passphrase that was set when that file was made. It writes <code className="text-xs">….dump</code> next to it.
            </li>
            <li>
              Create an empty database (for example a new Neon branch), then load the dump into it:
              {' '}<code className="text-xs break-all">pg_restore --no-owner --no-acl --dbname &quot;&lt;new database address&gt;&quot; servd-backup-….dump</code>
            </li>
            <li>Point the servd API at the new database only after checking it — never restore over the live database.</li>
          </ol>
          <p className="text-xs text-white/45 mt-3">A file that was changed or damaged will not open (the opener checks it). A wrong passphrase gives &ldquo;Wrong passphrase&rdquo;.</p>
        </div>
      )}

      {passOpen && d && <PassphraseDialog status={d} onClose={() => setPassOpen(false)} onDone={() => { setPassOpen(false); void qc.invalidateQueries({ queryKey: ['backups'] }) }} />}
    </div>
  )
}

function PassphraseDialog({ status, onClose, onDone }: { status: BackupStatus; onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [forgot, setForgot] = useState(false)
  const [error, setError] = useState('')
  const changing = status.passphraseSet
  const save = useMutation({
    mutationFn: () => api.put('/backups/passphrase', {
      passphrase: next,
      ...(changing && !forgot && { currentPassphrase: current }),
      ...(changing && forgot && { replaceForgotten: true }),
    }),
    onSuccess: () => { toast.success(changing ? 'Backup passphrase changed. New backups use it.' : 'Backup passphrase set.'); onDone() },
    onError: (e) => setError(errText(e)),
  })
  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.trim().length < status.minPassphrase) { setError(`Use at least ${status.minPassphrase} characters — a short sentence is easiest.`); return }
    if (next !== again) { setError('The two passphrases do not match.'); return }
    if (changing && !forgot && !current) { setError('Type the current passphrase.'); return }
    if (!save.isPending) save.mutate()
  }
  return (
    <Modal title={changing ? 'Change backup passphrase' : 'Set backup passphrase'} onClose={onClose} dirty={!!(current || next || again)}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-white/55">
          servd never stores this passphrase and cannot recover it. Write it down and keep it somewhere safe.
          {changing && ' Backups already made keep opening with the passphrase they were made with.'}
        </p>
        {changing && !forgot && (
          <div>
            <label className="block text-xs font-bold text-white/60 mb-1">Current passphrase</label>
            <PasswordInput className="s-input w-full" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="off" autoFocus />
          </div>
        )}
        <div>
          <label className="block text-xs font-bold text-white/60 mb-1">New passphrase</label>
          <PasswordInput className="s-input w-full" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" autoFocus={!changing || forgot} />
        </div>
        <div>
          <label className="block text-xs font-bold text-white/60 mb-1">Type it again</label>
          <PasswordInput className="s-input w-full" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </div>
        {changing && (
          <label className="flex items-start gap-2 text-xs text-white/60">
            <input type="checkbox" checked={forgot} onChange={(e) => setForgot(e.target.checked)} className="mt-0.5" />
            <span>I forgot the current passphrase. Older backups will stay locked with it — only new backups use the new one.</span>
          </label>
        )}
        {error && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="s-btn-secondary text-xs" onClick={onClose}>Cancel</button>
          <button type="submit" className="s-btn-primary text-xs" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save passphrase'}</button>
        </div>
      </form>
    </Modal>
  )
}
