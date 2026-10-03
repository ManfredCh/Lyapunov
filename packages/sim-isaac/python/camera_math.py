"""Isaac 相机族的**纯算术**：像素 ↔ 相机/世界坐标、生效内参、深度有效性。

为什么单独一个文件：`worker.py` 顶部会启动 Kit/SimulationApp，**没有 RTX 与 Isaac SDK 就导不进来**，
所以标注/导出的算术如果写在 `World` 方法里，就只能靠"真机跑一次"来验证，本机（无 `/dev/nvidia*`）永远
验证不了。这里只放**不依赖任何引擎对象**的算术：入参是 numpy 数组与已经读回来的标定字典，出参是
坐标/内参/判定。这样：
  · `World.project_annotation` 走的就是这几个函数（同一份算术，不是第二套实现）；
  · 验收可以在任意解释器上直接用真实 numpy 数组复算，并做 unproject→reproject 往返核对。

坐标约定与 `worker.capture` 的回执 `calibration` 完全一致（**同一套约定，不新开一套**）：
  · 世界右手 Z-up；USD 相机沿自身 **-Z** 看、**+Y** 向上、+X 向右；
  · `worldFromCamera.rotationMatrix` 是 world-from-camera 3×3，**列** = 相机 x/y/z 轴在世界下的方向
    （与 `World._camera_world_rotation` 用 `TransformDir` 逐基向量得到的结果同构）；
  · 像素中心约定 `cx=(W-1)/2-...`、`cy=(H-1)/2+...`（与 `worker.capture` 一字不差）。
"""
import math


def intrinsics_from_fovy(fovyDeg, width, height, focalLength, horizontalApertureOffset=0.0, verticalApertureOffset=0.0):
    """由**生效竖直视场**与**本次请求分辨率**算 K（不读 prim 上可能停留在别处宽高比的孔径）。

    与 `World._camera_readback` 的 K 同一口径：竖直孔径 = 2·focalLength·tan(fovy/2)、
    水平孔径 = 竖直·width/height，故 fx=fy=H_c/(2·tan(fovy/2))；主点含孔径偏移。
    `intrinsicsSource='usd-camera-focalLength-aperture'`（与 capture 回执同一取值）。
    """
    width, height = int(width), int(height)
    focalLength = float(focalLength)
    vertical = 2 * focalLength * math.tan(math.radians(float(fovyDeg)) / 2)
    horizontal = vertical * width / height
    return {
        'fx': focalLength / horizontal * width,
        'fy': focalLength / vertical * height,
        'cx': (width - 1) / 2 - float(horizontalApertureOffset) / horizontal * width,
        'cy': (height - 1) / 2 + float(verticalApertureOffset) / vertical * height,
        'width': width,
        'height': height,
        'fovyDeg': float(fovyDeg),
        'distortion': [0.0, 0.0, 0.0, 0.0, 0.0],
        'intrinsicsSource': 'usd-camera-focalLength-aperture',
    }


def unproject_camera_point(u, v, depthM, intrinsics):
    """像素 (u,v) + 该像素的**米制轴向深度**（沿光轴）→ 相机坐标（USD 相机系：-Z 朝前、+Y 向上）。

    与 MuJoCo 侧同一套公式：X=(u-cx)·d/fx、Y=-(v-cy)·d/fy、Z=-d。
    缺内参（fx/fy 为 0/None）时明确拒绝，不返回一个"看起来差不多"的点。
    """
    fx, fy = intrinsics.get('fx'), intrinsics.get('fy')
    cx, cy = intrinsics.get('cx'), intrinsics.get('cy')
    if not fx or not fy:
        raise ValueError('CALIBRATION_REQUIRED')
    d = float(depthM)
    return [(float(u) - float(cx)) * d / float(fx), -(float(v) - float(cy)) * d / float(fy), -d]


def camera_point_to_world(cameraPointM, worldFromCamera):
    """相机坐标 → 世界坐标：`world = R·p_camera + t`（R 的列是相机轴在世界下的方向）。"""
    rotation = worldFromCamera.get('rotationMatrix')
    if not rotation:
        raise ValueError('CALIBRATION_REQUIRED')
    position = worldFromCamera.get('positionM')
    x, y, z = (float(value) for value in cameraPointM)
    point = []
    for row in range(3):
        point.append(rotation[row][0] * x + rotation[row][1] * y + rotation[row][2] * z + float(position[row]))
    return point


