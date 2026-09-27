/**
 * The six procedural food characters. Every model is built facing +Z with
 * its feet on y = 0, roughly 1.1–1.5 units tall.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { CharacterKind } from './types'
import {
  Kit,
  addArms,
  addLegs,
  buildFace,
  canvasTexture,
  fbm,
  organic,
  paint,
  pillow,
  roundedPolygon,
  smoothLathe,
  sweep,
  withDetail,
  type FaceRig,
  type LimbShared,
  type SharedFace,
} from './kit'

export interface BuiltCharacter {
  model: THREE.Group
  face: FaceRig
  arms: THREE.Group[]
  /** Visual footprint, used for layout, hit boxes and contact shadows. */
  width: number
  height: number
  /** Arm rest angle (radians, outward). */
  armRest: number
  /** Eye height in model space: where neighbours look when they glance over. */
  headY: number
  /** Pieces the persona quirks animate. */
  parts: {
    /** fries: the sticks, jiggled by the "twitch" quirk. */
    wiggle?: THREE.Object3D
    /** coffee: the lid pivot, tilted by the "sip" quirk. */
    lid?: THREE.Object3D
    /** coffee: where the steam wisps start, in model space. */
    steam?: THREE.Vector3
  }
}

/**
 * Layout footprint per kind, known before anything is built, so the stage
 * can frame the whole cast on the first frame and drop each character into
 * its slot as it finishes building. Builders return these same numbers.
 */
export const FOOTPRINT: Record<CharacterKind, { width: number; height: number }> = {
  burger: { width: 1.3, height: 1.185 },
  fries: { width: 1.0, height: 1.23 },
  coffee: { width: 0.95, height: 1.19 },
  sandwich: { width: 1.2, height: 1.17 },
  shake: { width: 0.9, height: 1.56 },
  croissant: { width: 1.35, height: 0.91 },
}

export interface BuildContext {
  kit: Kit
  face: SharedFace
  limbs: LimbShared
  /** Geometry resolution, 1 = full; phones build at ~0.55. */
  detail?: number
}

