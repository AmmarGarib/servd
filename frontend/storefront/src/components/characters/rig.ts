/**
 * Animation rig for one character: idle breathing/bob/sway, blinks, eye
 * tracking, lean-toward-cursor, hops with squash & stretch, spins, arms-up,
 * plus the acting layer: seeded idle "bits" (double blink, neighbour glance,
 * stretch, bounce, camera look, per-kind quirk), a hop-in walk-on entrance,
 * and directed actions (focus, wave, gasp, catch).
 *
 * Hierarchy:  root (layout) → hop (jump height, spin) → squash (scale)
 *             → lean (tilt / turn) → model
 *
 * Nothing in `update` allocates: every scratch vector is module-level.
 */
import * as THREE from 'three'
import type { CharacterKind } from './types'
import type { BuiltCharacter } from './characters'

export interface FrameContext {
  t: number
  dt: number
  /** World-space point the crowd is looking at. */
  target: THREE.Vector3
  /** Camera world position (for camera looks and the reduced-motion pose). */
  camera: THREE.Vector3
  excitement: number
  reduced: boolean
}

/** The one static pose rendered under reduced motion. */
export type StillPose = 'rest' | 'cheer' | 'gasp' | 'wave'

type Bit = 'blink' | 'glance' | 'stretch' | 'bounce' | 'camera' | 'quirk'

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
/** 0→1 over `a`, hold, 1→0 over the last `b` of a unit interval. */
const envelope = (p: number, a: number, b: number) => (p <= 0 || p >= 1 ? 0 : Math.min(1, p / a, (1 - p) / b))

/** Deterministic PRNG (mulberry32). */
function rng32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const KIND_SEED: Record<CharacterKind, number> = { fries: 11, burger: 23, coffee: 37, sandwich: 41, shake: 53, croissant: 67 }
const QUIRK_DUR: Record<CharacterKind, number> = { coffee: 1.1, fries: 0.8, burger: 0.95, shake: 1.0, croissant: 1.15, sandwich: 0.9 }

const WALK_HOP = 0.35
const WALK_H = 0.25

const _v = new THREE.Vector3()
const _look = new THREE.Vector3()

export class Character {
  readonly root = new THREE.Group()
  readonly hop = new THREE.Group()
  readonly squash = new THREE.Group()
  readonly lean = new THREE.Group()
  readonly hit: THREE.Mesh
  readonly shadow: THREE.Mesh | null

  private phase = Math.random() * TAU
  private swayRate = 1.1 + Math.random() * 0.5

  // layout home (set by the engine; the rig offsets from it every frame)
  private homeX = 0
  private homeZ = 0
  private homeRotY = 0
  private homeScale = 1

  // jump state
  private jumpDelay = 0
  private jumpT = -1
  private jumpDur = 0.6
  private jumpH = 0
  private spinDir = 0
  private armsUpTarget = 0
  private armsUp = 0

  // squash spring
  private spring = 0
  private springV = 0

  private happy = 0
  hovered = false
  private happyHold = 0
  private smile = 0

  private nextBlink = 1 + Math.random() * 4
  private blinkT = -1
  private doubleBlink = false

  // lean state (kept separately so additive offsets never feed back into damping)
  private leanX = 0
  private leanY = 0
  private leanZ = 0

  // entrance: grow up out of the floor with an overshoot. -1 = not running.
  private introDelay = 0
  private introT = -1
  private introScale = 1

  // entrance: hop in from off-stage. -1 = not running.
  private walkDelay = 0
  private walkT = -1
  private walkFromX = 0
  private walkHops = 2
  private walkHopIdx = 0
  private walkX = 0
  private walkTurn = 0

  // idle bits
  private rand: () => number = Math.random
  private nextBit = 2 + Math.random() * 3
  private bit: Bit | null = null
  private bitT = 0
  private bitDur = 0
  /** Neighbours in the row (set by the engine after layout). */
  left: Character | null = null
  right: Character | null = null

  // attention: who / what the head and eyes turn to, over the shared target
  private watch: Character | null = null
  private watchCamera = false
  private focusOf: Character | null = null
  private attnW = 0
  private readonly attnPoint = new THREE.Vector3()

