/**
 * Animation rig for one character: idle breathing/bob/sway, blinks, eye
 * tracking, lean-toward-cursor, hops with squash & stretch, spins, arms-up,
 * plus the toy layer: grab, ballistic throw, bounce, land, walk home.
 *
 * Hierarchy:  root (layout / thrown position) → hop (jump height, spin,
 *             tumble) → squash (scale) → lean (tilt / turn) → model
 *
 * Every per-frame path works on fields and module scratch vectors only, so
 * the render loop allocates nothing.
 */
import * as THREE from 'three'
import type { CharacterKind } from './types'
import type { BuiltCharacter } from './characters'

export interface FrameContext {
  /** Simulation time (s), capped steps. */
  t: number
  /** Simulation step (s), capped at 1/20. */
  dt: number
  /** Wall clock (ms, performance.now()) — entrance and static swaps run on it. */
  wall: number
  /** World-space point this character looks at. */
  target: THREE.Vector3
  excitement: number
  reduced: boolean
}

export interface JumpOptions {
  height: number
  duration: number
  spin?: boolean
  armsUp?: boolean
  delay?: number
  /** Deep anticipation squash to 1.2 / 0.8 before take-off. */
  squash?: boolean
  /** Restart even if a hop is already in the air. */
  force?: boolean
}

const TAU = Math.PI * 2
/** World units / s². */
export const GRAVITY = 18
const RESTITUTION = 0.45
const MAX_BOUNCES = 2
const INTRO_MS = 420
const LAND_S = 0.3
const RETURN_S = 0.6
const FLINCH_S = 0.18

/** Toy state machine (plain object, not an enum: isolatedModules + SWC). */
const Mode = { Slot: 0, Held: 1, Flight: 2, Land: 3, Return: 4 } as const
type Mode = (typeof Mode)[keyof typeof Mode]

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
/** Wrap an angle into (-π, π]. */
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU)

const _v = new THREE.Vector3()

export class Character {
  readonly root = new THREE.Group()
  readonly hop = new THREE.Group()
  readonly squash = new THREE.Group()
  readonly lean = new THREE.Group()
  readonly hit: THREE.Mesh
  readonly shadow: THREE.Mesh | null

  /** Home position chosen by layout; thrown characters walk back to it. */
  readonly slot = new THREE.Vector3()
  /** |x| limit (world) a thrown character bounces off. Set by layout. */
  boundX = 4

  private phase = Math.random() * TAU
  private swayRate = 1.1 + Math.random() * 0.5

  // jump state
  private jumpDelay = 0
  private jumpT = -1
  private jumpDur = 0.6
  private jumpH = 0
  private jumpSquash = false
  private spinDir = 0
  private armsUpTarget = 0
  private armsUp = 0

  // squash spring
  private spring = 0
  private springV = 0

  private happy = 0
  hovered = false
  private happyHold = 0
  /** Seconds left of "eyes wide" (party). */
  wideHold = 0
  private wide = 0

  private nextBlink = 1 + Math.random() * 4
  private blinkT = -1
  private doubleBlink = false

  // entrance: grow up out of the floor with an overshoot, then a landing
  // jiggle. Runs on the wall clock so a slow first second can't stall it.
  private introAt = -1
  private introDelayMs = 0

  // toy state
  private mode: Mode = Mode.Slot
  private modeT = 0
  private readonly vel = new THREE.Vector3()
  private readonly holdAt = new THREE.Vector3()
  private readonly from = new THREE.Vector3()
  private grabY = 0
  private px = 0
  private py = 0
  private svx = 0
  private svy = 0
  private tilt = 0
  private stretch = 0
  private yaw = 0
  private yawRate = 0
  private yawFrom = 0
  private bounces = 0
  private flinchT = -1
  private leanX = 0
  private staticHappyUntil = 0

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

  /* ================================================================ */
  /* commands                                                          */
  /* ================================================================ */

  /** Layout home. A character mid-throw keeps flying and walks to the new slot. */
  setSlot(x: number, z: number, rotY: number): void {
    this.slot.set(x, 0, z)
    this.root.rotation.y = rotY
    if (this.mode === Mode.Slot) this.root.position.copy(this.slot)
  }

