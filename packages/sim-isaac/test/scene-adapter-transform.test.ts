/**
 * ISAAC-11（T3）离线核对：Scene 变换契约 —— 视觉的完整矩阵复合 vs 碰撞的「逐轴 TRS」。
 *
 * 做法：用 AST 从 `packages/sim-isaac/python/scene_adapter.py` 抽出**真源码**的 `poses()` 与
 * `collision_pose_rejection()`（不复制逻辑），在**真 Gf**（Isaac 环境 pxr）上跑矩阵数值对照：
 *   · 视觉/声明侧：`A = poses(scene)[eid]` 的 3×3 线性部分（完整矩阵复合）；
 *   · 碰撞侧：把 A 逐行拆成 `diag(norms)·R`（「逐轴缩放×旋转」唯一可能的形式），据此组 collider 世界矩阵；
 *   · 判据：`R·Rᵀ` 的非对角是否为 0（R 是不是旋转）与 `det(R)`（是否镜像）。
 * 接受时两条路径必须给出同一个矩阵；剪切/镜像/零分量时 `collision_pose_rejection` 必须返回可定位原因。
 *
 * 边界（不夸大）：这是矩阵数值核对，**不是引擎实测**——没有启动 Kit、没有 PhysX、没有装配任何
 * collider；「PhysX 真的拒绝镜像/剪切」依据的是 PhysX 正缩放要求这一契约判断，未在引擎里复验。
 * 本机没有带真 Gf 的解释器时整份跳过并说明原因（与仓库既有 MuJoCo 相机测试同一口径），不假装通过。
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 负对照入口：指向旧版本源码时契约检查不存在，断言必须失败。
const SOURCE = process.env.LYAPUNOV_SCENE_ADAPTER ?? resolve(HERE, '..', 'python', 'scene_adapter.py')
const REPO = resolve(HERE, '..', '..', '..')
const ISAAC_PY = process.env.LYAPUNOV_ISAAC_PY ?? resolve(REPO, '.runtime', 'conda', 'envs', 'isaac', 'bin', 'python')

const HARNESS = `
"""Offline transform-contract probe for SceneAdapter.poses / collision_pose_rejection (T3 ISAAC-11).

Runs the REAL poses() and collision_pose_rejection() source (AST-extracted from
scene_adapter.py -- not a copy) on real Gf and checks, per case:

  A            = poses(scene)[eid] 的 3x3 线性部分（完整矩阵复合，真 Gf）
  norms/R      = 逐行拆分：A = diag(norms)*R      （碰撞侧「逐轴 TRS」要能成立的唯一形式）
  rotationError= max |offdiag(R*R^T)|             （R 是不是旋转：0=是，>0=含剪切）
  rotationDet  = det(R)                           （-1=镜像，PhysX 的正缩放表达不了）
  colliderDiff = ||S_h*T_c*M - (diag(norms*h)*R + (c*norms)*R + t)||_max

Prints one JSON document. Not an engine run: no Kit, no PhysX, no collider assembly.
"""
import ast
import json
import math
import sys

from pxr import Gf

SOURCE = sys.argv[1]


def load(source_path):
    tree = ast.parse(open(source_path, encoding='utf-8').read())
    wanted = {'poses', 'collision_pose_rejection'}
    body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    body.append([node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'SceneError'][0])
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    return module


def matrix_rows(matrix):
    return [[float(matrix[i][j]) for j in range(4)] for i in range(4)]


def determinant3(rows):
    return (rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
            - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
            + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]))


def rotation_error(linear):
    """R*R^T 的非对角最大绝对值：0 表示三行两两正交（R 是旋转/反射），否则含剪切。"""
    gram = [[sum(linear[i][k] * linear[j][k] for k in range(3)) for j in range(3)] for i in range(3)]
    return max(abs(gram[i][j]) for i in range(3) for j in range(3) if i != j)


def full_matrix_path(matrix, center, half):
    """USD/视觉侧：完整矩阵复合下 collider 的世界矩阵 = S_h*T_c*M（真 Gf 产出的 M）。"""
    rows = matrix_rows(matrix)
    linear = [[half[i] * rows[i][j] for j in range(3)] for i in range(3)]
    translation = [sum(center[k] * rows[k][j] for k in range(3)) + rows[3][j] for j in range(3)]
    return [linear[i] + [0.0] for i in range(3)] + [translation + [1.0]]


def trs_reconstructed_path(norms, rotation, translation, center, half):
    """碰撞侧：把 A 拆成 diag(norms)*R 后逐轴组 collider（正尺寸 norms*h，center 逐轴映射）。"""
    linear = [[norms[i] * half[i] * rotation[i][j] for j in range(3)] for i in range(3)]
    offset = [sum(center[k] * norms[k] * rotation[k][j] for k in range(3)) for j in range(3)]
    return [linear[i] + [0.0] for i in range(3)] + [[offset[j] + translation[j] for j in range(3)] + [1.0]]


def diff(a, b):
    return max(abs(a[i][j] - b[i][j]) for i in range(4) for j in range(4))


def rotation_z(degrees):
    half = math.radians(degrees) / 2
    return [0.0, 0.0, math.sin(half), math.cos(half)]


def entity(eid, position, quaternion, scale, parent=None):
    return {'entityId': eid, 'parentId': parent,
            'transform': {'position': position, 'quaternion': quaternion, 'scale': scale}}


IDENTITY = [0.0, 0.0, 0.0, 1.0]
CENTER = [0.3, 0.1, 0.2]
HALF = [0.2, 0.15, 0.25]


def scenario(name, entities, eid, index, center=None, half=None):
    # where 与调用处同构：'实体 <id>（<prim path>）'，用来核对错误信息可定位。
    return {'case': name, 'entityId': eid, 'entities': entities, 'where': '实体 ' + eid + '（/World/entities/e' + str(index) + '）',
            'center': CENTER if center is None else center, 'half': HALF if half is None else half}


SCENARIOS = [
    # 均匀缩放 + 旋转：TRS 可表示，两条路径必须给出同一个矩阵
    scenario('uniform-scale-rotation', [entity('e0', [1, 0, .5], rotation_z(30), [2, 2, 2])], 'e0', 0),
    # 非均匀缩放与旋转在同一实体上：仍是「缩放×旋转」，两条路径一致
    scenario('same-entity-nonuniform', [entity('e0', [1, 0, .5], rotation_z(45), [2, 1, 1])], 'e0', 0),
    # 父层均匀缩放 + 子件旋转：乘积仍是「均匀缩放×旋转」，一致
    scenario('nested-uniform-child-rotation', [entity('p', [.5, 0, 0], rotation_z(20), [2, 2, 2]),
                                               entity('c', [.4, .1, 0], rotation_z(45), [1, 1, 1], 'p')], 'c', 1),
    # 父层非均匀缩放 + 子件轴对齐 90 度旋转：置换，仍无剪切（边界例，不能被误拒）
    scenario('nested-nonuniform-child-90', [entity('p', [.5, 0, 0], IDENTITY, [2, 1, 1]),
                                            entity('c', [.4, .1, 0], rotation_z(90), [1, 1, 1], 'p')], 'c', 1),
    # 父层非均匀缩放 + 子件任意角旋转：剪切，逐轴 TRS 不再成立 → 明确拒绝
    scenario('nested-nonuniform-child-45', [entity('p', [.5, 0, 0], IDENTITY, [2, 1, 1]),
                                            entity('c', [.4, .1, 0], rotation_z(45), [1, 1, 1], 'p')], 'c', 1),
    # 负缩放（镜像）：det(R) < 0 → 拒绝（不是路径分叉，是 PhysX 正缩放表达不了）
    scenario('negative-scale', [entity('e0', [0, 0, 0], IDENTITY, [-2, 1, 1])], 'e0', 0),
    # 负缩放 + 旋转：仍是镜像 → 拒绝
    scenario('negative-scale-rotated', [entity('e0', [0, 0, 0], rotation_z(30), [-1, 2, 1])], 'e0', 0),
    # 零缩放分量：几何被压成退化面 → 拒绝
    scenario('zero-scale', [entity('e0', [0, 0, 0], IDENTITY, [1, 0, 1])], 'e0', 0),
]


def main():
    namespace = {'Gf': Gf, 'math': math}
    exec(compile(load(SOURCE), SOURCE, 'exec'), namespace)
    pose_of = namespace['poses']
    contract_present = 'collision_pose_rejection' in namespace
    # 负对照：旧版本没有契约检查时不去崩，交给断言失败（rejection 恒为 None）。
    rejection_of = namespace['collision_pose_rejection'] if contract_present else (lambda matrix, where: None)

    results = []
    for item in SCENARIOS:
        scene = {'entities': item['entities']}
        matrix = pose_of(scene)[item['entityId']]
        linear = [matrix_rows(matrix)[i][:3] for i in range(3)]
        norms = [math.sqrt(sum(value * value for value in row)) for row in linear]
        rejection = rejection_of(matrix, item['where'])
        if min(norms) <= 0:
            # 零缩放：A 不可逆，逐行拆分无定义（拒绝原因就是这条），不硬算数字。
            results.append({'case': item['case'], 'entityId': item['entityId'], 'rejection': rejection,
                            'accepted': rejection is None, 'rotationError': None, 'rotationDet': None,
                            'colliderDiff': None})
            continue
        rotation = [[linear[i][j] / norms[i] for j in range(3)] for i in range(3)]
        rows = matrix_rows(matrix)
        full = full_matrix_path(matrix, item['center'], item['half'])
        reconstructed = trs_reconstructed_path(norms, rotation, rows[3][:3], item['center'], item['half'])
        results.append({
            'case': item['case'], 'entityId': item['entityId'],
            'rejection': rejection, 'accepted': rejection is None,
            'rotationError': rotation_error(rotation),
            'rotationDet': determinant3(rotation),
            'colliderDiff': diff(full, reconstructed),
        })
    print(json.dumps({'contractPresent': contract_present, 'cases': results}, sort_keys=True))


main()
`

interface CaseResult {
  case: string
  entityId: string
  rejection: string | null
  accepted: boolean
  rotationError: number | null
  rotationDet: number | null
  colliderDiff: number | null
}

interface ProbeResult {
  contractPresent: boolean
  cases: CaseResult[]
}

function runProbe(): ProbeResult {
  if (!existsSync(ISAAC_PY)) throw new Error('缺真 Gf 解释器: ' + ISAAC_PY)
  const run = spawnSync(ISAAC_PY, ['-c', HARNESS, SOURCE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) throw new Error('变换契约探针无法执行：' + String(run.error))
  if (run.status !== 0) throw new Error('变换契约探针失败 (exit ' + String(run.status) + ')：' + (run.stderr || run.stdout))
  return JSON.parse(run.stdout)
}

function near(actual: number | null, expected: number, epsilon = 1e-12): void {
  expect(actual).not.toBeNull()
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(epsilon)
}

if (!existsSync(ISAAC_PY)) {
  test.skip('Scene 变换契约（ISAAC-11）：缺带真 Gf 的解释器 ' + ISAAC_PY + '，整份跳过并说明原因，不假装通过', () => {})
} else {
  const probe = runProbe()
  const caseOf = (name: string): CaseResult => {
    const found = probe.cases.find(entry => entry.case === name)
    if (!found) throw new Error('场景缺失: ' + name)
    return found
  }

  describe('Scene 变换契约 via 真 Gf (' + ISAAC_PY + ')', () => {
    test('契约检查存在（旧源码负对照时必须失败）', () => {
      expect(probe.contractPresent).toBe(true)
    })

    test('均匀缩放＋旋转：两条路径给出同一矩阵，契约接受', () => {
      for (const name of ['uniform-scale-rotation', 'same-entity-nonuniform', 'nested-uniform-child-rotation', 'nested-nonuniform-child-90']) {
        const item = caseOf(name)
        expect(item.accepted).toBe(true)
        // R·Rᵀ 非对角为 0 ⇒ A = diag(norms)·R 是「逐轴缩放×旋转」，det=+1 ⇒ R 真是旋转。
        near(item.rotationError, 0, 1e-12)
        near(item.rotationDet, 1, 1e-12)
        // 两条路径的 collider 世界矩阵逐项一致（完整矩阵复合 = 逐轴 TRS 重组）。
        near(item.colliderDiff, 0, 1e-12)
      }
    })

    test('父层非均匀缩放＋子件旋转：两条路径不再等价 → 明确拒绝且可定位', () => {
      const item = caseOf('nested-nonuniform-child-45')
      expect(item.accepted).toBe(false)
      expect(item.rejection).toContain('剪切')
      expect(item.rejection).toContain('c')
      expect(item.rejection).toContain('/World/entities/e1')
      // 拒绝不是空转：R·Rᵀ 的非对角到 0.6（det 0.8）≠ 旋转，任何「旋转×逐轴正缩放」都等于不了这条线性映射。
      expect(item.rotationError as number).toBeGreaterThan(0.1)
    })

    test('负缩放（镜像）：契约明确拒绝', () => {
      for (const name of ['negative-scale', 'negative-scale-rotated']) {
        const item = caseOf(name)
        expect(item.accepted).toBe(false)
        expect(item.rejection).toContain('镜像')
        expect(item.rejection).toContain('行列式')
        // 镜像的路径分叉不在数值上（逐行拆分仍能重建矩阵），而在 R 不是旋转：det = −1。
        near(item.rotationDet, -1, 1e-12)
        near(item.rotationError, 0, 1e-12)
      }
    })

    test('零缩放分量：退化几何明确拒绝', () => {
      const item = caseOf('zero-scale')
      expect(item.accepted).toBe(false)
      expect(item.rejection).toContain('0 分量')
    })

    test('接受与否与独立算出的判据一致（无漏放、无空转）', () => {
      for (const item of probe.cases) {
        const representable = item.rotationError !== null
          && item.rotationError <= 1e-9
          && (item.rotationDet as number) > 0
        expect(item.accepted).toBe(representable)
      }
    })

    test('调用处接线：装配 Scene 碰撞前按实体 id／路径拒绝（结构核对，非运行 populate）', () => {
      const source = readFileSync(SOURCE, 'utf8')
      expect(source.includes('collision_pose_rejection(worldposes[eid]')).toBe(true)
      expect(source.includes("'实体 '+eid+'（'+path+'）'")).toBe(true)
      expect(source.includes("Scene 碰撞不能用 Isaac collider 保真装配")).toBe(true)
      // 视觉与碰撞共用同一个世界矩阵：root 的 transform 与 primitive 的 matrix 都是 worldposes[eid]。
      expect(source.includes('root.AddTransformOp().Set(worldposes[eid])')).toBe(true)
      expect(source.includes('self.primitive(stage,path')).toBe(true)
    })
  })
}
