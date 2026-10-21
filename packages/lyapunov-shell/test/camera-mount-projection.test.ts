/**
 * P19 R-005：真实相机安装 mount 必须穿过产品机器 UI 出站投影，再被已有安装解析函数读回。
 *
 * 真实断点（receipts/p13-live/R-005-R-006-1792165007593）：`camera_scene_save` 的
 * `ui.snapshot` 里 `camera.mount` 与 `installation.baseline.mount` 被通用
 * `INTERNAL_FIELD_NAMES`（含计费语义的 `mount`）递归清掉；Panel 保存后按 snapshot 走
 * `cameraDraftOfScene`，于是显示成"世界相机"。
 *
 * 本文件用**真实回执字段**（saved-camera.json / save-rpc.json 的 UR10e 现场）先过
 * `commandRouteResponse`/`uiCommandFields`（产品实际投影），再喂给
 * `cameraDraftOfScene`/`restoredCameraDraft`，并给出计费/取件 `mount`、token 与机器路径的负例。
 * 离线纯逻辑，不触网、不启动引擎/浏览器。
 */
import { describe, expect, test } from 'bun:test'
import { commandRouteResponse, isInternalFieldName, uiCommandFields } from '../../lyapunov-contracts/src/command-privacy.ts'
import type { ProductPathRoots } from '../../lyapunov-contracts/src/product-paths.ts'
import type { Entity, SceneCameraComponent, SceneCameraMount, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { cameraDraftOfScene, restoredCameraDraft } from '../src/camera-installation.ts'
import { sceneCameraDraftOf, sceneCamerasOfScene } from '../src/workbench-camera.ts'

/** 与 privacy-boundary.test.ts 同一份合成标记口径（片段拼接，正文不出现完整凭据形状）。 */
const MARKER_TOKEN = 'sk-' + 'MARKER_TOKEN_0123456789abcdef'
const MARKER_USER_PATH = '/home/alice/.lyapunov-dev/cache/packs/go2/model.onnx'
/** 登记域之外的机器路径：正式/开发机器面都只出 basename。 */
const MARKER_OUTSIDE_PATH = '/home/alice/secret-weights/model.onnx'
const ROOTS: ProductPathRoots = {
  captures: '/home/alice/.runtime/developer/developer/captures',
  data: '/home/alice/.lyapunov-dev/cache',
}
/** 取自 receipts/p13-live/R-005-R-006-1792165007593 的真实身份与镜头。 */
const ROBOT = 'entity_ed2efb27-396d-46bd-9455-1f3a7c8b0d67'
const CAMERA = 'e047d454-8950-440b-ad92-af53f5520fd0'
const INTRINSICS = { fx: 219.3805930176445, fy: 128.67041523057352, cx: 79.5, cy: 59.5, width: 160, height: 120 }

const realMount = (): SceneCameraMount => ({
  entityId: ROBOT, bodyName: 'wrist_3_link', positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1],
})
const realCamera = (): SceneCameraComponent => ({
  name: 'qa-wrist-camera', fovYDeg: 50, width: 160, height: 120, near: 0.001, far: 100,
  intrinsics: INTRINSICS, isActive: true, mount: realMount(),
  installation: { source: 'manual', baseline: { positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1], mount: realMount(), fovYDeg: 50, width: 160, height: 120, near: 0.001, far: 100, intrinsics: INTRINSICS } },
})
const realCameraEntity = (): Entity => ({
  entityId: CAMERA, name: 'qa-wrist-camera',
  transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  resources: [], components: { camera: realCamera() },
})
const realScene = (revision = 8): SceneSnapshot => ({
  sceneId: 'scene-1', revision,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [realCameraEntity()],
})
const saveReceipt = (snapshot: SceneSnapshot, source = 'manual') => ({
  status: 'SAVED', snapshot, entityId: CAMERA, source, worldNeedsSync: true,
  note: 'Installation saved in Scene. The existing World owner handles synchronization and native frame readback.',
})
const projectCameraSceneSave = (receipt: unknown, mode = 'formal') =>
  commandRouteResponse('camera_scene_save', { kind: 'success', text: JSON.stringify(receipt) }, mode, ROOTS).ui