  /** Queue a hop. */
  jump(opts: JumpOptions): void {
    if (this.mode !== Mode.Slot) {
      this.happyHold = Math.max(this.happyHold, 0.4)
      return
    }
    if (!opts.force && this.jumpT >= 0 && this.jumpT / this.jumpDur < 0.8) {
      // already airborne: upgrade the flourish and give it a wobble
      if (opts.armsUp) this.armsUpTarget = 1
      if (opts.spin && !this.spinDir && this.jumpDelay <= 0) this.spinDir = Math.random() < 0.5 ? -1 : 1
      this.springV += 1.4
      this.happyHold = Math.max(this.happyHold, 0.5)
      return
    }
    this.jumpDelay = opts.delay ?? 0
    this.jumpT = 0
    this.jumpDur = opts.duration
    this.jumpH = opts.height
    this.jumpSquash = !!opts.squash
    this.spinDir = opts.spin ? (Math.random() < 0.5 ? -1 : 1) : 0
    if (opts.armsUp) this.armsUpTarget = 1
    this.happyHold = Math.max(this.happyHold, opts.duration + (opts.delay ?? 0) + 0.25)
  }

  get airborne(): boolean {
    return this.jumpT >= 0 || this.mode !== Mode.Slot
  }

  /** True while grabbed, flying, landing or walking home. */
  get toyBusy(): boolean {
    return this.mode !== Mode.Slot
  }

  get held(): boolean {
    return this.mode === Mode.Held
  }

  /** In the air after a throw/launch (the rest of the crowd watches it). */
  get flying(): boolean {
    return this.mode === Mode.Held || this.mode === Mode.Flight
  }

  /** Start hidden and pop up out of the floor `delay` seconds after `wallMs`. */
  enter(delay: number, wallMs: number): void {
    this.introAt = wallMs
    this.introDelayMs = delay * 1000
    this.root.scale.setScalar(0.0001)
  }

  /** Scroll flick down: squash, lean back, blink. */
  flinch(): void {
    if (this.mode !== Mode.Slot || this.jumpT >= 0) return
    this.flinchT = 0
    this.blinkT = 0
  }

  /** Reduced motion: eyes-closed happy face until `untilMs` (wall clock). */
  staticHappy(untilMs: number): void {
    this.staticHappyUntil = Math.max(this.staticHappyUntil, untilMs)
  }

  /**
   * Picked up by the pointer. `grabY` = height of the grip above the feet;
   * returns the (clamped) grip height actually used.
   */
  grab(grabY: number): number {
    this.mode = Mode.Held
    this.modeT = 0
    this.jumpT = -1
    this.jumpDelay = 0
    this.flinchT = -1
    this.introAt = -1
    this.root.scale.setScalar(1)
    this.grabY = clamp(grabY, this.built.height * 0.15, this.built.height * 0.9)
    this.holdAt.copy(this.root.position)
    this.px = this.root.position.x
    this.py = this.root.position.y
    this.svx = 0
    this.svy = 0
    this.yawRate = 0
    this.armsUpTarget = 1
    return this.grabY
  }

  /** Where the grabbed character's feet should be (world, its own z plane). */
  hold(x: number, y: number): void {
    this.holdAt.set(clamp(x, -this.boundX - 1, this.boundX + 1), Math.max(0, y), this.root.position.z)
  }

  /** Let go with a world velocity (u/s); spin follows horizontal speed. */
  release(vx: number, vy: number): void {
    this.mode = Mode.Flight
    this.modeT = 0
    this.vel.set(vx, vy, 0)
    this.yawRate = clamp(vx * 1.6, -14, 14)
    this.bounces = 0
    this.armsUpTarget = 1
  }

  /** Touch / keyboard double-press: a big vertical toss with a spin, 1.1s airtime. */
  launch(): void {
    if (this.mode === Mode.Held) return
    this.mode = Mode.Flight
    this.modeT = 0
    this.jumpT = -1
    this.jumpDelay = 0
    this.flinchT = -1
    this.introAt = -1
    this.root.scale.setScalar(1)
    this.grabY = this.built.height * 0.5
    this.root.position.y = Math.max(0, this.root.position.y)
    this.vel.set(0, (GRAVITY * 1.1) / 2, 0)
    this.yawRate = ((Math.random() < 0.5 ? -1 : 1) * TAU * 2) / 1.1
    this.bounces = 0
    this.armsUpTarget = 1
    this.springV -= 2.4 // take-off crouch
  }

