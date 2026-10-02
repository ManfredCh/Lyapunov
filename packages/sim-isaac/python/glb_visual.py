"""把已登记的 glTF 视觉几何转换到 Provider 私有 USD 缓存，保留 Scene 变换所有权。"""
import copy
import hashlib
import json
import struct
import time
import warnings
from pathlib import Path
from urllib.parse import urlparse, unquote


class VisualError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_document(source):
    data = source.read_bytes()
    if source.suffix.lower() == '.gltf':
        return json.loads(data), None
    if len(data) < 20 or data[:4] != b'glTF':
        raise VisualError('INVALID_GLTF', 'GLB header 无效')
    _, version, length = struct.unpack_from('<III', data)
    if version != 2 or length != len(data):
        raise VisualError('INVALID_GLTF', '只支持完整 glTF 2 GLB')
    offset = 12; document = None; binary = None
    while offset + 8 <= length:
        size, kind = struct.unpack_from('<II', data, offset); offset += 8
        chunk = data[offset:offset + size]; offset += size
        if kind == 0x4e4f534a: document = json.loads(chunk)
        elif kind == 0x004e4942: binary = chunk
    if document is None or offset != length:
        raise VisualError('INVALID_GLTF', 'GLB chunk 无效')
    return document, binary


def dependencies(source, document):
    values = []
    for item in [*document.get('buffers', []), *document.get('images', [])]:
        uri = item.get('uri', '')
        if not uri or uri.startswith('data:'): continue
        parsed = urlparse(uri)
        if parsed.scheme and parsed.scheme != 'file':
            raise VisualError('RESOURCE_NOT_LOCAL', '先将 glTF 依赖导入资源库: ' + parsed.scheme)
        path = Path(unquote(parsed.path)) if parsed.scheme else source.parent / unquote(uri)
        path = path.resolve()
        if not path.is_file(): raise VisualError('RESOURCE_MISSING', str(path))
        values.append(path)
    return values


def node_document(source, document, binary, node_index, folder):
    """Scene 已保存每个节点的 TRS/层级，只切出本节点 mesh，不再烘焙同一变换。"""
    nodes = document.get('nodes', [])
    if not isinstance(node_index, int) or not 0 <= node_index < len(nodes):
        raise VisualError('INVALID_GLTF_NODE', str(node_index))
    node = nodes[node_index]
    if 'skin' in node: raise VisualError('UNSUPPORTED_CAPABILITY', 'glTF skin 需单独动画适配')
    if 'mesh' not in node: return None
    doc = copy.deepcopy(document)
    doc['nodes'] = [{k: node[k] for k in ['name', 'mesh', 'weights'] if k in node}]
    doc['scenes'] = [{'nodes': [0]}]; doc['scene'] = 0
    doc.pop('animations', None); doc.pop('skins', None)
    for item in [*doc.get('buffers', []), *doc.get('images', [])]:
        uri = item.get('uri', '')
        if not uri or uri.startswith('data:'): continue
        parsed = urlparse(uri)
        item['uri'] = str((Path(unquote(parsed.path)) if parsed.scheme else source.parent / unquote(uri)).resolve())
    if source.suffix.lower() == '.gltf':
        output = folder / 'node.gltf'; output.write_text(json.dumps(doc)); return output
    encoded = json.dumps(doc, separators=(',', ':')).encode(); encoded += b' ' * (-len(encoded) % 4)
    chunks = struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
    if binary is not None: chunks += struct.pack('<II', len(binary), 0x004e4942) + binary
    output = folder / 'node.glb'; output.write_bytes(struct.pack('<III', 0x46546c67, 2, 12 + len(chunks)) + chunks)
    return output


