'use client'
// Enrol / edit an intern (HR → Interns). Sections: Personal, Academic, Internship, Documents. The same form is the
// "Enroll intern" page and the profile's Edit. Rules shown beside the fields come from the API (zod issues and rule
// codes — lib/interns.ts apiErrors); the client only mirrors the obvious ones.

import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { btn, btnGhost, card, inp } from '../../../lib/hr'
import {
  WEEK_ORDER, apiErrors, bodyFromForm, durationLabel, emptyInternForm, formFromIntern, useInternLookups, validateInternForm,
  type InternDetail, type InternFormState,
} from '../../../lib/interns'
import { useHrAccess } from '../HrShell'
import { PendingFilesPicker } from '../../files/PendingFilesPicker'
import { uploadRecordFiles, type PickedFile } from '../../files/recordFiles'
import { Select } from '@/components/ui/Select'
import { NumberField } from '@/components/ui/NumberField'
import { ErrorBox, Field, Note, invalidStyle } from './ui'

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-4 sm:p-5" style={card}>
      <h2 className="text-sm font-black text-white/90"><span className="text-white/45 mr-1">{n}.</span>{title}</h2>
      {hint && <p className="text-xs text-white/55 mt-0.5">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2 mt-3">{children}</div>
    </section>
  )
}

