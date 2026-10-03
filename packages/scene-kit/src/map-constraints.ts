/**
 * 公开经纬度数据 → 局部米制约束（ENV-41/42/43 的程序侧薄片）。
 *
 * 只做一件事：把调用方**已明确声明来源 CRS** 的 GeoJSON（点/线/多边形）按给定**局部锚点**
 * 换算成右手 ENU 局部米制坐标（x=东、y=北、z=上，与场景的米制 Z-up 一致），并同时保留：
 *   · 可逆的原坐标（每个顶点的来源坐标原样返回，另导出反向换算函数）；
 *   · 真实范围与单位；
 *   · 用真实数据实测的局部帧畸变（不是抄公式口号）。
 *
 * 数值引擎：投影、基准与大地线**全部交给系统 PROJ**（proj-cli.ts：cct 执行 projinfo 所报运算的管线本身 / geod），
 * 本文件不做级数展开、不做基准变换、不做大地线迭代；PROJ 缺失或失败一律报错
 * （`MAP_PROJ_UNAVAILABLE` / `MAP_PROJ_FAILED`），不静默退回自造算法或换一套精度口径。
 *
 * 本文件**不做**：地点/年代消歧、地图服务、第二状态库、任何写入。
 *   · 地点与年代由原生 web 检索与模型判断（见 skills/environment-research），坐标换算不等于事实消歧；
 *   · 缺高度的要素不带假高度：第三位序数默认按 `unknown` 处理（GeoJSON 未定义其含义，USGS 的第三位是震源深度而非建筑高度），
 *     `heightProperty` 只**照抄**来源里的真实数值，本工具不生成任何高度；
 *   · 年代未确认时不会自动声称"与目标年代对应"：结果里 eraMatch 恒为 `not-asserted`，只回显调用方声明。
 *
 * CRS 支持面（**必须显式给出，缺省一律拒绝，绝不默认当 4326**）：
 *   · EPSG:4326 / OGC:CRS84 / WGS84（经纬度：GeoJSON 约定 x=经度 y=纬度；本工具不做基准变换）；
 *   · EPSG:4490 / CGCS2000（经纬度：同样按 GeoJSON 约定读，但**基准关系由 PROJ 决定**——
 *     PROJ 对该对 CRS 只给 ballpark/noop、精度 unknown，所以默认策略下**直接拒绝**，
 *     不会静默当成"和 WGS84 一样"；确实要接受时调用方显式传 datumPolicy="allow-ballpark"）；
 *   · EPSG:3857 / EPSG:900913（Web 墨卡托，交 PROJ 反投影回 WGS84 后再进局部帧）；
 *   · EPSG:326zz / EPSG:327zz（WGS84 UTM 北/南半球带，交 PROJ 反投影）；
 *   · 其它一切 CRS（EPSG:2056 LV95、EPSG:27700、EPSG:4214 北京54、EPSG:4547 CGCS2000 高斯带 …）
 *     明确拒绝并给出可执行动作（先用 pyproj/QGIS/官方转换工具转到 4326/3857/UTM 再传入），
 *     不让"看不懂的坐标"被静默当成经纬度。
 *
 * 单位与畸变口径：局部帧单位恒为米；畸变来自**本批数据实测**（局部帧水平距离 vs PROJ `geod`
 * 的 WGS84 椭球大地线距离）；源 CRS 自身的口径另记（UTM 的比例因子实测：中央经线 0.9996（−0.04%）、
 * 带边缘约 1.00098（+0.098%），不是"最大 0.04%"）。
 *
 * 投影 / 基准（datum）/ 历元（epoch）/ 垂直基准是四件事，本文件把它们分开报告：
 *   · 投影：cct 执行 PROJ 为这对 CRS 选定的运算管线（反向 = 同一条管线的 cct -I，正反严格互逆）；
 *   · 基准：`projinfo -s <来源> -t EPSG:4326` 的原话进 `projection.datumOperation`（种类/精度/适用范围/
 *     缺不缺格网/是否动态框架）；PROJ 说不可靠（ballpark、精度 unknown、缺格网、动态框架）时按 datumPolicy
 *     决定：默认 require-exact → `MAP_DATUM_UNAVAILABLE`（附可执行动作），allow-ballpark → 数值照算但精度如实标；
 *   · 历元：本工具不接观测历元、不做板块运动归算，结果里明说；
 *   · 垂直基准：不做大地水准面归算、不把椭球高当海拔（见 projection.verticalDatum）。
 */
import type { Context } from "@deepseek-ai/cordis"
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import {
  datumOperation, geodesicDistancesM, projVersion, transformCoordinates, WGS84_PROJ, wgs84ToEnu, enuToWgs84,
  type DatumOperation, type ProjEnu, type ProjPair, type ProjPoint, type ProjProcessRunner, type ProjRunOptions,
} from "./proj-cli.ts"

/** 一次换算允许的默认顶点数（超出请先按范围裁剪）；硬上限兜底，避免模型无意间要求整省数据。 */
export const MAP_CONSTRAINTS_DEFAULT_MAX_VERTICES = 20000
export const MAP_CONSTRAINTS_HARD_MAX_VERTICES = 200000
/** 畸变采样上限：实测统计按等距抽样，不影响返回的坐标（大地线批量走一次 `geod`）。 */
const DISTORTION_SAMPLE_LIMIT = 4000
/** 数据离锚点超过这个水平距离时给出"局部帧畸变已显著"的警告（米）。 */
const FAR_EXTENT_WARNING_M = 100000
/** UTM 数据偏离声明带中央经线超过这个角度时警告（度）：说明带号很可能选错。 */
const UTM_ZONE_WARNING_DEG = 6

export type MapCrsKind = "geographic" | "web-mercator" | "utm"

/** 已解析的来源 CRS 声明：kind 决定坐标怎么读，notes 说明本工具的读法与已知口径。 */
export interface MapSourceCrs {
  /** 调用方原本声明的字符串（原样保留，便于回执与复核）。 */
  declared: string
  /** 规范化后的 EPSG 代码（如 EPSG:4326 / EPSG:3857 / EPSG:32633）。 */
  epsg: string
  kind: MapCrsKind
  /** 来源坐标单位（换算前）。 */
  units: "degree" | "meter"
  /** 该来源 CRS 的 PROJ 记号（用于探测运算；实际换算按 projinfo 给出的管线执行，恒按 经度/东距 传统序进出）。 */
  proj: string
  /** UTM 带号与半球（仅 kind=utm）。 */
  zone?: number
  hemisphere?: "north" | "south"
  /** 该 CRS 与 WGS84 的关系与已知口径（写给模型看的事实说明，不是结论）。 */
  notes: string[]
}

const CRS_ACTION = "可采取的动作：先用 pyproj/QGIS/来源站点自带的转换把数据转成 EPSG:4326（经纬度）、EPSG:3857 或对应 UTM 带（EPSG:326zz/327zz）再传入；本工具不会把未知 CRS 当成经纬度。"

/**
 * 解析并校验调用方声明的来源 CRS。缺声明或不受支持一律抛错（带可执行动作），不猜、不默认。
 * 只接受一小组读法明确的 CRS：经纬度、Web 墨卡托、WGS84 UTM；其余明确拒绝。
 * 换算本身全部交给 PROJ（`proj` 字段是这对 CRS 的说明记号，实际执行的管线由 projinfo 给出、cct 执行）。
 */
export function parseSourceCrs(declared: unknown): MapSourceCrs {
  if (typeof declared !== "string" || !declared.trim()) {
    throw new Error(`MAP_CRS_REQUIRED: 必须显式给出来源数据的 CRS（例如 crs=\"EPSG:4326\"）。省略不会默认成 4326——经纬度与投影坐标、不同基准的坐标读法完全不同。${CRS_ACTION}`)
  }
  const text = declared.trim()
  const normalized = text.toLowerCase().replace(/^urn:ogc:def:crs:/, "").replace(/^urn:ogc:def:crs:epsg::/, "epsg:")
  const urnEpsg = /^urn:ogc:def:crs:epsg::(\d{4,5})$/.exec(text.toLowerCase())
  if (["epsg:4326", "wgs84", "ogc:crs84", "crs84", "urn:ogc:def:crs:ogc:1.3:crs84", "epsg:4490", "cgcs2000"].includes(normalized) || (urnEpsg && urnEpsg[1] === "4326")) {
    const epsg = normalized.includes("4490") || normalized.includes("cgcs2000") ? "EPSG:4490" : "EPSG:4326"
    return {
      declared: text, epsg, kind: "geographic", units: "degree",
      proj: epsg === "EPSG:4490" ? "+init=epsg:4490" : WGS84_PROJ,
      notes: [
        "按 GeoJSON 约定读坐标：x=经度、y=纬度（EPSG:4326 权威轴序是纬度-经度，本工具按 GeoJSON 的经度-纬度读，与本仓其它经纬度数据一致）。",
        ...(epsg === "EPSG:4490"
          ? ["空间基准：本工具不做基准变换。EPSG:4490 与 WGS84 之间的运算由 PROJ 决定——`projinfo -s EPSG:4490 -t EPSG:4326` 给的是「Ballpark geographic offset … unknown accuracy」（PROJ 字符串 +proj=noop），所以默认策略下这类换算会被 **MAP_DATUM_UNAVAILABLE** 拒绝；本次能算出结果是因为调用方显式传了 datumPolicy=\"allow-ballpark\"。本工具**不声称** CGCS2000 与 WGS84 在空间基准上等价，更不声称毫米级一致：真实基准归算请先自行用带精度的转换做好并注明来源。"]
          : []),
        "经度可用 ±180 之外的取值表示跨换日线的连续坐标（如 181 等价 -179），换算按最短路径处理。",
      ],
    }
  }
  if (["epsg:3857", "epsg:900913", "webmercator", "epsg:3785"].includes(normalized)) {
    return {
      declared: text, epsg: "EPSG:3857", kind: "web-mercator", units: "meter", proj: "+init=epsg:3857",
      notes: [
        "Web 墨卡托交 PROJ 反投影回 WGS84（球形公式，半径=WGS84 长半轴）；其网格米不是地面米（比例因子 1/cosφ），本工具的局部米制来自反投影后的真实椭球几何。",
        "有效纬度范围约 ±85.0511°；超出该范围的 y 值不是合法 Web 墨卡托坐标（PROJ 会拒绝或给出非有限值）。",
      ],
    }
  }
  const utm = /^epsg:(32[67])(\d{2})$/.exec(normalized)
  if (utm) {
    const zone = Number(utm[2])
    if (zone < 1 || zone > 60) throw new Error(`MAP_CRS_UNSUPPORTED: UTM 带号 ${zone} 不在 1..60。${CRS_ACTION}`)
    const hemisphere = utm[1] === "326" ? "north" as const : "south" as const
    return {
      declared: text, epsg: `EPSG:${utm[1]}${utm[2]}`, kind: "utm", units: "meter", proj: `+init=epsg:${utm[1]}${utm[2]}`, zone, hemisphere,
      notes: [
        `WGS84 UTM ${zone}${hemisphere === "north" ? "N" : "S"} 带：中央经线 ${zone * 6 - 183}°，比例因子 k0=0.9996，假东 500000 m${hemisphere === "south" ? "，假北 10000000 m（南半球）" : ""}；交 PROJ 反投影。`,
        `网格米 ≠ 地面米——比例因子随离中央经线的距离增大：中央经线 k=0.9996（−0.04%），带边缘（±3°）k≈1.00098（**+0.098%**）。实测（PROJ 8.2.1）：printf '6 0\\n9 0\\n12 0\\n' | proj -S +proj=utm +zone=32 +ellps=WGS84 → 带边 1.00098、中央 0.9996。本工具的局部米制来自反投影后的椭球几何，不受该比例影响。`,
      ],
    }
  }
  throw new Error(`MAP_CRS_UNSUPPORTED: 不支持的来源 CRS「${text}」。本工具只支持 EPSG:4326/OGC:CRS84/EPSG:4490（经纬度）、EPSG:3857（Web 墨卡托）、EPSG:326zz/327zz（WGS84 UTM）这几种读法明确的声明（换算本身由 PROJ 做，但轴序/单位/垂直含义的读法必须由本工具明确固定，不猜）。${CRS_ACTION}例如：先用 cs2cs +init=epsg:2056 +to +init=epsg:4326 把坐标转好再传入。`)
}

/**
 * 基准运算的策略：`require-exact`（默认）只接受 PROJ 给出**可信精度**的运算；
 * `allow-ballpark` 明确接受 ballpark / unknown 精度 / 缺格网的运算，结果里把精度如实标成 PROJ 自报的值。
 * 两者都不改变数值路径——变的只是"这种运算能不能被当成换算依据"。
 */
export type DatumPolicy = "require-exact" | "allow-ballpark"

export interface DatumAssessment {
  /** PROJ 对被探测 CRS 对的实际运算（事实，原样进结果）。 */
  operation: DatumOperation
  policy: DatumPolicy
  /** 这段运算"不可靠"的具体点；空数组表示 PROJ 给出了带精度的运算。 */
  concerns: string[]
  /** 允许继续时应一并写进结果 warnings 的话（默认策略下为空）。 */
  warnings: string[]
}

const DATUM_KIND_TEXT: Record<DatumOperation["kind"], string> = {
  noop: "无基准变换（PROJ 给出的运算是 noop / Null geographic offset）",
  projection: "只做投影正反算（同一基准，不含基准变换）",
  datum: "参数化基准变换（三/七参数或椭球转换）",
  grid: "格网（grid shift）基准变换",
  unknown: "管线里有本层不认识的步骤，种类照实标 unknown",
}

/** 把 PROJ 的运算事实写成一句可读的话（结果里的 datumTransform）。 */
export function describeDatumOperation(operation: DatumOperation, policy: DatumPolicy): string {
  const selected = operation.candidates.length > 1 ? `；PROJ 共列 ${operation.candidates.length} 个候选，本次运算用的是第 ${operation.selectedCandidate} 个` : ""
  const flag = operation.ballpark ? "；PROJ 标了 has ballpark transformation" : ""
  return `来源 CRS → EPSG:4326 的实际运算（projinfo）：${DATUM_KIND_TEXT[operation.kind]}；PROJ 自报精度「${operation.accuracy}」，适用范围「${operation.area || "未给出"}」${flag}${selected}。本结果里的坐标就是由这条运算的管线（标准 cct 执行，反向用同一条管线的 -I）算出的，不是另跑一条等价命令——管线原文见 datumOperation.projString。策略 ${policy}：${policy === "allow-ballpark" ? "调用方明确接受可能不精确的运算，数值照算但精度不得被说成比上面这行更好" : "只接受带可信精度的运算，不可靠的运算会拒绝而不是静默给出数值"}。`
}

/**
 * 问 PROJ 这对 CRS 之间**实际**成立什么运算，并按策略决定能不能做。
 * 这里拿到的 operation 会一路传到数值路径：projection 用 cct 执行的正是它自报的那条管线。
 *
 * 为什么必须这样拦：PROJ 的 `cs2cs` 在 ballpark / 缺格网的情况下**照常退出 0 并返回一套数值**
 * （本机实测：缺 OSTN15 格网时 `cs2cs +init=epsg:27700 +to +init=epsg:4326` 照常给出经纬度），
 * 静默用下去就等于把 unknown 精度当成精确。默认策略因此明确拒绝，并给出可执行动作。
 * 判据只看**选中并被执行的这条运算**：别的候选缺不缺格网不影响一条本机可用、且已按 PROJ 优先级选中的运算
 * （任务 92 实测：EPSG:27700 的首选是 OSGB36→WGS84 (6) 的 2 m 七参数，不需要 OSTN15 格网）。
 */
export async function assessDatumOperation(crs: MapSourceCrs, policy: DatumPolicy, context: MapProjContext = {}): Promise<DatumAssessment> {
  const operation = await resolveOperation(crs, context)
  const concerns: string[] = []
  if (operation.candidateCount === 0) concerns.push("PROJ 没有给出任何候选运算，无法说明这套坐标与 WGS84 的关系")
  if (operation.ballpark) concerns.push("PROJ 把选中的运算标为 ballpark（has ballpark transformation）：没有真实的基准归算")
  // 只报**选中这条**缺的格网。它缺格网时 cct 执行会直接失败（实测：exit 1 + "Error 1029 (File not found or invalid)"），
  // 也就是说 require-exact 的判据由实际执行路线自己证明，不是本层对候选名的猜测。
  if (operation.missingGrids.length) concerns.push(`选中的运算需要的格网本机缺失：${operation.missingGrids.map(grid => grid.name).join("、")}（cct 执行这条管线会直接失败，不会静默改用别的运算）`)
  if (/unknown/i.test(operation.accuracy)) concerns.push(`PROJ 自报精度为「${operation.accuracy}」`)
  if (operation.dynamicFrame) concerns.push("来源/目标里有带 FRAMEEPOCH 的动态参考框架（基准随观测历元变化）")
  if (operation.timeDependent) concerns.push("运算管线含时间相关参数（+t_epoch / +rate_* / +proj=deformation）")
  if (!operation.usable) concerns.push("选中的运算在本机不可用（usable=false：管线要的格网没装在系统里）")
  if (concerns.length && policy === "require-exact") {
    const grids = operation.missingGrids.map(grid => `${grid.name}${grid.url ? `（PROJ 给的官方地址 ${grid.url}）` : ""}`).join("、")
    const actions = [
      ...operation.missingGrids.length ? [`把格网装到本机后重试（${grids}；放进 PROJ 的数据目录，路径见 projinfo --searchpaths，或设 PROJ_DATA/PROJ_NETWORK=ON）`] : [],
      "先用 pyproj/QGIS/来源站点自带的带精度转换做基准归算，转成 EPSG:4326（经纬度）、EPSG:3857 或对应 UTM 带再传入",
      `确实只能接受这套数值时，显式传 datumPolicy="allow-ballpark"——结果里会把精度标成「${operation.accuracy}」并带上 PROJ 的原话，不得据此声称精确`,
    ]
    throw new Error(
      `MAP_DATUM_UNAVAILABLE: 声明的来源 CRS「${crs.declared}」到 EPSG:4326 之间，本机 PROJ（${await projVersion(runOptions(context))}）实际给出的运算是「${operation.description}」——精度「${operation.accuracy}」，适用范围「${operation.area || "未给出"}」${operation.ballpark ? "，PROJ 标了 has ballpark transformation" : ""}${operation.missingGrids.length ? `，且缺格网 ${grids}` : ""}。问题在于：${concerns.join("；")}。PROJ 的 cs2cs 在这种情况下**仍会退出 0 并给出一套数值**（本机实测：缺 OSTN15 格网时 cs2cs +init=epsg:27700 +to +init=epsg:4326 照常返回经纬度），所以「算得出数」不能当成「这个换算成立」；默认策略 datumPolicy="require-exact" 因此拒绝，而不是把精度 unknown 的数值当精确坐标交出去。`
      + ` 可采取的动作：${actions.map((action, index) => `${"①②③④"[index] ?? `(${index + 1})`} ${action}`).join("；")}。这段运算不是本工具的判断，可自行复核：projinfo -s ${crs.epsg} -t EPSG:4326 --spatial-test intersects --grid-check discard_missing（首条即本次实际执行的运算）。`,
    )
  }
  const warnings = concerns.length
    ? [`基准运算不可靠（调用方以 datumPolicy="allow-ballpark" 明确接受）：${concerns.join("；")}。PROJ 对这段换算的原话是「${operation.description}」，本结果里的坐标按该运算算出，精度至多是「${operation.accuracy}」——不得把它当成与 WGS84 精确一致的坐标，也不得据此声称比 PROJ 自报精度更好（复核命令：projinfo -s ${crs.epsg} -t EPSG:4326 --spatial-test intersects --grid-check discard_missing）。`]
    : []
  return { operation, policy, concerns, warnings }
}

export interface Geodetic { lon: number; lat: number; h: number }
/** 局部右手 ENU 坐标：east=东、north=北、up=上（米）。 */
export type LocalEnu = [number, number, number]

/**
 * 一次换算的上下文：取消信号 + 子进程执行器 + **已探测到的实际运算**。
 *
 * 为什么把运算对象一路传下来：`projinfo` 报的那条运算就是数值要执行的那条（proj-cli 用 cct 执行它本身），
 * 所以整批换算只问 PROJ 一次、正反向共用同一个 operation（反向 = 同一条管线的 cct -I），
 * 报告的运算与算出数值的运算因此是同一个东西，不存在"报告一条、执行另一条"。
 * 不传 operation 时各函数会自己问一次 PROJ（单点/独立调用的便利路径，代价是多一次 projinfo）。
 */
export interface MapProjContext {
  signal?: AbortSignal
  /** 宿主自定义的 PROJ 子进程执行器（省略则用 proj-cli 的默认异步实现）。 */
  runner?: ProjProcessRunner
  /** 来源 CRS → EPSG:4326 的实际运算（正反向共用；见 datumOperation）。 */
  operation?: DatumOperation
}

/** 取来源 CRS → EPSG:4326 的实际运算：调用方给了就用，没给就现问一次 PROJ。 */
async function resolveOperation(crs: MapSourceCrs, context: MapProjContext): Promise<DatumOperation> {
  return context.operation ?? await datumOperation(crs.epsg, "EPSG:4326", runOptions(context))
}

function runOptions(context: MapProjContext): ProjRunOptions {
  return { signal: context.signal, runner: context.runner }
}

/**
 * 批量：来源 CRS 坐标 → WGS84 大地坐标（换算由 PROJ 执行**所报告的那条运算管线**；
 * 经纬度声明按 GeoJSON 约定直读，EPSG:4326 不做基准变换）。
 * 整批一次子进程调用：换算本身是纯计算，不产生任何持久状态。
 */