const mesh = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]) => {
  const x = new THREE.Mesh(g, m)
  x.castShadow = true
  x.receiveShadow = true
  return x
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/* ================================================================== */
/* Burger                                                             */
/* ================================================================== */

function buildBurger({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const legH = 0.16
  const bunMat = kit.physical('bun', {
    color: '#FFFFFF',
    vertexColors: true,
    roughness: 0.5,
    clearcoat: 0.45,
    clearcoatRoughness: 0.35,
  })

  const bunPale = new THREE.Color('#F2BB6A')
  const bunToast = new THREE.Color('#B8561A')
  const bunPaint = (y0: number, y1: number) => (p: THREE.Vector3, out: THREE.Color) => {
    const k = smoothstep(y0, y1, p.y) + fbm(p.x * 5, p.y * 5, p.z * 5, 9) * 0.35
    out.copy(bunPale).lerp(bunToast, Math.min(1, Math.max(0, k)))
  }
  // Bottom bun
  const bottom = mesh(
    kit.geo(
      paint(organic(
        smoothLathe([
          [0, 0],
          [0.44, 0],
          [0.54, 0.02],
          [0.585, 0.08],
          [0.585, 0.14],
          [0.55, 0.185],
          [0.46, 0.2],
          [0, 0.2],
        ]),
        0.012,
        4,
        3,
      ), bunPaint(0.2, -0.05)),
    ),
    bunMat,
  )
  bottom.position.y = legH
  g.add(bottom)
  let y = legH + 0.19

  // Lettuce: a ruffled disc peeking out under the patty
  const lettuceGeo = new THREE.RingGeometry(0.05, 0.7, 180, 10)
  lettuceGeo.rotateX(-Math.PI / 2)
  {
    const p = lettuceGeo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const z = p.getZ(i)
      const r = Math.hypot(x, z)
      const th = Math.atan2(z, x)
      const edge = smoothstep(0.45, 0.7, r)
      const wob = 1 + 0.045 * Math.sin(th * 7 + 1.3) * edge
      p.setXYZ(i, x * wob, Math.sin(th * 17) * 0.03 * edge - edge * 0.05 + Math.sin(th * 5) * 0.015 * edge, z * wob)
    }
    lettuceGeo.computeVertexNormals()
  }
  const lettuce = mesh(
    kit.geo(lettuceGeo),
    kit.physical('lettuce', {
      color: '#46B02A',
      roughness: 0.42,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      sheen: 0.25,
      sheenColor: new THREE.Color('#D4FFA0'),
      side: THREE.DoubleSide,
    }),
  )
  lettuce.position.y = y + 0.01
  g.add(lettuce)
  y += 0.02

  // Patty: bumpy, chunky, seared
  const patty = mesh(
    kit.geo(
      organic(
        smoothLathe([
          [0, 0],
          [0.55, 0],
          [0.615, 0.025],
          [0.64, 0.085],
          [0.615, 0.145],
          [0.55, 0.175],
          [0, 0.175],
        ]),
        0.03,
        11,
        5,
      ),
    ),
    kit.physical('patty', {
      color: '#6A3620',
      roughness: 0.62,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
      sheen: 0.6,
      sheenColor: new THREE.Color('#C07A4A'),
    }),
  )
  patty.position.y = y
  g.add(patty)
  y += 0.17

  // Cheese: a square slice draped over the patty, corners melting down
  const cheeseGeo = new THREE.BoxGeometry(1.1, 0.036, 1.1, 64, 1, 64)
  cheeseGeo.rotateY(Math.PI / 4 + 0.18)
  {
    const p = cheeseGeo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i)
      let z = p.getZ(i)
      const yy = p.getY(i)
      const d = Math.hypot(x, z)
      let drop = 0
      if (d > 0.52) {
        drop = (d - 0.52) * (d - 0.52) * 3.2
        const pull = d > 0.62 ? (0.62 + (d - 0.62) * 0.3) / d : 1
        x *= pull
        z *= pull
      }
      p.setXYZ(i, x, yy - drop, z)
    }
    cheeseGeo.computeVertexNormals()
  }
  const cheeseMat = kit.physical('cheese', {
    color: '#FFB81C',
    roughness: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
    sheen: 0.4,
    sheenColor: new THREE.Color('#FFE9A0'),
  })
  const cheese = mesh(kit.geo(cheeseGeo), cheeseMat)
  cheese.position.y = y + 0.01
  g.add(cheese)
  // melted drips hanging off the corners
  const dripGeo = kit.geo(new THREE.CapsuleGeometry(0.03, 0.07, 6, 14))
  for (const [a, len] of [
    [Math.PI / 4 + 0.18, 1],
    [Math.PI / 4 + 0.18 + Math.PI, 0.7],
    [Math.PI / 4 + 0.18 - Math.PI / 2, 0.85],
  ] as const) {
    const dx = Math.sin(a + Math.PI / 4)
    const dz = Math.cos(a + Math.PI / 4)
    const drip = mesh(dripGeo, cheeseMat)
    drip.scale.set(1, len, 1)
    drip.position.set(dx * 0.664, y + 0.01 - 0.2 - 0.045 * len, dz * 0.664)
    g.add(drip)
  }
  y += 0.035

  // Tomato
  const tomato = mesh(
    kit.geo(
      smoothLathe([
        [0, 0],
        [0.54, 0],
        [0.575, 0.025],
        [0.54, 0.05],
        [0, 0.05],
      ]),
    ),
    kit.physical('tomato', { color: '#E8402C', roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.15 }),
  )
  tomato.position.y = y
  g.add(tomato)
  y += 0.04

  // Top bun: an irregular dome
  const A = 0.63
  const Bh = 0.52
  const base = 0.05
  const topPts: Array<[number, number]> = [
    [0, 0],
    [0.5, 0],
    [0.59, 0.018],
  ]
  for (let k = 0; k <= 20; k++) {
    const th = Math.PI / 2 - (k / 20) * (Math.PI / 2)
    topPts.push([A * Math.sin(th), base + Bh * Math.cos(th)])
  }
  const topBun = mesh(kit.geo(paint(organic(smoothLathe(topPts, { smooth: false, segments: 120 }), 0.018, 3.2, 11), bunPaint(0.02, 0.5))), bunMat)
  topBun.position.y = y
  g.add(topBun)

  // Sesame seeds (instanced), kept off the face
  const seedGeo = kit.geo(new THREE.SphereGeometry(0.026, 14, 10))
  const seedMat = kit.physical('seed', { color: '#FFF3D2', roughness: 0.45, clearcoat: 0.4 })
  const seeds = new THREE.InstancedMesh(seedGeo, seedMat, 30)
  seeds.castShadow = true
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const q2 = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  let placed = 0
  let tries = 0
  let s = 17
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  while (placed < 30 && tries < 600) {
    tries++
    const th = 0.12 + rnd() * 0.88
    const phi = rnd() * Math.PI * 2
    const nx = Math.sin(th) * Math.sin(phi)
    const nz = Math.sin(th) * Math.cos(phi)
    if (nz > 0.25 && th > 0.62) continue // face zone
    const pos = new THREE.Vector3(A * nx, base + Bh * Math.cos(th), A * nz)
    const n = new THREE.Vector3(pos.x / (A * A), (pos.y - base) / (Bh * Bh), pos.z / (A * A)).normalize()
    pos.addScaledVector(n, 0.004)
    q.setFromUnitVectors(up, n)
    q2.setFromAxisAngle(up, rnd() * Math.PI)
    q.multiply(q2)
    m4.compose(pos.setY(pos.y + y), q, new THREE.Vector3(0.62, 0.42, 1.25))
    seeds.setMatrixAt(placed++, m4)
  }
  seeds.count = placed
  g.add(seeds)

  const topY = y
  const surfaceZ = (x: number, yy: number) => {
    const ly = (yy - topY - base) / Bh
    const v = A * A * (1 - Math.min(1, ly * ly)) - x * x
    return v > 0 ? Math.sqrt(v) : 0
  }
  const fy = topY + base + 0.2
  const faceRig = buildFace(kit, face, {
    surfaceZ,
    eyes: [
      { x: -0.175, y: fy, r: 0.122 },
      { x: 0.175, y: fy, r: 0.122 },
    ],
    protrude: 0.35,
    mouth: { x: 0, y: fy - 0.17, w: 0.16, open: true },
    cheeks: [
      { x: -0.3, y: fy - 0.12, r: 0.06 },
      { x: 0.3, y: fy - 0.12, r: 0.06 },
    ],
    lidColor: '#CF8036',
  })
  g.add(faceRig.group)

  const limbMat = kit.physical('limb-burger', { color: '#8A4A22', roughness: 0.45, clearcoat: 0.4 })
  const arms = addArms(g, limbs, limbMat, [
    [-0.6, legH + 0.33, 0.02],
    [0.6, legH + 0.33, 0.02],
  ])
  addLegs(g, limbs, limbMat, [-0.2, 0.2], legH + 0.03)

  return { model: g, face: faceRig, arms, ...FOOTPRINT.burger, armRest: 0.45, headY: fy, parts: {} }
}

