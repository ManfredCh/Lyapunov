"""在真实 Blender 内建造、预览、导出可编辑层级世界；单独墙体保留房间内部。

三个 operation 分开：build=构造+导出（可选渲染，原有行为）、preview=只渲染（不导出、不递增资源版本）、
export=只导出（不隐式渲染）。文字/曲线等可显示对象在**派生副本**里转 MESH 导出，源工程保持可编辑。
"""
import bpy, hashlib, json, math, os, re, shutil, sys, tempfile, time, traceback, uuid
from pathlib import Path
from mathutils import Matrix, Quaternion, Vector

# 增量导出支撑（内容指纹/版本化文件/按需落盘）与本源同目录；`--python` 与 runpy 两种加载方式下 __file__ 都指向本文件。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from world_incremental import (WorldIncrement, curve_digest, extras_hash, facts, material_hash, mesh_hash,
                               modifier_facts, rna_facts, visual_content, write_bytes_if_changed, write_text_if_changed)

# 可显示对象类型：MESH 直接导出；FONT/CURVE/SURFACE/META 没有网格数据，在派生副本里转 MESH 后导出。
VISUAL_TYPES=('MESH','FONT','CURVE','SURFACE','META')
# 进实体列表的对象：EMPTY 只承载层级（parentId 指向它），本身没有可导出的几何。
ENTITY_TYPES=('EMPTY',)+VISUAL_TYPES
# 渲染产物一律 PNG：调用方（plugin.ts 的 attachPng）按 .png 后缀与 image/png 消费这个路径。
PNG_SIGNATURE=b'\x89PNG\r\n\x1a\n'
# Blender 按名去重时给同名数据块加的后缀（`墙面` 已被占用 ⇒ 新建的拿到 `墙面.001`）。
# 发现 J 的两处判据都要用它：回收自己上一轮留下的数据块、以及把被使用的 `.001` 认回清单里的基名。
DEDUP_SUFFIX=re.compile(r'\.\d{3}$')

def machine_ids(names):
    """把显示名映射为 scene-kit safeId 可接受的稳定机器身份。

    对象名可含空格/中文/斜杠（斜杠会让 visuals/<name>.glb 越出输出子目录），而 safeId 只接受
    ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$。身份属于对象本身，不由其它对象的名字集合决定：
    - 名字本身就是合法 safeId 时，机器身份就是它本身（既有合法名不会被同形非法名抢走）；
    - 非法名用 'entity-<消毒前缀>-<名称hash>' 派生，只取决于该对象自己的名字，新增/删除其它对象
      不会改变它；派生结果若与某个合法名撞车（人为把对象命名成派生串），按固定次序延长 hash 前缀。
    显示名原样写入 entity.name / blenderObject。
    """
    names=list(names)
    legal={name for name in names if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}',name)}
    result={name:name for name in legal};used=set(legal)
    for name in sorted(set(names)-legal):
        slug=re.sub(r'[^A-Za-z0-9_.:-]','-',name)[:40]
        digest=hashlib.sha256(name.encode('utf-8')).hexdigest()
        for take in range(8,41,4):
            candidate=('entity-'+slug+'-' if slug else 'entity-')+digest[:take]
            if candidate not in used: break
        used.add(candidate);result[name]=candidate
    return result

def node_by_type(node_tree, node_type):
    """按节点**内部类型**（`node.type`，RNA 枚举）找节点，与界面语言无关。

    这里**不能**用 `nodes.get('Principled BSDF')`：节点的 `.name` 在**新建时按当时的界面语言取名**
    （真机实测 5.2.2：`en_US` 得到 'Principled BSDF'，`zh_HANS` 得到 '原理化 BSDF'），
    所以打开既有工程/带中文偏好时英文名查找会落空成 `None`，再取 `.inputs` 就崩。
    `node.type`/`bl_idname` 是内部标识，不被翻译。
    """
    for node in node_tree.nodes:
        if node.type == node_type: return node
    return None

def socket_by_identifier(node, identifier, output=False):
    """按插槽**内部 identifier**（`socket.identifier`）取插槽，与界面语言无关。

    'Base Color'/'Roughness'/'Normal'/'Color'/'Fac'/'Color1' 这些是 RNA 内部名（identifier），
    不是界面上的显示名：真机实测 5.2.2 下中英两种界面的 identifier 逐字相同。
    取不到就**如实报错**，不返回 None 蒙混（None 会在下游变成更难读的错）。
    """
    for item in (node.outputs if output else node.inputs):
        if item.identifier == identifier: return item
    raise RuntimeError(f'BLENDER_SOCKET_MISSING: 节点 {node.name!r}（{node.type}）没有 identifier={identifier!r} 的插槽')

def principled(node_tree, material_name):
    """材质节点树里的 Principled BSDF；不存在就如实报错（不静默、不假装成功）。"""
    bsdf=node_by_type(node_tree,'BSDF_PRINCIPLED')
    if bsdf is None: raise RuntimeError(f'BLENDER_PRINCIPLED_MISSING: 材质 {material_name!r} 的节点树里没有 BSDF_PRINCIPLED 节点')
    return bsdf

def material(name, rgba):
    m=bpy.data.materials.new(name); m.diffuse_color=rgba; m.use_nodes=True
    socket_by_identifier(principled(m.node_tree,name),'Base Color').default_value=rgba
    return m

def apply_material_colors(raw):
    """显式声明的 RGBA 写入真正 PBR 插槽，不按材质名猜颜色、不修改原件。"""
    if raw is None: return []
    requested=json.loads(raw)
    if not isinstance(requested,dict): raise ValueError('MATERIAL_COLORS_INVALID: 需要材质名到RGBA的对象')
    planned=[]
    for name,rgba in requested.items():
        if not isinstance(name,str) or not isinstance(rgba,list) or len(rgba)!=4 or not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and 0<=v<=1 for v in rgba):
            raise ValueError('MATERIAL_COLORS_INVALID: '+str(name)+' 必须是四个 0..1 的有限值')
        mat=bpy.data.materials.get(name)
        if mat is None: raise ValueError('MATERIAL_COLOR_TARGET_MISSING: '+name)
        mat.use_nodes=True
        socket=socket_by_identifier(principled(mat.node_tree,name),'Base Color')
        if socket.is_linked: raise ValueError('MATERIAL_BASE_COLOR_LINKED: '+name+' 已有颜色/贴图接线，不能把default_value冒充覆盖成功')
        planned.append((mat,socket,rgba))
    result=[]
    for mat,socket,rgba in planned:
        mat.diffuse_color=rgba;socket.default_value=rgba
        result.append({'material':mat.name,'baseColor':list(socket.default_value),'source':'explicit-material-colors'})
    return result

def apply_texture_set(mat, entry):
  """把一套 PBR 贴图接到材质的 Principled BSDF 上。
  映射遵循 glTF/BSSDF 的通用约定，不做"看起来差不多"的自创接法：
    Diffuse -> Base Color；Rough -> Roughness；nor_gl -> Normal（经 Normal Map 节点）；
    AO      -> 与 Base Color 相乘（Blender 没有独立 AO 输入，乘进底色是标准做法）。
  缺哪张就跳过哪一项：颜色图缺失时**不接**（宁可保留原色，也不接半套看起来像贴图的假象）。
  """
  if not isinstance(entry, dict): return False
  maps = entry.get('maps') or {}
  if 'Diffuse' not in maps: return False
  nt = mat.node_tree
  bsdf = node_by_type(nt, 'BSDF_PRINCIPLED')
  if bsdf is None: return False
  def tex(key, non_color=False, label=''):
    path = maps.get(key)
    if not path: return None
    node = nt.nodes.new('ShaderNodeTexImage')
    node.name = node.label = f'{mat.name}-{label or key}'
    node.image = bpy.data.images.load(path, check_existing=True)
    node.interpolation = 'Linear'
    if non_color: node.image.colorspace_settings.name = 'Non-Color'
    return node
  diffuse = tex('Diffuse', False, 'diffuse')
  if diffuse is None: return False
  rough = tex('Rough', True, 'rough'); normal = tex('nor_gl', True, 'normal'); ao = tex('AO', True, 'ao')
  outlet = socket_by_identifier(diffuse, 'Color', output=True)
  if ao is not None:
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.name = mix.label = f'{mat.name}-ao-multiply'; mix.blend_type = 'MULTIPLY'; socket_by_identifier(mix, 'Fac').default_value = 1.0
    nt.links.new(socket_by_identifier(diffuse, 'Color', output=True), socket_by_identifier(mix, 'Color1'))
    nt.links.new(socket_by_identifier(ao, 'Color', output=True), socket_by_identifier(mix, 'Color2'))
    outlet = socket_by_identifier(mix, 'Color', output=True)
  nt.links.new(outlet, socket_by_identifier(bsdf, 'Base Color'))
  if rough is not None: nt.links.new(socket_by_identifier(rough, 'Color', output=True), socket_by_identifier(bsdf, 'Roughness'))
  if normal is not None:
    nmap = nt.nodes.new('ShaderNodeNormalMap'); nmap.name = nmap.label = f'{mat.name}-normal-map'
    nt.links.new(socket_by_identifier(normal, 'Color', output=True), socket_by_identifier(nmap, 'Color'))
    nt.links.new(socket_by_identifier(nmap, 'Normal', output=True), socket_by_identifier(bsdf, 'Normal'))
  return True


def load_texture_manifest(output):
  """读由调用方（blender_run）落在输出目录的 textures.json。缺文件即无贴图，不猜。"""
  path = Path(output) / 'textures.json'
  if not path.exists(): return {}
  try: data = json.loads(path.read_text())
  except Exception: return {}
  return {k: v for k, v in (data.get('sets') or {}).items() if isinstance(v, dict)}


def scene_used_materials():
  """场景里**被对象材质槽实际使用**的材质，按数据块名去重：{名字: 材质}。

  发现 J：接线只有落在这些材质上才算真的接上。`bpy.data.materials` 是数据块全集，里面有
  users=0 的同名旧孤儿（打开本作业自己的 source.blend 重跑就会有），按它按名匹配会报假成功。
  导出走的就是对象→材质槽这条路（export_selection 的 use_selection），所以"被使用"与"会进 GLB"
  是同一个集合，结果行与产物因此能互相印证。
  """
  used = {}
  for obj in bpy.context.scene.objects:
    for slot in getattr(obj,'material_slots',()) or ():
      mat = slot.material
      if mat is not None and mat.name not in used: used[mat.name]=mat
  return used


def manifest_key_for(name, manifest, keys_by_base):
  """清单键就是材质名：逐字命中优先；命中不上再按 Blender 去重后缀的基名回头找，基名唯一才认。

  例：被使用的材质叫 `墙面.001`（用户工程里本来就有同名材质，或本脚本没能把名字收回来）、清单键
  叫 `墙面` ⇒ 仍然接在**被使用的那个**上，而不是接在孤儿 `墙面` 上。两个清单键争同一个基名时不猜，
  该条落到 `error`（见 unmatched_manifest_reason）。
  """
  if name in manifest: return name
  base = DEDUP_SUFFIX.sub('',name) if DEDUP_SUFFIX.search(name) else name
  keys = keys_by_base.get(base) or []
  return keys[0] if len(keys)==1 else None


