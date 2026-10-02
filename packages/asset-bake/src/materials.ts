/**
 * What an object is MADE OF — one table, for how it looks and how it behaves.
 *
 * These two had drifted apart. The app carried a `MATERIAL_PRESETS` table that knew a ceramic
 * mug is glossy and a rubber ball is not, and it stopped there: metalness and roughness, pure
 * appearance. The physics came from somewhere else entirely — a single line of MJCF that gave
 * EVERY object in the world the same friction:
 *
 *     const GEOM_CONTACT = `contype="3" conaffinity="3" condim="4" friction="2.0 0.1 0.01"`
 *
 * A glass, a steel block and a rubber ball, all equally sticky. Mass was worse: a generated
 * object had none at all, and inherited whatever mass belonged to the pre-baked slot it
 * happened to land in.
 *
 * So one word — "ceramic" — now settles all three questions: how it renders, how much it
 * weighs, and how it slides. Adding a material is adding a row here, not a branch anywhere.
 *
 * Mass is NOT a per-object number. It is density × volume, and the volume comes from the mesh
 * (`measureShape`). That is why there is no "banana: 120 g" anywhere in this codebase and
 * never should be: a big banana is heavier than a small one, and the geometry already knows
 * which one it is.
 */

export interface MaterialProperties {
  /** Stable Chinese label shown in product/debug UI. */
  displayNameZh: string
  /** Coarse class used when matching generated objects to scene/robot contacts. */
  family:
    | "polymer"
    | "organic"
    | "rigid"
    | "metal"
    | "glass"
    | "rubber"
    | "fabric"
    | "paper"
    | "stone"
    | "air-dominated"
  /** kg/m³. With the mesh's volume this gives mass — no per-object weight table. */
  densityKgM3: number
  /**
   * MuJoCo's friction triple: sliding, torsional, rolling.
   *
   * Sliding is the one that decides whether a gripper holds an object or it squirts out. The
   * others are small and mostly keep a round object from spinning forever; MuJoCo's own
   * defaults for them are what these are based on.
   */
  friction: readonly [number, number, number]
  /** Elastic rebound. MuJoCo callers can map this to solref/solimp later; UI shows it now. */
  restitution: number
  /** Where the numeric physics values came from. */
  source: "engineering-reference" | "mujoco-default" | "robot-demo-tuned" | "project-default"
  /** Whether the row is measured, converted from another simulator, or only a start point. */
  confidence: "high" | "medium" | "low"
  /** Human-facing caveat so users know whether this is real data or a calibration seed. */
  noteZh: string
  /** Renderer PBR. Kept here so "ceramic" cannot mean one thing to physics and another to the
   *  camera — the drift this table exists to end. */
  metalness: number
  roughness: number
}

/**
 * Densities are the real ones; friction is the sliding coefficient against a typical dry
 * surface. Neither is tuned to make any particular demo work.
 *
 * `foam` and `fabric` matter more than they look: a plush toy modelled at plastic's density
 * would weigh several kilos and behave like a brick in a gripper.
 */
