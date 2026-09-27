/**
 * Foley: a tiny Web Audio synth. No audio files, no dependencies.
 *
 * Sound is OFF by default. It turns on only through `setSoundOn(true)`, which
 * the FoleyToggle calls inside a click, so the AudioContext is born inside a
 * user gesture. The choice persists in localStorage ('servd:sound'); when a
 * returning visitor had it on, the context is created on their first
 * pointerdown / keydown (browsers refuse to start audio before one).
 *
 * `sfx()` is a silent no-op on the server, while sound is off, under
 * prefers-reduced-motion, or before the context exists. It never throws.
 *
 * Levels: every voice runs through one master gain (0.18) and a limiter, with
 * a 5ms attack on every envelope, so nothing clicks and nothing clips.
 */

export type SfxName = 'pop' | 'catch' | 'whoosh' | 'cheer' | 'stamp' | 'chime' | 'tick'
export type SfxTheme = 'servd' | 'simmer' | 'stackd' | 'flipd'

const STORAGE_KEY = 'servd:sound'
const MASTER = 0.18
const ATTACK = 0.005
/** Identical voices closer than this are merged (several crowds hear one cue). */
const THROTTLE_MS = 45

type Ctx = AudioContext

let loaded = false
let soundOn = false
let ctx: Ctx | null = null
let master: GainNode | null = null
let noiseBuf: AudioBuffer | null = null
let gestureArmed = false
const listeners = new Set<(on: boolean) => void>()
const lastPlayed = new Map<string, number>()

function isClient(): boolean {
  return typeof window !== 'undefined'
}

function reducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function load(): void {
  if (loaded || !isClient()) return
  loaded = true
  try {
    soundOn = window.localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    soundOn = false
  }
  if (soundOn) armGesture()
}

function audioCtor(): (new () => AudioContext) | null {
  if (!isClient()) return null
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** Create the context + master chain (must run inside a user gesture). */
function ensureCtx(): Ctx | null {
  if (ctx) return ctx
  const Ctor = audioCtor()
  if (!Ctor) return null
  try {
    const c = new Ctor()
    const limiter = c.createDynamicsCompressor()
    limiter.threshold.value = -8
    limiter.knee.value = 4
    limiter.ratio.value = 14
    limiter.attack.value = 0.002
    limiter.release.value = 0.12
    const g = c.createGain()
    g.gain.value = MASTER
    g.connect(limiter)
    limiter.connect(c.destination)

    // one second of white noise, shared by every noisy voice
    const buf = c.createBuffer(1, Math.floor(c.sampleRate), c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    ctx = c
    master = g
    noiseBuf = buf
    return c
  } catch {
    ctx = null
    master = null
    return null
  }
}

function resume(): void {
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      /* still locked; the next gesture tries again */
    })
  }
}

/** On the next pointerdown / keydown: create (if needed) and resume the context. */
function armGesture(): void {
  if (gestureArmed || !isClient()) return
  gestureArmed = true
  const onGesture = () => {
    if (!soundOn) return
    ensureCtx()
    resume()
    if (ctx && ctx.state === 'running') {
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
      gestureArmed = false
    }
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
}

export function isSoundOn(): boolean {
  load()
  return soundOn
}

export function setSoundOn(on: boolean): void {
  if (!isClient()) return
  load()
  soundOn = !!on
  try {
    window.localStorage.setItem(STORAGE_KEY, soundOn ? 'on' : 'off')
  } catch {
    /* private mode / blocked storage: the choice lasts for this page only */
  }
  if (soundOn) {
    ensureCtx()
    resume()
    if (!ctx || ctx.state !== 'running') armGesture()
  } else if (ctx && ctx.state === 'running') {
    ctx.suspend().catch(() => {})
  }
  listeners.forEach((cb) => {
    try {
      cb(soundOn)
    } catch {
      /* ignore */
    }
  })
}

export function onSoundChange(cb: (on: boolean) => void): () => void {
  load()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/* ------------------------------------------------------------------ */
/* voices                                                             */
/* ------------------------------------------------------------------ */

/** Gain node with a 5ms attack to `peak`, exponential decay to silence at t0+dur. */
function envGain(c: Ctx, t0: number, peak: number, dur: number): GainNode {
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.linearRampToValueAtTime(peak, t0 + ATTACK)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(ATTACK + 0.004, dur))
  g.connect(master!)
  return g
}

function tone(c: Ctx, type: OscillatorType, f0: number, f1: number | null, t0: number, dur: number, peak: number): void {
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t0)
  if (f1 !== null) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur)
  o.connect(envGain(c, t0, peak, dur))
  o.start(t0)
  o.stop(t0 + dur + 0.03)
}

