# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Lyapunov adaptation: offline MuJoCo optical geometry from Playground."""

import mujoco
import numpy as np

_CV_FROM_MJ_CAM = np.diag([1.0, -1.0, -1.0])


def camera_intrinsics_from_model(
    model: mujoco.MjModel, cam_id: int, width: int, height: int
) -> tuple[np.ndarray, float, float, float, float]:
  """Computes exact MuJoCo pinhole intrinsics K matching mjr_render."""
  ss, intr = model.cam_sensorsize[cam_id], model.cam_intrinsic[cam_id]
  if float(ss[0]) > 0.0 and float(ss[1]) > 0.0:
    fx, fy = float(intr[0] / ss[0] * width), float(intr[1] / ss[1] * height)
    cx = float((0.5 - intr[2] / ss[0]) * width)
    cy = float((0.5 + intr[3] / ss[1]) * height)
  else:
    fy = float(0.5 * height / np.tan(0.5 * np.deg2rad(model.cam_fovy[cam_id])))
    fx, cx, cy = fy, 0.5 * float(width), 0.5 * float(height)
  k = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]])
  return k, fx, fy, cx, cy


def _mat4(rot: np.ndarray, pos: np.ndarray) -> np.ndarray:
  t = np.eye(4, dtype=np.float64)
  t[:3, :3], t[:3, 3] = rot.reshape(3, 3), pos
  return t


def camera_world_pose_opencv(data: mujoco.MjData, cam_id: int) -> np.ndarray:
  """Returns 4x4 T_world_cam in OpenCV (+X right, +Y down, +Z forward) frame."""
  r_cv = data.cam_xmat[cam_id].reshape(3, 3) @ _CV_FROM_MJ_CAM
  return _mat4(r_cv, data.cam_xpos[cam_id])