/* ================================================================== */
/* Fries                                                              */
/* ================================================================== */

function roundedRectLoop(w: number, d: number, r: number, perCorner: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = []
  const hw = w / 2 - r
  const hd = d / 2 - r
  const corners: Array<[number, number, number]> = [
    [hw, hd, 0],
    [-hw, hd, Math.PI / 2],
    [-hw, -hd, Math.PI],
    [hw, -hd, (3 * Math.PI) / 2],
  ]
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = a0 + (i / perCorner) * (Math.PI / 2)
      out.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r))
    }
  }
  return out
}

function buildFries({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const legH = 0.15
  const H = 0.78
  const W = 0.8
  const D = 0.46
  const taperX = (t: number) => 0.8 + 0.2 * t
  const taperZ = (t: number) => 0.84 + 0.16 * t
  const loop = roundedRectLoop(W, D, 0.1, 10)
  const rings = 40
  const positions: number[] = []
  const indices: number[] = []
  const n = loop.length
  for (let i = 0; i <= rings; i++) {
    const t = i / rings
    for (let j = 0; j < n; j++) {
      const p = loop[j]!
      const x = p.x * taperX(t)
      const z = p.y * taperZ(t)
      // classic carton silhouette: front/back dip, side peaks
      const frontness = smoothstep(0.1, 0.2, Math.abs(p.y))
      const dip = 0.1 * (1 - (p.x / (W / 2)) ** 2) * frontness * t ** 6
      const sidePeak = 0.05 * (1 - frontness) * t ** 6
      positions.push(x, t * H - dip + sidePeak, z)
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j
      const b = (i + 1) * n + j
      const a1 = i * n + ((j + 1) % n)
      const b1 = (i + 1) * n + ((j + 1) % n)
      indices.push(a, a1, b, b, a1, b1)
    }
  }
  // bottom cap
  const centreIdx = positions.length / 3
  positions.push(0, 0, 0)
  for (let j = 0; j < n; j++) indices.push(centreIdx, (j + 1) % n, j)
  const cartonGeo = new THREE.BufferGeometry()
  cartonGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  cartonGeo.setIndex(indices)
  cartonGeo.computeVertexNormals()

  // A cream "wave" band printed around the carton
  const cartonTex = canvasTexture(kit, 512, 256, (ctx) => {
    ctx.fillStyle = '#E3322A'
    ctx.fillRect(0, 0, 512, 256)
    ctx.fillStyle = '#FFE6B0'
    ctx.beginPath()
    ctx.moveTo(0, 256)
    for (let x = 0; x <= 512; x += 4) ctx.lineTo(x, 214 + Math.sin((x / 512) * Math.PI * 8) * 7)
    ctx.lineTo(512, 256)
    ctx.closePath()
    ctx.fill()
  })
  // planar UVs: u around, v = height
  {
    const p = cartonGeo.getAttribute('position') as THREE.BufferAttribute
    const uv: number[] = []
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getX(i), p.getZ(i))
      uv.push(a / (Math.PI * 2) + 0.5, p.getY(i) / H)
    }
    cartonGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  }
  const cartonMat = kit.physical('carton', {
    color: '#FFFFFF',
    map: cartonTex ?? null,
    roughness: 0.4,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    side: THREE.DoubleSide,
  })
  if (!cartonTex) cartonMat.color.set('#E3322A')
  const carton = mesh(kit.geo(cartonGeo), cartonMat)
  carton.position.y = legH
  g.add(carton)

  // dark inside so the carton reads as full
  const inner = mesh(
    kit.geo(new THREE.ShapeGeometry(new THREE.Shape(roundedRectLoop(W * 0.95, D * 0.93, 0.09, 8)), 1)),
    kit.physical('carton-inside', { color: '#8E1D17', roughness: 0.8 }),
  )
  inner.rotation.x = -Math.PI / 2
  inner.position.y = legH + H - 0.1
  g.add(inner)

  // Fries sticks
  const friesMat = kit.physical('fries', {
    color: '#FFFFFF',
    roughness: 0.48,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
  })
  const stickGeo = kit.geo(new RoundedBoxGeometry(0.085, 0.62, 0.085, 3, 0.03))
  const count = 24
  const sticks = new THREE.InstancedMesh(stickGeo, friesMat, count)
  sticks.castShadow = true
  const palette = ['#EFA11F', '#E8911A', '#F4B233', '#E39A22', '#F0A92A', '#DB8A16']
  let s = 5
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  const m4 = new THREE.Matrix4()
  const e = new THREE.Euler()
  const q = new THREE.Quaternion()
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const row = i % 3
    const x = ((i / count) * 2 - 1) * 0.31 + (rnd() - 0.5) * 0.07
    const z = (row - 1) * 0.1 + (rnd() - 0.5) * 0.05
    const h = 0.06 + rnd() * 0.24 + (1 - Math.abs(x) / 0.35) * 0.08 - row * 0.03
    e.set((z / 0.15) * 0.2 + (rnd() - 0.5) * 0.3, rnd() * 1.2, -(x / 0.3) * 0.32 + (rnd() - 0.5) * 0.3)
    q.setFromEuler(e)
    m4.compose(new THREE.Vector3(x, legH + H - 0.28 + h, z - 0.02), q, new THREE.Vector3(1, 1, 1))
    sticks.setMatrixAt(i, m4)
    sticks.setColorAt(i, c.set(palette[i % palette.length]!))
  }
  g.add(sticks)

  const surfaceZ = (_x: number, yy: number) => (D / 2) * taperZ(clamp01((yy - legH) / H))
  const fy = legH + 0.5
  const faceRig = buildFace(kit, face, {
    surfaceZ,
    eyes: [
      { x: -0.145, y: fy, r: 0.112 },
      { x: 0.145, y: fy, r: 0.112 },
    ],
    protrude: 0.55,
    mouth: { x: 0, y: fy - 0.17, w: 0.14, open: true },
    cheeks: [
      { x: -0.25, y: fy - 0.12, r: 0.055 },
      { x: 0.25, y: fy - 0.12, r: 0.055 },
    ],
    cheekColor: '#FF9AA0',
    lidColor: '#D9302A',
    browColor: '#4A1210',
  })
  g.add(faceRig.group)

  const limbMat = kit.physical('limb-fries', { color: '#B8231C', roughness: 0.4, clearcoat: 0.5 })
  const arms = addArms(g, limbs, limbMat, [
    [-0.36, legH + 0.4, 0],
    [0.36, legH + 0.4, 0],
  ])
  addLegs(g, limbs, limbMat, [-0.16, 0.16], legH + 0.03)
  return { model: g, face: faceRig, arms, ...FOOTPRINT.fries, armRest: 0.3, headY: fy, parts: { wiggle: sticks } }
}

