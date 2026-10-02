"""增量导出支撑（111）：内容指纹、版本化文件、"变了才写"的落盘口径。

不建第二资产数据库：一个资源的某个版本就是磁盘上真实存在的那一个文件
（可视资源 = `visuals/<resourceId>-v<版本>.glb`），"这次要不要重导"只用上一份 scene.json 里的读数
（representation 的 `blender:content`）加上重算的文件哈希判断，没有索引、没有场景状态。

版本号口径 = **引入该内容的 scene.json revision**。revision 只在场景内容真的变化时前进，所以
(resourceId, version) 一旦写出，字节就不会被覆盖：同内容复用旧文件，新内容用新 revision 当版本号写新文件。

指纹口径（L402）：**会随界面语言本地化的名字不进哈希**（UV 层名 `UVMap`/`UV贴图`、着色器节点名
`Principled BSDF`/`原理化 BSDF`…），身份改由**位置 + 结构**承担（属性 index/domain/data_type、节点顺序
index/node.type、插槽 `socket.identifier`）。同一条判据：**导出器写进字节的东西才算内容** —— 名字若真
进 GLB（材质名、形态键名进 `extras.targetNames`）就保留在判据里，否则剔除（UV 层名不进 GLB）。

`source.blend` 是活的编辑工程（场景变了才保存），每个资源版本另配一份冻结快照
（`sources/<ns>-r<rev>.blend`）当 `original`——"改了源件"与"这个版本当时是什么"因此不互相污染（61 的教训）。
"""
import hashlib, json, re, time
from array import array
from pathlib import Path

CHUNK = 1 << 20

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()

def facts(path):
    """文件现状（不存在返回 None）：size + mtime + sha256。回执与复用校验共用同一份读数。"""
    path = Path(path)
    if not path.is_file(): return None
    stat = path.stat()
    return {'size': stat.st_size, 'mtime': round(stat.st_mtime, 3), 'sha256': sha256_file(path)}

def write_bytes_if_changed(path, data, on_write=None):
    """只在字节真的不同时落盘：未变的产物不刷新 mtime（增量导出要能证明"没动"）。"""
    path = Path(path)
    if path.is_file() and path.read_bytes() == data: return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if on_write is None: path.write_bytes(data)
    else: on_write()
    return True

def write_text_if_changed(path, text):
    return write_bytes_if_changed(path, text.encode('utf-8'))

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str)

def digest(*parts):
    return hashlib.sha256(canonical(list(parts)).encode('utf-8')).hexdigest()


# ── 指纹：只覆盖导出器真正读到的输入 ────────────────────────────────────────────
def plain(value):
    """IDProperty/向量/颜色 → 可哈希的普通 Python 值。"""
    if value is None or isinstance(value, (bool, int, float, str)): return value
    for converter in ('to_list', 'to_dict'):
        method = getattr(value, converter, None)
        if method is None: continue
        try: return plain(method())
        except Exception: break
    if isinstance(value, (list, tuple)): return [plain(item) for item in value]
    if isinstance(value, dict): return {str(key): plain(item) for key, item in value.items()}
    try: return [plain(item) for item in value]
    except TypeError: return str(value)

def _take(hasher, label, collection, prop, code, width):
    """把一个 Blender 集合的数组折进指纹；批量接口失败就退回逐项取值（宁可多算不能漏读）。"""
    try:
        size = width * len(collection)
        buffer = array(code, [0]) * size
        if size: collection.foreach_get(prop, buffer)
        payload = buffer.tobytes()
    except Exception:
        payload = repr([plain(getattr(item, prop)) for item in collection]).encode('utf-8')
    hasher.update((label + '\0').encode('utf-8')); hasher.update(payload); hasher.update(b'|')

_ATTRIBUTE = {'FLOAT': ('value', 1), 'INT': ('value', 1), 'BOOLEAN': ('value', 1), 'FLOAT_VECTOR': ('vector', 3),
              'FLOAT2': ('vector', 2), 'FLOAT_COLOR': ('color', 4), 'BYTE_COLOR': ('color', 4)}

