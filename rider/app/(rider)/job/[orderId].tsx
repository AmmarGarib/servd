// Job detail. Everything the rider needs for one delivery, top to bottom:
// brand + company, the kitchen (navigate / call), the customer (navigate /
// call), the items, the cash to collect — and one big step button pinned to
// the bottom for the current stage:
//
//   offered    Accept / Decline (with a reason)
//   accepted   Picked up      (409 NOT_READY until the kitchen marks it ready)
//   picked_up  Arrived
//   arrived    Enter customer code (4 digits; attempts left; locked after 5 ->
//              call the kitchen, a manager marks it delivered in admin)
//
// Each step sends the rider's last known position with it.

import { useEffect, useState } from 'react'
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'

import { Button } from '../../../src/components/Button'
import { Banner, Card, Label, StageBadge } from '../../../src/components/Card'
import { api, ApiError, errorDetail, friendlyError } from '../../../src/lib/api'
import { formatBrandName } from '../../../src/lib/brand'
import { formatPhone, pkr, shortTime } from '../../../src/lib/format'
import { callNumber, openDirections } from '../../../src/lib/links'
import { quickFix } from '../../../src/lib/location'
import { qk, useJob } from '../../../src/lib/queries'
import { colors, theme } from '../../../src/lib/theme'
import type { Job, JobPlace } from '../../../src/lib/types'
import { sessionStore } from '../../../src/store/session'

type StepAction = 'accept' | 'decline' | 'picked-up' | 'arrived'

const DECLINE_REASONS = ['Too far', 'Vehicle problem', 'Already carrying an order', 'Other'] as const
const OTP_LENGTH = 4
const OTP_MAX_ATTEMPTS = 5

const ORDER_STATUS: Record<string, string> = {
  received: 'Received',
  confirmed: 'Confirmed',
  preparing: 'Being prepared',
  ready: 'Ready for pick-up',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  refunded: 'Refunded',
}

