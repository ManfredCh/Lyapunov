/**
 * 3D convex hull (quickhull) and closed-mesh volume. Pure maths, no dependencies.
 *
 * This exists because a generated mesh arrives as a shell — a few hundred thousand triangles
 * describing a surface, with no notion of what is solid. A physics engine cannot use that:
 * MuJoCo collides mesh geoms as their CONVEX HULL, so the hull is not an approximation we
 * choose, it is what the engine is going to use whether we compute it or not. Computing it
 * ourselves buys three things the engine will not give us:
 *
 *   - a SMALL collider. The raw mesh is tens of megabytes; its hull is a few dozen vertices.
 *     Every model recompile re-writes every mesh into the WASM filesystem, so this matters.
 *   - the hull's VOLUME, which is half of the concavity measure.
 *   - the mesh's own volume, which gives mass = density × volume instead of a guessed number.
 *
 * And concavity is the whole point of measuring rather than naming. A convex hull is a
 * truthful collider for a banana and a lie for a bowl — shrink-wrap a bowl and you seal its
 * mouth, so nothing can ever be placed in it. Which of those an object is cannot be read off
 * its name; it can be read off `1 - meshVolume / hullVolume`.
 *
 * It lives in `core` rather than in the app because both sides need it: the generator to
 * physicalize an asset, and the runtime to check what it was handed. `three` ships a convex
 * hull, but only the app depends on `three`, and dragging a rendering engine into the asset
 * pipeline to borrow one class is not a trade worth making.
 */

export interface Vec3Like {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface HullMesh {
  /** Hull corners, flat xyz. */
  readonly vertices: Float64Array
  /** Triangles, 3 vertex indices each. Wound counter-clockwise seen from OUTSIDE. */
  readonly faces: Uint32Array
  /** Which input point each hull vertex came from. Lets a caller carry data through. */
  readonly sourceIndices: Uint32Array
}

/** Below this, two points are the same point and a volume is nothing. */
const EPS = 1e-9

const sub = (p: Float64Array, a: number, b: number): [number, number, number] => [
  p[a * 3] - p[b * 3],
  p[a * 3 + 1] - p[b * 3 + 1],
  p[a * 3 + 2] - p[b * 3 + 2],
]

const cross = (u: readonly number[], v: readonly number[]): [number, number, number] => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
]

const dot = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
const norm = (u: readonly number[]) => Math.hypot(u[0], u[1], u[2])

interface Face {
  /** Vertex indices into the point cloud, wound CCW from outside. */
  a: number
  b: number
  c: number
  /** Outward unit normal. */
  n: [number, number, number]
  /** Signed plane offset: a point p is outside when dot(n, p) - d > tolerance. */
  d: number
  /** Points still outside this face, and the furthest of them. */
  outside: number[]
  dead: boolean
}

function makeFace(points: Float64Array, a: number, b: number, c: number, interior: readonly number[]): Face {
  const n = cross(sub(points, b, a), sub(points, c, a))
  const len = norm(n)
  const unit: [number, number, number] = len > EPS ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0]
  let d = unit[0] * points[a * 3] + unit[1] * points[a * 3 + 1] + unit[2] * points[a * 3 + 2]
  // Orient outward: the hull's interior point must be BEHIND every face.
  if (dot(unit, interior) - d > 0) {
    unit[0] = -unit[0]
    unit[1] = -unit[1]
    unit[2] = -unit[2]
    d = -d
    const t = b
    b = c
    c = t
  }
  return { a, b, c, n: unit, d, outside: [], dead: false }
}

const distanceToFace = (points: Float64Array, f: Face, i: number) =>
  f.n[0] * points[i * 3] + f.n[1] * points[i * 3 + 1] + f.n[2] * points[i * 3 + 2] - f.d

/**
 * Convex hull of a point cloud.
 *
 * Returns `undefined` when the points do not enclose a volume at all — every point equal,
 * collinear, or coplanar. That is a real answer, not a failure to be papered over: a flat
 * or empty point set has no hull, and a caller that pretends otherwise ends up dividing by
 * a zero volume further down.
 */