export const MATERIALS = {
  plastic: {
    displayNameZh: "塑料",
    family: "polymer",
    densityKgM3: 1050,
    friction: [0.7, 0.02, 0.005],
    restitution: 0.12,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "工程资料范围内的干燥塑料默认值，需按接触面校准。",
    metalness: 0.0,
    roughness: 0.45,
  },
  wood: {
    displayNameZh: "木头",
    family: "organic",
    densityKgM3: 650,
    friction: [0.6, 0.02, 0.005],
    restitution: 0.08,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "普通干燥木质桌面/物体的起始值。",
    metalness: 0.0,
    roughness: 0.78,
  },
  metal: {
    displayNameZh: "金属",
    family: "metal",
    densityKgM3: 2700,
    friction: [0.5, 0.02, 0.005],
    restitution: 0.18,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "普通金属干接触起始值，真实值受表面处理影响很大。",
    metalness: 0.85,
    roughness: 0.28,
  },
  steel: {
    displayNameZh: "钢",
    family: "metal",
    densityKgM3: 7850,
    friction: [0.5, 0.02, 0.005],
    restitution: 0.18,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "钢材密度较可靠，摩擦仍需看接触对象。",
    metalness: 0.9,
    roughness: 0.32,
  },
  ceramic: {
    displayNameZh: "陶瓷",
    family: "rigid",
    densityKgM3: 2400,
    friction: [0.7, 0.02, 0.005],
    restitution: 0.1,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "杯子、碗等陶瓷物体默认值。",
    metalness: 0.0,
    roughness: 0.18,
  },
  glass: {
    displayNameZh: "玻璃",
    family: "glass",
    densityKgM3: 2500,
    friction: [0.4, 0.01, 0.002],
    restitution: 0.2,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "玻璃表面偏滑，真实值受清洁度和涂层影响明显。",
    metalness: 0.1,
    roughness: 0.12,
  },
  rubber: {
    displayNameZh: "橡胶",
    family: "rubber",
    densityKgM3: 1200,
    friction: [1.2, 0.05, 0.01],
    restitution: 0.35,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "夹爪、轮胎、防滑垫常用起始值。",
    metalness: 0.0,
    roughness: 0.92,
  },
  /** Plush toys, cushions, sponges. Very light — this is the one that keeps a teddy bear from
   *  weighing as much as a brick. */
  foam: {
    displayNameZh: "泡棉",
    family: "fabric",
    densityKgM3: 60,
    friction: [0.9, 0.03, 0.008],
    restitution: 0.05,
    source: "engineering-reference",
    confidence: "low",
    noteZh: "轻质软物体兜底值，软体仿真前只能近似为刚体。",
    metalness: 0.0,
    roughness: 0.95,
  },
  fabric: {
    displayNameZh: "布料",
    family: "fabric",
    densityKgM3: 300,
    friction: [0.8, 0.03, 0.008],
    restitution: 0.04,
    source: "engineering-reference",
    confidence: "low",
    noteZh: "布面/毛绒玩具近似值，真实接触会受形变影响。",
    metalness: 0.0,
    roughness: 0.88,
  },
  leather: {
    displayNameZh: "皮革",
    family: "fabric",
    densityKgM3: 900,
    friction: [0.8, 0.03, 0.008],
    restitution: 0.08,
    source: "engineering-reference",
    confidence: "low",
    noteZh: "皮革/仿皮默认值，需按表面纹理校准。",
    metalness: 0.0,
    roughness: 0.72,
  },
  cardboard: {
    displayNameZh: "纸板",
    family: "paper",
    densityKgM3: 200,
    friction: [0.6, 0.02, 0.005],
    restitution: 0.05,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "纸箱、包装盒默认值。",
    metalness: 0.0,
    roughness: 0.85,
  },
  stone: {
    displayNameZh: "石材",
    family: "stone",
    densityKgM3: 2700,
    friction: [0.8, 0.03, 0.008],
    restitution: 0.08,
    source: "engineering-reference",
    confidence: "medium",
    noteZh: "石材/瓷砖类硬质表面的起始值。",
    metalness: 0.0,
    roughness: 0.8,
  },
  /** Fruit, vegetables, bread. Mostly water, so a shade under 1000. */
  food: {
    displayNameZh: "食物表皮",
    family: "organic",
    densityKgM3: 950,
    friction: [0.7, 0.02, 0.005],
    restitution: 0.08,
    source: "engineering-reference",
    confidence: "low",
    noteZh: "水果/面包等食物近似值，表面水分会让真实摩擦变化很大。",
    metalness: 0.05,
    roughness: 0.5,
  },
  /** Hollow packaging and empty containers — dominated by air, not by their walls. */
  hollow: {
    displayNameZh: "空心轻质物",
    family: "air-dominated",
    densityKgM3: 120,
    friction: [0.6, 0.02, 0.005],
    restitution: 0.1,
    source: "project-default",
    confidence: "low",
    noteZh: "空容器/轻包装兜底值，质量主要由外形体积和空腔决定。",
    metalness: 0.0,
    roughness: 0.6,
  },
} as const satisfies Record<string, MaterialProperties>

export type MaterialName = keyof typeof MATERIALS

