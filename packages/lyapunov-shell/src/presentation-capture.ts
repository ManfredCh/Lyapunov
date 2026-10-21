/**
 * 展示层（R-011 部件选择 / Exploded view）在采集/观察回执里的**窄面**：这张图是炸开视图还是装配视图、
 * 展开到多少、选中的是哪个真实部件、对应哪一版资源。
 *
 * 为什么要有它：Exploded view 是**纯显示层**——源模型、Scene、原生 body/FK、碰撞一个数都不改。模型看到
 * 一张散开的机器人图时，如果回执里没有这一面，它会以为那是一次真实的物理拆卸。有了这一面，观察结果能
 * 如实说出"displayOnly、哪台实体、哪个部件、哪版资源、展开比例"，读取消息的工具也就不会把展示偏移当成物理位置。
 *
 * 整形纪律与 `environment-capture.ts`/`lod-capture.ts` 相同：字段白名单、限长限量，缺字段就如实说缺，
 * `displayOnly` 必须为 `true`（前端没标就不是这一面），绝不补默认值冒充"核过了"。
 */
export interface PresentationCaptureFace {
  /** 恒 `true`：这一面只描述显示状态，不代表任何 Scene/物理改动。 */
  displayOnly: true
  exploded: boolean
  spread: number
  entityId?: string
  selectedPart?: { entityId: string; partId: string; name: string; kind: string }
  catalog?: { entityId: string; resource?: string; signature: string; parts: number; separable: number }
  /** 未应用的装配预览 ghost：告诉模型画面里的第二只手只是临时预览，不是已提交的实体。 */
  assemblyPreview?: AssemblyPreviewCaptureFace
  /** 未应用的旧件停放 ghost：旧件 ID + 明确世界停放位姿 + `applied:false`，别把额外的手当成真实实例。 */
  parkingPreview?: ParkingPreviewCaptureFace
}
export interface AssemblyPreviewCaptureFace {
  applied: false
  sourceEntityId: string
  targetEntityId: string
  targetBodyName: string
  sourceRootBodyName?: string
  worldId?: string
  sceneRevision?: number
  generation?: number
}
export interface ParkingPreviewCaptureFace {
  applied: false
  entityId: string
  positionM: [number, number, number]
  quaternionXyzw: [number, number, number, number]
  worldId?: string
  sceneRevision?: number
  generation?: number
}

const text = (value: unknown, limit: number): string | undefined => typeof value === "string" && value ? value.slice(0, limit) : undefined
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
/** 位姿向量必须是固定长度、全有限数；缺一个就不是这一面，绝不补默认值。 */
const pose3 = (value: unknown): [number, number, number] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "number" && Number.isFinite(item)) ? [value[0] as number, value[1] as number, value[2] as number] : undefined
const pose4 = (value: unknown): [number, number, number, number] | undefined =>
  Array.isArray(value) && value.length === 4 && value.every(item => typeof item === "number" && Number.isFinite(item)) ? [value[0] as number, value[1] as number, value[2] as number, value[3] as number] : undefined

