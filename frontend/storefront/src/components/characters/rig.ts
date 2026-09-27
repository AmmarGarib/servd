/**
 * Animation rig for one character: idle breathing/bob/sway, blinks, eye
 * tracking, lean-toward-cursor, hops with squash & stretch, spins, arms-up,
 * plus the personality layer: a per-kind cheer flourish, perk, wink, hover
 * spring and a reduced-motion emissive pulse.
 *
 * Hierarchy:  root (layout, steam puffs) → hop (jump height, spin, shimmy)
 *             → squash (scale) → lean (tilt / turn) → model
 *
 * Nothing in `update()` allocates: every scratch value is a field or a
 * module-level temp.
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

/** Extra per-character effects the engine supplies (shared textures/materials). */
export interface CharacterFx {
  /** Builds one hidden steam-puff sprite; its material must be registered for disposal by the caller. */
  makePuff?: () => THREE.Sprite
}

interface Rest {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/** Cheer flourish length per kind (seconds, each ≤ 0.9). */
const FLOURISH_DUR: Record<CharacterKind, number> = {
  burger: 0.8,
  sandwich: 0.72,
  shake: 0.8,
  coffee: 0.7,
  fries: 0.72,
  croissant: 0.52,
}

const PUFFS = 4
const PUFF_X = [-0.07, 0.07, -0.015, 0.11]
const PUFF_DRIFT = [-0.05, 0.06, 0.02, -0.03]
const PUFF_LIFE = 0.46
const PUFF_GAP = 0.08
const PULSE_DUR = 0.28
const PULSE_COLOR = 0xffe2a0
const WINK_DUR = 0.46
/** applyFlourish() results: which whole-body channel the pose wrote to. */
const FLOURISH_SHIMMY = 1
const FLOURISH_JITTER = 2

const _v = new THREE.Vector3()

interface PulseMat {
  mat: THREE.MeshStandardMaterial
  hex: number
  intensity: number
}

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

  // entrance: grow up out of the floor with an overshoot, then a landing
  // jiggle. -1 = not running (fully in).
  private introDelay = 0
  private introT = -1

  // personality
  private flT = -1
  private flDelay = 0
  private flK = 1
  private perkHold = 0
  private perkLevel = 0
  private glanceHold = 0
  private glance = 0
  private winkT = -1
  private winkDelay = 0
  private hoverS = 1
  private hoverV = 0
  private pulseT = -1

  private readonly lidRest: Rest | null
  private readonly strawRest: Rest | null
  private readonly cherryRest: Rest | null
  private readonly puffs: THREE.Sprite[] = []
  private readonly pulseMats: PulseMat[] = []

