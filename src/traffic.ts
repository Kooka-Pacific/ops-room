// Traffic on a real street network: cars keep to the left lane, follow the car ahead with
// the Intelligent Driver Model and cross junctions one approach at a time. Signalled
// junctions hold a green for several seconds, the others let each approach go in turn for
// a moment. The next approach goes only once the junction is empty, so no two cars ever
// share the same piece of road.

// A junction (x, z, 1 when it has traffic signals) and a directed street from junction a
// to b along a line of points, 1 when two-way; two-way streets have one entry each way.
export type Network = {
  nodes: [number, number, number][]
  edges: [number, number, [number, number][], number][]
}

type V = { x: number; z: number }

// Car length and the lane's offset to the left of the street's centre line, in world units.
// One-way streets keep left too, so streets the map draws on top of each other stay a lane
// apart.
const CAR = 0.95
const LANE = 0.4
// How far before a junction's centre the stop line sits at least and at most, the step it
// moves back by where lanes meet at a sharp angle, how far apart two lanes must be there, the
// trim at a plain bend, and the shortest lane left between two stop lines.
const STOP = 1.4
const STOP_MAX = 6
const STOP_STEP = 0.25
const APART = 0.73
const PASS = 0.2
const MIN_LANE = 1.2
// The driver model: standstill gap, time headway, comfortable acceleration and braking.
const S0 = 0.45
const HEADWAY = 0.9
const ACCEL = 2.2
const BRAKE = 3
// The speed through a corner, and how quickly a driver slows towards it per unit of road.
const TURN_SPEED = 1.4
const TURN_EASE = 0.8
// Greens at signals and at plain junctions, and the least time all approaches stay red.
const SIGNAL_GREEN = 6
const YIELD_GREEN = 2.5
const CLEAR = 1
const STEP = 1 / 60

type Turn = { to: Edge; p0: V; p1: V; p2: V; len: number; cum: number[]; straight: boolean }

// A line of points with its running length, so a distance along it gives a point.
class Path {
  readonly pts: V[]
  readonly cum: number[] = [0]

  constructor(pts: V[]) {
    this.pts = pts
    for (let k = 1; k < pts.length; k++) this.cum.push(this.cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z))
  }

  get length() {
    return this.cum[this.cum.length - 1]
  }

  private segment(s: number) {
    let k = 1
    while (k < this.pts.length - 1 && this.cum[k] < s) k++
    return k
  }

  at(s: number): V {
    const k = this.segment(s)
    const a = this.pts[k - 1]
    const b = this.pts[k]
    const u = Math.min(1, Math.max(0, (s - this.cum[k - 1]) / (this.cum[k] - this.cum[k - 1])))
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }
  }

  dir(s: number): V {
    const k = this.segment(s)
    const a = this.pts[k - 1]
    const b = this.pts[k]
    const d = Math.hypot(b.x - a.x, b.z - a.z)
    return { x: (b.x - a.x) / d, z: (b.z - a.z) / d }
  }
}

// The line moved to the left of the direction of travel, keeping its distance at the bends.
function offsetLeft(pts: V[], by: number): V[] {
  const normal = (a: V, b: V) => {
    const d = Math.hypot(b.x - a.x, b.z - a.z)
    return { x: (b.z - a.z) / d, z: -(b.x - a.x) / d }
  }
  return pts.map((p, k) => {
    const n0 = normal(pts[Math.max(0, k - 1)], pts[Math.max(1, k)])
    const n1 = normal(pts[Math.min(k, pts.length - 2)], pts[Math.min(k + 1, pts.length - 1)])
    const mx = n0.x + n1.x
    const mz = n0.z + n1.z
    const m = Math.hypot(mx, mz)
    // The mitre: the averaged normal, lengthened by how sharply the line turns here.
    const k2 = m > 1e-6 ? by / Math.max(0.5, (mx * n0.x + mz * n0.z) / m) / m : 0
    return { x: p.x + mx * k2, z: p.z + mz * k2 }
  })
}

class Edge {
  readonly cars: Car[] = []
  readonly path: Path
  readonly from: Node
  readonly to: Node
  // Where the lane begins and ends along its path, between the two stop lines.
  begin = 0
  len = 0

