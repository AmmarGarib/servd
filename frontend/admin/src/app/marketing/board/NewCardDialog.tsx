'use client'
import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, Textarea, fieldCls } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import { CardStaffFields, linesToLinks, staffPayload, type StaffFields } from './CardFields'
import { STAGES, STAGE_LABEL, type Board, type Card, type Stage } from './data'

function inAWeek(): string {
  return new Date(Date.now() + 5 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 10)
}

export function NewCardDialog({ board, lead, onClose, onCreated }: { board: Board; lead: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [links, setLinks] = useState('')
  const [stage, setStage] = useState<Stage>('idea')
  const [staff, setStaff] = useState<StaffFields>({ type: 'design_request', deadline: inAWeek(), priority: 'normal', ownerId: '', resourceIds: [], linkKind: '', linkId: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = !!(title || brief || links)

  async function save() {
    if (!title.trim()) { setErr('Give the card a title.'); return }
    setBusy(true); setErr(null)
    try {
      const card = await api.post<Card>('/marketing-board/cards', {
        boardId: board.id, title: title.trim(), brief: brief.trim() || null, referenceLinks: linesToLinks(links),
        ...staffPayload(staff), ...(lead && stage !== 'idea' ? { stage } : {}),
      })
      onCreated(card.id)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not create the card')
    } finally { setBusy(false) }
  }

  return (
    <Dialog title={`New card — ${board.name}`} onClose={onClose} wide dirty={dirty}>
      <div className="space-y-3">
        {err && <ErrorBanner message={err} />}
        <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></Field>
        <CardStaffFields boardId={board.id} value={staff} onChange={setStaff} />
        {lead && (
          <Field label="Starts at">
            <Select className={fieldCls} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Brief"><Textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={10000} /></Field>
        <Field label="Reference links" hint="One per line, starting with https://">
          <Textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://" />
        </Field>
      </div>
      <DialogFooter onCancel={onClose}>
        <Button onClick={() => void save()} disabled={busy}>{busy ? 'Creating…' : 'Create card'}</Button>
      </DialogFooter>
    </Dialog>
  )
}
