'use client'
// servd.pk/rider/jobs/<orderId> — one delivery, top to bottom (docs/rider-app.md):
// brand and company, cash to collect, the kitchen and the customer (navigate /
// call), the items — and one big step button pinned to the bottom:
//
//   offered    Accept / Decline (with a reason)
//   accepted   Picked up        (409 NOT_READY until the kitchen marks it ready)
//   picked_up  Arrived
//   arrived    The customer's 4-digit code → delivered. Wrong codes count down;
//              after 5 the hand-over locks: call the manager, who can send the
//              code to the rider's WhatsApp (Emergency overrides). The code
//              shows here too, as a fallback, with a "Use this code" fill.
//   picked up / arrived, code-only companies: "Problem at the door" (no code,
//              refused, can't reach) → bring the food back; a manager logs it.
//
// Each step sends the rider's latest position with it (never waits for GPS).
// The job refreshes every 15 s while on screen, so a kitchen marking it ready
// or a dispatcher taking it away shows up by itself.

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { formatBrandName } from '../../../../lib/concept'
import {
  RiderApiError, errorNumber, friendlyError, riderApi, type DoorProblemKind, type Job, type JobPlace, type StepAction,
} from '../../../../lib/riderApi'
import { useRiderSession } from '../../../../lib/riderSession'
import { currentPos } from '../../_lib/tracking'
import { usePoll } from '../../_lib/usePoll'
import { ORDER_STATUS_LABEL, directionsUrl, formatPhone, pkr, shortTime, telHref } from '../../_lib/format'
import {
  Banner, Button, ButtonLink, Card, CheckIcon, ChevronIcon, Label, NavigateIcon, PhoneIcon, Spinner, StageBadge,
} from '../../_components/ui'

const DECLINE_REASONS = ['Too far', 'Vehicle problem', 'Already carrying an order', 'Other'] as const
const OTP_LENGTH = 4

const DOOR_PROBLEMS: Array<{ kind: DoorProblemKind; label: string }> = [
  { kind: 'no_code', label: "Customer can't get the code" },
  { kind: 'refused', label: "Customer refused or won't pay" },
  { kind: 'unreachable', label: "Can't reach the customer" },
]

