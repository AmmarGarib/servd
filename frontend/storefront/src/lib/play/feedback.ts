// Haptics and sound for toys. Both are opt-out/opt-in in the sticker book:
// haptics default on, sound default OFF. Sound is synthesised with WebAudio
// (no audio files); a single AudioContext is created lazily on a user gesture.

import { usePlay, hydratePlay } from './store'

export type SfxName = 'pop' | 'ding' | 'whoosh' | 'thunk' | 'clack'

function settings(): { sound: boolean; haptics: boolean } {
  hydratePlay()
  const s = usePlay.getState()
  return { sound: s.sound, haptics: s.haptics }
}

/** navigator.vibrate, only when haptics are on. */
export function buzz(ms: number = 12): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  if (!settings().haptics) return
  try {
    navigator.vibrate(Math.max(1, Math.round(ms)))
  } catch {
    /* ignore */
  }
}

// ── audio ───────────────────────────────────────────────────────────────────

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null
let armed = false

function ctor(): AudioCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const C = ctor()
  if (!C) return null
  try {
    ctx = new C()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  } catch {
    ctx = null
    master = null
  }
  return ctx
}

/**
 * Create (or resume) the AudioContext. Call from inside a user gesture, such
 * as the sound toggle's click. Does nothing while sound is off.
 */
export function unlockAudio(force = false): void {
  if (!force && !settings().sound) return
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume().catch(() => {})
}

/**
 * Arm a one-time listener that unlocks audio on the first pointer or key
 * gesture, if sound is on. The PlayLayer calls this once on mount.
 */
export function armAudio(): void {
  if (armed || typeof window === 'undefined') return
  armed = true
  const once = () => {
    if (!settings().sound) return // stay armed until sound is switched on
    unlockAudio()
    window.removeEventListener('pointerdown', once, true)
    window.removeEventListener('keydown', once, true)
  }
  window.addEventListener('pointerdown', once, true)
  window.addEventListener('keydown', once, true)
}

function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise
  const len = Math.floor(c.sampleRate * 0.3)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  noise = buf
  return buf
}

function env(c: AudioContext, peak: number, attack: number, dur: number, at: number): GainNode {
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(peak, at + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  return g
}

function tone(c: AudioContext, out: AudioNode, type: OscillatorType, from: number, to: number, dur: number, peak: number, at: number): void {
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(from, at)
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + dur)
  const g = env(c, peak, 0.006, dur, at)
  o.connect(g).connect(out)
  o.start(at)
  o.stop(at + dur + 0.02)
}

function burst(c: AudioContext, out: AudioNode, dur: number, peak: number, at: number, filter: BiquadFilterNode): void {
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(c)
  const g = env(c, peak, 0.004, dur, at)
  src.connect(filter).connect(g).connect(out)
  src.start(at)
  src.stop(at + dur + 0.02)
}

/** A short synthesised blip. Silent unless sound is switched on. */
export function sfx(name: SfxName): void {
  if (typeof window === 'undefined') return
  if (!settings().sound) return
  const c = getCtx()
  if (!c || !master) return
  if (c.state === 'suspended') void c.resume().catch(() => {})
  const t = c.currentTime + 0.005
  const out = master
  try {
    switch (name) {
      case 'pop':
        tone(c, out, 'triangle', 660, 990, 0.07, 0.35, t)
        break
      case 'ding':
        tone(c, out, 'sine', 1320, 1320, 0.18, 0.3, t)
        tone(c, out, 'sine', 2640, 2640, 0.09, 0.06, t)
        break
      case 'whoosh': {
        const bp = c.createBiquadFilter()
        bp.type = 'bandpass'
        bp.Q.value = 1.4
        bp.frequency.setValueAtTime(380, t)
        bp.frequency.exponentialRampToValueAtTime(2600, t + 0.22)
        burst(c, out, 0.22, 0.28, t, bp)
        break
      }
      case 'thunk':
        tone(c, out, 'sine', 140, 90, 0.06, 0.5, t)
        break
      case 'clack': {
        for (const dt of [0, 0.045]) {
          const hp = c.createBiquadFilter()
          hp.type = 'highpass'
          hp.frequency.value = 1800
          burst(c, out, 0.018, 0.4, t + dt, hp)
        }
        break
      }
    }
  } catch {
    /* decorative */
  }
}