/* ================================================================== */
/* Coffee — "stackd"                                                  */
/* ================================================================== */

function buildCoffee({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const legH = 0.14
  const r = (y: number) => 0.31 + 0.1 * (y / 0.86)

  const cupPts: Array<[number, number]> = [
    [0, 0],
    [0.26, 0],
    [0.3, 0.015],
    [0.312, 0.05],
  ]
  for (let k = 1; k <= 8; k++) {
    const yy = 0.05 + (k / 8) * 0.8
    cupPts.push([r(yy), yy])
  }
  cupPts.push([0.43, 0.87], [0.4, 0.88])
  const cup = mesh(
    kit.geo(smoothLathe(cupPts, { samples: 80 })),
    kit.physical('cup', { color: '#FFF7EA', roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.12 }),
  )
  cup.position.y = legH
  g.add(cup)

  // Kraft sleeve with the stackd wordmark
  const sleeveTex = canvasTexture(kit, 1024, 256, (ctx) => {
    ctx.fillStyle = '#B06F37'
    ctx.fillRect(0, 0, 1024, 256)
    // subtle kraft fibre
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,230,190' : '90,50,20'},0.07)`
      ctx.fillRect(Math.random() * 1024, Math.random() * 256, 6 + Math.random() * 14, 1.5)
    }
    ctx.fillStyle = '#FFF1DC'
    ctx.font = '800 76px "Arial Rounded MT Bold", "Nunito", ui-rounded, "Helvetica Neue", Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('stackd', 512, 132)
  })
  const sy0 = 0.2
  const sy1 = 0.47
  const sleeveGeo = smoothLathe(
    [
      [r(sy0) + 0.004, sy0],
      [r(sy0) + 0.018, sy0 + 0.012],
      [r((sy0 + sy1) / 2) + 0.021, (sy0 + sy1) / 2],
      [r(sy1) + 0.018, sy1 - 0.012],
      [r(sy1) + 0.004, sy1],
    ],
    { samples: 30 },
  )
  const sleeve = mesh(
    kit.geo(sleeveGeo),
    kit.physical('sleeve', { color: sleeveTex ? '#FFFFFF' : '#B06F37', map: sleeveTex ?? null, roughness: 0.78, sheen: 0.3, sheenColor: new THREE.Color('#E8B98A') }),
  )
  sleeve.position.y = legH
  g.add(sleeve)

  // Lid
  const lidMat = kit.physical('lid', { color: '#3C2320', roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.15 })
  const lid = mesh(
    kit.geo(
      smoothLathe(
        [
          [0, 0.855],
          [0.415, 0.855],
          [0.445, 0.87],
          [0.452, 0.905],
          [0.44, 0.935],
          [0.395, 0.95],
          [0.37, 0.975],
          [0.345, 1.02],
          [0.3, 1.04],
          [0, 1.045],
        ],
        { samples: 60 },
      ),
    ),
    lidMat,
  )
  // The lid hangs off a pivot on its screen-left rim so the "sip" quirk can
  // tip it up like someone lifting the lid for a slurp.
  const lidPivot = new THREE.Group()
  lidPivot.position.set(-0.44, legH + 0.87, 0)
  lid.position.set(0.44, -0.87, 0)
  lidPivot.add(lid)
  g.add(lidPivot)
  const sip = mesh(kit.geo(new RoundedBoxGeometry(0.12, 0.03, 0.05, 3, 0.014)), kit.physical('sip', { color: '#1B0F0D', roughness: 0.5 }))
  sip.position.set(0.44, 1.04 - 0.87, 0.2)
  sip.rotation.x = 0.12
  lidPivot.add(sip)

  const surfaceZ = (x: number, yy: number) => {
    const rr = r(Math.min(0.86, Math.max(0, yy - legH)))
    return Math.sqrt(Math.max(0, rr * rr - x * x))
  }
  const fy = legH + 0.67
  const faceRig = buildFace(kit, face, {
    surfaceZ,
    eyes: [
      { x: -0.135, y: fy, r: 0.105 },
      { x: 0.135, y: fy, r: 0.105 },
    ],
    protrude: 0.4,
    mouth: { x: 0, y: fy - 0.13, w: 0.12 },
    cheeks: [
      { x: -0.23, y: fy - 0.09, r: 0.05 },
      { x: 0.23, y: fy - 0.09, r: 0.05 },
    ],
    lidColor: '#F1E3CF',
  })
  g.add(faceRig.group)

  const arms = addArms(g, limbs, lidMat, [
    [-0.355, legH + 0.42, 0],
    [0.355, legH + 0.42, 0],
  ])
  addLegs(g, limbs, lidMat, [-0.13, 0.13], legH + 0.03)
  return {
    model: g,
    face: faceRig,
    arms,
    ...FOOTPRINT.coffee,
    armRest: 0.3,
    headY: fy,
    parts: { lid: lidPivot, steam: new THREE.Vector3(0.02, legH + 1.1, 0.08) },
  }
}