export function convexHull(points: Float64Array, tolerance?: number): HullMesh | undefined {
  const count = Math.floor(points.length / 3)
  if (count < 4) return undefined

  // Scale the tolerance to the cloud: an absolute epsilon means something different for a
  // 2 cm die and a 2 m table.
  let extent = 0
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < count; i++) {
      const v = points[i * 3 + axis]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    extent = Math.max(extent, hi - lo)
  }
  if (!(extent > 0)) return undefined
  const tol = tolerance ?? extent * 1e-7

  // --- initial tetrahedron: two extremes, then the furthest from that line, then the plane
  let minX = 0
  let maxX = 0
  for (let i = 1; i < count; i++) {
    if (points[i * 3] < points[minX * 3]) minX = i
    if (points[i * 3] > points[maxX * 3]) maxX = i
  }
  if (minX === maxX) return undefined

  let third = -1
  let bestArea = tol
  for (let i = 0; i < count; i++) {
    const area = norm(cross(sub(points, maxX, minX), sub(points, i, minX)))
    if (area > bestArea) {
      bestArea = area
      third = i
    }
  }
  if (third < 0) return undefined // all points on one line

  const base = cross(sub(points, maxX, minX), sub(points, third, minX))
  const baseLen = norm(base)
  const baseUnit = [base[0] / baseLen, base[1] / baseLen, base[2] / baseLen]
  let fourth = -1
  let bestHeight = tol
  for (let i = 0; i < count; i++) {
    const h = Math.abs(dot(baseUnit, sub(points, i, minX)))
    if (h > bestHeight) {
      bestHeight = h
      fourth = i
    }
  }
  if (fourth < 0) return undefined // every point is coplanar

  const seeds = [minX, maxX, third, fourth]
  const interior: [number, number, number] = [0, 0, 0]
  for (const s of seeds) {
    interior[0] += points[s * 3] / 4
    interior[1] += points[s * 3 + 1] / 4
    interior[2] += points[s * 3 + 2] / 4
  }

  let faces: Face[] = [
    makeFace(points, seeds[0], seeds[1], seeds[2], interior),
    makeFace(points, seeds[0], seeds[1], seeds[3], interior),
    makeFace(points, seeds[0], seeds[2], seeds[3], interior),
    makeFace(points, seeds[1], seeds[2], seeds[3], interior),
  ]

  // Each point is claimed by ONE face it lies outside of — that is what makes this quickhull
  // rather than an O(n²) incremental hull: a point interior to the current hull is dropped
  // immediately and never looked at again, and a scanned mesh is almost all interior points.
  const assign = (candidates: readonly number[], into: readonly Face[]) => {
    for (const p of candidates) {
      let best: Face | undefined
      let bestDist = tol
      for (const f of into) {
        const dist = distanceToFace(points, f, p)
        if (dist > bestDist) {
          bestDist = dist
          best = f
        }
      }
      best?.outside.push(p)
    }
  }
  assign(
    Array.from({ length: count }, (_, i) => i),
    faces,
  )

  // --- grow: repeatedly absorb the point furthest outside the hull
  const stack = faces.filter((f) => f.outside.length > 0)
  let guard = count * 6 + 64 // a hull cannot need more rounds than this; see below
  while (stack.length > 0) {
    if (guard-- <= 0) break
    const face = stack.pop()!
    if (face.dead || face.outside.length === 0) continue

    let apex = face.outside[0]
    let apexDist = distanceToFace(points, face, apex)
    for (const p of face.outside) {
      const dist = distanceToFace(points, face, p)
      if (dist > apexDist) {
        apexDist = dist
        apex = p
      }
    }

    // Everything the apex can see comes off the hull; the boundary of that region is the
    // horizon, and the new faces are a cone from the apex back to it.
    const visible: Face[] = []
    for (const f of faces) {
      if (!f.dead && distanceToFace(points, f, apex) > tol) visible.push(f)
    }
    if (visible.length === 0) {
      face.outside = []
      continue
    }

    const edgeCount = new Map<string, [number, number]>()
    for (const f of visible) {
      f.dead = true
      for (const [u, v] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as const) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`
        // An edge shared by two visible faces is interior to the hole, not on its rim.
        if (edgeCount.has(key)) edgeCount.delete(key)
        else edgeCount.set(key, [u, v])
      }
    }

    const orphans: number[] = []
    for (const f of visible) orphans.push(...f.outside)

    const fresh: Face[] = []
    for (const [u, v] of edgeCount.values()) {
      const f = makeFace(points, u, v, apex, interior)
      if (norm(f.n) > 0) fresh.push(f)
    }
    if (fresh.length === 0) continue

    faces = faces.filter((f) => !f.dead)
    faces.push(...fresh)
    assign(
      orphans.filter((p) => p !== apex),
      fresh,
    )
    for (const f of fresh) if (f.outside.length > 0) stack.push(f)
  }

  // --- compact: keep only the vertices the hull actually uses
  const alive = faces.filter((f) => !f.dead)
  if (alive.length < 4) return undefined

  const remap = new Map<number, number>()
  const verts: number[] = []
  const tris: number[] = []
  const sources: number[] = []
  for (const f of alive) {
    for (const idx of [f.a, f.b, f.c]) {
      let mapped = remap.get(idx)
      if (mapped === undefined) {
        mapped = verts.length / 3
        remap.set(idx, mapped)
        verts.push(points[idx * 3], points[idx * 3 + 1], points[idx * 3 + 2])
        sources.push(idx)
      }
      tris.push(mapped)
    }
  }
  return {
    vertices: new Float64Array(verts),
    faces: new Uint32Array(tris),
    sourceIndices: new Uint32Array(sources),
  }
}

/** `n` directions spread evenly over the sphere (Fibonacci lattice). */
function sphereDirections(n: number): Float64Array {
  const out = new Float64Array(n * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const theta = golden * i
    out[i * 3] = r * Math.cos(theta)
    out[i * 3 + 1] = r * Math.sin(theta)
    out[i * 3 + 2] = z
  }
  return out
}

/** Solve a 3×3 system by Cramer's rule. `undefined` when the planes do not meet in a point. */
function solve3(m: readonly number[], rhs: readonly number[]): [number, number, number] | undefined {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  if (Math.abs(det) < 1e-12) return undefined
  const d = (a: number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
  const x = d([rhs[0], m[1], m[2], rhs[1], m[4], m[5], rhs[2], m[7], m[8]]) / det
  const y = d([m[0], rhs[0], m[2], m[3], rhs[1], m[5], m[6], rhs[2], m[8]]) / det
  const z = d([m[0], m[1], rhs[0], m[3], m[4], rhs[1], m[6], m[7], rhs[2]]) / det
  return [x, y, z]
}

/**
 * A convex hull with a bounded face count, that provably CONTAINS every input point.
 *
 * The exact hull of a scanned mesh is unusable as a collider. Its shape is right, but a
 * generated surface is noisy and every micron-high bump on it becomes a hull corner: the real
 * chair below measured 4,649 hull vertices and a plush toy 22,009. The colliders a working
 * physicalizer produced for those same objects have 64–66 vertices per convex piece. Two
 * orders of magnitude apart, and MuJoCo pays for every one of them on every contact.
 *
 * Naively decimating the hull is how you get a collider SMALLER than the object it stands
 * for, and a collider that is even slightly small is worse than a crude one: the object's tip
 * passes through the floor, the gripper closes past its surface. So this does not decimate.
 * It samples the shape's SUPPORT FUNCTION in `faceBudget` directions — for each direction,
 * how far out does the object reach — and intersects those tangent half-planes.
 *
 * Every one of those planes touches the object and none cuts into it, so the result contains
 * the object BY CONSTRUCTION, not by hope. It is slightly larger than the true hull, and
 * larger is the safe direction to be wrong in.
 *
 * The intersection is computed through the polar dual: a supporting plane of the shape is a
 * point of the dual body, so hulling the dual points and reading its faces back gives the
 * primal polytope's corners. Which means the only hull actually computed is one over
 * `faceBudget` points — a few dozen — rather than over a third of a million.
 */
export function outerHull(points: Float64Array, faceBudget = 64): HullMesh | undefined {
  const count = Math.floor(points.length / 3)
  if (count < 4 || faceBudget < 4) return undefined

  // The dual needs an interior origin; the cloud's centroid is inside its hull by definition.
  const c = [0, 0, 0]
  for (let i = 0; i < count; i++) {
    c[0] += points[i * 3] / count
    c[1] += points[i * 3 + 1] / count
    c[2] += points[i * 3 + 2] / count
  }

  const dirs = sphereDirections(faceBudget)
  const support = new Float64Array(faceBudget)
  for (let k = 0; k < faceBudget; k++) {
    const dx = dirs[k * 3]
    const dy = dirs[k * 3 + 1]
    const dz = dirs[k * 3 + 2]
    let best = -Infinity
    for (let i = 0; i < count; i++) {
      const p = dx * (points[i * 3] - c[0]) + dy * (points[i * 3 + 1] - c[1]) + dz * (points[i * 3 + 2] - c[2])
      if (p > best) best = p
    }
    // A non-positive support means the centroid is not strictly inside along this direction —
    // the cloud is flat. It has no volume and no collider.
    if (!(best > EPS)) return undefined
    support[k] = best
  }

  const dual = new Float64Array(faceBudget * 3)
  for (let k = 0; k < faceBudget; k++) {
    dual[k * 3] = dirs[k * 3] / support[k]
    dual[k * 3 + 1] = dirs[k * 3 + 1] / support[k]
    dual[k * 3 + 2] = dirs[k * 3 + 2] / support[k]
  }
  const dualHull = convexHull(dual)
  if (!dualHull) return undefined

  // Each face of the dual is three supporting planes meeting at one corner of the primal.
  const corners: number[] = []
  for (let f = 0; f < dualHull.faces.length; f += 3) {
    const k = [
      dualHull.sourceIndices[dualHull.faces[f]],
      dualHull.sourceIndices[dualHull.faces[f + 1]],
      dualHull.sourceIndices[dualHull.faces[f + 2]],
    ]
    const m = [
      dirs[k[0] * 3], dirs[k[0] * 3 + 1], dirs[k[0] * 3 + 2],
      dirs[k[1] * 3], dirs[k[1] * 3 + 1], dirs[k[1] * 3 + 2],
      dirs[k[2] * 3], dirs[k[2] * 3 + 1], dirs[k[2] * 3 + 2],
    ]
    const v = solve3(m, [support[k[0]], support[k[1]], support[k[2]]])
    if (v) corners.push(v[0] + c[0], v[1] + c[1], v[2] + c[2])
  }
  if (corners.length < 12) return undefined

  return convexHull(new Float64Array(corners))
}

/**
 * Volume enclosed by a closed triangle mesh, via the signed-tetrahedron sum.
 *
 * Each triangle forms a tetrahedron with the origin; sum their signed volumes and the parts
 * outside the solid cancel exactly. Absolute value, so a mesh wound inwards still reports a
 * positive volume — generated meshes are not reliably wound, and a negative mass is a worse
 * failure than an unnoticed flipped normal.
 *
 * A mesh with holes gives a meaningless number. That is inherent to the question, not to
 * this implementation: "how much space does this surface enclose" has no answer if it does
 * not enclose anything.
 */
export function meshVolume(vertices: Float64Array, faces: Uint32Array): number {
  let total = 0
  for (let i = 0; i + 2 < faces.length; i += 3) {
    const a = faces[i] * 3
    const b = faces[i + 1] * 3
    const c = faces[i + 2] * 3
    total +=
      vertices[a] * (vertices[b + 1] * vertices[c + 2] - vertices[b + 2] * vertices[c + 1]) -
      vertices[a + 1] * (vertices[b] * vertices[c + 2] - vertices[b + 2] * vertices[c]) +
      vertices[a + 2] * (vertices[b] * vertices[c + 1] - vertices[b + 1] * vertices[c])
  }
  return Math.abs(total) / 6
}

/**
 * Collapse surface noise by snapping points onto a grid and dropping duplicates.
 *
 * ONLY for measuring, never for the collider. Snapping can nudge a point inwards by up to
 * half a cell, so a hull built on the snapped cloud may sit a hair inside the real surface —
 * harmless when all you want from it is a volume, unacceptable in something a robot is going
 * to collide with. The collider comes from `outerHull`, which never moves a point at all.
 *
 * What it buys is enormous: on a real 283k-vertex plush toy the exact hull of the raw cloud
 * took 19 seconds and had 22,009 vertices, almost all of them micron-high bumps in the scan.
 * Snapped first, the same hull takes 150 ms and its volume is within 2%.
 */
function snapToGrid(points: Float64Array, cell: number): Float64Array {
  const seen = new Set<string>()
  const out: number[] = []
  for (let i = 0; i < points.length; i += 3) {
    const a = Math.round(points[i] / cell)
    const b = Math.round(points[i + 1] / cell)
    const c = Math.round(points[i + 2] / cell)
    const key = `${a},${b},${c}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a * cell, b * cell, c * cell)
  }
  return new Float64Array(out)
}

