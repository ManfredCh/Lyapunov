"""Newton 1.6 原生相机：只读取当前模型/状态，不拥有物理时钟。

MJCF 的相机声明由已安装的 MuJoCo XML 编译器读取元数据（没有 MjData、mj_step
或 MuJoCo 求解器）；实际几何、位姿、粒子和像素全部来自 Newton。
"""
import copy
import math
from pathlib import Path
import struct
import uuid
import zlib

import numpy as np


def rotation(quaternion):
    q = np.asarray(quaternion, dtype=float)
    if q.shape != (4,) or not np.isfinite(q).all() or np.linalg.norm(q) < 1e-8:
        raise ValueError('四元数必须是非零有限 xyzw / Quaternion must be finite nonzero xyzw')
    x, y, z, w = q / np.linalg.norm(q)
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


def quaternion(matrix):
    # 使用 Warp 自己的矩阵转四元数，避免重复实现旋转分支。
    import warp as wp
    return [float(v) for v in wp.quat_from_matrix(wp.mat33(np.asarray(matrix, dtype=np.float32)))]


def write_rgb_png(path, rgb):
    """标准 PNG 编码；不为无纹理原生相机引入 Pillow 依赖。"""
    height, width, _ = rgb.shape

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    rows = b''.join(b'\x00' + row.tobytes() for row in rgb)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