/* ================================================================== */
/* Sandwich                                                           */
/* ================================================================== */

function buildSandwich({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const inner = new THREE.Group()
  const legH = 0.15
  const tri: Array<[number, number]> = [
    [-0.6, 0],
    [0.6, 0],
    [0, 0.98],
  ]
  const cy = 0.98 / 3
  const shape = roundedPolygon(tri, 0.17)
  const outline = shape.getSpacedPoints(200)
  outline.pop()

  // Soft bread slices: golden crust rim, pillowy crumb face.
  const crustC = new THREE.Color('#BD6A26')
  const crumbC = new THREE.Color('#F7DDA2')
  const breadGeo = kit.geo(
    pillow(outline, { halfThick: 0.07, edge: 0.13, dome: 0.03 }, (t, out) => {
      out.copy(crustC).lerp(crumbC, smoothstep(0.3, 0.5, t))
    }),
  )
  const bread = kit.physical('bread', { color: '#FFFFFF', vertexColors: true, roughness: 0.7, clearcoat: 0.15, clearcoatRoughness: 0.6, sheen: 0.5, sheenColor: new THREE.Color('#FFF1CF') })
  const front = mesh(breadGeo, bread)
  front.position.z = 0.155
  const back = mesh(breadGeo, bread)
  back.position.z = -0.155
  inner.add(front, back)

  const slab = (depth: number, bevel: number, scale: number) => {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 5,
      curveSegments: 24,
    })
    geo.translate(0, -cy, -depth / 2)
    geo.scale(scale, scale, 1)
    geo.translate(0, cy - (scale - 1) * 0.3, 0)
    return geo
  }
  const ruffle = (geo: THREE.BufferGeometry, amp: number, freq: number) => {
    const p = geo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const yy = p.getY(i) - cy
      const a = Math.atan2(yy, x)
      const k = 1 + amp * Math.sin(a * freq)
      p.setXYZ(i, x * k, yy * k + cy, p.getZ(i) + Math.sin(a * freq * 1.7) * amp * 0.4)
    }
    geo.computeVertexNormals()
    return geo
  }
  const lettuce = mesh(
    kit.geo(ruffle(slab(0.016, 0.01, 1.08), 0.05, 22)),
    kit.physical('lettuce', { color: '#46B02A', roughness: 0.42, clearcoat: 0.45, clearcoatRoughness: 0.3, sheen: 0.25, sheenColor: new THREE.Color('#D4FFA0'), side: THREE.DoubleSide }),
  )
  lettuce.position.z = 0.058
  const cheese = mesh(
    kit.geo(slab(0.018, 0.01, 1.07)),
    kit.physical('cheese', { color: '#FFB81C', roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2, sheen: 0.4, sheenColor: new THREE.Color('#FFE9A0') }),
  )
  cheese.position.z = 0.022
  const tomato = mesh(kit.geo(slab(0.035, 0.012, 1.05)), kit.physical('tomato', { color: '#E8402C', roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.15 }))
  tomato.position.z = -0.018
  const ham = mesh(kit.geo(ruffle(slab(0.03, 0.012, 1.075), 0.018, 7)), kit.physical('ham', { color: '#F08A95', roughness: 0.42, clearcoat: 0.45, sheen: 0.5, sheenColor: new THREE.Color('#FFD6DA') }))
  ham.position.z = -0.062
  inner.add(lettuce, cheese, tomato, ham)
  inner.position.y = legH
  inner.rotation.y = -0.42
  g.add(inner)

  // face sits on the front slice (in the rotated inner frame)
  const zFront = 0.155 + 0.07 + 0.026
  const fy = 0.42
  const faceRig = buildFace(kit, face, {
    surfaceZ: () => zFront,
    eyes: [
      { x: -0.14, y: fy, r: 0.105 },
      { x: 0.14, y: fy, r: 0.105 },
    ],
    protrude: 0.45,
    mouth: { x: 0, y: fy - 0.15, w: 0.13, open: true },
    cheeks: [
      { x: -0.26, y: fy - 0.11, r: 0.055 },
      { x: 0.26, y: fy - 0.11, r: 0.055 },
    ],
    lidColor: '#EFCF8C',
  })
  inner.add(faceRig.group)

  const limbMat = kit.physical('limb-sandwich', { color: '#B56C2A', roughness: 0.5, clearcoat: 0.3 })
  const arms = addArms(inner, limbs, limbMat, [
    [-0.47, 0.26, 0.04],
    [0.47, 0.26, 0.04],
  ])
  addLegs(g, limbs, limbMat, [-0.2, 0.2], legH + 0.05)
  return { model: g, face: faceRig, arms, ...FOOTPRINT.sandwich, armRest: 0.5, headY: legH + fy, parts: {} }
}