def unmatched_manifest_reason(key, used):
  """清单里一条都没匹配上：区分"场景里根本没有这个材质"与"只有 users=0 的孤儿同名数据块"。"""
  base = DEDUP_SUFFIX.sub('',key) if DEDUP_SUFFIX.search(key) else key
  orphans = sorted(item.name for item in bpy.data.materials
                   if item.users==0 and (DEDUP_SUFFIX.sub('',item.name) if DEDUP_SUFFIX.search(item.name) else item.name)==base)
  if orphans:
    return (f'BLENDER_MATERIAL_UNUSED: 清单要求给材质 {key!r} 接贴图，但场景里没有任何对象的材质槽用它'
            f'（只找到 users=0 的孤儿数据块 {orphans}）——不接在没人用的数据块上，也不报成功')
  return (f'BLENDER_MATERIAL_NOT_USED: 清单要求给材质 {key!r} 接贴图，但场景里没有任何对象的材质槽用它'
          f'（当前被使用的材质：{sorted(used)}）')


def wire_material_textures(output):
  """按 manifest 的 {材质名: 贴图资产} 给**场景实际使用的材质**接节点；返回真实读数（发现 J）。

  读数只反映"被使用的材质"：接上的逐条给 assetId/license/maps；清单里没匹配到被使用材质的、
  只匹配到 users=0 孤儿的、或接不上的，逐条 `error` 如实报 —— **不把没人用的数据块报成成功**。
  """
  manifest = load_texture_manifest(output)
  if not manifest: return {}
  used = scene_used_materials()
  keys_by_base = {}
  for key in manifest:
    keys_by_base.setdefault(DEDUP_SUFFIX.sub('',key) if DEDUP_SUFFIX.search(key) else key,[]).append(key)
  wired = {}; matched = set()
  for name in sorted(used):
    key = manifest_key_for(name,manifest,keys_by_base)
    if key is None: continue
    matched.add(key); entry = manifest[key]
    try:
      if apply_texture_set(used[name],entry):
        wired[name] = {'assetId':entry.get('assetId'), 'license':entry.get('license'), 'maps':sorted((entry.get('maps') or {}).keys())}
      else:
        wired[name] = {'error':f'BLENDER_TEXTURE_NOT_APPLIED: 材质 {name!r} 没接上贴图（清单缺少 Diffuse 颜色图，或材质没有可用的 Principled BSDF 节点树）'}
    except Exception as error:
      # 结构化码 + 原因原文：Blender 的异常文案**随界面语言变**（'错误: 无法读取 …' / 'Error: Cannot read …'），
      # 机器读数必须与语言无关 ⇒ 码在前（与上面的 NOT_APPLIED/NOT_USED 同风格），原文只作细节，并去掉尾换行。
      wired[name] = {'error':f'BLENDER_TEXTURE_MAP_UNREADABLE: {str(error).strip()}'}
  for key in sorted(manifest):
    if key not in matched: wired[key] = {'error':unmatched_manifest_reason(key,used)}
  return wired


def empty(name, location, parent=None):
    o=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(o); o.parent=parent; o.location=location; return o

def box(name, location, size, mat, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=location; o.dimensions=size
    # 数据块名必须和对象名一样显式给定：primitive_* 新建的网格数据块名随**界面语言**本地化
    # （en_US 'Cube' / zh_HANS '立方体'），而它既是资源身份（visual_resource_id 的 slug 与 hash
    # 都取自 obj.data.name）又是 GLB 节点名 —— 不赋值就等于让 resourceId 随界面语言变。
    o.data.name=name
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat); o['lyapunov_shape']='box'; o['lyapunov_size']=list(size); return o

# build_fixture() 自产的名字（对象名＝网格/相机/灯数据块名，另加它自己的三个材质名）：重建前只回收
# **这些名字**上 users==0 的孤儿数据块（见 reclaim_owned_datablocks），用户工程里的其它名字一律不碰。
FIXTURE_MATERIAL_NAMES=('墙面','木材','蓝色方块')
FIXTURE_OBJECT_NAMES=('room','floor','wall_back','wall_left','wall_right','front_left','front_right','door_lintel',
                      'table','tabletop','cube','door','door_panel','preview_camera','preview_key')+tuple(
                      'leg_'+str(x)+'_'+str(y) for x in (-.58,.58) for y in (-.33,.33))

def owned_datablock_name(name, names):
  """名字是否属于本脚本：逐字命中，或去掉 Blender 去重后缀（`.001`）后命中。"""
  return name in names or (DEDUP_SUFFIX.search(name) is not None and DEDUP_SUFFIX.sub('',name) in names)

def reclaim_owned_datablocks(names):
  """把本脚本自己的名字从**上一轮遗留的孤儿数据块**手里收回来（发现 J 的根因）。

  `bpy.ops.object.delete()` 只删对象：网格/材质/相机/灯的数据块仍留在工程里。A5 恢复打开的是本作业
  自己写出的 `output/source.blend`，于是重跑 fixture 时 `materials.new('墙面')` 只能拿到 `墙面.001`
  —— 贴图按名接在 users=0 的旧 `墙面` 上，导出走对象材质槽拿到没有贴图的 `墙面.001`，结果行却报
  "接上了"（假成功）。名字必须确定性地回到本脚本手里。
  顺序：**先网格/相机/灯、后材质**——孤儿网格的材质槽还攥着旧材质，Blender 的 users 读数把网格算作
  使用者（实测：删完对象后 `Material` 仍读 users=1，直到引用它的孤儿网格被清除才落到 0）。
  边界：只回收 `names` 里的名字、且 `users==0` 的数据块；用户自带工程里在用的数据块一个都不动。
  """
  for collection in (bpy.data.meshes,bpy.data.cameras,bpy.data.lights,bpy.data.materials):
    for datablock in [item for item in collection if item.users==0 and owned_datablock_name(item.name,names)]:
      collection.remove(datablock)

def build_fixture():
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    reclaim_owned_datablocks(FIXTURE_MATERIAL_NAMES+FIXTURE_OBJECT_NAMES)
    bpy.context.scene.unit_settings.system='METRIC'; bpy.context.scene.unit_settings.scale_length=1
    wall=material('墙面',(0.65,0.69,0.75,1)); wood=material('木材',(0.38,0.19,0.08,1)); blue=material('蓝色方块',(0.02,0.3,0.8,1))
    room=empty('room',(0,0,0))
    for n,p,s in [('floor',(0,0,-.06),(5,4,.12)),('wall_back',(0,2,1.3),(5,.12,2.6)),('wall_left',(-2.5,0,1.3),(.12,4,2.6)),('wall_right',(2.5,0,1.3),(.12,4,2.6)),('front_left',(-2, -2,1.3),(1,.12,2.6)),('front_right',(1,-2,1.3),(3,.12,2.6)),('door_lintel',(-1,-2,2.4),(1,.12,.4))]: box(n,p,s,wall,room)
    table=empty('table',(0,0,0),room)
    box('tabletop',(0,0,.75),(1.4,.9,.08),wood,table)
    for x in [-.58,.58]:
      for y in [-.33,.33]: box('leg_'+str(x)+'_'+str(y),(x,y,.345),(.08,.08,.69),wood,table)
    cube=box('cube',(0,0,.83),(.08,.08,.08),blue,room); cube['lyapunov_dynamic']=True
    door=empty('door',(-1.48,-1.9,0),room); door['lyapunov_joint']='hinge'; door['lyapunov_axis']=[0,0,1]; door['lyapunov_range']=[0,1.57]
    box('door_panel',(.5,0,1.05),(.94,.06,2.02),wood,door)
    # Joint zero must match the exported Blender pose.  A preview-only angle
    # here would be baked into the body transform and make the closed door
    # collide with the jamb before MuJoCo can actuate it.
    door.rotation_euler.z=0
    # operator 建的相机/灯：**对象名与数据块名都要显式给**。数据块名同样随界面语言自动命名
    # （en_US 'Camera.001'/'Area' vs zh_HANS '摄像机'/'面光'），会渗进探针/GLB 节点名；对象名不写明
    # 则连 entityId/name 一起漏进 scene.json —— 同一逻辑场景在中/英机器上不可复现，理由同 box()。
    bpy.ops.object.camera_add(location=(6,-8,10)); camera=bpy.context.object; camera.name='preview_camera'; camera.data.name='preview_camera'; direction=Vector((0,0,.65))-camera.location; camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler(); bpy.context.scene.camera=camera
    bpy.ops.object.light_add(type='AREA', location=(0,-1,6)); key=bpy.context.object; key.name='preview_key'; key.data.name='preview_key'; key.data.energy=1400; key.data.shape='DISK'; key.data.size=6
    bpy.context.scene.render.engine='CYCLES'; bpy.context.scene.cycles.samples=12
    bpy.context.scene.render.resolution_x=960; bpy.context.scene.render.resolution_y=720; bpy.context.scene.render.resolution_percentage=100

# build_architecture_fixture() 自产的名字：理由与 FIXTURE_*_NAMES 逐字相同（同一个孤儿数据块根因）。
ARCHITECTURE_MATERIAL_NAMES=('浅色灰泥','暖木','庭院石材','庭院绿植','门金属')
ARCHITECTURE_OBJECT_NAMES=('solace_house','courtyard_floor','left_outer','right_outer','rear_wall','left_inner_front',
                           'left_inner_back','right_inner_front','right_inner_back','rear_roof','courtyard_gate',
                           'courtyard_gate_panel','sofa','coffee_table','planter','tree_canopy','walk_probe',
                           'exterior_camera','courtyard_camera','courtyard_key','golden_hour_sun')