export default function RiderJobPage() {
  const params = useParams<{ orderId: string }>()
  const orderId = String(params?.orderId ?? '')
  const router = useRouter()
  const signedIn = useRiderSession((s) => !!(s.accessToken || s.refreshToken))

  const [job, setJob] = useState<Job | null>(null)
  const [gone, setGone] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 'code' = this rider's code just closed it; 'already' = the server says it
  // was delivered before (an earlier try that timed out here but landed, or a
  // manager closed it from admin).
  const [delivered, setDelivered] = useState<'code' | 'already' | null>(null)

  const [busy, setBusy] = useState<StepAction | 'deliver' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [declining, setDeclining] = useState(false)
  const [declineReason, setDeclineReason] = useState<string | null>(null)
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)
  const [doorOpen, setDoorOpen] = useState(false)
  const [doorBusy, setDoorBusy] = useState<DoorProblemKind | null>(null)
  const [doorError, setDoorError] = useState<string | null>(null)
  const [doorReported, setDoorReported] = useState(false)

  const load = useCallback(async () => {
    try {
      const { job: fresh } = await riderApi.job(orderId)
      setJob(fresh)
      setLoadError(null)
      const session = useRiderSession.getState()
      if (fresh.stage === 'picked_up' || fresh.stage === 'arrived') session.setActiveOrderId(fresh.orderId)
    } catch (err) {
      if (err instanceof RiderApiError && err.code === 'SESSION_ENDED') return
      if (err instanceof RiderApiError && err.status === 404) {
        // Finished, cancelled or given to another rider since we last looked.
        setGone(true)
        setJob(null)
        const session = useRiderSession.getState()
        if (session.activeOrderId === orderId) session.setActiveOrderId(null)
        return
      }
      setLoadError(friendlyError(err))
    }
  }, [orderId])

  usePoll(load, 15_000, signedIn && !!orderId && !delivered && !gone)

  // The server's count wins whenever a fresh job arrives.
  useEffect(() => {
    if (typeof job?.otpAttemptsLeft === 'number') {
      setAttemptsLeft(job.otpAttemptsLeft)
      setLocked(job.otpAttemptsLeft <= 0)
    }
  }, [job?.otpAttemptsLeft])

  async function step(action: StepAction, extra: { reason?: string } = {}) {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const res = await riderApi.step(orderId, action, { ...currentPos(), ...extra })
      if (action === 'decline') {
        router.replace('/rider/jobs')
        return
      }
      // Carrying it from here: tag location fixes straight away.
      if (action === 'picked-up') useRiderSession.getState().setActiveOrderId(orderId)
      if (res?.job) setJob(res.job)
      else void load()
    } catch (err) {
      setError(stepErrorMessage(err))
      void load()
    } finally {
      setBusy(null)
    }
  }

  async function reportDoor(kind: DoorProblemKind) {
    if (doorBusy) return
    setDoorBusy(kind)
    setDoorError(null)
    try {
      await riderApi.reportDoorProblem(orderId, kind, currentPos())
      setDoorReported(true)
      setDoorOpen(false)
      void load()
    } catch (err) {
      setDoorError(stepErrorMessage(err))
    } finally {
      setDoorBusy(null)
    }
  }

  // The job is over: stop tagging location fixes with it.
  function closeJob(how: 'code' | 'already') {
    setDelivered(how)
    const session = useRiderSession.getState()
    if (session.activeOrderId === orderId) session.setActiveOrderId(null)
  }

  async function deliver() {
    if (busy || locked) return
    setOtpError(null)
    setError(null)
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(otp)) {
      setOtpError(`Enter the ${OTP_LENGTH}-digit code the customer gives you.`)
      return
    }
    setBusy('deliver')
    try {
      await riderApi.deliver(orderId, otp, currentPos())
      closeJob('code')
    } catch (err) {
      setOtp('')
      if (err instanceof RiderApiError && (err.status === 423 || err.code === 'OTP_LOCKED')) {
        setLocked(true)
        setAttemptsLeft(0)
      } else if (err instanceof RiderApiError && (err.status === 403 || err.code === 'OTP_MISMATCH')) {
        const left = errorNumber(err, 'attemptsLeft')
        if (left !== null) setAttemptsLeft(left)
        if (left === 0) {
          setLocked(true)
        } else {
          setOtpError(
            left === null
              ? 'Wrong code. Ask the customer to read it again from their order page or WhatsApp.'
              : `Wrong code — ${left} ${left === 1 ? 'try' : 'tries'} left. Ask the customer to read it again from their order page or WhatsApp.`,
          )
        }
      } else if (err instanceof RiderApiError && err.code === 'ALREADY_DELIVERED') {
        closeJob('already')
      } else {
        setOtpError(stepErrorMessage(err))
      }
    } finally {
      setBusy(null)
    }
  }

  // ─── Delivered ──────────────────────────────────────────────────────────────
  if (delivered) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-16 text-center">
        <span className="flex h-24 w-24 items-center justify-center rounded-full"
          style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
          <CheckIcon size={52} />
        </span>
        <h1 className="text-[34px] font-extrabold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>Delivered</h1>
        <p className="text-[17px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
          {delivered === 'already'
            ? 'This order is already marked delivered. Nothing more to do.'
            : 'The code matched and the order is closed. Thank you.'}
        </p>
        <div className="w-full">
          <Button size="xl" onClick={() => router.replace('/rider/jobs')}>Back to jobs</Button>
        </div>
      </div>
    )
  }

  // ─── Loading / gone / error ─────────────────────────────────────────────────
  if (!job) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-4 px-4 py-16">
        {gone ? (
          <>
            <h1 className="text-center text-[26px] font-extrabold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              This job is no longer yours
            </h1>
            <p className="text-center text-[16px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
              It was finished, cancelled, or given to another rider. Nothing more to do here.
            </p>
            <Button size="lg" onClick={() => router.replace('/rider/jobs')}>Back to jobs</Button>
          </>
        ) : loadError ? (
          <>
            <Banner tone="danger" title="Could not load this job">{loadError}</Banner>
            <Button size="lg" onClick={() => void load()}>Try again</Button>
            <Button intent="ghost" size="md" onClick={() => router.replace('/rider/jobs')}>Back to jobs</Button>
          </>
        ) : (
          <div className="flex justify-center" style={{ color: 'var(--servd-purple)' }}>
            <Spinner size={30} />
            <span className="sr-only">Loading the job</span>
          </div>
        )}
      </div>
    )
  }

  const brand = formatBrandName(job.brand?.name)
  const cash = job.cashToCollectCents ?? 0
  const reroutedCode = job.handover?.rerouted ? job.handover.code : null
  const canReportDoor = !!job.doorProblemEnabled && (job.stage === 'picked_up' || job.stage === 'arrived')
  const showReturnGuidance = doorReported || !!job.doorProblem
  const outlet = formatBrandName(job.pickup?.name) || brand

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col gap-4 px-4 pb-6 pt-4">
        <Link href="/rider/jobs" className="-ml-1 inline-flex min-h-[44px] items-center gap-1 self-start text-[15px] font-black"
          style={{ color: 'var(--servd-purple)' }}>
          <ChevronIcon dir="left" size={22} /> All jobs
        </Link>

        {/* Who and what */}
        <div className="flex flex-col gap-1.5">
          <div><StageBadge stage={job.stage} large /></div>
          <h1 className="text-[30px] font-extrabold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
            {brand} <span style={{ color: 'var(--servd-mute)' }}>#{job.orderNumber}</span>
          </h1>
          {job.company?.name ? (
            <p className="text-[16px] font-bold" style={{ color: 'var(--servd-mute)' }}>For {job.company.name}</p>
          ) : null}
          <p className="text-[15px]" style={{ color: 'var(--servd-mute)' }}>
            Kitchen: <strong style={{ color: 'var(--servd-ink)' }}>{ORDER_STATUS_LABEL[job.status] ?? job.status}</strong>
          </p>
        </div>

        {/* Cash */}
        {cash > 0 ? (
          <Card tone="purple">
            <Label color="var(--servd-on-purple)">Cash to collect</Label>
            <p className="text-[38px] font-black leading-none" style={{ fontFamily: 'var(--font-display)' }}>{pkr(cash)}</p>
            <p className="mt-2 text-[15px]">Collect this in cash before you hand the order over.</p>
          </Card>
        ) : (
          <Card tone="green">
            <p className="text-[18px] font-black">Prepaid — collect nothing</p>
          </Card>
        )}

        <PlaceCard label="Pick up from" title={formatBrandName(job.pickup?.name) || brand} place={job.pickup} callLabel="Call kitchen" />
        <PlaceCard label="Deliver to" title={job.dropoff?.name || 'Customer'} place={job.dropoff} callLabel="Call customer" />

        {/* Items */}
        <Card>
          <Label>Items ({job.itemCount})</Label>
          <ul className="flex flex-col gap-2">
            {(job.items ?? []).map((it, i) => (
              <li key={`${it.name}-${i}`} className="flex gap-3 text-[17px]">
                <span className="min-w-[2.5rem] font-black" style={{ color: 'var(--servd-purple)' }}>{it.qty} ×</span>
                <span className="flex-1">{it.name}</span>
              </li>
            ))}
          </ul>
        </Card>

        {job.notes ? (
          <Card>
            <Label>Notes from the customer</Label>
            <p className="text-[16px] leading-snug">{job.notes}</p>
          </Card>
        ) : null}

        <Timeline job={job} />
      </div>

      {/* The step — pinned to the bottom, where the thumb is */}
      <div
        className="sticky bottom-0 z-30 mt-auto flex flex-col gap-3 px-4 pt-4"
        style={{
          background: 'var(--servd-bg)',
          borderTop: '1px solid var(--servd-line)',
          boxShadow: '0 -8px 24px color-mix(in srgb, var(--servd-ink) 10%, transparent)',
          paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        }}
      >
        {error ? <Banner tone="danger" title="Not done">{error}</Banner> : null}

        {showReturnGuidance && canReportDoor ? (
          <Banner tone="strong" title="Problem at the door reported">
            Bring the food back to {outlet}; a manager logs it.
          </Banner>
        ) : null}

        {job.stage === 'offered' && !declining ? (
          <>
            <Button size="xl" busy={busy === 'accept'} disabled={!!busy} onClick={() => void step('accept')}>Accept job</Button>
            <Button intent="ghost" size="md" disabled={!!busy} onClick={() => setDeclining(true)}>Decline</Button>
          </>
        ) : null}

        {job.stage === 'offered' && declining ? (
          <>
            <p className="text-[18px] font-black">Why are you declining?</p>
            <div className="grid grid-cols-2 gap-2.5">
              {DECLINE_REASONS.map((r) => (
                <Button key={r} intent="ghost" size="md" busy={busy === 'decline' && declineReason === r} disabled={!!busy}
                  onClick={() => { setDeclineReason(r); void step('decline', { reason: r }) }}>
                  {r}
                </Button>
              ))}
            </div>
            <Button intent="secondary" size="md" disabled={!!busy} onClick={() => setDeclining(false)}>Keep the job</Button>
          </>
        ) : null}

        {job.stage === 'accepted' ? (
          <>
            <p className="text-center text-[15px]" style={{ color: 'var(--servd-mute)' }}>
              {job.status === 'ready' || job.status === 'completed'
                ? 'The order is ready. Tap once the kitchen hands it to you.'
                : 'The kitchen is still on it. Tap once they hand it to you.'}
            </p>
            <Button size="xl" busy={busy === 'picked-up'} disabled={!!busy} onClick={() => void step('picked-up')}>Picked up</Button>
          </>
        ) : null}

        {job.stage === 'picked_up' ? (
          <Button size="xl" busy={busy === 'arrived'} disabled={!!busy} onClick={() => void step('arrived')}>
            Arrived at customer
          </Button>
        ) : null}

        {job.stage === 'arrived' ? (
          locked ? (
            <>
              <Banner tone="danger" title="Code locked">
                Call your manager — they can send the code to you.
              </Banner>
              <ButtonLink href={telHref(job.pickup?.phone)} intent="secondary" size="xl" icon={<PhoneIcon />}>
                Call the kitchen
              </ButtonLink>
            </>
          ) : (
            <>
            {reroutedCode ? (
              <Banner tone="success" title="A manager sent the code to your WhatsApp">
                {cash > 0 ? 'Take the cash first, then enter the code. ' : 'Check the customer has the food, then enter the code. '}
                If the message has not arrived, the code is <strong>{reroutedCode}</strong>.
                <div className="mt-3">
                  <Button intent="secondary" size="md" onClick={() => { setOtp(reroutedCode); setOtpError(null) }}>
                    Use this code
                  </Button>
                </div>
              </Banner>
            ) : null}
            <form className="flex flex-col gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void deliver() }}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[18px] font-black">Enter the customer&apos;s code</span>
                <span className="text-[14px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
                  The customer has a {OTP_LENGTH}-digit code on their order page and on WhatsApp.
                  {typeof attemptsLeft === 'number' ? ` ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.` : ''}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  maxLength={OTP_LENGTH}
                  placeholder={'0'.repeat(OTP_LENGTH)}
                  value={otp}
                  readOnly={busy === 'deliver'}
                  onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH)); if (otpError) setOtpError(null) }}
                  aria-invalid={!!otpError}
                  aria-label="Customer code"
                  className="mt-1 w-full rounded-2xl px-4 text-center text-[38px] font-black tracking-[0.5em] outline-none focus:ring-4"
                  style={{
                    minHeight: 72,
                    background: 'var(--servd-surface)',
                    color: 'var(--servd-ink)',
                    border: `2px solid ${otpError ? 'var(--servd-danger)' : 'var(--servd-purple)'}`,
                    '--tw-ring-color': 'color-mix(in srgb, var(--servd-green) 60%, transparent)',
                  } as CSSProperties}
                />
              </label>
              {otpError ? (
                <p role="alert" className="text-[15px] font-bold" style={{ color: 'var(--servd-danger)' }}>{otpError}</p>
              ) : null}
              <Button type="submit" size="xl" busy={busy === 'deliver'} disabled={otp.length !== OTP_LENGTH}>
                Complete delivery
              </Button>
            </form>
            </>
          )
        ) : null}

        {canReportDoor && !showReturnGuidance && !doorOpen ? (
          <Button intent="ghost" size="md" disabled={!!busy} onClick={() => { setDoorError(null); setDoorOpen(true) }}>
            Problem at the door
          </Button>
        ) : null}

        {canReportDoor && doorOpen ? (
          <>
            <p className="text-[18px] font-black">What is the problem?</p>
            <div className="flex flex-col gap-2.5">
              {DOOR_PROBLEMS.map((d) => (
                <Button key={d.kind} intent="ghost" size="md" busy={doorBusy === d.kind} disabled={!!doorBusy}
                  onClick={() => void reportDoor(d.kind)}>
                  {d.label}
                </Button>
              ))}
            </div>
            {doorError ? <Banner tone="danger" title="Not sent">{doorError}</Banner> : null}
            <Button intent="secondary" size="md" disabled={!!doorBusy} onClick={() => setDoorOpen(false)}>Cancel</Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function PlaceCard({ label, title, place, callLabel }: {
  label: string
  title: string
  place: JobPlace | null | undefined
  callLabel: string
}) {
  const p: JobPlace = place ?? { name: null, address: null, lat: null, lng: null, phone: null }
  return (
    <Card>
      <Label>{label}</Label>
      <p className="text-[20px] font-black leading-tight">{title}</p>
      {p.address ? (
        <p className="mt-1 whitespace-pre-line text-[16px] leading-snug">{p.address}</p>
      ) : (
        <p className="mt-1 text-[15px]" style={{ color: 'var(--servd-mute)' }}>No address given — call for directions.</p>
      )}
      {p.phone ? <p className="mt-1 text-[15px]" style={{ color: 'var(--servd-mute)' }}>{formatPhone(p.phone)}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <ButtonLink href={directionsUrl(p)} intent="secondary" external icon={<NavigateIcon size={18} />}>Navigate</ButtonLink>
        <ButtonLink href={telHref(p.phone)} intent="ghost" icon={<PhoneIcon size={18} />}>{callLabel}</ButtonLink>
      </div>
    </Card>
  )
}

function Timeline({ job }: { job: Job }) {
  const rows: Array<[string, string | null]> = [
    ['Offered', job.assignedAt],
    ['Accepted', job.acceptedAt],
    ['Picked up', job.pickedUpAt],
    ['Arrived', job.arrivedAt],
  ]
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2 px-1">
      {rows.map(([label, at]) => (
        <li key={label} className="flex items-center gap-1.5 text-[13px] font-bold"
          style={{ color: at ? 'var(--servd-ink)' : 'var(--servd-dim)' }}>
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full"
            style={{
              background: at ? 'var(--servd-green)' : 'transparent',
              border: `2px solid ${at ? 'var(--servd-green)' : 'var(--servd-dim)'}`,
            }} />
          {label}{at ? ` ${shortTime(at)}` : ''}
        </li>
      ))}
    </ol>
  )
}

function stepErrorMessage(err: unknown): string {
  if (err instanceof RiderApiError) {
    if (err.code === 'NOT_READY') {
      return 'The kitchen has not marked this order ready yet. Wait at the counter and tap again when they hand it over.'
    }
    if (err.status === 404) return 'This job is no longer yours — it was cancelled or given to another rider.'
    if (err.status === 409 || err.status === 422) return err.message
  }
  return friendlyError(err)
}