export function InternForm({ mode, intern, onSaved, onCancel }: {
  mode: 'create' | 'edit'
  intern?: InternDetail
  /** After a successful save: the saved intern (create → the page goes to its profile). */
  onSaved: (saved: InternDetail) => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const { role } = useHrAccess()
  const ceo = role === 'admin'
  const { data: lk } = useInternLookups()
  const closed = !!intern && (intern.status === 'completed' || intern.status === 'terminated')
  const [f, setF] = useState<InternFormState>(() => (intern ? formFromIntern(intern) : emptyInternForm()))
  const [files, setFiles] = useState<PickedFile[]>([])
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [createdId, setCreatedId] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const set = <K extends keyof InternFormState>(k: K, v: InternFormState[K]) => setF((p) => ({ ...p, [k]: v }))
  const tenant = intern?.tenantId
  const depts = useMemo(() => (lk?.departments ?? []).filter((d) => !tenant || d.tenantId === null || d.tenantId === tenant), [lk, tenant])
  const sups = useMemo(() => (lk?.supervisors ?? []).filter((s) => !tenant || s.tenantId === tenant), [lk, tenant])
  const weekdays = WEEK_ORDER.map((v) => lk?.weekdays.find((w) => w.value === v) ?? { value: v, label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v]! })
  const duration = durationLabel(f.startDate, f.endDate || null)

  const save = useMutation({
    mutationFn: async (how: 'draft' | 'submit' | 'edit') => {
      const body = bodyFromForm(f, { closed })
      if (how === 'edit') return api.patch<InternDetail>(`/hr/interns/${intern!.id}`, body)
      return api.post<InternDetail>('/hr/interns', { ...body, saveAsDraft: how === 'draft' })
    },
  })

  async function go(how: 'draft' | 'submit' | 'edit') {
    if (save.isPending) return
    const found = validateInternForm(f, { closed })
    setErrs(found)
    if (Object.keys(found).length) {
      setErr('Please fix the marked fields.')
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0)
      return
    }
    setErr('')
    let saved: InternDetail
    try { saved = await save.mutateAsync(how) }
    catch (e) {
      const a = apiErrors(e)
      setErr(a.message); setErrs(a.fields)
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0)
      return
    }
    void qc.invalidateQueries({ queryKey: ['interns'] })
    void qc.invalidateQueries({ queryKey: ['intern'] })
    void qc.invalidateQueries({ queryKey: ['intern-dashboard'] })
    if (mode === 'create' && files.length) {
      try { await uploadRecordFiles('intern_document', saved.id, files) }
      catch (e) {
        setCreatedId(saved.id)
        setErr(`${saved.internCode} was saved, but a document could not be uploaded: ${(e as Error).message}. Attach it from the intern's Documents tab.`)
        return
      }
    }
    onSaved(saved)
  }

  const text = (key: keyof InternFormState, label: string, o: { required?: boolean; type?: string; hint?: string; disabled?: boolean; className?: string; maxLength?: number } = {}) => (
    <Field label={label} required={o.required} error={errs[key]} hint={o.hint} className={o.className}>
      {({ id, invalid, describedBy }) => (
        <input id={id} type={o.type ?? 'text'} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          value={String(f[key] ?? '')} maxLength={o.maxLength ?? 160} disabled={o.disabled} onChange={(e) => set(key, e.target.value as never)} />
      )}
    </Field>
  )

  return (
    <form ref={formRef} noValidate className="space-y-5" onSubmit={(e) => { e.preventDefault(); void go(mode === 'edit' ? 'edit' : 'submit') }}>
      {closed && <Note tone="info">This internship has ended — only the personal, academic and remark details can change.</Note>}

      <Section n={1} title="Personal">
        <Field label="Intern ID" hint={mode === 'create' ? 'Assigned automatically (INT-0001 …) when you save' : undefined}>
          {({ id }) => <input id={id} className={inp} value={intern?.internCode ?? 'Auto'} disabled readOnly />}
        </Field>
        {text('fullName', 'Full name', { required: true })}
        {text('fatherName', 'Father / guardian name')}
        {text('cnic', 'CNIC / B-form', { hint: '12345-1234567-1' })}
        {text('dateOfBirth', 'Date of birth', { type: 'date' })}
        <Field label="Gender" error={errs['gender']}>
          {({ id }) => (
            <Select id={id} className={inp} value={f.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">Not stated</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
            </Select>
          )}
        </Field>
        {text('phone', 'Phone', { type: 'tel', maxLength: 30 })}
        {text('email', 'Email', { type: 'email' })}
        <Field label="Address" error={errs['address']} className="sm:col-span-2">
          {({ id, invalid }) => <textarea id={id} className={`${inp} min-h-[64px]`} style={invalidStyle(invalid)} maxLength={400} value={f.address} onChange={(e) => set('address', e.target.value)} />}
        </Field>
        {text('emergencyContactName', 'Emergency contact name')}
        {text('emergencyContactPhone', 'Emergency contact phone', { type: 'tel', maxLength: 30 })}
      </Section>

      <Section n={2} title="Academic">
        {text('institution', 'University / institution', { className: 'sm:col-span-2' })}
        {text('degree', 'Degree / program')}
        {text('fieldOfStudy', 'Field of study')}
        {text('semester', 'Semester / year', { maxLength: 40 })}
        {text('studentRegNo', 'Student ID / registration no.', { maxLength: 60 })}
      </Section>

      <Section n={3} title="Internship" hint={closed ? 'Fixed — this internship has ended.' : undefined}>
        <Field label="Department" required error={errs['departmentId']}>
          {({ id, invalid, describedBy }) => (
            <Select id={id} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy} disabled={closed}
              value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">Pick a department…</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}
        </Field>
        {text('designation', 'Position / role', { disabled: closed })}
        <Field label="Supervisor" error={errs['supervisorEmployeeId']} hint="A current employee of this company">
          {({ id, invalid, describedBy }) => (
            <Select id={id} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy} disabled={closed}
              value={f.supervisorEmployeeId} onChange={(e) => set('supervisorEmployeeId', e.target.value)}>
              <option value="">No supervisor</option>
              {sups.map((s) => <option key={s.id} value={s.id}>{s.fullName} · {s.employeeCode}{s.designation ? ` · ${s.designation}` : ''}</option>)}
            </Select>
          )}
        </Field>
        <div className="hidden sm:block" aria-hidden="true" />
        {text('startDate', 'Start date', { required: true, type: 'date', disabled: closed })}
        {text('endDate', 'End date', { type: 'date', disabled: closed, hint: duration ? `Duration: ${duration}` : 'Leave empty if open-ended' })}
        <Field label="Internship type" error={errs['internshipType']}>
          {({ id }) => (
            <Select id={id} className={inp} disabled={closed} value={f.internshipType} onChange={(e) => set('internshipType', e.target.value as 'paid' | 'unpaid')}>
              <option value="unpaid">Unpaid</option><option value="paid">Paid</option>
            </Select>
          )}
        </Field>
        {f.internshipType === 'paid' ? (
          <Field label="Monthly stipend (PKR)" required error={errs['monthlyStipendCents']}>
            {({ id, invalid, describedBy }) => (
              <NumberField id={id} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy} decimals={2} min={0}
                disabled={closed} value={f.stipend} onValueChange={(n) => set('stipend', n)} />
            )}
          </Field>
        ) : <div className="hidden sm:block" aria-hidden="true" />}
        <Field label="Working days" required error={errs['workingDays']} className="sm:col-span-2">
          {() => (
            <div role="group" aria-label="Working days" className="flex flex-wrap gap-2">
              {weekdays.map((w) => {
                const on = f.workingDays.includes(w.value)
                return (
                  <button key={w.value} type="button" aria-pressed={on} disabled={closed}
                    onClick={() => set('workingDays', on ? f.workingDays.filter((x) => x !== w.value) : [...f.workingDays, w.value].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)))}
                    className={`rounded-full px-3 py-1 text-xs font-bold border min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-4 disabled:opacity-60 ${on ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/60'}`}>{w.label}</button>
                )
              })}
            </div>
          )}
        </Field>
        {text('workingHours', 'Working hours', { disabled: closed, maxLength: 80, hint: 'e.g. 9:00 – 17:00' })}
        <Field label="Performance remarks" error={errs['performanceRemarks']} className="sm:col-span-2">
          {({ id }) => <textarea id={id} className={`${inp} min-h-[72px]`} maxLength={2000} value={f.performanceRemarks} onChange={(e) => set('performanceRemarks', e.target.value)} />}
        </Field>
      </Section>

      <section className="rounded-2xl p-4 sm:p-5" style={card}>
        <h2 className="text-sm font-black text-white/90"><span className="text-white/45 mr-1">4.</span>Documents</h2>
        <p className="text-xs text-white/55 mt-0.5 mb-3">CNIC / B-form, student card, NOC, CV. Private files — only HR opens them.</p>
        {mode === 'create'
          ? <PendingFilesPicker ownerType="intern_document" value={files} onChange={setFiles} label="Attach documents" hint="Uploaded as soon as the intern is saved." />
          : <p className="text-xs text-white/60">Use the Documents tab on the intern&rsquo;s profile.</p>}
      </section>

      <ErrorBox message={err} />
      {createdId && <Link href={`/hr/interns/${createdId}`} className="inline-block text-sm font-bold text-primary-ink underline">Open the saved intern</Link>}
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'edit' ? (
          <button type="submit" className={btn} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        ) : (
          <>
            <button type="submit" className={btn} disabled={save.isPending}>{save.isPending ? 'Saving…' : ceo ? 'Enroll (active now)' : 'Submit for approval'}</button>
            <button type="button" className={btnGhost} disabled={save.isPending} onClick={() => void go('draft')}>Save as draft</button>
          </>
        )}
        {onCancel && <button type="button" className={btnGhost} onClick={onCancel}>Cancel</button>}
      </div>
      {mode === 'create' && <p className="text-[11px] text-white/50">{ceo ? 'As the CEO your own enrolment is active at once.' : 'Submitting sends the enrolment to the CEO for approval; a draft stays with HR.'}</p>}
    </form>
  )
}