def build_architecture_fixture():
    """A small editable courtyard house inspired by the Astra workflow.

    The scene deliberately uses independent wall/floor/furniture objects.  It
    is a compact architectural input fixture rather than a rendered image:
    the same source.blend is exported to per-object visuals, MJCF collision,
    and a USD scene reference for Isaac.
    """
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    reclaim_owned_datablocks(ARCHITECTURE_MATERIAL_NAMES+ARCHITECTURE_OBJECT_NAMES)
    bpy.context.scene.unit_settings.system='METRIC'; bpy.context.scene.unit_settings.scale_length=1
    bpy.context.scene['lyapunov_world_kind']='architecture'
    plaster=material('浅色灰泥',(0.72,0.74,0.76,1)); timber=material('暖木',(0.42,0.20,0.09,1)); stone=material('庭院石材',(0.48,0.52,0.50,1)); green=material('庭院绿植',(0.08,0.28,0.12,1)); brass=material('门金属',(0.55,0.28,0.08,1))
    house=empty('solace_house',(0,0,0))
    # U-shaped envelope: the front remains open so an agent can enter the
    # courtyard.  Every wall is an independent collision volume.
    walls=[
      ('courtyard_floor',(0,0,-.06),(12,9,.12),stone),
      ('left_outer',(-4,0,1.4),(.18,7,2.8),plaster),('right_outer',(4,0,1.4),(.18,7,2.8),plaster),
      ('rear_wall',(0,3.5,1.4),(8,.18,2.8),plaster),
      ('left_inner_front',(-2.4,-2.45,1.4),(.12,2.1,2.8),plaster),('left_inner_back',(-2.4,2.15,1.4),(.12,2.5,2.8),plaster),
      ('right_inner_front',(2.4,-2.45,1.4),(.12,2.1,2.8),plaster),('right_inner_back',(2.4,2.15,1.4),(.12,2.5,2.8),plaster),
      ('rear_roof',(0,2.6,2.9),(8,1.8,.16),timber)
    ]
    for n,p,s,m in walls: box(n,p,s,m,house)
    # A real opening in the left wing, with an independently articulated gate.
    gate=empty('courtyard_gate',(-2.30,-1.40,0),house); gate['lyapunov_joint']='hinge'; gate['lyapunov_axis']=[0,0,1]; gate['lyapunov_range']=[-1.45,1.45]
    panel=box('courtyard_gate_panel',(0,.60,1.0),(.06,1.2,1.8),timber,gate); panel['lyapunov_collision_role']='articulated'
    # A few editable furniture/landscape pieces keep the visual scene useful
    # without turning collision baking into a monolithic hull.
    box('sofa',(0,2.1,.42),(1.8,.7,.42),timber,house)
    box('coffee_table',(0,1.05,.36),(1.1,.55,.08),brass,house)
    planter=box('planter',(-1.0,-.4,.22),(.7,.7,.44),stone,house); planter['lyapunov_collision']=False
    tree=box('tree_canopy',(-1.0,-.4,1.0),(.9,.9,1.1),green,house); tree['lyapunov_collision']=False
    probe=box('walk_probe',(0,-3.0,.36),(.36,.36,.72),brass,house); probe['lyapunov_dynamic']=True; probe['lyapunov_collision_role']='navigation-probe'; probe['lyapunov_friction']=[.05,.005,.0001]
    # Two cameras and warm architectural lighting support the same Blender
    # source for review and later camera/RGBD collection.
    # 相机/灯的数据块名同样显式给（理由同 build_fixture()）。对象名不动：它们已是既有显式名。
    for name,loc,target,lens in [('exterior_camera',(11,-13,9),(0,.8,.7),28),('courtyard_camera',(0,-7,3),(0,1,.7),24)]:
      bpy.ops.object.camera_add(location=loc); camera=bpy.context.object; camera.name=name; camera.data.name=name; camera.data.lens=lens; camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler();
      if name=='exterior_camera': bpy.context.scene.camera=camera
    bpy.ops.object.light_add(type='AREA', location=(0,0,5.5)); area=bpy.context.object; area.name='courtyard_key'; area.data.name='courtyard_key'; area.data.energy=1100; area.data.shape='DISK'; area.data.size=5
    bpy.ops.object.light_add(type='SUN', location=(0,-3,5)); sun=bpy.context.object; sun.name='golden_hour_sun'; sun.data.name='golden_hour_sun'; sun.data.energy=1.8; sun.rotation_euler=(math.radians(28),math.radians(-18),math.radians(28))
    bpy.context.scene.render.engine='BLENDER_EEVEE'; bpy.context.scene.render.resolution_x=960; bpy.context.scene.render.resolution_y=640; bpy.context.scene.render.resolution_percentage=100

def export_selection(obj, path, export_name=None):
    """把单个对象按 identity 世界变换导出成 GLB。

    几何留在对象局部空间，世界位姿由实体 transform 承载（scene.json 的既有约定）；
    导出前临时解父，结束后无论成败都复原，调用方的对象不因导出而改变。
    动画必须随 GLB 导出：作者在 Blender 里打的关键帧（手势、循环、开门演示）要能在工作台播放。
    Blender 5.x 的 glTF 导出器默认已含动画，但**显式声明**关键项，避免默认值变化时静默丢动画。

    `export_name` 是 GLB 节点名：共享资源的导出必须与"哪个实例先被导出"无关，所以用稳定的身份名
    （MESH 用网格数据块名）。占着这个名字的别的对象先挪到临时名——否则 Blender 会给自己加 `.001`，
    字节就随场景里的重名情况漂移了。

    修改器必须**显式应用**：导出器默认不应用，而内容指纹读的是评估后几何——照默认导出的话，
    "改了修改器"会声明出一个新版本，字节却与旧版一字节不差（同一资源白拿两个身份）。导出器自己会
    临时关掉骨架修改器以保蒙皮，跳过修改器这件事不用我们操心；带形态键的网格除外，见 bakes_modifiers。
    """
    parent, local = obj.parent, obj.matrix_local.copy()
    previous_name, holder = obj.name, None
    if export_name and export_name != previous_name:
        holder = bpy.data.objects.get(export_name)
        if holder is not None and holder is not obj: holder.name = '__lyapunov_export_tmp__' + export_name[:40]
        obj.name = export_name
    bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active=obj
    obj.parent=None; obj.matrix_world=Matrix.Identity(4)
    try:
        bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_extras=True,
          export_animations=True,export_animation_mode='ACTIONS',export_frame_range=False,export_bake_animation=False,
          export_optimize_animation_size=False,export_anim_single_armature=True,export_apply=bakes_modifiers(obj))
    finally:
        obj.parent=parent; obj.matrix_local=local
        if obj.name != previous_name: obj.name = previous_name
        if holder is not None: holder.name = export_name
        bpy.context.view_layer.update()

def evaluated_geometry_hash(obj):
    """对象**评估后**几何的数据指纹（修改器已应用）。临时网格有效期内读完，见 93 的有效期教训。"""
    evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh=evaluated.to_mesh()
    try: return mesh_hash(mesh)
    finally: evaluated.to_mesh_clear()

def bakes_modifiers(obj):
    """这个对象的修改器会不会被烘进 GLB：导出器拒绝给**带形态键**的网格应用修改器（否则丢变形目标），
    其余一律应用。导出、几何指纹、内容指纹三处共用这一个判据，避免"声明了新版本、字节却没变"。"""
    return bool(obj.modifiers) and getattr(obj.data,'shape_keys',None) is None

def export_geometry_hash(obj):
    """内容指纹要读的几何 = 导出真正写出去的那份：会被烘的修改器读评估后几何，不会被烘的读原始数据块。"""
    if obj.modifiers and not bakes_modifiers(obj): return mesh_hash(obj.data)
    return evaluated_geometry_hash(obj)

def visual_resource_id(obj, ids, namespace):
    """可视资源身份：MESH 按**共享的网格数据块**（链接副本共用一个资源；改数据块 = 改它的全部实例），
    其余（文字/曲线等派生几何）按对象——它们的派生几何本来就不共享。改名 = 新身份，内容变 = 新版本。"""
    if obj.type=='MESH' and obj.data is not None:
        slug=re.sub(r'[^A-Za-z0-9_.:-]','-',obj.data.name)[:40] or 'mesh'
        return f'{namespace}-mesh-{slug}-{hashlib.sha256(obj.data.name.encode("utf-8")).hexdigest()[:8]}-mesh'
    return f'{namespace}-{ids[obj.name]}-mesh'

def blend_state_digest(cache):
    """source.blend 的"这次要不要保存"判据：覆盖场景里所有对象的几何/材质/属性与场景自有属性。

    它只决定 .blend 的 mtime，不决定任何派生内容；宁可多存：指纹读不完整的类型（骨骼等集合数据）
    一律当作"变了"，绝不因为判据漏读而让用户的编辑没被保存。
    """
    # 只算**会被写进 .blend** 的数据块。0 用户且无假用户的数据块在保存时被丢弃，若把它们算进判据，
    # 判据永远追不上文件里存得下的那份状态（实测：首次导出后连存两次 source.blend 才收敛）。
    def saved(item):
        return item.users>0 or item.use_fake_user
    # 位姿要先求值：脚本改完 location/scale 后 `matrix_local` 直到依赖图更新前都是旧值，
    # 若直接读，则"刚改完就导出"的工程会被判成没变（实测：只移相机的导出没保存工程）。
    bpy.context.view_layer.update()
    parts=[]
    for obj in sorted((item for item in bpy.data.objects if saved(item)),key=lambda item:item.name):
        data=obj.data; covered=True; kind=data.bl_rna.identifier if data is not None else None
        if data is None: data_key=None
        elif kind=='Mesh': data_key=(kind,mesh_hash(data))
        elif kind in ('Curve','TextCurve','SurfaceCurve','Font'): data_key=(kind,curve_digest(data),rna_facts(data,cache))
        elif kind in ('Light','Camera','Speaker','Volume'): data_key=(kind,rna_facts(data,cache))
        else: data_key=(kind,'uncovered'); covered=False
        parts.append((obj.name,obj.type,obj.parent.name if obj.parent else None,
                      [[round(value,6) for value in row] for row in obj.matrix_local],extras_hash(obj),data_key,covered,
                      [slot.material.name if slot.material else None for slot in obj.material_slots],
                      # 修改器挂在**对象**上，不在这份数据块指纹里：漏了它，只加一个修改器的编辑就判成"工程没变"，
                      # 工程不落盘 → 下一轮载入的旧工程把这一版的可视内容又倒回去（实测：石狮_西 的 v2 退回 v1）。
                      modifier_facts(obj,cache)))
    # 材质只算**场景对象真的在用**的那批（外加假用户保留的）：孤立网格数据块（例如被删掉的常见
    # 起始立方体）会给用户材质留 1 个引用计数，但那份材质并不属于这个工程的状态。
    used=set()
    for obj in bpy.data.objects:
        if not saved(obj): continue
        for slot in obj.material_slots:
            if slot.material is not None: used.add(slot.material.name)
        data=obj.data
        for slot in getattr(data,'materials',[]) or []:
            if slot is not None: used.add(slot.name)
    materials=sorted((material.name,material_hash(material,cache)) for material in bpy.data.materials
                     if material.use_fake_user or material.name in used)
    props=sorted((str(key),str(value)) for key,value in bpy.context.scene.items()
                 if key not in ('lyapunov_export_version','lyapunov_source_state'))
    return hashlib.sha256(json.dumps([parts,materials,props],sort_keys=True,ensure_ascii=False,default=str).encode('utf-8')).hexdigest()