class NewtonCamera:
    """由 worker 串行调用，所有输出属于 world 当前 generation/stepIndex。"""

    def __init__(self, world, error_type, native_source, world_poses):
        self.world = world
        self.error_type = error_type
        self.native_source = native_source
        self.world_poses = world_poses
        self.model = None
        self.scene = None
        self.sensor = None
        self.cameras = {}
        self.warnings = []
        self.captures = {}

    def fail(self, code, message):
        raise self.error_type(code, message)

    def close(self):
        self.model = self.scene = self.sensor = None
        self.cameras = {}
        self.captures = {}
        self.warnings = []

    def _resolution(self, options):
        values = []
        for key, default in [('width', 640), ('height', 480)]:
            value = options.get(key, default)
            if isinstance(value, bool) or not isinstance(value, int) or not 16 <= value <= 4096:
                self.fail('INVALID_ARGUMENT', key + ' 必须是 16..4096 的整数 / Resolution must be an integer in 16..4096')
            values.append(value)
        return values

    def _optics(self, pose, fovy_key):
        intrinsics = pose.get('intrinsics')
        if intrinsics is not None:
            if not isinstance(intrinsics, dict):
                raise ValueError('intrinsics 必须是对象 / Intrinsics must be an object')
            result = {}
            for key in ('fx', 'fy', 'cx', 'cy', 'width', 'height'):
                value = intrinsics.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError('intrinsics.' + key + ' 必须有限 / Intrinsics must be finite')
                result[key] = float(value)
            if min(result[k] for k in ('fx', 'fy', 'width', 'height')) <= 0:
                raise ValueError('焦距与参考尺寸必须为正 / Focal lengths and reference resolution must be positive')
            if any(result[k] != int(result[k]) for k in ('width', 'height')):
                raise ValueError('K 的参考尺寸必须是整数 / Calibration resolution must be integer')
            distortion = intrinsics.get('distortion', [])
            if not isinstance(distortion, (list, tuple)) or any(
                    isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v != 0
                    for v in distortion):
                raise ValueError('此切片尚未接通非零镜头畸变 / Nonzero lens distortion is not connected in this slice')
            return {'intrinsics': result, 'intrinsicsSource': 'declared-K'}
        fovy = pose.get(fovy_key)
        if isinstance(fovy, bool) or not isinstance(fovy, (int, float)) or not math.isfinite(fovy) or not 0 < fovy < 180:
            raise ValueError('需要合法 K 或 (0,180) 度竖直视场 / A valid K or vertical FOV in (0,180) is required')
        return {'fovyDeg': float(fovy), 'intrinsicsSource': 'fovy'}

    def _put(self, record, build):
        name = record['cameraName']
        if name in self.cameras:
            self.cameras[name] = {**record, 'available': False,
                                  'reason': '相机名冲突 / Duplicate camera name'}
            return
        try:
            record.update(build())
            record['available'] = True
        except (ValueError, TypeError, ImportError) as exc:
            record = {**record, 'available': False, 'reason': str(exc)}
        self.cameras[name] = record

    def _native_cameras(self, entity, cfg, poses):
        path = cfg.get('sourcePath')
        if path and str(path).lower().endswith('.urdf'):
            return  # URDF 的 Gazebo 传感器扩展不是 Newton MJCF 相机声明。
        try:
            import mujoco as mj
            from xml.etree import ElementTree as ET
            if path:
                from urllib.parse import unquote, urlparse
                parsed = urlparse(str(path))
                source = unquote(parsed.path) if parsed.scheme == 'file' else str(path)
                metadata = mj.MjModel.from_xml_path(source)
                model_name = ET.parse(source).getroot().get('model')
            else:
                metadata = mj.MjModel.from_xml_string(cfg['xml'])
                model_name = ET.fromstring(cfg['xml']).get('model')
        except Exception as exc:
            self.warnings.append({'code': 'NATIVE_CAMERA_METADATA_UNAVAILABLE', 'entityId': entity['entityId'],
                                  'source': path or 'inline-xml',
                                  'message': 'MJCF 相机元数据未读取 / MJCF camera metadata unavailable: ' + str(exc)})
            return
        eid = entity['entityId']
        info = self.world.entities.get(eid, {})
        start = info.get('bodyStart', info.get('rootBody', 0))
        end = info.get('bodyEnd', start + len(info.get('bodyLabels', [])))
        for index in range(metadata.ncam):
            local_name = mj.mj_id2name(metadata, mj.mjtObj.mjOBJ_CAMERA, index)
            if not local_name:
                continue
            record = {'cameraName': eid + '/' + local_name, 'localName': local_name,
                      'entityId': eid, 'cameraSource': 'mjcf', 'cameraComponent': 'mjcf'}

            def build(index=index):
                if int(metadata.cam_mode[index]) != int(mj.mjtCamLight.mjCAMLIGHT_FIXED):
                    raise ValueError('只接通 MJCF fixed 相机；tracking/targetbody 尚未接通 / Only fixed MJCF cameras are connected')
                if hasattr(metadata, 'cam_orthographic') and metadata.cam_orthographic[index]:
                    raise ValueError('正交相机尚未接通 / Orthographic cameras are not connected')
                body_id = int(metadata.cam_bodyid[index])
                position = np.asarray(metadata.cam_pos[index], dtype=float).copy()
                qw, qx, qy, qz = metadata.cam_quat[index]
                matrix = rotation([qx, qy, qz, qw])
                parent = None
                parent_name = 'world'
                if body_id:
                    from newton._src.utils.import_utils import sanitize_name
                    ancestors = []
                    ancestor = body_id
                    while ancestor:
                        source_name = mj.mj_id2name(metadata, mj.mjtObj.mjOBJ_BODY, ancestor)
                        if not source_name:
                            raise ValueError('源相机祖先 body 未命名，无法精确对应 / Unnamed camera ancestor cannot exactly map to Newton body')
                        ancestors.append(sanitize_name(source_name))
                        ancestor = int(metadata.body_parentid[ancestor])
                    root_label = str(model_name) + '/worldbody' if model_name else 'worldbody'
                    source_path = root_label + '/' + '/'.join(reversed(ancestors))
                    matches = [i for i in range(start, end) if self.model.body_label[i] == source_path]
                    if len(matches) != 1:
                        raise ValueError('源相机父体无法唯一对应 Newton body / Source camera parent cannot uniquely map to Newton body: ' + source_path)
                    parent = matches[0]
                    parent_name = self.model.body_label[parent]
                else:
                    p, q, _ = poses[eid]
                    root_rotation = rotation(q)
                    position, matrix = p + root_rotation @ position, root_rotation @ matrix
                sensor = np.asarray(metadata.cam_sensorsize[index], dtype=float)
                resolution = np.asarray(metadata.cam_resolution[index], dtype=float)
                intrinsic = np.asarray(metadata.cam_intrinsic[index], dtype=float)
                if min(sensor) > 0 and min(resolution) > 0 and min(intrinsic[:2]) > 0:
                    focal = intrinsic[:2] * resolution / sensor
                    principal = intrinsic[2:] * resolution / sensor
                    optics = {'intrinsics': {'fx': float(focal[0]), 'fy': float(focal[1]),
                                             'cx': float((resolution[0]-1)/2 - principal[0]),
                                             'cy': float((resolution[1]-1)/2 - principal[1]),
                                             'width': float(resolution[0]), 'height': float(resolution[1])},
                              'intrinsicsSource': 'engine-intrinsics'}
                else:
                    optics = self._optics({'fovyDeg': float(metadata.cam_fovy[index])}, 'fovyDeg')
                return {**optics, 'parentBodyName': parent_name, '_parent': parent,
                        '_position': position, '_rotation': matrix}

            self._put(record, build)

    def _scene_cameras(self, entity, poses):
        eid = entity['entityId']
        components = entity.get('components') or {}
        declarations = []
        if isinstance(components.get('camera'), dict) and components['camera']:
            declarations.append(('camera', entity.get('name') or 'camera', components['camera']))
        viewer = components.get('viewerCamera')
        if isinstance(viewer, dict) and isinstance(viewer.get('cameras'), list):
            for item in viewer['cameras']:
                if isinstance(item, dict):
                    declarations.append(('viewerCamera', item.get('name') or entity.get('name') or 'camera', item.get('state', item)))
        for component, local_name, pose in declarations:
            record = {'cameraName': eid + '/' + str(local_name), 'localName': str(local_name),
                      'entityId': eid, 'cameraSource': 'scene-camera', 'cameraComponent': component}

            def build(component=component, pose=pose):
                if not isinstance(pose, dict):
                    raise ValueError('相机声明必须是对象 / Camera declaration must be an object')
                optics = self._optics(pose, 'fovYDeg' if component == 'camera' else 'fovDeg')
                p, q, _ = poses[eid]
                position, matrix = np.asarray(p, dtype=float), rotation(q)
                if component == 'viewerCamera':
                    if 'position' not in pose or 'quaternion' not in pose:
                        raise ValueError('命名相机需要保存的世界位置与四元数 / Saved camera requires world position and quaternion')
                    position, matrix = np.asarray(pose['position'], dtype=float), rotation(pose['quaternion'])
                if position.shape != (3,) or not np.isfinite(position).all():
                    raise ValueError('相机位置必须是有限三维向量 / Camera position must be a finite 3-vector')
                owner = eid if eid in self.world.entities else entity.get('parentId')
                parent_info = self.world.entities.get(owner)
                parent = None if parent_info is None else parent_info.get('rootBody')
                if parent_info and (parent_info.get('liquid') or (
                        'bodyEnd' in parent_info and parent_info['bodyEnd'] <= parent_info.get('bodyStart', 0))):
                    raise ValueError('父实体没有可挂载的 Newton body / Parent entity has no Newton body for camera mounting')
                if parent is not None and not 0 <= parent < self.model.body_count:
                    raise ValueError('父实体没有可挂载的 Newton body / Parent entity has no Newton body for camera mounting')
                if owner and parent_info is None:
                    raise ValueError('父实体没有真实 Newton body / Parent entity has no physical Newton body: ' + str(owner))
                parent_name = 'world'
                if parent is not None:
                    initial = self.model.body_q.numpy()[parent]
                    initial_rotation = rotation(initial[3:7])
                    position, matrix = initial_rotation.T @ (position-initial[:3]), initial_rotation.T @ matrix
                    parent_name = self.model.body_label[parent]
                return {**optics, 'parentBodyName': parent_name, '_parent': parent,
                        '_position': position, '_rotation': matrix}

            self._put(record, build)

    def _refresh(self):
        self.world.require_ready()
        if self.model is self.world.model and self.scene is self.world.scene:
            return
        self.sensor = None
        self.cameras = {}
        self.warnings = []
        self.captures = {}
        self.model, self.scene = self.world.model, self.world.scene
        poses = self.world_poses(self.scene)
        for entity in self.scene['entities']:
            cfg = self.native_source(entity)
            if cfg:
                self._native_cameras(entity, cfg, poses)
            self._scene_cameras(entity, poses)

    def _effective(self, record, width, height, body_q):
        result = {key: copy.deepcopy(value) for key, value in record.items() if not key.startswith('_')}
        if not record['available']:
            return result
        position, matrix = record['_position'], record['_rotation']
        if record['_parent'] is not None:
            body = body_q[record['_parent']]
            body_rotation = rotation(body[3:7])
            position, matrix = body[:3] + body_rotation @ position, body_rotation @ matrix
        source = record.get('intrinsics')
        if source:
            sx, sy = width/source['width'], height/source['height']
            fx, fy = source['fx']*sx, source['fy']*sy
            cx, cy = (source['cx']+.5)*sx-.5, (source['cy']+.5)*sy-.5
        else:
            fx = fy = height/(2*math.tan(math.radians(record['fovyDeg'])/2))
            cx, cy = (width-1)/2, (height-1)/2
        fovy = math.degrees(2*math.atan(height/(2*fy)))
        result.update({'fovyDeg': fovy, 'referenceResolution': [width, height],
                       'intrinsics': {'fx': fx, 'fy': fy, 'cx': cx, 'cy': cy, 'width': width, 'height': height,
                                      'fovyDeg': fovy, 'pixelAspectRatio': fx/fy, 'distortionModeled': False},
                       'worldFromCamera': {'positionM': [float(v) for v in position], 'rotationMatrix': matrix.tolist()}})
        return result

    def list(self, options=None):
        self._refresh()
        width, height = self._resolution(options or {})
        body_q = self.world.state_a.body_q
        body_q = body_q.numpy() if body_q is not None else np.empty((0, 7))
        return {'worldId': self.world.id, 'generation': self.world.generation,
                'sceneRevision': self.world.applied_revision, 'stepIndex': self.world.step_index,
                'simTime': float(self.world.sim_time), 'referenceResolution': [width, height],
                'source': 'newton-sensor-tiled-camera',
                'cameras': [self._effective(c, width, height, body_q) for c in self.cameras.values()],
                'warnings': copy.deepcopy(self.warnings)}

    def _resolve(self, name):
        if not isinstance(name, str) or not name.strip():
            self.fail('INVALID_ARGUMENT', '需要显式命名相机 / An explicit named camera is required')
        matches = [c for key, c in self.cameras.items() if key == name]
        if not matches:
            matches = [c for c in self.cameras.values() if c['localName'] == name]
        if not matches:
            self.fail('CAMERA_NOT_FOUND', '相机不存在 / Camera not found: ' + name)
        if len(matches) > 1:
            self.fail('AMBIGUOUS_CAMERA', '多个实体拥有同名相机 / Multiple entities have this camera: ' + name)
        if not matches[0]['available']:
            self.fail('UNSUPPORTED_CAPABILITY', matches[0]['reason'])
        return matches[0]

    def capture_multi(self, options):
        self._refresh()
        width, height = self._resolution(options)
        names = options.get('cameraNames')
        if not isinstance(names, list) or not names or any(not isinstance(n, str) or not n.strip() for n in names):
            self.fail('INVALID_ARGUMENT', 'cameraNames 必须是非空命名数组 / Camera names must be a nonempty string array')
        records = [self._resolve(n) for n in names]
        if len({c['cameraName'] for c in records}) != len(records):
            self.fail('INVALID_ARGUMENT', 'cameraNames 不可重复 / Camera names must be unique')
        if options.get('geomGroups') is not None:
            self.fail('UNSUPPORTED_CAPABILITY', 'Newton 相机未接通 MuJoCo geomGroups / MuJoCo geomGroups are not connected for Newton cameras')
        output_dir = options.get('outputDir')
        if not isinstance(output_dir, str) or not output_dir:
            self.fail('INVALID_ARGUMENT', 'outputDir 必须是非空路径 / Output directory is required')
        import warp as wp
        from newton.sensors import SensorTiledCamera
        try:
            if self.sensor is None:
                self.sensor = SensorTiledCamera(self.model, default_render_config=SensorTiledCamera.RenderConfig(enable_textures=True))
            state = self.world.state_a
            self.model.bvh_refit_shapes(state)
            self.model.bvh_refit_particles(state)
            body_q = state.body_q.numpy() if state.body_q is not None else np.empty((0, 7))
            effective = [self._effective(c, width, height, body_q) for c in records]
            images = []
            # worker 串行分派；整个多视图调用内没有 tick 或其他状态更新。
            for camera in effective:
                k = camera['intrinsics']
                # 原生 helper 在像素边界坐标采样 u+.5；公共 K 使用整数像素中心。
                rays = self.sensor.utils.compute_camera_rays_pinhole_opencv(width, height, k['fx'], k['fy'], k['cx']+.5, k['cy']+.5)
                pose = camera['worldFromCamera']
                transform = [*pose['positionM'], *quaternion(pose['rotationMatrix'])]
                transforms = wp.array(np.array([[transform]], dtype=np.float32), dtype=wp.transform, device=self.model.device)
                color = self.sensor.utils.create_color_image_output(width, height)
                depth = self.sensor.utils.create_forward_depth_image_output(width, height)
                self.sensor.update(state, transforms, rays, color_image=color, forward_depth_image=depth)
                wp.synchronize_device(self.model.device)
                packed = color.numpy()[0, 0]
                rgb = np.stack([(packed >> shift) & 255 for shift in (0, 8, 16)], axis=-1).astype(np.uint8)
                axial = depth.numpy()[0, 0].copy()
                if not np.isfinite(axial).all():
                    self.fail('RENDER_FAILED', '原生深度含非有限值 / Native depth contains nonfinite values')
                images.append((rgb, axial))
        except ImportError as exc:
            self.fail('PROVIDER_DEPENDENCY_MISSING', 'Newton 相机渲染缺少依赖 / Newton camera rendering dependency missing: ' + str(exc))
        root = Path(output_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        capture_id = str(uuid.uuid4())
        entries = []
        for index, (camera, (rgb, depth)) in enumerate(zip(effective, images)):
            rgb_path = root / (capture_id + '-' + str(index) + '-rgb.png')
            depth_path = root / (capture_id + '-' + str(index) + '-depth.npy')
            write_rgb_png(rgb_path, rgb)
            np.save(depth_path, depth, allow_pickle=False)
            calibration = {'model': 'pinhole', 'intrinsicsSource': camera['intrinsicsSource'],
                           'intrinsics': camera['intrinsics'], 'worldFromCamera': camera['worldFromCamera'],
                           'parentBodyName': camera['parentBodyName'], 'referenceFrame': None,
                           'coordinateSystem': 'right-handed-z-up; camera looks along -Z, +Y up',
                           'depthSemantics': 'axial-meters-along-camera-axis; p_cam=[(u-cx)*d/fx, -(v-cy)*d/fy, -d]; world=R*p_cam+t',
                           'backgroundDepthM': 0.0, 'invalidDepthRule': 'depth <= 0 is no hit'}
            entries.append({'cameraName': names[index], 'resolvedCameraName': camera['cameraName'],
                            'worldGeneration': self.world.generation, 'override': False,
                            'rgb': {'uri': rgb_path.as_uri(), 'mimeType': 'image/png'},
                            'depth': {'uri': depth_path.as_uri(), 'mimeType': 'application/x-npy', 'units': 'm'},
                            'depthRangeM': [float(depth.min()), float(depth.max())], 'calibration': calibration})
        observation_selection = {'sensors': True}
        # MPM 使用原生 collider，未提供刚体 Contacts；其余路径保持接触读回。
        if self.world.solver_name != 'implicit-mpm':
            observation_selection['contacts'] = True
        result = {'worldId': self.world.id, 'generation': self.world.generation,
                  'stepIndex': self.world.step_index, 'simTime': float(self.world.sim_time),
                  'sceneRevision': self.world.applied_revision,
                  'frameId': f'{self.world.id}:{self.world.generation}:{self.world.step_index}',
                  'source': 'newton-sensor-tiled-camera', 'captureId': capture_id,
                  'multi': len(entries) > 1, 'cameraNames': list(names), 'width': width, 'height': height,
                  'cameras': entries, 'renderOption': {'source': 'Newton VISIBLE shapes and native particles'},
                  'observation': self.world.observe(observation_selection)}
        self.captures[capture_id] = copy.deepcopy(result)
        return result

    def capture(self, options):
        multi = self.capture_multi({**options, 'cameraNames': [options.get('cameraName')]})
        result = {key: value for key, value in multi.items() if key not in ('cameras', 'cameraNames', 'multi')}
        result.update(multi['cameras'][0])
        result['multi'] = False
        return result

    def publish_capture(self, capture_id, from_dir, to_dir):
        """继承公共 transport 的会话暂存→产品路径回写；只改已记录文件的 URI。"""
        record = self.captures.get(capture_id)
        if record is None:
            self.fail('CAPTURE_NOT_FOUND', '采集记录不存在 / Capture not found: ' + str(capture_id))
        source, destination = Path(from_dir).resolve(), Path(to_dir).resolve()
        from urllib.parse import unquote, urlparse
        updates = []
        for camera in record['cameras']:
            for key in ('rgb', 'depth'):
                file = Path(unquote(urlparse(camera[key]['uri']).path)).resolve()
                try:
                    relative = file.relative_to(source)
                except ValueError:
                    self.fail('INVALID_ARGUMENT', '采集文件不在暂存目录 / Capture file is outside staging directory')
                updates.append((camera[key], (destination / relative).as_uri()))
        for file, uri in updates:
            file['uri'] = uri
        return {'captureId': capture_id, 'files': len(updates)}
