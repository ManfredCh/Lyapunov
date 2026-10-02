export type FleetPoint = readonly [number, number]
export interface FleetPathObstacle { id: string; center: FleetPoint; radiusM: number }
export interface FleetPathRequest {
  start: FleetPoint
  goal: FleetPoint
  bounds: { min: FleetPoint; max: FleetPoint }
  clearanceM: number
  /** Existing vehicles can legitimately be inside the larger planning band
   * when a changing carried-load envelope triggers a replan.  This endpoint
   * value permits an outward escape while all future cells keep clearanceM. */
  startClearanceM?: number
  obstacles: readonly FleetPathObstacle[]
  gridM?: number
}
export type FleetPathResult = { ok: true; points: FleetPoint[] } | { ok: false; reason: "start_blocked" | "goal_blocked" | "no_route"; message: string }

const key = (x: number, y: number) => `${x},${y}`

/** Point-to-segment distance; the executor judges a polyline segment by segment
 * (fleet-run.ts validatePath), so the planner must use exactly this measure too. */
function pointSegmentDistance(point: FleetPoint, start: FleetPoint, end: FleetPoint) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-12) return Math.hypot(point[0] - start[0], point[1] - start[1])
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared))
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dy * t))
}

/** Deterministic grid A* used by wheeled instances; all collision input is in world metres. */
export function planFleetPath(request: FleetPathRequest): FleetPathResult {
  const grid = request.gridM ?? 0.2
  if (!Number.isFinite(grid) || grid <= 0) throw new Error("gridM must be positive")
  const [minX, minY] = request.bounds.min
  const [maxX, maxY] = request.bounds.max
  const toCell = (p: FleetPoint) => [Math.round((p[0] - minX) / grid), Math.round((p[1] - minY) / grid)] as const
  const toPoint = (cell: readonly [number, number]): FleetPoint => [minX + cell[0] * grid, minY + cell[1] * grid]
  const maxCellX = Math.floor((maxX - minX) / grid)
  const maxCellY = Math.floor((maxY - minY) / grid)
  const pointBlocked = (point: FleetPoint, clearanceM = request.clearanceM) =>
    request.obstacles.some((o) => Math.hypot(point[0] - o.center[0], point[1] - o.center[1]) < o.radiusM + clearanceM)
  /** Whole-segment clearance with the same predicate as the executor: a pair of
   * clear nodes is not enough, because the straight chord between them can dip
   * inside the envelope (grid step L dips up to about L²/(8·(radius+clearance))). */
  const segmentClear = (from: FleetPoint, to: FleetPoint) =>
    request.obstacles.every((o) => pointSegmentDistance(o.center, from, to) >= o.radiusM + request.clearanceM)
  const inBounds = (cell: readonly [number, number]) => cell[0] >= 0 && cell[1] >= 0 && cell[0] <= maxCellX && cell[1] <= maxCellY
  if (pointBlocked(request.start, request.startClearanceM)) return { ok: false, reason: "start_blocked", message: "当前车辆位置处于禁入或占用区域，请先等待或人工移出该区域。" }
  if (pointBlocked(request.goal)) return { ok: false, reason: "goal_blocked", message: "目标位置被其他机器人、物体或禁入区占用，请等待、换目标或重新规划。" }
  /** 起点已在正常包络内的障碍：只有它们可能被 startClearanceM 放行；未阻塞起点的障碍一律不得借用逃逸豁免。 */
  const blockingStart = request.obstacles.filter((o) => Math.hypot(request.start[0] - o.center[0], request.start[1] - o.center[1]) < o.radiusM + request.clearanceM)
  /** startClearanceM 外逃只发生在「真实起点 → 起点格点」这一条连接段上，且必须整段向外：
   *  对每个阻塞起点的障碍，点到该障碍的距离沿连接段非减（最近点只能落在起点端），且整段不进入 radius+startClearanceM；
   *  未阻塞起点的障碍仍按正常净空整段判定。「终点更远」不等于整段向外——先朝障碍走再出来的连接段一律不接受。 */
  const connectionClear = (from: FleetPoint, to: FleetPoint) => request.obstacles.every((o) => {
    if (pointSegmentDistance(o.center, from, to) >= o.radiusM + request.clearanceM) return true
    if (!blockingStart.includes(o)) return false
    if (pointSegmentDistance(o.center, from, to) < o.radiusM + (request.startClearanceM ?? request.clearanceM)) return false
    const vx = to[0] - from[0], vy = to[1] - from[1]
    // 距离平方沿段可导且导数为线性函数：两端点非负即整段非负（距离非减 = 整段向外）。
    return (from[0] - o.center[0]) * vx + (from[1] - o.center[1]) * vy >= 0
      && (to[0] - o.center[0]) * vx + (to[1] - o.center[1]) * vy >= 0
  })
  /** 端点格点：格点自身必须未被占用，且真实端点 → 格点的整段连接满足净空（起点侧按上例外逃语义判定）。
   *  找不到可用格点时返回 undefined：绝不把明知不安全的取整格点放回兜底——宁可明确 no_route，也不返回非法成功。 */
  const cellFor = (endpoint: FleetPoint, clearanceOf: (from: FleetPoint, to: FleetPoint) => boolean): [number, number] | undefined => {
    const preferred: [number, number] = [...toCell(endpoint)]
    const usable = (cell: readonly [number, number]) => inBounds(cell) && !pointBlocked(toPoint(cell)) && clearanceOf(endpoint, toPoint(cell))
    if (usable(preferred)) return preferred
    let best: [number, number] | undefined, bestDistanceM = Infinity
    for (let dx = -3; dx <= 3; dx += 1) for (let dy = -3; dy <= 3; dy += 1) {
      const cell: [number, number] = [preferred[0] + dx, preferred[1] + dy]
      if (!usable(cell)) continue
      const candidate = toPoint(cell)
      const distanceM = Math.hypot(candidate[0] - endpoint[0], candidate[1] - endpoint[1])
      if (distanceM < bestDistanceM - 1e-9) { best = cell; bestDistanceM = distanceM }
    }
    return best
  }
  const start = cellFor(request.start, connectionClear), goal = cellFor(request.goal, segmentClear)
  if (!start || !goal) return { ok: false, reason: "no_route", message: "当前没有安全路径；车辆已停止，等待区域释放或重新规划。" }
  /** 起终点格点已保证自身净空：不再有任何“特殊格点”豁免，相邻扩展一律整段判据。 */
  const blocked = (cell: readonly [number, number]) => !inBounds(cell) || pointBlocked(toPoint(cell))
  const open = new Map<string, { cell: [number, number]; g: number; f: number }>()
  const came = new Map<string, string>()
  const cost = new Map<string, number>([[key(...start), 0]])
  open.set(key(...start), { cell: start, g: 0, f: Math.hypot(start[0] - goal[0], start[1] - goal[1]) })
  const steps: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  while (open.size) {
    const current = [...open.values()].sort((a, b) => a.f - b.f)[0]!
    const currentKey = key(...current.cell)
    open.delete(currentKey)
    if (currentKey === key(...goal)) {
      const path: FleetPoint[] = []
      let at: string | undefined = currentKey
      while (at) { const [x, y] = at.split(",").map(Number); path.push(toPoint([x!, y!])); at = came.get(at) }
      return { ok: true, points: path.reverse() }
    }
    for (const [dx, dy] of steps) {
      const next: [number, number] = [current.cell[0] + dx, current.cell[1] + dy]
      if (blocked(next)) continue
      // A diagonal must not cut through the corner of an occupied/no-go cell.
      if (dx !== 0 && dy !== 0 && (blocked([current.cell[0] + dx, current.cell[1]]) || blocked([current.cell[0], current.cell[1] + dy]))) continue
      // 每个网格步都必须整段净空：外逃只发生于起点连接段，网格内没有例外。
      if (!segmentClear(toPoint(current.cell), toPoint(next))) continue
      const nextKey = key(...next), g = current.g + Math.hypot(dx, dy)
      if (g >= (cost.get(nextKey) ?? Infinity)) continue
      came.set(nextKey, currentKey); cost.set(nextKey, g)
      open.set(nextKey, { cell: next, g, f: g + Math.hypot(next[0] - goal[0], next[1] - goal[1]) })
    }
  }
  return { ok: false, reason: "no_route", message: "当前没有安全路径；车辆已停止，等待区域释放或重新规划。" }
}