def derived_mesh_copy(source):
    """可显示但不是网格的对象（文字/曲线/曲面/元球）→ 派生 MESH 副本；**原对象不动**。

    在派生副本里转换而不是就地 convert，理由是源工程的可编辑性：source.blend 落盘在前，
    内存里的原对象也原封不动，用户回到 Blender 改的是文字内容/曲线倒角，而不是一堆烘焙网格。
    保留数据层（UV、顶点色、材质槽）用 preserve_all_data_layers + depsgraph，UV 才不会在转换时丢掉。
    调用方负责在导出后删除副本（对象与其网格数据）。
    """
    dependency_graph=bpy.context.evaluated_depsgraph_get()
    mesh=bpy.data.meshes.new_from_object(source.evaluated_get(dependency_graph),preserve_all_data_layers=True,depsgraph=dependency_graph)
    copy=bpy.data.objects.new(source.name+'__derived',mesh); bpy.context.scene.collection.objects.link(copy)
    copy.matrix_world=Matrix.Identity(4)
    # 材质按**对象解析后的槽位**覆盖到派生网格：link='OBJECT' 的覆盖存在对象上、不属于网格数据，
    # 而 new_from_object 带过来的是 data 上的那份材质（实测：覆盖是蓝的，派生网格仍是红的 data 材质）。
    # 所以每个有材质的槽都要按槽号写进去（只补空槽会把数据材质留下，GLB 里就是错的颜色/贴图），
    # 槽号之间不能错位：中间的空槽用 None 占位补齐。
    for index,slot in enumerate(source.material_slots):
        if slot.material is None: continue
        while len(mesh.materials)<=index: mesh.materials.append(None)
        mesh.materials[index]=slot.material
    return copy


def textured_without_uv(obj):
    """材质引用了图像贴图、但这份网格**没有任何 UV 层** → 贴图在 GLB 里贴不上。

    返回一句如实的损失说明（否则 None）。判据只看两件真事实：材质节点树里有没有 TEX_IMAGE 且
    真的挂了 image；网格的 uv_layers 是不是空。导出器在这种情况下**照样**把 texture/image 引用写进
    GLB，只是没有 TEXCOORD_0 —— 画面只能看到基色常量，所以这里必须显式记一条，不能静默。
    """
    mesh=getattr(obj,'data',None)
    if mesh is None or not hasattr(mesh,'uv_layers'): return None
    if len(mesh.uv_layers)>0: return None
    textured=sorted({material.name for material in getattr(mesh,'materials',[])
                     if material is not None and material.use_nodes and any(
                         node.type=='TEX_IMAGE' and node.image is not None
                         for node in material.node_tree.nodes)})
    if not textured: return None
    return (f'材质 {textured} 引用了图像贴图，但网格 {mesh.name} 没有 UV 层：GLB 里贴图引用在、'
            f'TEXCOORD_0 不在，画面只能看到基色（补 UV 或去掉贴图后重导）')


def scaled_vector(values, scale):
    """按分量缩放：折进 MJCF geom 的 pos/size 用（MJCF body 没有 scale，缩放只能落在盒子上）。"""
    return [float(values[axis])*float(scale[axis]) for axis in range(3)]

def abs_vector(values):
    return [abs(float(value)) for value in values]

def fmt(values):
    """数值按读数精度（1e-6）格式化：-0.0 归一成 0.0，避免导出文本里出现"负零"。"""
    return [str(round(float(value),6)+0.0) for value in values]

def mesh_local_bounds(mesh):
    """网格顶点集合在**自身局部帧**里的包围盒 {center,size}；没有顶点返回 None。

    极值必须在临时网格**有效期内**就算完：vertex.co 是 RNA 包装引用，to_mesh_clear() 释放网格后
    它指向的坐标数组已经不属于我们（读到的可能是被分配器复用过的别人的内存），所以逐分量取
    普通 float 再比较，不把包装向量留到释放之后。
    """
    low=None; high=None
    for vertex in mesh.vertices:
        point=(float(vertex.co[0]),float(vertex.co[1]),float(vertex.co[2]))
        if low is None:
            low=list(point); high=list(point); continue
        for axis in range(3):
            if point[axis]<low[axis]: low[axis]=point[axis]
            elif point[axis]>high[axis]: high[axis]=point[axis]
    if low is None: return None
    return {'center':[(low[axis]+high[axis])/2.0 for axis in range(3)],'size':[high[axis]-low[axis] for axis in range(3)]}

def evaluated_local_bounds(obj):
    """对象**自身局部帧**里评估后几何的包围盒（含修改器）；没有可测几何返回 None。

    读数属于数据空间：不含对象自己的 TRS/缩放，也不含父级链——这正是 scene.json 实体 transform 与
    MJCF body 表达所在的帧。物理侧本来就要按实体/父级缩放去还原世界尺寸，导出侧若把世界包围盒
    写进来，同一份非均匀缩放就会被算两次（或按 1/scale 缩小）。

    评估后（depsgraph）而不是原始 data：作者在 Blender 里看到的形状就是碰撞该包的形状；
    对象原点可以不在几何中心（几何被烘焙进顶点/导入的网格），所以中心和尺寸都要一起量。
    """
    if obj.type!='MESH': return None
    dependency_graph=bpy.context.evaluated_depsgraph_get()
    evaluated=obj.evaluated_get(dependency_graph)
    mesh=evaluated.to_mesh()
    try: return mesh_local_bounds(mesh)
    finally: evaluated.to_mesh_clear()

def exported_local_bounds(obj):
    """碰撞盒要量的几何 = **导出器真正写出去的那份**（与 export_geometry_hash 同一判据，见 bakes_modifiers）。

    带形态键的网格：导出器拒绝应用修改器（应用就丢变形目标），GLB 里就是数据块本身的几何——碰撞盒也必须
    量数据块，否则盒子里会比可视 GLB 多出一圈修改器效果（实测分叉：Solidify 加厚 0.4 的立方体，画面里是
    0.5 m、碰撞盒却是 0.9 m，谁都不知道物理在跟一个画面里不存在的体积碰撞）。
    改的是**读数来源**：对象、数据块、形态键、修改器一个都不动，源工程照旧可编辑。
    """
    if obj.type!='MESH' or obj.data is None: return None
    if obj.modifiers and not bakes_modifiers(obj): return mesh_local_bounds(obj.data)
    return evaluated_local_bounds(obj)

def collision_box(obj):
    """声明了 lyapunov_shape 的对象的碰撞盒：{center,size,boxSource,...}，量不出来返回 None。

    以**导出几何**（见 exported_local_bounds）的局部包围盒为准：会被烘的修改器算进几何；带形态键时
    修改器不烘，盒子与可视 GLB 同源，没被表示的修改器记进 unbakedModifiers + 结构化 loss（不静默丢）。
    标签 lyapunov_size 只作对照，过期时（几何被就地改过/导入后重命名）以几何为准并如实记录 declaredSizeM，
    不让陈旧元数据把碰撞盒留在旧尺寸上。标签与几何一致时不多写字段。
    """
    declared=obj.get('lyapunov_size')
    measured=exported_local_bounds(obj)
    if measured is None:
        # 没有可测几何（EMPTY、空网格）：保持既有语义——按声明尺寸放在对象原点，并标明来源。
        if declared is None: raise ValueError('BLENDER_COLLISION_SIZE_MISSING: 对象 '+obj.name+' 声明了 lyapunov_shape，但既没有声明 lyapunov_size 也没有可测几何')
        size=[float(value) for value in declared]
        return {'center':[0.0,0.0,0.0],'size':size,'boxSource':'declared-lyapunov_size'}
    box={'center':measured['center'],'size':measured['size'],'boxSource':'geometry-local-bounds'}
    if declared is not None and max(abs(float(declared[axis])-measured['size'][axis]) for axis in range(3))>1e-6:
        box['declaredSizeM']=[float(value) for value in declared]
    if obj.modifiers:
        if bakes_modifiers(obj): box['evaluatedModifiers']=[modifier.name for modifier in obj.modifiers]
        else:
            # 有形态键 ⇒ 修改器不烘（导出器保变形目标）：可视 GLB 与这个盒子都不含它们的效果。
            # 这是有意的同源，但不能静默——把没被表示的修改器连同 loss 写进产品结果，消费方不许当精确盒用。
            names=[modifier.name for modifier in obj.modifiers]
            box['unbakedModifiers']=names
            box['losses']=[{'code':'COLLISION_MODIFIERS_UNBAKED',
                            'detail':'该网格带形态键，导出器不会给带形态键的网格应用修改器（应用就丢变形目标），'
                                     '所以可视 GLB 与这个碰撞盒量的是同一份不带修改器的几何 '+obj.data.name+'；'
                                     '修改器 '+', '.join(names)+' 仍留在 source.blend 里可编辑，只是这份导出里没有它的效果。',
                            'followUp':'要让碰撞与画面都含修改器效果：把该对象上的修改器应用到几何（Blender 不允许给带形态键的网格应用修改器，'
                                       '需先去形态键或另建一个不带形态键的替身），或把该效果直接烘进网格数据再导出；'
                                       '本任务的导出器不做这种改写（保源工程可编辑与形态键）。'}]
    return box

def quaternion_xyzw(values):
    """scene.json 的合同是 xyzw，mathutils 的四元数是 wxyz：转换只在这一处。"""
    return Quaternion((float(values[3]),float(values[0]),float(values[1]),float(values[2])))

def composed_pose(byid,eid,cache):
    """实体在**消费方约定**下的世界位姿 (position,quaternion,scale)：沿父链逐分量乘缩放、再按父级朝向旋转。

    与 sim-mujoco worker 的 world_poses() 是同一套数学（子体位置 ×父级累计缩放后旋转、位置相加、
    四元数左乘、缩放逐分量相乘），所以这里算出来的世界位形就是消费方会得到的世界位形。
    """
    if eid in cache: return cache[eid]
    e=byid[eid]; t=e['transform']
    position=Vector([float(v) for v in t['position']]); quaternion=quaternion_xyzw(t['quaternion']); scale=[float(v) for v in t['scale']]
    if e.get('parentId') in byid:
        parent_position,parent_quaternion,parent_scale=composed_pose(byid,e['parentId'],cache)
        position=parent_position+parent_quaternion @ Vector(scaled_vector(position,parent_scale))
        quaternion=parent_quaternion @ quaternion
        scale=scaled_vector(scale,parent_scale)
    cache[eid]=(position,quaternion,scale); return cache[eid]

def box_half_extents(box):
    """盒的半长：导出内部读数用 'size'（整尺寸），scene.json 的碰撞组件用 'halfExtents'，两种都收。"""
    if 'halfExtents' in box: return [float(value) for value in box['halfExtents']]
    return [float(value)/2.0 for value in box['size']]

