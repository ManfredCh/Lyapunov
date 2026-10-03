"""Read explicit Gazebo/SDFormat pinhole sensor declarations from URDF.

No camera is inferred from link names. Reference links and poses are retained;
Gazebo +X forward/+Y left/+Z up is converted once to camera +X right/+Y up/-Z forward.
Sources: https://sdformat.org/spec/1.11/sensor/
https://get.gazebosim.org/tutorials?cat=connect_ros&tut=ros_gzplugins
https://gazebosim.org/api/sim/10/frame_reference.html
"""
import math
from xml.etree import ElementTree
import numpy as np
import mujoco as mj


def _number(node, path, default=None):
    text = node.findtext(path)
    if text is None:
        if default is None:
            raise ValueError('missing ' + path)
        return default
    value = float(text)
    if not math.isfinite(value):
        raise ValueError('nonfinite ' + path)
    return value


def _pose(node, allowed_reference):
    element = node.find('pose')
    if element is None:
        return np.eye(4)
    relative = element.get('relative_to', element.get('frame', ''))
    if relative and relative != allowed_reference:
        raise ValueError('unsupported pose reference ' + relative)
    values = np.array([float(v) for v in (element.text or '').split()])
    fmt = element.get('rotation_format', 'euler_rpy')
    if not np.all(np.isfinite(values)):
        raise ValueError('nonfinite pose')
    matrix = np.eye(4)
    if fmt == 'quat_xyzw' and len(values) == 7:
        q = values[[6, 3, 4, 5]]
        if np.linalg.norm(q) < 1e-12:
            raise ValueError('zero pose quaternion')
        rotation = np.empty(9)
        mj.mju_quat2Mat(rotation, q / np.linalg.norm(q))
        matrix[:3, :3] = rotation.reshape(3, 3)
    elif fmt == 'euler_rpy' and len(values) == 6:
        r, p, y = values[3:]
        if element.get('degrees', 'false').lower() in ('true', '1'):
            r, p, y = np.radians([r, p, y])
        cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
        matrix[:3, :3] = [[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
                         [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr], [-sp, cp*sr, cp*cr]]
    else:
        raise ValueError('unsupported pose rotation format or size')
    matrix[:3, 3] = values[:3]
    return matrix


def install_urdf_cameras(spec, path, optics):
    """Install only complete declared pinhole cameras into existing real links.

    Return source metadata and named refusals for camera_list/robot_presets.
    The source document is read-only; distortion/skew/stereo P cannot be
    represented by the current pinhole provider and are explicitly refused.
    """
    root = ElementTree.parse(path).getroot()
    records, refusals = {}, []
    links = {link.get('name') for link in root.findall('link')}
    declarations = [(g.get('reference', ''), sensor) for g in root.findall('gazebo') for sensor in g.findall('sensor')
                    if sensor.get('type') in ('camera', 'depth', 'depth_camera', 'rgbd', 'rgbd_camera', 'multicamera', 'wideanglecamera')]
    if not declarations:
        return records, refusals
    # Fixed sensor links must retain their identity rather than be fused away.
    spec.compiler.fusestatic = False
    optical = np.array([[0., 0., -1.], [-1., 0., 0.], [0., 1., 0.]])
    for reference, sensor in declarations:
        name = sensor.get('name', '')
        cameras = sensor.findall('camera')
        if not cameras:
            refusals.append({'cameraName': name, 'code': 'URDF_CAMERA_CALIBRATION_MISSING', 'message': 'camera sensor has no camera declaration'})
        for index, camera in enumerate(cameras):
            camera_name = name if len(cameras) == 1 else name + '::' + (camera.get('name') or str(index))
            try:
                if not camera_name or reference not in links:
                    raise ValueError('sensor name or reference link is missing')
                matches = [body for body in spec.bodies if body.name == reference]
                if len(matches) != 1:
                    raise ValueError('reference link has no unique native body: ' + reference)
                if sensor.get('type') == 'wideanglecamera' or camera.findtext('lens/type', 'gnomonical') not in ('gnomonical', 'perspective'):
                    raise ValueError('unsupported non-pinhole camera lens')
                if any(_number(camera, 'distortion/' + key, 0.) != 0. for key in ('k1', 'k2', 'k3', 'p1', 'p2')):
                    raise ValueError('nonzero distortion is not modeled by the pinhole provider')
                for plugin in sensor.findall('plugin'):
                    if any(_number(plugin, key, 0.) != 0. for key in ('distortionK1', 'distortionK2', 'distortionK3', 'distortionT1', 'distortionT2')):
                        raise ValueError('nonzero plugin distortion is not modeled by the pinhole provider')
                width, height = _number(camera, 'image/width'), _number(camera, 'image/height')
                if not all(v.is_integer() and 16 <= v <= 4096 for v in (width, height)):
                    raise ValueError('invalid image resolution')
                width, height = int(width), int(height)
                intrinsics = camera.find('lens/intrinsics')
                if intrinsics is not None:
                    k = {key: _number(intrinsics, key) for key in ('fx', 'fy', 'cx', 'cy')}
                    if _number(intrinsics, 's', 0.) != 0.:
                        raise ValueError('nonzero intrinsic skew is unsupported')
                else:
                    fov = _number(camera, 'horizontal_fov')
                    if not 0 < fov < math.pi:
                        raise ValueError('horizontal_fov must be in (0,pi) radians')
                    focal = width / (2. * math.tan(fov / 2.))
                    k = {'fx': focal, 'fy': focal, 'cx': (width-1)/2., 'cy': (height-1)/2.}
                projection = camera.find('lens/projection')
                if projection is not None:
                    if _number(projection, 'tx', 0.) != 0. or _number(projection, 'ty', 0.) != 0.:
                        raise ValueError('stereo projection tx/ty is unsupported')
                    k = {key: _number(projection, 'p_' + key, k[key]) for key in ('fx', 'fy', 'cx', 'cy')}
                if k['fx'] <= 0 or k['fy'] <= 0:
                    raise ValueError('focal lengths must be positive')
                k.update(width=width, height=height)
                near, far = _number(camera, 'clip/near', .1), _number(camera, 'clip/far', 100.)
                if not 0 < near < far:
                    raise ValueError('invalid clip range')
                pose = _pose(sensor, reference) @ _pose(camera, name)
                rotation = pose[:3, :3] @ optical
                quaternion = np.empty(4)
                mj.mju_mat2Quat(quaternion, rotation.reshape(9))
                if camera_name in records or any(c.name == camera_name for c in spec.cameras):
                    raise ValueError('duplicate camera name ' + camera_name)
                fovy = math.degrees(2. * math.atan(height / (2. * k['fy'])))
                matches[0].add_camera(name=camera_name, pos=pose[:3, 3], quat=quaternion, **optics(k, fovy))
                records[camera_name] = {'cameraSource': 'urdf', 'sourceFormat': 'urdf-gazebo-sensor', 'sensorType': sensor.get('type'),
                                        'parentBodyName': reference, 'declaredIntrinsicsPx': k,
                                        'declaredNearM': near, 'declaredFarM': far,
                                        'orientationSource': 'gazebo-body-to-optical',
                                        'sourceSensorName': name, 'opticalFrameId': camera.findtext('optical_frame_id')}
            except (ValueError, TypeError) as exc:
                refusals.append({'cameraName': camera_name, 'code': 'URDF_CAMERA_UNSUPPORTED', 'message': str(exc), 'parentBodyName': reference})
    return records, refusals