export async function sourceToGeodeticBatch(crs: MapSourceCrs, points: Array<{ x: number; y: number }>, context: MapProjContext = {}): Promise<Geodetic[]> {
  if (crs.kind === "geographic") {
    for (const point of points) {
      // 声明了经纬度、值却明显不是角度（投影坐标是几十万到几百万）：这里必须拦住，
      // 否则"把投影坐标当 4326"就会一路静默算出假位置——这正是要避免的那种默认。
      if (!Number.isFinite(point.y) || Math.abs(point.y) > 90) {
        throw new Error(`MAP_GEOJSON_NOT_GEOGRAPHIC: 声明 CRS 为 ${crs.epsg}（经纬度），但读到纬度 y=${point.y}，超出 ±90，这不可能是经纬度。可采取的动作：回来源页核对真实 EPSG（如 EPSG:2056/27700/326zz 等投影 CRS），先用官方或 pyproj 转到 EPSG:4326 再传入；不要在 crs 里硬写 4326 蒙过去。`)
      }
    }
    // EPSG:4326 就是本工具的基准：直读并归一化经度。4490 不走这条捷径——它与 WGS84 的关系由 PROJ 决定（ballpark/noop），
    // 所以照样执行 PROJ 给的那条运算（本机是 +proj=noop：数值不变，但"这段运算成立"这件事仍由 PROJ 说）。
    if (crs.epsg === "EPSG:4326") return points.map(point => ({ lon: normalizeLongitude(point.x), lat: point.y, h: 0 }))
  }
  const operation = await resolveOperation(crs, context)
  const rows = await transformCoordinates(operation, points.map(point => [point.x, point.y] as ProjPair), runOptions(context))
  return rows.map(row => ({ lon: normalizeLongitude(row[0]), lat: row[1], h: 0 }))
}

/** 批量：WGS84 大地坐标 → 来源 CRS 坐标（sourceToGeodeticBatch 的逆运算：同一条运算管线的 cct -I；经度归一到 [-180,180)）。 */
export async function geodeticToSourceBatch(crs: MapSourceCrs, points: Geodetic[], context: MapProjContext = {}): Promise<ProjPair[]> {
  if (crs.kind === "geographic" && crs.epsg === "EPSG:4326") return points.map(point => [normalizeLongitude(point.lon), point.lat] as ProjPair)
  const operation = await resolveOperation(crs, context)
  return await transformCoordinates(operation, points.map(point => [normalizeLongitude(point.lon), point.lat] as ProjPair), { ...runOptions(context), inverse: true })
}

/** 来源 CRS 坐标 → WGS84 大地坐标（单点；批量路径见 sourceToGeodeticBatch）。 */
export async function sourceToGeodetic(crs: MapSourceCrs, x: number, y: number, context: MapProjContext = {}): Promise<Geodetic> {
  return (await sourceToGeodeticBatch(crs, [{ x, y }], context))[0]!
}

/** WGS84 大地坐标 → 来源 CRS 坐标（sourceToGeodetic 的逆运算，往返可复原原坐标）。 */
export async function geodeticToSource(crs: MapSourceCrs, point: Geodetic, context: MapProjContext = {}): Promise<[number, number]> {
  return (await geodeticToSourceBatch(crs, [point], context))[0]!
}

/** 大地坐标 → 以 anchor 为原点的局部 ENU 米制坐标（PROJ cart→topocentric：跨换日线/极点由三维几何自然处理）。 */
export async function geodeticToLocal(anchor: Geodetic, point: Geodetic, context: MapProjContext = {}): Promise<LocalEnu> {
  return (await geodeticToLocalBatch(anchor, [point], context))[0]!
}

/** 批量 大地坐标 → 局部 ENU 米制坐标（整批一次子进程）。 */
export async function geodeticToLocalBatch(anchor: Geodetic, points: Geodetic[], context: MapProjContext = {}): Promise<LocalEnu[]> {
  const enu = await wgs84ToEnu(asProjPoint(anchor), points.map(asProjPoint), runOptions(context))
  return enu.map(point => [point[0], point[1], point[2]] as LocalEnu)
}

/** 批量 局部 ENU → 大地坐标（geodeticToLocalBatch 的逆运算；上千顶点请走批量，别逐点起子进程）。 */
export async function localToGeodeticBatch(anchor: Geodetic, locals: LocalEnu[], context: MapProjContext = {}): Promise<Geodetic[]> {
  return await enuToWgs84(asProjPoint(anchor), locals.map(local => [local[0], local[1], local[2]] as ProjEnu), runOptions(context))
}

/** 局部 ENU → 大地坐标（单点便利版；批量见 localToGeodeticBatch）。 */
export async function localToGeodetic(anchor: Geodetic, local: LocalEnu, context: MapProjContext = {}): Promise<Geodetic> {
  return (await localToGeodeticBatch(anchor, [local], context))[0]!
}

/** 批量 局部米制 → 来源 CRS 坐标（可逆性核对走这条：N 个顶点两次子进程，而不是 2N 次）。 */
export async function localToSourceBatch(crs: MapSourceCrs, anchor: Geodetic, locals: LocalEnu[], context: MapProjContext = {}): Promise<ProjPair[]> {
  return await geodeticToSourceBatch(crs, await localToGeodeticBatch(anchor, locals, context), context)
}

/** 局部米制 → 来源 CRS 坐标（先经锚点 ENU 反算，再投影回来源 CRS；与正向严格互逆）。 */
export async function localToSource(crs: MapSourceCrs, anchor: Geodetic, local: LocalEnu, context: MapProjContext = {}): Promise<[number, number]> {
  return (await localToSourceBatch(crs, anchor, [local], context))[0]!
}

function asProjPoint(point: Geodetic): ProjPoint {
  return { lon: point.lon, lat: point.lat, h: point.h }
}

/**
 * WGS84 椭球上的大地线长度（PROJ `geod` 的 inverse 解，Karney 算法；近对跖点同样收敛，
 * 所以不存在"退化时换口径"的隐藏分支）。用它做独立口径：局部帧水平距离与它对比即得实测畸变。
 */
export async function geodesicDistanceM(a: Geodetic, b: Geodetic, context: MapProjContext = {}): Promise<{ meters: number; method: "proj-geod" }> {
  return { meters: (await geodesicDistances(a, [b], context))[0]!, method: "proj-geod" }
}

/** 批量：从 a 出发到各点的大地线距离（整批一次子进程；畸变采样走这条）。 */
export async function geodesicDistances(a: Geodetic, points: Geodetic[], context: MapProjContext = {}): Promise<number[]> {
  return await geodesicDistancesM(asProjPoint(a), points.map(asProjPoint), runOptions(context))
}

/** 经度归一到 [-180,180)，用于把 0..360 或跨换日线的经度折算成标准区间（比较与投影用）。 */
export function normalizeLongitude(lon: number): number {
  if (lon >= -180 && lon < 180) return lon
  return ((lon + 180) % 360 + 360) % 360 - 180
}

/** 同一点的两个经度表示之差（取最短路径，跨 ±180 不产生 359.8° 的假跳变）。 */
export function longitudeDelta(a: number, b: number): number {
  return normalizeLongitude(a - b)
}

export type GeoJsonGeometryType = "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon" | "GeometryCollection"

export interface GeoJsonVertex {
  /** 来源坐标原样保留（含第三位序数），任何换算都不改写它。 */
  source: number[]
  lon: number
  lat: number
  /** 第三位序数：GeoJSON 未定义其含义（可能是高程，也可能是深度），按 zMeaning 处理；缺失为 null。 */
  z: number | null
  local: LocalEnu
}

export interface GeoJsonFeatureSummary {
  id: string | null
  name: string | null
  geometryType: GeoJsonGeometryType
  vertexCount: number
  /** 来源 properties 原样保留（年代、面积、来源标注等都属于来源事实，本工具不改写）。 */
  sourceProperties: Record<string, unknown>
  /** 来源里真实存在的图层/时间字段（存在才写，便于核对年代；缺失为 null）。 */
  sourceYear: number | null
  /** 来源自报的官方量（如 swisstopo 的 gemflaeche/perimeter）：只照抄，不重算、不合并。 */
  sourceMeasures: Record<string, number>
  height: { present: boolean; meters: number | null; source: string; meaning: string }
  vertices: GeoJsonVertex[]
  /**
   * 顶点数组里的环划分（多边形才有；点/线为 null）：消费方据此知道哪些顶点连成一个环、
   * 哪些环是洞。role 按 GeoJSON 规范的结构位（Polygon 第 0 环为外环、其余为洞；MultiPolygon 每部分同理），
   * winding 是**在局部米制坐标里实测**的绕向（RFC 7946 要求外环逆时针、洞顺时针；实测不符就是来源文件的问题，本工具不改写坐标）。
   */
  rings: Array<{ start: number; count: number; role: "outer" | "hole" | "line"; winding: "ccw" | "cw" | "degenerate"; closed: boolean }> | null
  /** 结果是否省略了逐顶点数组（includeVertices=false）；范围与畸变仍按真实顶点计算。 */
  verticesOmitted?: boolean
  bboxLocal: { minE: number; maxE: number; minN: number; maxN: number; minUp: number | null; maxUp: number | null }
}

const SUPPORTED_GEOMETRIES: readonly GeoJsonGeometryType[] = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]

interface ParsedPoint { source: number[]; x: number; y: number; z: number | null }

/** 逐坐标校验：必须是 2..3 个有限数；不合法直接报出要素与位置，便于回来源核对。 */
function readPosition(value: unknown, where: string): ParsedPoint {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) throw new Error(`MAP_GEOJSON_POSITION_INVALID: ${where} 的位置必须是 2 或 3 个数字的数组，实际为 ${JSON.stringify(value)?.slice(0, 80)}。${CRS_ACTION}`)
  const numbers = value.map(item => typeof item === "number" ? item : Number.NaN)
  if (numbers.some(item => !Number.isFinite(item))) throw new Error(`MAP_GEOJSON_POSITION_INVALID: ${where} 的位置含非有限数字 ${JSON.stringify(value)?.slice(0, 80)}。可采取的动作：回来源页核对这条坐标（NaN/字符串/空值都不是合法坐标）。`)
  return { source: value as number[], x: numbers[0]!, y: numbers[1]!, z: value.length === 3 ? numbers[2]! : null }
}

interface ParsedGeometry { type: GeoJsonGeometryType; points: ParsedPoint[]; rings: ParsedPoint[][]; ringRoles: ("outer" | "hole" | "line")[]; childGeometries: number }

/** 递归展开 GeoJSON 几何：点集（用于换算）与环（用于闭合/跨换日线检查）分开收集。 */
function readGeometry(value: unknown, where: string): ParsedGeometry {
  if (!value || typeof value !== "object") throw new Error(`MAP_GEOJSON_GEOMETRY_INVALID: ${where} 缺少 geometry。可采取的动作：确认这是 GeoJSON 要素或几何对象（Point/LineString/Polygon/…）。`)
  const geometry = value as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  if (typeof geometry.type !== "string" || !SUPPORTED_GEOMETRIES.includes(geometry.type as GeoJsonGeometryType)) {
    throw new Error(`MAP_GEOJSON_GEOMETRY_UNSUPPORTED: ${where} 的 geometry.type「${String(geometry.type)}」不受支持。可采取的动作：先转成 ${SUPPORTED_GEOMETRIES.join("/")} 之一。`)
  }
  const type = geometry.type as GeoJsonGeometryType
  if (type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) throw new Error(`MAP_GEOJSON_GEOMETRY_INVALID: ${where} 是 GeometryCollection 但没有 geometries 数组。`)
    const points: ParsedPoint[] = [], rings: ParsedPoint[][] = [], ringRoles: ("outer" | "hole" | "line")[] = []
    for (const [index, child] of geometry.geometries.entries()) {
      const parsed = readGeometry(child, `${where}.geometries[${index}]`)
      points.push(...parsed.points); rings.push(...parsed.rings); ringRoles.push(...parsed.ringRoles)
    }
    return { type, points, rings, ringRoles, childGeometries: geometry.geometries.length }
  }
  const coordinates = geometry.coordinates
  const points: ParsedPoint[] = [], rings: ParsedPoint[][] = [], ringRoles: ("outer" | "hole" | "line")[] = []
  const requireArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`MAP_GEOJSON_GEOMETRY_INVALID: ${label} 必须是非空数组。`)
    return value
  }
  const readRing = (value: unknown, label: string, minimum: number): ParsedPoint[] => {
    const ring = requireArray(value, label).map((item, index) => readPosition(item, `${label}[${index}]`))
    if (ring.length < minimum) throw new Error(`MAP_GEOJSON_GEOMETRY_INVALID: ${label} 只有 ${ring.length} 个点（至少 ${minimum} 个）。`)
    return ring
  }
  if (type === "Point") points.push(readPosition(coordinates, `${where}.coordinates`))
  else if (type === "MultiPoint") points.push(...requireArray(coordinates, `${where}.coordinates`).map((item, index) => readPosition(item, `${where}.coordinates[${index}]`)))
  else if (type === "LineString") {
    const line = readRing(coordinates, `${where}.coordinates`, 2)
    points.push(...line); rings.push(line); ringRoles.push("line")
  } else if (type === "MultiLineString") {
    for (const [lineIndex, line] of requireArray(coordinates, `${where}.coordinates`).entries()) {
      const parsedLine = readRing(line, `${where}.coordinates[${lineIndex}]`, 2)
      points.push(...parsedLine); rings.push(parsedLine); ringRoles.push("line")
    }
  } else if (type === "Polygon") {
    for (const [ringIndex, ring] of requireArray(coordinates, `${where}.coordinates`).entries()) {
      const parsedRing = readRing(ring, `${where}.coordinates[${ringIndex}]`, 4)
      points.push(...parsedRing); rings.push(parsedRing); ringRoles.push(ringIndex === 0 ? "outer" : "hole")
    }
  } else {
    for (const [polygonIndex, polygon] of requireArray(coordinates, `${where}.coordinates`).entries()) {
      for (const [ringIndex, ring] of requireArray(polygon, `${where}.coordinates[${polygonIndex}]`).entries()) {
        const parsedRing = readRing(ring, `${where}.coordinates[${polygonIndex}][${ringIndex}]`, 4)
        points.push(...parsedRing); rings.push(parsedRing); ringRoles.push(ringIndex === 0 ? "outer" : "hole")
      }
    }
  }
  return { type, points, rings, ringRoles, childGeometries: 0 }
}

/** 环是否闭合（GeoJSON 要求首尾相同）；不闭合只警告不改写坐标。 */
function ringClosed(ring: ParsedPoint[]): boolean {
  if (ring.length < 2) return false
  const first = ring[0]!, last = ring.at(-1)!
  return first.x === last.x && first.y === last.y
}

/** 在局部米制坐标里量环的绕向（RFC 7946：外环逆时针 ccw、洞顺时针 cw）；零面积环标 degenerate。 */
function ringWinding(local: LocalEnu[]): "ccw" | "cw" | "degenerate" {
  let twiceArea = 0
  for (let index = 0; index < local.length - 1; index++) {
    const [x1, y1] = local[index]!, [x2, y2] = local[index + 1]!
    twiceArea += x1 * y2 - x2 * y1
  }
  if (!Number.isFinite(twiceArea) || twiceArea === 0) return "degenerate"
  return twiceArea > 0 ? "ccw" : "cw"
}

export interface ReadGeoJsonOptions {
  crs: MapSourceCrs
  anchor: Geodetic
  /** 第三位序数的含义由调用方声明；默认 unknown（不当高度用）。 */
  zMeaning: "elevation" | "depth" | "unknown"
  /** 可选：把某个来源 property 当作高度照抄（缺失的要素仍为 null，不补值）。 */
  heightProperty?: string
  maxVertices: number
  /** 换算上下文（取消信号 + 已探测的实际运算）：投影与基准换算按它执行。 */
  context?: MapProjContext
}

/** 把 GeoJSON 的每个要素换算成局部米制顶点；返回结构里的数值全部是 JSON 安全的（无 undefined）。 */
export async function convertGeoJsonFeatures(root: unknown, options: ReadGeoJsonOptions): Promise<{ features: GeoJsonFeatureSummary[]; warnings: string[]; totalVertices: number }> {
  const context = options.context ?? {}
  const signal = context.signal
  const warnings: string[] = []
  const rawFeatures: unknown[] = (() => {
    if (!root || typeof root !== "object") throw new Error("MAP_GEOJSON_INVALID: geojson 必须是对象或 JSON 字符串。可采取的动作：传 FeatureCollection/Feature/几何对象，或指向 .geojson/.json 文件的 path。")
    const value = root as { type?: unknown; features?: unknown }
    if (value.type === "FeatureCollection") {
      if (!Array.isArray(value.features)) throw new Error("MAP_GEOJSON_INVALID: FeatureCollection 缺少 features 数组。")
      return value.features
    }
    return [root]
  })()
  if (rawFeatures.length === 0) throw new Error("MAP_GEOJSON_EMPTY: 没有任何要素可换算。可采取的动作：确认查询确实返回了要素（空结果不是几何证据，不要据此建模）。")
  let totalVertices = 0
  interface ParsedRecord {
    where: string
    feature: { type?: unknown; id?: unknown; properties?: unknown; geometry?: unknown; features?: unknown }
    properties: Record<string, unknown>
    parsed: ParsedGeometry
  }
  // —— 第一遍：展开要素、解析几何、结构检查、顶点上限（在动子进程之前就拦住超限数据）。——
  const records: ParsedRecord[] = []
  const flatten = (list: unknown[], prefix: string): void => {
    for (const [index, raw] of list.entries()) {
      signal?.throwIfAborted()
      const where = `${prefix}[${index}]`
      if (!raw || typeof raw !== "object") throw new Error(`MAP_GEOJSON_INVALID: ${where} 不是对象。`)
      const feature = raw as ParsedRecord["feature"]
      // 允许要素列表里再嵌 FeatureCollection（有些导出会这么套），递归展开。
      if (feature.type === "FeatureCollection") {
        if (!Array.isArray(feature.features)) throw new Error(`MAP_GEOJSON_INVALID: ${where} 是 FeatureCollection 但没有 features 数组。`)
        flatten(feature.features, `${where}.features`)
        continue
      }
      const geometry = feature.type === "Feature" || feature.geometry !== undefined ? feature.geometry : feature
      const properties = (feature.type === "Feature" && feature.properties && typeof feature.properties === "object" ? feature.properties : {}) as Record<string, unknown>
      const parsed = readGeometry(geometry, where)
      totalVertices += parsed.points.length
      if (totalVertices > options.maxVertices) {
        throw new Error(`MAP_GEOJSON_TOO_MANY_VERTICES: 顶点数超过本次上限 ${options.maxVertices}（已读到 ${totalVertices}）。可采取的动作：先用范围/属性裁剪到目标片段，或显式调大 maxVertices（硬上限 ${MAP_CONSTRAINTS_HARD_MAX_VERTICES}）；不要一次把整份大范围数据塞进一个局部帧。`)
      }
      for (const [ringIndex, ring] of parsed.rings.entries()) {
        // 只有多边形环才有"首尾相同"的要求；折线（role=line）本来就该是开口的，别拿环的规矩去警告它。
        if (parsed.ringRoles[ringIndex] !== "line" && !ringClosed(ring)) warnings.push(`${where}: 环没有闭合（首尾坐标不同）；坐标按原样保留，多边形闭合请在建模侧显式处理。`)
        let maxJump = 0
        for (let step = 1; step < ring.length; step++) maxJump = Math.max(maxJump, Math.abs(longitudeDelta(ring[step]!.x, ring[step - 1]!.x)))
        if (maxJump > 180) warnings.push(`${where}: 相邻顶点的经度跳变 ${maxJump.toFixed(2)}°，该环跨越 ±180 换日线；换算按最短路径处理正确，但 RFC 7946 §3.1.9 建议在 ±180 处切分成两个环，供下游按需处理。`)
      }
      records.push({ where, feature, properties, parsed })
    }
  }
  flatten(rawFeatures, "features")
  if (records.length === 0) throw new Error("MAP_GEOJSON_EMPTY: 没有任何要素可换算。可采取的动作：确认查询确实返回了要素（空结果不是几何证据，不要据此建模）。")
  // —— 第二遍：整批换算，各一次 PROJ 调用（不做逐点子进程；也不在中途换口径）。——
  const allPoints = records.flatMap(record => record.parsed.points)
  const geodetics = await sourceToGeodeticBatch(options.crs, allPoints, context)
  const locals = await geodeticToLocalBatch(options.anchor, geodetics.map((geodetic, index) => ({
    lon: geodetic.lon, lat: geodetic.lat,
    // 只有调用方声明第三位是高程时它才参与局部帧；深度/未声明一律不当作高度（0 只是投影的椭球高，不是"补的高度"）。
    h: options.zMeaning === "elevation" ? (allPoints[index]!.z ?? 0) : 0,
  })), context)
  // —— 第三遍：按要素装配结果（坐标已是上面批量算出的切片，不再重算）。——
  const features: GeoJsonFeatureSummary[] = []
  let cursor = 0
  for (const record of records) {
    const { where, feature, properties, parsed } = record
    const firstVertex = cursor
    cursor += parsed.points.length
    const vertices: GeoJsonVertex[] = parsed.points.map((point, index) => ({
      source: point.source,
      lon: geodetics[firstVertex + index]!.lon,
      lat: geodetics[firstVertex + index]!.lat,
      z: point.z,
      local: locals[firstVertex + index]!,
    }))
    const declaredHeight = options.heightProperty === undefined ? null
      : (() => {
        const value = properties[options.heightProperty!]
        if (typeof value === "number" && Number.isFinite(value)) return { present: true, meters: value, source: `property:${options.heightProperty}`, meaning: "声明为高度属性，来源数值照抄" }
        if (value !== undefined) warnings.push(`${where}: heightProperty「${options.heightProperty}」的值不是有限数字（${JSON.stringify(value)?.slice(0, 60)}），按缺高度处理，不补值。`)
        return null
      })()
    const geometryHeight = options.zMeaning === "elevation" && parsed.points.some(item => item.z !== null)
    const height = declaredHeight ?? (geometryHeight
      ? { present: true, meters: parsed.points.find(item => item.z !== null)?.z ?? null, source: "geometry-third-ordinate", meaning: "第三位序数，调用方声明为高程（elevation）" }
      : { present: false, meters: null, source: "absent", meaning: options.zMeaning === "unknown" ? "第三位序数含义未声明（GeoJSON 未定义其含义；例如 USGS 的第三位是震源深度），本工具不当作高度" : `第三位序数按 ${options.zMeaning} 处理，但该要素没有第三位` })
    const year = (() => {
      for (const key of ["jahr", "year", "Jahr", "YEAR"]) {
        const value = (properties as Record<string, unknown>)[key]
        if (typeof value === "number" && Number.isFinite(value)) return value
      }
      return null
    })()
    const measures: Record<string, number> = {}
    for (const key of ["gemflaeche", "perimeter", "area", "shape_area", "shape_leng", "mag", "depth"]) {
      const value = (properties as Record<string, unknown>)[key]
      if (typeof value === "number" && Number.isFinite(value)) measures[key] = value
    }
    // 环划分：vertices 是按环顺序摊平的，这里按同一顺序给出每环的区间与实测绕向（坐标不改写）。
    let ringCursor = 0
    const rings = parsed.rings.map((ring, index) => {
      const start = ringCursor
      ringCursor += ring.length
      return {
        start, count: ring.length,
        role: parsed.ringRoles[index] ?? "line",
        winding: ringWinding(vertices.slice(start, ringCursor).map(vertex => vertex.local)),
        closed: ringClosed(ring),
      }
    })
    // 点类几何（Point/MultiPoint）没有环，rings 为空；有线/多边形时环必须恰好铺满顶点数组。
    if (rings.length && ringCursor !== vertices.length) throw new Error(`MAP_GEOJSON_INTERNAL: 环划分与顶点数不一致（${ringCursor} ≠ ${vertices.length}），请报告这个不一致而不是继续使用结果。`)
    // 真实来源常违反 RFC 7946 的绕向约定（例如 swisstopo 的市界外环是顺时针）：实测绕向照实上报，
    // 并明确告诉下游以 role（结构位）为准，别拿绕向当"内外"判据——本工具不改写来源坐标。
    for (const [index, ring] of rings.entries()) {
      const expected = ring.role === "outer" ? "ccw" : "cw"
      if (ring.role !== "line" && ring.winding !== "degenerate" && ring.winding !== expected) warnings.push(`${where}: 第 ${index} 环（${ring.role}）实测绕向为 ${ring.winding}，与 RFC 7946 §3.1.6 要求的 ${expected} 相反——坐标按原样保留不改写；下游请用 rings[].role 区分外环/洞，不要用绕向判定内外。`)
    }
    const east: number[] = vertices.map(vertex => vertex.local[0])
    const north: number[] = vertices.map(vertex => vertex.local[1])
    const up: number[] = vertices.map(vertex => vertex.local[2])
    // 只有来源真的带高程第三位、且调用方声明为 elevation 时，局部 z 才是有意义的量；否则不上报 up 范围（不拿 0 冒充"高度"）。
    const upMeaningful = options.zMeaning === "elevation" && parsed.points.some(item => item.z !== null)
    features.push({
      id: typeof feature.id === "string" || typeof feature.id === "number" ? String(feature.id) : (typeof (properties as Record<string, unknown>).id === "string" ? String((properties as Record<string, unknown>).id) : null),
      name: typeof properties.name === "string" ? properties.name : (typeof properties.gemname === "string" ? properties.gemname : null),
      geometryType: parsed.type,
      vertexCount: parsed.points.length,
      sourceProperties: properties,
      sourceYear: year,
      sourceMeasures: measures,
      height,
      // 逐顶点坐标一律先算出来（畸变统计要用）；是否写进结果由调用流程按 includeVertices 决定。
      vertices,
      rings: rings.length ? rings : null,
      bboxLocal: {
        minE: Math.min(...east), maxE: Math.max(...east), minN: Math.min(...north), maxN: Math.max(...north),
        minUp: upMeaningful ? Math.min(...up) : null, maxUp: upMeaningful ? Math.max(...up) : null,
      },
    })
  }
  // 批量切片必须与要素装配严格对齐：对不上就报错，别让错位的坐标混进结果。
  if (cursor !== allPoints.length) throw new Error(`MAP_GEOJSON_INTERNAL: 批量换算的顶点数（${allPoints.length}）与装配出的顶点数（${cursor}）不一致，请报告这个不一致而不是继续使用结果。`)
  return { features, warnings, totalVertices }
}