def body_frame_box(box,quaternion,scale,parent_scale):
    """数据空间（对象局部）的盒 → 本 body 帧的盒：{'center','halfExtents','exact'}。

    数据空间到世界的线性映射是 R_parent·diag(S_parent)·R_e·diag(S_e)，body 帧只把它按 R_body=R_parent·R_e
    分解：L = R_body·B，B = R_eᵀ·diag(S_parent)·R_e·diag(S_e)（世界位姿里的旋转交给 body 的 quat，geom 只承担 B）。
      · B 对角（父级等比缩放；或实体只做 90° 倍数的换轴旋转）→ 盒**精确**表示，exact=True；
      · 否则真实体积是斜平行六面体，MJCF 的轴对齐 box 表达不了：退化成该体积在 body 帧里的真实 AABB
        （行绝对值之和，保守包络：任意 |u_j|≤h_j 都有 |(B·u)_i|≤Σ_j|B_ij|·h_j），exact=False 由调用方写进 loss。
    中心一律取 B·c（两种情形都精确）；对角时 Σ_j|B_ij|·h_j 正好等于 |b_i|·h_i，与逐分量乘缩放一致——
    也就是说这条公式在原来能精确表示的位形上与原行为**逐位相同**。
    """
    rotation=quaternion.to_matrix()
    linear=(rotation.transposed() @ Matrix.Diagonal(parent_scale) @ rotation) @ Matrix.Diagonal(scale)
    center=linear @ Vector([float(v) for v in box['center']])
    extent=box_half_extents(box)
    half=[sum(abs(linear[row][column])*extent[column] for column in range(3)) for row in range(3)]
    # "对角线"判定要按**输入精度**给容差：实体四元数来自 Blender 的 matrix_local.decompose()，分量是单精度
    # （90° 转出来的 qz=0.7071067690849304），换算到 B 上就带 ~3e-8 的非对角项——那是表示误差不是剪切。
    # 真正的剪切大得多：2× 各向异性父级下差 5° 就有 ~1e-1 量级的非对角项，这个 1e-6 相对阈值分得开。
    off_diagonal=max(abs(linear[row][column]) for row in range(3) for column in range(3) if row!=column)
    magnitude=max([abs(linear[row][column]) for row in range(3) for column in range(3)]+[1.0])
    return {'center':[float(v) for v in center],'halfExtents':half,'exact':off_diagonal<=1e-6*magnitude}

def box_offsets(center,half):
    """盒的 8 个角点（相对该盒所在帧的原点）：真值、两条出口都按同一顺序生成，便于对账。"""
    return [Vector((center[0]+sx*half[0],center[1]+sy*half[1],center[2]+sz*half[2])) for sx in (-1,1) for sy in (-1,1) for sz in (-1,1)]

def hausdorff(first,second):
    """两组角点作为**点集**的最大偏差（两条边取最大）。

    盒是中心对称体：镜像/换轴时角点只是被置换，逐点对应比会假报误差，所以按点集比。
    """
    def one_way(points,others): return max(min((point-other).length for other in others) for point in points)
    return max(one_way(first,second),one_way(second,first))

