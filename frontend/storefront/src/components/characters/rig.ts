/**
 * Animation rig for one character: idle breathing/bob/sway, blinks, eye
 * tracking, lean-toward-cursor, hops with squash & stretch, spins, arms-up.
 *
 * Hierarchy:  root (layout) → hop (jump height, spin) → squash (scale)
 *             → lean (tilt / turn) → model
 */
import * as THREE from 'three'
import type { CharacterKind } from './types'
import type { BuiltCharacter } from './characters'

export interface FrameContext {
  t: number
  dt: number
  /** World-space point the crowd is looking at. */
  target: THREE.Vector3
  excitement: number
  reduced: boolean
}

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

const _v = new THREE.Vector3()

export class Character {
  readonly root = new THREE.Group()
  readonly hop = new THREE.Group()
  readonly squash = new THREE.Group()
  readonly lean = new THREE.Group()
  readonly hit: THREE.Mesh
  readonly shadow: THREE.Mesh | null

  private phase = Math.random() * TAU
  private swayRate = 1.1 + Math.random() * 0.5

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

  private nextBlink = 1 + Math.random() * 4
  private blinkT = -1
  private doubleBlink = false

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
  }

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

  update(ctx: FrameContext): void {
    const { t, dt, target, excitement: ex, reduced } = ctx
    const face = this.built.face

    /* -------- eyes: always track (snap when reduced) -------- */
    const eyeLambda = reduced ? 1e6 : 14 + ex * 8
    for (const eye of face.eyes) {
      _v.copy(target)
      eye.anchor.worldToLocal(_v)
      const len = _v.length() || 1
      const yaw = clamp(Math.atan2(_v.x, _v.z), -0.62, 0.62)
      const pitch = clamp(-Math.asin(clamp(_v.y / len, -1, 1)), -0.5, 0.45)
      eye.ball.rotation.y = damp(eye.ball.rotation.y, yaw, eyeLambda, dt)
      eye.ball.rotation.x = damp(eye.ball.rotation.x, pitch, eyeLambda, dt)
    }

    // body turn / lean toward the target (in root space)
    _v.copy(target)
    this.root.worldToLocal(_v)
    const toward = Math.atan2(_v.x, Math.max(0.5, _v.z))
    const reach = 0.28 + ex * 0.35
    const turnY = clamp(toward * reach, -0.45, 0.45)
    const tiltZ = clamp(-toward * (0.05 + ex * 0.12), -0.2, 0.2)
    const tiltX = clamp(Math.atan2(_v.y - this.built.height * 0.6, Math.max(0.5, _v.z)) * -0.08 * (1 + ex), -0.12, 0.12)

    if (reduced) {
      this.lean.rotation.set(tiltX * 0.5, turnY * 0.5, 0)
      this.hop.position.y = 0
      this.hop.rotation.y = 0
      this.squash.scale.set(1, 1, 1)
      for (const eye of face.eyes) eye.lid.scale.set(1, eye.baseScaleY, 1)
      face.mouth.scale.setScalar(1)
      return
    }

    /* -------- idle life -------- */
    const bobRate = 2.1 * (1 + ex * 1.1)
    const breathe = Math.sin(t * bobRate + this.phase)
    let sq = 0.016 * breathe * (1 + ex)
    let y = Math.max(0, Math.sin(t * bobRate * 0.5 + this.phase)) * 0.012 * (1 + ex * 2.5)
    const sway = Math.sin(t * this.swayRate + this.phase * 1.7) * 0.03

    // excited characters bounce on the spot now and then
    if (ex > 0.3 && this.jumpT < 0 && Math.random() < dt * (ex - 0.2) * 1.4) {
      this.jump({ height: 0.1 + 0.14 * ex, duration: 0.42 })
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

    // landing jiggle spring
    this.springV += (-190 * this.spring - 10 * this.springV) * dt
    this.spring += this.springV * dt
    sq += this.spring

    this.hop.position.y = y
    this.hop.rotation.y = spin
    const s = clamp(sq, -0.35, 0.3)
    this.squash.scale.set(1 - s * 0.55, 1 + s, 1 - s * 0.55)

    this.lean.rotation.x = damp(this.lean.rotation.x, tiltX, 5, dt)
    this.lean.rotation.y = damp(this.lean.rotation.y, turnY, 4 + ex * 4, dt)
    this.lean.rotation.z = damp(this.lean.rotation.z, tiltZ + sway, 5, dt)

    if (this.shadow) {
      const k = 1 / (1 + y * 2.2)
      this.shadow.scale.set(this.built.width * 1.05 * k * (1 - s * 0.3), this.built.width * 0.6 * k, 1)
    }

    /* -------- arms -------- */
    this.armsUp = damp(this.armsUp, this.armsUpTarget, 12, dt)
    const wave = Math.sin(t * (2.4 + ex * 3) + this.phase) * (0.08 + ex * 0.12)
    for (const arm of this.built.arms) {
      const side = arm.userData.side as number
      const rest = this.built.armRest + wave * side
      arm.rotation.z = side * (rest + (2.55 - rest) * this.armsUp)
    }

    /* -------- face: blink, squint, widen -------- */
    this.happyHold = Math.max(0, this.happyHold - dt)
    const wantHappy = this.hovered || this.happyHold > 0 ? 1 : 0
    this.happy = damp(this.happy, wantHappy, 10, dt)

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

    const widen = 1 + ex * 0.16
    const squint = 1 - this.happy * 0.5
    for (const eye of face.eyes) {
      eye.lid.scale.set(widen * (1 + this.happy * 0.04), eye.baseScaleY * widen * squint * blink, widen)
    }
    face.mouth.scale.set(1 + this.happy * 0.35 + ex * 0.15, 1 + this.happy * 0.6 + ex * 0.2, 1)
  }
}