/* ================================================================== */
/* Shake                                                              */
/* ================================================================== */

function buildShake({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const legH = 0.14
  const r = (y: number) => 0.265 + 0.1 * (y / 0.84)

  const stripeTex = canvasTexture(kit, 512, 64, (ctx) => {
    ctx.fillStyle = '#F2679A'
    ctx.fillRect(0, 0, 512, 64)
    ctx.fillStyle = '#FF9DC0'
    for (let i = 0; i < 16; i++) ctx.fillRect(i * 32 + 4, 0, 14, 64)
  })
  if (stripeTex) {
    stripeTex.wrapS = THREE.RepeatWrapping
  }
  const pts: Array<[number, number]> = [
    [0, 0],
    [0.22, 0],
    [0.255, 0.012],
    [0.268, 0.05],
  ]
  for (let k = 1; k <= 8; k++) {
    const yy = 0.05 + (k / 8) * 0.78
    pts.push([r(yy), yy])
  }
  pts.push([0.385, 0.85], [0.37, 0.865])
  const cup = mesh(
    kit.geo(smoothLathe(pts, { samples: 80 })),
    kit.physical('shake-cup', { color: stripeTex ? '#FFFFFF' : '#F2679A', map: stripeTex ?? null, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 }),
  )
  cup.position.y = legH
  g.add(cup)

  // Whipped cream: tiered swirl
  const creamGeo = smoothLathe(
    [
      [0, 0.8],
      [0.36, 0.8],
      [0.405, 0.845],
      [0.41, 0.9],
      [0.37, 0.95],
      [0.3, 0.975],
      [0.32, 1.01],
      [0.3, 1.06],
      [0.22, 1.09],
      [0.225, 1.12],
      [0.18, 1.17],
      [0.09, 1.22],
      [0.03, 1.27],
      [0, 1.285],
    ],
    { samples: 120, segments: 128 },
  )
  {
    const p = creamGeo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const z = p.getZ(i)
      const yy = p.getY(i)
      if (yy < 0.83) continue
      const a = Math.atan2(x, z)
      const k = 1 + 0.07 * Math.sin(a * 6 + yy * 34) * smoothstep(0.83, 0.9, yy)
      p.setX(i, x * k)
      p.setZ(i, z * k)
    }
  }
  const cream = mesh(
    kit.geo(organic(creamGeo, 0.01, 9, 21)),
    kit.physical('cream', { color: '#FFF8EE', roughness: 0.55, clearcoat: 0.2, sheen: 0.9, sheenColor: new THREE.Color('#FFFFFF'), sheenRoughness: 0.5 }),
  )
  cream.position.y = legH
  g.add(cream)

  // Cherry
  const cherry = mesh(kit.geo(new THREE.SphereGeometry(0.075, 32, 24)), kit.physical('cherry', { color: '#D3142E', roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 }))
  cherry.position.set(-0.02, legH + 1.33, 0.02)
  g.add(cherry)
  const stem = mesh(
    kit.geo(
      new THREE.TubeGeometry(
        new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, 0.1, 0), new THREE.Vector3(0.07, 0.15, -0.02)),
        16,
        0.009,
        8,
      ),
    ),
    kit.physical('stem', { color: '#4E7A22', roughness: 0.5 }),
  )
  stem.position.set(-0.02, legH + 1.39, 0.02)
  g.add(stem)

  // Striped straw
  const strawTex = canvasTexture(kit, 64, 256, (ctx) => {
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, 64, 256)
    ctx.fillStyle = '#E8392F'
    for (let i = -2; i < 10; i++) {
      ctx.beginPath()
      ctx.moveTo(0, i * 32)
      ctx.lineTo(64, i * 32 + 24)
      ctx.lineTo(64, i * 32 + 40)
      ctx.lineTo(0, i * 32 + 16)
      ctx.closePath()
      ctx.fill()
    }
  })
  if (strawTex) {
    strawTex.wrapT = THREE.RepeatWrapping
    strawTex.repeat.set(1, 3)
  }
  const straw = mesh(
    kit.geo(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 24, 1)),
    kit.physical('straw', { color: strawTex ? '#FFFFFF' : '#E8392F', map: strawTex ?? null, roughness: 0.3, clearcoat: 0.8 }),
  )
  straw.position.set(0.14, legH + 1.15, -0.1)
  straw.rotation.z = -0.32
  g.add(straw)

  const surfaceZ = (x: number, yy: number) => {
    const rr = r(Math.min(0.84, Math.max(0, yy - legH)))
    return Math.sqrt(Math.max(0, rr * rr - x * x))
  }
  const fy = legH + 0.6
  const faceRig = buildFace(kit, face, {
    surfaceZ,
    eyes: [
      { x: -0.125, y: fy, r: 0.102 },
      { x: 0.125, y: fy, r: 0.102 },
    ],
    protrude: 0.4,
    mouth: { x: 0, y: fy - 0.13, w: 0.11 },
    cheeks: [
      { x: -0.21, y: fy - 0.09, r: 0.045 },
      { x: 0.21, y: fy - 0.09, r: 0.045 },
    ],
    cheekColor: '#FF4F7E',
    lidColor: '#EE6394',
  })
  g.add(faceRig.group)

  const limbMat = kit.physical('limb-shake', { color: '#D9487A', roughness: 0.35, clearcoat: 0.6 })
  const arms = addArms(g, limbs, limbMat, [
    [-0.31, legH + 0.4, 0],
    [0.31, legH + 0.4, 0],
  ])
  addLegs(g, limbs, limbMat, [-0.12, 0.12], legH + 0.03)
  return { model: g, face: faceRig, arms, ...FOOTPRINT.shake, armRest: 0.28, headY: fy, parts: {} }
}