  constructor(from: Node, to: Node, pts: V[]) {
    this.from = from
    this.to = to
    this.path = new Path(offsetLeft(pts, LANE))
  }

  // Cuts the lane between the stop lines of its two junctions.
  cut() {
    const full = this.path.length
    let head = this.from.stop
    let tail = this.to.stop
    if (full - head - tail < MIN_LANE) {
      const k = Math.max(0, full - MIN_LANE) / (head + tail)
      head *= k
      tail *= k
    }
    this.begin = head
    this.len = full - head - tail
  }

  at(s: number) {
    return this.path.at(this.begin + s)
  }

  dir(s: number) {
    return this.path.dir(this.begin + s)
  }

  // The lowest position taken on this lane, or its full length when it is empty.
  get room() {
    let low = this.len
    for (const car of this.cars) low = Math.min(low, car.s)
    return low
  }
}

class Node {
  readonly incoming: Edge[] = []
  readonly outgoing: Edge[] = []
  readonly turning: Car[] = []
  readonly pos: V
  readonly signal: boolean
  // A junction where no two approaches can meet needs no control.
  free = false
  stop = STOP
  phase = 0
  green = true
  timer: number
  greenFor: number

  constructor(pos: V, signal: boolean, random: () => number) {
    this.pos = pos
    this.signal = signal
    this.greenFor = signal ? SIGNAL_GREEN + random() * 3 : YIELD_GREEN
    this.timer = random() * this.greenFor
  }

  // Whether a car on this lane may cross now: the junction is free, the car's approach has
  // the green, or the car was too close to stop when the green ended.
  open(car: Car) {
    return this.free || car.committed || (this.green && this.incoming[this.phase] === car.edge)
  }
}

export class Car {
  edge: Edge
  plan: Turn
  turn: Turn | null = null
  s: number
  v = 0
  committed = false
  x = 0
  z = 0
  heading = 0
  // A car with a home keeps within the radius of it, counted along the streets.
  home: { at: V; radius: number } | null = null
  readonly v0: number

  constructor(edge: Edge, s: number, v0: number, plan: Turn) {
    this.edge = edge
    this.s = s
    this.v0 = v0
    this.plan = plan
  }
}

function quad(p0: V, p1: V, p2: V, k: number): V {
  const u = 1 - k
  return { x: u * u * p0.x + 2 * u * k * p1.x + k * k * p2.x, z: u * u * p0.z + 2 * u * k * p1.z + k * k * p2.z }
}

const bezier = (t: Turn, k: number) => quad(t.p0, t.p1, t.p2, k)

// The streets a car may take after this one: any but back the way it came, unless that is
// the only way on. On a divided road the way back is the other carriageway, so it counts by
// direction as well as by street.
function onward(edge: Edge) {
  const d0 = edge.path.dir(edge.path.length)
  const ways = edge.to.outgoing.filter((e) => {
    const d2 = e.path.dir(0)
    return e.to !== edge.from && d0.x * d2.x + d0.z * d2.z > -0.8
  })
  return ways.length ? ways : edge.to.outgoing
}

// The middle control point of the curve from the end of one lane to the start of the next.
function bend(p0: V, d0: V, p2: V, d2: V): V {
  const cross = d0.x * d2.z - d0.z * d2.x
  const dot = d0.x * d2.x + d0.z * d2.z
  const mid = { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 }
  // Turning back at a dead end swings out past the end of the street.
  if (dot < -0.8) return { x: mid.x + d0.x * 1.4, z: mid.z + d0.z * 1.4 }
  if (Math.abs(cross) <= 0.2) return mid
  // A corner bends around the point where the two lanes would meet.
  const u = ((p2.x - p0.x) * d2.z - (p2.z - p0.z) * d2.x) / cross
  return u > 0 && u < 6 ? { x: p0.x + d0.x * u, z: p0.z + d0.z * u } : mid
}

// Points along a car standing at a stop line, or just leaving a junction, from its front
// back to the third car in the queue.
const SPOTS = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((k) => k * CAR)
const apart = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z) >= APART
const laneEnd = (e: Edge, d: number) => e.path.at(e.path.length - d)
const laneStart = (e: Edge, d: number) => e.path.at(d)