  /** Snap home (reduced motion switched on mid-throw, or layout reset). */
  settle(): void {
    this.mode = Mode.Slot
    this.modeT = 0
    this.vel.set(0, 0, 0)
    this.root.position.copy(this.slot)
    this.yaw = 0
    this.yawRate = 0
    this.tilt = 0
    this.stretch = 0
    this.armsUpTarget = 0
  }

  /* ================================================================ */
  /* frame                                                             */
  /* ================================================================ */

  update(ctx: FrameContext): void {
    const { t, dt, wall, target, excitement: ex, reduced } = ctx
    const face = this.built.face
    const h = this.built.height

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
    const tiltX = clamp(Math.atan2(_v.y - h * 0.6, Math.max(0.5, _v.z)) * -0.08 * (1 + ex), -0.12, 0.12)

    if (reduced) {
      // Hand-authored still pose: home, upright, no idle, no jiggle.
      if (this.mode !== Mode.Slot) this.settle()
      this.introAt = -1
      this.jumpT = -1
      this.flinchT = -1
      this.root.scale.setScalar(1)
      this.leanX = tiltX * 0.5
      this.lean.rotation.set(this.leanX, turnY * 0.5, 0)
      this.hop.position.set(0, 0, 0)
      this.hop.rotation.set(0, 0, 0)
      this.squash.scale.set(1, 1, 1)
      this.armsUp = 0
      this.armsUpTarget = 0
      for (const arm of this.built.arms) arm.rotation.z = (arm.userData.side as number) * this.built.armRest
      const happyNow = wall < this.staticHappyUntil
      for (const eye of face.eyes) eye.lid.scale.set(1, eye.baseScaleY * (happyNow ? 0.1 : 1), 1)
      if (happyNow) face.mouth.scale.set(1.35, 1.7, 1)
      else face.mouth.scale.setScalar(1)
      if (this.shadow) this.shadow.scale.set(this.built.width * 1.05, this.built.width * 0.6, 1)
      return
    }

    /* -------- entrance (wall clock) -------- */
    if (this.introAt >= 0) {
      const p = (wall - this.introAt - this.introDelayMs) / INTRO_MS
      if (p <= 0) {
        this.root.scale.setScalar(0.0001)
      } else if (p < 1) {
        this.root.scale.setScalar(Math.max(0.0001, easeOutBack(p)))
      } else {
        this.introAt = -1
        this.root.scale.setScalar(1)
        this.springV -= 2.6 // landing jiggle
        this.happyHold = Math.max(this.happyHold, 0.6)
      }
    }

    /* -------- idle life -------- */
    const home = this.mode === Mode.Slot
    const bobRate = 2.1 * (1 + ex * 1.1)
    const breathe = Math.sin(t * bobRate + this.phase)
    let sq = home ? 0.016 * breathe * (1 + ex) : 0
    let y = home ? Math.max(0, Math.sin(t * bobRate * 0.5 + this.phase)) * 0.012 * (1 + ex * 2.5) : 0
    const sway = home ? Math.sin(t * this.swayRate + this.phase * 1.7) * 0.03 : 0
    let ovY = 1
    let ovXZ = 1
    let spin = 0
    let leanBack = 0

    if (home) {
      // excited characters bounce on the spot now and then
      if (ex > 0.3 && this.jumpT < 0 && Math.random() < dt * (ex - 0.2) * 1.4) {
        this.jump({ height: 0.1 + 0.14 * ex, duration: 0.42 })
      }

      /* -------- jump -------- */
      if (this.jumpT >= 0) {
        if (this.jumpDelay > 0) {
          this.jumpDelay -= dt
        } else {
          this.jumpT += dt
          const p = this.jumpT / this.jumpDur
          const A = this.jumpSquash ? 0.24 : 0.2
          const strength = clamp(this.jumpH / 0.5, 0.35, 1)
          if (p < A) {
            const k = Math.sin((p / A) * Math.PI * 0.5)
            if (this.jumpSquash) {
              ovY = 1 - 0.2 * k
              ovXZ = 1 + 0.2 * k
            } else sq += -0.24 * strength * k
          } else if (p < 1) {
            const q = (p - A) / (1 - A)
            y += this.jumpH * 4 * q * (1 - q)
            const takeoff = 1 - Math.min(1, q / 0.12)
            const stretch = 0.16 * strength * Math.abs(1 - 2 * q)
            if (this.jumpSquash && takeoff > 0) {
              ovY = lerp(1, 0.8, takeoff)
              ovXZ = lerp(1, 1.2, takeoff)
              sq += stretch * (1 - takeoff)
            } else sq += -0.24 * strength * takeoff + stretch * (1 - takeoff)
            if (this.spinDir) spin = this.spinDir * TAU * easeInOut(q)
          } else {
            this.jumpT = -1
            this.jumpSquash = false
            this.springV -= 3.2 + this.jumpH * 5
            this.armsUpTarget = 0
          }
        }
      }

      /* -------- scroll-flick flinch -------- */
      if (this.flinchT >= 0) {
        this.flinchT += dt
        const p = this.flinchT / FLINCH_S
        if (p >= 1) {
          this.flinchT = -1
          this.springV += 0.8
        } else {
          const env = Math.sin(p * Math.PI)
          ovY = 1 - 0.12 * env
          ovXZ = 1 + 0.07 * env
          leanBack = -0.2 * env
        }
      }
      this.tilt = damp(this.tilt, 0, 14, dt)
      this.stretch = damp(this.stretch, 0, 14, dt)
    } else {
      /* -------- toy physics -------- */
      this.modeT += dt
      const pos = this.root.position
      if (this.mode === Mode.Held) {
        const k = 1 - Math.exp(-35 * dt)
        pos.x += (this.holdAt.x - pos.x) * k
        pos.y += (this.holdAt.y - pos.y) * k
        if (dt > 0) {
          this.svx = damp(this.svx, (pos.x - this.px) / dt, 14, dt)
          this.svy = damp(this.svy, (pos.y - this.py) / dt, 14, dt)
        }
        this.aim(this.svx, this.svy, 1.2, dt)
      } else if (this.mode === Mode.Flight) {
        const v = this.vel
        v.y -= GRAVITY * dt
        pos.x += v.x * dt
        pos.y += v.y * dt
        if (pos.x < -this.boundX && v.x < 0) {
          pos.x = -this.boundX
          v.x = -v.x * 0.5
          this.yawRate *= -0.6
          this.springV += 1.5
        } else if (pos.x > this.boundX && v.x > 0) {
          pos.x = this.boundX
          v.x = -v.x * 0.5
          this.yawRate *= -0.6
          this.springV += 1.5
        }
        if (pos.y <= 0 && v.y <= 0) {
          pos.y = 0
          const impact = -v.y
          if (this.bounces < MAX_BOUNCES && impact > 1.2) {
            this.bounces++
            v.y = impact * RESTITUTION
            v.x *= 0.65
            this.yawRate *= 0.55
            this.springV -= Math.min(3.5, impact * 0.3)
          } else {
            v.set(0, 0, 0)
            this.mode = Mode.Land
            this.modeT = 0
            this.armsUpTarget = 0
            this.happyHold = Math.max(this.happyHold, 0.9)
          }
        } else if (this.modeT > 5) {
          // never strand a character off-stage
          pos.y = 0
          this.mode = Mode.Land
          this.modeT = 0
        }
        this.yaw += this.yawRate * dt
        this.aim(v.x, v.y, 0.7, dt)
      } else if (this.mode === Mode.Land) {
        const p = Math.min(1, this.modeT / LAND_S)
        ovY = p < 0.35 ? lerp(0.7, 1.1, easeOut(p / 0.35)) : lerp(1.1, 1, easeInOut((p - 0.35) / 0.65))
        ovXZ = 1 / Math.sqrt(ovY)
        this.yawRate = damp(this.yawRate, 0, 10, dt)
        this.yaw += this.yawRate * dt
        this.tilt = damp(this.tilt, 0, 16, dt)
        this.stretch = 0
        if (p >= 1) {
          this.mode = Mode.Return
          this.modeT = 0
          this.from.copy(pos)
          this.yawFrom = wrapAngle(this.yaw)
        }
      } else {
        // Return: walk / spring back to the slot
        const p = Math.min(1, this.modeT / RETURN_S)
        const e = easeInOut(p)
        pos.lerpVectors(this.from, this.slot, e)
        const dist = Math.abs(this.from.x - this.slot.x) + Math.abs(this.from.y - this.slot.y)
        if (dist > 0.15) y = Math.abs(Math.sin(p * Math.PI * 3)) * 0.07 * (1 - p)
        this.yaw = this.yawFrom * (1 - e)
        this.tilt = damp(this.tilt, 0, 16, dt)
        if (p >= 1) {
          this.mode = Mode.Slot
          this.modeT = 0
          pos.copy(this.slot)
          this.yaw = 0
          this.springV -= 1.2
        }
      }
      this.px = pos.x
      this.py = pos.y
      if (this.mode === Mode.Held || this.mode === Mode.Flight) {
        ovY = 1 + 0.25 * this.stretch
        ovXZ = 1 - 0.15 * this.stretch
      }
      spin = this.yaw
    }

    // landing jiggle spring
    this.springV += (-190 * this.spring - 10 * this.springV) * dt
    this.spring += this.springV * dt
    sq += this.spring

    const s = clamp(sq, -0.35, 0.3)
    const sy = (1 + s) * ovY
    const sxz = (1 - s * 0.55) * ovXZ
    this.squash.scale.set(sxz, sy, sxz)

    // hop: jump height + spin + tumble. The tumble pivots on the grip point
    // (not the feet), so a held character dangles from the cursor.
    const g = this.grabY
    const th = this.tilt
    this.hop.rotation.set(0, spin, th)
    if (th !== 0) {
      const sinT = Math.sin(th)
      const cosY = Math.cos(spin)
      const sinY = Math.sin(spin)
      this.hop.position.set(g * sy * sinT * cosY, y + g - g * sy * Math.cos(th), -g * sy * sinT * sinY)
    } else {
      this.hop.position.set(0, y, 0)
    }

    this.leanX = damp(this.leanX, tiltX, 5, dt)
    this.lean.rotation.x = this.leanX + leanBack
    this.lean.rotation.y = damp(this.lean.rotation.y, turnY, 4 + ex * 4, dt)
    this.lean.rotation.z = damp(this.lean.rotation.z, tiltZ + sway, 5, dt)

    if (this.shadow) {
      const lift = this.root.position.y + y
      const k = 1 / (1 + lift * 2.2)
      this.shadow.position.y = 0.003 - this.root.position.y
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
    this.wideHold = Math.max(0, this.wideHold - dt)
    const wantWide = this.mode === Mode.Held || this.mode === Mode.Flight || this.wideHold > 0 ? 1 : 0
    this.wide = damp(this.wide, wantWide, 14, dt)
    const wantHappy = !wantWide && (this.hovered || this.happyHold > 0) ? 1 : 0
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

    const widen = 1 + ex * 0.16 + this.wide * 0.26
    const squint = 1 - this.happy * 0.5
    for (const eye of face.eyes) {
      eye.lid.scale.set(widen * (1 + this.happy * 0.04), eye.baseScaleY * widen * squint * blink, widen)
    }
    // held / flying: a little round "oh" mouth
    face.mouth.scale.set(
      (1 + this.happy * 0.35 + ex * 0.15) * (1 - this.wide * 0.3),
      (1 + this.happy * 0.6 + ex * 0.2) * (1 + this.wide * 0.7),
      1,
    )
  }

  /** Stretch + tumble along a velocity (u/s). `maxTilt` in radians. */
  private aim(vx: number, vy: number, maxTilt: number, dt: number): void {
    const speed = Math.hypot(vx, vy)
    const s = clamp(speed / 9, 0, 1)
    // long axis parallel to the velocity, never upside down
    const ang = speed < 1e-3 ? 0 : vy >= 0 ? Math.atan2(-vx, vy) : Math.atan2(vx, -vy)
    this.tilt = damp(this.tilt, clamp(ang * s, -maxTilt, maxTilt), 12, dt)
    this.stretch = damp(this.stretch, s, 12, dt)
  }
}
