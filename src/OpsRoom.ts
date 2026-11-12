import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import brisbane from './brisbane-cbd.json' with { type: 'json' }
import { Traffic, type Car, type Network } from './traffic.ts'

// An operations room in white: rows of desks facing a wall of screens. The big screen shows
// a white city with traffic in quiet tints and one car in strong red; the side screens show
// the same city from above, a camera behind the red car, and two calm panels.

const WHITE = '#f7f7f4'
const PAPER = '#eceef0'
const GREY = '#dcdfe3'
const STEEL = '#b7bcc3'
const TARGET = '#ff1a1a'
const TRAFFIC = ['#7fa6c4', '#9cb98f', '#a99cc9', '#8f99a5', '#c9b48a', '#7fbab4']

// Traffic in the city, besides the target.
const CARS = 360
// Buildings stand at this share of their height, so the streets between towers stay in view.
const RELIEF = 0.35
// The busiest part of the map, which the target keeps to, with its reach along the streets.
const CORE = { at: { x: 8, z: -29 }, radius: 160 }
const MAP = brisbane as unknown as CityMap
// Visitors who ask their device for less motion get the first frame and no more.
const STILL = window.matchMedia('(prefers-reduced-motion: reduce)')

type CityMap = Network & {
  bounds: [number, number, number, number]
  buildings: [number, [number, number][]][]
  water: [number, number][][]
  parks: [number, number][][]
}

const MAIN = { w: 18, h: 6.75 }
const SIDE = { w: 6, h: 3.375 }
const WALL_Z = -15
// Half the height of the ground the overhead screen shows around the target.
const TOP_VIEW = 60

function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const matte = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 })

function box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  draw(canvas.getContext('2d')!)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// A workstation screen: a few grey rows, and on some a red mark where the target is.
function deskScreen(mark: boolean) {
  return canvasTexture(256, 160, (ctx) => {
    ctx.fillStyle = '#f2f4f6'
    ctx.fillRect(0, 0, 256, 160)
    ctx.fillStyle = '#d6dade'
    for (let i = 0; i < 6; i++) ctx.fillRect(18, 22 + i * 20, 120 - (i % 3) * 26, 8)
    ctx.fillStyle = '#e3e6ea'
    ctx.fillRect(160, 22, 78, 116)
    if (mark) {
      ctx.fillStyle = TARGET
      ctx.beginPath()
      ctx.arc(199, 80, 7, 0, Math.PI * 2)
      ctx.fill()
    }
  })
}

// The city on the screens: Brisbane's centre from OpenStreetMap, with white buildings in
// low relief, pale streets, the river and parks, traffic in quiet tints and the target in
// strong red.
class City {
  readonly scene = new THREE.Scene()
  readonly traffic: Traffic
  readonly target: THREE.Mesh
  private readonly fleet: THREE.InstancedMesh
  private readonly sun = new THREE.DirectionalLight('#ffffff', 1.6)
  private readonly ring: THREE.Mesh
  private readonly beam: THREE.Mesh
  private readonly dummy = new THREE.Object3D()