export interface DeclaredValue { name: string; value: number; unit: string | null; basis: "measured" | "estimated"; source: string | null }

/**
 * 测量值与估计值分栏：只认调用方显式声明的 basis（measured/estimated），
 * 其它取值直接报错——本工具不会替调用方把某个来源悄悄升格成"实测"。
 */
export function splitDeclaredValues(values: unknown): { measured: DeclaredValue[]; estimated: DeclaredValue[] } {
  const measured: DeclaredValue[] = [], estimated: DeclaredValue[] = []
  if (values === undefined || values === null) return { measured, estimated }
  if (!Array.isArray(values)) throw new Error("MAP_VALUES_INVALID: declaredValues 必须是数组：[{name,value,unit,basis:\"measured\"|\"estimated\",source?}]。")
  for (const [index, item] of values.entries()) {
    const row = item as { name?: unknown; value?: unknown; unit?: unknown; basis?: unknown; source?: unknown }
    if (!row || typeof row !== "object" || typeof row.name !== "string" || typeof row.value !== "number" || !Number.isFinite(row.value)) {
      throw new Error(`MAP_VALUES_INVALID: declaredValues[${index}] 需要 name（字符串）与有限数字 value。`)
    }
    if (row.basis !== "measured" && row.basis !== "estimated") {
      throw new Error(`MAP_VALUE_BASIS_REQUIRED: declaredValues[${index}]「${row.name}」必须显式声明 basis 为 measured 或 estimated（收到 ${JSON.stringify(row.basis)}）。测量值与估计值必须分栏，本工具不替你归类。`)
    }
    const entry: DeclaredValue = { name: row.name, value: row.value, unit: typeof row.unit === "string" ? row.unit : null, basis: row.basis, source: typeof row.source === "string" ? row.source : null }
    ;(row.basis === "measured" ? measured : estimated).push(entry)
  }
  return { measured, estimated }
}

export interface MapConstraintsAnchorInput { lon?: unknown; lat?: unknown; x?: unknown; y?: unknown; h?: unknown }
export interface MapConstraintsSourceInput { page?: unknown; url?: unknown; retrievedAt?: unknown; object?: unknown; era?: unknown; license?: unknown; attribution?: unknown; note?: unknown }

/** 解析锚点：{lon,lat}（WGS84 度）或 {x,y}（来源 CRS 坐标）二选一；两者都给/都不给都报错，避免歧义。 */
export async function resolveAnchor(crs: MapSourceCrs, anchor: MapConstraintsAnchorInput | undefined, context: MapProjContext = {}): Promise<{ geodetic: Geodetic; input: { form: "lonlat" | "source-xy"; values: number[] } }> {
  if (!anchor || typeof anchor !== "object") throw new Error('MAP_ANCHOR_REQUIRED: 必须给出局部锚点。可采取的动作：用 {"lon":..,"lat":..}（WGS84 度）或 {"x":..,"y":..}（来源 CRS 坐标，如 UTM 东距/北距）。')
  const hasLonLat = typeof anchor.lon === "number" && typeof anchor.lat === "number"
  const hasXY = typeof anchor.x === "number" && typeof anchor.y === "number"
  const h = typeof anchor.h === "number" && Number.isFinite(anchor.h) ? anchor.h : 0
  if (hasLonLat && hasXY) throw new Error('MAP_ANCHOR_AMBIGUOUS: 锚点同时给了经纬度与来源 CRS 坐标，无法判断以哪个为准。可采取的动作：只保留一种形式——{"lon":..,"lat":..} 或 {"x":..,"y":..}。')
  if (hasLonLat) {
    const lon = anchor.lon as number, lat = anchor.lat as number
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat > 90 || lat < -90) throw new Error(`MAP_ANCHOR_INVALID: 锚点经纬度不合法（lon=${lon}, lat=${lat}）。可采取的动作：核对锚点坐标；纬度必须在 ±90 内。`)
    return { geodetic: { lon: normalizeLongitude(lon), lat, h }, input: { form: "lonlat", values: [lon, lat] } }
  }
  if (hasXY) {
    const x = anchor.x as number, y = anchor.y as number
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`MAP_ANCHOR_INVALID: 锚点坐标不是有限数字（x=${x}, y=${y}）。`)
    const geodetic = await sourceToGeodetic(crs, x, y, context)
    return { geodetic: { ...geodetic, h }, input: { form: "source-xy", values: [x, y] } }
  }
  throw new Error('MAP_ANCHOR_REQUIRED: 锚点必须给出 {"lon":..,"lat":..}（WGS84 度）或 {"x":..,"y":..}（来源 CRS 坐标）中的一种。')
}

/** 来源元数据原样保留（是记录，不是判定）；缺项如实列出，不替调用方编来源。 */
export function preserveSourceMetadata(source: MapConstraintsSourceInput | undefined): { meta: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null
  const page = text(source?.page), url = text(source?.url), retrievedAt = text(source?.retrievedAt)
  const object = text(source?.object), license = text(source?.license), attribution = text(source?.attribution), note = text(source?.note)
  const eraInput = source?.era as { label?: unknown; status?: unknown } | undefined
  const eraLabel = text(eraInput?.label)
  const eraStatus = eraInput?.status === "confirmed" || eraInput?.status === "unconfirmed" || eraInput?.status === "unknown" ? eraInput.status : (eraLabel === null ? "unknown" : null)
  if (eraLabel !== null && eraStatus === null) throw new Error("MAP_ERA_STATUS_INVALID: 给了 era.label 就必须同时声明 era.status 为 confirmed/unconfirmed/unknown。可采取的动作：确认该数据对应的年代是否有来源支持；未确认就写 unconfirmed。")
  if (page === null) notes.push("未提供来源页（source.page）：本次结果不能回溯到发现它的页面，建议下次一并传入。")
  if (retrievedAt === null) notes.push("未提供获取时间（source.retrievedAt）：请把真实取数时间写入，供之后核对数据版本。")
  if (object === null) notes.push("未提供对象名（source.object）：建议写清这是哪个地点/构件的坐标数据。")
  return {
    meta: {
      page, url, retrievedAt, object, license, attribution, note,
      era: { label: eraLabel, status: eraStatus },
      // 工具自身的判定恒为"不断言"：坐标换算不构成地点/年代的对应关系。
      eraMatch: "not-asserted",
      eraNote: eraStatus === "confirmed"
        ? "调用方声明该数据年代已确认；本工具只回显该声明，不代替来源核对。"
        : "年代未确认：本工具不会声称该数据与目标对象/年代对应；建模前请用来源页、对象名与年份字段人工核对（不设某类来源无条件正确）。",
    },
    notes,
  }
}

export interface MapConstraintsInput {
  path?: unknown
  geojson?: unknown
  crs?: unknown
  anchor?: MapConstraintsAnchorInput
  zMeaning?: unknown
  heightProperty?: unknown
  source?: MapConstraintsSourceInput
  declaredValues?: unknown
  maxVertices?: unknown
  includeVertices?: unknown
  /** 基准运算策略，默认 require-exact（见 DatumPolicy）。 */
  datumPolicy?: unknown
}

/** 校验 datumPolicy：缺省 require-exact；其它取值直接拒绝（不替调用方挑一个宽松档）。 */
export function parseDatumPolicy(value: unknown): DatumPolicy {
  if (value === undefined || value === null) return "require-exact"
  if (value === "require-exact" || value === "allow-ballpark") return value
  throw new Error(`MAP_DATUM_POLICY_INVALID: datumPolicy 只能是 "require-exact"（默认：只接受 PROJ 给出可信精度的运算）或 "allow-ballpark"（明确接受 ballpark/unknown 精度，结果里如实标注）。收到 ${JSON.stringify(value)}。`)
}

