/**
 * Animation rig for one character: a persona (how its body moves), a face
 * vocabulary (moods with brows, lids and mouth), sleep and wake on the world
 * clock, quirks, glances at its neighbours, and the old favourites: eye
 * tracking, lean-toward-cursor, hops with squash & stretch, spins, arms-up.
 *
 * Hierarchy:  root (layout, entrance scale, z sprites)
 *             → hop (jump height, spin, sway offset) → squash (scale)
 *             → lean (tilt / turn) → model (steam wisps)
 *
 * Nothing here allocates per frame: every scratch vector is module-level
 * and every sprite is built once in the constructor.
 */
import * as THREE from 'three'
import type { CharacterKind, Mood } from './types'
import type { BuiltCharacter } from './characters'
import { lidAngle, lowerLidAngle } from './kit'

export interface FrameContext {
  t: number
  dt: number
  /** World-space point the crowd is looking at. */
  target: THREE.Vector3
  /** Live pointer on the crowd's plane (z = 0); null when there is none. */
  cursor: THREE.Vector3 | null
  excitement: number
  /** World energy 0..1: scales bob rate and amplitude by 0.6 + 0.8·energy. */
  energy: number
  /** Effective sleepiness 0..1; above 0.5 the crowd dozes. */
  sleepy: number
  reduced: boolean
}

/* ------------------------------------------------------------------ */
/* Personas                                                            */
/* ------------------------------------------------------------------ */

export type Quirk = 'twitch' | 'nod' | 'sip' | 'peek' | 'wobble' | 'shimmy'

export interface Persona {
  /** Heavier hops lower and lands harder. */
  mass: number
  /** Multiplies the idle bob / breathe rate. */
  bobRate: number
  /** Landing-jiggle spring stiffness and damping (low damping = jelly). */
  springK: number
  springDamp: number
  /** Multiplies jump duration (hang time). */
  hang: number
  /** > 1 blinks more often; < 1 blinks less often and more slowly. */
  blinkMul: number
  /** Multiplies how quickly the eyes chase the target. */
  eyeLambdaMul: number
  armWaveMul: number
  quirk: Quirk
}

export const PERSONAS: Record<CharacterKind, Persona> = {
  // light and twitchy, darting eyes
  fries: { mass: 0.8, bobRate: 1.25, springK: 260, springDamp: 12, hang: 0.88, blinkMul: 1.45, eyeLambdaMul: 1.7, armWaveMul: 1.35, quirk: 'twitch' },
  // solid, unhurried, nods along
  burger: { mass: 1.25, bobRate: 0.85, springK: 170, springDamp: 11, hang: 1, blinkMul: 1, eyeLambdaMul: 0.9, armWaveMul: 0.75, quirk: 'nod' },
  // calm, slow blinks, takes a sip now and then
  coffee: { mass: 1, bobRate: 0.72, springK: 190, springDamp: 12, hang: 1.05, blinkMul: 0.55, eyeLambdaMul: 0.65, armWaveMul: 0.65, quirk: 'sip' },
  // nosy: leans out to peek and back
  sandwich: { mass: 1, bobRate: 1, springK: 200, springDamp: 10, hang: 1, blinkMul: 1.1, eyeLambdaMul: 1.2, armWaveMul: 1, quirk: 'peek' },
  // heavy and wobbly on a jelly spring
  shake: { mass: 1.35, bobRate: 0.9, springK: 105, springDamp: 4.2, hang: 0.95, blinkMul: 0.9, eyeLambdaMul: 0.9, armWaveMul: 0.9, quirk: 'wobble' },
  // floaty and doughy, shimmies
  croissant: { mass: 0.85, bobRate: 0.8, springK: 145, springDamp: 6.5, hang: 1.3, blinkMul: 0.85, eyeLambdaMul: 0.85, armWaveMul: 1.1, quirk: 'shimmy' },
}

const QUIRK_DURATION: Record<Quirk, number> = { twitch: 0.9, nod: 1.2, sip: 1.7, peek: 1.9, wobble: 1.3, shimmy: 1.3 }

/* ------------------------------------------------------------------ */
/* Face vocabulary                                                     */
/* ------------------------------------------------------------------ */

interface FacePose {
  /** Brow lift, in eye radii. */
  browLift: number
  /** Brow angle in radians; positive = inner ends up (worried). */
  browAngle: number
  /** Extra lift on the screen-right brow (the curious eyebrow). */
  browAsym: number
  /** Upper-lid closure 0 (open) .. 1 (shut). */
  lidTop: number
  /** Lower-lid raise 0 .. 1. */
  lidBottom: number
  mouthW: number
  /** Mouth height scale; negative flips a smile into a frown (smile tubes only). */
  mouthH: number
  /** 0..1 blend into the surprised 'O'. */
  mouthO: number
  eyeScale: number
}