/** 把前端送来的展示层整形进采集记录；形状不对（尤其 `displayOnly` 不是 `true`）返回 undefined，不猜不造。 */
export function presentationFaceFrom(input: unknown): PresentationCaptureFace | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>
  if (raw.displayOnly !== true || typeof raw.exploded !== "boolean") return undefined
  const spread = typeof raw.spread === "number" && Number.isFinite(raw.spread) ? Math.min(1, Math.max(0, raw.spread)) : 0
  const entityId = text(raw.entityId, 200)
  const selectedRaw = raw.selectedPart
  let selectedPart: PresentationCaptureFace["selectedPart"]
  if (selectedRaw && typeof selectedRaw === "object" && !Array.isArray(selectedRaw)) {
    const row = selectedRaw as Record<string, unknown>
    const partEntityId = text(row.entityId, 200), partId = text(row.partId, 200), name = text(row.name, 200), kind = text(row.kind, 40)
    if (partEntityId && partId) selectedPart = { entityId: partEntityId, partId, name: name ?? partId, kind: kind ?? "node" }
  }
  const catalogRaw = raw.catalog
  let catalog: PresentationCaptureFace["catalog"]
  if (catalogRaw && typeof catalogRaw === "object" && !Array.isArray(catalogRaw)) {
    const row = catalogRaw as Record<string, unknown>
    const catalogEntityId = text(row.entityId, 200), signature = text(row.signature, 400)
    const parts = count(row.parts), separable = count(row.separable)
    if (catalogEntityId && signature && parts !== undefined && separable !== undefined) {
      const resource = text(row.resource, 300)
      catalog = { entityId: catalogEntityId, ...(resource ? { resource } : {}), signature, parts, separable }
    }
  }
  const previewRaw = raw.assemblyPreview
  let assemblyPreview: PresentationCaptureFace["assemblyPreview"]
  if (previewRaw && typeof previewRaw === "object" && !Array.isArray(previewRaw)) {
    const row = previewRaw as Record<string, unknown>
    const sourceEntityId = text(row.sourceEntityId, 200), targetEntityId = text(row.targetEntityId, 200), targetBodyName = text(row.targetBodyName, 200)
    // `applied` 必须是显式 false；不是就不是这一面，绝不补默认值。
    if (row.applied === false && sourceEntityId && targetEntityId && targetBodyName) {
      const sourceRootBodyName = text(row.sourceRootBodyName, 200), worldId = text(row.worldId, 200)
      const sceneRevision = count(row.sceneRevision), generation = count(row.generation)
      assemblyPreview = {
        applied: false,
        sourceEntityId, targetEntityId, targetBodyName,
        ...(sourceRootBodyName ? { sourceRootBodyName } : {}),
        ...(worldId ? { worldId } : {}),
        ...(sceneRevision !== undefined ? { sceneRevision } : {}),
        ...(generation !== undefined ? { generation } : {}),
      }
    }
  }
  const parkingRaw = raw.parkingPreview
  let parkingPreview: PresentationCaptureFace["parkingPreview"]
  if (parkingRaw && typeof parkingRaw === "object" && !Array.isArray(parkingRaw)) {
    const row = parkingRaw as Record<string, unknown>
    const parkedEntityId = text(row.entityId, 200)
    const positionM = pose3(row.positionM), quaternionXyzw = pose4(row.quaternionXyzw)
    // `applied` 必须是显式 false 且位姿完整；缺一个就不是这一面，绝不补默认值冒充"核过了"。
    if (row.applied === false && parkedEntityId && positionM && quaternionXyzw) {
      const worldId = text(row.worldId, 200)
      const sceneRevision = count(row.sceneRevision), generation = count(row.generation)
      parkingPreview = {
        applied: false,
        entityId: parkedEntityId,
        positionM, quaternionXyzw,
        ...(worldId ? { worldId } : {}),
        ...(sceneRevision !== undefined ? { sceneRevision } : {}),
        ...(generation !== undefined ? { generation } : {}),
      }
    }
  }
  return {
    displayOnly: true,
    exploded: raw.exploded,
    spread,
    ...(entityId ? { entityId } : {}),
    ...(selectedPart ? { selectedPart } : {}),
    ...(catalog ? { catalog } : {}),
    ...(assemblyPreview ? { assemblyPreview } : {}),
    ...(parkingPreview ? { parkingPreview } : {}),
  }
}

/**
 * 给模型看的一句话：只有**真的是炸开/显示偏移/未应用预览 ghost**时才出现，避免每张普通截图都多一段噪声。
 * 它必须把"这只是查看/预览"说清楚，否则模型会把散开的图当成真实拆卸、把额外的 ghost 当成真实实例。
 */
export function presentationFaceNote(face: PresentationCaptureFace | undefined): string | undefined {
  if (!face) return undefined
  const parts: string[] = []
  if (face.exploded) {
    const part = face.selectedPart ? `；当前选中部件 ${face.selectedPart.entityId}/${face.selectedPart.partId}（${face.selectedPart.name}）` : ""
    const version = face.catalog?.resource ? `；资源版本 ${face.catalog.resource}` : ""
    parts.push(`展示层：这张图是 Exploded view（展开比例 ${face.spread.toFixed(2)}，displayOnly=true）${part}${version}。源模型、Scene、原生 body/FK 关节与碰撞数据都没有改变；别把画面里的偏移当成真实的物理拆卸或装配。`)
  }
  if (face.assemblyPreview) parts.push(`画面里的装配 ghost 是**未应用预览**（applied=false）：新件 ${face.assemblyPreview.sourceEntityId} → 目标 ${face.assemblyPreview.targetEntityId}/${face.assemblyPreview.targetBodyName}，它还不是真实实例，也没有写进 Scene 或物理。`)
  if (face.parkingPreview) parts.push(`画面里还有旧件 ${face.parkingPreview.entityId} 的**未应用停放 ghost**（applied=false，位置 [${face.parkingPreview.positionM.map(value => value.toFixed(3)).join(", ")}] m）：它只是临时显示的停放去向，旧件尚未被真正移动或停放。`)
  return parts.length ? parts.join(" ") : undefined
}