export interface MapConstraintsDependencies {
  /** 仅测试注入：现在时间。 */
  now?: () => Date
  readFile?: (path: string) => Promise<string>
  /**
   * 相对路径的解析基准（注册时取自原生 agent 会话工作目录 exec.agent.session.header.cwd）。
   * **给相对路径这个字段就是必需的**：没有基准时直接报 MAP_SESSION_CWD_UNKNOWN，不退回进程目录。
   */
  pathBase?: string
  /**
   * 仅测试/装配注入：PROJ 子进程执行器（省略则用 proj-cli 的默认异步实现）。
   * 宿主若要把 PROJ 调用统一走自己的子进程服务，在这里传一个同签名的 runner：必须是异步且可取消的，
   * 本工具的等待语义（不阻塞同进程其它会话、AbortSignal 能终止本次转换）就建立在这条约定上。
   */
  runner?: ProjProcessRunner
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * 主流程：显式 CRS + 锚点 + GeoJSON → 可逆原坐标与局部米制坐标、真实范围、实测畸变。
 * 失败一律抛错并带可执行动作；不做任何写入，不建第二状态库（结果就是本工具的返回值）。
 */
export async function mapGeoJsonToLocal(input: MapConstraintsInput, dependencies: MapConstraintsDependencies = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const now = dependencies.now ?? (() => new Date())
  // 默认读取按 pathBase 解析相对路径（有 fs 服务时注册方会给出走 ctx.fs 的 readFile，见 registerMapConstraintTools）；
  // 两条路径的相对路径语义一致：都是"会话工作目录里的这个文件"。
  const readText = dependencies.readFile ?? (async (path: string) => await readFile(
    dependencies.pathBase && !isAbsolute(path) ? join(dependencies.pathBase, path) : path, "utf8"))
  const convertedAt = now().toISOString()
  const crs = parseSourceCrs(input?.crs)
  if (input?.zMeaning !== undefined && input.zMeaning !== "elevation" && input.zMeaning !== "depth" && input.zMeaning !== "unknown") {
    throw new Error('MAP_Z_MEANING_INVALID: zMeaning 只能是 elevation（高程）、depth（深度）或 unknown（未声明）。可采取的动作：说清第三位序数到底是什么；不确定就省略，本工具按 unknown 处理，不会当高度用。')
  }
  const zMeaning = (input?.zMeaning ?? "unknown") as "elevation" | "depth" | "unknown"
  const heightProperty = typeof input?.heightProperty === "string" && input.heightProperty.trim() ? input.heightProperty.trim() : undefined
  const datumPolicy = parseDatumPolicy(input?.datumPolicy)
  const hasPath = typeof input?.path === "string" && input.path.trim().length > 0
  const hasInline = input?.geojson !== undefined && input?.geojson !== null
  if (hasPath === hasInline) throw new Error("MAP_GEOJSON_SOURCE_REQUIRED: 必须在 path（本地 GeoJSON 文件）与 geojson（内联对象或 JSON 字符串）之间给且只给一个。")
  // 相对路径必须有明确的解析基准：注册时取自原生 agent 会话工作目录（exec.agent.session.header.cwd），
  // 或调用方显式给的 pathBase。没有基准就**明确报错**，不退回进程启动目录——
  // 本仓已经有过一次"按进程目录解析相对路径"的缺陷（任务 67），这里不再留同一个坑。
  const requestedPath = hasPath ? (input.path as string).trim() : ""
  if (hasPath && !isAbsolute(requestedPath) && !dependencies.pathBase) {
    throw new Error(`MAP_SESSION_CWD_UNKNOWN: path「${requestedPath}」是相对路径，但这次调用没有可用的会话工作目录（原生 agent 的 exec.agent.session.header.cwd 缺失；本仓 read/write/edit 也按它解析相对路径）。本工具不会退回进程启动目录去猜。可采取的动作：改用绝对路径，或从带会话工作目录的 agent 调用；脚本/纯计算场景请在依赖里显式设置 pathBase。`)
  }
  // 先把"这套坐标与 WGS84 的真实关系"问清（projinfo）：球面/投影都是精确事实，
  // 但基准运算可能是 ballpark 或缺格网——那种情况下按策略拒绝，绝不静默给一套 ballpark 数值。
  const context: MapProjContext = { ...(signal ? { signal } : {}), ...(dependencies.runner ? { runner: dependencies.runner } : {}) }
  const datum = await assessDatumOperation(crs, datumPolicy, context)
  // 这条运算对象一路传给下面的换算：数值由 cct 执行它自报的管线得出（反向 == 同一条管线的 cct -I）。
  const projection: MapProjContext = { ...context, operation: datum.operation }
  const anchor = await resolveAnchor(crs, input?.anchor, projection)
  const requestedMax = input?.maxVertices === undefined ? MAP_CONSTRAINTS_DEFAULT_MAX_VERTICES : input.maxVertices
  if (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax <= 0) throw new Error("MAP_MAX_VERTICES_INVALID: maxVertices 必须是正整数。可采取的动作：省略用默认上限，或给一个不超过硬上限的整数。")
  const maxVertices = Math.min(requestedMax, MAP_CONSTRAINTS_HARD_MAX_VERTICES)
  const includeVertices = input?.includeVertices !== false
  let parsedRaw: unknown
  if (hasPath) {
    const path = requestedPath
    let text: string
    try { text = await readText(path) } catch (error) {
      throw new Error(`MAP_GEOJSON_FILE_UNREADABLE: 读不到 ${path}（${error instanceof Error ? error.message : String(error)}）。可采取的动作：确认路径存在且是工作区里的 GeoJSON——${isAbsolute(path) ? "本次给的是绝对路径，相对路径也可以（按会话工作目录解析）" : `本次是相对路径，按会话工作目录 ${dependencies.pathBase} 解析，也可以用绝对路径`}；网络来源请先落到本地文件再传入。`)
    }
    try { parsedRaw = JSON.parse(text) } catch (error) {
      throw new Error(`MAP_GEOJSON_PARSE_FAILED: ${path} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。可采取的动作：确认文件确实是 GeoJSON（有些站点返回的是 HTML 错误页或压缩包）。`)
    }
  } else if (typeof input?.geojson === "string") {
    try { parsedRaw = JSON.parse(input.geojson) } catch (error) {
      throw new Error(`MAP_GEOJSON_PARSE_FAILED: geojson 字符串不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。`)
    }
  } else parsedRaw = input?.geojson
  signal?.throwIfAborted()
  const converted = await convertGeoJsonFeatures(parsedRaw, { crs, anchor: anchor.geodetic, zMeaning, heightProperty, maxVertices, context: projection })
  const warnings = [...datum.warnings, ...converted.warnings]
  const source = preserveSourceMetadata(input?.source)
  const values = splitDeclaredValues(input?.declaredValues)
  // 实测畸变：局部帧距离 vs WGS84 椭球大地线距离（以锚点为共同起点）；口径两侧都写明。
  // 采样点整批交给 PROJ geod（一次子进程，不逐点调用，也不换第二套算法）。
  const allVertices = converted.features.flatMap(feature => feature.vertices)
  const sampleStep = Math.max(1, Math.ceil(allVertices.length / DISTORTION_SAMPLE_LIMIT))
  const sampled = allVertices.filter((_vertex, index) => index % sampleStep === 0)
  const sampledGeodesicM = await geodesicDistances(anchor.geodetic, sampled.map(vertex => ({ lon: vertex.lon, lat: vertex.lat, h: 0 })), context)
  let samples = 0, maxRelativePpm = 0, maxAbsoluteM = 0, farthestM = 0, farthestLocalM = 0, farthestGeodesicM = 0
  for (const [index, vertex] of sampled.entries()) {
    const localM = Math.hypot(vertex.local[0], vertex.local[1])
    const geodesicM = sampledGeodesicM[index]!
    if (geodesicM > 1 && localM > 1) {
      samples++
      maxRelativePpm = Math.max(maxRelativePpm, Math.abs(localM / geodesicM - 1) * 1e6)
      maxAbsoluteM = Math.max(maxAbsoluteM, Math.abs(localM - geodesicM))
    }
    if (geodesicM > farthestM) { farthestM = geodesicM; farthestLocalM = localM; farthestGeodesicM = geodesicM }
  }
  const extentLocal = converted.features.reduce(
    (accumulator, feature) => ({
      minE: Math.min(accumulator.minE, feature.bboxLocal.minE), maxE: Math.max(accumulator.maxE, feature.bboxLocal.maxE),
      minN: Math.min(accumulator.minN, feature.bboxLocal.minN), maxN: Math.max(accumulator.maxN, feature.bboxLocal.maxN),
    }),
    { minE: Infinity, maxE: -Infinity, minN: Infinity, maxN: -Infinity },
  )
  const widthM = extentLocal.maxE - extentLocal.minE, depthM = extentLocal.maxN - extentLocal.minN
  const maxExtentM = Math.max(widthM, depthM)
  if (maxExtentM > FAR_EXTENT_WARNING_M) warnings.push(`数据范围约 ${(maxExtentM / 1000).toFixed(1)} km，远超局部帧的适用尺度：请用范围/分块裁剪到目标片段，或直接使用 geodesic 值；一个局部米制帧不适合覆盖这个尺度。`)
  const lonValues = converted.features.flatMap(feature => feature.vertices.map(vertex => vertex.lon))
  const lonSpan = lonValues.length ? Math.max(...lonValues) - Math.min(...lonValues) : 0
  const crossesAntimeridian = lonSpan > 180
  if (crossesAntimeridian) warnings.push("数据经度跨度超过 180°，判定为跨越 ±180：局部帧按最短路径处理正确，但不要用经纬度直减表示范围（见 extent.geodesic.note），也不要把经度跨度≥180°的数据当成一条连续直线直接建墙。")
  if (crs.kind === "utm") {
    const anchorLon = anchor.geodetic.lon
    const centralMeridian = crs.zone! * 6 - 183
    if (Math.abs(longitudeDelta(anchorLon, centralMeridian)) > UTM_ZONE_WARNING_DEG) warnings.push(`锚点经度 ${anchorLon.toFixed(4)}° 离声明的 UTM ${crs.zone}${crs.hemisphere === "north" ? "N" : "S"} 带中央经线 ${centralMeridian}° 超过 ${UTM_ZONE_WARNING_DEG}°：带号很可能选错（或数据其实不属于该带），请回来源核对 EPSG 代码。`)
  }
  const missingHeight = converted.features.filter(feature => !feature.height.present).map(feature => feature.id ?? feature.name ?? "(未命名要素)")
  // includeVertices=false 时只去掉返回里的逐顶点数组：范围与畸变仍按真实顶点算出（不是另算一份弱替身读数）。
  const featuresOut = converted.features.map(feature => ({ ...feature, vertices: includeVertices ? feature.vertices : [], verticesOmitted: !includeVertices }))
  // 统一走一次 JSON 往返：保证返回给模型的结果里没有 undefined/NaN（DSH 工具结果的硬要求）。
  return jsonSafe({
    tool: "map_geojson_to_local",
    ok: true,
    crs: { declared: crs.declared, epsg: crs.epsg, kind: crs.kind, units: crs.units, proj: crs.proj, zone: crs.zone ?? null, hemisphere: crs.hemisphere ?? null, notes: crs.notes, silentlyAssumed: false },
    projection: {
      engine: "PROJ 命令行（cct：执行 projinfo 所报运算的管线本身，含 CRS↔WGS84 与 cart→topocentric 局部 ENU；geod：WGS84 椭球大地线；projinfo：这对 CRS 实际用哪条运算、精度、适用范围、缺不缺格网）",
      version: await projVersion(runOptions(context)),
      datumPolicy: datum.policy,
      // 基准变换的事实来自 PROJ 自己的 projinfo（不是本文件的判断）：种类、精度、适用范围、缺不缺格网、是否动态框架。
      datumTransform: describeDatumOperation(datum.operation, datum.policy),
      datumOperation: {
        from: datum.operation.from,
        to: datum.operation.to,
        kind: datum.operation.kind,
        description: datum.operation.description,
        accuracy: datum.operation.accuracy,
        area: datum.operation.area,
        ballpark: datum.operation.ballpark,
        usable: datum.operation.usable,
        selectedCandidate: datum.operation.selectedCandidate,
        candidateCount: datum.operation.candidateCount,
        missingGrids: datum.operation.missingGrids,
        candidates: datum.operation.candidates,
        dynamicFrame: datum.operation.dynamicFrame,
        timeDependent: datum.operation.timeDependent,
        projString: datum.operation.projString,
        // 数值路线：这条管线就是被 cct 执行的那条（反向 = 同一条管线 cct -I），所以"报告的操作"与"实际执行的操作"是同一个。
        execution: {
          engine: "cct",
          axisSwap: datum.operation.execution.axisSwap,
          executedProjString: datum.operation.projString,
          executedBy: "cct -d 12 <上面这条 projString>（来源→EPSG:4326；反向为同一条管线加 -I，正反严格互逆）",
          note: datum.operation.execution.note,
        },
        concerns: datum.concerns,
        note: `这是 \`projinfo -s <来源> -t EPSG:4326 --spatial-test intersects --grid-check discard_missing\` 的第一条候选（与运行时的空间筛选、缺格网跳过口径一致，本机实测与 cs2cs 自报的运算名相同）：精度与适用范围都是 PROJ 自报，不是本工具对「大概差多少」的估计。**本结果里的坐标就是由这条运算的 PROJ 管线（标准 cct 执行）算出的**，缺格网会在执行时直接失败而不是静默改用别的运算；kind=projection/noop 表示不含基准变换；accuracy 是这段运算自身的精度，局部帧的畸变另见 distortion。别的候选缺不缺格网只记在 candidates 里，不影响这条已选中且本机可用的运算。`,
      },
      // 四件事分开说：投影 / 基准 / 历元 / 垂直基准。本工具只做投影正反算，不碰后三者的归算。
      verticalDatum: "未做垂直基准变换：本工具不用大地水准面/似大地水准面模型（无 EGM96/geoid 格网归算），不把椭球高当海拔，也不把来源高程归算到任何本地高程基准。第三位序数只在 zMeaning=\"elevation\" 时原样进入局部 z（是相对锚点 h 的椭球高差），depth/unknown 一律不进 z；高度缺失保持 null。",
      epoch: datum.operation.dynamicFrame || datum.operation.timeDependent
        ? `未做历元归算：这段运算与时间/历元相关（dynamicFrame=${datum.operation.dynamicFrame}, timeDependent=${datum.operation.timeDependent}），而本工具不接受观测历元参数，也不做板块运动/时间相关项——坐标里的时间变化没有被处理。`
        : "不适用：这段运算与时间无关（PROJ 报的候选里没有 FRAMEEPOCH 动态框架，管线里也没有 +t_epoch/+rate_*）。本工具不接受历元参数、不做板块运动归算。",
      note: "投影、基准事实与大地线全部由 PROJ 标准实现完成（本工具不含自造数值算法）；PROJ 缺失或失败会直接报 MAP_PROJ_UNAVAILABLE / MAP_PROJ_FAILED；基准运算不可靠（ballpark/缺格网/精度 unknown/动态框架）时默认直接报 MAP_DATUM_UNAVAILABLE，不静默换算法也不静默降精度。",
    },
    source: source.meta,
    sourceNotes: source.notes,
    anchor: {
      input: { form: anchor.input.form, values: anchor.input.values },
      geodetic: { lon: anchor.geodetic.lon, lat: anchor.geodetic.lat, h: anchor.geodetic.h },
      inSourceCrs: await geodeticToSource(crs, anchor.geodetic, projection),
    },
    localFrame: {
      origin: { lon: anchor.geodetic.lon, lat: anchor.geodetic.lat, h: anchor.geodetic.h },
      axes: { x: "east", y: "north", z: "up" },
      units: "meter",
      handedness: "right",
      note: "x=东、y=北、z=上（米），与场景的米制 Z-up 右手系一致；这是以锚点为切点的 ENU 局部帧，不从来源投影继承网格畸变。",
    },
    features: featuresOut,
    extent: {
      localMeters: { minE: extentLocal.minE, maxE: extentLocal.maxE, minN: extentLocal.minN, maxN: extentLocal.maxN, widthM, depthM },
      geodesic: {
        minLon: lonValues.length ? Math.min(...lonValues) : null, maxLon: lonValues.length ? Math.max(...lonValues) : null,
        lonSpanDeg: lonSpan, crossesAntimeridian,
        note: crossesAntimeridian
          ? "经度跨度是原始取值之差，跨 ±180 时它不代表真实东西向跨度；东西向尺寸请看 extent.localMeters.widthM（按最短路径换算得到）。"
          : "经纬度范围是来源坐标的事实记录；实际米制尺寸看 extent.localMeters。",
      },
    },
    heightSummary: {
      declaredMeaning: zMeaning,
      featuresWithSourceHeight: converted.features.length - missingHeight.length,
      featuresWithoutHeight: missingHeight,
      note: "缺高度的要素 height.meters 为 null：本工具不补、不猜建筑高度。要建体量请由模型决定用来源值（heightProperty）、照片/深度估计（明确标估计）或先检索公开尺寸；估计值不得混进实测栏。",
    },
    distortion: {
      method: "局部 ENU 帧水平距离 vs PROJ geod 的 WGS84 椭球大地线距离（Karney 算法，以锚点为起点）",
      sampleCount: samples,
      maxRelativeErrorPpm: maxRelativePpm,
      maxAbsoluteErrorM: maxAbsoluteM,
      farthest: { localMeters: farthestLocalM, geodesicMeters: farthestGeodesicM, scale: farthestGeodesicM > 0 ? farthestLocalM / farthestGeodesicM : null },
      note: "ENU 是切平面近似：从锚点出发的距离误差随距离约按 (d/2R)² 增长（1 km 约 1.2e-8，10 km 约 1.2e-6）；上面是**本批数据实测**的最大误差，不是理论口号。远处要素的米制尺寸请以 geodesic 值为准。",
      sourceCrsNote: crs.kind === "utm"
        ? "源 CRS 的网格米有固有比例差：中央经线 k=0.9996（−0.04%），带边缘（±3°）k≈1.00098（+0.098%）——两个方向都有，且带边缘是 **+0.098%** 而不是 0.04%（实测命令：printf '6 0\\n9 0\\n12 0\\n' | proj -S +proj=utm +zone=32 +ellps=WGS84 → 1.00098 / 0.9996 / 1.00098）。本工具的局部米制来自反投影后的椭球几何，不受该比例影响。"
        : crs.kind === "web-mercator"
          ? "源 CRS 的网格米比例因子为 1/cosφ（不是地面米），本工具的局部米制来自反投影后的椭球几何。"
          : "源 CRS 是经纬度：0.001° 纬度约 111.32 m，0.001° 经度约 111.32·cosφ m；由 PROJ 按椭球几何换算，不用固定比例。",
    },
    values: {
      measured: values.measured,
      estimated: values.estimated,
      derived: {
        note: "上面的范围、畸变、局部坐标都是**派生值**（由来源坐标换算得到），不与 measured 列混排；来源自报量在 features[].sourceMeasures 里原样保留。",
      },
    },
    eraAssertion: "not-asserted",
    warnings: [...warnings, ...source.notes],
    limits: { requestedMaxVertices: requestedMax, effectiveMaxVertices: maxVertices, hardMaxVertices: MAP_CONSTRAINTS_HARD_MAX_VERTICES, totalVertices: converted.totalVertices, includeVertices },
    reversible: {
      sourceCoordinatesKeptVerbatim: true,
      functions: ["localToSourceBatch(crs, anchorGeodetic, locals[])", "localToGeodeticBatch(anchorGeodetic, locals[])", "geodeticToSourceBatch(crs, geodetics[])", "localToSource(crs, anchorGeodetic, local)", "geodeticToSource(crs, geodetic)"],
      note: "features[].vertices[].source 是来源坐标原文，local 是同一顶点的局部米制坐标；反向换算用上面导出的函数（anchor 用 anchor.geodetic，crs 按 crs.declared 重新解析）——它们都是异步的（PROJ 子进程在等待期间不占事件循环），并可传同一个 MapProjContext 复用本次探到的运算、省掉重复 projinfo。顶点多时用批量的那几个：单点版每次都要起 PROJ 子进程。",
    },
    derivedFromSourceCoordinates: true,
    convertedAt,
  }) as Record<string, unknown>
}

/** 模型可见参数：crs 与 anchor 必填（不默认 4326、不默认原点）。 */
export const mapConstraintsParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Convert public GeoJSON points, lines and polygons to local ENU metre constraints using an explicitly declared CRS and local anchor. Return every vertex's original source coordinates and reversible local metre coordinates, actual bounds, unit information and measured projection distortion. Coordinate conversion only: no place/era disambiguation, inferred heights or state writes.",
    examples: [
      {
        path: "workspace/data/city-boundary.geojson",
        crs: "EPSG:4326",
        anchor: { lon: 8.5417, lat: 47.3769 },
        source: { page: "https://api3.geo.admin.ch/…", retrievedAt: "2026-09-20T04:16:00Z", object: "Zurich municipal boundary (source-reported year 2026)", era: { label: "2026", status: "unconfirmed" } },
      },
    ],
    properties: {
      path: { type: "string", description: "Local GeoJSON path, mutually exclusive with geojson. Resolve relative paths against the session workspace, consistently with native read/write/edit. If that workspace is unknown, report MAP_SESSION_CWD_UNKNOWN rather than falling back to the process startup directory. Fetch network sources into workspace files with web_fetch/download before passing them here." },
      geojson: { type: "json", description: "Inline GeoJSON object or JSON string, mutually exclusive with path. Supports FeatureCollection, Feature, geometry objects and GeometryCollection." },
      crs: { type: "string", required: true, description: "Explicit source CRS: EPSG:4326/OGC:CRS84/EPSG:4490, EPSG:3857, or EPSG:326zz/327zz (WGS84 UTM). Other CRSs, such as EPSG:2056, 27700 or 4214, are rejected with conversion guidance; they are never silently treated as 4326." },
      anchor: { type: "json", required: true, description: "Local origin: either {\"lon\":..,\"lat\":..} in WGS84 degrees or {\"x\":..,\"y\":..} in source-CRS coordinates, such as UTM easting/northing. Optional \"h\" gives height. Supplying both forms is ambiguous and rejected." },
      zMeaning: { oneOf: [{ type: "string", const: "elevation" }, { type: "string", const: "depth" }, { type: "string", const: "unknown" }], description: "Meaning of the third GeoJSON ordinate: elevation, depth, or unknown (default). Values not declared as elevation do not contribute local z. USGS hypocentre depth must not be treated as building height." },
      datumPolicy: { oneOf: [{ type: "string", const: "require-exact" }, { type: "string", const: "allow-ballpark" }], description: "Datum-operation policy; default require-exact. If PROJ offers only ballpark conversion, unknown accuracy, missing local grids or an epoch-dependent dynamic frame for the CRS pair, report MAP_DATUM_UNAVAILABLE with actionable guidance instead of silently returning ballpark numbers. Explicit allow-ballpark computes the values but reports PROJ's stated datumOperation.accuracy, often unknown; do not call it exact." },
      heightProperty: { type: "string", description: "Optional source-properties key to copy verbatim as height, such as height/hoehe. A missing or nonnumeric value remains a missing height (null); this tool does not infer it." },
      source: { type: "json", description: "Preserve source metadata verbatim: {page, url, retrievedAt, object, era:{label,status:\"confirmed\"|\"unconfirmed\"|\"unknown\"}, license, attribution, note}. An unconfirmed era always gives eraMatch=not-asserted; coordinate conversion is not place/era disambiguation." },
      declaredValues: { type: "array", items: { type: "json" }, description: "Caller-declared measurements/estimates to include: [{name,value,unit,basis:\"measured\"|\"estimated\",source?}]. Return them separately by basis. Missing basis is rejected; the tool does not classify it for you." },
      maxVertices: { type: "integer", description: "Vertex limit for this request; default 20000, hard maximum 200000. Crop by extent/properties first when larger." },
      includeVertices: { type: "boolean", description: "Whether to return per-vertex coordinates; default true. Set false for large data when only extent and distortion are needed." },
    },
  },
}

/** 交叉校对的一个来源：复用同一套来源元数据与 declaredValues 口径（不另立第二套来源结构）。 */
export interface MapCrossCheckSourceInput {
  /** 来源标识（自由文本，照抄）：用于在结论里指认"是哪一份不一致"。 */
  id?: unknown
  /** 来源类别（自由文本，照抄）：map / cad / photo / 尺寸表…；本工具不按类别给权重。 */
  kind?: unknown
  source?: MapConstraintsSourceInput
  /** 照片来源的相机事实（机型/焦距/位置/时间等）：**原样回显**；本工具不做摄影测量或相机标定。 */
  camera?: unknown
  declaredValues?: unknown
}

export interface MapCrossCheckInput {
  sources?: unknown
  /**
   * 容差必须由调用方显式声明：`{relativePpm?, absolute?}`（相对 ppm 与绝对量，单位随各条值自己的单位）。
   * 两个都给了就按更宽松的那个（满足任一即算在容差内）。**本工具不替调用方挑"多大算不一致"**：
   * 缺容差时同名多来源的比较结论恒为 unverifiable，而不是猜一个阈值。
   */
  tolerance?: unknown
}

const CROSS_CHECK_RULE = "只有【同名】【同单位】【同一对象（source.object 一致或都未声明）】【调用方给了容差】且【两个及以上来源可比】的量，偏离超出容差才判 conflict；其余一律 unverifiable 并说明原因。单位不同不换算，对象不同不比较。"

function parseCrossCheckTolerance(value: unknown): { relativePpm?: number; absolute?: number } | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("MAP_CROSS_CHECK_TOLERANCE_INVALID: tolerance 必须是对象 {relativePpm?, absolute?}（两个都不给等于没给）。")
  const row = value as { relativePpm?: unknown; absolute?: unknown }
  const tolerance: { relativePpm?: number; absolute?: number } = {}
  for (const key of ["relativePpm", "absolute"] as const) {
    const raw = row[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error(`MAP_CROSS_CHECK_TOLERANCE_INVALID: tolerance.${key} 必须是非负有限数字（收到 ${JSON.stringify(raw)}）。`)
    tolerance[key] = raw
  }
  return tolerance.relativePpm === undefined && tolerance.absolute === undefined ? null : tolerance
}

/** 相机事实原样回显：只接受 JSON 可序列化的对象/字符串/数字，别的一律报错（不塞函数、不猜字段）。 */
function jsonVerbatim(value: unknown, label: string): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`MAP_CROSS_CHECK_CAMERA_INVALID: ${label} 只接受对象/字符串/数字（原样回显），收到 ${Array.isArray(value) ? "数组" : typeof value}。`)
  try { return JSON.parse(JSON.stringify(value)) } catch { throw new Error(`MAP_CROSS_CHECK_CAMERA_INVALID: ${label} 不能 JSON 序列化，无法原样回显。`) }
}

/**
 * 多来源交叉校对（ENV-43）：把调用方声明的量按 name 对齐，给出可区分的结论并回查对象/年代/相机。
 * 只比对**已声明**的量：本工具不读图纸、不做摄影测量、不按来源类别给权重，也不替调用方解释冲突原因。
 */
export function crossCheckSources(input: MapCrossCheckInput, now: () => Date = () => new Date()): Record<string, unknown> {
  if (!Array.isArray(input?.sources) || input.sources.length === 0) {
    throw new Error('MAP_CROSS_CHECK_SOURCES_REQUIRED: 必须给 sources 数组：[{id?, kind?, source:{page,url,retrievedAt,object,era:{label,status}}, camera?, declaredValues:[{name,value,unit,basis,source?}]}]。')
  }
  if (input.sources.length > 32) throw new Error(`MAP_CROSS_CHECK_SOURCES_TOO_MANY: 一次最多 32 个来源（收到 ${input.sources.length}）。可采取的动作：先按对象/年代分组，分批比较。`)
  const tolerance = parseCrossCheckTolerance(input.tolerance)
  const sources = input.sources.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_CROSS_CHECK_SOURCE_INVALID: sources[${index}] 必须是对象。`)
    const row = raw as MapCrossCheckSourceInput
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `来源#${index + 1}`
    const kind = typeof row.kind === "string" && row.kind.trim() ? row.kind.trim() : null
    const preserved = preserveSourceMetadata(row.source)
    const values = splitDeclaredValues(row.declaredValues)
    return { id, kind, meta: preserved.meta, notes: preserved.notes, camera: jsonVerbatim(row.camera, `sources[${index}].camera`), entries: [...values.measured, ...values.estimated] }
  })
  const names = [...new Set(sources.flatMap(source => source.entries.map(entry => entry.name)))]
  const notes: string[] = []
  if (sources.some(source => source.entries.some(entry => entry.basis === "estimated")) && sources.some(source => source.entries.some(entry => entry.basis === "measured"))) {
    notes.push("同名量里 measured 与 estimated 并存：每条都按调用方声明的 basis 照实标注，本工具不把估计值升格成实测，也不因此改判结论。")
  }
  if (sources.some(source => source.camera !== null)) notes.push("相机事实原样回显（机型/焦距/位置/时间等）：本工具不做摄影测量与相机标定，由相机与像素推算的尺寸必须由调用方给出并声明 basis。")
  const eraOfSource = (source: { meta: Record<string, unknown> }): string => {
    const era = source.meta.era as { label: string | null; status: string | null } | undefined
    return era?.label ? `${era.label}（${era.status}）` : `未声明（${era?.status ?? "unknown"}）`
  }
  const rows = names.map(name => {
    const entries = sources.flatMap(source => source.entries.filter(entry => entry.name === name).map(entry => ({ source, entry })))
    const units = [...new Set(entries.map(item => item.entry.unit))]
    const objects = [...new Set(entries.map(item => (item.source.meta.object as string | null) ?? null))]
    const eras = [...new Set(entries.map(item => eraOfSource(item.source)))]
    const declaredObjects = objects.filter(object => object !== null)
    const objectMismatch = declaredObjects.length > 1
    const eraMismatch = eras.length > 1
    const reference = entries.find(item => item.entry.basis === "measured") ?? entries[0]!
    const comparisons = entries.map(item => {
      const delta = item.entry.value - reference.entry.value
      const relativePpm = reference.entry.value === 0 ? null : Math.abs(delta / reference.entry.value) * 1e6
      const withinAbsolute = tolerance?.absolute === undefined ? null : Math.abs(delta) <= tolerance.absolute
      const withinRelative = tolerance?.relativePpm === undefined || relativePpm === null ? null : relativePpm <= tolerance.relativePpm
      const bounds = [withinAbsolute, withinRelative].filter(value => value !== null) as boolean[]
      return {
        sourceId: item.source.id, kind: item.source.kind, value: item.entry.value, unit: item.entry.unit, basis: item.entry.basis, declaredBy: item.entry.source,
        deltaFromReference: Number(delta.toFixed(9)), relativePpmFromReference: relativePpm === null ? null : Number(relativePpm.toFixed(6)),
        withinTolerance: bounds.length ? bounds.some(Boolean) : null,
        camera: item.source.camera,
      }
    })
    const distinctUnits = units.filter(unit => unit !== null)
    let verdict: "agree" | "conflict" | "unverifiable", reason: string
    if (entries.length < 2) { verdict = "unverifiable"; reason = "single-source：只有一个来源声明了这条量，没有可比对象（不判冲突）。" }
    else if (distinctUnits.length > 1 || (distinctUnits.length === 1 && units.includes(null))) { verdict = "unverifiable"; reason = `unit-mismatch：单位不一致（${units.map(unit => unit ?? "未声明").join(" / ")}），本工具不做单位换算；请调用方换算成同一单位后再比。` }
    else if (objectMismatch) { verdict = "unverifiable"; reason = `subject-mismatch：来源声明的对象不同（${declaredObjects.join(" / ")}），先把对象确认成同一个再比（这不是数值冲突）。` }
    else if (!tolerance) { verdict = "unverifiable"; reason = "tolerance-missing：没有声明容差，本工具不替调用方挑阈值；请给出 tolerance.relativePpm 或 tolerance.absolute。" }
    else if (comparisons.some(item => item.withinTolerance === false)) { verdict = "conflict"; reason = `deviation-exceeds-tolerance：偏离超出调用方声明的容差（${JSON.stringify(tolerance)}）。` }
    else { verdict = "agree"; reason = "within-tolerance：全部可比来源都在调用方声明的容差内。" }
    const outlier = comparisons.find(item => item.sourceId !== reference.source.id && item.withinTolerance === false)
    return {
      name, unit: units.length === 1 ? units[0] : units, verdict, reason,
      reference: { sourceId: reference.source.id, value: reference.entry.value, unit: reference.entry.unit, basis: reference.entry.basis },
      comparisons,
      backQuery: {
        ids: entries.map(item => item.source.id), kinds: entries.map(item => item.source.kind), objects, eras,
        pages: [...new Set(entries.map(item => (item.source.meta.page as string | null) ?? null))],
        urls: [...new Set(entries.map(item => (item.source.meta.url as string | null) ?? null))],
        retrievedAt: entries.map(item => (item.source.meta.retrievedAt as string | null) ?? null),
        cameras: entries.map(item => item.source.camera),
        declaredBy: entries.map(item => item.entry.source),
        objectMismatch, eraMismatch,
      },
      note: verdict === "conflict"
        ? `冲突只说明"这些来源在这条量上不一致"（最远偏离 ${outlier ? `${outlier.deltaFromReference} ${reference.entry.unit ?? "单位未声明"}` : "见 comparisons"}），不解释原因${eraMismatch ? `；两来源年代不同（${eras.join(" / ")}），先回查要哪个年代` : ""}${comparisons.some(item => item.basis === "estimated") ? "；其中含 estimated 值，先回查它是怎么得来的（见 camera/declaredBy）" : ""}。`
        : verdict === "agree"
          ? "一致不等于来源独立：若两条出自同一页/同一次测量，一致性只说明复述没错（见 backQuery.pages）。"
          : reason,
    }
  })
  const conflicts = rows.filter(row => row.verdict === "conflict").map(row => row.name)
  return jsonSafe({
    tool: "map_cross_check_sources",
    ok: true,
    comparisonRule: CROSS_CHECK_RULE,
    tolerance: tolerance ?? null,
    sourceCount: sources.length,
    sources: sources.map(source => ({
      id: source.id, kind: source.kind, object: source.meta.object, era: source.meta.era, page: source.meta.page, url: source.meta.url,
      retrievedAt: source.meta.retrievedAt, license: source.meta.license, camera: source.camera,
      values: source.entries.map(entry => ({ name: entry.name, value: entry.value, unit: entry.unit, basis: entry.basis, declaredBy: entry.source })),
      sourceNotes: source.notes,
    })),
    values: rows,
    summary: {
      names: rows.length,
      agreed: rows.filter(row => row.verdict === "agree").length,
      conflicted: conflicts.length,
      unverifiable: rows.filter(row => row.verdict === "unverifiable").length,
      conflicts,
    },
    backQuery: {
      objects: [...new Set(sources.map(source => (source.meta.object as string | null) ?? null))],
      eras: [...new Set(sources.map(eraOfSource))],
      cameras: sources.filter(source => source.camera !== null).map(source => ({ sourceId: source.id, camera: source.camera })),
      note: "回查顺序：先按 object 确认是同一个对象，再看 era 确认要哪个年代，最后看 camera/declaredBy 确认这条量是怎么得到的。",
    },
    eraAssertion: "not-asserted",
    notes: [...notes, ...sources.flatMap(source => source.notes.map(note => `${source.id}：${note}`))],
    checkedAt: now().toISOString(),
  }) as Record<string, unknown>
}