def mesh_hash(mesh):
    """评估后网格的数据指纹：顶点/边/环/面 + 全部属性层（UV、顶点色、锐边…）+ 形态键。

    用 foreach_get 读进普通数组，**不保留任何 RNA 包装引用**（见 93：包装在网格释放后不可读）。
    """
    hasher = hashlib.sha256(b'mesh-v2|')
    _take(hasher, 'vertices', mesh.vertices, 'co', 'f', 3)
    _take(hasher, 'edges', mesh.edges, 'vertices', 'i', 2)
    _take(hasher, 'loops', mesh.loops, 'vertex_index', 'i', 1)
    _take(hasher, 'loop_start', mesh.polygons, 'loop_start', 'i', 1)
    _take(hasher, 'loop_total', mesh.polygons, 'loop_total', 'i', 1)
    _take(hasher, 'material_index', mesh.polygons, 'material_index', 'i', 1)
    _take(hasher, 'use_smooth', mesh.polygons, 'use_smooth', 'b', 1)
    for index, attribute in enumerate(mesh.attributes):
        # 属性名**不进哈希**：UV 层名随界面语言本地化（真机 5.2.2：en_US `UVMap` / zh_HANS `UV贴图`），
        # 而它不是导出内容（glTF 一律按顺序写成 `TEXCOORD_0`…，层名不出现，L402 探针实测）。
        # 身份由**位置 + 结构**承担：同语言两次运行顺序逐位相同，增删/换序数据层仍然会改哈希。
        hasher.update(('attr:%d:%s:%s\0' % (index, attribute.domain, attribute.data_type)).encode('utf-8'))
        shape = _ATTRIBUTE.get(attribute.data_type)
        if shape is None: hasher.update(repr(len(attribute.data)).encode('utf-8'))
        else: _take(hasher, 'data', attribute.data, shape[0], 'f' if shape[1] > 1 else 'f', shape[1])
    if mesh.shape_keys is not None:
        for index, block in enumerate(mesh.shape_keys.key_blocks):
            # 形态键有**两个**身份，都留：位置（决定 glTF `targets[]` 的顺序）与名字 —— 名字真的是导出
            # 内容（L402 探针实测：glTF 把它写进 `meshes[].extras.targetNames`，改名会改 GLB 字节）。
            # `ShapeKey` 没有 `identifier`（真机实测 `hasattr(block,'identifier') is False`），而默认名
            # 两种界面下相同（普查：都是 `Key`）⇒ 名字不是本地化对象，按 index + name 一起参与。
            hasher.update(('key:%d:%s:%s:%s\0' % (index, block.name, block.mute, round(block.value, 6))).encode('utf-8'))
            _take(hasher, 'key_co', block.data, 'co', 'f', 3)
    hasher.update(canonical([material.name if material else None for material in mesh.materials]).encode('utf-8'))
    return hasher.hexdigest()

def curve_digest(data):
    """曲线/曲面/文字的**形状**读数（splines 是集合，属性扫描覆盖不到）。

    类型由调用方给（`bl_rna.identifier`）：文字数据块是 TextCurve，它没有 `.type` 属性。
    """
    hasher = hashlib.sha256(b'curve-v1|')
    for spline in data.splines:
        hasher.update(('%s:%s:%s|' % (spline.type, len(spline.points), len(spline.bezier_points))).encode('utf-8'))
        source = spline.bezier_points if spline.type == 'BEZIER' else spline.points
        for point in source:
            hasher.update(repr(plain(point.co)).encode('utf-8'))
            for name in ('handle_left', 'handle_right', 'handle_left_type', 'handle_right_type', 'radius', 'tilt', 'use_smooth'):
                if hasattr(point, name): hasher.update(repr(plain(getattr(point, name))).encode('utf-8'))
    return hasher.hexdigest()