  // actions
  private focused = false
  private focusAmt = 0
  private waveDelay = 0
  private waveT = -1
  private readonly waveDur = 1.2
  private gaspDelay = 0
  private gaspT = -1
  private readonly gaspDur = 0.7
  private readonly puffBaseY: number

  /** Reduced motion: the pose rendered once. */
  pose: StillPose = 'rest'

  constructor(
    readonly kind: CharacterKind,
    readonly built: BuiltCharacter,
    hitGeo: THREE.BufferGeometry,
    hitMat: THREE.Material,
    shadowGeo: THREE.BufferGeometry | null,
    shadowMat: THREE.Material | null,
  ) {
    this.root.name = kind
    this.lean.add(built.model)
    this.squash.add(this.lean)
    this.hop.add(this.squash)
    this.root.add(this.hop)

    this.hit = new THREE.Mesh(hitGeo, hitMat)
    this.hit.visible = false
    this.hit.scale.set(built.width * 0.85, built.height, 0.7)
    this.hit.position.y = built.height / 2
    this.hit.userData.character = this
    this.hop.add(this.hit)

    if (shadowGeo && shadowMat) {
      this.shadow = new THREE.Mesh(shadowGeo, shadowMat)
      this.shadow.rotation.x = -Math.PI / 2
      this.shadow.position.y = 0.003
      this.shadow.renderOrder = 1
      this.shadow.scale.set(built.width * 1.05, built.width * 0.6, 1)
      this.root.add(this.shadow)
    } else {
      this.shadow = null
    }

    for (const arm of built.arms) arm.rotation.z = (arm.userData.side as number) * built.armRest
    this.puffBaseY = built.parts?.puff?.position.y ?? 0
  }

  /* ================================================================ */
  /* layout + seeding                                                 */
  /* ================================================================ */

  /** Seed the personal idle timer from kind + slot index. */
  setSeed(index: number, t: number): void {
    this.rand = rng32(KIND_SEED[this.kind] * 7919 + index * 104729 + 1)
    this.nextBit = t + 1.6 + this.rand() * 3.2
  }

  /** Where this character stands in the row (world units). */
  setHome(x: number, z: number, rotY: number, scale: number): void {
    this.homeX = x
    this.homeZ = z
    this.homeRotY = rotY
    this.homeScale = scale
    this.applyRoot()
  }

  get homePosX(): number {
    return this.homeX
  }

  /* ================================================================ */
  /* entrances                                                        */
  /* ================================================================ */

  /** Start hidden and pop up out of the floor after `delay` seconds. */
  enter(delay: number): void {
    this.walkT = -1
    this.walkX = 0
    this.introDelay = delay
    this.introT = 0
    this.introScale = 0.0001
    this.applyRoot()
  }

  /** Start off-stage at world x `fromX` and hop home in `hops` hops. */
  walkIn(delay: number, fromX: number, hops: number): void {
    this.introT = -1
    this.introScale = 1
    this.walkDelay = delay
    this.walkT = 0
    this.walkFromX = fromX
    this.walkHops = Math.max(1, Math.round(hops))
    this.walkHopIdx = 0
    this.walkX = fromX - this.homeX
    this.walkTurn = 0
    this.applyRoot()
  }

  /** Skip any running entrance (placed immediately). */
  place(): void {
    this.introT = -1
    this.introScale = 1
    this.walkT = -1
    this.walkX = 0
    this.walkTurn = 0
    this.applyRoot()
  }

  private get entering(): boolean {
    return this.introT >= 0 || this.walkT >= 0
  }

  /* ================================================================ */
  /* actions                                                          */
  /* ================================================================ */

  /** Queue a hop. `big` = click jump with a spin. */
  jump(opts: { height: number; duration: number; spin?: boolean; armsUp?: boolean; delay?: number }): void {
    if (this.jumpT >= 0 && this.jumpT / this.jumpDur < 0.8) {
      // already airborne: just upgrade the flourish
      if (opts.armsUp) this.armsUpTarget = 1
      return
    }
    this.jumpDelay = opts.delay ?? 0
    this.jumpT = 0
    this.jumpDur = opts.duration
    this.jumpH = opts.height
    this.spinDir = opts.spin ? (Math.random() < 0.5 ? -1 : 1) : 0
    if (opts.armsUp) this.armsUpTarget = 1
    this.happyHold = Math.max(this.happyHold, opts.duration + (opts.delay ?? 0) + 0.25)
  }