/** 模型可见参数：交叉校对只比对调用方声明的量，不读图纸、不做摄影测量、不换单位。 */
export const mapCrossCheckParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Cross-check the same caller-declared quantity from two or more map/CAD/photo/public-dimension sources by name. With matching name, unit and object and an explicit tolerance, deviations beyond tolerance are conflict; otherwise agree. Insufficient conditions produce unverifiable. Do not convert units, guess tolerances or weight sources by category. Return back-query facts for object, era and camera verbatim.",
    properties: {
      sources: { type: "array", required: true, description: "Source array (1-32): [{id?, kind?(map|cad|photo|... free text), source:{page,url,retrievedAt,object,era:{label,status:\"confirmed\"|\"unconfirmed\"|\"unknown\"}}, camera?, declaredValues:[{name,value,unit,basis:\"measured\"|\"estimated\",source?}]}]." },
      tolerance: { type: "json", required: true, description: "Required caller-selected tolerance: {relativePpm?:nonnegative number, absolute?:nonnegative number}. If both are provided, use the more permissive one. Without tolerance, same-name comparisons remain unverifiable." },
    },
  },
}

/** 字段级融合的输入：来源结构与交叉校对的 `sources` 完全一致（复用同一套口径，不另立来源结构）。 */
export interface MapFusionInput {
  sources?: unknown
  /** 目标：{object?, era?:{label,status}}。target.object 与 target.era 是**核对基准**，不是"标准答案"。 */
  target?: unknown
  /** 要融合的字段清单（省略时取所有来源声明过的 name 的并集）：[{name, unit?, required?}]。 */
  fields?: unknown
  tolerance?: unknown
}

const FUSION_RULE = "字段级融合判据（写死；kind 只是标识，**不按来源类别给权重**）：① 候选只看同名、同单位、同一对象（source.object 与 target.object 一致；都未声明视为一致）；② target.era 已声明时，era.label 与 target 不同的候选**排除**并回查年代（eraMismatch），不静默合并；③ 单位不同或对象不同 → 该候选 not-comparable（不换算、不比较、不进入取值）；④ 可比候选按 basis 排序：measured 优先于 estimated（basis 由调用方声明）；⑤ 同 basis 内超容差分歧 → status=conflict-unresolved：value=null，**不取平均/中位数，也不按来源类别裁决**，必须回查对象/年代/相机/来源页后再定；⑥ 容差内一致或只有一条可比 → status=adopted：取 basis 最高的一条，同 basis 多条一致时取输入顺序第一条（一致候选全部列出）；⑦ 没有可比候选 → status=missing：value=null，**不补不猜**；⑧ 容差缺失 → status=unverifiable（tolerance-missing），value=null。"

/**
 * 字段级融合（ENV-15）：CAD + 照片 + 地图等多来源的**声明字段**按 name 融合成一份逐字段结果，
 * 每个字段给 取值/来源类别与 id/依据/冲突状态/回查项；采信只看依据（basis + 年代 + 对象 + 容差），
 * 不按来源类别写死，也不在冲突时静默取平均。
 */
export function fuseDeclaredFields(input: MapFusionInput, now: () => Date = () => new Date()): Record<string, unknown> {
  if (!Array.isArray(input?.sources) || input.sources.length === 0) throw new Error("MAP_FUSION_SOURCES_REQUIRED: 必须给 sources 数组（与 map_cross_check_sources 同一结构）。")
  if (input.sources.length > 32) throw new Error(`MAP_FUSION_SOURCES_TOO_MANY: 一次最多 32 个来源（收到 ${input.sources.length}）。`)
  const tolerance = parseCrossCheckTolerance(input.tolerance)
  const targetRow = (input.target ?? {}) as { object?: unknown; era?: { label?: unknown; status?: unknown } }
  const targetObject = typeof targetRow.object === "string" && targetRow.object.trim() ? targetRow.object.trim() : null
  const targetEra = (() => {
    const era = targetRow.era
    if (era === undefined || era === null) return null
    if (typeof era !== "object" || Array.isArray(era)) throw new Error("MAP_FUSION_TARGET_ERA_INVALID: target.era 必须是对象 {label,status}。")
    const label = typeof era.label === "string" && era.label.trim() ? era.label.trim() : null
    const status = era.status === "confirmed" || era.status === "unconfirmed" || era.status === "unknown" ? era.status : null
    if (label === null || status === null) throw new Error("MAP_FUSION_TARGET_ERA_INVALID: target.era 需要 label 与 status（confirmed/unconfirmed/unknown）。可采取的动作：要么给全，要么整个省略——省略时不做年代排除。")
    return { label, status }
  })()
  const sources = input.sources.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_FUSION_SOURCE_INVALID: sources[${index}] 必须是对象。`)
    const row = raw as MapCrossCheckSourceInput
    const preserved = preserveSourceMetadata(row.source)
    const values = splitDeclaredValues(row.declaredValues)
    return {
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `来源#${index + 1}`,
      kind: typeof row.kind === "string" && row.kind.trim() ? row.kind.trim() : null,
      meta: preserved.meta, notes: preserved.notes,
      camera: jsonVerbatim(row.camera, `sources[${index}].camera`),
      order: index,
      entries: [...values.measured, ...values.estimated],
    }
  })
  const requestedFields = (() => {
    if (input.fields === undefined || input.fields === null) return null
    if (!Array.isArray(input.fields)) throw new Error("MAP_FUSION_FIELDS_INVALID: fields 必须是数组：[{name, unit?, required?}]。")
    return input.fields.map((item, index) => {
      const row = (item ?? {}) as { name?: unknown; unit?: unknown; required?: unknown }
      if (typeof row.name !== "string" || !row.name.trim()) throw new Error(`MAP_FUSION_FIELDS_INVALID: fields[${index}] 需要 name 字符串。`)
      return { name: row.name.trim(), unit: typeof row.unit === "string" ? row.unit : null, required: row.required === true }
    })
  })()
  const declaredNames = sources.flatMap(source => source.entries.map(entry => entry.name))
  const fieldNames = requestedFields ? [...new Set([...requestedFields.map(field => field.name), ...declaredNames])] : [...new Set(declaredNames)]
  const eraOf = (meta: Record<string, unknown>): string => {
    const era = meta.era as { label: string | null; status: string | null } | undefined
    return era?.label ? `${era.label}（${era.status}）` : `未声明（${era?.status ?? "unknown"}）`
  }
  const notes: string[] = []
  if (sources.some(source => source.camera !== null)) notes.push("相机事实原样回显（机型/焦距/位置/时间等）：本工具不做摄影测量与相机标定；由相机与像素推算的量必须由调用方声明 basis。")
  if (targetEra === null) notes.push("未声明 target.era：本次**没有**做年代排除（无法判断哪个候选属于目标年代）；要给年代核对请传 target.era={label,status}。")
  const fields = fieldNames.map(name => {
    const requested = requestedFields?.find(field => field.name === name)
    const entries = sources.flatMap(source => source.entries.filter(entry => entry.name === name).map(entry => ({ source, entry })))
    const units = [...new Set(entries.map(item => item.entry.unit))]
    const candidates = entries.map(item => {
      const object = (item.source.meta.object as string | null) ?? null
      const era = eraOf(item.source.meta)
      const sourceEra = item.source.meta.era as { label: string | null; status: string | null } | undefined
      const objectsDiffer = targetObject !== null && object !== null && object !== targetObject
      const eraOut = targetEra !== null && sourceEra?.label != null && sourceEra.label !== targetEra.label
      const unitMismatch = units.length > 1 || (units.length === 1 && units.includes(null) && requested?.unit != null && requested.unit !== units[0])
      const excludedBecause = unitMismatch
        ? `unit-mismatch：单位不一致（${units.map(unit => unit ?? "未声明").join(" / ")}），本工具不换算。`
        : objectsDiffer
          ? `subject-mismatch：来源对象「${object}」与目标对象「${targetObject}」不同。`
          : eraOut
            ? `era-mismatch：来源年代 ${era} 与目标年代 ${targetEra!.label}（${targetEra!.status}）不同。`
            : null
      return {
        sourceId: item.source.id, kind: item.source.kind, value: item.entry.value, unit: item.entry.unit, basis: item.entry.basis, declaredBy: item.entry.source,
        object, era, sourceEraStatus: sourceEra?.status ?? null, camera: item.source.camera,
        comparable: excludedBecause === null, excludedBecause, order: item.source.order,
      }
    })
    const comparable = candidates.filter(candidate => candidate.comparable)
    const excluded = candidates.filter(candidate => !candidate.comparable)
    const objectMismatch = excluded.some(candidate => candidate.excludedBecause?.startsWith("subject-mismatch"))
    const eraMismatch = excluded.some(candidate => candidate.excludedBecause?.startsWith("era-mismatch"))
    const backQuery = {
      ids: candidates.map(candidate => candidate.sourceId), kinds: candidates.map(candidate => candidate.kind),
      objects: [...new Set(candidates.map(candidate => candidate.object))], eras: [...new Set(candidates.map(candidate => candidate.era))],
      pages: [...new Set(entries.map(item => (item.source.meta.page as string | null) ?? null))],
      retrievedAt: entries.map(item => (item.source.meta.retrievedAt as string | null) ?? null),
      cameras: candidates.filter(candidate => candidate.camera !== null).map(candidate => ({ sourceId: candidate.sourceId, camera: candidate.camera })),
      declaredBy: candidates.map(candidate => candidate.declaredBy), objectMismatch, eraMismatch,
      action: excluded.length
        ? `先回查被排除的候选：${excluded.map(candidate => `${candidate.sourceId}（${candidate.excludedBecause}）`).join("；")}`
        : "没有候选因对象/年代/单位被排除；如仍冲突，按 basis 与 sources[].page/declaredBy/camera 逐条核对原始依据。",
    }
    const basisRank = (basis: string): number => basis === "measured" ? 0 : 1
    const ordered = [...comparable].sort((a, b) => basisRank(a.basis) - basisRank(b.basis) || a.order - b.order)
    const reference = ordered[0] ?? null
    const spread = comparable.length >= 2 ? Math.max(...comparable.map(candidate => candidate.value)) - Math.min(...comparable.map(candidate => candidate.value)) : 0
    const spreadPpm = reference && reference.value !== 0 ? Math.abs(spread / reference.value) * 1e6 : null
    const comparisons = comparable.map(candidate => {
      const delta = reference ? candidate.value - reference.value : 0
      const relativePpm = reference && reference.value !== 0 ? Math.abs(delta / reference.value) * 1e6 : null
      const withinAbsolute = tolerance?.absolute === undefined ? null : Math.abs(delta) <= tolerance.absolute
      const withinRelative = tolerance?.relativePpm === undefined || relativePpm === null ? null : relativePpm <= tolerance.relativePpm
      const bounds = [withinAbsolute, withinRelative].filter(value => value !== null) as boolean[]
      return { ...candidate, deltaFromReference: Number(delta.toFixed(9)), relativePpmFromReference: relativePpm === null ? null : Number(relativePpm.toFixed(6)), withinTolerance: bounds.length ? bounds.some(Boolean) : null }
    })
    const outliers = comparisons.filter(candidate => candidate.withinTolerance === false && candidate.sourceId !== reference?.sourceId)
    let status: "adopted" | "conflict-unresolved" | "missing" | "unverifiable", value: number | null = null, adoptedFrom: Record<string, unknown> | null = null, reason: string
    if (comparable.length === 0) {
      status = "missing"
      reason = entries.length === 0
        ? "missing：没有任何来源声明这个字段 → **不补不猜**，value=null。"
        : `missing：${entries.length} 个候选全部不可比（${excluded.map(candidate => candidate.excludedBecause).join("；")}）→ 不产出取值。`
    } else if (!tolerance) {
      status = "unverifiable"; reason = "tolerance-missing：没有声明容差，本工具不替调用方挑阈值；请给 tolerance.relativePpm 或 tolerance.absolute。"
    } else if (outliers.length > 0) {
      status = "conflict-unresolved"
      reason = `conflict-unresolved：可比候选在容差 ${JSON.stringify(tolerance)} 内不一致（极差 ${Number(spread.toFixed(9))}${reference?.unit ? ` ${reference.unit}` : ""}${spreadPpm === null ? "" : `，${Number(spreadPpm.toFixed(2))} ppm`}）→ **不取平均/中位数、不按来源类别裁决**，value=null；先回查 ${outliers.map(candidate => candidate.sourceId).join("、")} 与 backQuery。`
    } else {
      status = "adopted"; value = reference!.value
      adoptedFrom = { sourceId: reference!.sourceId, kind: reference!.kind, basis: reference!.basis, unit: reference!.unit, era: reference!.era, object: reference!.object, declaredBy: reference!.declaredBy, camera: reference!.camera }
      reason = `adopted-by-evidence：可比候选都在容差内；取 basis 最高的「${reference!.basis}」候选（kind=${reference!.kind ?? "未声明"}，仅作标识，不参与排序）。${comparable.length > 1 ? `另外 ${comparable.length - 1} 条一致候选见 candidates（同 basis 一致时按输入顺序取第一条）。` : ""}`
    }
    return {
      name, unit: requested?.unit ?? (units.length === 1 ? units[0] : units), required: requested?.required ?? false,
      status, value, adoptedFrom, reason,
      conflict: { detected: status === "conflict-unresolved", spread: Number(spread.toFixed(9)), spreadPpm: spreadPpm === null ? null : Number(spreadPpm.toFixed(2)), outliers: outliers.map(candidate => candidate.sourceId), averaging: "forbidden-by-rule" },
      candidates: [...comparisons, ...excluded.map(candidate => ({ ...candidate, deltaFromReference: null, relativePpmFromReference: null, withinTolerance: null }))] as Array<Record<string, unknown>>,
      backQuery,
      note: status === "conflict-unresolved"
        ? "冲突不静默：本字段没有取值（value=null）。规则原文见 fusionRule ⑤——不取平均、不按类别裁决；回查顺序：对象 → 年代 → 相机/declaredBy。"
        : status === "adopted"
          ? "取值按依据（basis + 年代 + 对象 + 容差），不按来源类别；若两条一致候选出自同一页/同一次测量，一致性只说明复述没错（见 backQuery.pages）。"
          : status === "missing" ? "缺项不编：value=null，规则原文见 fusionRule ⑦。" : reason,
    }
  })
  const needBackQuery = fields.filter(field => field.status === "conflict-unresolved" || field.backQuery.objectMismatch || field.backQuery.eraMismatch).map(field => field.name)
  return jsonSafe({
    tool: "map_fuse_fields",
    ok: true,
    fusionRule: FUSION_RULE,
    tolerance: tolerance ?? null,
    target: { object: targetObject, era: targetEra },
    sourceCount: sources.length,
    sources: sources.map(source => ({
      id: source.id, kind: source.kind, object: source.meta.object, era: source.meta.era, page: source.meta.page, url: source.meta.url,
      retrievedAt: source.meta.retrievedAt, license: source.meta.license, camera: source.camera,
      values: source.entries.map(entry => ({ name: entry.name, value: entry.value, unit: entry.unit, basis: entry.basis, declaredBy: entry.source })),
      sourceNotes: source.notes,
    })),
    fields,
    summary: {
      fieldCount: fields.length,
      adopted: fields.filter(field => field.status === "adopted").length,
      conflictUnresolved: fields.filter(field => field.status === "conflict-unresolved").length,
      missing: fields.filter(field => field.status === "missing").length,
      unverifiable: fields.filter(field => field.status === "unverifiable").length,
      needBackQuery,
    },
    missingPolicy: "缺高度等缺字段一律 status=missing、value=null：本工具不补、不猜、不沿用别的来源的猜测值（见 fusionRule ⑦）。",
    eraAssertion: "not-asserted",
    notes: [...notes, ...sources.flatMap(source => source.notes.map(note => `${source.id}：${note}`))],
    fusedAt: now().toISOString(),
  }) as Record<string, unknown>
}

/** 模型可见参数：字段级融合只吃**调用方声明的字段**，不读图纸、不做摄影测量、不换算单位。 */
export const mapFusionParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Fuse caller-declared fields from CAD/photos/maps/public dimensions by name. For each field return the value, source category/id, basis including era/object/tolerance, conflict status and back-query items. Evaluate evidence rather than source-category weights. Do not silently merge different eras. Conflicts produce value=null, not a mean/median; do not infer missing fields.",
    properties: {
      sources: { type: "array", required: true, description: "Same structure as map_cross_check_sources: [{id?, kind?(cad|photo|map|... free text), source:{page,url,retrievedAt,object,era:{label,status}}, camera?, declaredValues:[{name,value,unit,basis:\"measured\"|\"estimated\",source?}]}]." },
      target: { type: "json", description: "Optional target for checking: {object?, era?:{label,status}}. target.object excludes candidates for another object; target.era excludes other eras with an eraMismatch back-query. Omitted targets do not cause exclusions, and the result reports that fact." },
      fields: { type: "array", description: "Optional fields to fuse: [{name, unit?, required?}]. When omitted, use the union of names declared across sources." },
      tolerance: { type: "json", required: true, description: "Required tolerance: {relativePpm?, absolute?}. Without it, status remains unverifiable; the tool does not select a threshold." },
    },
  },
}

/** ENV-41 地点/年代消歧 + 边界/相邻地标核对：候选与目标都由调用方给，本工具只做**可复算的比对**。 */
export interface MapPlaceCheckInput {
  place?: unknown
  candidates?: unknown
  target?: unknown
  boundary?: unknown
  /** 只做地标测量（不做内外判定）时给的局部米制帧：{crs, anchor}（与 boundary 的 crs/anchor 同一口径）。 */
  frame?: unknown
  landmarks?: unknown
}

const PLACE_RULE = "地名消歧判据（写死）：① 候选只按名称/别名匹配（去空白、大小写不敏感）；② **只有调用方给的证据（target.era 或 target.identity 的键值）能唯一筛出一个候选时才 resolved-by-evidence**，并逐字回显用到的证据；③ 筛不出唯一候选（含没有候选、多个候选、证据不足、证据把候选筛空）一律 ambiguous/no-candidate，chosen=null，并列出每个候选要回查什么——本工具**不擅自选定**；④ 只记录同名候选之间**真实存在的身份/坐标差异**（sameNameDifferentIdentity / sameNameDifferentCoordinates + 具体键），不替调用方判「哪个才是对的」。"
const ERA_RULE = "年代核对判据（写死）：target.era 已声明时，era.label 与之不同的候选标 era-mismatch **并排除出候选集**，backQuery.eras 列出全部出现过的年代供回查；target.era 未声明时**显式写「未做年代排除」**，不得据年代排除任何候选。"
const BOUNDARY_RULE = "边界核对判据（写死）：把点与边界放进**同一个局部 ENU 米制帧**（复用 map_geojson_to_local 的 CRS/锚点/投影口径）；内外用射线法（外环计入、role=hole 扣除）；距离取到最近边界线段的米数（外环+洞都算）；|距离| ≤ toleranceM 记 on-boundary；inside 与 outside 都必须明确报出（越界不得静默算成在范围内）。"
const LANDMARK_RULE = "相邻地标判据（写死）：只做**测量**（到目标点的距离米数 + 从正北顺时针的方位角 + 是否在边界内）并与调用方声明的 expected（withinM / bearingDeg±bearingToleranceDeg / inside）逐条比对；expected 没给就只报测量、不下结论；不匹配时列出回查项（地标名称与坐标、来源页、目标地点与年代），不说「哪个错了」。"
const BOUNDARY_UNAVAILABLE = "boundary-unavailable：本次没有可用的边界几何（未给 boundary.path/geojson，或 CRS/锚点不全）→ 不做内外判定，也不假设任何点在边界内。"