  constructor() {
    const random = seeded(7)
    this.scene.background = new THREE.Color('#e9ecef')
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#cfd4da', 2.2))
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 140 })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.scene.add(this.sun, this.sun.target)

    const [x0, z0, x1, z1] = MAP.bounds
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 200, z1 - z0 + 200), matte('#dde1e5'))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
    this.scene.add(flat(MAP.water, '#c9d5de', 0.02), flat(MAP.parks, '#d9e2d6', 0.03), this.streets())

    const tones = ['#ffffff', '#f3f4f5', '#e8eaed']
    const parts: THREE.BufferGeometry[][] = tones.map(() => [])
    for (const [h, ring] of MAP.buildings) {
      const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)))
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(h * RELIEF, 0.6), bevelEnabled: false })
      geometry.rotateX(-Math.PI / 2)
      parts[Math.floor(random() * tones.length)].push(geometry)
    }
    parts.forEach((list, k) => {
      const mesh = new THREE.Mesh(mergeGeometries(list), matte(tones[k]))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)
      list.forEach((g) => g.dispose())
    })

    this.traffic = new Traffic(MAP, CARS + 1, random)
    // The target is the car nearest the centre, kept last in the list.
    const cars = this.traffic.cars
    const away = (c: Car) => Math.hypot(c.x - CORE.at.x, c.z - CORE.at.z)
    const first = cars.reduce((best, c) => (away(c) < away(best) ? c : best))
    cars[cars.indexOf(first)] = cars[CARS]
    cars[CARS] = first
    first.home = CORE
    const body = new THREE.BoxGeometry(0.5, 0.3, 0.95)
    this.fleet = new THREE.InstancedMesh(body, matte('#ffffff'), CARS)
    this.fleet.castShadow = true
    const tint = new THREE.Color()
    for (let k = 0; k < CARS; k++) this.fleet.setColorAt(k, tint.set(TRAFFIC[k % TRAFFIC.length]))
    this.scene.add(this.fleet)
    this.target = new THREE.Mesh(body, new THREE.MeshStandardMaterial({ color: TARGET, emissive: TARGET, emissiveIntensity: 0.45, roughness: 0.6 }))
    this.target.castShadow = true
    this.scene.add(this.target)

    // The marker shows through buildings, so the target is never lost behind a tower.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.1, 48),
      new THREE.MeshBasicMaterial({ color: TARGET, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.renderOrder = 2
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 6, 8),
      new THREE.MeshBasicMaterial({ color: TARGET, transparent: true, opacity: 0.6, depthTest: false }),
    )
    this.beam.renderOrder = 2
    this.scene.add(this.ring, this.beam)
  }

  // Every street once, as a flat band along its centre line, with a disc at each junction.
  private streets() {
    const parts: THREE.BufferGeometry[] = []
    for (const [a, b, pts, two] of MAP.edges) {
      if (two === 1 && a > b) continue
      const width = two === 1 ? 1.7 : 1.5
      const vertices: number[] = []
      const index: number[] = []
      pts.forEach(([x, z], k) => {
        const [px, pz] = pts[Math.max(0, k - 1)]
        const [nx, nz] = pts[Math.min(pts.length - 1, k + 1)]
        const d = Math.hypot(nx - px, nz - pz)
        const ox = ((nz - pz) / d) * (width / 2)
        const oz = (-(nx - px) / d) * (width / 2)
        vertices.push(x + ox, 0.04, z + oz, x - ox, 0.04, z - oz)
        if (k > 0) index.push(k * 2 - 2, k * 2 - 1, k * 2, k * 2 - 1, k * 2 + 1, k * 2)
      })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
      geometry.setIndex(index)
      parts.push(geometry)
    }
    for (const [x, z] of MAP.nodes) {
      const disc = new THREE.CircleGeometry(1.05, 20).rotateX(-Math.PI / 2)
      disc.deleteAttribute('uv')
      disc.deleteAttribute('normal')
      parts.push(disc.translate(x, 0.045, z))
    }
    const merged = mergeGeometries(parts)
    merged.computeVertexNormals()
    parts.forEach((g) => g.dispose())
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: '#f5f6f7', roughness: 0.95, side: THREE.DoubleSide }))
    mesh.receiveShadow = true
    return mesh
  }

  get heading() {
    return this.target.rotation.y
  }

  update(dt: number, time: number) {
    this.traffic.update(dt)
    const cars = this.traffic.cars
    for (let k = 0; k < CARS; k++) {
      const car = cars[k]
      this.dummy.position.set(car.x, 0.2, car.z)
      this.dummy.rotation.y = car.heading
      this.dummy.updateMatrix()
      this.fleet.setMatrixAt(k, this.dummy.matrix)
    }
    this.fleet.instanceMatrix.needsUpdate = true
    const red = cars[CARS]
    this.target.position.set(red.x, 0.2, red.z)
    this.target.rotation.y = red.heading

    const at = this.target.position
    const pulse = (time * 0.8) % 1
    this.ring.position.set(at.x, 0.12, at.z)
    this.ring.scale.setScalar(0.8 + pulse * 1.4)
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 1 - pulse
    this.beam.position.set(at.x, 3.2, at.z)
    // Shadows are drawn around the target, where the screens look.
    this.sun.position.set(at.x - 18, 40, at.z + 12)
    this.sun.target.position.copy(at)
  }
}

// Flat areas such as water and parks, laid on the ground.
function flat(rings: [number, number][][], color: string, y: number) {
  const shapes = rings.map((ring) => new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z))))
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapes).rotateX(-Math.PI / 2), matte(color))
  mesh.position.y = y
  mesh.receiveShadow = true
  return mesh
}

// One screen in the wall: a bezel and a lit face showing a texture.
function screen(width: number, height: number, map: THREE.Texture, x: number, y: number) {
  const group = new THREE.Group()
  group.add(box(width + 0.36, height + 0.36, 0.24, matte(STEEL), 0, 0, 0))
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map, toneMapped: false }))
  face.position.z = 0.125
  group.add(face)
  group.position.set(x, y, WALL_Z + 0.3)
  return group
}