  get airborne(): boolean {
    return this.jumpT >= 0
  }

  /** Step forward (z +0.6, scale 1.08) and wave; `false` steps back into line. */
  setFocused(on: boolean): void {
    if (on === this.focused) return
    this.focused = on
    if (on) {
      this.endBit()
      this.wave(0.15)
      this.happyHold = Math.max(this.happyHold, 1.6)
    }
  }

  /** Turn the head to the focused character (null = back to the shared target). */
  setFocusOf(c: Character | null): void {
    this.focusOf = c
    if (c) this.endBit()
  }

  wave(delay = 0): void {
    this.waveDelay = delay
    this.waveT = 0
    this.happyHold = Math.max(this.happyHold, this.waveDur + delay)
  }

  gasp(delay = 0): void {
    this.endBit()
    this.gaspDelay = delay
    this.gaspT = 0
    this.jump({ height: 0.1, duration: 0.34, delay })
    this.happyHold = 0
  }

  catchIt(delay = 0): void {
    this.endBit()
    this.jump({ height: 0.18, duration: 0.46, armsUp: true, delay })
    this.springV -= 1.2
    this.smile = 1
  }

  /* ================================================================ */
  /* idle bits                                                        */
  /* ================================================================ */

  /** True when this character's personal timer has come due. */
  bitDue(t: number): boolean {
    return this.bit === null && t >= this.nextBit
  }

  /** Whether a bit may start right now. */
  bitReady(excitement: number): boolean {
    return (
      !this.hovered &&
      !this.airborne &&
      excitement <= 0.5 &&
      !this.entering &&
      !this.focused &&
      this.focusOf === null &&
      this.gaspT < 0 &&
      this.waveT < 0
    )
  }

  /** Push the timer back (another character just started, or not ready). */
  deferBit(until: number): void {
    this.nextBit = Math.max(this.nextBit, until)
  }

  startBit(t: number): void {
    const r = this.rand()
    const bit: Bit = r < 0.18 ? 'blink' : r < 0.36 ? 'glance' : r < 0.5 ? 'stretch' : r < 0.6 ? 'bounce' : r < 0.76 ? 'camera' : 'quirk'
    this.nextBit = t + 4 + this.rand() * 5
    this.bitT = 0
    this.bitDur = 0
    switch (bit) {
      case 'blink':
        this.blinkT = 0
        this.doubleBlink = true
        return // one-shot; no running bit
      case 'bounce':
        this.jump({ height: 0.12, duration: 0.42 })
        return
      case 'glance': {
        const n = this.left && this.right ? (this.rand() < 0.5 ? this.left : this.right) : (this.left ?? this.right)
        if (n) this.watch = n
        else this.watchCamera = true
        this.bitDur = 1.2
        break
      }
      case 'stretch':
        this.bitDur = 0.4
        break
      case 'camera':
        this.watchCamera = true
        this.bitDur = 1.4
        break
      case 'quirk':
        this.bitDur = QUIRK_DUR[this.kind]
        break
    }
    this.bit = bit
  }

  private endBit(): void {
    if (this.bit === 'stretch') this.spring += 0.08 * clamp(this.bitT / 0.12, 0, 1)
    this.bit = null
    this.watch = null
    this.watchCamera = false
    this.resetParts()
  }

  private resetParts(): void {
    const p = this.built.parts
    if (!p) return
    if (p.lid) p.lid.rotation.set(0, 0, 0)
    if (p.lid) p.lid.position.x = 0
    if (p.puff) {
      p.puff.visible = false
      p.puff.position.y = this.puffBaseY
    }
    if (p.bunTop) p.bunTop.rotation.x = 0
    if (p.straw) p.straw.rotation.y = 0
    if (p.fill) p.fill.position.x = 0
    if (p.sticks) p.sticks.position.y = 0
  }

  /* ================================================================ */
  /* frame                                                            */
  /* ================================================================ */