/** 射线法：点 (x,y) 是否在给定环内（环坐标是局部米制、含闭合点）。 */
function pointInRing(ring: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点到线段的距离（米，同一局部帧内）。 */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * ENV-41：地点名/年代消歧（①②）+ 边界核对（③）+ 相邻地标核对（④）。
 * 全部复用既有口径：`preserveSourceMetadata()` 的来源元数据、`mapGeoJsonToLocal()` 的 CRS/锚点/米制局部帧；
 * 不新增坐标系实现，判据原文随结果返回，缺证据时只报"要回查什么"。
 */
export async function checkPlace(input: MapPlaceCheckInput, dependencies: MapConstraintsDependencies = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const placeRow = (input?.place ?? {}) as { name?: unknown; aliases?: unknown; note?: unknown }
  const declaredName = typeof placeRow.name === "string" && placeRow.name.trim() ? placeRow.name.trim() : null
  if (declaredName === null) throw new Error('MAP_PLACE_NAME_REQUIRED: 必须给 place.name（要消歧的地名）。可采取的动作：把用户说的地名原样传入（别名可放 place.aliases）。')
  const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase()
  const aliases = Array.isArray(placeRow.aliases) ? placeRow.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map(normalize) : []
  const wantedNames = [normalize(declaredName), ...aliases]
  const targetRow = (input?.target ?? {}) as { era?: { label?: unknown; status?: unknown }; identity?: Record<string, unknown>; note?: unknown }
  const targetEra = (() => {
    const era = targetRow.era
    if (era === undefined || era === null) return null
    const label = typeof era.label === "string" && era.label.trim() ? era.label.trim() : null
    const status = era.status === "confirmed" || era.status === "unconfirmed" || era.status === "unknown" ? era.status : null
    if (label === null || status === null) throw new Error('MAP_PLACE_TARGET_ERA_INVALID: target.era 需要 label 与 status（confirmed/unconfirmed/unknown），或整个省略（省略时不做年代排除）。')
    return { label, status }
  })()
  const targetIdentity = targetRow.identity && typeof targetRow.identity === "object" && !Array.isArray(targetRow.identity) ? targetRow.identity as Record<string, unknown> : null
  if (!Array.isArray(input?.candidates)) throw new Error("MAP_PLACE_CANDIDATES_REQUIRED: 必须给 candidates 数组：[{id,name,identity?,era?,coordinate?,page?}]。")
  if (input.candidates.length > 64) throw new Error(`MAP_PLACE_CANDIDATES_TOO_MANY: 一次最多 64 个候选（收到 ${input.candidates.length}）。`)
  const candidates = input.candidates.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_PLACE_CANDIDATE_INVALID: candidates[${index}] 必须是对象。`)
    const row = raw as { id?: unknown; name?: unknown; identity?: Record<string, unknown>; era?: { label?: unknown; status?: unknown }; coordinate?: { lon?: unknown; lat?: unknown }; page?: unknown; url?: unknown; note?: unknown }
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : name ?? `候选#${index + 1}`
    const era = row.era && typeof row.era.label === "string" && row.era.label.trim()
      ? { label: row.era.label.trim(), status: row.era.status === "confirmed" || row.era.status === "unconfirmed" || row.era.status === "unknown" ? row.era.status : "unknown" }
      : null
    const coordinate = row.coordinate && typeof row.coordinate.lon === "number" && typeof row.coordinate.lat === "number" && Number.isFinite(row.coordinate.lon) && Number.isFinite(row.coordinate.lat)
      ? { lon: row.coordinate.lon as number, lat: row.coordinate.lat as number } : null
    const identity = row.identity && typeof row.identity === "object" && !Array.isArray(row.identity) ? row.identity as Record<string, unknown> : null
    const nameMatches = name !== null && wantedNames.includes(normalize(name))
    const eraMismatch = targetEra !== null && era !== null && era.label !== targetEra.label
    const identityEvidence = targetIdentity === null || identity === null
      ? []
      : Object.entries(targetIdentity).filter(([key, value]) => identity[key] !== undefined && String(identity[key]) === String(value)).map(([key]) => key)
    const identityConflicts = targetIdentity === null || identity === null
      ? []
      : Object.entries(targetIdentity).filter(([key, value]) => identity[key] !== undefined && String(identity[key]) !== String(value)).map(([key, value]) => `${key}=${String(identity[key])}≠${String(value)}`)
    return { id, name, nameMatches, era, identity, coordinate, page: typeof row.page === "string" ? row.page : null, url: typeof row.url === "string" ? row.url : null, note: typeof row.note === "string" ? row.note : null, eraMismatch, identityEvidence, identityConflicts }
  })
  const nameMatched = candidates.filter(candidate => candidate.nameMatches)
  // ② 年代核对：target.era 已声明 → 排除 era-mismatch 候选；未声明 → 显式"未做年代排除"
  const eraExcluded = targetEra === null ? [] : nameMatched.filter(candidate => candidate.eraMismatch)
  const afterEra = targetEra === null ? nameMatched : nameMatched.filter(candidate => !candidate.eraMismatch)
  // ① 消歧：只有证据唯一筛出一个才算 resolved
  const evidenceUsed = targetEra === null && targetIdentity === null ? [] : [
    ...(targetEra === null ? [] : [`target.era=${targetEra.label}（${targetEra.status}）`]),
    ...(targetIdentity === null ? [] : Object.entries(targetIdentity).map(([key, value]) => `target.identity.${key}=${String(value)}`)),
  ]
  const survivors = targetIdentity === null ? afterEra : afterEra.filter(candidate => candidate.identityConflicts.length === 0)
  let placeStatus: "no-candidate" | "ambiguous" | "resolved-by-evidence" | "single-candidate", chosen: Record<string, unknown> | null = null, placeReason: string
  if (nameMatched.length === 0) {
    placeStatus = "no-candidate"; placeReason = `no-candidate：没有任何候选的名称/别名匹配「${declaredName}」（${candidates.length} 个候选都不匹配）→ chosen=null。要回查：候选名称是否用了别名/旧名，或补一份候选清单（含 page/坐标）。`
  } else if (survivors.length === 1 && evidenceUsed.length === 0 && nameMatched.length === 1) {
    // 只有一个同名候选：采用它靠的是"没有竞争者"这个事实，不是身份判定——仍然把要回查的项列全。
    placeStatus = "single-candidate"; chosen = { id: survivors[0]!.id, name: survivors[0]!.name, because: ["no-competing-candidate（同名候选只有一个）"], era: survivors[0]!.era, identity: survivors[0]!.identity, page: survivors[0]!.page }
    placeReason = "single-candidate：名称/别名只匹配到一个候选，没有可消歧的竞争者 → 采用它（依据是唯一性，不是身份判定）；仍按 whatToQuery 回查后才能当作事实。"
  } else if (survivors.length === 1 && evidenceUsed.length > 0) {
    placeStatus = "resolved-by-evidence"; chosen = { id: survivors[0]!.id, name: survivors[0]!.name, because: evidenceUsed, era: survivors[0]!.era, identity: survivors[0]!.identity, page: survivors[0]!.page }
    placeReason = `resolved-by-evidence：用到的证据 ${evidenceUsed.join("、")} 唯一筛出一个候选；其余 ${nameMatched.length - 1} 个同名候选被排除（见 candidatesExcluded）。`
  } else {
    placeStatus = "ambiguous"
    placeReason = survivors.length === 0
      ? `ambiguous：给的证据（${evidenceUsed.join("、")}）把同名候选**筛空了**（0 个满足）→ chosen=null；先回查证据本身对不对（年代/身份键）。`
      : `ambiguous：同名候选有 ${survivors.length} 个满足现有证据${evidenceUsed.length ? `（${evidenceUsed.join("、")}）` : "（本次没有任何辨别证据）"} → chosen=null，**不擅自选定**；按 whatToQuery 回查后再定。`
  }
  const identityKeys = ["gde_hist_id", "gde_nr", "jahr", "is_current_jahr"]
  const differingIdentityKeys = [...new Set(nameMatched.flatMap(candidate => Object.keys(candidate.identity ?? {})))]
    .filter(key => new Set(nameMatched.map(candidate => JSON.stringify(candidate.identity?.[key] ?? null))).size > 1)
  const coordinateKeys = new Set(nameMatched.map(candidate => candidate.coordinate ? `${candidate.coordinate.lon},${candidate.coordinate.lat}` : "null"))
  const placeSection = {
    declaredName, aliases, candidateCount: candidates.length, nameMatchedCount: nameMatched.length,
    status: placeStatus, chosen, reason: placeReason, evidenceUsed,
    sameNameDifferentIdentity: differingIdentityKeys.length > 0,
    sameNameDifferentCoordinates: coordinateKeys.size > 1,
    differingIdentityKeys, knownIdentityKeysHint: identityKeys,
    candidates: candidates.map(candidate => ({
      id: candidate.id, name: candidate.name, nameMatches: candidate.nameMatches, era: candidate.era, identity: candidate.identity, coordinate: candidate.coordinate,
      eraMismatch: candidate.eraMismatch, identityEvidence: candidate.identityEvidence, identityConflicts: candidate.identityConflicts, page: candidate.page, url: candidate.url, note: candidate.note,
      whatToQuery: [
        candidate.era === null ? "era（来源年代未声明）" : null,
        candidate.identity === null ? "identity（身份键缺失）" : `identity（现有键：${Object.keys(candidate.identity).join("/")}）`,
        candidate.coordinate === null ? "coordinate（候选没有坐标，无法算同名异地距离）" : "coordinate（可按坐标核对是否同一地点）",
        candidate.page === null ? "page/url（候选没有来源页，无法回溯）" : null,
      ].filter(Boolean),
    })),
    candidatesExcluded: nameMatched.filter(candidate => !survivors.includes(candidate)).map(candidate => ({
      id: candidate.id,
      because: candidate.eraMismatch ? `era-mismatch：候选年代 ${candidate.era?.label}（${candidate.era?.status}）与 target.era ${targetEra?.label}（${targetEra?.status}）不同` : candidate.identityConflicts.length ? `identity-conflict：${candidate.identityConflicts.join("、")}` : "clash：与另一个候选同时满足现有证据（证据不足以区分）",
    })),
    rule: PLACE_RULE,
  }
  const eraSection = {
    targetEra, declared: targetEra !== null,
    excluded: eraExcluded.map(candidate => ({ id: candidate.id, era: candidate.era, because: `era-mismatch：${candidate.era?.label}（${candidate.era?.status}）与 target.era ${targetEra?.label}（${targetEra?.status}）不同` })),
    backQuery: { eras: [...new Set(candidates.filter(candidate => candidate.nameMatches).map(candidate => candidate.era?.label ?? "未声明"))], eraMismatch: eraExcluded.length > 0 },
    note: targetEra === null
      ? "未声明 target.era：本次**没有做年代排除**（不得据年代排除任何候选）；要给年代核对请传 target.era={label,status}。"
      : eraExcluded.length ? `已按 target.era=${targetEra.label}（${targetEra.status}）排除 ${eraExcluded.length} 个年代不同的同名候选，并列入 backQuery.eras 供回查。` : "所有同名候选的年代都与 target.era 一致：没有候选因年代被排除。",
    rule: ERA_RULE,
  }
  // ③④：边界与地标共用一次 map_geojson_to_local（同一 CRS/锚点/局部帧；没有边界几何时可用 frame 只做地标测量）
  const boundaryRow = (input?.boundary ?? null) as { path?: unknown; geojson?: unknown; crs?: unknown; anchor?: unknown; coordinate?: { lon?: unknown; lat?: unknown; name?: unknown }; toleranceM?: unknown } | null
  const frameRow = (input?.frame ?? null) as { crs?: unknown; anchor?: unknown } | null
  const landmarksRaw = Array.isArray(input?.landmarks) ? input.landmarks : []
  const toleranceM = boundaryRow && typeof boundaryRow.toleranceM === "number" && Number.isFinite(boundaryRow.toleranceM) && boundaryRow.toleranceM >= 0 ? boundaryRow.toleranceM : 0
  const targetPoint = boundaryRow?.coordinate && typeof boundaryRow.coordinate.lon === "number" && typeof boundaryRow.coordinate.lat === "number" ? { lon: boundaryRow.coordinate.lon as number, lat: boundaryRow.coordinate.lat as number, name: typeof boundaryRow.coordinate.name === "string" ? boundaryRow.coordinate.name : null } : null
  const landmarks = landmarksRaw.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_PLACE_LANDMARK_INVALID: landmarks[${index}] 必须是对象。`)
    const row = raw as { name?: unknown; lon?: unknown; lat?: unknown; page?: unknown; expected?: { withinM?: unknown; bearingDeg?: unknown; bearingToleranceDeg?: unknown; inside?: unknown } }
    if (typeof row.name !== "string" || !row.name.trim() || typeof row.lon !== "number" || typeof row.lat !== "number" || !Number.isFinite(row.lon) || !Number.isFinite(row.lat)) {
      throw new Error(`MAP_PLACE_LANDMARK_INVALID: landmarks[${index}] 需要 name（字符串）与有限数字 lon/lat。`)
    }
    return { name: row.name.trim(), lon: row.lon, lat: row.lat, page: typeof row.page === "string" ? row.page : null, expected: row.expected ?? null }
  })
  const hasBoundaryGeometry = boundaryRow !== null && (boundaryRow.path !== undefined || boundaryRow.geojson !== undefined)
  const frame = hasBoundaryGeometry
    ? { crs: boundaryRow!.crs, anchor: boundaryRow!.anchor }
    : frameRow && frameRow.crs !== undefined && frameRow.anchor !== undefined ? { crs: frameRow.crs, anchor: frameRow.anchor } : null
  let boundarySection: Record<string, unknown>
  let landmarkSection: Record<string, unknown>
  if (frame === null) {
    boundarySection = { status: "unavailable", reason: BOUNDARY_UNAVAILABLE, rule: BOUNDARY_RULE, coordinate: targetPoint, toleranceM }
    landmarkSection = {
      status: landmarks.length === 0 ? "none" : "unavailable", target: targetPoint, items: [],
      reason: landmarks.length === 0 ? "没有给 landmarks：不做地标核对（不虚构地标）。" : "landmark-unavailable：没有可用的局部米制帧（boundary.path/geojson 或 frame{crs,anchor} 都没给全）→ 算不出方位与米数，不编。",
      rule: LANDMARK_RULE,
    }
  } else {
    const readText = dependencies.readFile ?? (async (path: string) => await readFile(dependencies.pathBase && !isAbsolute(path) ? join(dependencies.pathBase, path) : path, "utf8"))
    const boundaryTextCache = hasBoundaryGeometry && boundaryRow!.geojson === undefined ? await readText(String(boundaryRow!.path)) : null
    const collection = hasBoundaryGeometry
      ? (() => {
        const raw = boundaryRow!.geojson !== undefined ? boundaryRow!.geojson : JSON.parse(boundaryTextCache ?? "")
        return raw?.type === "FeatureCollection" ? raw : { type: "FeatureCollection", features: [raw?.type === "Feature" ? raw : { type: "Feature", id: "boundary", properties: {}, geometry: raw }] }
      })()
      : { type: "FeatureCollection", features: [] }
    const pointFeatures = [
      ...(targetPoint ? [{ type: "Feature", id: "__target", properties: { role: "target-point" }, geometry: { type: "Point", coordinates: [targetPoint.lon, targetPoint.lat] } }] : []),
      ...landmarks.map((landmark, index) => ({ type: "Feature", id: `__landmark_${index}`, properties: { role: "landmark", name: landmark.name }, geometry: { type: "Point", coordinates: [landmark.lon, landmark.lat] } })),
    ]
    const converted = await mapGeoJsonToLocal({ geojson: { type: "FeatureCollection", features: [...collection.features, ...pointFeatures] }, crs: frame.crs, anchor: frame.anchor as MapConstraintsAnchorInput | undefined, zMeaning: "unknown" }, dependencies, signal) as any
    const boundaryFeatures = converted.features.filter((feature: any) => !String(feature.id ?? "").startsWith("__"))
    const pointLocal = new Map<string, [number, number]>()
    for (const feature of converted.features) {
      const id = String(feature.id ?? "")
      if (!id.startsWith("__")) continue
      const first = feature.vertices?.[0]?.local
      if (Array.isArray(first)) pointLocal.set(id, [first[0], first[1]])
    }
    const parts: Array<{ id: string | null; rings: Array<{ role: string; points: Array<[number, number]> }> }> = boundaryFeatures.map((feature: any) => {
      const flat: Array<[number, number]> = (feature.vertices ?? []).map((vertex: any) => [vertex.local[0], vertex.local[1]] as [number, number])
      const rings = (feature.rings ?? []).map((ring: any) => ({ role: ring.role, points: flat.slice(ring.start, ring.start + ring.count) }))
      return { id: feature.id ?? null, rings }
    })
    const contains = (x: number, y: number): boolean => parts.some(part => {
      const outers = part.rings.filter((ring: any) => ring.role !== "hole")
      const holes = part.rings.filter((ring: any) => ring.role === "hole")
      return outers.some((ring: any) => pointInRing(ring.points, x, y)) && !holes.some((ring: any) => pointInRing(ring.points, x, y))
    })
    const distanceToBoundary = (x: number, y: number): number => {
      let best = Infinity
      for (const part of parts) for (const ring of part.rings) {
        const points: Array<[number, number]> = ring.points
        for (let index = 0; index + 1 < points.length; index++) best = Math.min(best, distanceToSegment(x, y, points[index]![0], points[index]![1], points[index + 1]![0], points[index + 1]![1]))
      }
      return best
    }
    const targetLocal = targetPoint ? pointLocal.get("__target") ?? null : null
    if (parts.length === 0) {
      boundarySection = { status: "unavailable", reason: BOUNDARY_UNAVAILABLE, rule: BOUNDARY_RULE, coordinate: targetPoint, toleranceM, frame: { crs: converted.crs, anchor: converted.anchor } }
    } else if (targetPoint === null || targetLocal === null) {
      boundarySection = { status: "unavailable", reason: "boundary-unavailable：没有可核对的坐标（boundary.coordinate 缺失或换算不出局部坐标）→ 不做内外判定。", rule: BOUNDARY_RULE, coordinate: targetPoint, toleranceM }
    } else {
      const [x, y] = targetLocal
      const inside = contains(x, y)
      const distance = distanceToBoundary(x, y)
      const onBoundary = distance <= toleranceM
      const status = onBoundary ? "on-boundary" : inside ? "inside" : "outside"
      boundarySection = {
        status, inside, onBoundary, distanceToBoundaryM: Number(distance.toFixed(3)), toleranceM,
        coordinate: targetPoint, localMeters: [Number(x.toFixed(3)), Number(y.toFixed(3))],
        evidence: { crs: converted.crs, anchor: converted.anchor, extentM: converted.extent.localMeters, vertexCount: converted.limits.totalVertices, parts: parts.length },
        note: status === "outside"
          ? `越界：该坐标在边界**外**，到边界最近 ${distance.toFixed(3)} m（容差 ${toleranceM} m）——明确报出为 outside，不按「在范围内」处理。`
          : status === "on-boundary" ? `在边界上（到边界 ${distance.toFixed(3)} m ≤ 容差 ${toleranceM} m）。` : `在边界内，到边界最近 ${distance.toFixed(3)} m。`,
        rule: BOUNDARY_RULE,
      }
    }
    landmarkSection = {
      status: landmarks.length === 0 ? "none" : "measured",
      target: targetPoint,
      frame: parts.length === 0 ? { crs: converted.crs, anchor: converted.anchor, note: "本次只给了 frame（没有边界几何）：地标只算方位/米数，不做内外判定。" } : undefined,
      items: landmarks.map((landmark, index) => {
        const local = pointLocal.get(`__landmark_${index}`) ?? null
        if (local === null) return { name: landmark.name, status: "unavailable", reason: "landmark-unavailable：这个地标算不出局部坐标（坐标不合法或换算失败）。", page: landmark.page, expected: landmark.expected }
        const [lx, ly] = local
        const base = targetLocal ?? [0, 0]
        const east = lx - base[0], north = ly - base[1]
        const distance = Math.hypot(east, north)
        const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360
        const inside = parts.length ? contains(lx, ly) : null
        const expected = landmark.expected as { withinM?: unknown; bearingDeg?: unknown; bearingToleranceDeg?: unknown; inside?: unknown } | null
        const checks: Array<{ check: string; expected: unknown; actual: number | boolean | null; matched: boolean }> = []
        if (expected && typeof expected.withinM === "number") checks.push({ check: "withinM", expected: expected.withinM, actual: Number(distance.toFixed(3)), matched: distance <= expected.withinM })
        if (expected && typeof expected.bearingDeg === "number") {
          const tolerance = typeof expected.bearingToleranceDeg === "number" ? expected.bearingToleranceDeg : 0
          const delta = Math.abs(((bearing - expected.bearingDeg + 540) % 360) - 180)
          checks.push({ check: `bearingDeg±${tolerance}`, expected: expected.bearingDeg, actual: Number(bearing.toFixed(3)), matched: delta <= tolerance })
        }
        if (expected && typeof expected.inside === "boolean") checks.push({ check: "inside", expected: expected.inside, actual: inside, matched: inside === expected.inside })
        const mismatched = checks.filter(check => !check.matched)
        return {
          name: landmark.name, lon: landmark.lon, lat: landmark.lat, page: landmark.page,
          distanceM: Number(distance.toFixed(3)), bearingDeg: Number(bearing.toFixed(3)), insideBoundary: inside,
          expected: expected ?? null, checks, status: checks.length === 0 ? "measured-only" : mismatched.length ? "mismatch" : "matched",
          note: checks.length === 0
            ? "没有 expected：只报测量（方位/距离/内外），不下匹配结论。"
            : mismatched.length ? `不匹配：${mismatched.map(check => `${check.check} 期望 ${String(check.expected)} 实测 ${String(check.actual)}`).join("；")}。回查：该地标的名称与坐标是否属于这个对象、来源页是否同名异地、目标地点/年代是否选错——本工具不说「哪个错了」。`
              : "匹配：声明的 expected 都成立。",
        }
      }),
      note: landmarks.length === 0 ? "没有给 landmarks：不做地标核对（不虚构地标）。" : "地标只做测量与 expected 比对；expected 由调用方声明，本工具不替你定「应该」在哪。",
      rule: LANDMARK_RULE,
    }
  }
  const landmarkItems = (landmarkSection.items ?? []) as Array<{ status?: string; name?: string }>
  const needBackQuery = [
    ...(placeSection.status === "ambiguous" || placeSection.status === "no-candidate" ? ["place"] : []),
    ...(eraSection.backQuery.eraMismatch ? ["era"] : []),
    ...(boundarySection.status === "outside" ? ["boundary"] : []),
    ...landmarkItems.filter(item => item.status === "mismatch").map(item => `landmark:${item.name}`),
  ]
  return jsonSafe({
    tool: "map_place_check",
    ok: true,
    place: placeSection,
    era: eraSection,
    boundary: boundarySection,
    landmarks: landmarkSection,
    summary: {
      placeStatus, chosen: chosen === null ? null : (chosen as Record<string, unknown>).id,
      eraExcluded: eraSection.excluded.length, eraDeclared: eraSection.declared,
      boundaryStatus: boundarySection.status, landmarkMismatches: landmarkItems.filter(item => item.status === "mismatch").length,
      needBackQuery,
    },
    notes: [
      "本工具不做地点/年代的**事实判定**：只按调用方给的候选、证据与真实几何做可复算的比对，缺证据时返回「要回查什么」。",
      "eraAssertion 恒为 not-asserted：坐标换算与几何比对不构成地点/年代对应关系。",
    ],
    eraAssertion: "not-asserted",
    checkedAt: new Date().toISOString(),
  }) as Record<string, unknown>
}

export const mapPlaceCheckParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Place/era disambiguation plus boundary and adjacent-landmark checks. Same-name candidates are selected only when caller evidence (target.era/target.identity) uniquely identifies one; otherwise return ambiguous with back-query items. Exclude era mismatches and return backQuery.eras; an unspecified era explicitly means no era exclusion was performed. A coordinate plus actual boundary geometry yields inside/outside, metre distance and tolerance; report outside when beyond it. For adjacent landmarks, report name/coordinate-based bearing, distance and inside/outside, compare caller-declared expected values and back-query mismatches. Return the exact decision rules.",
    properties: {
      place: { type: "json", required: true, description: "Place name to disambiguate: {name, aliases?:string[], note?}." },
      candidates: { type: "array", required: true, description: "Candidate places/objects: [{id?, name, identity?:{... free fields such as gde_hist_id/gde_nr/jahr}, era?:{label,status}, coordinate?:{lon,lat}, page?, url?, note?}]." },
      target: { type: "json", description: "Optional caller evidence: {era?:{label,status}, identity?:{key:value}}. Without either, at least two same-name candidates produce ambiguous." },
      boundary: { type: "json", description: "Optional boundary check: {path?|geojson?, crs, anchor, coordinate:{lon,lat,name?}, toleranceM?}. Missing/incomplete input yields boundary-unavailable; no point is assumed inside." },
      frame: { type: "json", description: "Optional local metre frame for landmark measurements without boundary geometry: {crs, anchor}. It uses the same CRS/anchor convention and PROJ conversion as boundary." },
      landmarks: { type: "array", description: "Optional adjacent landmarks: [{name, lon, lat, page?, expected?:{withinM?, bearingDeg?, bearingToleranceDeg?, inside?}}]. Without expected, report measurements only. Without frame/boundary, explicitly report landmark-unavailable." },
    },
  },
}

/** ENV-48 候选五维度比较：候选/维度都由调用方给，本工具只做**机器可判定**的比对与类别隔离。 */
export interface CandidateComparisonInput {
  candidates?: unknown
  target?: unknown
  tolerance?: unknown
}

const CANDIDATE_RULE = "候选比较判据（写死；禁止「看起来像」）：① 每个维度只用**机器可判定证据**——形制看几何指纹（mesh-geometry 的逐节点顶点集合+三角面多重集合 sha256，**判据不看 bbox**）、比例看 sizeM 归一化后的三个比值（带调用方容差）、完整性看缺件集合与验证结果、体量看 m3（boundsM3 只作代理参考，不参与判定）、使用条件看条件集合与许可的集合相等；② 只有拓扑计数（节点/材质数）时**不判形制相同**，状态 insufficient 并说明要补几何指纹；③ 没有该维度证据 ⇒ status=missing，不编值（missingPlan 写清去哪儿取）；④ **类别隔离**：original/substitute/generated 只在**同类内部**比较；跨类别一律 verdict=different-role，**不得被静默等同**；⑤ 没有 original 候选时 noOriginal=true，结论只在同类内部成立，生成件/替代件不得被当作原物。"
const CANDIDATE_ROLE_RULE = "原物/替代/生成用候选的 role 字段显式声明（original/substitute/generated，其它值记 unclassified）；类别是**采信前提**，不是装饰：比较结论只在同类内部成立，跨类别只报「不同类别」与各自读数。"

function candidateNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`MAP_CANDIDATES_INVALID: ${label} 必须是有限数字。`)
  return value
}

/**
 * ENV-48：对同一目标的多个候选按 形制/比例/完整性/体量/使用条件 逐维度比较，并把
 * 原物/替代/生成分开（跨类别不静默等同）。几何指纹由调用方用 `mesh-geometry.ts` 的
 * `glbGeometryFacts()`/`compareGlbGeometry()` 得到后传入——本工具不自己解 GLB。
 */
export function compareCandidates(input: CandidateComparisonInput, now: () => Date = () => new Date()): Record<string, unknown> {
  if (!Array.isArray(input?.candidates) || input.candidates.length === 0) throw new Error('MAP_CANDIDATES_REQUIRED: 必须给 candidates 数组：[{id?, role:"original"|"substitute"|"generated", source?, declaredBy?, basis?, form?, size?, completeness?, volume?, usage?}]。')
  if (input.candidates.length > 32) throw new Error(`MAP_CANDIDATES_TOO_MANY: 一次最多 32 个候选（收到 ${input.candidates.length}）。`)
  const tolerance = parseCrossCheckTolerance(input.tolerance)
  const targetRow = (input.target ?? {}) as { object?: unknown; era?: unknown }
  const targetObject = typeof targetRow.object === "string" && targetRow.object.trim() ? targetRow.object.trim() : null
  const roles = ["original", "substitute", "generated"] as const
  const candidates = input.candidates.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_CANDIDATES_INVALID: candidates[${index}] 必须是对象。`)
    const row = raw as { id?: unknown; role?: unknown; source?: MapConstraintsSourceInput; declaredBy?: unknown; basis?: unknown; form?: any; size?: any; completeness?: any; volume?: any; usage?: any }
    const preserved = preserveSourceMetadata(row.source)
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `候选#${index + 1}`
    const role = typeof row.role === "string" && (roles as readonly string[]).includes(row.role.trim()) ? row.role.trim() as typeof roles[number] : "unclassified"
    const sizeM = Array.isArray(row.size?.sizeM) && row.size.sizeM.length === 3 ? row.size.sizeM.map((value: unknown, axis: number) => candidateNumber(value, `candidates[${index}].size.sizeM[${axis}]`)) as Array<number | null> : null
    const conditions = (() => {
      const raw = row.usage?.conditions
      if (raw === undefined || raw === null) return null
      const list = Array.isArray(raw) ? raw : [raw]
      if (list.some(item => typeof item !== "string" || !item.trim())) throw new Error(`MAP_CANDIDATES_INVALID: candidates[${index}].usage.conditions 只能是字符串或字符串数组。`)
      return [...new Set((list as string[]).map(item => item.trim()))].sort()
    })()
    return {
      id, role, meta: preserved.meta, notes: preserved.notes,
      declaredBy: typeof row.declaredBy === "string" ? row.declaredBy : null,
      basis: typeof row.basis === "string" ? row.basis : null,
      object: (preserved.meta.object as string | null) ?? null,
      era: preserved.meta.era, page: (preserved.meta.page as string | null) ?? null,
      form: {
        digest: typeof row.form?.digest === "string" && row.form.digest.trim() ? row.form.digest.trim() : null,
        vertexCount: candidateNumber(row.form?.vertexCount, `candidates[${index}].form.vertexCount`),
        triangleCount: candidateNumber(row.form?.triangleCount, `candidates[${index}].form.triangleCount`),
        topology: row.form?.topology && typeof row.form.topology === "object" ? row.form.topology as Record<string, unknown> : null,
        openings: candidateNumber(row.form?.openings, `candidates[${index}].form.openings`),
      },
      sizeM,
      completeness: {
        missingParts: Array.isArray(row.completeness?.missingParts) ? (row.completeness.missingParts as unknown[]).map(String).sort() : null,
        expectedParts: candidateNumber(row.completeness?.expectedParts, `candidates[${index}].completeness.expectedParts`),
        presentParts: candidateNumber(row.completeness?.presentParts, `candidates[${index}].completeness.presentParts`),
        verification: row.completeness?.verification && typeof row.completeness.verification === "object" ? row.completeness.verification as Record<string, unknown> : null,
      },
      volume: {
        m3: candidateNumber(row.volume?.m3, `candidates[${index}].volume.m3`),
        boundsM3: candidateNumber(row.volume?.boundsM3, `candidates[${index}].volume.boundsM3`),
        massKg: candidateNumber(row.volume?.massKg, `candidates[${index}].volume.massKg`),
      },
      usage: {
        conditions,
        license: typeof row.usage?.license === "string" && row.usage.license.trim() ? row.usage.license.trim() : (preserved.meta.license as string | null) ?? null,
        purpose: typeof row.usage?.purpose === "string" ? row.usage.purpose : null,
      },
      order: index,
    }
  })
  // 参考候选：优先原物（original），否则第一条；**跨类别也照实报数值差**，只是永不判「一致」。
  const reference = candidates.find(candidate => candidate.role === "original") ?? candidates[0]!
  const originalCandidate = candidates.find(candidate => candidate.role === "original") ?? null
  const proportions = (candidate: (typeof candidates)[number]): [number, number, number] | null => {
    const size = candidate.sizeM
    if (!size || size.some(value => value === null)) return null
    const values = size as number[]
    const max = Math.max(...values)
    if (!(max > 0)) return null
    return values.map(value => Number((value / max).toFixed(9))) as [number, number, number]
  }
  const withinTolerance = (delta: number, base: number): boolean | null => {
    if (!tolerance) return null
    const relativePpm = base === 0 ? null : Math.abs(delta / base) * 1e6
    const results = [
      tolerance.absolute === undefined ? null : Math.abs(delta) <= tolerance.absolute,
      tolerance.relativePpm === undefined || relativePpm === null ? null : relativePpm <= tolerance.relativePpm,
    ].filter(value => value !== null) as boolean[]
    return results.length ? results.some(Boolean) : null
  }
  const dimensionRows = (valueOf: (candidate: (typeof candidates)[number]) => number | string | null) => {
    const referenceValue = valueOf(reference)
    return candidates.map(candidate => {
      const value = valueOf(candidate)
      const crossRole = candidate.role !== reference.role
      let difference: number | null = null
      let numericSame: boolean | null = null
      let textSame: boolean | null = null
      if (value !== null && referenceValue !== null) {
        if (typeof value === "number" && typeof referenceValue === "number") {
          difference = Number((value - referenceValue).toFixed(9))
          numericSame = withinTolerance(difference, referenceValue) ?? value === referenceValue
        } else textSame = String(value) === String(referenceValue)
      }
      const same = numericSame ?? textSame
      const verdict = candidate.id === reference.id ? "reference"
        : value === null || referenceValue === null ? "insufficient"
          : crossRole ? (same ? "same-value-different-role" : "different-role")
            : same ? "same" : "different"
      return {
        candidateId: candidate.id, role: candidate.role, value, referenceId: reference.id,
        differenceVsReference: difference,
        comparable: value !== null && referenceValue !== null,
        verdict,
        basis: candidate.declaredBy ?? (candidate.page ? `source.page=${candidate.page}` : null),
      }
    })
  }
  const dimension = (name: string, label: string, rows: ReturnType<typeof dimensionRows>, options: { missingPlan?: string; note?: string } = {}) => {
    const valued = rows.filter(row => row.value !== null)
    const sameRoleRows = rows.filter(row => row.verdict === "same" || row.verdict === "different")
    const crossRoleRows = rows.filter(row => row.verdict === "different-role" || row.verdict === "same-value-different-role")
    const status = valued.length === 0 ? "missing"
      : rows.some(row => row.verdict === "different") ? "different"
        : rows.length > 1 && sameRoleRows.length === 0 && crossRoleRows.length > 0 ? "cross-role-only"
          : rows.some(row => row.verdict === "insufficient") ? "insufficient"
            : valued.length === 1 ? "single-candidate" : "same"
    const verdictNote = status === "missing"
      ? `missing：没有候选在该维度给出可判定证据${options.missingPlan ? `；最小方案：${options.missingPlan}` : ""}`
      : status === "different" ? "不同：同类候选与参考（原物优先）的可判定证据不一致（差值见 rows）。"
        : status === "cross-role-only" ? "只有跨类别可比：数值/指纹差异已逐条列出，但**不判同类一致性**（类别不同不得被静默等同）；要判一致性需要同类候选。"
          : status === "insufficient" ? "证据不足：只有计数/部分证据时**不判相同**（形制要几何指纹）。"
            : status === "same" ? "同类候选在该维度证据一致（跨类别行不计入同一性结论）。" : "只有一个候选给了该维度证据。"
    const lacksEvidence = status === "missing" || rows.some(row => row.verdict === "insufficient")
    return { dimension: name, label, status, rows, verdictNote: status === "missing" ? undefined : verdictNote, note: status === "missing" ? verdictNote : options.note ?? null, missingPlan: lacksEvidence ? options.missingPlan ?? null : null }
  }
  const formRows = dimensionRows(candidate => candidate.form.digest)
  const proportionRows = dimensionRows(candidate => {
    const ratio = proportions(candidate)
    return ratio === null ? null : ratio.join(":")
  })
  const completenessRows = dimensionRows(candidate => candidate.completeness.missingParts === null ? null : candidate.completeness.missingParts.join(",") || "(无缺件)")
  const volumeRows = dimensionRows(candidate => candidate.volume.m3)
  const usageRows = dimensionRows(candidate => {
    const parts = [candidate.usage.conditions === null ? null : candidate.usage.conditions.join("|"), candidate.usage.license]
    const present = parts.filter(part => part !== null) as string[]
    return present.length ? present.join(" + ") : null
  })
  const dimensions = [
    dimension("form", "形制", formRows, { missingPlan: "用 mesh-geometry.ts 的 glbGeometryFacts() 算几何指纹（逐节点顶点集合+三角面多重集合 sha256）后传 form.digest；只有拓扑计数时本工具不判相同。", note: "判据不看 bbox：比例相同、形制不同必须区分（bbox 相同也可能形制不同）。" }),
    dimension("proportion", "比例", proportionRows, { missingPlan: "传 size.sizeM（米制三轴）后由本工具归一化成比值比较。", note: "比值 = 三轴 sizeM 除以最大轴（与朝向无关）；容差由 tolerance 给。" }),
    dimension("completeness", "完整性", completenessRows, { missingPlan: "传 completeness.missingParts（缺件名列表）与 completeness.verification（ResourceLibrary.verify 的结果）。", note: "无缺件且 verification.valid 不为 false 才算满足；缺件集合差异逐项列出。" }),
    dimension("volume", "体量", volumeRows, { missingPlan: "跑 asset-bake 的 physicalize 得到 physicalization.measured.meshVolumeM3（packages/asset-bake/src/physicalize.ts）后传 volume.m3；boundsM3 只是包围盒代理，不参与判定。", note: "只看 m3；boundsM3 与 massKg 仅作参考随行返回。" }),
    dimension("usage", "使用条件", usageRows, { missingPlan: "产品里与用途相关的既有字段只有 physicalizeUsage（asset-acquisition.ts:100 的派生用途）与 license/era；使用条件（承重/环境限制）目前**没有专门字段**——要么由调用方按真实规格声明 usage.conditions，要么先补契约。", note: "条件集合按去重排序后相等才判 same；许可不同即 different。" }),
  ]
  const roleGroups = roles.map(role => ({ role, candidates: candidates.filter(candidate => candidate.role === role).map(candidate => candidate.id) })).filter(group => group.candidates.length > 0)
  const crossRolePairs = candidates.flatMap((left, index) => candidates.slice(index + 1)
    .filter(right => right.role !== left.role)
    .map(right => ({ left: left.id, leftRole: left.role, right: right.id, rightRole: right.role, verdict: "different-role", note: "类别不同不得被静默等同：本对比对不判「一致」，只报各自读数。" })))
  const needBackQuery: string[] = []
  if (!originalCandidate) needBackQuery.push("no-original")
  for (const item of dimensions) if (item.status === "missing" || item.status === "insufficient") needBackQuery.push(item.dimension)
  if (candidates.some(candidate => candidate.role === "unclassified")) needBackQuery.push("unclassified-role")
  return jsonSafe({
    tool: "map_compare_candidates",
    ok: true,
    comparisonRule: CANDIDATE_RULE,
    roleRule: CANDIDATE_ROLE_RULE,
    tolerance: tolerance ?? null,
    target: { object: targetObject, era: targetRow.era ?? null },
    candidates: candidates.map(candidate => ({
      id: candidate.id, role: candidate.role, object: candidate.object, era: candidate.era, page: candidate.page,
      declaredBy: candidate.declaredBy, basis: candidate.basis,
      form: candidate.form, sizeM: candidate.sizeM, proportions: proportions(candidate),
      completeness: candidate.completeness, volume: candidate.volume, usage: candidate.usage,
    })),
    dimensions,
    roleGroups,
    crossRolePairs,
    originalCandidate: originalCandidate ? { id: originalCandidate.id, declaredBy: originalCandidate.declaredBy, page: originalCandidate.page } : null,
    noOriginal: originalCandidate === null,
    noOriginalNote: originalCandidate === null ? "无原物可比：本次没有 role=original 的候选，所有比较结论只在同类内部成立；**生成件/替代件不得被当作原物**（要判定原物请补一份原物候选或说明原物的来源）。" : null,
    summary: {
      candidates: candidates.length,
      roles: roleGroups.map(group => `${group.role}:${group.candidates.length}`),
      dimensionsCompared: dimensions.filter(item => item.status !== "missing").length,
      dimensionsCrossRoleOnly: dimensions.filter(item => item.status === "cross-role-only").map(item => item.dimension),
      dimensionsMissing: dimensions.filter(item => item.status === "missing").map(item => item.dimension),
      dimensionsInsufficient: dimensions.filter(item => item.status === "insufficient").map(item => item.dimension),
      crossRolePairs: crossRolePairs.length,
      needBackQuery: [...new Set(needBackQuery)],
    },
    notes: [
      "形制/比例的机器判据分别来自 mesh-geometry.ts:220 glbGeometryFacts() 与 sizeM 归一化比值；本工具不接受「看起来一样」这类依据。",
      "体量与使用条件若没有证据一律 missing，并给出最小方案（见各维度 missingPlan）。",
    ],
    comparedAt: now().toISOString(),
  }) as Record<string, unknown>
}