const cameraOf = (ui: Record<string, unknown> | null): SceneCameraComponent => {
  const snapshot = ui!.snapshot as SceneSnapshot
  return snapshot.entities[0]!.components.camera as SceneCameraComponent
}
const plain = (value: unknown): Record<string, any> => value as Record<string, any>

describe('P19 R-005 真实相机安装穿过机器 UI 投影', () => {
  for (const mode of ['formal', 'developer']) {
    test(`${mode}：camera_scene_save 快照保留 camera.mount 与 installation.baseline.mount`, () => {
      const camera = cameraOf(projectCameraSceneSave(saveReceipt(realScene()), mode))
      expect(camera.mount).toEqual(realMount())
      expect(camera.installation?.baseline.mount).toEqual(realMount())
      // 同一组件的既有字段一个不少、形状不变。
      expect(camera.fovYDeg).toBe(50)
      expect(camera.width).toBe(160)
      expect(camera.height).toBe(120)
      expect(camera.near).toBe(0.001)
      expect(camera.intrinsics).toEqual(INTRINSICS)
      expect(camera.installation?.source).toBe('manual')
    })
  }

  test('真实回执喂给既有安装解析函数后仍是同一条 body 与同一局部位姿/分辨率', () => {
    const ui = projectCameraSceneSave(saveReceipt(realScene()))
    const snapshot = ui!.snapshot as SceneSnapshot
    const entity = snapshot.entities[0]!
    expect(sceneCamerasOfScene(snapshot.entities)).toHaveLength(1)
    const draft = cameraDraftOfScene(snapshot, entity)
    expect(draft).toMatchObject({ parentEntityId: ROBOT, bodyName: 'wrist_3_link', position: '0 0 0.2', quaternion: '0 0 0 1', width: '160', height: '120' })
    expect(draft.intrinsics).toEqual(INTRINSICS)
    expect(sceneCameraDraftOf(entity)).toMatchObject({ parentEntityId: ROBOT, bodyName: 'wrist_3_link', position: '0 0 0.2', quaternion: '0 0 0 1' })
    // 安装基线恢复（restore）读的是同一份 installation.baseline.mount。
    expect(restoredCameraDraft(entity)).toMatchObject({ parentEntityId: ROBOT, bodyName: 'wrist_3_link', position: '0 0 0.2', quaternion: '0 0 0 1', width: '160', height: '120' })
  })

  test('其它真正返回 Scene snapshot 的 UI 命令同样保留 mount（同一份组件表示）', () => {
    for (const name of ['scene_edit', 'scene_reconcile_physics', 'scene_bind_physics', 'robot_set_tcp', 'sim_reset']) {
      const ui = uiCommandFields(name, { snapshot: realScene(), changed: true }, ROOTS)
      const camera = cameraOf(ui)
      expect(camera.mount, name).toEqual(realMount())
      expect(camera.installation?.baseline.mount, name).toEqual(realMount())
    }
    // `scene_inspect` 的实体在顶层（不是 snapshot），走的是同一个递归主体。
    const inspect = uiCommandFields('scene_inspect', { sceneId: 'scene-1', revision: 8, entities: realScene(8).entities }, ROOTS)
    const entity = (inspect!.entities as Entity[])[0]!
    expect((entity.components.camera as SceneCameraComponent).mount).toEqual(realMount())
  })

  test('同版本重复投影（轮询重取）不丢 mount', () => {
    const receipt = saveReceipt(realScene(9))
    const first = projectCameraSceneSave(receipt)!.snapshot as SceneSnapshot
    const second = projectCameraSceneSave(receipt)!.snapshot as SceneSnapshot
    for (const snapshot of [first, second]) {
      expect((snapshot.entities[0]!.components.camera as SceneCameraComponent).mount).toEqual(realMount())
      expect(cameraDraftOfScene(snapshot, snapshot.entities[0]!).bodyName).toBe('wrist_3_link')
    }
  })

  test('负例：计费/取件 mount、用户自定组件与假相机不借类型白名单泄露', () => {
    const billingMount = { mountId: 'mount-1', expiresAt: '2026-10-17T00:00:00.000Z', budget: { maxBytes: 123 } }
    const projected = uiCommandFields('scene_edit', {
      mount: billingMount,
      snapshot: {
        revision: 1,
        entities: [
          { entityId: 'u', components: { myWidget: { mount: billingMount } } },
          { entityId: 'f', components: { camera: { fovYDeg: 50, mount: billingMount } } },
          { entityId: 'g', components: { camera: { mount: billingMount } } },
          { entityId: 'x', components: { camera: { fovYDeg: 50, mount: { ...realMount(), token: MARKER_TOKEN } } } },
        ],
      },
    }, ROOTS)
    const entities = (projected!.snapshot as { entities: Entity[] }).entities
    expect(plain(plain(entities[0]!.components).myWidget).mount).toBeUndefined()
    // 真相机组件里的计费 mount：形状白名单拒绝（不是"在相机里就放行"）。
    expect(plain(plain(entities[1]!.components).camera).mount).toBeUndefined()
    // 无 fovYDeg 的同名 namespace：不进入相机上下文，照旧按内部字段过滤。
    expect(plain(plain(entities[2]!.components).camera).mount).toBeUndefined()
    // 白名单是精确 schema：多带一个任意键的 mount 不再按真实挂载放行。
    expect(plain(plain(entities[3]!.components).camera).mount).toBeUndefined()
    const wire = JSON.stringify(projected)
    expect(wire).not.toContain('mountId')
    expect(wire).not.toContain('expiresAt')
    expect(wire).not.toContain(MARKER_TOKEN)
  })

  test('负例：真 mount 内的机器路径仍 basename、令牌形状仍脱敏', () => {
    const withPath = uiCommandFields('scene_edit', {
      snapshot: {
        revision: 1,
        entities: [
          { entityId: 'c', components: { camera: { fovYDeg: 50, mount: { entityId: 'e', bodyName: MARKER_OUTSIDE_PATH, positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } } } },
          { entityId: 't', components: { camera: { fovYDeg: 50, mount: { entityId: MARKER_TOKEN, bodyName: 'wrist_3_link', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } } } },
        ],
      },
    }, ROOTS)
    const entities = (withPath!.snapshot as { entities: Entity[] }).entities
    const pathMount = plain(plain(entities[0]!.components).camera).mount
    expect(pathMount.bodyName).toBe('model.onnx')
    expect(pathMount.entityId).toBe('e')
    const tokenMount = plain(plain(entities[1]!.components).camera).mount
    expect(tokenMount.entityId).not.toContain(MARKER_TOKEN)
    const wire = JSON.stringify(withPath)
    expect(wire).not.toContain('/home/alice')
    expect(wire).not.toContain(MARKER_TOKEN)
  })

  test('负例：计费回执顶层 mount 仍不下发，且 mount 仍在全局内部字段表中', () => {
    const leaky = { status: 'PACK_DIRECT_CONTROL', mount: { mountId: 'mount-1', expiresAt: MARKER_USER_PATH, budget: { maxBytes: 1 } }, nextSteps: [MARKER_TOKEN] }
    for (const mode of ['formal', 'developer']) {
      const response = commandRouteResponse('policy_prepare', { kind: 'success', text: JSON.stringify(leaky) }, mode, ROOTS)
      const wire = JSON.stringify(response)
      expect(wire).not.toContain('mountId')
      expect(wire).not.toContain(MARKER_USER_PATH)
      expect(wire).not.toContain('nextSteps')
      expect(wire).not.toContain(MARKER_TOKEN)
    }
    // 本单没有全局删除 `mount` 的隐私过滤规则：计费语义的同名键仍在内部字段表里。
    expect(isInternalFieldName('mount')).toBe(true)
    expect(isInternalFieldName('mountId')).toBe(true)
    expect(isInternalFieldName('mount_snapshot')).toBe(true)
  })
})