export interface ShapeMeasure {
  /** Volume the mesh itself encloses (m³). Drives mass = density × volume. */
  meshVolumeM3: number
  /** Volume of the true convex hull (m³) — the shrink-wrap. Always ≥ the mesh's own. */
  convexVolumeM3: number
  /**
   * `1 - meshVolume / convexVolume`. 0 = already convex, so the hull IS the shape. Approaching
   * 1 = mostly empty space inside the wrap, so the hull is a solid block where the object has
   * a hollow — a bowl you cannot put anything into, a chair with no gap under the seat.
   *
   * Measured, not named. A bowl-shaped sculpture and an actual bowl get the same answer, and
   * an object nobody thought of gets a real one instead of falling off a keyword table.
   */
  concavity: number
  /** The collider: bounded face count, and it contains the mesh by construction. Its volume
   *  is deliberately a little larger than `convexVolumeM3` — see `outerHull`. */
  hull: HullMesh
}

/** Enough faces to be a recognisable shape, few enough for MuJoCo to collide cheaply. The
 *  working physicalizer whose output survives in `tools/fixtures/object-physics` produced
 *  64–66 vertices per convex piece; a 64-plane outer hull lands in the same place. */
export const DEFAULT_HULL_FACE_BUDGET = 64

/** Grid fineness for the measuring hull, as a fraction of the object's longest side. Fine
 *  enough that the volume lands within ~1%, coarse enough to erase the scan's noise. */
