"""几何专用 GLB 读取：只读当前节点的 POSITION/INDEX，不解码全场贴图、动画或 BIN。"""
import json, math, struct

MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_NODE_BYTES = 64 * 1024 * 1024
MAX_READ_BYTES = 8 * 1024 * 1024


def checked_count(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError('INVALID_GLB_GEOMETRY: ' + name)
    return value


class GLBGeometry:
    """静态参考姿态，完整祖先 TRS；单节点硬预算，所有文件读块 ≤8 MiB。"""
    def __init__(self, source, req):
        import numpy as np
        self.source, self.req = source, req
        self.np = np
        self.read_stats = {'readBytes': 0, 'readCalls': 0, 'observedMaxReadBytes': 0}
        with source.open('rb') as stream:
            header = stream.read(12)
            if len(header) != 12: raise ValueError('TRUNCATED_GLB_HEADER')
            magic, version, length = struct.unpack('<4sII', header)
            if magic != b'glTF' or version != 2 or length != source.stat().st_size:
                raise ValueError('INVALID_GLB_HEADER')
            chunk = stream.read(8)
            if len(chunk) != 8: raise ValueError('TRUNCATED_GLB_JSON')
            count, kind = struct.unpack('<I4s', chunk)
            if kind != b'JSON' or count > MAX_MANIFEST_BYTES or count + 20 > length:
                raise ValueError('GLB_JSON_BUDGET_EXCEEDED: JSON 头必须在 8 MiB 内')
            blob = stream.read(count)
            if len(blob) != count: raise ValueError('TRUNCATED_GLB_JSON')
            self.document = json.loads(blob)
            self.bin_offset = self.bin_length = 0
            while stream.tell() < length:
                chunk = stream.read(8)
                if len(chunk) != 8: raise ValueError('TRUNCATED_GLB_CHUNK')
                count, kind = struct.unpack('<I4s', chunk)
                offset = stream.tell()
                if offset + count > length: raise ValueError('TRUNCATED_GLB_CHUNK')
                if kind == b'BIN\0':
                    if self.bin_offset: raise ValueError('INVALID_GLB_MULTIPLE_BIN')
                    self.bin_offset, self.bin_length = offset, count
                stream.seek(count, 1)
        buffers = self.document.get('buffers', [])
        if len(buffers) != 1 or buffers[0].get('uri') or not self.bin_offset:
            raise ValueError('UNSUPPORTED_GLB_BUFFER: 物理交接仅接受 GLB 内嵌单 BIN，未退回全场加载')
        if checked_count(buffers[0].get('byteLength'), 'buffer.byteLength') > self.bin_length:
            raise ValueError('TRUNCATED_GLB_BUFFER')
        axis = req.get('sourceUpAxis', 'Y'); scale = req.get('metersPerUnit', 1.)
        if axis not in ('Y', 'Z'): raise ValueError('INVALID_SOURCE_UP_AXIS')
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale) or scale <= 0:
            raise ValueError('INVALID_METERS_PER_UNIT')
        self.source_frame = {'pose': 'reference', 'sourceUpAxis': axis, 'metersPerUnit': scale,
                             'derivedUnits': 'm', 'derivedUpAxis': 'Z',
                             'animation': {'clips': len(self.document.get('animations', [])), 'evaluated': False, 'skinApplied': False}}
        self.nodes = self._nodes()

    def _nodes(self):
        np = self.np; document = self.document; nodes = document.get('nodes', [])
        if len(nodes) > 100000: raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED')
        scenes = document.get('scenes', [])
        if scenes:
            selected = document.get('scene', 0)
            if not isinstance(selected, int) or selected < 0 or selected >= len(scenes): raise ValueError('INVALID_GLB_SCENE')
            roots = scenes[selected].get('nodes', [])
        else:
            children = {i for node in nodes for i in node.get('children', [])}
            roots = [i for i in range(len(nodes)) if i not in children]
        results = []; visited = set(); names = set()
        def walk(index, parent, ancestry):
            if not isinstance(index, int) or index < 0 or index >= len(nodes): raise ValueError('INVALID_GLB_NODE_REFERENCE')
            if index in ancestry or index in visited: raise ValueError('INVALID_GLB_NODE_GRAPH: 循环或多父节点')
            visited.add(index); node = nodes[index]
            if 'matrix' in node:
                matrix = np.asarray(node['matrix'], dtype=np.float64)
                if matrix.size != 16: raise ValueError('INVALID_GLB_NODE_MATRIX')
                matrix = matrix.reshape((4, 4), order='F')
            else:
                translation = np.asarray(node.get('translation', [0, 0, 0]), dtype=np.float64)
                scale = np.asarray(node.get('scale', [1, 1, 1]), dtype=np.float64)
                rotation = np.asarray(node.get('rotation', [0, 0, 0, 1]), dtype=np.float64)
                if translation.shape != (3,) or scale.shape != (3,) or rotation.shape != (4,): raise ValueError('INVALID_GLB_NODE_TRS')
                norm = np.linalg.norm(rotation)
                if not math.isfinite(norm) or norm == 0: raise ValueError('INVALID_GLB_NODE_ROTATION')
                x, y, z, w = rotation / norm
                matrix = np.eye(4)
                matrix[:3, :3] = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                                           [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                                           [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]) * scale
                matrix[:3, 3] = translation
            if not np.isfinite(matrix).all() or not np.allclose(matrix[3], [0, 0, 0, 1]): raise ValueError('INVALID_GLB_NODE_MATRIX')
            world = parent @ matrix
            if 'mesh' in node:
                mesh_index = node['mesh']; meshes = document.get('meshes', [])
                if not isinstance(mesh_index, int) or mesh_index < 0 or mesh_index >= len(meshes): raise ValueError('INVALID_GLB_MESH_REFERENCE')
                if 'skin' in node: raise ValueError('UNSUPPORTED_ANIMATED_COLLISION: 蒙皮变形未参与静态参考姿态物理派生')
                weights = node.get('weights', meshes[mesh_index].get('weights', []))
                if any(weights): raise ValueError('UNSUPPORTED_ANIMATED_COLLISION: 非零 morph 参考权重未参与物理派生')
                name = str(node.get('name') or 'node-' + str(index))
                if name in names: name += '#' + str(index)
                names.add(name)
                results.append((name, index, mesh_index, world))
            for child in node.get('children', []): walk(child, world, ancestry | {index})
        for root in roots: walk(root, np.eye(4), set())
        if not results: raise ValueError('EMPTY_GEOMETRY')
        return results

    def _view(self, index):
        views = self.document.get('bufferViews', [])
        if not isinstance(index, int) or index < 0 or index >= len(views): raise ValueError('INVALID_GLB_BUFFER_VIEW')
        view = views[index]
        if view.get('buffer', 0) != 0 or 'EXT_meshopt_compression' in view.get('extensions', {}):
            raise ValueError('UNSUPPORTED_COMPRESSED_GEOMETRY: bufferView 未解码；不静默跳过碰撞')
        offset = checked_count(view.get('byteOffset', 0), 'bufferView.byteOffset')
        length = checked_count(view.get('byteLength'), 'bufferView.byteLength')
        if offset + length > self.bin_length: raise ValueError('INVALID_GLB_BUFFER_VIEW_RANGE')
        return view, offset, length

    def _read(self, view_index, byte_offset, count, components, dtype):
        np = self.np; view, offset, length = self._view(view_index)
        item = np.dtype(dtype).itemsize; width = components * item
        stride = checked_count(view.get('byteStride', width), 'byteStride')
        byte_offset = checked_count(byte_offset, 'accessor.byteOffset')
        if stride < width or stride > MAX_READ_BYTES or stride % item or byte_offset % item:
            raise ValueError('INVALID_GLB_ACCESSOR_STRIDE')
        needed = byte_offset + (count-1)*stride + width if count else byte_offset
        if needed > length:
            raise ValueError('INVALID_GLB_ACCESSOR_RANGE')
        if count * width > MAX_NODE_BYTES: raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED: accessor 超过 64 MiB')
        result = np.empty((count, components), dtype=dtype)
        block = max(1, MAX_READ_BYTES // stride)
        with self.source.open('rb') as stream:
            for start in range(0, count, block):
                wanted = min(count-start, block); read_bytes = (wanted-1)*stride + width
                stream.seek(self.bin_offset + offset + byte_offset + start*stride)
                data = stream.read(read_bytes)
                if len(data) != read_bytes: raise ValueError('TRUNCATED_GLB_ACCESSOR')
                self.read_stats['readBytes'] += len(data);self.read_stats['readCalls'] += 1
                self.read_stats['observedMaxReadBytes'] = max(self.read_stats['observedMaxReadBytes'], len(data))
                result[start:start+wanted] = np.ndarray((wanted, components), dtype=dtype, buffer=data, strides=(stride, item))
        return result

    def accessor(self, index, position=False):
        np = self.np; accessors = self.document.get('accessors', [])
        if not isinstance(index, int) or index < 0 or index >= len(accessors): raise ValueError('INVALID_GLB_ACCESSOR')
        accessor = accessors[index]; count = checked_count(accessor.get('count'), 'accessor.count')
        component = accessor.get('componentType'); components = 3 if position else 1
        dtype = {5121: '<u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}.get(component)
        if accessor.get('type') != ('VEC3' if position else 'SCALAR') or accessor.get('normalized') or not dtype or (position and component != 5126) or (not position and component == 5126):
            raise ValueError('UNSUPPORTED_GLB_ACCESSOR_TYPE: POSITION 必须是 f32 VEC3，INDEX 必须是无符号 SCALAR')
        if 'bufferView' in accessor: values = self._read(accessor['bufferView'], accessor.get('byteOffset', 0), count, components, dtype)
        else:
            if count * components * np.dtype(dtype).itemsize > MAX_NODE_BYTES: raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED')
            values = np.zeros((count, components), dtype=dtype)
        if 'sparse' in accessor:
            sparse = accessor['sparse']; sparse_count = checked_count(sparse.get('count'), 'sparse.count')
            if sparse_count > count: raise ValueError('INVALID_GLB_SPARSE_COUNT')
            indices = sparse['indices']; sdtype = {5121: '<u1', 5123: '<u2', 5125: '<u4'}.get(indices.get('componentType'))
            if not sdtype: raise ValueError('INVALID_GLB_SPARSE_INDEX')
            targets = self._read(indices['bufferView'], indices.get('byteOffset', 0), sparse_count, 1, sdtype).reshape(-1)
            if sparse_count and (targets[-1] >= count or np.any(targets[1:] <= targets[:-1])): raise ValueError('INVALID_GLB_SPARSE_RANGE')
            spec = sparse['values']; values[targets] = self._read(spec['bufferView'], spec.get('byteOffset', 0), sparse_count, components, dtype)
        return values

    def meshes(self):
        import numpy as np, trimesh
        selected = set(self.req.get('sourceNodes', [])) if self.req.get('sourceNodes') else None
        for ordinal, (name, node_index, mesh_index, world) in enumerate(self.nodes):
            if selected is not None and name not in selected: continue
            primitives = self.document['meshes'][mesh_index].get('primitives', [])
            counts = []; vertices_count = faces_count = 0; point_cloud = None
            for primitive in primitives:
                if 'KHR_draco_mesh_compression' in primitive.get('extensions', {}): raise ValueError('UNSUPPORTED_COMPRESSED_GEOMETRY: Draco POSITION/INDEX 未解码')
                pi = primitive.get('attributes', {}).get('POSITION')
                if pi is None: raise ValueError('GLB_POSITION_REQUIRED')
                pc = checked_count(self.document['accessors'][pi].get('count'), 'POSITION.count')
                ic = checked_count(self.document['accessors'][primitive['indices']].get('count'), 'INDEX.count') if 'indices' in primitive else pc
                mode = primitive.get('mode', 4)
                if mode not in (0, 4, 5, 6): raise ValueError('UNSUPPORTED_GLB_PRIMITIVE_MODE: ' + str(mode))
                is_point = mode == 0
                if point_cloud is not None and point_cloud != is_point: raise ValueError('UNSUPPORTED_MIXED_POINT_MESH_NODE')
                point_cloud = is_point
                if mode == 4 and ic % 3: raise ValueError('INVALID_GLB_TRIANGLE_INDEX_COUNT')
                fc = 0 if mode == 0 else ic//3 if mode == 4 else max(0, ic-2)
                counts.append((pc, ic, fc)); vertices_count += pc; faces_count += fc
            if vertices_count * 24 + faces_count * 12 > MAX_NODE_BYTES:
                raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED: ' + name + ' POSITION/INDEX 超过 64 MiB；未粗化、未跳过')
            if not vertices_count: raise ValueError('EMPTY_GEOMETRY: ' + name)
            vertices = np.empty((vertices_count, 3), dtype=np.float64)
            faces = np.empty((faces_count, 3), dtype=np.uint32); vo = fo = 0
            for primitive, (pc, ic, fc) in zip(primitives, counts):
                vertices[vo:vo+pc] = self.accessor(primitive['attributes']['POSITION'], True)
                indices = self.accessor(primitive['indices']).reshape(-1) if 'indices' in primitive else np.arange(pc, dtype=np.uint32)
                if len(indices) and int(indices.max()) >= pc: raise ValueError('INVALID_GLB_INDEX_RANGE: ' + name)
                mode = primitive.get('mode', 4)
                if mode == 4: triangles = indices.reshape((-1, 3))
                elif mode == 5:
                    triangles = np.column_stack((indices[:-2], indices[1:-1], indices[2:])).astype(np.uint32)
                    triangles[1::2, :2] = triangles[1::2, 1::-1]
                elif mode == 6: triangles = np.column_stack((np.full(fc, indices[0], dtype=np.uint32), indices[1:-1], indices[2:]))
                else: triangles = np.empty((0, 3), dtype=np.uint32)
                # 原 accessor 可为 u8/u16；材质 primitive 的全节点偏移必须先提升到 u32。
                faces[fo:fo+fc] = triangles.astype(np.uint32,copy=False) + vo; vo += pc; fo += fc
            if not np.isfinite(vertices).all(): raise ValueError('NONFINITE_GEOMETRY: ' + name)
            metadata = {'sourceNodeIndex': node_index, 'sourceMeshIndex': mesh_index, 'sourceWorldMatrix': world.reshape(-1, order='F').tolist()}
            if point_cloud:
                yield ordinal, name, trimesh.points.PointCloud(trimesh.transform_points(vertices, world)), metadata
            else:
                mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
                mesh.merge_vertices(merge_tex=True, merge_norm=True); mesh.apply_transform(world)
                yield ordinal, name, mesh, metadata