const POSES: Record<Mood, FacePose> = {
  neutral: { browLift: 0, browAngle: 0, browAsym: 0, lidTop: 0.1, lidBottom: 0, mouthW: 1, mouthH: 1, mouthO: 0, eyeScale: 1 },
  happy: { browLift: 0.18, browAngle: -0.12, browAsym: 0, lidTop: 0.14, lidBottom: 0.28, mouthW: 1.3, mouthH: 1.55, mouthO: 0, eyeScale: 1.03 },
  surprised: { browLift: 0.55, browAngle: 0.1, browAsym: 0, lidTop: 0, lidBottom: 0, mouthW: 0.8, mouthH: 0.8, mouthO: 1, eyeScale: 1.2 },
  sleepy: { browLift: -0.12, browAngle: 0.1, browAsym: 0, lidTop: 0.8, lidBottom: 0.12, mouthW: 0.85, mouthH: 0.55, mouthO: 0, eyeScale: 0.98 },
  proud: { browLift: 0.1, browAngle: -0.28, browAsym: 0, lidTop: 0.36, lidBottom: 0.18, mouthW: 1.25, mouthH: 1.2, mouthO: 0, eyeScale: 1 },
  concerned: { browLift: 0.16, browAngle: 0.38, browAsym: 0, lidTop: 0.18, lidBottom: 0.04, mouthW: 0.8, mouthH: -0.55, mouthO: 0, eyeScale: 1 },
  curious: { browLift: 0.12, browAngle: 0.04, browAsym: 0.32, lidTop: 0.04, lidBottom: 0, mouthW: 0.8, mouthH: 0.6, mouthO: 0, eyeScale: 1.08 },
}

const POSE_KEYS = Object.keys(POSES.neutral) as (keyof FacePose)[]

/* ------------------------------------------------------------------ */
/* Shared resources the engine hands every character                   */
/* ------------------------------------------------------------------ */

export interface RigShared {
  hitGeo: THREE.BufferGeometry
  hitMat: THREE.Material
  shadowGeo: THREE.BufferGeometry | null
  shadowMat: THREE.Material | null
  /** Path-drawn 'z' (null when 2D canvas is unavailable). */
  zTex: THREE.Texture | null
  /** Soft steam wisp. */
  wispTex: THREE.Texture | null
  /** Registers a per-character material for disposal with the engine's kit. */
  track: <M extends THREE.Material>(m: M) => M
}

/* ------------------------------------------------------------------ */
/* Maths                                                               */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
const rand = (a: number, b: number) => a + Math.random() * (b - a)

const _v = new THREE.Vector3()
const _gaze = new THREE.Vector3()
const _head = new THREE.Vector3()

interface ZSprite {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  /** Age in seconds; negative = waiting to launch; null = idle. */
  age: number | null
  size: number
}

interface Wisp {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  phase: number
}

const Z_LIFE = 1.8
const PEEK_HOLD = 0.6

export class Character {
  readonly root = new THREE.Group()
  readonly hop = new THREE.Group()
  readonly squash = new THREE.Group()
  readonly lean = new THREE.Group()
  readonly hit: THREE.Mesh
  readonly shadow: THREE.Mesh | null
  readonly persona: Persona
  /** Set by the engine at layout: [left, right] (either may be missing). */
  neighbours: Character[] = []
  hovered = false

  private phase = Math.random() * TAU
  private swayRate = 1.1 + Math.random() * 0.5
  private bobPhase = Math.random() * TAU
  private swayPhase = Math.random() * TAU
  private wavePhase = Math.random() * TAU
  private breathPhase = Math.random() * TAU

  // jump state
  private jumpDelay = 0
  private jumpT = -1
  private jumpDur = 0.6
  private jumpH = 0
  private spinDir = 0
  private armsUpTarget = 0
  private armsUp = 0

  // squash spring (vertical) + wobble spring (sideways tilt)
  private spring = 0
  private springV = 0
  private wob = 0
  private wobV = 0

  // face
  private happyHold = 0
  private timedMood: Mood | null = null
  private moodLeft = 0
  private readonly pose: FacePose = { ...POSES.neutral }
  private nextBlink = 1 + Math.random() * 4
  private blinkT = -1
  private doubleBlink = false

  // entrance: grow up out of the floor with an overshoot. -1 = not running.
  private introDelay = 0
  private introT = -1