const MEASURE_GRID_DIVISIONS = 512

/**
 * Measure a mesh: how much space it encloses, how far its convex hull is from that, and a
 * hull that can actually be used as a collider.
 *
 * Two hulls, because one hull cannot do both jobs. The concavity needs an ACCURATE convex
 * volume, and the collider needs a SAFE and SMALL one. Trying to serve both from a single
 * hull means either a collider with twenty thousand vertices, or a concavity computed against
 * a shape 40% too big — which would report a perfectly convex banana as concave.
 *
 * `undefined` when the mesh has no volume to speak of (flat, degenerate, empty). Callers must
 * treat that as "this cannot be physicalized", not as "assume zero".
 */
export function measureShape(
  vertices: Float64Array,
  faces: Uint32Array,
  faceBudget = DEFAULT_HULL_FACE_BUDGET,
): ShapeMeasure | undefined {
  // The collider: never moves a point, so it provably contains the object.
  const hull = outerHull(vertices, faceBudget)
  if (!hull) return undefined

  let extent = 0
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity
    let hi = -Infinity
    for (let i = axis; i < vertices.length; i += 3) {
      if (vertices[i] < lo) lo = vertices[i]
      if (vertices[i] > hi) hi = vertices[i]
    }
    extent = Math.max(extent, hi - lo)
  }
  if (!(extent > 0)) return undefined

  // The measure: accurate convex volume, off a de-noised cloud.
  const measured = convexHull(snapToGrid(vertices, extent / MEASURE_GRID_DIVISIONS))
  if (!measured) return undefined
  const convexVolumeM3 = meshVolume(measured.vertices, measured.faces)
  if (!(convexVolumeM3 > 0)) return undefined

  const meshVolumeM3 = meshVolume(vertices, faces)
  // A mesh volume above its own hull's is numerically impossible; if it happens the mesh is
  // self-intersecting or badly wound and the ratio means nothing. Clamp rather than report a
  // negative concavity, which would read as "more convex than convex".
  const ratio = Math.min(1, meshVolumeM3 / convexVolumeM3)
  return { meshVolumeM3, convexVolumeM3, concavity: 1 - ratio, hull }
}