def image_hash(image, cache):
    """贴图内容的真指纹：优先磁盘字节（真实外部贴图改了字节就要重导），打包/生成图各取本来的来源。"""
    if image is None: return None
    key = ('image', image.name)
    if key in cache: return cache[key]
    hasher = hashlib.sha256(('image-v1|%s|%s|%s|%s|%s|' % (image.name, image.source, image.file_format,
                                                          image.colorspace_settings.name, image.alpha_mode)).encode('utf-8'))
    location = None
    try:
        if image.packed_file is not None:
            hasher.update(b'packed:' + bytes(image.packed_file.data)); location = 'packed'
        elif image.source == 'FILE' and image.filepath:
            import bpy
            resolved = Path(bpy.path.abspath(image.filepath))
            location = str(resolved)
            hasher.update((b'file:' + sha256_file(resolved).encode('ascii')) if resolved.is_file()
                          else (b'missing:' + str(resolved).encode('utf-8')))
        else:
            hasher.update(('generated:%s:%s:%s' % (image.source, tuple(image.size), tuple(round(v, 6) for v in image.generated_color))).encode('utf-8'))
            location = 'generated'
    except Exception as error:
        hasher.update(('unreadable:' + str(error)).encode('utf-8'))
    cache[key] = {'hash': hasher.hexdigest(), 'location': location}
    return cache[key]

def object_target_hash(target, cache, depth=0):
    """修改器/节点引用的**别的对象**：它的几何或位姿变了，本对象的派生结果就变了。"""
    if target is None: return None
    key = ('object', target.name, depth)
    if key in cache: return cache[key]
    import bpy
    cache[key] = 'pending'  # 先占位：互相引用的环只跟到深度 0 的一层
    result = digest('object', target.name, [[round(value, 6) for value in row] for row in target.matrix_world])
    if depth == 0 and target.type == 'MESH' and target.data is not None:
        evaluated = target.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        try: result = digest(result, mesh_hash(mesh))
        finally: evaluated.to_mesh_clear()
    cache[key] = result; return result

def rna_facts(item, cache, skip=frozenset()):
    """按 RNA 声明扫一遍可写标量/引用属性：字段增删自动进指纹，不靠手写字段清单。"""
    import bpy
    values = {}
    for prop in item.bl_rna.properties:
        if prop.is_readonly or prop.identifier in skip: continue
        try: value = getattr(item, prop.identifier)
        except Exception: values[prop.identifier] = '!unreadable'; continue
        if getattr(prop, 'is_array', False) or prop.type in ('FLOAT', 'INT', 'BOOLEAN', 'STRING', 'ENUM'):
            values[prop.identifier] = plain(value)
        elif prop.type == 'POINTER':
            if isinstance(value, bpy.types.Image): values[prop.identifier] = (image_hash(value, cache) or {}).get('hash')
            elif isinstance(value, bpy.types.Object): values[prop.identifier] = object_target_hash(value, cache)
            elif value is None: values[prop.identifier] = None
    return values

# 节点 `rna_facts` 里**不进哈希**的字段。L402 普查（真机 5.2.2，中/英两界面把每个节点的全部可写标量
# 逐字段转储后对比）的结论：节点上**只有 `name` 会本地化**（'Principled BSDF'/'原理化 BSDF'、
# 'Mix (Legacy)'/'混合 (旧版)'…），`label` 是人写的（空或用户文本），其余（`bl_label`/`bl_description`/
# `bl_icon`/`bl_width_*`/`location*`…）两种语言逐字相同。这里剔除名字与布局/展示元数据：挪一下节点
# 位置、换个显示名都不是内容变化，而改参数/接线/贴图仍然会改哈希。
_NODE_FACTS_SKIP = frozenset({'name', 'label', 'rna_type', 'location', 'width', 'height',
                              'dimensions', 'color', 'select', 'parent', 'type'})