/**
 * When nobody says. Plastic is the least wrong guess for a manufactured object, and a caller
 * that took this default is recorded as having done so — an estimated mass must never pass
 * itself off as a measured one.
 */
export const DEFAULT_MATERIAL: MaterialName = "plastic"

export const MATERIAL_NAMES = Object.keys(MATERIALS) as MaterialName[]

export function isMaterialName(value: unknown): value is MaterialName {
  // 只认自有键：`value in MATERIALS` 会沿原型链命中原型属性（constructor/toString/__proto__…），
  // 让 materialProperties 返回函数对象、密度 undefined、质量 NaN，落盘成 null。material 是
  // Tool 的自由字符串，未知串按既有语义回退 DEFAULT_MATERIAL。
  return typeof value === "string" && Object.hasOwn(MATERIALS, value)
}

export function materialProperties(name: string | undefined): MaterialProperties {
  return isMaterialName(name) ? MATERIALS[name] : MATERIALS[DEFAULT_MATERIAL]
}

export function materialDisplayNameZh(name: string | undefined): string {
  return materialProperties(name).displayNameZh
}

export function frictionTripleFromSliding(sliding: number): [number, number, number] {
  const value = Number.isFinite(sliding) ? Math.max(0, sliding) : materialProperties(undefined).friction[0]
  return [value, Math.max(0.001, value * 0.05), Math.max(0.0001, value * 0.005)]
}

export type ContactProfileSource = "material-combine" | "contact-override"

export interface ContactProfile {
  friction: readonly [number, number, number]
  source: ContactProfileSource
  noteZh: string
}

const CONTACT_OVERRIDES: Record<string, ContactProfile> = {
  "rubber:food": {
    friction: [1.6, 0.08, 0.012],
    source: "contact-override",
    noteZh: "橡胶夹爪抓水果/食物时的项目校准起点。",
  },
  "rubber:plastic": {
    friction: [1.4, 0.07, 0.01],
    source: "contact-override",
    noteZh: "橡胶夹爪抓塑料方块时的项目校准起点。",
  },
  "rubber:ceramic": {
    friction: [1.3, 0.06, 0.01],
    source: "contact-override",
    noteZh: "橡胶夹爪抓杯子/碗等硬质器物时的项目校准起点。",
  },
}

function contactKey(left: MaterialName, right: MaterialName): string {
  return [left, right].sort().join(":")
}

export function contactProfile(left: string | undefined, right: string | undefined): ContactProfile {
  const a = isMaterialName(left) ? left : DEFAULT_MATERIAL
  const b = isMaterialName(right) ? right : DEFAULT_MATERIAL
  const override = CONTACT_OVERRIDES[contactKey(a, b)]
  if (override) return override
  const fa = MATERIALS[a].friction
  const fb = MATERIALS[b].friction
  return {
    friction: [
      Math.sqrt(fa[0] * fb[0]),
      Math.sqrt(fa[1] * fb[1]),
      Math.sqrt(fa[2] * fb[2]),
    ] as const,
    source: "material-combine",
    noteZh: "未命中特殊接触对，使用两个材质默认摩擦的几何平均值。",
  }
}

/** Below this an object is dust and MuJoCo's solver struggles; above it, nothing a robot in
 *  this simulator is going to pick up. Not a guess at any object — a guard against a volume
 *  or density that came out nonsense. */
export const MIN_OBJECT_MASS_KG = 0.001
export const MAX_OBJECT_MASS_KG = 100

/**
 * mass = density × volume, clamped to something a solver can integrate.
 *
 * The clamp is a real event, not a formality: a hollow generated shell can measure a volume
 * near zero, and a zero-mass free body makes MuJoCo's contact solver produce infinities. The
 * caller is told when it happened rather than silently handed a plausible number.
 */
export function massFromVolume(
  volumeM3: number,
  material: string | undefined,
): { massKg: number; densityKgM3: number; clamped: boolean } {
  const { densityKgM3 } = materialProperties(material)
  const raw = volumeM3 * densityKgM3
  const massKg = Math.min(MAX_OBJECT_MASS_KG, Math.max(MIN_OBJECT_MASS_KG, raw))
  return { massKg, densityKgM3, clamped: massKg !== raw }
}