  private applyRoot(): void {
    const gaspZ = -0.2 * this.gaspEnv()
    this.root.position.set(this.homeX + this.walkX, 0, this.homeZ + this.focusAmt * 0.6 + gaspZ)
    this.root.rotation.y = this.homeRotY + this.walkTurn
    this.root.scale.setScalar(Math.max(0.0001, this.homeScale * (1 + 0.08 * this.focusAmt) * this.introScale))
  }

  private gaspEnv(): number {
    if (this.gaspT < 0 || this.gaspDelay > 0) return 0
    const q = this.gaspT / this.gaspDur
    if (q <= 0 || q >= 1) return 0
    if (q < 0.22) return Math.sin((q / 0.22) * Math.PI * 0.5)
    if (q < 0.6) return 1
    return easeInOut(1 - (q - 0.6) / 0.4)
  }

  update(ctx: FrameContext): void {
    const { t, dt, excitement: ex, reduced } = ctx
    const face = this.built.face

    /* -------- attention: where head + eyes point -------- */
    let wantAttn = 0
    const lookAtChar = this.focusOf ?? this.watch
    if (reduced) {
      _look.copy(ctx.camera)
    } else {
      if (lookAtChar) {
        const n = lookAtChar.root
        this.attnPoint.set(n.position.x, lookAtChar.built.height * 0.72 * n.scale.y + n.position.y, n.position.z + 0.2)
        wantAttn = 1
      } else if (this.watchCamera) {
        this.attnPoint.copy(ctx.camera)
        wantAttn = 1
      }
      this.attnW = damp(this.attnW, wantAttn, 8, dt)
      _look.copy(ctx.target).lerp(this.attnPoint, this.attnW)
    }
    const attn = reduced ? 0 : this.attnW

    /* -------- eyes: always track (snap when reduced) -------- */
    const eyeLambda = reduced ? 1e6 : 14 + ex * 8
    for (const eye of face.eyes) {
      _v.copy(_look)
      eye.anchor.worldToLocal(_v)
      const len = _v.length() || 1
      const yaw = clamp(Math.atan2(_v.x, _v.z), -0.62, 0.62)
      const pitch = clamp(-Math.asin(clamp(_v.y / len, -1, 1)), -0.5, 0.45)
      eye.ball.rotation.y = damp(eye.ball.rotation.y, yaw, eyeLambda, dt)
      eye.ball.rotation.x = damp(eye.ball.rotation.x, pitch, eyeLambda, dt)
    }

    // body turn / lean toward the look point (in root space)
    _v.copy(_look)
    this.root.worldToLocal(_v)
    const toward = Math.atan2(_v.x, Math.max(0.5, _v.z))
    const reach = 0.28 + ex * 0.35 + attn * 0.45
    const lim = 0.45 + attn * 0.3
    const turnY = clamp(toward * reach, -lim, lim)
    const tiltZ = clamp(-toward * (0.05 + ex * 0.12), -0.2, 0.2)
    const tiltX = clamp(Math.atan2(_v.y - this.built.height * 0.6, Math.max(0.5, _v.z)) * -0.08 * (1 + ex), -0.12, 0.12)

    if (reduced) {
      this.renderStill(tiltX, turnY)
      return
    }

    /* -------- entrance: grow -------- */
    if (this.introT >= 0) {
      if (this.introDelay > 0) {
        this.introDelay -= dt
      } else {
        this.introT += dt
        const p = Math.min(1, this.introT / 0.72)
        this.introScale = Math.max(0.0001, easeOutBack(p))
        if (p >= 1) {
          this.introT = -1
          this.introScale = 1
          this.springV -= 2.6 // landing jiggle
          this.happyHold = Math.max(this.happyHold, 0.6)
        }
      }
    }

    /* -------- idle life -------- */
    const bobRate = 2.1 * (1 + ex * 1.1)
    const breathe = Math.sin(t * bobRate + this.phase)
    let sq = 0.016 * breathe * (1 + ex)
    let y = Math.max(0, Math.sin(t * bobRate * 0.5 + this.phase)) * 0.012 * (1 + ex * 2.5)
    const sway = Math.sin(t * this.swayRate + this.phase * 1.7) * 0.03
    let extraZ = 0
    let extraY = 0

    /* -------- entrance: walk (hop in from off-stage) -------- */
    if (this.walkT >= 0) {
      if (this.walkDelay > 0) {
        this.walkDelay -= dt
        this.walkX = this.walkFromX - this.homeX
      } else {
        this.walkT += dt
        const total = this.walkHops * WALK_HOP
        if (this.walkT >= total) {
          this.walkT = -1
          this.walkX = 0
          this.walkTurn = 0
          this.springV -= 3.4 // the landing squash
          this.happyHold = Math.max(this.happyHold, 0.7)
        } else {
          const idx = Math.floor(this.walkT / WALK_HOP)
          if (idx !== this.walkHopIdx) {
            this.walkHopIdx = idx
            this.springV -= 2.2
          }
          const hp = (this.walkT - idx * WALK_HOP) / WALK_HOP
          const prog = (idx + easeInOut(hp)) / this.walkHops
          const dir = Math.sign(this.homeX - this.walkFromX) || 1
          this.walkX = (this.walkFromX - this.homeX) * (1 - prog)
          this.walkTurn = dir * 0.5 * (1 - prog * prog * prog)
          y += WALK_H * 4 * hp * (1 - hp)
          sq += 0.1 * (1 - Math.abs(1 - 2 * hp)) - 0.08 * Math.max(0, 1 - hp / 0.15)
        }
      }
    }

    // excited characters bounce on the spot now and then
    if (ex > 0.3 && this.jumpT < 0 && !this.entering && Math.random() < dt * (ex - 0.2) * 1.4) {
      this.jump({ height: 0.1 + 0.14 * ex, duration: 0.42 })
    }

    /* -------- idle bit in progress -------- */
    if (this.bit) {
      this.bitT += dt
      const p = this.bitDur > 0 ? this.bitT / this.bitDur : 1
      if (this.bit === 'stretch') {
        sq += 0.08 * Math.min(1, this.bitT / 0.12)
      } else if (this.bit === 'camera') {
        this.smile = Math.max(this.smile, envelope(p, 0.2, 0.3))
      } else if (this.bit === 'quirk') {
        const o = this.quirk(Math.min(1, p))
        extraZ += o.z
        extraY += o.y
        sq += o.sq
      }
      if (p >= 1 || this.hovered || this.airborne || ex > 0.5) this.endBit()
    }

    /* -------- jump -------- */
    let spin = 0
    if (this.jumpT >= 0) {
      if (this.jumpDelay > 0) {
        this.jumpDelay -= dt
      } else {
        this.jumpT += dt
        const p = this.jumpT / this.jumpDur
        const A = 0.2
        const strength = clamp(this.jumpH / 0.5, 0.35, 1)
        if (p < A) {
          sq += -0.24 * strength * Math.sin((p / A) * Math.PI * 0.5)
        } else if (p < 1) {
          const q = (p - A) / (1 - A)
          y += this.jumpH * 4 * q * (1 - q)
          const takeoff = 1 - Math.min(1, q / 0.12)
          const stretch = 0.16 * strength * Math.abs(1 - 2 * q)
          sq += -0.24 * strength * takeoff + stretch * (1 - takeoff)
          if (this.spinDir) spin = this.spinDir * TAU * easeInOut(q)
        } else {
          this.jumpT = -1
          this.springV -= 3.2 + this.jumpH * 5
          this.armsUpTarget = 0
        }
      }
    }

    /* -------- gasp -------- */
    let gaspEnv = 0
    if (this.gaspT >= 0) {
      if (this.gaspDelay > 0) this.gaspDelay -= dt
      else {
        this.gaspT += dt
        if (this.gaspT >= this.gaspDur) this.gaspT = -1
        else gaspEnv = this.gaspEnv()
      }
    }

    /* -------- focus -------- */
    this.focusAmt = damp(this.focusAmt, this.focused ? 1 : 0, 8, dt)
    if (!this.focused && this.focusAmt < 1e-3) this.focusAmt = 0

    // landing jiggle spring
    this.springV += (-190 * this.spring - 10 * this.springV) * dt
    this.spring += this.springV * dt
    sq += this.spring

    this.hop.position.y = y + extraY
    this.hop.rotation.y = spin
    const s = clamp(sq, -0.35, 0.3)
    this.squash.scale.set(1 - s * 0.55, 1 + s, 1 - s * 0.55)

    this.leanX = damp(this.leanX, tiltX, 5, dt)
    this.leanY = damp(this.leanY, turnY, 4 + ex * 4 + attn * 3, dt)
    this.leanZ = damp(this.leanZ, tiltZ + sway, 5, dt)
    this.lean.rotation.set(this.leanX, this.leanY, this.leanZ + extraZ)

    this.applyRoot()

    if (this.shadow) {
      const k = 1 / (1 + (y + extraY) * 2.2)
      this.shadow.scale.set(this.built.width * 1.05 * k * (1 - s * 0.3), this.built.width * 0.6 * k, 1)
    }

    /* -------- arms -------- */
    this.armsUp = damp(this.armsUp, Math.max(this.armsUpTarget, gaspEnv * 0.6), 12, dt)
    let waveEnv = 0
    let waveOsc = 0
    if (this.waveT >= 0) {
      if (this.waveDelay > 0) this.waveDelay -= dt
      else {
        this.waveT += dt
        const q = this.waveT / this.waveDur
        if (q >= 1) this.waveT = -1
        else {
          waveEnv = envelope(q, 0.14, 0.18)
          waveOsc = Math.sin(q * 3 * TAU)
        }
      }
    }
    const idleWave = Math.sin(t * (2.4 + ex * 3) + this.phase) * (0.08 + ex * 0.12)
    const arms = this.built.arms
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!
      const side = arm.userData.side as number
      const rest = this.built.armRest + idleWave * side
      let a = rest + (2.55 - rest) * this.armsUp
      // the wave uses the character's right arm (the last one)
      if (waveEnv > 0 && i === arms.length - 1) a += (2.25 + 0.38 * waveOsc - a) * waveEnv
      arm.rotation.z = side * a
    }