export const candidateComparisonParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Compare candidates for one target across form, proportions, completeness, volume and usage conditions, distinguishing original/substitute/generated. For each dimension return its value, difference or machine-testable conclusion against same-role references, satisfaction and evidence. Form uses only geometric fingerprints, not bbox; volume uses m3; completeness uses missing-part sets; usage uses condition sets and licence. Do not silently equate roles. Missing evidence is always missing with a minimal next plan.",
    properties: {
      candidates: { type: "array", required: true, description: "Candidates: [{id?, role:\"original\"|\"substitute\"|\"generated\", source?{page,url,object,era,license}, declaredBy?, basis?, form?{digest,vertexCount,triangleCount,topology,openings}, size?{sizeM:[x,y,z]}, completeness?{missingParts[],expectedParts,presentParts,verification}, volume?{m3,boundsM3,massKg}, usage?{conditions[],license,purpose}}]." },
      target: { type: "json", description: "Optional comparison target: {object?, era?}; annotate it only, without using it for decisions." },
      tolerance: { type: "json", required: true, description: "Required tolerance: {relativePpm?, absolute?} for proportions/volume. Without it, numeric dimensions are same only when exactly equal." },
    },
  },
}

/** ENV-18 参考图与资产的一致性检查：实测参考图必须被当成实测、生成补视角必须标成假设。 */
export interface ReferenceConsistencyInput {
  asset?: unknown
  references?: unknown
  tolerance?: unknown
}