def export_world(output):
    started_at=time.time()
    root=Path(output).resolve(); (root/'visuals').mkdir(parents=True,exist_ok=True); (root/'physics').mkdir(exist_ok=True)
    # MESH 直接导出；文字/曲线等可显示对象也进实体列表，几何走派生副本（见 derived_mesh_copy）。
    objects=[o for o in bpy.context.scene.objects if o.type in ENTITY_TYPES]
    # 机器身份覆盖场景内全部对象（parentId 可能指向未导出的父对象），实体/资源/文件名/MJCF 名共用它。
    ids=machine_ids(o.name for o in bpy.context.scene.objects)
    # 物理只认 MESH/EMPTY：文字/曲线原来的物理语义就是"无碰撞"，不能因为它们进了实体列表就凭空多出碰撞体。
    physics_objects={ids[o.name]:o for o in bpy.context.scene.objects if o.type in ('MESH','EMPTY')}
    previous=json.loads((root/'scene.json').read_text()) if (root/'scene.json').exists() else {}
    # 资源身份属于源工程，不能由跨工程重复的对象名决定。保存到 blend 后，
    # 同源另存继续使用相同 namespace；新建工程得到独立 namespace。
    namespace=bpy.context.scene.get('lyapunov_resource_namespace') or str(uuid.uuid4())
    # 资源**版本**不再全场统一自增：版本号 = 引入该内容的 revision（只在内容真的变化时前进）。
    # 老输出目录（revision 0 起）接着往上排，不与既有版本号相撞；本目录已有版本文件也不覆盖。
    # 候选号只在 scene.json 真的写盘时才算数（published_revision），没变时连号都不消耗。
    previous_revision=previous.get('revision')
    revision=int(previous_revision)+1 if isinstance(previous_revision,int) else 1
    bpy.context.scene['lyapunov_resource_namespace']=namespace
    # 工程里留一个自述标记（预览测试据此确认预览不占版本号）；它不是派生内容的版本来源，scene.json 才是。
    bpy.context.scene['lyapunov_export_version']=revision
    def resource_id(name): return namespace+'-'+name
    fingerprint_cache={}
    increment=WorldIncrement(root,namespace,revision,fingerprint_cache).learn(previous)
    # source.blend 是**活的编辑工程**：只有场景真的变了才重写（未变时连 mtime 都不动）。
    # 判据来自 blend 自身的状态指纹（存在场景属性里）：编辑过就一定不同，宁可多存不可漏存。
    state=blend_state_digest(fingerprint_cache)
    if bpy.context.scene.get('lyapunov_source_state')!=state:
        bpy.context.scene['lyapunov_source_state']=state
        bpy.ops.wm.save_as_mainfile(filepath=str(root/'source.blend'),relative_remap=False)
        increment.report['sourceSaved']=True
    entities=[]
    # 每个带碰撞对象的**局部帧**盒子（center/size，无缩放）：scene.json 与两个 MJCF 出口共用同一份读数，
    # 各自只做自己帧的换算（MJCF body 没有 scale，要把累计缩放折进 geom 的 pos/size）。
    collision_boxes={}
    for o in objects:
        pos,quat,scale=o.matrix_local.decompose(); resources=[]
        converted_from=None; empty_geometry=False
        if o.type in VISUAL_TYPES:
            # GLB 里的节点名用稳定身份名（MESH = 网格数据块名）：共享资源的字节不随"哪个实例先导出"漂移。
            export_name=o.data.name if (o.type=='MESH' and o.data is not None) else o.name
            losses=['源工程中的高级节点和修改器保留在 source.blend']
            derived=None; geometry=None
            if o.type=='MESH':
                # glTF 导出器遇到**无效网格**会就地 validate()（它自己那句 "Mesh X is not valid" 警告的来源），
                # 这是改数据块的：共享同一网格的其它实例此后算出的指纹就与先导出的那个不同 —— 同一个资源
                # 在一次导出里拿到两个身份，第二个内容还会去写"同一个版本文件"。指纹前先自己 validate
                # （幂等；有效网格上是空操作），让"指纹看到的网格"就是"导出器写出去的网格"。
                if o.data is not None: o.data.validate(verbose=False, clean_customdata=False)
                geometry=export_geometry_hash(o)
            else:
                # 文字/曲线/曲面/元球不是网格，glTF 取不到几何（此前这些对象整个被丢掉，文字招牌根本不出现）：
                # 在**派生副本**里转 MESH 后导出；原对象与已落盘的 source.blend 保持可编辑。
                converted_from=o.type
                derived=derived_mesh_copy(o); geometry=mesh_hash(derived.data)
                empty_geometry=len(derived.data.polygons)==0
                losses=losses+[f'{converted_from} 对象在派生副本中转为网格导出；source.blend 里仍是可编辑的 {converted_from} 对象']
                if empty_geometry: losses=losses+['派生网格没有面（例如未填充/未倒角的曲线），该 GLB 不含可显示几何']
            # 贴图要靠 UV 才贴得上：引用了贴图却没有 UV 层时，导出物里"贴图引用在、TEXCOORD_0 不在"，
            # 必须在这里如实记一条损失（负对照证明：去掉 UV 层后这条会出现，正例不出现）。
            textured_no_uv=textured_without_uv(derived or o)
            if textured_no_uv: losses=losses+[textured_no_uv]
            try:
                content=visual_content(o,fingerprint_cache,geometry,modifiers=bakes_modifiers(derived or o))
                # 内容没变 → 复用旧版本文件（不导出、不改字节/mtime/版本）；变了 → 写新版本的新文件。
                entry=increment.visual(visual_resource_id(o,ids,namespace),content,losses,
                                       lambda path: export_selection(derived or o,path,export_name))
            finally:
                if derived is not None:
                    derived_data=derived.data; bpy.data.objects.remove(derived)
                    if derived_data.users==0: bpy.data.meshes.remove(derived_data)
            resources=[{'resourceId':entry['resourceId'],'version':entry['version'],
                        'original':{'uri':entry['original'],'mimeType':'application/x-blender'},
                        'representations':[entry['representation']],
                        # 本产品自己的读数（命名空间键，见 SKILL.md）：这份字节对应哪些输入、
                        # 文件在哪、多大。下一轮靠它判断"要不要重导"，最终审阅靠它核对历史未被改写。
                        'blender:content':{'contentHash':content,'sha256':entry['sha256'],'byteSize':entry['byteSize']},
                        'source':{'units':'m','upAxis':'Y','handedness':'right','metersPerUnit':1}}]
        components={}
        if resources: components['visual']={'kind':'mesh','sourceTransformApplied':False,'blenderObject':o.name}
        if converted_from: components['visual']['convertedFrom']=converted_from
        if empty_geometry: components['visual']['geometryEmpty']=True
        if o.get('lyapunov_shape') and o.get('lyapunov_collision',True):
            # 碰撞盒：center 是对象局部帧里的几何中心，sizeM/halfExtents 是同一帧的尺寸。
            # 消费方（sim-mujoco worker）按实体累计缩放还原世界尺寸，所以这里**不**乘任何缩放/TRS。
            box=collision_box(o)
            components['collision']={'type':'box','sizeM':[round(v,6) for v in box['size']],'halfExtents':[round(v/2,6) for v in box['size']],
                                     'center':[round(v,6) for v in box['center']],'source':'blender-primitive','boxSource':box['boxSource'],
                                     'role':o.get('lyapunov_collision_role','solid')}
            if 'declaredSizeM' in box: components['collision']['declaredSizeM']=[round(v,6) for v in box['declaredSizeM']]
            if 'evaluatedModifiers' in box: components['collision']['evaluatedModifiers']=box['evaluatedModifiers']
            # 盒子里没被表示的修改器（带形态键 ⇒ 不烘）：字段与 loss 一起写进组件，消费方不许当精确盒用。
            if 'unbakedModifiers' in box:
                components['collision']['unbakedModifiers']=box['unbakedModifiers']
                components['collision']['losses']=box['losses']
            if o.get('lyapunov_friction'): components['collision']['friction']=list(o['lyapunov_friction'])
            collision_boxes[ids[o.name]]=box
        if o.get('lyapunov_dynamic'): components['rigidBody']={'type':'dynamic','massKg':.15}
        if o.get('lyapunov_joint'): components['articulation']={'joints':[{'name':ids[o.name]+'_hinge','type':'hinge','axis':list(o['lyapunov_axis']),'range':list(o['lyapunov_range'])}]}
        entity={'entityId':ids[o.name],'name':o.name,'transform':{'position':list(pos),'quaternion':[quat.x,quat.y,quat.z,quat.w],'scale':list(scale)},'resources':resources,'components':components}
        if o.parent: entity['parentId']=ids[o.parent.name]
        entities.append(entity)
    # ── 灯与相机：作为**一等 Scene 实体**导出 ──────────────────────────────────
    # 此前只取 ('MESH','EMPTY')，源工程里的灯与相机被整段丢掉：GLB 里没有 KHR_lights_punctual，
    # 工作台只能用它自己硬编码的两盏灯。官方建筑 case 的"打光 + 可开关顶灯"因此不成立。
    # 这里把灯/相机变成带 `light`/`camera` 组件的实体，由 Viewer 端消费；不新建资源类型、
    # 不新建子系统——实体本来就能带任意组件。
    # 与 mesh 共用同一套机器 id：对**全场景**统一编号，保证跨类别不撞名、且改名后仍稳定。
    all_ids=machine_ids(o.name for o in bpy.context.scene.objects)
    for o in bpy.context.scene.objects:
      if o.type not in ('LIGHT','CAMERA'): continue
      pos,quat,scale=o.matrix_local.decompose()
      components={}
      if o.type=='LIGHT':
        # 朝向由对象旋转决定：Sun/Spot 用朝向，Area/Point 用位置（面积/点光源无方向）。
        forward=(o.matrix_world.to_quaternion() @ Vector((0,0,-1))).normalized()
        components['light']={
          'kind':o.data.type.lower(),                      # sun|area|point|spot
          'color':[round(c,6) for c in o.data.color],      # 线性 RGB（Blender 原生即为线性）
          'energy':float(o.data.energy),
          'direction':[round(v,6) for v in forward],
        }
        if o.data.type=='AREA':
          components['light']['sizeM']=float(o.data.size)
          components['light']['shape']=str(o.data.shape).lower()
        if o.data.type=='SUN':
          components['light']['angleRad']=float(o.data.angle)
        if o.data.type=='SPOT':
          components['light']['spotSizeRad']=float(o.data.spot_size)
      else:
        # 相机：只导出**标定需要的**量，不导出朝向之外的东西；不替模型做取景决策。
        look=(o.matrix_world.to_quaternion() @ Vector((0,0,-1))).normalized()
        components['camera']={
          'lensMm':float(o.data.lens),
          'sensorWidthMm':float(o.data.sensor_width),
          'fovYDeg':float(o.data.angle_y*180.0/math.pi),
          'direction':[round(v,6) for v in look],
          'isActive':o is bpy.context.scene.camera,
        }
      entity={'entityId':all_ids[o.name],'name':o.name,
              'transform':{'position':list(pos),'quaternion':[quat.x,quat.y,quat.z,quat.w],'scale':list(scale)},
              'resources':[],'components':components}
      if o.parent: entity['parentId']=ids[o.parent.name]
      entities.append(entity)

    from xml.etree.ElementTree import Element,SubElement,tostring
    # 原生机构独立导出，后代实体继续负责视觉；避免 panel 再被创建为静态碰撞体。
    for entity in entities:
      joints=entity['components'].get('articulation',{}).get('joints',[])
      if not joints: continue
      model=Element('mujoco',model=entity['entityId']);SubElement(model,'compiler',angle='radian');wb=SubElement(model,'worldbody');body=SubElement(wb,'body',name=entity['entityId'])
      actuators=SubElement(model,'actuator')
      for joint in joints:
        SubElement(body,'joint',name=joint['name'],type=joint['type'],axis=' '.join(map(str,joint['axis'])),range=' '.join(map(str,joint['range'])),damping='2')
        SubElement(actuators,'position',name=joint['name']+'_motor',joint=joint['name'],kp='100',kv='15',ctrlrange=' '.join(map(str,joint['range'])))
      for child in entities:
        if child.get('parentId')!=entity['entityId'] or 'collision' not in child['components']: continue
        t=child['transform'];q=t['quaternion']
        # 本体是机构根（MJCF 里没有 scale，本体的缩放折进子体的位置与盒子，见 world.xml 的同一套换算）。
        # 盒子的换算与 world.xml 同一函数：可精确表示的位形逐位相同，剪切位形退化成保守包络（并记 loss）。
        frame=body_frame_box(child['components']['collision'],quaternion_xyzw(q),[float(v) for v in t['scale']],[float(v) for v in entity['transform']['scale']])
        part=SubElement(body,'body',name=child['entityId'],pos=' '.join(fmt([float(t['position'][axis])*float(entity['transform']['scale'][axis]) for axis in range(3)])),quat=' '.join(map(str,[q[3],*q[:3]])))
        SubElement(part,'geom',type='box',pos=' '.join(fmt(frame['center'])),size=' '.join(fmt(frame['halfExtents'])),mass='8')
        child['components']['blender:physicsOwner']=entity['entityId'];child['components'].pop('collision')
      native=root/'physics'/(entity['entityId']+'.xml')
      physics_id=resource_id(entity['entityId']+'-physics')
      native_data=tostring(model)
      fixed=increment.fixed(native,native_data,physics_id)
      entity['components']['mujoco']={'sourcePath':str(native),'rootBody':entity['entityId']}
      # 原生模型是**固定名**的场景级产物（消费方按 physics/<entityId>.xml 找它）：字节变了才写，
      # 版本取"最近一次内容变化的 revision"，所以没变时版本不前进、变了时旧版本号也不会盖上新字节。
      entity['resources'].append({'resourceId':physics_id,'version':fixed['version'],'original':{'uri':str(root/'source.blend'),'mimeType':'application/x-blender'},'representations':[{'uri':str(native),'mimeType':'application/mjcf+xml','role':'physics'}],'blender:content':{'sha256':fixed['sha256'],'byteSize':fixed['byteSize']},'source':{'units':'m','upAxis':'Z','handedness':'right','metersPerUnit':1}})
    default_scene_id=bpy.context.scene.get('lyapunov_scene_id') or ('solace-house' if bpy.context.scene.get('lyapunov_world_kind')=='architecture' else 'blender-room')
    scene_id=previous.get('sceneId',default_scene_id)
    byid={e['entityId']:e for e in entities}
    # freejoint 必须位于 worldbody 的直属 body，因此动态实体保留其世界 pose 独立实例化。这一步必须在
    # scene.json 落盘**之前**：scene.json 是 Scene 侧出口，提升后两条出口才说的是同一个世界位形。
    dynamic=[e for e in entities if e['components'].get('rigidBody',{}).get('type')=='dynamic']
    for e in dynamic:
      o=physics_objects.get(e['entityId'])
      if o is None: continue
      p,q,s=o.matrix_world.decompose(); e.pop('parentId',None)
      e['transform']['position']=list(p); e['transform']['quaternion']=[q.x,q.y,q.z,q.w]
      # 位置/朝向之外，**父链缩放也要一起提升**：只提升前两者的话，下面按"剩下的局部 scale"折算累计缩放，
      # 父层缩放就丢了——动态子体的碰撞盒尺寸（scene.json 与 world.xml 两条出口）会跟着错，GLB/Scene 里
      # 实体本身也不再是提升后的世界尺度。
      e['transform']['scale']=list(s)
    # ── 碰撞盒的帧换算与近似度读数 ─────────────────────────────────────────────
    # 每个带碰撞的实体在**消费方约定**下的世界位姿 + 本 body 帧的盒（见 body_frame_box）；偏差按 Blender
    # 现场真值（matrix_world）量，两条出口各按自己的约定合成后逐角点比，写进产品回执（实体组件 + result）。
    poses={}
    for e in entities: composed_pose(byid,e['entityId'],poses)
    frames={}; approximations=[]
    for eid in list(collision_boxes):
      e=byid.get(eid)
      if e is None: continue
      box=collision_boxes[eid]; t=e['transform']
      parent_scale=poses[e['parentId']][2] if e.get('parentId') in byid else [1.0,1.0,1.0]
      frame=body_frame_box(box,quaternion_xyzw(t['quaternion']),[float(v) for v in t['scale']],parent_scale)
      frames[eid]=frame
      original=physics_objects.get(eid)
      if box['boxSource']!='geometry-local-bounds' or original is None: continue
      half=[float(v)/2.0 for v in box['size']]
      truth=[original.matrix_world @ point for point in box_offsets(box['center'],half)]
      position,quaternion,scale=poses[eid]
      # world.xml/原生模型出口：body 帧的盒按 body 世界位姿合成（MJCF 没有 scale，缩放已经折进盒里）。
      engine=[position+quaternion @ point for point in box_offsets(frame['center'],frame['halfExtents'])]
      # scene.json 出口：盒是数据空间的量，消费方（worker）另外乘累计缩放。
      contract=[position+quaternion @ Vector(scaled_vector(point,scale)) for point in box_offsets(box['center'],half)]
      engine_error=hausdorff(truth,engine); contract_error=hausdorff(truth,contract)
      frame['engineDeviationM']=engine_error; frame['sceneDeviationM']=contract_error
      if max(engine_error,contract_error)<=1e-5: continue
      # 表示不了就必须说：这类盒子在产品结果里**不是**精确碰撞盒，偏差、来源与后续接口一起写进回执。
      losses=[{'code':'COLLISION_BOX_APPROXIMATE_FRAME',
               'detail':('实体链上的非等比缩放与自身旋转叠加：真实碰撞体是斜平行六面体，MJCF 的轴对齐 box 表达不了，'
                         'world.xml/原生模型出口改用该体积在 body 帧里的真实 AABB（保守包络，保证不比真实体积小）；'
                         'scene.json 出口按盒合同（消费方每帧逐分量乘缩放）给出最佳尺寸。两条出口与 Blender 真值的最大角点偏差见读数。')
                        if not frame['exact'] else
                        ('实体在非等比缩放的父链下换轴旋转：world.xml/原生模型出口按 body 帧精确换算（剩余偏差是 6 位小数舍入），'
                         '但 scene.json 的盒合同（消费方每帧逐分量乘缩放）表达不了这次换轴，该出口的偏差见读数。'),
               'engineDeviationM':round(engine_error,6),'sceneDeviationM':round(contract_error,6),
               'followUp':'要两条出口都精确：Scene 侧需支持 body 帧盒（或带朝向四元数的盒），或该实体改走 asset-bake 的网格/多盒派生；本任务范围内不改消费方，见 NEEDS_ROOT.md'}]
      # 追加而不是覆盖：同一个实体可能既有"盒合同表达不了"的 loss，也有"修改器没烘进几何"的 loss。
      if 'collision' in e['components']: e['components']['collision'].setdefault('losses',[]).extend(losses)
      approximations.append({'entityId':eid,'name':e.get('name'),'exact':frame['exact'],
                             'engineDeviationM':round(engine_error,6),'sceneDeviationM':round(contract_error,6)})
    if approximations:
      print('LYAPUNOV_COLLISION_APPROXIMATION='+json.dumps(approximations,ensure_ascii=False))
    # 带形态键的对象修改器不烘（导出器保变形目标）：盒与可视 GLB 同源，但"少了修改器效果"不能只在实体组件里说，
    # 跑完导出的人得在结果行一眼看到——需要那些效果的消费方据此决定先改源件还是按 loss 处理。
    unbaked=[{'entityId':eid,'name':byid[eid].get('name'),'unbakedModifiers':collision_boxes[eid]['unbakedModifiers']}
             for eid in collision_boxes if 'unbakedModifiers' in collision_boxes[eid]]
    if unbaked:
      print('LYAPUNOV_COLLISION_UNBAKED='+json.dumps(unbaked,ensure_ascii=False))
    # 每个 Blender 几何保持独立。门只用原生 hinge，动态方块使用 freejoint。
    mj=Element('mujoco',model='blender_world'); SubElement(mj,'compiler',angle='radian'); SubElement(mj,'option',timestep='.002')
    world=SubElement(mj,'worldbody')
    # 层级缩放：MJCF 的 body 没有 scale，父级缩放只能折进子体位置与子体的碰撞盒（见 body_frame_box）。
    accumulated={}
    def accumulated_scale(eid):
      if eid in accumulated: return accumulated[eid]
      e=byid[eid]; scale=[float(v) for v in e['transform']['scale']]
      # 父对象不是实体（例如 ARMATURE）时停止上溯：这种 body 在 world.xml 里本来就是无父的孤立实例，
      # 不能因为查不到父缩放就把导出打断。
      if e.get('parentId') in byid: scale=scaled_vector(scale,accumulated_scale(e['parentId']))
      accumulated[eid]=scale; return scale
    def add_body(e,parent):
      t=e['transform']; q=t['quaternion']; c=e['components']
      position=list(t['position'])
      if e.get('parentId') in byid: position=scaled_vector(position,accumulated_scale(e['parentId']))
      body=SubElement(parent,'body',name=e['entityId'],pos=' '.join(fmt(position)),quat=' '.join(map(str,[q[3],*q[:3]])))
      if c.get('rigidBody',{}).get('type')=='dynamic': SubElement(body,'freejoint',name=e['entityId']+'_free')
      for j in c.get('articulation',{}).get('joints',[]): SubElement(body,'joint',name=j['name'],type='hinge',axis=' '.join(map(str,j['axis'])),range=' '.join(map(str,j['range'])),damping='2')
      # 物理只对 mesh/empty 有意义：灯与相机没有碰撞/刚体，于是**不加 geom**（保留空 body，不伪造几何）。
      original=physics_objects.get(e['entityId'])
      if original is not None and original.get('lyapunov_shape') and original.get('lyapunov_collision',True):
        frame=frames.get(e['entityId'])
        if frame is None:
          # 预读数缺失时的兜底（正常路径走不到）：仍按同一函数算，父链缩放从同一处累计。
          box=collision_box(original)
          parent_scale=accumulated_scale(e['parentId']) if e.get('parentId') in byid else [1.0,1.0,1.0]
          frame=body_frame_box(box,quaternion_xyzw(q),[float(v) for v in t['scale']],parent_scale)
        # geom 的 pos/size 都在本 body 帧里：世界位姿（含缩放）已经折进 body 链与盒子的换算，
        # 这里写的半长保证为正（镜像的负号由位姿承担，见 body_frame_box）。
        attrs={'type':'box','pos':' '.join(fmt(frame['center'])),'size':' '.join(fmt(frame['halfExtents'])),'rgba':'0.5 0.55 0.6 1'}
        if original.get('lyapunov_friction'): attrs['friction']=' '.join(str(v) for v in original['lyapunov_friction'])
        if 'rigidBody' in c: attrs['mass']=str(c['rigidBody']['massKg'])
        SubElement(body,'geom',attrs)
      for child in entities:
        if child.get('parentId')==e['entityId']: add_body(child,body)
    for e in entities:
      if not e.get('parentId'): add_body(e,world)
    SubElement(mj,'actuator')
    # world.xml / 场景级 MJCF 也是固定名产物：内容没变就不刷新（只移相机/只改一个实例位移时它根本不变）。
    increment.fixed(root/'physics'/'world.xml',tostring(mj),resource_id('world-physics'))
    result={'source':str(root/'source.blend'),'scene':str(root/'scene.json'),'entities':len(entities),'visuals':sum(any(rp['mimeType']=='model/gltf-binary' for r in e['resources'] for rp in r['representations']) for e in entities),'physics':str(root/'physics'/'world.xml'),'resourceNamespace':namespace,'collisionApproximations':approximations,'collisionUnbakedModifiers':unbaked}
    # Blender's native USD exporter is the Isaac visual/source representation.
    # Collision stays per-entity in scene.json and world.xml so the building
    # is never replaced by one closed convex hull.
    if bpy.context.scene.get('lyapunov_world_kind')=='architecture':
      isaac=root/'isaac'; isaac.mkdir(exist_ok=True)
      usd=isaac/'architecture.usda'; usd_status='blocked'; usd_error=None
      # 先导到同目录的临时名再按字节比对：内容一样就不替换正式文件（USD 导出很贵，未变时不该动它）。
      staged=isaac/'architecture.usda.next'
      try:
        bpy.ops.wm.usd_export(filepath=str(staged),selected_objects_only=False,export_animation=False,export_materials=True,export_lights=True,export_cameras=True,export_custom_properties=True,convert_scene_units='METERS',meters_per_unit=1.0,root_prim_path='/World')
        usd_status='generated' if staged.is_file() and staged.stat().st_size else 'blocked'
      except Exception as error:
        usd_error=str(error)
      # center 与 halfExtents 同帧（实体局部帧，未乘缩放）：position/quaternion/scale 一起给出世界位形，
      # 每条碰撞体都能独立还原，不必回到 scene.json 反查。
      collision_manifest=[{'entityId':e['entityId'],'parentId':e.get('parentId'),'role':e['components']['collision'].get('role','solid'),'shape':'box',
                           'center':e['components']['collision'].get('center',[0,0,0]),'halfExtents':e['components']['collision']['halfExtents'],
                           'position':e['transform']['position'],'quaternion':e['transform']['quaternion'],'scale':e['transform']['scale'],
                           # 盒合同表达不了剪切位形时这里带着结构化 loss（空列表=该盒与几何一致），
                           # 下游不许把带 loss 的盒子当精确碰撞体用。
                           'losses':e['components']['collision'].get('losses',[])} for e in entities if 'collision' in e['components']]
      manifest={'format':'usd','sourcePath':str(usd),'units':'m','upAxis':'Z','handedness':'right','collisionSource':'scene.json components.collision','collisionEntities':collision_manifest,'mujocoWorld':str(root/'physics'/'world.xml'),'status':usd_status}
      if usd_error: manifest['error']=usd_error
      manifestPath=isaac/'import.json'
      if usd_status=='generated':
        usd_data=staged.read_bytes()
        # USD 是场景级表示（整场变了它就变），但仍按字节决定写不写：临时名先导出，内容一样就删掉、不碰正式文件。
        usd_fixed=increment.fixed(usd,usd_data,resource_id(scene_id+'-usd'),on_write=lambda: os.replace(staged,usd))
      else:
        usd_fixed=None
        if staged.is_file(): staged.unlink()   # 导出失败/空文件：不留半成品
      manifest_fixed=increment.fixed(manifestPath,json.dumps(manifest,ensure_ascii=False,indent=2).encode('utf-8'),resource_id(scene_id+'-usd-manifest'))
      if usd_status=='generated':
        # lyapunov_root_entity 的既有语义是“Blender 对象名”（不是 entityId），经机器身份映射后再定位实体。
        root_name=bpy.context.scene.get('lyapunov_root_entity')
        roots=[e for e in entities if not e.get('parentId') and (physics_objects.get(e['entityId']) is not None and physics_objects[e['entityId']].type=='EMPTY')]
        owner=next((e for e in entities if e['entityId']==ids.get(root_name)),None) if root_name else (roots[0] if len(roots)==1 else None)
        if root_name and owner is None:
          raise ValueError('BLENDER_ROOT_ENTITY_MISSING: '+str(root_name))
        if owner is not None:
          usd_resource_id=resource_id(scene_id+'-usd')
          owner['resources'].append({'resourceId':usd_resource_id,'version':usd_fixed['version'],'original':{'uri':str(root/'source.blend'),'mimeType':'application/x-blender'},'representations':[{'uri':str(usd),'mimeType':'model/vnd.usd','role':'scene','losses':['Isaac collision uses scene.json per-entity boxes; Blender materials/shaders may be approximated']},{'uri':str(manifestPath),'mimeType':'application/json','role':'import-config'}],'blender:content':{'sha256':usd_fixed['sha256'],'byteSize':usd_fixed['byteSize'],'manifestSha256':manifest_fixed['sha256'],'manifestByteSize':manifest_fixed['byteSize']},'source':{'units':'m','upAxis':'Z','handedness':'right','metersPerUnit':1}})
          owner['components']['isaac']={'sourcePath':str(usd),'importManifest':str(manifestPath),'collisionSource':'scene.json'}
      result['isaac']={'usd':str(usd),'manifest':str(manifestPath),'status':usd_status,'collisionEntities':len(collision_manifest)}
    # ── scene.json：唯一一次落盘，且只在内容真的不同时写 ─────────────────────────
    # revision 只在内容变化时前进：这保证 (resourceId, version) 一旦写出，字节就不会被同一版本号覆盖。
    content={'sceneId':scene_id,'coordinates':{'units':'m','upAxis':'Z','handedness':'right','quaternion':'xyzw'},'entities':entities}
    previous_content={key:previous.get(key) for key in ('sceneId','coordinates','entities')}
    snapshot={'sceneId':scene_id,'revision':revision,**{key:value for key,value in content.items() if key!='sceneId'}}
    if previous and json.dumps(previous_content,sort_keys=True,ensure_ascii=False)==json.dumps(content,sort_keys=True,ensure_ascii=False):
      increment.report['artifactSkips'].append({'path':str(root/'scene.json'),'byteSize':(root/'scene.json').stat().st_size,'version':previous.get('revision')})
      published_revision=previous.get('revision',revision)   # 没写盘就不消耗号：回执报 scene.json 里真实记的 revision
    else:
      write_text_if_changed(root/'scene.json',json.dumps(snapshot,ensure_ascii=False,indent=2))
      increment.report['artifactWrites'].append({'path':str(root/'scene.json'),'byteSize':(root/'scene.json').stat().st_size,'version':revision,
                                                 'mtime':round((root/'scene.json').stat().st_mtime,3)})
      published_revision=revision
    increment.watch(root/'source.blend')
    result['revision']=published_revision
    result['resourceVersion']=published_revision
    report=increment.finish(revision=published_revision,visualEntities=len(entities),
                            sharedResources={entry['resourceId']:entry['instances'] for entry in increment.report['resources'] if entry['instances']>1},
                            secondsTotal=round(time.time()-started_at,3))
    print('LYAPUNOV_INCREMENTAL='+json.dumps({key:report[key] for key in ('revision','visualExports','visualReused','visualRestored','bytesExported','bytesReused','sourceSaved','sourceSnapshot')},ensure_ascii=False))
    result['incremental']=report
    return result