def report_import(source, document, node_index):
    """交付视觉 USD 前报告本次保留/丢弃内容；无丢弃项时不发提示（避免误导性告警）。

    丢弃发生在节点分片（animations/skins/其余 nodes）与转换器上下文（ignore_animations）两处，
    都没有调用方可见的返回值差异，故沿用标准 warnings 通道发出同一份 JSON：调用方
    warnings.catch_warnings(record=True) 可读回，worker 的 stderr/日志也直接可见；函数同时返回该报告。

    ISAAC-19 的完成条件是"导入前说明**保留与不支持**的内容"——只报 dropped 时，"glTF 里本来就
    没有的东西"与"有但本通道不支持、只是这次没触发"两种情况在回执上无法区分（例如无动画的 GLB
    被读成"动画没问题"）。所以报告里**另外**给出两条与本次是否触发无关的事实：
      · `retained`：本次真实保留进视觉 USD 的内容清单（不含物理/动画）；
      · `notSupported`：本视觉通道**一律不支持**的内容清单及各自原因（与本次源里有没有无关），
        调用方据此事先判定，而不是先导入再看 dropped 猜。
    两个键都是附加键，`kept`/`dropped` 的既有结构不变（既有消费方按原键读不受影响）。
    """
    nodes = document.get('nodes', []) or []
    if node_index is None:
        kept = {'nodes': len(nodes), 'meshes': len(document.get('meshes', []) or [])}
    else:
        kept = {'nodes': 1, 'mesh': nodes[node_index].get('mesh')}
    dropped = []
    animations = len(document.get('animations', []) or [])
    if animations:
        dropped.append({'kind': 'animations', 'count': animations, 'reason': '视觉 USD 不写动画通道'})
    if node_index is not None:
        skins = len(document.get('skins', []) or [])
        if skins:
            dropped.append({'kind': 'skins', 'count': skins, 'reason': '节点分片移除 skin，蒙皮需单独适配'})
        if len(nodes) > 1:
            dropped.append({'kind': 'nodes', 'count': len(nodes) - 1, 'reason': '节点分片只保留 gltfNode 指定的节点'})
    retained = ['mesh-geometry', 'materials', 'node-hierarchy' if node_index is None else 'single-node-transform-removed']
    not_supported = [
        {'kind': 'animations', 'reason': '本通道只产出静态视觉 USD（asset_converter 的 ignore_animations=True，节点分片也移除 animations）：GLB 动画不会变成动作通道，模型运动请用 articulation/策略'},
        {'kind': 'skins', 'reason': '指定节点带 skin 时直接拒绝（UNSUPPORTED_CAPABILITY: glTF skin 需单独动画适配）；蒙皮不落成 articulation'},
        {'kind': 'physics', 'reason': '本通道只产出视觉几何：不建 collider、不建刚体；需要碰撞/物理请另行声明 components.collision 或写进原生 USD'},
    ]
    report = {'source': str(source), 'nodeIndex': node_index, 'kept': kept, 'dropped': dropped,
              'retained': retained, 'notSupported': not_supported}
    if dropped:
        warnings.warn('[lyapunov] GLB 视觉导入: ' + json.dumps(report, ensure_ascii=False, sort_keys=True))
    return report


def convert_glb(path, cache_root, node_index=None, resource_version=None):
    source = Path(path).resolve()
    if not source.is_file(): raise VisualError('RESOURCE_MISSING', str(source))
    document, binary = read_document(source)
    refs = dependencies(source, document)
    stamps = [(str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in [source, *refs]]
    key = hashlib.sha256(json.dumps([stamps, node_index, resource_version]).encode()).hexdigest()[:24]
    folder = Path(cache_root).resolve() / 'visual-glb' / key; folder.mkdir(parents=True, exist_ok=True)
    output = folder / 'asset.usdc'
    if node_index is not None:
        nodes = document.get('nodes', [])
        if not isinstance(node_index, int) or not 0 <= node_index < len(nodes):
            raise VisualError('INVALID_GLTF_NODE', str(node_index))
        if 'mesh' not in nodes[node_index]: return None
    if output.is_file() and output.stat().st_size:
        report_import(source, document, node_index); return str(output)
    input_path = node_document(source, document, binary, node_index, folder) if node_index is not None else source
    if input_path is None: return None
    report_import(source, document, node_index)  # 转换开始前先报告保留/丢弃内容
    import omni.kit.app
    app = omni.kit.app.get_app()
    if not app.get_extension_manager().set_extension_enabled_immediate('omni.kit.asset_converter', True):
        raise VisualError('PROVIDER_UNAVAILABLE', 'Isaac omni.kit.asset_converter 扩展不可用')
    from omni.kit import asset_converter
    from omni.kit.async_engine import run_coroutine
    context = asset_converter.AssetConverterContext()
    context.use_meter_as_world_unit = True
    context.convert_stage_up_y = True  # 保留glTF坐标；Scene/visual Xform唯一负责转轴与比例。
    context.export_preview_surface = True
    context.ignore_camera = True; context.ignore_light = True; context.ignore_animations = True
    task = asset_converter.get_instance().create_converter_task(str(input_path), str(output), None, context)
    future = run_coroutine(task.wait_until_finished())
    deadline = time.monotonic() + 120
    while not future.done():
        if time.monotonic() >= deadline:
            task.cancel(); future.cancel()
            raise VisualError('PROVIDER_TIMEOUT', 'GLB→USD 转换超时')
        app.update(); time.sleep(.001)
    if not future.result() or not output.is_file() or not output.stat().st_size:
        raise VisualError('PROVIDER_FAILED', task.get_error_message() or 'GLB→USD 没有产物')
    return str(output)
