"""L402 真机探针：内容指纹在**中/英界面**下必须同名同值，且**降级后的键仍保留区分力**。

跑法（两种界面各跑一次；本文件由 `world-content-hash-locale.test.ts` 起进程，也可手跑）：

  BN=/snap/blender/current/blender
  $BN --background --factory-startup --python-exit-code 1 \
      --python packages/blender/test/test_world_content_hash_locale.py -- --mode hashes
  $BN --background                    --python-exit-code 1 \
      --python packages/blender/test/test_world_content_hash_locale.py -- --mode hashes

  # 负向对照：把被测 world_incremental.py 换成**改前**那一版（world.py 同目录、同 sys.path 约定）
  $BN --background --factory-startup --python-exit-code 1 \
      --python packages/blender/test/test_world_content_hash_locale.py -- \
      --mode hashes --world .runtime/lane-hash402/before_pkg/world.py

两种 mode：
  `hashes`         —— 造 `world.py` 的 `--fixture` 场景，转储每种材质的 `material_hash`、每个网格的
                      `mesh_hash` 与 `visual_content`（= `blender:content.contentHash`）。
  `discrimination` —— 在真机上逐项改**内容**与逐项改**名字**，钉住两条：真改内容必变；改本地化名字不变
                      （形态键名例外：它真的进 GLB，见下）。

输出：`LANG_PROBE=`（当前界面语言）与 `HASH_PROBE=`（JSON）各一行。
"""
import importlib.util, json, sys
from pathlib import Path

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def argument(flag, default):
    return ARGS[ARGS.index(flag) + 1] if flag in ARGS else default

ROOT = Path(__file__).resolve().parents[3]
WORLD_PATH = Path(argument('--world', str(ROOT/'packages/blender/src/world.py'))).resolve()
MODE = argument('--mode', 'hashes')

spec = importlib.util.spec_from_file_location('lyapunov_world', WORLD_PATH)
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)

import bpy  # noqa: E402  （world.py 已经 import；这里显式一次，读起来不靠副作用）

print('LANG_PROBE=' + bpy.context.preferences.view.language)
print('WORLD_PATH=' + str(WORLD_PATH))
print('INCREMENTAL_PATH=' + str(Path(world.__dict__['material_hash'].__code__.co_filename).resolve()))


def build():
    """与 `--fixture` 同一条构造路径：直接调用 world.py 的函数，避免复制一份场景定义在这里漂移。"""
    world.build_fixture()


def meshes():
    return sorted((o for o in bpy.context.scene.objects if o.type == 'MESH' and o.data is not None), key=lambda o: o.name)


def hash_snapshot():
    build()
    cache = {}
    materials = {m.name: world.material_hash(m, cache) for m in sorted(bpy.data.materials, key=lambda m: m.name)}
    mesh_hashes = {}
    contents = {}
    for obj in meshes():
        mesh_hashes[obj.name] = world.mesh_hash(obj.data)
        contents[obj.name] = world.visual_content(obj, cache, world.export_geometry_hash(obj),
                                                 modifiers=world.bakes_modifiers(obj))
    return {'language': bpy.context.preferences.view.language,
            'materialNames': sorted(materials),
            'materials': materials, 'meshes': mesh_hashes, 'contents': contents,
            'meshNames': sorted(mesh_hashes)}