/* ================================================================== */
/* Croissant                                                          */
/* ================================================================== */

function buildCroissant({ kit, face, limbs }: BuildContext): BuiltCharacter {
  const g = new THREE.Group()
  const R = 0.4
  const cy = 0.2
  const a0 = Math.PI + 0.42
  const span = Math.PI + 0.84
  const rMax = 0.31
  const depth = 0.86
  const angle = (t: number) => a0 - t * span
  const env = (t: number) => Math.pow(Math.sin(Math.PI * t), 0.62)
  const segs = 5
  const seg = (t: number, th: number) => {
    // diagonal rolled layers: ridge phase shifts around the cross-section
    const ph = segs * Math.PI * t + 0.35 * Math.sin(th)
    return 0.8 + 0.2 * Math.pow(Math.abs(Math.sin(ph)), 0.55)
  }
  const rad = (t: number, th: number) => {
    const base = rMax * env(t) * seg(t, th) + 0.012
    const flake = 1 + fbm(t * 14, Math.cos(th) * 2, Math.sin(th) * 2, 4) * 0.05
    return base * flake
  }
  const center = (t: number) => new THREE.Vector3(R * Math.cos(angle(t)), cy + R * Math.sin(angle(t)), 0)
  const frame = (t: number): [THREE.Vector3, THREE.Vector3] => [new THREE.Vector3(Math.cos(angle(t)), Math.sin(angle(t)), 0), new THREE.Vector3(0, 0, 1)]
  const light = new THREE.Color('#F7C471')
  const dark = new THREE.Color('#A34E16')
  const geo = sweep(
    center,
    frame,
    (t, th) => {
      const rr = rad(t, th)
      return [rr, rr * depth]
    },
    220,
    64,
    (t, th, out) => {
      const crest = Math.pow(Math.abs(Math.sin(segs * Math.PI * t + 0.35 * Math.sin(th))), 1.5)
      const top = 0.5 + 0.5 * Math.cos(th) // outer side bakes darker
      out.copy(light).lerp(dark, clamp01(0.12 + crest * 0.55 + top * 0.3 + (1 - env(t)) * 0.45))
    },
  )
  const body = mesh(kit.geo(geo), kit.physical('croissant', { color: '#FFFFFF', vertexColors: true, roughness: 0.56, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.3 }))
  g.add(body)

  // Face on the top bulge: map (x, y) back to the tube.
  const surfaceZ = (x: number, yy: number) => {
    const a = Math.atan2(yy - cy, x)
    const t = clamp01((a0 - (a < -Math.PI / 2 ? a + Math.PI * 2 : a)) / span)
    const d = Math.hypot(x, yy - cy) - R
    const rr = rMax * env(t) * seg(t, Math.PI / 2) + 0.012
    const v = 1 - (d / rr) ** 2
    return v > 0 ? rr * depth * Math.sqrt(v) : 0
  }
  const fy = cy + R + 0.04
  const faceRig = buildFace(kit, face, {
    surfaceZ,
    eyes: [
      { x: -0.13, y: fy, r: 0.1 },
      { x: 0.13, y: fy, r: 0.1 },
    ],
    protrude: 0.45,
    mouth: { x: 0, y: fy - 0.13, w: 0.11 },
    cheeks: [
      { x: -0.22, y: fy - 0.1, r: 0.05 },
      { x: 0.22, y: fy - 0.1, r: 0.05 },
    ],
    lidColor: '#E0994A',
  })
  g.add(faceRig.group)

  const limbMat = kit.physical('limb-croissant', { color: '#A9561A', roughness: 0.45, clearcoat: 0.5 })
  const arms = addArms(g, limbs, limbMat, [
    [-0.5, 0.44, 0.08],
    [0.5, 0.44, 0.08],
  ])
  return { model: g, face: faceRig, arms, ...FOOTPRINT.croissant, armRest: 0.35, headY: fy, parts: {} }
}

const BUILDERS: Record<CharacterKind, (ctx: BuildContext) => BuiltCharacter> = {
  burger: buildBurger,
  fries: buildFries,
  coffee: buildCoffee,
  sandwich: buildSandwich,
  shake: buildShake,
  croissant: buildCroissant,
}

export function buildCharacter(kind: CharacterKind, ctx: BuildContext): BuiltCharacter {
  return withDetail(ctx.detail ?? 1, () => BUILDERS[kind](ctx))
}