// Whether, with stop lines this far from the centre, the queues on every pair of lanes at
// the junction are clear of each other. A lane in and a lane out may be left out of it.
function lanesClear(node: Node, stop: number, inAndOut: boolean) {
  const ends = [
    ...node.incoming.map((e) => ({ into: true, at: (d: number) => laneEnd(e, d) })),
    ...node.outgoing.map((e) => ({ into: false, at: (d: number) => laneStart(e, d) })),
  ]
  return ends.every((f, i) =>
    ends.every((g, j) => {
      if (j <= i || (!inAndOut && f.into !== g.into)) return true
      return SPOTS.every((u) => SPOTS.every((w) => apart(f.at(stop + u), g.at(stop + w))))
    }),
  )
}

// Whether every way across the junction keeps clear of the queues on the other lanes in.
function crossingsClear(node: Node, stop: number) {
  for (const e of node.incoming) {
    for (const to of onward(e)) {
      const p0 = laneEnd(e, stop)
      const p2 = laneStart(to, stop)
      const p1 = bend(p0, e.path.dir(e.path.length - stop), p2, to.path.dir(stop))
      for (let k = 1; k < 8; k++) {
        const p = quad(p0, p1, p2, k / 8)
        for (const o of node.incoming) if (o !== e && !SPOTS.every((u) => apart(p, laneEnd(o, stop + u)))) return false
      }
    }
  }
  return true
}

// How far back from the centre a junction's stop lines sit. At a plain bend a lane in runs
// on into its lane out, so only the lanes that pass each other count there.
function stopLine(node: Node) {
  const clear = (stop: number) => (node.free ? lanesClear(node, stop, false) : lanesClear(node, stop, true) && crossingsClear(node, stop))
  let stop = node.free ? PASS : STOP
  while (stop < STOP_MAX && !clear(stop)) stop += STOP_STEP
  return stop
}

const SAMPLES = 16

export class Traffic {
  readonly cars: Car[] = []
  private readonly nodes: Node[]
  private readonly random: () => number
  private readonly routes = new Map<object, Map<Node, number>>()

  constructor(network: Network, count: number, random: () => number) {
    this.random = random
    this.nodes = network.nodes.map(([x, z, signal]) => new Node({ x, z }, signal === 1, random))
    // Which junctions need control is known from the streets alone, before any lane is cut.
    const links = network.edges.map(([a, b]) => ({ from: this.nodes[a], to: this.nodes[b] }))
    for (const node of this.nodes) {
      // Free: one way in, or a plain bend of a street where each way in has its own way on.
      const into = links.filter((l) => l.to === node)
      const ways = into.map((l) => links.filter((o) => o.from === node && o.to !== l.from).map((o) => o.to))
      const exits = ways.flat()
      const near = new Set([...into.map((l) => l.from), ...exits])
      node.free = into.length <= 1 || (near.size <= 2 && ways.every((w) => w.length === 1) && new Set(exits).size === exits.length)
    }
    for (const [a, b, pts] of network.edges) {
      const edge = new Edge(this.nodes[a], this.nodes[b], pts.map(([x, z]) => ({ x, z })))
      edge.from.outgoing.push(edge)
      edge.to.incoming.push(edge)
    }
    // A bend that turns a car by more than a right angle, or so sharp that a car arriving and
    // a car leaving would touch, is a junction too.
    const hairpin = (node: Node) =>
      node.incoming.some((e) => onward(e).some((to) => {
        const d0 = e.path.dir(e.path.length)
        const d2 = to.path.dir(0)
        return d0.x * d2.x + d0.z * d2.z < 0
      }))
    for (const node of this.nodes) if (node.free && (hairpin(node) || !lanesClear(node, STOP, true))) node.free = false
    for (const node of this.nodes) node.stop = stopLine(node)
    for (const node of this.nodes) for (const edge of node.outgoing) edge.cut()
    const edges = this.nodes.flatMap((x) => x.outgoing)
    const total = edges.reduce((sum, e) => sum + e.len, 0)
    let tries = 0
    while (this.cars.length < count && tries++ < count * 50) {
      let pick = this.random() * total
      let edge = edges[0]
      for (const e of edges) {
        edge = e
        pick -= e.len
        if (pick <= 0) break
      }
      if (edge.len < CAR * 2) continue
      const s = CAR / 2 + random() * (edge.len - CAR)
      if (edge.cars.some((c) => Math.abs(c.s - s) < CAR + S0 * 2)) continue
      const car = new Car(edge, s, 2.4 + random() * 0.9, this.planFrom(edge))
      edge.cars.push(car)
      this.cars.push(car)
    }
    this.place()
  }