def rows():
    """区分力逐条：每行 = (断言名, 期望, 实测)。改**内容**必须变；改**本地化名字**必须不变。"""
    output = []

    def record(name, changed, expect, detail=''):
        output.append({'name': name, 'changed': bool(changed), 'expect': expect, 'detail': detail})

    build()
    cache = {}
    floor = bpy.data.objects['floor']
    wall = bpy.data.materials['墙面']
    principled = world.node_by_type(wall.node_tree, 'BSDF_PRINCIPLED')

    base_mesh = world.mesh_hash(floor.data)
    base_content = world.visual_content(floor, {}, world.export_geometry_hash(floor), modifiers=world.bakes_modifiers(floor))
    base_material = world.material_hash(wall, {})

    # 幂等：同一次运行里连算两次必须逐位相同（哈希本身不能抖）。
    record('mesh_hash 幂等（同一次运行连算两次）', world.mesh_hash(floor.data) != base_mesh, 'same', base_mesh[:16])
    record('material_hash 幂等（同一次运行连算两次）', world.material_hash(wall, {}) != base_material, 'same', base_material[:16])

    # ── 名字：本地化的显示名（改前会误判成"内容变了"）────────────────────────────
    original = floor.data.uv_layers[0].name
    floor.data.uv_layers[0].name = 'L402_renamed_uv'
    after = world.mesh_hash(floor.data)
    record('UV 层改名 → mesh_hash 不变（层名不进 GLB，glTF 只写 TEXCOORD_0）', after != base_mesh, 'same',
           f'{original!r}→{after[:12]}')
    floor.data.uv_layers[0].name = original

    node_name = principled.name
    principled.name = 'L402_renamed_node'
    renamed_material = world.material_hash(wall, {})
    record('着色器节点改名 → material_hash 不变（glTF 材质是扁平的，不写节点名）', renamed_material != base_material, 'same',
           f'{node_name!r}→{renamed_material[:12]}')
    principled.name = node_name

    # ── 真内容：几何 / 属性数据 / 材质参数 / 接线必须变 ───────────────────────────
    coordinate = floor.data.vertices[0].co.copy()
    floor.data.vertices[0].co.x += 0.05
    record('顶点位移 → mesh_hash 变', world.mesh_hash(floor.data) != base_mesh, 'change')
    floor.data.vertices[0].co = coordinate

    uv = floor.data.uv_layers[0].data[0].uv.copy()
    floor.data.uv_layers[0].data[0].uv = (uv[0] + 0.25, uv[1])
    record('UV 数值变 → mesh_hash 变', world.mesh_hash(floor.data) != base_mesh, 'change')
    floor.data.uv_layers[0].data[0].uv = uv

    added = floor.data.uv_layers.new(name='L402_second_uv')
    record('多一层 UV → mesh_hash 变（层数/顺序进指纹）', world.mesh_hash(floor.data) != base_mesh, 'change')
    floor.data.uv_layers.remove(added)

    roughness = world.socket_by_identifier(principled, 'Roughness').default_value
    world.socket_by_identifier(principled, 'Roughness').default_value = 0.123
    record('Principled Roughness 变 → material_hash 变', world.material_hash(wall, {}) != base_material, 'change')
    world.socket_by_identifier(principled, 'Roughness').default_value = roughness

    colour = list(principled.inputs['Base Color'].default_value)
    changed_colour = list(colour); changed_colour[0] = min(1.0, changed_colour[0] + 0.2)
    principled.inputs['Base Color'].default_value = changed_colour
    record('Base Color 变 → material_hash 变', world.material_hash(wall, {}) != base_material, 'change')
    principled.inputs['Base Color'].default_value = colour

    mix = wall.node_tree.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    wall.node_tree.links.new(mix.outputs['Color'], principled.inputs['Base Color'])
    record('新增节点并改接线 → material_hash 变', world.material_hash(wall, {}) != base_material, 'change')
    # 删掉新节点即连带删掉它那两条连线，回到基线接线（基线那条 BSDF→Surface 从未被碰过）。
    wall.node_tree.nodes.remove(mix)
    record('接线复原 → material_hash 回到基线', world.material_hash(wall, {}) != base_material, 'same')

    mute = principled.mute
    principled.mute = not mute
    record('节点 mute 变 → material_hash 变', world.material_hash(wall, {}) != base_material, 'change')
    principled.mute = mute

    # 材质名：改名**不算**材质自身的参数变化（material_hash 有意剔除名字），但它是 GLB 字节的一部分
    # ⇒ 包住它的 `visual_content`（contentHash）必须变。
    wall_name = wall.name
    wall.name = 'L402_renamed_material'
    renamed = bpy.data.materials['L402_renamed_material']
    record('材质改名 → material_hash 不变（名字由外层 contentHash 捕获）', world.material_hash(renamed, {}) != base_material, 'same')
    record('材质改名 → contentHash（visual_content）变（glTF JSON 里写着材质名）',
           world.visual_content(floor, {}, world.export_geometry_hash(floor),
                                modifiers=world.bakes_modifiers(floor)) != base_content, 'change')
    renamed.name = wall_name

    # ── 形态键：名字**真的进 GLB**（`meshes[].extras.targetNames`），所以位置与名字都留在指纹里 ──────
    cube = bpy.data.objects['cube']
    cube.shape_key_add(name='Basis')
    smile = cube.shape_key_add(name='L402_smile')
    for point in smile.data:
        point.co.y += 0.1
    data_basis = world.mesh_hash(cube.data)
    basis_name = cube.data.shape_keys.key_blocks[0].name
    cube.data.shape_keys.key_blocks[0].name = 'L402_renamed_basis'
    record('形态键改名 → mesh_hash(data) 变（名字进 GLB extras.targetNames）',
           world.mesh_hash(cube.data) != data_basis, 'change', f'{basis_name!r}')
    cube.data.shape_keys.key_blocks[0].name = basis_name

    value = smile.value
    smile.value = 0.75
    record('形态键 value 变 → mesh_hash(data) 变', world.mesh_hash(cube.data) != data_basis, 'change')
    smile.value = value

    coordinate = smile.data[0].co.copy()
    smile.data[0].co.z += 0.3
    record('形态键顶点位移 → mesh_hash(data) 变', world.mesh_hash(cube.data) != data_basis, 'change')
    smile.data[0].co = coordinate

    # 结构事实：形态键没有 identifier；求值后网格（导出真正读的那份）里没有形态键层。
    block = cube.data.shape_keys.key_blocks[0]
    evaluated = cube.evaluated_get(bpy.context.evaluated_depsgraph_get())
    temporary = evaluated.to_mesh()
    try:
        output.append({'name': 'ShapeKey 结构事实（非断言）', 'changed': None, 'expect': 'info',
                       'detail': f'hasattr(block, identifier)={hasattr(block, "identifier")}'
                                 f' evaluated_mesh.shape_keys is None={temporary.shape_keys is None}'})
    finally:
        evaluated.to_mesh_clear()

    failed = [row for row in output if row['expect'] != 'info' and row['changed'] != (row['expect'] == 'change')]
    return output, failed


if MODE == 'hashes':
    print('HASH_PROBE=' + json.dumps(hash_snapshot(), ensure_ascii=False, sort_keys=True))
elif MODE == 'discrimination':
    table, failed = rows()
    # 期望表：名字类断言期望"不变"，内容类断言期望"变"；改前那一版会在名字类断言上翻车。
    print('HASH_PROBE=' + json.dumps({'language': bpy.context.preferences.view.language,
                                      'rows': table, 'failed': failed, 'passed': not failed},
                                     ensure_ascii=False, sort_keys=True))
    print('DISCRIMINATION_PASSED=' + str(not failed))
else:
    raise SystemExit(f'未知 --mode {MODE!r}')