def material_hash(material, cache):
    """材质指纹：材质自身属性 + 节点树（节点/连线/未连线输入值）+ 贴图字节。"""
    if material is None: return None
    key = ('material', material.name)
    if key in cache: return cache[key]
    # 材质名**不进哈希**：`bpy.ops.material.new()` 之类建的材质默认名随界面语言本地化
    # （'Material'/'材质'）。名字仍被两处捕获：`visual_content` 的 `slot.material.name`（glTF 把材质名
    # 写进 JSON，是真字节）与 `blend_state_digest` 的 `(material.name, material_hash)` ⇒ 改名照样改
    # contentHash 与存盘判据，只是"改的判据"落在包住它的那一层。
    hasher = hashlib.sha256(b'material-v2|')
    hasher.update(canonical(rna_facts(material, cache, {'name', 'node_tree', 'rna_type'})).encode('utf-8'))
    if material.use_nodes and material.node_tree is not None:
        tree = material.node_tree
        nodes = list(tree.nodes)
        index_of = {node.name: index for index, node in enumerate(nodes)}
        for index, node in enumerate(nodes):
            # 节点名随界面语言变（'Principled BSDF'/'原理化 BSDF'），而 glTF 的材质是扁平的、根本不写节点名
            # ⇒ 身份用**节点类型 + 位置**：改接线/改参数仍然会改哈希，只有"改个显示名"不再算内容变化。
            hasher.update(('node:%d:%s|' % (index, node.type)).encode('utf-8'))
            hasher.update(canonical(rna_facts(node, cache, _NODE_FACTS_SKIP)).encode('utf-8'))
            for position, socket in enumerate(node.inputs):
                if socket.is_linked: continue
                # 有的插槽（着色器/几何等）没有 default_value：真的没有值时记类型，不做假值。
                value = plain(socket.default_value) if hasattr(socket, 'default_value') else ('no-default:' + socket.type)
                # 插槽按**内部 identifier**（'Base Color'…，语言无关），位置补足 identifier 在同一节点里不唯一的情形。
                hasher.update(('in:%d:%s=%s\0' % (position, socket.identifier, canonical(value))).encode('utf-8'))
        for link in tree.links:
            # 连线按**两侧节点的位置 + 插槽 identifier**：节点名与插槽名都是会本地化的显示名。
            hasher.update(('link:%d.%s>%d.%s\0' % (index_of[link.from_node.name], link.from_socket.identifier,
                                                   index_of[link.to_node.name], link.to_socket.identifier)).encode('utf-8'))
    cache[key] = hasher.hexdigest(); return cache[key]

def iter_action_fcurves(action):
    """动作的全部 fcurve 通道，兼容 Blender 4.x 与 5.x。

    Blender 5.x 移除了 `Action.fcurves`（改为 slotted actions：`action.layers[*].strips[*].channelbags[*].fcurves`），
    旧属性在 5.2.2 上已不存在。这里只做**取通道**这一件事，通道本身（data_path/array_index/keyframe_points/
    modifiers/extrapolation）与指纹语义完全沿用调用方，避免第二套指纹口径。
    """
    legacy = getattr(action, 'fcurves', None)
    if legacy is not None: return list(legacy)
    curves = []
    for layer in getattr(action, 'layers', ()):
        for strip in getattr(layer, 'strips', ()):
            for bag in getattr(strip, 'channelbags', ()):
                curves.extend(bag.fcurves)
    return curves

def animation_hash(obj, cache):
    """动画指纹：GLB 导出的是关键帧（export_animation_mode='ACTIONS'），所以读动作/关键帧/NLA/驱动器。"""
    data = obj.animation_data
    if data is None: return None
    def action_facts(action):
        if action is None: return None
        key = ('action', action.name)
        if key in cache: return cache[key]
        curves = []
        for curve in iter_action_fcurves(action):
            keys = [(round(keyframe.co[0], 6), round(keyframe.co[1], 6), keyframe.interpolation, keyframe.easing,
                     round(keyframe.handle_left[0], 6), round(keyframe.handle_left[1], 6),
                     round(keyframe.handle_right[0], 6), round(keyframe.handle_right[1], 6)) for keyframe in curve.keyframe_points]
            curves.append((curve.data_path, curve.array_index, curve.extrapolation, keys,
                           [(modifier.type, canonical(rna_facts(modifier, cache))) for modifier in curve.modifiers]))
        cache[key] = digest(action.name, [round(value, 6) for value in action.frame_range], curves)
        return cache[key]
    tracks = []
    for track in data.nla_tracks:
        tracks.append((track.name, track.mute, [(strip.name, strip.type, action_facts(strip.action), round(strip.frame_start, 6),
                                                 round(strip.frame_end, 6), round(strip.blend_in, 6), round(strip.blend_out, 6),
                                                 strip.blend_type, strip.extrapolation, round(strip.influence, 6)) for strip in track.strips]))
    drivers = [(driver.data_path, driver.array_index, driver.type, driver.expression,
                sorted(variable.name for variable in driver.driver.variables)) for driver in data.drivers]
    return digest(action_facts(data.action), tracks, drivers)