const REFERENCE_RULE = "参考图判据（写死）：① 只有机器可判定量能进一致性结论——图片 sha256（重复检测）、像素宽高比 vs 资产声明主平面宽高比（仅 view=top-down/facade 适用，perspective/detail 记 not-applicable）、像素统计（meanRGB 欧氏距离 / uniqueColors 相对差 / nonBackgroundShare 绝对差，与第一张实测参考比，带调用方容差）；不许用「看起来一致」。② 实测参考图（role=measured-reference）不得被标成假设：assumption 恒 false。③ 生成的补充视角（role=generated-view）**必须**标 assumption=true + 假设说明，且不参与一致性判定（只列出读数）。④ 没有实测参考 ⇒ status=unavailable/no-measured-reference，不编一致性结论。"
const ASSUMPTION_RULE = "生成补视角=假设：role=generated-view（或 basis=estimated 且来源声明为生成/推导）一律 assumption=true，并写明「生成的补充视角=假设/估计，未经核实，不得与实测参考图混同」；实测参考图恒 assumption=false（本工具不把实测降级成假设，也不把生成升格成实测）。"

function finiteOrNull(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`MAP_REFERENCES_INVALID: ${label} 必须是有限数字。`)
  return value
}

/**
 * ENV-18：把同一资产/局部的多张参考图挂在一起做**机器可判定**的一致性检查，并把「生成补视角」显式标成假设。
 * 像素统计由调用方用真实图片工具算好后传入（本工具不读图片字节）；资产尺寸用调用方声明的 sizeM。
 */
export function checkReferenceConsistency(input: ReferenceConsistencyInput, now: () => Date = () => new Date()): Record<string, unknown> {
  const assetRow = (input?.asset ?? {}) as { id?: unknown; object?: unknown; sizeM?: unknown; material?: unknown; declaredBy?: unknown; page?: unknown }
  const assetId = typeof assetRow.id === "string" && assetRow.id.trim() ? assetRow.id.trim() : null
  const assetObject = typeof assetRow.object === "string" && assetRow.object.trim() ? assetRow.object.trim() : null
  if (assetId === null && assetObject === null) throw new Error('MAP_REFERENCES_ASSET_REQUIRED: 必须给 asset.id 或 asset.object（参考图要挂到哪个资产/局部）。')
  const sizeM = Array.isArray(assetRow.sizeM) && assetRow.sizeM.length === 3 ? assetRow.sizeM.map((value, axis) => finiteOrNull(value, `asset.sizeM[${axis}]`)) as Array<number | null> : null
  if (sizeM && sizeM.some(value => value === null)) throw new Error("MAP_REFERENCES_INVALID: asset.sizeM 三个分量都必须是有限数字。")
  const tolerance = parseCrossCheckTolerance(input.tolerance)
  if (!Array.isArray(input?.references)) throw new Error("MAP_REFERENCES_REQUIRED: 必须给 references 数组：[{id?, role, view?, source?, declaredBy?, basis?, image:{path?,sha256?,bytes?,width,height,meanRGB?,uniqueColors?,nonBackgroundShare?}}]。")
  const references = input.references.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MAP_REFERENCES_INVALID: references[${index}] 必须是对象。`)
    const row = raw as { id?: unknown; role?: unknown; view?: unknown; source?: MapConstraintsSourceInput; declaredBy?: unknown; basis?: unknown; image?: any; note?: unknown }
    const preserved = preserveSourceMetadata(row.source)
    const image = row.image ?? {}
    const width = finiteOrNull(image.width, `references[${index}].image.width`)
    const height = finiteOrNull(image.height, `references[${index}].image.height`)
    if (width === null || height === null || width <= 0 || height <= 0) throw new Error(`MAP_REFERENCES_INVALID: references[${index}].image 需要正的 width/height（实测像素）。`)
    const meanRGB = Array.isArray(image.meanRGB) && image.meanRGB.length === 3 ? image.meanRGB.map((value: unknown, channel: number) => finiteOrNull(value, `references[${index}].image.meanRGB[${channel}]`)) as Array<number | null> : null
    const role = row.role === "measured-reference" || row.role === "generated-view" ? row.role : "unclassified"
    const assumption = role !== "measured-reference"
    return {
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `参考图#${index + 1}`,
      role, view: typeof row.view === "string" && row.view.trim() ? row.view.trim() : null,
      basis: typeof row.basis === "string" ? row.basis : null,
      declaredBy: typeof row.declaredBy === "string" ? row.declaredBy : null,
      note: typeof row.note === "string" ? row.note : null,
      meta: preserved.meta, sourceNotes: preserved.notes,
      assumption,
      assumptionNote: assumption
        ? "生成的补充视角=假设/估计，未经核实，不得与实测参考图混同。"
        : "实测参考图：assumption=false（本工具不把实测降级成假设）。",
      image: {
        path: typeof image.path === "string" ? image.path : null,
        sha256: typeof image.sha256 === "string" && image.sha256.trim() ? image.sha256.trim() : null,
        bytes: finiteOrNull(image.bytes, `references[${index}].image.bytes`),
        width, height, pixelAspect: Number((width / height).toFixed(9)),
        meanRGB, uniqueColors: finiteOrNull(image.uniqueColors, `references[${index}].image.uniqueColors`),
        nonBackgroundShare: finiteOrNull(image.nonBackgroundShare, `references[${index}].image.nonBackgroundShare`),
      },
      order: index,
    }
  })
  const measured = references.filter(reference => reference.role === "measured-reference")
  const generated = references.filter(reference => reference.role !== "measured-reference")
  // ① 重复检测：sha256 相同的两份是同一张图，不构成独立参考
  const digestGroups = new Map<string, string[]>()
  for (const reference of references) if (reference.image.sha256) digestGroups.set(reference.image.sha256, [...(digestGroups.get(reference.image.sha256) ?? []), reference.id])
  const digestDuplicates = [...digestGroups.entries()].filter(([, ids]) => ids.length > 1).map(([sha256, ids]) => ({ sha256, ids, note: "同一份字节（sha256 相同）被当成多张参考：一致性检查里只能算一条。" }))
  // ② 像素宽高比 vs 资产声明主平面宽高比（只对 top-down/facade 适用）
  const assetAspect = (() => {
    if (!sizeM) return null
    const values = (sizeM as number[]).slice().sort((a, b) => b - a)
    const plane = values.slice(0, 2)
    return plane[0]! > 0 && plane[1]! > 0 ? Number((plane[0]! / plane[1]!).toFixed(9)) : null
  })()
  const applicableViews = new Set(["top-down", "facade"])
  const assetAspectRows = references.map(reference => {
    const applicable = reference.view !== null && applicableViews.has(reference.view)
    if (!applicable || assetAspect === null) return { id: reference.id, role: reference.role, view: reference.view, pixelAspect: reference.image.pixelAspect, assetAspect, verdict: "not-applicable", reason: applicable ? "资产没有声明 sizeM，宽高比无从比对。" : `view=${reference.view ?? "未声明"}：透视/细部视角与主平面宽高比不可比（不硬套）。` }
    const delta = Math.abs(reference.image.pixelAspect - assetAspect)
    const relativePpm = assetAspect === 0 ? null : delta / assetAspect * 1e6
    const within = tolerance?.relativePpm !== undefined && relativePpm !== null ? relativePpm <= tolerance.relativePpm : tolerance?.absolute !== undefined ? delta <= tolerance.absolute : null
    return { id: reference.id, role: reference.role, view: reference.view, pixelAspect: reference.image.pixelAspect, assetAspect, delta: Number(delta.toFixed(9)), relativePpm: relativePpm === null ? null : Number(relativePpm.toFixed(2)), withinTolerance: within, verdict: reference.role !== "measured-reference" ? "assumption-excluded" : within === null ? "no-tolerance" : within ? "consistent" : "inconsistent" }
  })
  // ③ 像素统计一致性：以第一张实测参考为基准
  const base = measured[0] ?? null
  const pixelRows = references.map(reference => {
    if (!base) return { id: reference.id, role: reference.role, verdict: "not-applicable", reason: "没有实测参考图作基准。" }
    if (reference.id === base.id) return { id: reference.id, role: reference.role, verdict: "reference", note: "基准（第一张实测参考图）。" }
    if (reference.role !== "measured-reference") return { id: reference.id, role: reference.role, verdict: "assumption-excluded", note: "生成补视角不参与一致性判定（只列读数）。" }
    const rgbDistance = reference.image.meanRGB && base.image.meanRGB
      ? Number(Math.hypot(...reference.image.meanRGB.map((value, channel) => (value ?? 0) - (base.image.meanRGB![channel] ?? 0))).toFixed(6))
      : null
    const uniqueColorsRelative = reference.image.uniqueColors !== null && base.image.uniqueColors ? Number((Math.abs(reference.image.uniqueColors - base.image.uniqueColors) / base.image.uniqueColors).toFixed(6)) : null
    const nonBackgroundDelta = reference.image.nonBackgroundShare !== null && base.image.nonBackgroundShare !== null ? Number(Math.abs(reference.image.nonBackgroundShare - base.image.nonBackgroundShare).toFixed(6)) : null
    const checks = [
      rgbDistance === null ? null : { metric: "meanRgbDistance", value: rgbDistance, threshold: tolerance?.absolute ?? null, within: tolerance?.absolute === undefined ? null : rgbDistance <= tolerance.absolute },
      uniqueColorsRelative === null ? null : { metric: "uniqueColorsRelative", value: uniqueColorsRelative, threshold: tolerance?.relativePpm === undefined ? null : tolerance.relativePpm / 1e6, within: tolerance?.relativePpm === undefined ? null : uniqueColorsRelative <= tolerance.relativePpm / 1e6 },
      nonBackgroundDelta === null ? null : { metric: "nonBackgroundShareDelta", value: nonBackgroundDelta, threshold: tolerance?.absolute ?? null, within: tolerance?.absolute === undefined ? null : nonBackgroundDelta <= tolerance.absolute },
    ].filter(Boolean) as Array<{ metric: string; value: number; threshold: number | null; within: boolean | null }>
    const evaluated = checks.filter(check => check.within !== null)
    return { id: reference.id, role: reference.role, rgbDistance, uniqueColorsRelative, nonBackgroundDelta, checks, verdict: evaluated.length === 0 ? "no-tolerance" : evaluated.some(check => check.within === false) ? "inconsistent" : "consistent" }
  })
  const measuredAspectVerdicts = assetAspectRows.filter(row => row.role === "measured-reference" && (row.verdict === "consistent" || row.verdict === "inconsistent"))
  const measuredPixelVerdicts = pixelRows.filter(row => row.role === "measured-reference" && (row.verdict === "consistent" || row.verdict === "inconsistent"))
  const inconsistent = [...measuredAspectVerdicts, ...measuredPixelVerdicts].some(row => row.verdict === "inconsistent")
  const consistencyStatus = references.length === 0 ? "unavailable" : measured.length === 0 ? "no-measured-reference" : inconsistent ? "inconsistent" : (measuredAspectVerdicts.length + measuredPixelVerdicts.length) > 0 ? "consistent" : "insufficient-evidence"
  const warnings: string[] = []
  if (digestDuplicates.length) warnings.push(`重复参考图：${digestDuplicates.map(item => item.ids.join("=")).join("；")} 的 sha256 相同——不是独立来源，一致性不能靠它们互相印证。`)
  if (generated.length) warnings.push(`本次有 ${generated.length} 张**生成补视角**（assumption=true）：它们不参与一致性结论；要核实用真实拍摄/渲染的参考图。`)
  if (assetAspect === null) warnings.push("资产未声明 sizeM：宽高比一致性无从比对（不是「一致」）。")
  return jsonSafe({
    tool: "map_check_reference_consistency",
    ok: true,
    referenceRule: REFERENCE_RULE,
    assumptionRule: ASSUMPTION_RULE,
    tolerance: tolerance ?? null,
    asset: { id: assetId, object: assetObject, sizeM, assetAspect, material: typeof assetRow.material === "string" ? assetRow.material : null, declaredBy: typeof assetRow.declaredBy === "string" ? assetRow.declaredBy : null },
    references: references.map(reference => ({ id: reference.id, role: reference.role, view: reference.view, basis: reference.basis, declaredBy: reference.declaredBy, note: reference.note, source: reference.meta, assumption: reference.assumption, assumptionNote: reference.assumptionNote, image: reference.image })),
    checks: {
      digestDuplicates,
      aspect: { assetAspect, applicableViews: [...applicableViews], rows: assetAspectRows },
      pixelStatistics: { referenceId: base?.id ?? null, rows: pixelRows },
    },
    consistency: { status: consistencyStatus, inconsistentCount: [...measuredAspectVerdicts, ...measuredPixelVerdicts].filter(row => row.verdict === "inconsistent").length, note: consistencyStatus === "unavailable" ? "没有给任何参考图 ⇒ unavailable，不编一致性。" : consistencyStatus === "no-measured-reference" ? "只有生成补视角、没有实测参考图 ⇒ 不产出一致性结论（生成件标为假设）。" : consistencyStatus === "insufficient-evidence" ? "有实测参考但缺可判定证据（如没给容差或没有 pixel 统计）⇒ 不判一致性。" : consistencyStatus === "inconsistent" ? "机器可判定检查发现不一致（数值见 checks）。" : "机器可判定检查一致（数值见 checks）。" },
    assumptions: { generated: generated.map(reference => ({ id: reference.id, assumption: true, assumptionNote: reference.assumptionNote, declaredBy: reference.declaredBy })), measured: measured.map(reference => ({ id: reference.id, assumption: false, assumptionNote: reference.assumptionNote })) },
    summary: {
      references: references.length, measured: measured.length, generated: generated.length,
      measuredMarkedAsAssumption: measured.filter(reference => reference.assumption).length,
      generatedMissingAssumption: generated.filter(reference => !reference.assumption).length,
      consistencyStatus,
      needBackQuery: [
        ...(consistencyStatus === "no-measured-reference" || consistencyStatus === "unavailable" ? ["measured-reference"] : []),
        ...(consistencyStatus === "inconsistent" ? ["resolve-inconsistency"] : []),
        ...(digestDuplicates.length ? ["duplicate-bytes"] : []),
        ...(assetAspect === null ? ["asset-sizeM"] : []),
      ],
    },
    warnings,
    checkedAt: now().toISOString(),
  }) as Record<string, unknown>
}

export const referenceConsistencyParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Attach multiple reference images to the same asset/local area and check machine-testable consistency. Detect repeated sha256 values: identical bytes are not independent references. Compare image aspect ratio with the asset sizeM principal-plane ratio only for top-down/facade; perspective/detail are not-applicable. Compare pixel statistics against the first measured reference with explicit tolerances: Euclidean meanRGB distance, relative uniqueColors difference, absolute nonBackgroundShare difference. Measured references always have assumption=false; generated supplementary views always have assumption=true and do not participate. Without measured references, give no consistency conclusion.",
    properties: {
      asset: { type: "json", required: true, description: "Asset/local area receiving references: {id?, object?, sizeM?:[x,y,z] in metres, material?, declaredBy?, page?}. At least id or object is required." },
      references: { type: "array", required: true, description: "[{id?, role:\"measured-reference\"|\"generated-view\", view?:\"top-down\"|\"facade\"|\"perspective\"|\"detail\"|..., source?{page,url,retrievedAt,object,era,license}, declaredBy?, basis?:\"measured\"|\"estimated\", image:{path?,sha256?,bytes?,width,height,meanRGB?:[r,g,b],uniqueColors?,nonBackgroundShare?}}]. Compute and supply pixel statistics from actual image tools." },
      tolerance: { type: "json", required: true, description: "Required tolerance: {relativePpm?, absolute?}. Aspect ratio uses relativePpm; meanRGB/share use absolute; uniqueColors uses relativePpm." },
    },
  },
}

export interface MapConstraintsToolOptions {
  /** 仅测试注入依赖（时间、文件读取），正常装配不需要参数。 */
  dependencies?: MapConstraintsDependencies
}

/** 原生 fs 服务的最小面（不引入对 dsh-fs 的依赖：只用 resolve + readText 两个调用）。 */
interface MapFilePathResolver {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * 真实注册 `map_geojson_to_local`（坐标换算）与 `map_cross_check_sources`（多来源交叉校对）：两者都是纯计算、无状态、无写入，因此不需要 dataRoot，也不新开 Job
 * （取消沿用调用方 exec.signal：proj-cli 的异步子进程等待期间事件循环是自由的，signal 一触发就 kill 掉本次 PROJ 子进程）。
 * 接线：scene-kit 的 `apply(ctx, config)` 里在 `config.mapTool` 打开时调一次（见 plugin.ts），
 * 依赖状态与配置说明见 docs/MAP_CONSTRAINTS.md。
 */
export function registerMapConstraintTools(ctx: Context, options: MapConstraintsToolOptions = {}): void {
  ctx.tools.register(defineTool({
    name: "map_geojson_to_local",
    description: "Convert public GeoJSON points/lines/polygons to local ENU metre coordinates with an explicitly declared source CRS and local anchor. Return reversible source/local coordinates, actual extent/units and projection distortion measured from this batch. Report PROJ's actual datum-operation accuracy and area of use for the CRS pair. Reject ballpark-only, missing-grid or unknown-accuracy cases by default; only an explicit policy may relax that. Do not infer missing heights or assert unconfirmed era matches. Coordinate conversion only: no place/era disambiguation, new map service or state store.",
    parameters: mapConstraintsParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    // 纯函数换算：不写任何共享状态，可与其他调用并行。
    isConcurrencySafe: () => true,
    execute: async (args: any, exec: any) => {
      const dependencies: MapConstraintsDependencies = { ...(options.dependencies ?? {}) }
      // path 与原生 read/write/edit 同一套解析：exec.agent.session.header.cwd（dsh-tool-fs/session-cwd.ts 的同一口径）。
      // 会话没有 cwd 时**不设** pathBase：相对路径会明确报 MAP_SESSION_CWD_UNKNOWN，而不是被静默按进程目录解析。
      if (!dependencies.readFile) {
        const fs = ctx.get("fs" as never) as unknown as MapFilePathResolver | undefined
        if (fs && typeof fs.resolve === "function" && typeof fs.readText === "function") {
          const cwd = (exec?.agent?.session?.header as { cwd?: string } | undefined)?.cwd
          if (typeof cwd === "string" && cwd) dependencies.pathBase = cwd
          const signal: AbortSignal | undefined = exec?.signal
          dependencies.readFile = async (path: string) => {
            const target = await fs.resolve(path, { ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) })
            return await fs.readText(target, signal)
          }
        }
      }
      return (await mapGeoJsonToLocal(args.input, dependencies, exec?.signal)) as any
    },
  }))
  // 第二个入口：多来源交叉校对（ENV-43）。与坐标换算共用同一套来源元数据/declaredValues 口径，不新增配置开关（同受 config.mapTool 约束）。
  ctx.tools.register(defineTool({
    name: "map_cross_check_sources",
    description: "Cross-check the same quantity declared by two or more map/CAD/photo/public-dimension sources by name. With matching name/unit/object and caller tolerance, deviations beyond tolerance are conflict; otherwise agree. Missing tolerance, differing units/objects or one source produce unverifiable with reasons. Return object/era/camera back-query facts verbatim. Do not read drawings, perform photogrammetry, convert units, weight source categories or explain the cause of conflicts; that judgment belongs to the model and human.",
    parameters: mapCrossCheckParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: any) => crossCheckSources(args.input) as any,
  }))
  // 第三个入口：字段级融合（ENV-15）。同样复用来源元数据/declaredValues 口径，同受 config.mapTool 约束。
  ctx.tools.register(defineTool({
    name: "map_fuse_fields",
    description: "Fuse declared fields from CAD/photos/maps/public dimensions by name, returning each value, source category/id, evidence (basis/era/object/tolerance), conflict status and back-query items. Trust evidence rather than category weights: CAD/maps are not intrinsically correct. Do not silently merge target.era mismatches; return eraMismatch for back-query. Conflicting fields have value=null, never an average/median, with rules included in the result. Do not infer missing fields, read drawings, perform photogrammetry or convert units.",
    parameters: mapFusionParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: any) => fuseDeclaredFields(args.input) as any,
  }))
  // 第四个入口：地点/年代消歧 + 边界/相邻地标核对（ENV-41）。同受 config.mapTool 约束。
  ctx.tools.register(defineTool({
    name: "map_place_check",
    description: "Place/era disambiguation plus boundary and adjacent-landmark checks. Match candidate names, then select only if caller target.era/target.identity uniquely identifies one; otherwise return ambiguous and back-query requirements. Exclude era mismatches with backQuery.eras; explicitly state when no era exclusion was performed. Given a coordinate and actual boundary geometry, determine inside/outside, metre distance and tolerance; report outside beyond it. Measure landmark bearings/distances/inside from real names and coordinates, compare expected values and back-query mismatches. The result contains fixed decision rules; the tool does not make factual place/era judgments.",
    parameters: mapPlaceCheckParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: any, exec: any) => checkPlace(args.input, { ...(options.dependencies ?? {}) }, exec?.signal) as any,
  }))
  // 第五个入口：候选五维度比较 + 原物/替代/生成隔离（ENV-48）。同受 config.mapTool 约束。
  ctx.tools.register(defineTool({
    name: "map_compare_candidates",
    description: "Compare candidates for one target across form/proportions/completeness/volume/usage and distinguish original/substitute/generated. Form uses only a mesh-geometry vertex-set and triangle-multiset sha256 fingerprint, never bbox; proportions use normalized sizeM ratios with tolerance; completeness uses missing parts and verification; volume uses m3 only, not proxy boundsM3; usage uses conditions and licence. Different roles are never silently equated: report their readings without asserting equality. Report noOriginal when no original exists. Missing evidence is always missing with a minimal next plan.",
    parameters: candidateComparisonParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: any) => compareCandidates(args.input) as any,
  }))
  // 第六个入口：局部资产参考图的一致性检查 + 生成补视角=假设（ENV-18）。同受 config.mapTool 约束。
  ctx.tools.register(defineTool({
    name: "map_check_reference_consistency",
    description: "Attach multiple reference images to the same asset/local area for machine-testable consistency checks: sha256 duplicates, image aspect ratio against the sizeM principal plane, and pixel-statistic differences with real readings/thresholds. Mark generated supplementary views as assumptions (assumption=true), excluded from consistency decisions; measured references always have assumption=false. No measured reference means no conclusion. Return the exact decision rules.",
    parameters: referenceConsistencyParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: any) => checkReferenceConsistency(args.input) as any,
  }))
}