    /* -------- face: blink, squint, widen, smile -------- */
    this.happyHold = Math.max(0, this.happyHold - dt)
    const wantHappy = this.hovered || this.happyHold > 0 ? 1 : 0
    this.happy = damp(this.happy, wantHappy * (1 - gaspEnv), 10, dt)
    this.smile = damp(this.smile, 0, 2.5, dt)

    let blink = 1
    if (this.blinkT < 0 && t > this.nextBlink) this.blinkT = 0
    if (this.blinkT >= 0) {
      this.blinkT += dt
      const D = 0.13
      if (this.blinkT >= D) {
        this.blinkT = -1
        if (this.doubleBlink) {
          this.doubleBlink = false
          this.nextBlink = t + 0.09
        } else {
          this.doubleBlink = Math.random() < 0.2
          this.nextBlink = t + 2 + Math.random() * 4.5
        }
      } else {
        blink = 1 - 0.9 * Math.sin((this.blinkT / D) * Math.PI)
      }
    }

    const widen = (1 + ex * 0.16) * (1 + 0.25 * gaspEnv)
    const squint = 1 - this.happy * 0.5
    for (const eye of face.eyes) {
      eye.lid.scale.set(widen * (1 + this.happy * 0.04), eye.baseScaleY * widen * squint * blink, widen)
    }
    const grin = Math.max(this.happy, this.smile)
    face.mouth.scale.set(
      (1 + grin * 0.45 + ex * 0.15) * (1 - gaspEnv * 0.35),
      (1 + grin * 0.7 + ex * 0.2) * (1 + gaspEnv * 0.6),
      1,
    )
  }

  /** Per-kind quirk at progress p (0..1). Writes parts; returns body offsets. */
  private readonly quirkOut = { z: 0, y: 0, sq: 0 }
  private quirk(p: number): { z: number; y: number; sq: number } {
    const o = this.quirkOut
    o.z = 0
    o.y = 0
    o.sq = 0
    const parts = this.built.parts
    const fade = 1 - p
    switch (this.kind) {
      case 'coffee': {
        // lid wobble, then a steam puff rises off the sip hole
        if (parts?.lid) {
          parts.lid.rotation.z = Math.sin(p * Math.PI * 5) * 0.13 * fade
          parts.lid.rotation.x = Math.sin(p * Math.PI * 5 + 1.1) * 0.06 * fade
        }
        if (parts?.puff) {
          const pp = clamp((p - 0.25) / 0.75, 0, 1)
          parts.puff.visible = pp > 0 && pp < 1
          parts.puff.position.y = this.puffBaseY + pp * 0.28
          parts.puff.scale.setScalar(0.4 + pp * 0.9)
          if (parts.puffMat) parts.puffMat.opacity = 0.85 * Math.sin(pp * Math.PI)
        }
        o.sq = 0.03 * Math.sin(p * Math.PI)
        break
      }
      case 'fries': {
        // shimmy: quick side-to-side wiggle, the sticks rattle
        const w = Math.sin(p * Math.PI * 7)
        o.z = w * 0.13 * Math.sin(p * Math.PI)
        if (parts?.sticks) parts.sticks.position.y = Math.abs(w) * 0.028 * fade
        break
      }
      case 'burger': {
        // bun lift: the crown tips up like a hat, then drops back
        if (parts?.bunTop) {
          const e = Math.sin(clamp(p / 0.8, 0, 1) * Math.PI)
          parts.bunTop.rotation.x = -0.3 * e + (p > 0.8 ? Math.sin(((p - 0.8) / 0.2) * Math.PI * 2) * 0.03 : 0)
        }
        o.sq = -0.03 * Math.sin(p * Math.PI)
        break
      }
      case 'shake': {
        if (parts?.straw) parts.straw.rotation.y = easeInOut(p) * TAU
        o.y = 0.02 * Math.sin(p * Math.PI)
        break
      }
      case 'croissant': {
        // roll: rock over onto one horn, then the other, and settle
        o.z = Math.sin(p * TAU) * 0.32 * (1 - p * 0.4)
        o.y = Math.abs(Math.sin(p * TAU)) * 0.03
        break
      }
      case 'sandwich': {
        // the fillings slide out to one side and snap back
        if (parts?.fill) {
          const e = p < 0.55 ? Math.sin((p / 0.55) * Math.PI * 0.5) : 1 - easeOutBack((p - 0.55) / 0.45)
          parts.fill.position.x = 0.09 * e
        }
        o.z = -0.04 * Math.sin(p * Math.PI)
        break
      }
    }
    return o
  }

  /** Reduced motion: one static, posed, camera-facing frame. */
  private renderStill(tiltX: number, turnY: number): void {
    const face = this.built.face
    this.introT = -1
    this.introScale = 1
    this.walkT = -1
    this.walkX = 0
    this.walkTurn = 0
    this.jumpT = -1
    this.gaspT = -1
    this.waveT = -1
    this.bit = null
    this.watch = null
    this.watchCamera = false
    this.resetParts()
    this.focusAmt = this.focused ? 1 : 0
    const pose = this.pose
    this.root.position.set(this.homeX, 0, this.homeZ + this.focusAmt * 0.6 + (pose === 'gasp' ? -0.2 : 0))
    this.root.rotation.y = this.homeRotY
    this.root.scale.setScalar(this.homeScale * (1 + 0.08 * this.focusAmt))
    this.lean.rotation.set(tiltX * 0.5, turnY * 0.5, 0)
    this.hop.position.y = 0
    this.hop.rotation.y = 0
    this.squash.scale.set(1, 1, 1)
    if (this.shadow) this.shadow.scale.set(this.built.width * 1.05, this.built.width * 0.6, 1)

    const up = pose === 'cheer' ? 1 : pose === 'gasp' ? 0.6 : 0.35
    this.armsUp = up
    const arms = this.built.arms
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!
      const side = arm.userData.side as number
      const rest = this.built.armRest
      let a = rest + (2.55 - rest) * up
      if ((pose === 'wave' || this.focused) && i === arms.length - 1) a = 2.3
      arm.rotation.z = side * a
    }
    const widen = pose === 'gasp' ? 1.25 : 1
    const squint = pose === 'gasp' ? 1 : 0.72
    for (const eye of face.eyes) eye.lid.scale.set(widen, eye.baseScaleY * widen * squint, widen)
    if (pose === 'gasp') face.mouth.scale.set(0.7, 1.6, 1)
    else face.mouth.scale.set(1.4, 1.65, 1)
  }
}
