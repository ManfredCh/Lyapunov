import { useEffect, useRef, useState } from "react"
import type { Entity, EntityObservation, SceneCommit, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { NumberField, type Translate } from "./entity-editor.tsx"
import type { CameraExitBridge } from "./camera-authoring.ts"
import { nativePhysicsCommit, flexKeys, cableKeys, mpmKeys, isaacKeys, pbdKeys, type NativePhysicsEditTarget } from "../../scene-kit/src/native-physics.ts"
export { nativePhysicsCommit } from "../../scene-kit/src/native-physics.ts"

export interface NativePhysicsTarget extends NativePhysicsEditTarget {
  key: string; parameters: Record<string, number>; measured: Record<string, number>
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : []
const numbers = (value: unknown, keys: readonly string[]): Record<string, number> => {
  const input = record(value), result: Record<string, number> = {}
  for (const key of keys) if (typeof input[key] === "number" && Number.isFinite(input[key])) result[key] = input[key] as number
  return result
}
/** 仅解析三后端已确认的材料读回和原生组件；没有回读时不凭引擎名编造材料。 */
export function nativePhysicsTargets(entity: Entity, observation?: EntityObservation): NativePhysicsTarget[] {
  const result: NativePhysicsTarget[] = [], physics = record(observation?.sensors?.nativePhysics)
  const mujoco = record(entity.components.mujoco)
  for (const [kind, container, keys] of [["flex", "flexMaterials", flexKeys], ["cable", "cableMaterials", cableKeys]] as const) {
    const configured = record(mujoco[container]), measured = new Map(rows(physics[kind]).map(row => [String(row.nativeName), row]))
    for (const name of new Set([...Object.keys(configured), ...measured.keys()])) {
      const values = numbers(measured.get(name), keys)
      result.push({ key: `mujoco:${kind}:${name}`, engine: "mujoco", kind, nativeName: name, measured: values, parameters: { ...values, ...numbers(configured[name], keys) } })
    }
  }
  const isaac = record(entity.components.isaac), overrides = record(isaac.materialOverrides)
  for (const material of rows(physics.materials)) {
    if (typeof material.nativeName !== "string") continue
    const mapping = material.schema === "OmniPhysicsDeformableMaterialAPI" ? isaacKeys : material.schema === "PhysxPBDMaterialAPI" ? pbdKeys : undefined
    if (!mapping) continue
    const values: Record<string, number> = {}, source = record(material.parameters)
    for (const [input, native] of Object.entries(mapping)) if (typeof source[native] === "number" && Number.isFinite(source[native])) values[input] = source[native] as number
    result.push({ key: `isaac:${material.nativeName}`, engine: "isaac", kind: mapping === isaacKeys ? "deformable" : "pbd", nativeName: material.nativeName, measured: values, parameters: { ...values, ...numbers(overrides[material.nativeName], Object.keys(mapping)) } })
  }
  // 保存过的 USD 覆写在离线状态也可编辑；只显示实际已声明的参数。
  for (const name of Object.keys(overrides)) if (!result.some(item => item.engine === "isaac" && item.nativeName === name)) {
    const parameters = numbers(overrides[name], [...Object.keys(isaacKeys), ...Object.keys(pbdKeys)])
    result.push({ key: `isaac:${name}`, engine: "isaac", kind: Object.keys(parameters).some(key => key in pbdKeys && key !== "densityKgM3") ? "pbd" : "deformable", nativeName: name, parameters, measured: {} })
  }
  const mpm = record(record(entity.components.newton).mpm)
  if (mpm.kind === "water") {
    const measured = physics.solver === "implicit-mpm" ? numbers(physics, mpmKeys) : {}
    result.push({ key: "newton:mpm:water", engine: "newton", kind: "mpm", nativeName: "water", measured, parameters: { ...measured, ...numbers(mpm, mpmKeys) }, ...(Array.isArray(mpm.dimensions) ? { dimensions: mpm.dimensions as number[] } : {}) })
  }
  return result
}

function fieldLabel(key: string, tr: Translate): string {
  if (["youngPa", "youngsModulusPa"].includes(key)) return tr("杨氏模量 Pa", "Young's modulus Pa")
  if (["poisson", "poissonsRatio", "poissonRatio"].includes(key)) return tr("泊松比", "Poisson ratio")
  if (key === "youngModulusPa") return tr("MPM 压缩响应参数 Pa", "MPM compression parameter Pa")
  if (key === "densityKgM3") return tr("密度 kg/m³", "Density kg/m³")
  if (key === "rayleighDamping") return tr("Rayleigh 阻尼", "Rayleigh damping")
  if (key === "bendPa") return tr("缆线弯曲刚度 Pa", "Cable bending stiffness Pa")
  if (key === "twistPa") return tr("缆线扭转刚度 Pa", "Cable torsional stiffness Pa")
  if (key === "viscosityPaS") return tr("黏度 Pa·s", "Viscosity Pa·s")
  if (key === "spacingM") return tr("初始粒子间距 m", "Initial particle spacing m")
  if (key === "voxelSizeM") return tr("MPM 体素尺寸 m", "MPM voxel size m")
  if (key === "viscosity") return tr("原生 PBD 黏度", "Native PBD viscosity")
  if (key === "surfaceTension") return tr("原生 PBD 表面张力", "Native PBD surface tension")
  if (key === "cohesion") return tr("原生 PBD 内聚力", "Native PBD cohesion")
  return key === "dynamicFriction" ? tr("动态摩擦系数", "Dynamic friction") : tr("摩擦系数", "Friction")
}

interface NativeDraft {
  sceneId: string; baseRevision: number; entity: Entity; target: NativePhysicsTarget
  parameters: Record<string, number>; dimensions?: number[]; dirty: boolean
}
const draftKey = (draft: NativeDraft) => `${draft.sceneId}:${draft.entity.entityId}:${draft.target.key}`
const createDraft = (sceneId: string, revision: number, entity: Entity, target?: NativePhysicsTarget): NativeDraft | undefined => target ? {
  sceneId, baseRevision: revision, entity: structuredClone(entity), target: structuredClone(target),
  parameters: { ...target.parameters }, dimensions: target.dimensions ? [...target.dimensions] : undefined, dirty: false,
} : undefined

/** 输入稿沿已发布的退出协调器汇总/保存；选择和工具切换复用原保留面板，不另建持久状态。 */
export function NativePhysicsPanel({ sceneId, revision, entity, observation, readOnly, tr, commit, exitBridge, exitId }: {
  sceneId: string; revision: number; entity: Entity; observation?: EntityObservation; readOnly: boolean; tr: Translate
  commit: (input: SceneCommit) => Promise<SceneSnapshot>; exitBridge?: CameraExitBridge; exitId?: string
}) {
  const targets = nativePhysicsTargets(entity, observation)
  const [selection, setSelection] = useState(targets[0]?.key ?? "")
  const visibleTarget = targets.find(item => item.key === selection) ?? targets[0]
  const key = `${sceneId}:${entity.entityId}:${visibleTarget?.key ?? ''}`
  const [draft, setDraft] = useState(() => createDraft(sceneId, revision, entity, visibleTarget))
  const drafts = useRef(new Map<string, NativeDraft>()), draftRef = useRef(draft), activeKey = useRef(key)
  const pendingSave = useRef<Promise<void>>()
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("")
  draftRef.current = draft
  const visible = useRef({ key, sceneId, revision, entity, target: visibleTarget }); visible.current = { key, sceneId, revision, entity, target: visibleTarget }
  const targetState = JSON.stringify(visibleTarget)
  useEffect(() => {
    if (activeKey.current !== key) {
      const previous = draftRef.current; if (previous) drafts.current.set(draftKey(previous), previous)
      activeKey.current = key
      const cached = drafts.current.get(key), next = cached?.dirty ? cached : createDraft(sceneId, revision, entity, visibleTarget)
      draftRef.current = next; setDraft(next); setSelection(visibleTarget?.key ?? ""); setError(""); setNotice(""); return
    }
    if (!draftRef.current?.dirty) { const next = createDraft(sceneId, revision, entity, visibleTarget); draftRef.current = next; setDraft(next) }
  }, [key, revision, targetState])
  const target = draft?.target ?? visibleTarget, parameters = draft?.parameters ?? {}, dimensions = draft?.dimensions, dirty = draft?.dirty === true
  const measured = visibleTarget?.key === target?.key ? visibleTarget?.measured ?? {} : {}
  const edit = (change: Partial<Pick<NativeDraft, 'parameters' | 'dimensions'>>) => {
    const current = draftRef.current; if (!current) return
    const next = { ...current, ...change, dirty: true }; draftRef.current = next; drafts.current.set(draftKey(next), next); setDraft(next); setNotice("")
  }
  const reload = () => {
    const next = createDraft(sceneId, revision, entity, visibleTarget)
    if (next) drafts.current.set(draftKey(next), next)
    draftRef.current = next; setDraft(next); setError(""); setNotice("")
  }
  const submit = (source = draftRef.current): Promise<void> => {
    if (pendingSave.current) return pendingSave.current
    if (!source?.dirty) return Promise.resolve()
    const sourceKey = draftKey(source), pending = structuredClone(source)
    const operation = (async () => {
      setSaving(true); setError(""); setNotice("")
      try {
        const snapshot = await commit(nativePhysicsCommit(pending.sceneId, pending.baseRevision, pending.entity, pending.target, pending.parameters, pending.dimensions))
        const updated = snapshot.entities.find(row => row.entityId === pending.entity.entityId)
        if (!updated) throw Error('NATIVE_DRAFT_SAVE_UNCONFIRMED: ' + pending.entity.entityId)
        const updatedTarget = nativePhysicsTargets(updated).find(row => row.key === pending.target.key) ?? { ...pending.target, parameters: pending.parameters, dimensions: pending.dimensions, measured: {} }
        const current = visible.current, superseded = current.key === sourceKey && current.revision > snapshot.revision
        const next = superseded ? createDraft(current.sceneId, current.revision, current.entity, current.target) : createDraft(snapshot.sceneId, snapshot.revision, updated, updatedTarget)
        if (next) drafts.current.set(sourceKey, next)
        if (visible.current.key === sourceKey) {
          draftRef.current = next; setDraft(next)
          setNotice(tr("原生参数已写入场景。等待同步后读取新世界的实际值。", "Native parameters were saved to the scene. Read the new world's actual values after synchronization."))
        }
      } catch (value) {
        if (visible.current.key === sourceKey) setError(tr("参数未提交，草稿已保留。 ", "Parameters were not saved; the draft was preserved. ") + String(value instanceof Error ? value.message : value))
        throw value
      } finally { setSaving(false) }
    })()
    pendingSave.current = operation
    void operation.finally(() => { if (pendingSave.current === operation) pendingSave.current = undefined }).catch(() => undefined)
    return operation
  }
  const submitRef = useRef(submit); submitRef.current = submit
  const pendingDrafts = () => {
    const known = new Map(drafts.current), current = draftRef.current
    if (current) known.set(draftKey(current), current)
    if ([...known.values()].some(row => !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 0)) throw Error('NATIVE_DRAFT_STATUS_UNKNOWN')
    return [...known.values()].filter(row => row.dirty)
  }
  useEffect(() => exitBridge?.registerExitParticipant?.(exitId ?? 'native-physics:' + sceneId, {
    summary: () => ({ dirtyDrafts: pendingDrafts().length, runningActions: 0 }),
    flush: async () => { if (pendingSave.current) await pendingSave.current; for (const source of pendingDrafts()) await submitRef.current(source); if (pendingDrafts().length) throw Error('NATIVE_DRAFT_SAVE_UNCONFIRMED') },
  }), [exitBridge, exitId])
  if (!targets.length) return null
  return <fieldset className="lya-property-editor" data-testid="native-physics-panel"><legend>{tr("原生物理参数", "Native physics parameters")}</legend>
    <select aria-label={tr("原生材料或求解对象", "Native material or solver object")} value={target?.key ?? ""} disabled={saving || dirty} onChange={event => { setSelection(event.target.value); setNotice(""); setError("") }}>{targets.map(item => <option key={item.key} value={item.key}>{item.engine} · {item.nativeName}</option>)}</select>
    {target?.kind === "mpm" && <p className="lya-help">{tr("水示例中的 youngModulusPa 与 poissonRatio 用于原生 MPM 压缩响应；不表示液体具有弹性固体的杨氏材料本构。", "In this water example, youngModulusPa and poissonRatio control native MPM compression response; they do not define an elastic-solid Young's material law for the liquid.")}</p>}
    {target?.kind === "cable" && <p className="lya-help">{tr("原生 cable 的弯曲与扭转参数；该模型按不可伸长假设求解。", "Native cable bending and torsion parameters; this model assumes inextensibility.")}</p>}
    <div className="lya-values">{Object.entries(parameters).map(([key, value]) => <NumberField key={key} label={fieldLabel(key, tr)} value={value} disabled={readOnly || saving} step={key.toLowerCase().includes("poisson") ? 0.01 : "any"} set={next => edit({ parameters: { ...parameters, [key]: next } })}/>)}</div>
    {target?.kind === "mpm" && dimensions && <div className="lya-values">{dimensions.map((value, axis) => <NumberField key={axis} label={tr(`初始粒子网格 ${["X", "Y", "Z"][axis]}`, `Initial particle grid ${["X", "Y", "Z"][axis]}`)} value={value} disabled={readOnly || saving} step={1} min={1} set={next => edit({ dimensions: dimensions.map((value, index) => index === axis ? next : value) })}/>)}</div>}
    {target && <p className="lya-help" data-testid="native-physics-measured">{tr("当前帧实际读回", "Actual values in the current frame")}: {Object.keys(measured).length ? Object.entries(measured).map(([key, value]) => `${fieldLabel(key, tr)}=${value}`).join(" · ") : tr("尚未读到；启动或同步对应引擎后观察。", "No readback yet; start or sync the matching engine and observe.")}</p>}
    {observation?.dynamicGeometry?.length ? <p className="lya-help">{tr("原生动态几何", "Native dynamic geometry")}: {observation.dynamicGeometry.map(item => `${item.nativeName} · ${item.kind} · ${item.positionsM.length / 3} ${item.kind === "particles" ? tr("粒子", "particles") : tr("顶点", "vertices")}`).join("；")}</p> : null}
    {dirty && revision !== draft?.baseRevision && <p className="lya-warning lya-help">{tr(`场景已更新到 rev ${revision}；参数草稿仍基于 rev ${draft?.baseRevision}。`, `The scene is at rev ${revision}; the parameter draft is based on rev ${draft?.baseRevision}.`)}</p>}
    {error && <p role="alert" className="lya-error lya-help">{error}</p>}{notice && <p role="status" className="lya-help">{notice}</p>}
    <div className="lya-row"><button disabled={readOnly || saving || !dirty} onClick={() => void submit().catch(() => undefined)}>{saving ? tr("提交中…", "Saving…") : tr("保存原生参数", "Save native parameters")}</button><button disabled={saving} onClick={reload}>{tr("读取当前版本", "Reload current")}</button></div>
    <p className="lya-help">{tr("参数随原生源声明保存。自然语言修改使用同一场景编辑入口；瞬态网格与粒子由模拟帧读取。", "Parameters are saved with the native source declaration. Natural-language edits use the same scene editing path; transient mesh and particle positions come from simulation frames.")}</p>
  </fieldset>
}