function noise(
  c: Ctx,
  t0: number,
  dur: number,
  peak: number,
  filter: BiquadFilterType,
  f0: number,
  f1: number | null,
  q = 1,
): void {
  if (!noiseBuf) return
  const src = c.createBufferSource()
  src.buffer = noiseBuf
  src.loop = true
  const bq = c.createBiquadFilter()
  bq.type = filter
  bq.Q.value = q
  bq.frequency.setValueAtTime(f0, t0)
  if (f1 !== null) bq.frequency.exponentialRampToValueAtTime(f1, t0 + dur)
  src.connect(bq)
  bq.connect(envGain(c, t0, peak, dur))
  src.start(t0, Math.random() * 0.5)
  src.stop(t0 + dur + 0.03)
}

function play(c: Ctx, name: SfxName, theme: SfxTheme): void {
  const t0 = c.currentTime + 0.005
  if (theme === 'simmer') {
    // simmer: hushed service. No pops, catches or cheers.
    switch (name) {
      case 'whoosh':
        noise(c, t0, 0.34, 0.6, 'lowpass', 600, 380, 0.7) // a low swish, a napkin past the table
        return
      case 'stamp':
        tone(c, 'sine', 180, 150, t0, 0.12, 0.8) // a soft wood tock
        noise(c, t0, 0.02, 0.18, 'bandpass', 900, null, 2)
        return
      case 'chime':
        tone(c, 'sine', 440, null, t0, 0.9, 0.5) // a single bell
        return
      case 'tick':
        noise(c, t0, 0.008, 0.25, 'lowpass', 1800, null, 0.7)
        return
      default:
        return
    }
  }
  switch (name) {
    case 'pop':
      tone(c, 'sine', 520, 880, t0, 0.09, 0.9)
      return
    case 'catch':
      tone(c, 'triangle', 660, null, t0, 0.06, 0.8)
      tone(c, 'triangle', 990, null, t0 + 0.06, 0.06, 0.8)
      return
    case 'whoosh':
      noise(c, t0, 0.28, 0.7, 'bandpass', 400, 2400, 1.1)
      return
    case 'cheer': {
      // three rising square blips at an output level of ~0.08
      const peak = 0.08 / MASTER
      const notes = [523.25, 659.25, 783.99]
      notes.forEach((f, i) => tone(c, 'square', f, null, t0 + i * 0.075, 0.07, peak))
      return
    }
    case 'stamp':
      tone(c, 'sine', 90, 55, t0, 0.16, 1)
      noise(c, t0, 0.018, 0.4, 'highpass', 2200, null, 0.7)
      return
    case 'chime':
      tone(c, 'sine', 880, null, t0, 0.3, 0.45)
      tone(c, 'sine', 1320, null, t0, 0.3, 0.3)
      return
    case 'tick':
      noise(c, t0, 0.008, 0.45, 'highpass', 3000, null, 0.7)
      return
  }
}

/** Play a foley cue. Silent unless sound is on. Never throws. */
export function sfx(name: SfxName, opts?: { theme?: SfxTheme }): void {
  if (!isClient()) return
  load()
  if (!soundOn || reducedMotion()) return
  const c = ctx
  if (!c || !master) {
    armGesture()
    return
  }
  if (c.state === 'suspended') resume()
  const theme = opts?.theme ?? 'servd'
  const key = theme + ':' + name
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prev = lastPlayed.get(key)
  if (prev !== undefined && now - prev < THROTTLE_MS) return
  lastPlayed.set(key, now)
  try {
    play(c, name, theme)
  } catch {
    /* an audio node refused; foley is garnish */
  }
}