  constructor(
    readonly kind: CharacterKind,
    readonly built: BuiltCharacter,
    hitGeo: THREE.BufferGeometry,
    hitMat: THREE.Material,
    shadowGeo: THREE.BufferGeometry | null,
    shadowMat: THREE.Material | null,
    fx: CharacterFx | null = null,
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

    const rest = (o: THREE.Object3D | undefined): Rest | null => (o ? ((o.userData.rest as Rest | undefined) ?? null) : null)
    this.lidRest = rest(built.parts.lid)
    this.strawRest = rest(built.parts.straw)
    this.cherryRest = rest(built.parts.cherry)

    // Steam puffs (coffee): a small pool made once, hidden until a flourish.
    if (built.parts.steam && fx?.makePuff) {
      for (let i = 0; i < PUFFS; i++) {
        const s = fx.makePuff()
        s.visible = false
        s.renderOrder = 2
        this.puffs.push(s)
        this.root.add(s)
      }
    }

    // Body materials for the reduced-motion pulse. The face kit is shared by
    // every character, so it is left out (otherwise every face would glow).
    const skip = new Set<THREE.Object3D>()
    built.face.group.traverse((o) => skip.add(o))
    const seen = new Set<THREE.Material>()
    built.model.traverse((o) => {
      if (skip.has(o)) return
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of list) {
        if (!m || seen.has(m)) continue
        seen.add(m)
        const sm = m as THREE.MeshStandardMaterial
        if (sm.isMeshStandardMaterial) this.pulseMats.push({ mat: sm, hex: sm.emissive.getHex(), intensity: sm.emissiveIntensity })
      }
    })
  }

  /** Queue a hop. `spin` = click jump with a spin (fries shimmy instead). */
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
    let spin = !!opts.spin
    if (spin && this.kind === 'fries') {
      spin = false
      this.flourish(1, opts.delay ?? 0)
    }
    this.spinDir = spin ? (Math.random() < 0.5 ? -1 : 1) : 0
    if (opts.armsUp) this.armsUpTarget = 1
    this.happyHold = Math.max(this.happyHold, opts.duration + (opts.delay ?? 0) + 0.25)
  }

  get airborne(): boolean {
    return this.jumpT >= 0
  }

  /** True while a reduced-motion pulse is still fading (the engine keeps rendering). */
  get pulsing(): boolean {
    return this.pulseT >= 0
  }

  /** Start hidden and pop up out of the floor after `delay` seconds. */
  enter(delay: number): void {
    this.introDelay = delay
    this.introT = 0
    this.root.scale.setScalar(0.0001)
  }

  /** The full cheer: a happy jump, arms up, and this kind's own flourish. */
  cheer(delay = 0): void {
    this.jump({ height: 0.48, duration: 0.7, armsUp: true, delay })
    this.flourish(1, delay)
  }

  /** This kind's signature move. `k` scales it (0.5 = idle beat). */
  flourish(k = 1, delay = 0): void {
    if (this.flT >= 0 && this.flT < FLOURISH_DUR[this.kind] * 0.7) {
      this.flK = Math.max(this.flK, k)
      return
    }
    this.flT = 0
    this.flDelay = delay
    this.flK = clamp(k, 0, 1)
    this.happyHold = Math.max(this.happyHold, FLOURISH_DUR[this.kind] * k + delay)
  }

  /** Lean in, eyes wide, one small hop; stay keen for `seconds`, then ease back. */
  perk(seconds: number, delay = 0): void {
    this.perkHold = Math.max(this.perkHold, seconds + delay)
    if (!this.airborne) this.jump({ height: 0.15, duration: 0.42, delay })
  }

  /** Hop, turn toward the viewer and wink. */
  hint(): void {
    this.jump({ height: 0.22, duration: 0.5 })
    this.glanceHold = Math.max(this.glanceHold, 1.4)
    this.winkT = 0
    this.winkDelay = 0.12
    this.happyHold = Math.max(this.happyHold, 0.9)
  }

  /** Reduced motion: a 280ms warm glow, no transform. */
  pulse(): void {
    if (this.pulseMats.length) this.pulseT = 0
  }

  private endPulse(): void {
    this.pulseT = -1
    for (const p of this.pulseMats) {
      p.mat.emissive.setHex(p.hex)
      p.mat.emissiveIntensity = p.intensity
    }
  }

  private restParts(): void {
    const { lid, straw, cherry } = this.built.parts
    if (lid && this.lidRest) {
      lid.position.set(this.lidRest.x, this.lidRest.y, this.lidRest.z)
      lid.rotation.set(this.lidRest.rx, this.lidRest.ry, this.lidRest.rz)
      lid.scale.set(1, 1, 1)
    }
    if (straw && this.strawRest) straw.rotation.set(this.strawRest.rx, this.strawRest.ry, this.strawRest.rz)
    if (cherry && this.cherryRest) {
      cherry.position.set(this.cherryRest.x, this.cherryRest.y, this.cherryRest.z)
      cherry.scale.set(1, 1, 1)
    }
    for (const s of this.puffs) s.visible = false
  }

  /** Release pooled materials/effects references. Geometry and materials are owned by the Kit. */
  dispose(): void {
    if (this.pulseT >= 0) this.endPulse()
    for (const s of this.puffs) {
      s.removeFromParent()
      s.material.dispose()
    }
    this.puffs.length = 0
  }

  update(ctx: FrameContext): void {
    const { t, dt, target, excitement: exGlobal, reduced } = ctx
    const face = this.built.face

    /* -------- perk / glance levels -------- */
    this.perkHold = Math.max(0, this.perkHold - dt)
    this.perkLevel = damp(this.perkLevel, this.perkHold > 0 ? 1 : 0, this.perkHold > 0 ? 9 : 2.4, dt)
    this.glanceHold = Math.max(0, this.glanceHold - dt)
    this.glance = damp(this.glance, this.hovered || this.glanceHold > 0 ? 1 : 0, 8, dt)
    const ex = Math.max(exGlobal, reduced ? 0 : this.perkLevel)

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
    const reach = 0.28 + ex * 0.35 + this.glance * 0.35
    const turnLim = 0.45 + this.glance * 0.2
    const turnY = clamp(toward * reach, -turnLim, turnLim)
    const tiltZ = clamp(-toward * (0.05 + ex * 0.12), -0.2, 0.2)
    const tiltX = clamp(Math.atan2(_v.y - this.built.height * 0.6, Math.max(0.5, _v.z)) * -0.08 * (1 + ex), -0.12, 0.12)

    if (reduced) {
      this.introT = -1
      this.jumpT = -1
      this.flT = -1
      this.winkT = -1
      this.armsUpTarget = 0
      this.root.scale.setScalar(1)
      this.lean.rotation.set(tiltX * 0.5, turnY * 0.5, 0)
      this.hop.position.y = 0
      this.hop.rotation.set(0, 0, 0)
      this.squash.scale.set(1, 1, 1)
      this.restParts()
      for (const eye of face.eyes) eye.lid.scale.set(1, eye.baseScaleY, 1)
      face.mouth.scale.setScalar(1)
      // The one reduced-motion celebration: a warm glow, no movement.
      if (this.pulseT >= 0) {
        this.pulseT += dt
        const p = this.pulseT / PULSE_DUR
        if (p >= 1) this.endPulse()
        else {
          const glow = Math.sin(Math.PI * p) * 0.45
          for (const m of this.pulseMats) {
            m.mat.emissive.setHex(PULSE_COLOR)
            m.mat.emissiveIntensity = glow
          }
        }
      }
      return
    }
    if (this.pulseT >= 0) this.endPulse()

    /* -------- entrance -------- */
    if (this.introT >= 0) {
      if (this.introDelay > 0) {
        this.introDelay -= dt
      } else {
        this.introT += dt
        const p = Math.min(1, this.introT / 0.72)
        this.root.scale.setScalar(Math.max(0.0001, easeOutBack(p)))
        if (p >= 1) {
          this.introT = -1
          this.root.scale.setScalar(1)
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

    // excited crowds bounce on the spot now and then (page-level excitement only;
    // a perk already did its one hop)
    if (exGlobal > 0.3 && this.jumpT < 0 && Math.random() < dt * (exGlobal - 0.2) * 1.4) {
      this.jump({ height: 0.1 + 0.14 * exGlobal, duration: 0.42 })
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

    /* -------- per-kind flourish -------- */
    let shimmy = 0
    let jitter = 0
    this.restParts()
    if (this.flT >= 0) {
      if (this.flDelay > 0) this.flDelay -= dt
      else {
        this.flT += dt
        const dur = FLOURISH_DUR[this.kind]
        const p = this.flT / dur
        if (p >= 1) this.flT = -1
        else {
          const r = this.applyFlourish(p, this.flK)
          shimmy = r === FLOURISH_SHIMMY ? this.shimmyOut : 0
          jitter = r === FLOURISH_JITTER ? this.jitterOut : 0
        }
      }
    }

    // landing jiggle spring
    this.springV += (-190 * this.spring - 10 * this.springV) * dt
    this.spring += this.springV * dt
    sq += this.spring

    // hover: a springy 1.04 scale-up (underdamped, so it overshoots a touch)
    this.hoverV += (300 * ((this.hovered ? 1.04 : 1) - this.hoverS) - 16 * this.hoverV) * dt
    this.hoverS += this.hoverV * dt
    const hs = this.hoverS

    this.hop.position.y = y
    this.hop.rotation.y = spin
    this.hop.rotation.z = shimmy
    const s = clamp(sq, -0.35, 0.3)
    this.squash.scale.set((1 - s * 0.55) * (1 + jitter) * hs, (1 + s) * (1 - jitter * 0.8) * hs, (1 - s * 0.55) * (1 + jitter) * hs)

    this.lean.rotation.x = damp(this.lean.rotation.x, tiltX, 5, dt)
    this.lean.rotation.y = damp(this.lean.rotation.y, turnY, 4 + ex * 4 + this.glance * 4, dt)
    this.lean.rotation.z = damp(this.lean.rotation.z, tiltZ + sway, 5, dt)

    if (this.shadow) {
      const k = 1 / (1 + y * 2.2)
      this.shadow.scale.set(this.built.width * 1.05 * k * (1 - s * 0.3) * hs, this.built.width * 0.6 * k * hs, 1)
    }

    /* -------- arms -------- */
    this.armsUp = damp(this.armsUp, this.armsUpTarget, 12, dt)
    const wave = Math.sin(t * (2.4 + ex * 3) + this.phase) * (0.08 + ex * 0.12)
    for (const arm of this.built.arms) {
      const side = arm.userData.side as number
      const rest = this.built.armRest + wave * side
      arm.rotation.z = side * (rest + (2.55 - rest) * this.armsUp)
    }

    /* -------- face: blink, wink, squint, widen -------- */
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

    let wink = 1
    if (this.winkT >= 0) {
      if (this.winkDelay > 0) this.winkDelay -= dt
      else {
        this.winkT += dt
        const p = this.winkT / WINK_DUR
        if (p >= 1) this.winkT = -1
        else wink = 1 - 0.88 * (p < 0.25 ? p / 0.25 : p > 0.75 ? (1 - p) / 0.25 : 1)
      }
    }

    // perk widens the eyes on top of page excitement
    const widen = 1 + ex * 0.16 + this.perkLevel * 0.08
    const squint = 1 - this.happy * 0.5
    const winkEye = face.eyes.length - 1
    for (let i = 0; i < face.eyes.length; i++) {
      const eye = face.eyes[i]!
      const w = i === winkEye ? wink : 1
      eye.lid.scale.set(widen * (1 + this.happy * 0.04), eye.baseScaleY * widen * squint * blink * w, widen)
    }
    face.mouth.scale.set(1 + this.happy * 0.35 + ex * 0.15, 1 + this.happy * 0.6 + ex * 0.2, 1)
  }

  // Scratch outputs for applyFlourish (no per-frame objects).
  private shimmyOut = 0
  private jitterOut = 0

  /** Pose this kind's flourish at progress p (0..1), intensity k. */
  private applyFlourish(p: number, k: number): number {
    const { lid, straw, cherry } = this.built.parts
    switch (this.kind) {
      case 'fries': {
        // shimmy: ±8° three times, easing out
        this.shimmyOut = 0.14 * k * Math.sin(p * Math.PI * 6) * (1 - p * 0.45)
        return FLOURISH_SHIMMY
      }
      case 'croissant': {
        // flaky shudder: four fast scale jitters
        this.jitterOut = 0.07 * k * Math.sin(p * Math.PI * 8) * (1 - p)
        return FLOURISH_JITTER
      }
      case 'burger': {
        if (!lid || !this.lidRest) return 0
        // the bun top lifts off, then lands with a squash
        const L = 0.55
        if (p < L) {
          const q = p / L
          lid.position.y = this.lidRest.y + 0.24 * k * 4 * q * (1 - q)
          lid.rotation.z = this.lidRest.rz + 0.12 * k * Math.sin(q * Math.PI)
        } else {
          const q = (p - L) / (1 - L)
          const sqz = 0.2 * k * Math.sin(q * Math.PI * 2.2) * (1 - q) ** 1.5
          lid.scale.set(1 + sqz * 0.5, 1 - sqz, 1 + sqz * 0.5)
        }
        return 0
      }
      case 'sandwich': {
        if (!lid || !this.lidRest) return 0
        // the front slice pops open like a lid, then clatters shut
        const O = 0.22
        const open = p < O ? easeOutCubic(p / O) : Math.abs(Math.cos(((p - O) / (1 - O)) * Math.PI * 2.5)) * (1 - (p - O) / (1 - O)) ** 2
        lid.rotation.x = this.lidRest.rx + 0.5 * k * open
        lid.position.y = this.lidRest.y + 0.05 * k * open
        return 0
      }
      case 'shake': {
        // straw wobble + cherry bounce with overshoot
        if (straw && this.strawRest) straw.rotation.z = this.strawRest.rz + 0.32 * k * Math.sin(p * Math.PI * 5) * (1 - p)
        if (cherry && this.cherryRest) {
          const U = 0.38
          if (p < U) {
            const q = p / U
            cherry.position.y = this.cherryRest.y + 0.16 * k * 4 * q * (1 - q)
            cherry.scale.set(1 - 0.08 * k * (1 - q), 1 + 0.12 * k * (1 - q), 1 - 0.08 * k * (1 - q))
          } else {
            const q = (p - U) / (1 - U)
            const o = Math.sin(q * Math.PI * 3) * (1 - q) ** 2
            cherry.position.y = this.cherryRest.y - 0.035 * k * o
            cherry.scale.set(1 + 0.18 * k * o, 1 - 0.22 * k * o, 1 + 0.18 * k * o)
          }
        }
        return 0
      }
      case 'coffee': {
        // 3–4 cream steam puffs rise and fade (2 at half intensity)
        const steam = this.built.parts.steam
        if (!steam || !this.puffs.length) return 0
        const tt = p * FLOURISH_DUR.coffee
        const n = k >= 0.75 ? this.puffs.length : 2
        for (let i = 0; i < this.puffs.length; i++) {
          const s = this.puffs[i]!
          const l = (tt - i * PUFF_GAP) / PUFF_LIFE
          if (i >= n || l <= 0 || l >= 1) {
            s.visible = false
            continue
          }
          s.visible = true
          s.position.set(steam.x + PUFF_X[i]! + PUFF_DRIFT[i]! * l, steam.y + 0.05 + 0.42 * easeOutCubic(l), steam.z)
          const size = (0.1 + 0.16 * l) * (0.6 + 0.4 * k)
          s.scale.set(size, size, 1)
          s.material.opacity = 0.85 * Math.sin(Math.PI * l)
        }
        return 0
      }
    }
    return 0
  }
}

