'use client'
// servd.pk/rider/jobs — the shift switch and the rider's jobs (docs/rider-app.md).
// Jobs refresh every 15 s while the page is on screen (GET /rider/jobs); a new
// offer buzzes the phone where the browser allows it. The rider's status comes
// from the shell's GET /rider/me poll.

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { formatBrandName } from '../../../lib/concept'
import {
  RiderApiError, carryingJob, friendlyError, isOnShift, riderApi, signOutRider, type Job,
} from '../../../lib/riderApi'
import { useRiderSession } from '../../../lib/riderSession'
import { startTracking, stopTracking } from '../_lib/tracking'
import { usePoll } from '../_lib/usePoll'
import { formatPhone, pkr, vehicleLabel } from '../_lib/format'
import { LocationBanner } from '../_components/LocationBanner'
import { Banner, Button, Card, ChevronIcon, Label, Spinner, StageBadge } from '../_components/ui'

const ACTIVE_JOBS_MESSAGE =
  'You are carrying a job. Deliver it — or call the kitchen to take it off you — before going off shift.'

export default function RiderJobsPage() {
  const rider = useRiderSession((s) => s.rider)
  const signedIn = useRiderSession((s) => !!(s.accessToken || s.refreshToken))
  const onShift = isOnShift(rider?.status)

  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shiftBusy, setShiftBusy] = useState(false)
  const [shiftError, setShiftError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  // 'carrying' = the server refused to take the rider off shift (a job is
  // theirs); 'stillOn' = going off shift failed (offline, server trouble), so
  // the rider would still be getting offers after signing out.
  const [signingOut, setSigningOut] = useState<'idle' | 'busy' | 'carrying' | 'stillOn'>('idle')
  const seenOffers = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    try {
      const { jobs: list } = await riderApi.jobs()
      setJobs(list)
      setLoadError(null)
      useRiderSession.getState().setActiveOrderId(carryingJob(list)?.orderId ?? null)
      // Buzz for an offer that was not there last time (not on the first load).
      const offers = list.filter((j) => j.stage === 'offered').map((j) => j.orderId)
      const fresh = seenOffers.current ? offers.filter((id) => !seenOffers.current!.has(id)) : []
      seenOffers.current = new Set(offers)
      if (fresh.length > 0 && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([300, 150, 300]) } catch { /* not allowed before a tap */ }
      }
    } catch (err) {
      if (err instanceof RiderApiError && err.code === 'SESSION_ENDED') return
      setLoadError(friendlyError(err))
    }
  }, [])

  usePoll(load, 15_000, signedIn)

  async function goOnShift() {
    if (shiftBusy) return
    setShiftError(null)
    setShiftBusy(true)
    // Straight from the tap, so the browser's location prompt belongs to it.
    startTracking()
    try {
      const { rider: fresh } = await riderApi.setShift(true)
      useRiderSession.getState().setRider(fresh)
      void load()
    } catch (err) {
      stopTracking()
      setShiftError(friendlyError(err))
    } finally {
      setShiftBusy(false)
    }
  }

  async function goOffShift() {
    if (shiftBusy) return
    setShiftError(null)
    setShiftBusy(true)
    try {
      const { rider: fresh } = await riderApi.setShift(false)
      useRiderSession.getState().setRider(fresh)
      setConfirmOff(false)
      void load()
    } catch (err) {
      setConfirmOff(false)
      setShiftError(err instanceof RiderApiError && err.code === 'ACTIVE_JOBS' ? ACTIVE_JOBS_MESSAGE : friendlyError(err))
    } finally {
      setShiftBusy(false)
    }
  }

  async function signOut(force = false) {
    if (signingOut === 'busy') return
    setSigningOut('busy')
    // Off shift first, so dispatch stops offering jobs to a rider who is gone.
    // Any failure is the rider's call, never a silent sign-out: signed out but
    // still on shift, the auto-dispatcher keeps offering them orders that then
    // sit until the offer times out.
    if (onShift) {
      try {
        await riderApi.setShift(false)
      } catch (err) {
        // Already signed out (the server refused the session): the shell
        // takes the rider to the sign-in screen.
        if (err instanceof RiderApiError && err.code === 'SESSION_ENDED') { setSigningOut('idle'); return }
        if (!force) {
          setSigningOut(err instanceof RiderApiError && err.code === 'ACTIVE_JOBS' ? 'carrying' : 'stillOn')
          return
        }
      }
    }
    stopTracking()
    await signOutRider()
    // The shell sends a signed-out rider to the sign-in screen.
  }

  const carrying = jobs?.some((j) => j.stage !== 'offered') ?? false

  return (
    <div className="flex flex-col gap-4 px-4 pb-12 pt-5">
      {/* ── Shift ── */}
      <Card tone={onShift ? 'green' : 'plain'}>
        <Label color={onShift ? 'var(--servd-green-ink)' : undefined}>Shift</Label>
        <p className="text-[26px] font-extrabold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
          {onShift
            ? rider?.status === 'busy' ? 'On shift — on a job' : 'On shift — waiting for jobs'
            : 'You are off shift'}
        </p>
        <p className="mt-1 text-[15px] leading-snug" style={{ color: onShift ? 'var(--servd-green-ink)' : 'var(--servd-mute)' }}>
          {onShift
            ? 'New jobs show up below. Keep this page open while you ride.'
            : 'Go on shift to get jobs. The kitchen sees your location while you are on shift.'}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {!onShift ? (
            <Button size="xl" busy={shiftBusy} onClick={() => void goOnShift()}>Go on shift</Button>
          ) : confirmOff ? (
            <>
              <p className="text-[16px] font-bold">Go off shift? New jobs stop and your location stops sharing.</p>
              <Button intent="danger" size="lg" busy={shiftBusy} onClick={() => void goOffShift()}>Go off shift</Button>
              <Button intent="ghost" size="md" disabled={shiftBusy} onClick={() => setConfirmOff(false)}>Stay on shift</Button>
            </>
          ) : (
            <Button intent="ghost" size="lg" disabled={shiftBusy} onClick={() => { setShiftError(null); setConfirmOff(true) }}>
              Go off shift
            </Button>
          )}
          {shiftError ? <Banner tone="danger" title="Not changed">{shiftError}</Banner> : null}
        </div>
      </Card>

      {onShift ? <LocationBanner /> : null}

      {/* ── Jobs ── */}
      <div className="mt-2 flex items-baseline justify-between">
        <h1 className="text-[24px] font-extrabold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
          Your jobs
        </h1>
        {jobs && jobs.length > 0 ? (
          <span className="text-[14px] font-bold" style={{ color: 'var(--servd-mute)' }}>{jobs.length}</span>
        ) : null}
      </div>

      {loadError ? (
        <Banner tone="danger" title="Could not load your jobs" action={
          <Button intent="secondary" size="md" onClick={() => void load()}>Try again</Button>
        }>
          {loadError}
        </Banner>
      ) : null}

      {jobs === null && !loadError ? (
        <div className="flex justify-center py-10" style={{ color: 'var(--servd-purple)' }}><Spinner size={28} /></div>
      ) : null}

      {jobs && jobs.length === 0 ? (
        <Card>
          <p className="text-[17px] font-bold">No jobs right now.</p>
          <p className="mt-1 text-[15px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
            {onShift
              ? 'A new job appears here by itself within a few seconds. Keep this page open.'
              : 'Go on shift to start getting jobs.'}
          </p>
        </Card>
      ) : null}

      {jobs?.map((job) => <JobCard key={job.orderId} job={job} />)}

      {/* ── Account ── */}
      {rider ? (
        <Card className="mt-6">
          <Label>Signed in</Label>
          <p className="text-[18px] font-black">{rider.name}</p>
          <p className="mt-0.5 text-[15px]" style={{ color: 'var(--servd-mute)' }}>
            {[formatPhone(rider.phone), vehicleLabel(rider.vehicleType), rider.companyName].filter(Boolean).join(' · ')}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {signingOut === 'carrying' || signingOut === 'stillOn' ? (
              <>
                {signingOut === 'carrying' ? (
                  <Banner tone="danger" title="You are carrying a job">
                    If you sign out, your location stops and the job stays yours. Deliver it first, or call the kitchen.
                  </Banner>
                ) : (
                  <Banner tone="danger" title="You are still on shift">
                    Going off shift did not go through, so new jobs can still be sent to you. Check your connection
                    and try again, or call the kitchen if you sign out anyway.
                  </Banner>
                )}
                {signingOut === 'stillOn' ? (
                  <Button intent="secondary" size="md" onClick={() => void signOut(false)}>Try again</Button>
                ) : null}
                <Button intent="danger" size="md" onClick={() => void signOut(true)}>Sign out anyway</Button>
                <Button intent="ghost" size="md" onClick={() => setSigningOut('idle')}>Stay signed in</Button>
              </>
            ) : (
              <Button intent="ghost" size="md" busy={signingOut === 'busy'} onClick={() => void signOut(false)}>
                Sign out{onShift && !carrying ? ' and go off shift' : ''}
              </Button>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function JobCard({ job }: { job: Job }) {
  const brand = formatBrandName(job.brand?.name)
  const cash = job.cashToCollectCents ?? 0
  const offered = job.stage === 'offered'
  return (
    <Link
      href={`/rider/jobs/${encodeURIComponent(job.orderId)}`}
      className="block rounded-3xl p-4 transition-transform active:scale-[0.99]"
      style={{
        background: 'var(--servd-surface)',
        color: 'var(--servd-ink)',
        border: offered ? '3px solid var(--servd-green-dark)' : '1px solid var(--servd-line)',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={job.stage} />
            {cash > 0 ? (
              <span className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.1em]"
                style={{ background: 'var(--servd-purple)', color: 'var(--servd-on-purple)' }}>
                Collect {pkr(cash)}
              </span>
            ) : (
              <span className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.1em]"
                style={{ background: 'var(--servd-green-soft)', color: 'var(--servd-green-ink)' }}>
                Prepaid
              </span>
            )}
          </div>
          <p className="mt-2 text-[20px] font-black leading-tight">
            {brand} <span style={{ color: 'var(--servd-mute)' }}>#{job.orderNumber}</span>
          </p>
          {job.company?.name ? (
            <p className="text-[14px] font-bold" style={{ color: 'var(--servd-mute)' }}>For {job.company.name}</p>
          ) : null}
          <dl className="mt-3 grid gap-1.5 text-[15px] leading-snug">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 font-black" style={{ color: 'var(--servd-mute)' }}>From</dt>
              <dd className="min-w-0">{formatBrandName(job.pickup?.name) || brand}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 font-black" style={{ color: 'var(--servd-mute)' }}>To</dt>
              <dd className="min-w-0 line-clamp-2">
                {job.dropoff?.address || job.dropoff?.name || 'Customer — open for details'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 font-black" style={{ color: 'var(--servd-mute)' }}>Items</dt>
              <dd>{job.itemCount}</dd>
            </div>
          </dl>
        </div>
        <span className="mt-1 shrink-0" style={{ color: 'var(--servd-purple)' }}><ChevronIcon size={26} /></span>
      </div>
      {offered ? (
        <p className="mt-3 rounded-2xl px-4 py-3 text-center text-[17px] font-black"
          style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
          New job — open to accept
        </p>
      ) : null}
    </Link>
  )
}