def extras_hash(obj):
    """GLB 带 export_extras：对象自定义属性是导出内容的一部分。"""
    return digest(sorted((str(key), plain(value)) for key, value in obj.items()))

def modifier_facts(obj, cache):
    """对象修改器栈的读数：它既是**导出输入**（会被烘进 GLB），也是 source.blend 里用户要保住的内容。"""
    return [(modifier.name, modifier.type, canonical(rna_facts(modifier, cache, {'name', 'type', 'rna_type'})))
            for modifier in obj.modifiers]

def visual_content(obj, cache, geometry_hash, modifiers=True):
    """导出一个可视对象真正读到的输入：几何 + 材质与**贴图字节** + extras + 动画 + 修改器 + 导出名。

    `modifiers` 由调用方按"这个对象的修改器会不会被烘进 GLB"给（world.py 的 bakes_modifiers）：
    不会被烘的修改器不是这份字节的输入，算进去就会声明出一个字节与旧版一模一样的"新版本"。
    """
    return digest('visual-v1', obj.type, obj.name if geometry_hash is None else geometry_hash,
                  [(slot.material.name if slot.material else None, material_hash(slot.material, cache)) for slot in obj.material_slots],
                  extras_hash(obj), animation_hash(obj, cache),
                  modifier_facts(obj, cache) if modifiers else [])