export default function JobScreen() {
  const { orderId: rawId } = useLocalSearchParams<{ orderId: string }>()
  const orderId = String(rawId ?? '')
  const router = useRouter()
  const qc = useQueryClient()
  const insets = useSafeAreaInsets()
  // 'code' = this rider's code just closed it; 'already' = the server says it
  // was delivered before (an earlier try that timed out on the phone but
  // landed, or a manager closed it from admin).
  const [delivered, setDelivered] = useState<'code' | 'already' | null>(null)
  const q = useJob(orderId, !delivered)
  // React Query keeps the last good data after an error, so a 404 (the job
  // was cancelled, re-assigned or closed from admin) must hide it explicitly.
  const gone = q.error instanceof ApiError && q.error.status === 404
  const job = gone ? undefined : q.data?.job

  const [busy, setBusy] = useState<StepAction | 'deliver' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [declining, setDeclining] = useState(false)
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)

  // Back to the list — also when the screen was opened without history.
  function leave() {
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }

  // The server's count wins whenever a fresh job arrives.
  useEffect(() => {
    if (typeof job?.otpAttemptsLeft === 'number') {
      setAttemptsLeft(job.otpAttemptsLeft)
      if (job.otpAttemptsLeft <= 0) setLocked(true)
    }
  }, [job?.otpAttemptsLeft])

  async function refreshAll() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.job(orderId) }),
      qc.invalidateQueries({ queryKey: qk.jobs }),
      qc.invalidateQueries({ queryKey: qk.me }),
    ])
  }

  async function step(action: StepAction, extra: Record<string, unknown> = {}) {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const fix = await quickFix()
      const res = await api.post<{ job?: Job } | undefined>(
        `/rider/jobs/${encodeURIComponent(orderId)}/${action}`,
        { ...(fix ?? {}), ...extra },
      )
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      if (action === 'decline') {
        setDeclining(false)
        qc.removeQueries({ queryKey: qk.job(orderId) })
        await qc.invalidateQueries({ queryKey: qk.jobs })
        leave()
        return
      }
      // From here the rider is carrying it: tag location fixes straight away,
      // without waiting for the jobs list to refetch.
      if (action === 'picked-up') await sessionStore.getState().setActiveOrderId(orderId)
      if (res?.job) qc.setQueryData(qk.job(orderId), { job: res.job })
      await refreshAll()
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      setError(stepErrorMessage(err))
      void refreshAll()
    } finally {
      setBusy(null)
    }
  }

  // The job is over: stop tagging fixes with it and drop it from the lists.
  async function closeJob(how: 'code' | 'already') {
    setDelivered(how)
    if (sessionStore.getState().activeOrderId === orderId) await sessionStore.getState().setActiveOrderId(null)
    qc.removeQueries({ queryKey: qk.job(orderId) })
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.jobs }),
      qc.invalidateQueries({ queryKey: qk.me }),
    ])
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
      const fix = await quickFix()
      await api.post(`/rider/jobs/${encodeURIComponent(orderId)}/deliver`, { otp, ...(fix ?? {}) })
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      await closeJob('code')
    } catch (err) {
      setOtp('')
      if (err instanceof ApiError && err.code === 'ALREADY_DELIVERED') {
        // Nothing went wrong for the rider: it is done.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
        await closeJob('already')
        return
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      if (err instanceof ApiError && (err.status === 423 || err.code === 'OTP_LOCKED')) {
        setLocked(true)
        setAttemptsLeft(0)
      } else if (err instanceof ApiError && (err.status === 403 || err.code === 'OTP_MISMATCH')) {
        const left = errorDetail(err, 'attemptsLeft')
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
      } else {
        setOtpError(stepErrorMessage(err))
      }
    } finally {
      setBusy(null)
    }
  }

  // ─── Delivered ────────────────────────────────────────────────────────────
  if (delivered) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.padLg, justifyContent: 'center', gap: 18 }}>
        <Stack.Screen options={{ title: 'Delivered' }} />
        <View style={{
          width: 88, height: 88, borderRadius: 44, backgroundColor: colors.green, alignSelf: 'center',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {/* A tick drawn from two borders — a shape, not an emoji */}
          <View style={{
            width: 44, height: 24, marginTop: -10,
            borderLeftWidth: 9, borderBottomWidth: 9, borderColor: colors.purple,
            transform: [{ rotate: '-45deg' }],
          }} />
        </View>
        <Text style={{ color: colors.ink, fontSize: 30, fontWeight: '900', textAlign: 'center' }}>Delivered</Text>
        <Text style={{ color: colors.textDim, fontSize: 17, textAlign: 'center', lineHeight: 24 }}>
          {delivered === 'already'
            ? 'This order is already marked delivered. Nothing more to do.'
            : 'The code matched and the order is closed. Thank you.'}
        </Text>
        <Button label="Back to jobs" size="xl" onPress={leave} />
      </View>
    )
  }

  // ─── Loading / gone ───────────────────────────────────────────────────────
  if (!job) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.padLg, justifyContent: 'center', gap: 16 }}>
        <Stack.Screen options={{ title: 'Job' }} />
        {q.isLoading ? (
          <Text style={{ color: colors.textDim, fontSize: 17, textAlign: 'center' }}>Loading the job…</Text>
        ) : gone ? (
          <>
            <Text style={{ color: colors.ink, fontSize: 24, fontWeight: '900', textAlign: 'center' }}>
              This job is no longer yours
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22 }}>
              It was finished, cancelled, or given to another rider. Nothing more to do here.
            </Text>
            <Button label="Back to jobs" size="lg" onPress={leave} />
          </>
        ) : (
          <>
            <Banner tone="danger" title="Could not load this job" body={friendlyError(q.error)} />
            <Button label="Try again" size="lg" onPress={() => void q.refetch()} />
            <Button label="Back to jobs" intent="ghost" onPress={leave} />
          </>
        )}
      </View>
    )
  }

  const brand = formatBrandName(job.brand?.name)
  const cash = job.cashToCollectCents ?? 0

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <Stack.Screen options={{ title: `${brand} #${job.orderNumber}` }} />

      <ScrollView
        contentContainerStyle={{ padding: theme.pad, gap: 14, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled">
        {/* Who and what */}
        <View style={{ gap: 6 }}>
          <StageBadge stage={job.stage} large />
          <Text style={{ color: colors.ink, fontSize: 28, fontWeight: '900' }}>
            {brand} <Text style={{ color: colors.textDim }}>#{job.orderNumber}</Text>
          </Text>
          {job.company?.name ? (
            <Text style={{ color: colors.textDim, fontSize: 16, fontWeight: '700' }}>
              For {job.company.name}
            </Text>
          ) : null}
          <Text style={{ color: colors.textDim, fontSize: 15 }}>
            Kitchen: {ORDER_STATUS[job.status] ?? job.status}
          </Text>
        </View>

        {/* Cash */}
        {cash > 0 ? (
          <View style={{
            backgroundColor: colors.warnBg, borderRadius: theme.radiusLg, padding: theme.pad,
            borderWidth: 2, borderColor: colors.warn,
          }}>
            <Label color={colors.warn}>CASH TO COLLECT</Label>
            <Text style={{ color: colors.ink, fontSize: 34, fontWeight: '900' }}>{pkr(cash)}</Text>
            <Text style={{ color: colors.ink, fontSize: 15, marginTop: 2 }}>Collect this in cash before you hand over.</Text>
          </View>
        ) : (
          <Card tone="green">
            <Text style={{ color: colors.greenText, fontSize: 18, fontWeight: '900' }}>Prepaid — collect nothing</Text>
          </Card>
        )}

        <PlaceCard
          label="PICK UP FROM"
          title={formatBrandName(job.pickup?.name) || brand}
          place={job.pickup}
          callLabel="Call kitchen"
        />
        <PlaceCard
          label="DELIVER TO"
          title={job.dropoff?.name || 'Customer'}
          place={job.dropoff}
          callLabel="Call customer"
        />

        {/* Items */}
        <Card>
          <Label>ITEMS ({job.itemCount})</Label>
          <View style={{ gap: 8 }}>
            {(job.items ?? []).map((it, i) => (
              <View key={`${it.name}-${i}`} style={{ flexDirection: 'row', gap: 10 }}>
                <Text style={{ color: colors.purple, fontSize: 17, fontWeight: '900', minWidth: 34 }}>{it.qty} ×</Text>
                <Text style={{ color: colors.ink, fontSize: 17, flex: 1 }}>{it.name}</Text>
              </View>
            ))}
          </View>
        </Card>

        {job.notes ? (
          <Card>
            <Label>NOTES</Label>
            <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 22 }}>{job.notes}</Text>
          </Card>
        ) : null}

        <Timeline job={job} />
      </ScrollView>

      {/* The step — pinned to the bottom, where the thumb is */}
      <View style={{
        backgroundColor: colors.card,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingHorizontal: theme.pad,
        paddingTop: 14,
        paddingBottom: insets.bottom + 14,
        gap: 10,
      }}>
        {error ? <Banner tone="danger" title="Not done" body={error} /> : null}

        {job.stage === 'offered' && !declining ? (
          <>
            <Button label="Accept job" size="xl" busy={busy === 'accept'} disabled={!!busy} onPress={() => void step('accept')} />
            <Button label="Decline" intent="ghost" disabled={!!busy} onPress={() => setDeclining(true)} />
          </>
        ) : null}

        {job.stage === 'offered' && declining ? (
          <>
            <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '900' }}>Why are you declining?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {DECLINE_REASONS.map(r => (
                <Pressable
                  key={r}
                  disabled={!!busy}
                  onPress={() => void step('decline', { reason: r })}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    minHeight: theme.tapMin, paddingHorizontal: 16, justifyContent: 'center',
                    borderRadius: 999, borderWidth: 2, borderColor: colors.purple,
                    backgroundColor: pressed ? colors.infoBg : colors.transparent,
                    opacity: busy ? 0.5 : 1,
                  })}>
                  <Text style={{ color: colors.purple, fontSize: 16, fontWeight: '800' }}>{r}</Text>
                </Pressable>
              ))}
            </View>
            <Button label="Keep the job" intent="ghost" disabled={!!busy} onPress={() => setDeclining(false)} />
          </>
        ) : null}

        {job.stage === 'accepted' ? (
          <>
            <Text style={{ color: colors.textDim, fontSize: 15, textAlign: 'center' }}>
              {job.status === 'ready'
                ? 'The order is ready. Tap once the kitchen hands it to you.'
                : 'The kitchen is still on it. Tap once they hand it to you.'}
            </Text>
            <Button label="Picked up" size="xl" busy={busy === 'picked-up'} onPress={() => void step('picked-up')} />
          </>
        ) : null}

        {job.stage === 'picked_up' ? (
          <Button label="Arrived at customer" size="xl" busy={busy === 'arrived'} onPress={() => void step('arrived')} />
        ) : null}

        {job.stage === 'arrived' ? (
          locked ? (
            <>
              <Banner
                tone="danger"
                title="Code locked"
                body={`${OTP_MAX_ATTEMPTS} wrong codes were entered. Call the kitchen — a manager will mark the order delivered.`}
              />
              <Button label="Call the kitchen" size="xl" intent="secondary" onPress={() => void callNumber(job.pickup?.phone)} />
            </>
          ) : (
            <>
              <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '900' }}>Enter customer code</Text>
              <Text style={{ color: colors.textDim, fontSize: 14 }}>
                The customer has a {OTP_LENGTH}-digit code on their order page and on WhatsApp.
                {typeof attemptsLeft === 'number' ? ` ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.` : ''}
              </Text>
              <TextInput
                value={otp}
                onChangeText={(v) => { setOtp(v.replace(/\D/g, '').slice(0, OTP_LENGTH)); if (otpError) setOtpError(null) }}
                placeholder={'0'.repeat(OTP_LENGTH)}
                placeholderTextColor={colors.borderHi}
                keyboardType="number-pad"
                maxLength={OTP_LENGTH}
                editable={!busy}
                returnKeyType="done"
                onSubmitEditing={() => void deliver()}
                accessibilityLabel="Customer code"
                style={{
                  backgroundColor: colors.bone, color: colors.ink,
                  borderWidth: 2, borderColor: otpError ? colors.danger : colors.borderHi,
                  borderRadius: theme.radius, minHeight: 68,
                  fontSize: 36, fontWeight: '900', letterSpacing: 18, textAlign: 'center',
                }}
              />
              {otpError ? <Text style={{ color: colors.danger, fontSize: 15, fontWeight: '700' }}>{otpError}</Text> : null}
              <Button
                label="Complete delivery"
                size="xl"
                busy={busy === 'deliver'}
                disabled={otp.length !== OTP_LENGTH}
                onPress={() => void deliver()}
              />
            </>
          )
        ) : null}
      </View>
    </KeyboardAvoidingView>
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
      <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '900' }}>{title}</Text>
      {p.address ? (
        <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 22, marginTop: 4 }}>{p.address}</Text>
      ) : (
        <Text style={{ color: colors.textMuted, fontSize: 15, marginTop: 4 }}>No address given — call for directions.</Text>
      )}
      {p.phone ? (
        <Text style={{ color: colors.textDim, fontSize: 15, marginTop: 4 }}>{formatPhone(p.phone)}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <View style={{ flex: 1 }}>
          <Button label="Navigate" intent="secondary" onPress={() => void openDirections(p)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label={callLabel} intent="ghost" disabled={!p.phone} onPress={() => void callNumber(p.phone)} />
        </View>
      </View>
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
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 4 }}>
      {rows.map(([label, at]) => (
        <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{
            width: 10, height: 10, borderRadius: 5,
            backgroundColor: at ? colors.green : colors.transparent,
            borderWidth: 2, borderColor: at ? colors.green : colors.borderHi,
          }} />
          <Text style={{ color: at ? colors.ink : colors.textMuted, fontSize: 13, fontWeight: '700' }}>
            {label}{at ? ` ${shortTime(at)}` : ''}
          </Text>
        </View>
      ))}
    </View>
  )
}

function stepErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'NOT_READY') {
      return 'The kitchen has not marked this order ready yet. Wait at the counter and tap again when they hand it over.'
    }
    if (err.status === 404) {
      return 'This job is no longer yours — it was cancelled or given to another rider.'
    }
    if (err.status === 409 || err.status === 422) return err.message
  }
  return friendlyError(err)
}
