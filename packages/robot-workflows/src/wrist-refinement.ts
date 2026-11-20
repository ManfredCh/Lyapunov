import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import type { GraspCandidate, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import { assertIdentity, type RequestIdentity } from './workflow-evidence.ts'

export interface WristRefinementInput {
  cameraName: string
  outputDir: string
  targetChannel: 'red' | 'green' | 'blue'
  /** Initial estimate in world meters, from the same source used by the baseline. */
  estimateXY: [number, number]
  /** Height of the visible planar face, in world meters. */
  targetPlaneZM: number
  maxCorrectionM: number
  /** Include the first measurement. Explicit opt-in for repeated observation and correction. */
  feedbackPasses?: number
  feedbackToleranceM?: number
  /** Retry once from a wider view when the first target mask is absent or cut off. */
  reacquireBackoffM?: number
  /** Optional radial correction for an arm whose approach pose rotates with azimuth. */
  yawPivotXY?: [number, number]
}

interface Capture {
  worldId: string; generation: number; frameId: string; stepIndex: number
  parentEntityId?: string; cameraName: string; captureId: string; source: string
  width: number; height: number; rgb: { uri: string }; depth: { uri: string; units: string }
  calibration: {
    intrinsics: { fx: number; fy: number; cx: number; cy: number }
    worldFromCamera: { positionM: Vec3; rotationMatrix: [Vec3, Vec3, Vec3] }
  }
}

/** Decode the bounded RGB8 scanlines emitted by the MuJoCo worker. */
function readRaster(png: Buffer, width: number, height: number): Buffer {
  if (png.length < 45 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height
    || png.subarray(24, 29).toString('hex') !== '0802000000') throw new Error('WRIST_RGB_FORMAT_UNSUPPORTED')
  const pieces: Buffer[] = []
  for (let pos = 8; pos + 12 <= png.length;) {
    const size = png.readUInt32BE(pos), tag = png.toString('ascii', pos + 4, pos + 8)
    if (pos + 12 + size > png.length) throw new Error('WRIST_RGB_INVALID')
    if (tag === 'IDAT') pieces.push(png.subarray(pos + 8, pos + 8 + size))
    pos += 12 + size
  }
  const stride = 3 * width + 1
  const data = inflateSync(Buffer.concat(pieces), { maxOutputLength: stride * height })
  if (data.length !== stride * height) throw new Error('WRIST_RGB_INVALID')
  for (let y = 0; y < height; y++) if (data[y * stride] !== 0) throw new Error('WRIST_RGB_FORMAT_UNSUPPORTED')
  return data
}

/** Read MuJoCo's native little-endian float32 NPY, without accepting other encodings. */
function readAxialDepth(npy: Buffer, width: number, height: number) {
  if (npy.length < 10 || npy.subarray(0, 8).toString('hex') !== '934e554d50590100') throw new Error('WRIST_DEPTH_FORMAT_UNSUPPORTED')
  const offset = 10 + npy.readUInt16LE(8)
  const header = npy.toString('ascii', 10, offset)
  if (!header.includes("'descr': '<f4'") || !header.includes("'fortran_order': False")
    || !header.includes(`'shape': (${height}, ${width})`) || npy.length !== offset + width * height * 4) {
    throw new Error('WRIST_DEPTH_FORMAT_UNSUPPORTED')
  }
  return (u: number, v: number) => npy.readFloatLE(offset + 4 * (v * width + u))
}

/** Estimate tabletop XY from a fresh color mask and calibrated camera rays. */
export async function wristCorrection(value: unknown, identity: RequestIdentity, robotId: string, options: WristRefinementInput) {
  const capture = value as Capture
  assertIdentity('腕相机采集', capture, identity)
  if (capture.parentEntityId !== robotId || capture.cameraName !== options.cameraName || capture.source !== 'mujoco-renderer') {
    throw new Error('WRIST_CAMERA_SOURCE_MISMATCH: 需要本次机器人挂载的 MuJoCo 相机')
  }
  const { width, height } = capture
  const { fx, fy, cx, cy } = capture.calibration.intrinsics
  const { positionM, rotationMatrix } = capture.calibration.worldFromCamera
  if (!(fx > 0 && fy > 0 && Number.isFinite(cx) && Number.isFinite(cy)) || width !== 256 || height !== 192) {
    throw new Error('WRIST_CAMERA_CALIBRATION_INVALID')
  }
  if (capture.depth.units !== 'm') throw new Error('WRIST_DEPTH_UNITS_UNSUPPORTED')
  const [rgb, depth] = await Promise.all([readFile(fileURLToPath(capture.rgb.uri)), readFile(fileURLToPath(capture.depth.uri))])
  const data = readRaster(rgb, width, height), axialDepth = readAxialDepth(depth, width, height)
  const channel = { red: 0, green: 1, blue: 2 }[options.targetChannel]
  const stride = 3 * width + 1
  const planeToleranceM = .0025
  let count = 0, sumX = 0, sumY = 0
  let loU = width, hiU = -1, loV = height, hiV = -1
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const p = v * stride + 1 + 3 * u, brightness = data[p + channel]!
      if (brightness < 65 || brightness - data[p + (channel + 1) % 3]! < 45 || brightness - data[p + (channel + 2) % 3]! < 45) continue
      const a = (u - cx) / fx, b = -(v - cy) / fy
      const ray = rotationMatrix.map(row => row[0] * a + row[1] * b - row[2]) as Vec3
      const distance = axialDepth(u, v)
      if (!Number.isFinite(distance) || distance <= 0 || Math.abs(positionM[2] + distance * ray[2] - options.targetPlaneZM) > planeToleranceM) continue
      sumX += positionM[0] + distance * ray[0]
      sumY += positionM[1] + distance * ray[1]
      loU = Math.min(loU, u); hiU = Math.max(hiU, u)
      loV = Math.min(loV, v); hiV = Math.max(hiV, v)
      count++
    }
  }
  if (count < 18 || loU < 2 || loV < 2 || hiU >= width - 2 || hiV >= height - 2) {
    throw new Error(`WRIST_TARGET_UNRELIABLE: captureId=${capture.captureId}, pixels=${count}, bounds=${loU},${loV},${hiU},${hiV}`)
  }
  const observedXY: [number, number] = [sumX / count, sumY / count]
  const deltaM: Vec3 = [observedXY[0] - options.estimateXY[0], observedXY[1] - options.estimateXY[1], 0]
  if (Math.hypot(...deltaM) > options.maxCorrectionM) throw new Error(`WRIST_CORRECTION_OUT_OF_RANGE: captureId=${capture.captureId}, deltaM=${deltaM}`)
  return { captureId: capture.captureId, cameraName: capture.cameraName, frameId: capture.frameId, stepIndex: capture.stepIndex,
    rgbUri: capture.rgb.uri, depthUri: capture.depth.uri, planeToleranceM, pixels: count, observedXY, deltaM }
}

/** Apply an XY correction and, for radial approaches, rotate around world +Z. */
export function correctedGraspPose(pose: GraspCandidate['tcpPose'], reference: WristRefinementInput,
  measurement: Awaited<ReturnType<typeof wristCorrection>>): GraspCandidate['tcpPose'] {
  const [x, y, z] = pose.position
  const [dx, dy] = measurement.deltaM
  if (!reference.yawPivotXY) return { ...pose, position: [x + dx, y + dy, z] }
  const [rx, ry] = reference.estimateXY, [px, py] = reference.yawPivotXY
  const yaw = Math.atan2(ry + dy - py, rx + dx - px) - Math.atan2(ry - py, rx - px)
  const cos = Math.cos(yaw), sin = Math.sin(yaw)
  const halfCos = Math.cos(yaw / 2), halfSin = Math.sin(yaw / 2)
  const [qx, qy, qz, qw] = pose.quaternion
  return {
    position: [rx + dx + cos * (x - rx) - sin * (y - ry), ry + dy + sin * (x - rx) + cos * (y - ry), z],
    quaternion: [halfCos * qx - halfSin * qy, halfCos * qy + halfSin * qx, halfCos * qz + halfSin * qw, halfCos * qw - halfSin * qz],
  }
}