def check_png(path, camera_name, published=None):
    """缺图不可成功：渲染后必须存在、非空、且真是 PNG。

    Blender 渲染失败时可能不写盘或留下空文件；只看路径存在就回报成功，会让调用方把
    "没有图"当成"看过图"。所以这里读文件头判定，失败直接抛（进程非零退出）。
    `published` 是调用方拿到的正式路径：本轮先写暂存文件，报错要指向正式路径才对得上号。
    """
    reported=published or path
    if not path.is_file(): raise RuntimeError(f'BLENDER_RENDER_MISSING: 机位 {camera_name} 渲染后没有产出文件 {reported}')
    if path.stat().st_size==0: raise RuntimeError(f'BLENDER_RENDER_MISSING: 机位 {camera_name} 的渲染结果是空文件 {reported}')
    with path.open('rb') as handle: header=handle.read(len(PNG_SIGNATURE))
    if header!=PNG_SIGNATURE: raise RuntimeError(f'BLENDER_RENDER_NOT_PNG: {reported} 不是 PNG（渲染格式没有生效）')

def resolve_cameras(names):
    """--cameras 给的机位名必须真实存在且是相机；缺省用场景当前相机。缺一个就失败，不静默换机位。"""
    if not names:
        camera=bpy.context.scene.camera
        if camera is None or camera.type!='CAMERA':
            raise ValueError('BLENDER_CAMERA_MISSING: 场景没有当前相机，请用 --cameras 指定机位名')
        return [camera]
    cameras=[]
    for name in names:
        camera=bpy.context.scene.objects.get(name)
        if camera is None: raise ValueError(f'BLENDER_CAMERA_MISSING: 场景里没有名为 {name} 的对象')
        if camera.type!='CAMERA': raise ValueError(f'BLENDER_CAMERA_NOT_CAMERA: {name} 是 {camera.type} 对象，不是相机')
        cameras.append(camera)
    return cameras