  // sleep
  private doze = 0
  private sleepyOn = false
  private dozeDelay = 0
  private awakeHold = 0
  private nodT = -1
  private nextNod = rand(3, 7)
  private readonly zs: ZSprite[] = []
  private nextZ = rand(0.1, 1.2)
  private started = false
  private peekEye = -1
  private peekT = -1
  private readonly peekAmt: number[]
  private near = false
  private peekCooldown = 0

  // quirks
  private quirkT = -1
  private quirkDur = 1
  private quirkDir = 1
  private nextQuirk = rand(6, 14)

  // glances
  private glanceChar: Character | null = null
  private readonly glancePoint = new THREE.Vector3()
  private glanceMode: 0 | 1 | 2 = 0
  private glanceLeft = 0
  private glanceDelay = 0
  private nextGlance = rand(5, 9)

  // flinch (a neighbour got poked)
  private flinchDelay = -1
  private flinchDir = 0
  private flinchFrom: Character | null = null

  // coffee steam
  private readonly wisps: Wisp[] = []
  private steamBoost = 0

  // smoothed lean
  private leanX = 0
  private leanY = 0
  private leanZ = 0
  private clock = 0

  constructor(
    readonly kind: CharacterKind,
    readonly built: BuiltCharacter,
    shared: RigShared,
  ) {
    this.persona = PERSONAS[kind]
    this.root.name = kind
    this.lean.add(built.model)
    this.squash.add(this.lean)
    this.hop.add(this.squash)
    this.root.add(this.hop)
    this.peekAmt = built.face.eyes.map(() => 0)

    this.hit = new THREE.Mesh(shared.hitGeo, shared.hitMat)
    this.hit.visible = false
    this.hit.scale.set(built.width * 0.85, built.height, 0.7)
    this.hit.position.y = built.height / 2
    this.hit.userData.character = this
    this.hop.add(this.hit)

    if (shared.shadowGeo && shared.shadowMat) {
      this.shadow = new THREE.Mesh(shared.shadowGeo, shared.shadowMat)
      this.shadow.rotation.x = -Math.PI / 2
      this.shadow.position.y = 0.003
      this.shadow.renderOrder = 1
      this.shadow.scale.set(built.width * 1.05, built.width * 0.6, 1)
      this.root.add(this.shadow)
    } else {
      this.shadow = null
    }

    // Three 'z's per character, launched as a trio while dozing.
    if (shared.zTex) {
      for (let i = 0; i < 3; i++) {
        const mat = shared.track(
          new THREE.SpriteMaterial({ map: shared.zTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
        )
        const sprite = new THREE.Sprite(mat)
        sprite.visible = false
        sprite.renderOrder = 5
        this.root.add(sprite)
        this.zs.push({ sprite, mat, age: null, size: 0.075 + i * 0.03 })
      }
    }

    // Coffee: three soft wisps over the lid.
    if (built.parts.steam && shared.wispTex) {
      for (let i = 0; i < 3; i++) {
        const mat = shared.track(
          new THREE.SpriteMaterial({ map: shared.wispTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
        )
        const sprite = new THREE.Sprite(mat)
        sprite.visible = false
        sprite.renderOrder = 4
        built.model.add(sprite)
        this.wisps.push({ sprite, mat, phase: i / 3 })
      }
    }

    for (const arm of built.arms) arm.rotation.z = (arm.userData.side as number) * built.armRest
  }

  /* ---------------- public api ---------------- */

  /** Queue a hop. Heights and durations are scaled by the persona. */
  jump(opts: { height: number; duration: number; spin?: boolean; armsUp?: boolean; delay?: number }): void {
    if (this.jumpT >= 0 && this.jumpT / this.jumpDur < 0.8) {
      // already airborne: just upgrade the flourish
      if (opts.armsUp) this.armsUpTarget = 1
      return
    }
    this.jumpDelay = opts.delay ?? 0
    this.jumpT = 0
    this.jumpDur = opts.duration * this.persona.hang
    this.jumpH = opts.height / Math.sqrt(this.persona.mass)
    this.spinDir = opts.spin ? (Math.random() < 0.5 ? -1 : 1) : 0
    if (opts.armsUp) this.armsUpTarget = 1
    this.happyHold = Math.max(this.happyHold, this.jumpDur + (opts.delay ?? 0) + 0.25)
  }

  get airborne(): boolean {
    return this.jumpT >= 0
  }

  /** True while (mostly) asleep. */
  get dozing(): boolean {
    return this.doze > 0.5
  }

  /** Start small and pop up out of the floor after `delay` seconds. */
  enter(delay: number): void {
    this.introDelay = delay
    this.introT = 0
    this.root.scale.setScalar(0.35)
  }

  /** Pull a face for `seconds` (default 1.6), blending over ~180 ms. */
  setMood(mood: Mood, seconds = 1.6): void {
    this.timedMood = mood
    this.moodLeft = Math.max(0.05, seconds)
  }

  /** Stay awake for at least `seconds`, whatever the clock says. */
  wake(seconds: number): void {
    this.awakeHold = Math.max(this.awakeHold, seconds)
  }

  /**
   * Somebody clicked or tapped this character. A dozer jolts awake
   * (surprised, a 0.35 hop) and stays up for 8 s; an awake one does the
   * big spin jump. `motion` false = reduced motion: face only.
   */
  poke(motion: boolean): void {
    if (this.doze > 0.3 || (this.sleepyOn && this.awakeHold <= 0)) {
      this.wake(8)
      this.setMood('surprised', 0.9)
      if (motion) this.jump({ height: 0.35, duration: 0.6 })
    } else {
      this.happyHold = Math.max(this.happyHold, 0.9)
      if (motion) this.jump({ height: 0.62, duration: 0.78, spin: true, armsUp: true })
    }
    this.peekT = -1
  }

  /** A neighbour was poked: after `delay`, flinch toward it (hop + surprised). */
  flinch(from: Character, delay: number, strength: number): void {
    this.flinchDelay = delay
    this.flinchFrom = from
    this.flinchDir = Math.sign(from.root.position.x - this.root.position.x) || 1
    this.wake(strength > 0.75 ? 3 : 2)
  }

  /** Look at another character (or a world point) for `seconds`. */
  glanceAt(who: Character | THREE.Vector3, seconds: number, delay = 0): void {
    if (who instanceof Character) {
      if (who === this) return
      this.glanceChar = who
      this.glanceMode = 1
    } else {
      this.glancePoint.copy(who)
      this.glanceMode = 2
    }
    this.glanceLeft = seconds
    this.glanceDelay = delay
  }

  /** Play this character's signature quirk now (ignored mid-quirk). */
  quirk(): void {
    if (this.quirkT >= 0 || this.doze > 0.5) return
    const q = this.persona.quirk
    this.quirkT = 0
    this.quirkDur = QUIRK_DURATION[q]
    this.quirkDir = Math.random() < 0.5 ? -1 : 1
    switch (q) {
      case 'sip':
        this.steamBoost = 1
        this.setMood('happy', 1.5)
        break
      case 'wobble':
        this.wobV += this.quirkDir * 5.5
        this.springV -= 2.6
        break
      case 'peek': {
        this.setMood('curious', 1.7)
        _v.set(this.root.position.x + this.quirkDir * 4, this.built.headY, 1.2)
        this.glanceAt(_v, 1.5, 0.2)
        break
      }
      case 'shimmy':
        this.setMood('happy', 1.2)
        break
      case 'nod':
        this.happyHold = Math.max(this.happyHold, 1)
        break
      case 'twitch':
        this.setMood('surprised', 0.35)
        break
    }
  }

  /** Eye height in world space (includes hops). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    const s = this.root.scale.y
    return out.set(this.root.position.x + this.hop.position.x, this.root.position.y + (this.built.headY + this.hop.position.y) * s, this.root.position.z + 0.15)
  }

  /* ---------------- frame ---------------- */

  update(ctx: FrameContext): void {
    const { dt, target, reduced } = ctx
    const P = this.persona
    const face = this.built.face
    this.clock += dt
    const t = this.clock

    /* -------- timers -------- */
    this.happyHold = Math.max(0, this.happyHold - dt)
    if (this.timedMood) {
      this.moodLeft -= dt
      if (this.moodLeft <= 0) this.timedMood = null
    }
    const wasHeld = this.awakeHold > 0
    this.awakeHold = Math.max(0, this.awakeHold - dt)
    if (wasHeld && this.awakeHold <= 0) this.dozeDelay = rand(0.4, 1.6)
    this.peekCooldown = Math.max(0, this.peekCooldown - dt)

    /* -------- sleep state -------- */
    const sleepyOn = ctx.sleepy > 0.5
    if (!this.started) {
      // Already night when we arrive: start asleep, so the first frame reads as "dozing".
      this.started = true
      if (sleepyOn) {
        this.doze = 1
        Object.assign(this.pose, POSES.sleepy)
      }
    } else if (sleepyOn && !this.sleepyOn) {
      this.dozeDelay = rand(0, 2.6) // everyone nods off on their own clock
    }
    this.sleepyOn = sleepyOn
    if (this.dozeDelay > 0) this.dozeDelay -= dt
    const wantDoze = sleepyOn && this.awakeHold <= 0 && this.dozeDelay <= 0
    if (reduced) this.doze = wantDoze ? 1 : 0
    else this.doze = damp(this.doze, wantDoze ? 1 : 0, wantDoze ? 1.5 : 12, dt)
    const doze = this.doze
    const awake = 1 - doze
    const drowsy = sleepyOn ? 0 : clamp(ctx.sleepy, 0, 0.5) * 0.3
    const ex = ctx.excitement * awake

    /* -------- flinch (delayed ripple from a poked neighbour) -------- */
    if (this.flinchDelay >= 0) {
      this.flinchDelay -= dt
      if (this.flinchDelay < 0) {
        this.setMood('surprised', 0.5)
        if (!reduced) {
          this.jump({ height: 0.1, duration: 0.34 })
          this.wobV -= this.flinchDir * 3.2 // +rotation.z tips the top toward -x, so negate to lean toward
        }
        if (this.flinchFrom) this.glanceAt(this.flinchFrom, 0.9)
        this.flinchFrom = null
      }
    }

    /* -------- idle life: quirks and glances -------- */
    const idle = !reduced && doze < 0.2 && this.jumpT < 0 && !this.hovered && this.quirkT < 0 && this.introT < 0 && !this.timedMood
    if (!reduced && t > this.nextQuirk) {
      if (idle) {
        this.quirk()
        this.nextQuirk = t + rand(6, 14)
      } else this.nextQuirk = t + rand(1, 2.5)
    }
    if (!reduced && t > this.nextGlance) {
      if (idle && this.glanceLeft <= 0 && this.neighbours.length) {
        const n = this.neighbours[Math.floor(Math.random() * this.neighbours.length)]
        if (n) this.glanceAt(n, rand(0.8, 1.4))
      }
      this.nextGlance = t + rand(5, 9)
    }

    /* -------- gaze target -------- */
    let gaze: THREE.Vector3 = target
    let glancing = 0
    if (this.glanceMode) {
      if (this.glanceDelay > 0) this.glanceDelay -= dt
      else {
        this.glanceLeft -= dt
        if (this.glanceLeft <= 0 || doze > 0.6) {
          this.glanceMode = 0
          this.glanceChar = null
        } else {
          gaze = this.glanceMode === 1 && this.glanceChar ? this.glanceChar.headWorld(_gaze) : _gaze.copy(this.glancePoint)
          glancing = 1
        }
      }
    }

    /* -------- peek: a dozer opens one eye when the cursor comes close -------- */
    if (!reduced && ctx.cursor && doze > 0.6) {
      this.headWorld(_head)
      const d = Math.hypot(ctx.cursor.x - _head.x, ctx.cursor.y - _head.y)
      const nowNear = d < 1.2
      if (nowNear && (!this.near || this.peekCooldown <= 0) && this.peekT < 0) {
        const wantSide = ctx.cursor.x >= _head.x ? 1 : -1
        this.peekEye = Math.max(0, face.eyes.findIndex((e) => e.side === wantSide))
        this.peekT = 0
        this.peekCooldown = 3
      }
      this.near = nowNear
    } else if (!ctx.cursor) {
      this.near = false
    }
    for (let i = 0; i < this.peekAmt.length; i++) {
      let want = 0
      if (this.peekT >= 0 && i === this.peekEye) want = this.peekT < PEEK_HOLD ? 1 : 0
      this.peekAmt[i] = reduced ? 0 : damp(this.peekAmt[i]!, want, want ? 18 : 2.4, dt)
    }
    if (this.peekT >= 0) {
      this.peekT += dt
      if (this.peekT > PEEK_HOLD + 1.2) this.peekT = -1
    }

    /* -------- eyes: track the gaze (snap when reduced) -------- */
    const eyeLambda = reduced ? 1e6 : (14 + ex * 8) * P.eyeLambdaMul * (doze > 0.5 ? 0.3 : 1)
    for (let i = 0; i < face.eyes.length; i++) {
      const eye = face.eyes[i]!
      _v.copy(gaze)
      eye.anchor.worldToLocal(_v)
      const len = _v.length() || 1
      const yaw = clamp(Math.atan2(_v.x, _v.z), -0.62, 0.62)
      const pitch = clamp(-Math.asin(clamp(_v.y / len, -1, 1)), -0.5, 0.45)
      const k = this.peekAmt[i]! > 0.2 ? 1e6 : eyeLambda
      eye.ball.rotation.y = damp(eye.ball.rotation.y, yaw, k, dt)
      eye.ball.rotation.x = damp(eye.ball.rotation.x, pitch, k, dt)
    }

    // body turn / lean toward the gaze (in root space)
    _v.copy(gaze)
    this.root.worldToLocal(_v)
    const toward = Math.atan2(_v.x, Math.max(0.5, _v.z))
    const reach = (0.28 + ex * 0.35) * (1 - doze * 0.75) * (glancing ? 0.7 : 1)
    const turnY = clamp(toward * reach, -0.45, 0.45)
    const tiltZ = clamp(-toward * (0.05 + ex * 0.12), -0.2, 0.2) * awake
    const tiltX = clamp(Math.atan2(_v.y - this.built.height * 0.6, Math.max(0.5, _v.z)) * -0.08 * (1 + ex), -0.12, 0.12) * awake

    /* -------- mood → face pose -------- */
    let mood: Mood = 'neutral'
    if (this.timedMood) mood = this.timedMood
    else if (this.hovered && doze < 0.5) mood = 'curious'
    else if (this.happyHold > 0) mood = 'happy'
    else if (doze > 0.5) mood = 'sleepy'
    const goal = POSES[mood]
    const poseLambda = mood === 'sleepy' ? 2.2 : 16 // ~180 ms, slower when nodding off
    for (const key of POSE_KEYS) this.pose[key] = reduced ? goal[key] : damp(this.pose[key], goal[key], poseLambda, dt)

    if (reduced) {
      this.introT = -1
      this.root.scale.setScalar(1)
      this.leanX = tiltX * 0.5 + 0.13 * doze
      this.leanY = turnY * 0.5
      this.leanZ = 0
      this.lean.rotation.set(this.leanX, this.leanY, 0)
      this.hop.position.set(0, 0, 0)
      this.hop.rotation.y = 0
      this.squash.scale.set(1, 1, 1)
      this.resetQuirkParts()
      for (const z of this.zs) {
        z.age = null
        z.sprite.visible = false
      }
      for (const w of this.wisps) w.sprite.visible = false
      this.applyFace(0, drowsy, 0)
      for (const arm of this.built.arms) arm.rotation.z = (arm.userData.side as number) * this.built.armRest
      return
    }

    /* -------- entrance -------- */
    if (this.introT >= 0) {
      if (this.introDelay > 0) {
        this.introDelay -= dt
      } else {
        this.introT += dt
        const p = Math.min(1, this.introT / 0.46)
        this.root.scale.setScalar(Math.max(0.0001, 0.35 + 0.65 * easeOutBack(p)))
        if (p >= 1) {
          this.introT = -1
          this.root.scale.setScalar(1)
          this.springV -= 2.2 // landing jiggle
          this.happyHold = Math.max(this.happyHold, 0.5)
        }
      }
    }

    /* -------- idle life: bob, sway, breathe -------- */
    const eK = 0.6 + 0.8 * clamp(ctx.energy, 0, 1)
    const bobRate = 2.1 * P.bobRate * eK * (1 + ex * 1.1)
    this.bobPhase += dt * bobRate
    this.swayPhase += dt * this.swayRate * (0.7 + 0.3 * eK)
    this.breathPhase += dt * TAU * 0.25
    const breathe = Math.sin(this.bobPhase + this.phase)
    let sq = 0.016 * breathe * (1 + ex) * eK * awake + 0.02 * Math.sin(this.breathPhase) * doze
    let y = Math.max(0, Math.sin(this.bobPhase * 0.5 + this.phase)) * 0.012 * (1 + ex * 2.5) * eK * awake
    const sway = Math.sin(this.swayPhase + this.phase * 1.7) * 0.03 * (awake + 0.4 * doze)

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
          this.springV -= (3.2 + this.jumpH * 5) * Math.min(1.3, P.mass)
          this.armsUpTarget = 0
        }
      }
    }

    // landing jiggle spring (persona: stiff for fries, jelly for the shake)
    // (semi-implicit Euler: stable for these stiffnesses at the 1/20 s dt cap)
    this.springV += (-P.springK * this.spring - P.springDamp * this.springV) * dt
    this.spring += this.springV * dt
    this.wobV += (-P.springK * 0.45 * this.wob - P.springDamp * 0.8 * this.wobV) * dt
    this.wob += this.wobV * dt
    sq += this.spring

    /* -------- sleep: droop + nods -------- */
    let droop = 0.13 * doze
    if (doze > 0.7) {
      if (this.nodT < 0 && t > this.nextNod) this.nodT = 0
    }
    if (this.nodT >= 0) {
      this.nodT += dt
      const p = this.nodT / 1.5
      if (p >= 1 || doze < 0.3) {
        this.nodT = -1
        this.nextNod = t + rand(4, 9)
      } else {
        droop += (p < 0.3 ? easeInOut(p / 0.3) : 1 - easeOut((p - 0.3) / 0.7)) * 0.17 * doze
        if (p > 0.3 && p < 0.42) sq += 0.02 * Math.sin(((p - 0.3) / 0.12) * Math.PI) // little jerk back up
      }
    }

    /* -------- quirks -------- */
    let qx = 0
    let qy = 0
    let qz = 0
    let hx = 0
    if (this.quirkT >= 0) {
      this.quirkT += dt
      const p = Math.min(1, this.quirkT / this.quirkDur)
      const env = Math.sin(Math.PI * p)
      const parts = this.built.parts
      switch (this.persona.quirk) {
        case 'twitch':
          if (parts.wiggle) {
            parts.wiggle.position.y = 0.035 * Math.abs(Math.sin(p * Math.PI * 6)) * (1 - p)
            parts.wiggle.position.x = Math.sin(p * Math.PI * 11) * 0.012 * (1 - p)
          }
          qz = Math.sin(p * Math.PI * 14) * 0.035 * (1 - p)
          break
        case 'nod':
          qx = 0.15 * Math.max(0, Math.sin(p * Math.PI * 4))
          break
        case 'sip':
          if (parts.lid) parts.lid.rotation.z = 0.3 * Math.sin(Math.PI * Math.min(1, p * 1.25))
          qx = -0.06 * env
          break
        case 'peek': {
          const e = p < 0.25 ? easeInOut(p / 0.25) : p < 0.72 ? 1 : 1 - easeInOut((p - 0.72) / 0.28)
          qz = -this.quirkDir * 0.2 * e
          hx = this.quirkDir * 0.07 * e
          break
        }
        case 'shimmy':
          qy = Math.sin(p * Math.PI * 8) * 0.22 * env
          qz = Math.sin(p * Math.PI * 8 + 1) * 0.07 * env
          hx = Math.sin(p * Math.PI * 8) * 0.03 * env
          break
        case 'wobble':
          break
      }
      if (p >= 1) {
        this.quirkT = -1
        this.resetQuirkParts()
      }
    }

    this.hop.position.set(hx, y, 0)
    this.hop.rotation.y = spin
    const s = clamp(sq, -0.35, 0.3)
    this.squash.scale.set(1 - s * 0.55, 1 + s, 1 - s * 0.55)

    this.leanX = damp(this.leanX, tiltX + droop, 5, dt)
    this.leanY = damp(this.leanY, turnY, (4 + ex * 4) * (glancing ? 1.4 : 1), dt)
    this.leanZ = damp(this.leanZ, tiltZ + sway, 5, dt)
    this.lean.rotation.set(this.leanX + qx, this.leanY + qy, this.leanZ + qz + clamp(this.wob, -0.35, 0.35))

    if (this.shadow) {
      const k = 1 / (1 + y * 2.2)
      this.shadow.scale.set(this.built.width * 1.05 * k * (1 - s * 0.3), this.built.width * 0.6 * k, 1)
    }

    /* -------- arms -------- */
    this.armsUp = damp(this.armsUp, this.armsUpTarget, 12, dt)
    this.wavePhase += dt * (2.4 + ex * 3) * (0.8 + 0.2 * eK)
    const wave = Math.sin(this.wavePhase + this.phase) * (0.08 + ex * 0.12) * P.armWaveMul * (awake * 0.9 + 0.1)
    const hang = 0.12 * doze // arms go slack when asleep
    for (const arm of this.built.arms) {
      const side = arm.userData.side as number
      const rest = this.built.armRest - hang + wave * side
      arm.rotation.z = side * (rest + (2.55 - rest) * this.armsUp)
    }

    /* -------- blink -------- */
    let blinkClose = 0
    if (doze < 0.5) {
      if (this.blinkT < 0 && t > this.nextBlink) this.blinkT = 0
      if (this.blinkT >= 0) {
        this.blinkT += dt
        const D = 0.13 / Math.min(1, P.blinkMul) // slow blinkers blink slowly
        if (this.blinkT >= D) {
          this.blinkT = -1
          if (this.doubleBlink) {
            this.doubleBlink = false
            this.nextBlink = t + 0.09
          } else {
            this.doubleBlink = Math.random() < 0.2
            this.nextBlink = t + (2 + Math.random() * 4.5) / P.blinkMul
          }
        } else {
          blinkClose = Math.sin((this.blinkT / D) * Math.PI)
        }
      }
    }
    this.applyFace(blinkClose, drowsy, ex)

    /* -------- z sprites -------- */
    if (this.zs.length) {
      if (doze > 0.7 && t > this.nextZ) {
        this.zs.forEach((z, i) => (z.age = -i * 0.34))
        this.nextZ = t + rand(2.4, 4)
      }
      const zx = this.built.width * 0.2
      const zy = this.built.height * 0.9
      for (let i = 0; i < this.zs.length; i++) {
        const z = this.zs[i]!
        if (z.age === null) continue
        z.age += dt
        if (z.age < 0) {
          z.sprite.visible = false
          continue
        }
        const p = z.age / Z_LIFE
        if (p >= 1 || doze < 0.05) {
          z.age = null
          z.sprite.visible = false
          continue
        }
        z.sprite.visible = true
        z.sprite.position.set(zx + p * 0.2 + Math.sin(p * 6 + i) * 0.035, zy + p * 0.5, 0.18)
        const size = z.size * (0.6 + 0.6 * p)
        z.sprite.scale.set(size, size, 1)
        z.mat.rotation = -0.18 + Math.sin(p * 4 + i) * 0.12
        z.mat.opacity = Math.pow(Math.sin(Math.PI * p), 0.7) * 0.95 * doze
      }
    }

    /* -------- coffee steam -------- */
    if (this.wisps.length && this.built.parts.steam) {
      this.steamBoost = damp(this.steamBoost, 0, 1.1, dt)
      const base = (0.22 + 0.5 * this.steamBoost) * awake
      const rate = (1 / 2.4) * (1 + this.steamBoost * 0.9)
      const a = this.built.parts.steam
      for (let i = 0; i < this.wisps.length; i++) {
        const w = this.wisps[i]!
        w.phase = (w.phase + dt * rate) % 1
        const p = w.phase
        const op = Math.sin(Math.PI * p) * base
        w.sprite.visible = op > 0.01
        if (!w.sprite.visible) continue
        w.sprite.position.set(a.x + Math.sin(p * 5 + i * 2.1) * 0.05, a.y + p * 0.42, a.z)
        w.sprite.scale.set(0.1 + 0.14 * p, 0.2 + 0.22 * p, 1)
        w.mat.opacity = op
      }
    }
  }

  /** Writes the current pose (plus blink, drowsiness, peek) onto the face. */
  private applyFace(blinkClose: number, drowsy: number, ex: number): void {
    const face = this.built.face
    const pose = this.pose
    const es = pose.eyeScale * (1 + ex * 0.16)
    for (let i = 0; i < face.eyes.length; i++) {
      const eye = face.eyes[i]!
      const peek = this.peekAmt[i] ?? 0
      let c = clamp(Math.max(pose.lidTop + drowsy, blinkClose), 0, 1)
      c += (0.06 - c) * peek
      const low = pose.lidBottom * (1 - peek)
      eye.upper.rotation.x = lidAngle(c)
      eye.lower.rotation.x = lowerLidAngle(low)
      const showGlint = c < 0.6
      for (const g of eye.glints) g.visible = showGlint
      const wide = 1 + peek * 0.06
      eye.lid.scale.set(es * wide, eye.baseScaleY * es * wide, es * wide)
    }
    for (const b of face.brows) {
      const peekLift = this.peekEye >= 0 && face.eyes[this.peekEye]?.side === b.side ? (this.peekAmt[this.peekEye] ?? 0) * 0.3 : 0
      const lift = pose.browLift + (b.side > 0 ? pose.browAsym : 0) + peekLift
      b.bar.position.y = lift * b.r
      b.bar.rotation.z = -b.side * pose.browAngle
    }
    const O = clamp(pose.mouthO, 0, 1)
    const keep = 1 - O * 0.92
    const mh = face.openMouth ? Math.max(0.25, pose.mouthH) : pose.mouthH
    const mw = pose.mouthW + ex * 0.15
    const mhx = mh > 0 ? mh + ex * 0.2 : mh
    face.mouth.scale.set(Math.max(0.0001, mw * keep), Math.abs(mhx * keep) < 1e-4 ? 1e-4 : mhx * keep, 1)
    face.mouthO.visible = O > 0.02
    face.mouthO.scale.setScalar(Math.max(0.0001, O))
  }

  private resetQuirkParts(): void {
    const parts = this.built.parts
    if (parts.wiggle) parts.wiggle.position.set(0, 0, 0)
    if (parts.lid) parts.lid.rotation.z = 0
  }
}