def world_point_to_pixel(worldPointM, intrinsics, worldFromCamera):
    """世界坐标 → 像素（反投影自校验）：先 R⁻¹·(p−t) 回到相机系，再按针孔模型投回 (u,v)。

    只用于回执/验收核对（`receiptRoundTripPx`），不参与坐标生成。
    """
    rotation = worldFromCamera['rotationMatrix']
    position = worldFromCamera['positionM']
    delta = [float(worldPointM[index]) - float(position[index]) for index in range(3)]
    cameraPoint = [sum(rotation[row][index] * delta[row] for row in range(3)) for index in range(3)]
    depth = -cameraPoint[2]
    u = float(intrinsics['fx']) * cameraPoint[0] / depth + float(intrinsics['cx'])
    v = float(intrinsics['fy']) * (-cameraPoint[1]) / depth + float(intrinsics['cy'])
    return [u, v]


def depth_is_valid(actual, farM, relativeTolerance=1e-6):
    """该像素的深度读数是否代表**真实几何**。

    拒绝三类，理由都是"这个读数不是被观测表面"：
      · 非有限（NaN/Inf）或 ≤0：深度通道没有有效读数；
      · 恰好落在相机远裁剪面（或更远）：RTX 的 `distance_to_image_plane` 对**未命中几何**的射线
        返回的正是远平面距离，比它更远不可能来自真实表面。
    `farM` 为 None（相机没写裁剪范围、USD 默认 1e6）时**只**判前两条：不拿一个猜出来的上限
    去拒绝本来有效的点。返回 (是否有效, 判定理由)。
    """
    value = float(actual)
    if not math.isfinite(value) or value <= 0:
        return False, 'NON_POSITIVE_OR_NON_FINITE'
    if farM is not None and value >= float(farM) * (1 - relativeTolerance):
        return False, 'AT_OR_BEYOND_FAR_CLIP'
    return True, 'GEOMETRY'


def select_capture(captures, capture_id, camera_name, resolved_camera_name, width, height, current_generation):
    """标注要引用的采集必须**同 world、同代次、同相机、同分辨率**；任一不成立即结构化拒绝。

    返回 (record, entry, intrinsics, worldFromCamera)。拒绝码与理由：
      · CAPTURE_NOT_FOUND      该 world 没登记过这个 captureId（标注只能引用真实采集）；
      · CAPTURE_NOT_REUSABLE   标注自带的新鲜渲染（ephemeral）：深度没有按本次渲染重新落盘；
      · STALE_GENERATION       采集属于旧世界代次（Isaac 的 generation 随 sync 变，标定/像素可能已不同步）；
      · CAMERA_NOT_IN_CAPTURE  该 capture 里没有这台相机；
      · INVALID_ARGUMENT       本次标注的参考分辨率与该 capture 的分辨率不一致（深度 npy 的尺寸由采集时定）；
      · CALIBRATION_REQUIRED   该相机条目没有可用内外参。
    调用方（worker）把 `ValueError` 的 `code:message` 原样转成引擎结构化错误。
    """
    record = captures.get(capture_id)
    if record is None:
        raise ValueError('CAPTURE_NOT_FOUND:captureId 不存在于当前 world（标注只能引用真实采集）: ' + str(capture_id))
    if record.get('ephemeral'):
        raise ValueError('CAPTURE_NOT_REUSABLE:该 capture 的深度未按本次渲染重新落盘，不能再次标注: ' + str(capture_id))
    if record.get('generation') != current_generation:
        raise ValueError('STALE_GENERATION:该 capture 属于旧世界代次（采集时 generation=' + str(record.get('generation'))
                         + '，当前 ' + str(current_generation) + '）：标定与像素可能已经不同步，拒绝而不是照旧算一个世界点')
    entry = next((item for item in (record.get('cameras') or [])
                  if item.get('cameraName') == camera_name or item.get('resolvedCameraName') == resolved_camera_name), None)
    if entry is None:
        raise ValueError('CAMERA_NOT_IN_CAPTURE:该 capture 没有相机: ' + str(camera_name))
    if record.get('width') != int(width) or record.get('height') != int(height):
        raise ValueError('INVALID_ARGUMENT:该 capture 的分辨率是 ' + str(record.get('width')) + 'x' + str(record.get('height'))
                         + '，与本次标注的 ' + str(int(width)) + 'x' + str(int(height)) + ' 不一致：标定按采集时的分辨率算，请按该 capture 的分辨率重新调用')
    calibration = entry.get('calibration')
    if not calibration or not calibration.get('intrinsics') or not calibration.get('worldFromCamera'):
        raise ValueError('CALIBRATION_REQUIRED:该 capture 的相机条目没有可用的内外参，无法反投影')
    return record, entry, calibration['intrinsics'], calibration['worldFromCamera']