def apply_render_settings(resolution, samples):
    """应用分辨率/采样并把**实际生效**的设置读回来（供结果行；不支持的项目如实标注未应用）。"""
    scene=bpy.context.scene
    if resolution is not None:
        scene.render.resolution_x,scene.render.resolution_y=resolution; scene.render.resolution_percentage=100
    applied={'engine':scene.render.engine,'resolution':[int(scene.render.resolution_x),int(scene.render.resolution_y)],'resolutionPercentage':int(scene.render.resolution_percentage)}
    if samples is not None:
        if scene.render.engine=='CYCLES':
            scene.cycles.samples=samples; applied['samples']=samples; applied['samplesTarget']='cycles.samples'
        elif scene.render.engine.startswith('BLENDER_EEVEE') and hasattr(scene,'eevee') and hasattr(scene.eevee,'taa_render_samples'):
            scene.eevee.taa_render_samples=samples; applied['samples']=samples; applied['samplesTarget']='eevee.taa_render_samples'
        if 'samples' not in applied: applied['samplesNotice']=f'{scene.render.engine} 不支持 --samples，本次未应用'
    return applied

def camera_readout(camera, entity_id, path, active_before):
    """机位元数据：世界位姿 + 光学参数，口径与 scene.json 的 camera 组件一致，供调用方复现同一视角。"""
    position,quaternion,_scale=camera.matrix_world.decompose()
    direction=(camera.matrix_world.to_quaternion() @ Vector((0,0,-1))).normalized()
    return {'name':camera.name,'entityId':entity_id,'path':str(path),
            'position':[round(v,6) for v in position],
            'quaternion':[round(v,6) for v in (quaternion.x,quaternion.y,quaternion.z,quaternion.w)],
            'direction':[round(v,6) for v in direction],
            'lensMm':float(camera.data.lens),'sensorWidthMm':float(camera.data.sensor_width),
            'fovYDeg':float(camera.data.angle_y*180.0/math.pi),
            # 指渲染前场景的激活机位（渲染时会把 scene.camera 临时切到目标机位，不能按当时的值报）。
            'isActive':camera is active_before}

def render_previews(output, cameras=None, resolution=None, samples=None):
    """渲染机位并逐张校验真实 PNG；返回 (每个机位的元数据, 实际生效的渲染设置)。

    路径由这里唯一给出（绝对路径）：指定机位名时落 renders/<entityId>.png（与 scene.json 的机位实体同名），
    不指定时沿用既有的 <output>/preview.png。这里只写渲染产物，不碰 scene.json/GLB/source.blend。

    本轮图先落到本进程独享的暂存目录，**校验通过后才顶替正式路径**：输出目录复用是常态，
    只查正式路径的文件头分不出新旧——这一轮要是没写出图（操作被取消/静默没落盘），旧图就会被
    当成本轮结果报出去。暂存 + 顶替让"上报的图一定是本轮产出的"不依赖"旧文件恰好不在"。
    失败路径不删旧图（用户既有产物不动）；顶替用同目录 os.replace，调用方读不到半张图。
    """
    root=Path(output).resolve(); root.mkdir(parents=True,exist_ok=True)
    scene=bpy.context.scene
    ids=machine_ids(o.name for o in scene.objects)
    targets=resolve_cameras(cameras)
    applied=apply_render_settings(resolution,samples)
    scene.render.image_settings.file_format='PNG'
    active_before=scene.camera; renders=[]
    staging=Path(tempfile.mkdtemp(prefix='.render-staging-',dir=str(root)))
    try:
        for camera in targets:
            path=(root/'renders'/f'{ids[camera.name]}.png') if cameras else (root/'preview.png')
            path.parent.mkdir(parents=True,exist_ok=True)
            staged=staging/path.name
            scene.camera=camera; scene.render.filepath=str(staged)
            # 操作状态要真读：非 FINISHED 表示这一轮没渲染成，任何已有文件都不是本轮结果。
            status=bpy.ops.render.render(write_still=True)
            if 'FINISHED' not in status: raise RuntimeError(f'BLENDER_RENDER_NOT_FINISHED: 机位 {camera.name} 渲染返回 {sorted(status)}，没有产出本轮图')
            check_png(staged,camera.name,path)
            os.replace(staged,path)
            renders.append(camera_readout(camera,ids[camera.name],path,active_before))
    finally:
        scene.camera=active_before
        shutil.rmtree(staging,ignore_errors=True)
    return renders,applied


def parse_json_argument(raw, flag):
    """解析 JSON 形参；写错的参数必须在动场景之前报错，不能当成"没给"。"""
    if raw is None: return None
    try: return json.loads(raw)
    except Exception as error: raise ValueError(f'{flag} 不是合法 JSON：{error}')

def parse_cameras(raw):
    """--cameras：机位名 JSON 数组。空数组、重复名、非字符串都当场拒绝。"""
    names=parse_json_argument(raw,'--cameras')
    if names is None: return []
    if not isinstance(names,list) or not names: raise ValueError(f'--cameras 需要非空 JSON 数组（机位名），收到 {names!r}')
    for name in names:
        if not isinstance(name,str) or not name.strip(): raise ValueError(f'--cameras 的每一项都必须是非空字符串，收到 {name!r}')
    duplicated=sorted({name for name in names if names.count(name)>1})
    if duplicated: raise ValueError('--cameras 有重复机位名：'+','.join(duplicated))
    return names

def parse_resolution(raw):
    """--resolution：JSON [宽,高]，两项都是正整数。"""
    value=parse_json_argument(raw,'--resolution')
    if value is None: return None
    if not isinstance(value,list) or len(value)!=2 or not all(isinstance(item,int) and not isinstance(item,bool) and item>0 for item in value):
        raise ValueError(f'--resolution 需要 JSON 数组 [宽,高]，两项都是正整数，收到 {value!r}')
    return list(value)

def parse_samples(raw):
    if raw is None: return None
    if raw<=0: raise ValueError(f'--samples 需要正整数，收到 {raw}')
    return raw


def main(argv):
    import argparse
    parser=argparse.ArgumentParser(description='在真实 Blender 内建造/预览/导出世界')
    parser.add_argument('--output',required=True)
    parser.add_argument('--fixture',action='store_true')
    parser.add_argument('--architecture',action='store_true')
    parser.add_argument('--render',action='store_true')
    parser.add_argument('--operation',default='build',choices=('build','preview','export'),help='build=构造+导出（缺省，可选渲染）；preview=只渲染（不导出、不递增资源版本）；export=只导出（不隐式渲染）')
    parser.add_argument('--cameras',help='机位名 JSON 数组，例如 ["exterior_camera","courtyard_camera"]；不给则用场景当前相机')
    parser.add_argument('--resolution',help='渲染分辨率 JSON 数组 [宽,高]')
    parser.add_argument('--samples',type=int,help='渲染采样数（正整数）')
    parser.add_argument('--material-colors',help='显式材质名→RGBA JSON；写入真实Principled Base Color，不只设置viewport diffuse_color')
    args=parser.parse_args(argv)
    cameras=parse_cameras(args.cameras); resolution=parse_resolution(args.resolution); samples=parse_samples(args.samples)
    if args.architecture: build_architecture_fixture()
    elif args.fixture: build_fixture()
    # 贴图节点必须在**导出之前**接好：GLB 才会把这个材质连同贴图一起带出去；预览也要接线，否则预览看不到真实材质。
    applied_colors=apply_material_colors(args.material_colors)
    wired=wire_material_textures(args.output)
    # preview **不调用 export_world**：不写 scene.json/GLB/source.blend，因此不递增资源版本（局部预览不全量导出）。
    result={'operation':args.operation,'outputDirectory':str(Path(args.output).resolve())}
    if applied_colors: result['materialColors']=applied_colors
    if args.operation=='preview':
        result['exported']=False
    else:
        result.update(export_world(args.output)); result['exported']=True
    if wired: result['materialTextures']=wired
    if args.render or args.operation=='preview':
        # 渲染产物路径**由这里唯一给出**（绝对路径）：调用方（blender_run）据此把图带进模型上下文，
        # 不需要在插件里猜目录结构；缺图会直接失败，不会返回空路径当成功。
        renders,applied=render_previews(args.output,cameras,resolution,samples)
        result['preview']=renders[0]['path']; result['extraRenders']=[item['path'] for item in renders[1:]]
        result['cameras']=renders
        applied['mode']='multi-camera' if cameras else 'single-frame'
        result['render']=applied
        result['renderMode']=applied['mode']
    print('LYAPUNOV_RESULT='+json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    # Blender 默认把 `--python` 脚本里的异常吞成 exit 0（plugin.ts 的 argv 里没有 --python-exit-code）：
    # 只打 traceback 会让"没渲染出图""机位不存在"这类真实失败在调用方看起来像正常结束。
    # 这里显式以非零码退出：结果行不打印，调用方（plugin.ts）按退出码与 stderr 判失败。
    try:
        main(sys.argv[sys.argv.index('--')+1:])
    except Exception as error:
        traceback.print_exc()
        print(f'BLENDER_OPERATION_FAILED: {type(error).__name__}: {error}',file=sys.stderr)
        sys.exit(1)