  // The next street after this one, and the curve across the junction that leads into it.
  private planFrom(edge: Edge, home: Car['home'] = null): Turn {
    const ways = onward(edge)
    // A car with a home picks among the streets that lead no farther from it than the radius,
    // counted along the streets, and takes the shortest way back when none does.
    const left = home && this.routeHome(home)
    const near = left ? ways.filter((e) => left.get(e.to)! <= home!.radius) : ways
    let to = near[Math.floor(this.random() * near.length)]
    if (left && !near.length) to = ways.reduce((best, e) => (e.len + left.get(e.to)! < best.len + left.get(best.to)! ? e : best))
    const p0 = edge.at(edge.len)
    const p2 = to.at(0)
    const d0 = edge.dir(edge.len)
    const d2 = to.dir(0)
    const straight = d0.x * d2.x + d0.z * d2.z > 0.9
    const turn: Turn = { to, p0, p1: bend(p0, d0, p2, d2), p2, len: 0, cum: [0], straight }
    let last = p0
    for (let k = 1; k <= SAMPLES; k++) {
      const p = bezier(turn, k / SAMPLES)
      turn.cum.push(turn.cum[k - 1] + Math.hypot(p.x - last.x, p.z - last.z))
      last = p
    }
    turn.len = Math.max(turn.cum[SAMPLES], 0.01)
    return turn
  }

  // How far each junction is from a home by the streets, for the shortest way back.
  private routeHome(home: NonNullable<Car['home']>) {
    const known = this.routes.get(home)
    if (known) return known
    const goal = this.nodes.reduce((best, n) =>
      Math.hypot(n.pos.x - home.at.x, n.pos.z - home.at.z) < Math.hypot(best.pos.x - home.at.x, best.pos.z - home.at.z) ? n : best,
    )
    const left = new Map<Node, number>(this.nodes.map((n) => [n, Infinity]))
    left.set(goal, 0)
    const open = new Set(this.nodes)
    while (open.size) {
      let node = goal
      let low = Infinity
      for (const n of open) if (left.get(n)! <= low) [node, low] = [n, left.get(n)!]
      open.delete(node)
      for (const e of node.incoming) left.set(e.from, Math.min(left.get(e.from)!, low + e.len))
    }
    this.routes.set(home, left)
    return left
  }

  // Whether the street after the junction has room for one more car, counting the cars
  // already on their way into it.
  private hasRoom(car: Car) {
    const to = car.plan.to
    const entering = car.edge.to.turning.filter((c) => c.turn!.to === to).length
    // A street shorter than a car and its gap takes one car at a time.
    return to.room - entering * (CAR + S0) >= Math.min(CAR + S0, to.len)
  }

  private canGo(car: Car) {
    return car.edge.to.open(car) && this.hasRoom(car)
  }

  // The gap to whatever is ahead, from the car's front to its back, and its speed.
  private leader(car: Car): { gap: number; v: number } {
    let gap = Infinity
    let v = 0
    const take = (g: number, speed: number) => {
      if (g < gap) {
        gap = g
        v = speed
      }
    }
    const node = car.edge.to
    if (car.turn) {
      const turn = car.turn
      for (const o of node.turning) if (o !== car && o.edge === car.edge && o.s > car.s) take(o.s - car.s - CAR, o.v)
      for (const o of turn.to.cars) take(turn.len - car.s + o.s - CAR, o.v)
      return { gap, v }
    }
    for (const o of car.edge.cars) if (o !== car && o.s > car.s) take(o.s - car.s - CAR, o.v)
    const rest = car.edge.len - car.s
    if (!this.canGo(car)) {
      take(rest - CAR / 2, 0)
      return { gap, v }
    }
    for (const o of node.turning) if (o.edge === car.edge) take(rest + o.s - CAR, o.v)
    for (const o of car.plan.to.cars) take(rest + car.plan.len + o.s - CAR, o.v)
    return { gap, v }
  }