# ── 一次导出的增量状态 ─────────────────────────────────────────────────────────
class WorldIncrement:
    """上一份 scene.json 的读数 + 本轮真实的写/复用计数 + 冻结快照。

    资源版本 = 引入该内容的 revision（revision 只在 scene.json 内容真的变化时前进）；
    复用判据 = 上一份 scene.json 记下的 (resourceId, contentHash) → 重算该文件 sha256 与记录一致。
    """

    def __init__(self, root, namespace, revision, cache=None):
        self.root = Path(root); self.namespace = namespace; self.revision = int(revision)
        self.cache = cache if cache is not None else {}
        self.known = {}; self.fixed_known = {}; self.made = {}
        self._snapshot = None
        self.report = {'revision': self.revision, 'visualExports': 0, 'visualReused': 0, 'visualRestored': 0,
                       'bytesExported': 0, 'bytesReused': 0, 'exportSeconds': 0.0, 'resources': [],
                       'artifactWrites': [], 'artifactSkips': [], 'sourceSnapshot': None, 'sourceSaved': False}

    def learn(self, previous):
        """读上一份 scene.json：哪些 (resourceId, contentHash) 已有可复用的文件、固定名产物的版本与字节。"""
        for entity in previous.get('entities', []):
            for resource in entity.get('resources', []):
                content = resource.get('blender:content') or {}
                if content.get('contentHash'):
                    self.known[(resource['resourceId'], content['contentHash'])] = {
                        'version': int(resource.get('version', 0)), 'original': (resource.get('original') or {}).get('uri'),
                        'representation': resource['representations'][0], 'sha256': content.get('sha256'), 'byteSize': content.get('byteSize')}
                if content.get('sha256'): self.fixed_known[resource['resourceId']] = (int(resource.get('version', 0)), content['sha256'])
        return self

    def visual_path(self, resource_id, version):
        return self.root/'visuals'/f'{resource_id}-v{version}.glb'

    def next_free_version(self, resource_id):
        """版本号被人为占用时（例如有人回滚了 scene.json）退到磁盘上最大版本 +1：绝不覆盖已有文件。"""
        used = []
        for path in (self.root/'visuals').glob(f'{resource_id}-v*.glb'):
            digits = re.fullmatch(r'%s-v(\d+)\.glb' % re.escape(resource_id), path.name)
            if digits: used.append(int(digits.group(1)))
        return max(used, default=0) + 1

    def visual(self, resource_id, content_hash, losses, export):
        """这个可视内容的 representation + 版本：内容没变就复用旧文件，变了就写新版本文件。

        `export(path)` 是调用方传入的真实导出动作（世界位姿/解父等由它负责），本方法只管版本与字节。
        """
        key = (resource_id, content_hash)
        if key in self.made:
            entry = self.made[key]; entry['instances'] += 1; return entry
        known = self.known.get(key)
        if known is not None:
            path = Path(known['representation']['uri']); current = facts(path)
            if current is not None and current['sha256'] == known['sha256'] and current['size'] == known['byteSize']:
                entry = {'resourceId': resource_id, 'version': known['version'], 'status': 'reused', 'original': known['original'],
                         'representation': {**{k: v for k, v in known['representation'].items() if k != 'losses'}, 'losses': losses},
                         'sha256': current['sha256'], 'byteSize': current['size'], 'instances': 1}
                self.report['visualReused'] += 1; self.report['bytesReused'] += current['size']
                self.made[key] = entry; self.report['resources'].append(entry); return entry
        # 新内容（或原文件已丢失/被改）：用 revision 当版本号写新文件；号被占就退到磁盘最大版本 +1。
        version = self.revision
        path = self.visual_path(resource_id, version)
        if path.exists() and (known is None or Path(known['representation']['uri']) != path): version = self.next_free_version(resource_id)
        path = self.visual_path(resource_id, version)
        started = time.time()
        export(path)
        seconds = time.time() - started
        if not path.is_file() or path.stat().st_size == 0: raise RuntimeError(f'BLENDER_VISUAL_EXPORT_MISSING: {path}')
        size = path.stat().st_size; sha = sha256_file(path)
        status = 'exported' if known is None else 'restored'
        entry = {'resourceId': resource_id, 'version': version, 'status': status, 'original': str(self.snapshot()),
                 'representation': {'uri': str(path), 'mimeType': 'model/gltf-binary', 'role': 'visual', 'losses': losses},
                 'sha256': sha, 'byteSize': size, 'instances': 1, 'seconds': round(seconds, 3)}
        self.report['visualExports'] += 1; self.report['bytesExported'] += size; self.report['exportSeconds'] += seconds
        if status == 'restored': self.report['visualRestored'] += 1
        self.made[key] = entry; self.report['resources'].append(entry); return entry

    def fixed(self, path, data, resource_id, on_write=None):
        """固定名场景产物（world.xml / 原生模型 / USD / 清单）：只在字节真的不同时落盘。

        版本用"最近一次内容变化的 revision"：没变就沿用旧版本号，变了才前进（旧版本号不会盖上新字节）。
        """
        path = Path(path); previous = self.fixed_known.get(resource_id)
        if path.is_file() and path.read_bytes() == data:
            version = previous[0] if previous else self.revision
            self.report['artifactSkips'].append({'path': str(path), 'byteSize': len(data), 'version': version})
        else:
            write_bytes_if_changed(path, data, on_write); version = self.revision
            self.report['artifactWrites'].append({'path': str(path), 'byteSize': len(data), 'version': version,
                                                  'mtime': round(path.stat().st_mtime, 3) if path.is_file() else None})
        return {'version': version, 'sha256': hashlib.sha256(data).hexdigest(), 'byteSize': len(data)}

    def watch(self, path):
        """把一个已经写好的产物登记进回执（附真实字节与 mtime），不改变它。"""
        current = facts(path)
        if current: self.report.setdefault('watched', []).append({'path': str(path), 'byteSize': current['size'], 'mtime': current['mtime']})
        return current

    def snapshot(self):
        """冻结快照：第一次需要时把当前内存中的场景存成 sources/<ns>-r<rev>.blend，此后永不改写。"""
        if self._snapshot is None:
            import bpy
            directory = self.root/'sources'; directory.mkdir(parents=True, exist_ok=True)
            path = directory/f'{self.namespace}-r{self.revision}.blend'
            if not path.is_file(): bpy.ops.wm.save_as_mainfile(filepath=str(path), copy=True, relative_remap=False)
            self._snapshot = path; self.report['sourceSnapshot'] = str(path)
        return self._snapshot

    def finish(self, **extra):
        """回执只带**读数**（每个资源一行小摘要），完整引用信息在 scene.json 里，不在这里重复。"""
        detail = self.report.pop('resources')
        self.report['resources'] = [{key: entry[key] for key in ('resourceId', 'version', 'status', 'instances', 'byteSize')} for entry in detail]
        self.report.update(extra)
        self.report['exportSeconds'] = round(self.report['exportSeconds'], 3)
        self.report['resourceCount'] = len(detail)
        return self.report