export class OpsRoom {
  private readonly host: HTMLElement
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true })
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200)
  private readonly city = new City()
  private readonly mainCam = new THREE.PerspectiveCamera(32, MAIN.w / MAIN.h, 0.5, 200)
  private readonly chaseCam = new THREE.PerspectiveCamera(50, SIDE.w / SIDE.h, 0.1, 200)
  private readonly topCam = new THREE.OrthographicCamera(-TOP_VIEW * 1.78, TOP_VIEW * 1.78, TOP_VIEW, -TOP_VIEW, 1, 200)
  private readonly mainTarget = new THREE.WebGLRenderTarget(2048, 768, { samples: 4 })
  private readonly chaseTarget = new THREE.WebGLRenderTarget(768, 432, { samples: 4 })
  private readonly topTarget = new THREE.WebGLRenderTarget(768, 432, { samples: 4 })
  private readonly timeline: THREE.CanvasTexture
  private readonly resize = new ResizeObserver(() => this.fit())
  // The room only runs while some of it is on screen.
  private readonly seen = new IntersectionObserver(([entry]) => this.show(entry.isIntersecting))
  private readonly clock = new THREE.Timer()
  private readonly look = new THREE.Vector3()
  private readonly chaseLook = new THREE.Vector3()
  private time = 0
  private frame = 0

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.NeutralToneMapping
    host.append(this.renderer.domElement)

    this.topCam.position.set(0, 120, 0)
    this.topCam.up.set(0, 0, -1)
    this.topCam.lookAt(0, 0, 0)
    this.timeline = canvasTexture(768, 432, (ctx) => this.drawTimeline(ctx, 0))

    this.buildRoom()
    this.resize.observe(host)
    this.seen.observe(host)
    this.fit()
  }

  private show(visible: boolean) {
    if (visible && !this.frame) this.loop()
    if (!visible) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
  }

  private buildRoom() {
    const scene = this.scene
    scene.background = new THREE.Color('#f1f2f3')
    scene.add(new THREE.HemisphereLight('#ffffff', '#e2e5e9', 2.6))
    const sun = new THREE.DirectionalLight('#ffffff', 1.3)
    sun.position.set(6, 22, 16)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.radius = 4
    Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 70 })
    sun.shadow.camera.updateProjectionMatrix()
    scene.add(sun)

    const wall = new THREE.MeshStandardMaterial({ color: WHITE, emissive: WHITE, emissiveIntensity: 0.3, roughness: 0.9 })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 50), matte(PAPER))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor)
    const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 26), wall)
    back.position.set(0, 13, WALL_Z)
    back.receiveShadow = true
    scene.add(back)
    for (const side of [-1, 1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(50, 26), wall)
      plane.position.set(side * 23, 13, 10)
      plane.rotation.y = -side * (Math.PI / 2)
      plane.receiveShadow = true
      scene.add(plane)
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(60, 50), wall)
    ceiling.position.set(0, 14, 10)
    ceiling.rotation.x = Math.PI / 2
    scene.add(ceiling)
    const strip = new THREE.MeshBasicMaterial({ color: '#ffffff' })
    for (let k = 0; k < 5; k++) {
      const light = new THREE.Mesh(new THREE.BoxGeometry(30, 0.06, 0.5), strip)
      light.position.set(0, 13.95, -10 + k * 6)
      scene.add(light)
    }

    // The wall of screens, with a console along its foot.
    scene.add(screen(MAIN.w, MAIN.h, this.mainTarget.texture, 0, 6.9))
    scene.add(screen(SIDE.w, SIDE.h, this.topTarget.texture, -13.4, 8.6))
    scene.add(screen(SIDE.w, SIDE.h, this.chaseTarget.texture, 13.4, 8.6))
    scene.add(screen(SIDE.w, SIDE.h, this.timeline, 13.4, 4.9))
    scene.add(screen(SIDE.w, SIDE.h, deskScreen(false), -13.4, 4.9))
    scene.add(box(40, 1.1, 1.6, matte(GREY), 0, 0.55, WALL_Z + 1.2))

    // Tiered rows of desks, each a step higher than the one in front.
    const random = seeded(3)
    const deskMat = matte(WHITE)
    const legMat = matte(GREY)
    const chairMat = matte(STEEL)
    const shirts = [matte('#ffffff'), matte('#eef0f2'), matte('#e2e5e9')]
    const skin = matte('#ecebe8')
    const plain = deskScreen(false)
    const marked = deskScreen(true)
    const torso = new THREE.CapsuleGeometry(0.24, 0.42, 4, 12)
    const head = new THREE.SphereGeometry(0.17, 20, 14)
    for (let row = 0; row < 4; row++) {
      const z = -6 + row * 4.4
      const floorY = row * 0.45
      const width = 22 + row * 3
      if (row > 0) scene.add(box(width + 4, floorY, 4.4, matte(PAPER), 0, floorY / 2, z + 0.6))
      scene.add(box(width, 0.07, 1.1, deskMat, 0, floorY + 0.78, z))
      scene.add(box(width, 0.7, 0.06, legMat, 0, floorY + 0.4, z - 0.5))
      const seats = Math.round(width / 2.6)
      for (let s = 0; s < seats; s++) {
        const x = -width / 2 + (s + 0.5) * (width / seats)
        for (const side of [-1, 1]) {
          const monitor = new THREE.Group()
          monitor.add(box(0.78, 0.48, 0.04, chairMat, 0, 0, 0))
          const face = new THREE.Mesh(
            new THREE.PlaneGeometry(0.72, 0.42),
            new THREE.MeshBasicMaterial({ map: random() < 0.25 ? marked : plain, toneMapped: false }),
          )
          face.position.z = 0.025
          monitor.add(face)
          monitor.position.set(x + side * 0.42, floorY + 1.15, z - 0.25)
          monitor.rotation.y = -side * 0.22
          scene.add(monitor)
        }
        if (random() < 0.15) continue
        const seatZ = z + 0.95
        scene.add(box(0.55, 0.08, 0.55, chairMat, x, floorY + 0.5, seatZ))
        scene.add(box(0.55, 0.62, 0.07, chairMat, x, floorY + 0.88, seatZ + 0.3))
        const body = new THREE.Mesh(torso, shirts[s % shirts.length])
        body.position.set(x, floorY + 0.98, seatZ - 0.05)
        body.rotation.x = -0.12
        body.castShadow = true
        scene.add(body)
        const face = new THREE.Mesh(head, skin)
        face.position.set(x + (random() - 0.5) * 0.08, floorY + 1.55, seatZ - 0.12)
        face.castShadow = true
        scene.add(face)
      }
    }
  }

  // The lower right panel: grey tracks of the last minutes and a red marker moving along one.
  private drawTimeline(ctx: CanvasRenderingContext2D, k: number) {
    ctx.fillStyle = '#f2f4f6'
    ctx.fillRect(0, 0, 768, 432)
    for (let i = 0; i < 7; i++) {
      const y = 60 + i * 50
      ctx.fillStyle = '#dde1e5'
      ctx.fillRect(60, y, 648, 6)
      ctx.fillStyle = '#c4c9cf'
      ctx.fillRect(60 + ((i * 97) % 300), y - 4, 90 + ((i * 53) % 120), 14)
    }
    const y = 60 + 3 * 50
    ctx.fillStyle = TARGET
    ctx.fillRect(60, y, 648 * k, 6)
    ctx.beginPath()
    ctx.arc(60 + 648 * k, y + 3, 11, 0, Math.PI * 2)
    ctx.fill()
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private loop = (now?: number) => {
    this.frame = requestAnimationFrame(this.loop)
    this.clock.update(now)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    if (STILL.matches && this.time > 0) return
    this.time += dt || 0.016
    const t = this.time
    this.city.update(dt || 0.016, t)

    const at = this.city.target.position
    const a = t * 0.05
    if (this.look.lengthSq() === 0) this.look.copy(at)
    this.look.lerp(at, 1 - Math.exp(-1.5 * dt))
    this.mainCam.position.set(this.look.x + Math.sin(a) * 24, 46, this.look.z + Math.cos(a) * 24)
    this.mainCam.lookAt(this.look)
    this.topCam.position.set(this.look.x, 120, this.look.z)
    this.topCam.lookAt(this.look.x, 0, this.look.z)

    const heading = this.city.heading
    const behind = new THREE.Vector3(-Math.sin(heading) * 6, 8, -Math.cos(heading) * 6).add(at)
    this.chaseCam.position.lerp(behind, 1 - Math.exp(-3 * dt))
    this.chaseLook.lerp(at, 1 - Math.exp(-6 * dt))
    this.chaseCam.lookAt(this.chaseLook)

    this.drawTimeline((this.timeline.image as HTMLCanvasElement).getContext('2d')!, (t * 0.04) % 1)
    this.timeline.needsUpdate = true

    this.camera.position.set(Math.sin(t * 0.07) * 2.2, 8.4, 20)
    this.camera.lookAt(0, 4.8, WALL_Z)

    const r = this.renderer
    for (const [target, cam] of [[this.mainTarget, this.mainCam], [this.chaseTarget, this.chaseCam], [this.topTarget, this.topCam]] as const) {
      r.setRenderTarget(target)
      r.render(this.city.scene, cam)
    }
    r.setRenderTarget(null)
    r.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.resize.disconnect()
    this.seen.disconnect()
    for (const scene of [this.scene, this.city.scene]) {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const material = object.material as THREE.MeshBasicMaterial
        material.map?.dispose()
        material.dispose()
      })
    }
    for (const target of [this.mainTarget, this.chaseTarget, this.topTarget]) target.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