  private desired(car: Car) {
    if (car.turn) return car.turn.straight ? car.v0 : TURN_SPEED
    if (car.plan.straight) return car.v0
    return Math.min(car.v0, TURN_SPEED + (car.edge.len - car.s) * TURN_EASE)
  }

  private lights(h: number) {
    for (const node of this.nodes) {
      if (node.free) continue
      node.timer += h
      const lanes = node.incoming
      if (node.green) {
        if (node.timer < node.greenFor) continue
        node.green = false
        node.timer = 0
        // Drivers too close to stop when the green ends keep going.
        for (const car of lanes[node.phase].cars) {
          if ((car.v * car.v) / (2 * BRAKE) > car.edge.len - car.s - CAR / 2) car.committed = true
        }
        continue
      }
      // A driver who went on at the change but had to stop for a full street gives way.
      const committed = lanes[node.phase].cars.some((c) => c.committed && c.v > 0.05)
      if (node.timer < CLEAR || node.turning.length > 0 || committed) continue
      // The next approach with a car on it; when all are empty the junction moves on anyway.
      let k = 1
      while (k < lanes.length && lanes[(node.phase + k) % lanes.length].cars.length === 0) k++
      for (const car of lanes[node.phase].cars) car.committed = false
      node.phase = (node.phase + (k < lanes.length ? k : 1)) % lanes.length
      node.green = true
      node.timer = 0
    }
  }

  private step(h: number) {
    this.lights(h)
    const moves = this.cars.map((car) => {
      const { gap, v } = this.leader(car)
      const v0 = this.desired(car)
      const wish = S0 + car.v * HEADWAY + (car.v * (car.v - v)) / (2 * Math.sqrt(ACCEL * BRAKE))
      const a = ACCEL * (1 - (car.v / v0) ** 4 - (Math.max(wish, 0) / Math.max(gap, 0.01)) ** 2)
      return { car, gap, a: Math.max(a, -9) }
    })
    for (const { car, gap, a } of moves) {
      car.v = Math.max(0, car.v + a * h)
      let ds = car.v * h
      // Never into the car ahead, whatever the model says.
      if (ds > gap - 0.02) {
        ds = Math.max(0, gap - 0.02)
        car.v = ds / h
      }
      car.s += ds
      this.advance(car)
    }
  }

  private advance(car: Car) {
    if (!car.turn && car.s >= car.edge.len) {
      const lane = car.edge.cars
      lane.splice(lane.indexOf(car), 1)
      car.s -= car.edge.len
      car.turn = car.plan
      car.committed = false
      car.edge.to.turning.push(car)
    }
    if (car.turn && car.s >= car.turn.len) {
      const turning = car.edge.to.turning
      turning.splice(turning.indexOf(car), 1)
      car.s -= car.turn.len
      car.edge = car.turn.to
      car.turn = null
      car.edge.cars.push(car)
      car.plan = this.planFrom(car.edge, car.home)
    }
  }

  private place() {
    for (const car of this.cars) {
      if (!car.turn) {
        const p = car.edge.at(car.s)
        const d = car.edge.dir(car.s)
        car.x = p.x
        car.z = p.z
        car.heading = Math.atan2(d.x, d.z)
        continue
      }
      const { cum } = car.turn
      let k = 1
      while (k < SAMPLES && cum[k] < car.s) k++
      const t = (k - 1 + Math.min(1, (car.s - cum[k - 1]) / Math.max(cum[k] - cum[k - 1], 1e-6))) / SAMPLES
      const a = bezier(car.turn, Math.max(0, t - 0.01))
      const b = bezier(car.turn, Math.min(1, t + 0.01))
      const p = bezier(car.turn, t)
      car.x = p.x
      car.z = p.z
      if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-4) car.heading = Math.atan2(b.x - a.x, b.z - a.z)
    }
  }

  update(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / STEP))
    for (let k = 0; k < steps; k++) this.step(dt / steps)
    this.place()
  }
}
