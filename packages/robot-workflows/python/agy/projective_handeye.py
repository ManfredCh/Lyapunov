# Copyright 2026 DeepMind Technologies Limited
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
#!/usr/bin/env python3
"""Multi-pose 3D hand-eye calibration sweep and perspective-regularized 3x4 projection fitter (Stage 5 Part C)."""

# Lyapunov adaptation: retain only offline calibration math.
import math
from typing import Any

import numpy as np


def pixel_to_world_at_z(
    proj_matrix: np.ndarray, u: float, v: float, z_plane_m: float
) -> tuple[float, float]:
  """Closed-form ray-plane intersection mapping overhead pixel (u, v) to robot (X, Y) at Z = z_plane_m."""
  m_mat = np.asarray(proj_matrix, dtype=float)
  a_mat = np.array(
      [
          [m_mat[0, 0] - u * m_mat[2, 0], m_mat[0, 1] - u * m_mat[2, 1]],
          [m_mat[1, 0] - v * m_mat[2, 0], m_mat[1, 1] - v * m_mat[2, 1]],
      ],
      dtype=float,
  )
  b_vec = np.array(
      [
          u * (m_mat[2, 2] * z_plane_m + m_mat[2, 3])
          - (m_mat[0, 2] * z_plane_m + m_mat[0, 3]),
          v * (m_mat[2, 2] * z_plane_m + m_mat[2, 3])
          - (m_mat[1, 2] * z_plane_m + m_mat[1, 3]),
      ],
      dtype=float,
  )
  xy = np.linalg.solve(a_mat, b_vec)
  return float(xy[0]), float(xy[1])


def fit_projective_handeye(
    samples: list[dict[str, Any]],
    mount_z_offset_m: float = 0.098,
    reg_lambda: float = 500.0,
) -> dict[str, Any]:
  """Fit perspective-regularized 3x4 projective camera matrix M mapping [X_tip, Y_tip, Z_tip, 1]^T -> [u, v, 1]^T."""
  if len(samples) < 8:
    raise RuntimeError(
        f"Need at least 8 valid calibration samples, got {len(samples)}"
    )

  pts = np.array([s["tip_xyz_m"] for s in samples], dtype=float)
  uvs = np.array([s["marker_uv_px"] for s in samples], dtype=float)

  rows = []
  rhs = []
  for (x_w, y_w, z_w), (u_px, v_px) in zip(pts, uvs):
    rows.append([
        x_w,
        y_w,
        z_w,
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -u_px * x_w,
        -u_px * y_w,
        -u_px * z_w,
    ])
    rhs.append(u_px)
    rows.append([
        0.0,
        0.0,
        0.0,
        0.0,
        x_w,
        y_w,
        z_w,
        1.0,
        -v_px * x_w,
        -v_px * y_w,
        -v_px * z_w,
    ])
    rhs.append(v_px)

  for col in (8, 9, 10):
    reg = [0.0] * 11
    reg[col] = float(reg_lambda)
    rows.append(reg)
    rhs.append(0.0)

  theta_m, _, _, _ = np.linalg.lstsq(
      np.array(rows, dtype=float), np.array(rhs, dtype=float), rcond=None
  )
  m_final = [
      [
          float(theta_m[0]),
          float(theta_m[1]),
          float(theta_m[2]),
          float(theta_m[3]),
      ],
      [
          float(theta_m[4]),
          float(theta_m[5]),
          float(theta_m[6]),
          float(theta_m[7]),
      ],
      [float(theta_m[8]), float(theta_m[9]), float(theta_m[10]), 1.0],
  ]
  m_np = np.array(m_final, dtype=float)

  per_pose_errors = []
  for s in samples:
    xt, yt, zt = [float(v) for v in s["tip_xyz_m"]]
    proj = m_np @ np.array([xt, yt, zt, 1.0], dtype=float)
    u_hat, v_hat = float(proj[0] / proj[2]), float(proj[1] / proj[2])
    u_obs_k, v_obs_k = float(s["marker_uv_px"][0]), float(s["marker_uv_px"][1])
    px_err = math.hypot(u_hat - u_obs_k, v_hat - v_obs_k)

    xy_hat = pixel_to_world_at_z(m_np, u_obs_k, v_obs_k, zt)
    mm_err = math.hypot(xy_hat[0] - xt, xy_hat[1] - yt) * 1000.0
    per_pose_errors.append({
        "pose_idx": s["pose_idx"],
        "tip_xyz_m": [round(xt, 4), round(yt, 4), round(zt, 4)],
        "obs_uv_px": [round(u_obs_k, 2), round(v_obs_k, 2)],
        "pred_uv_px": [round(u_hat, 2), round(v_hat, 2)],
        "reproj_error_px": round(px_err, 2),
        "table_xy_error_mm": round(mm_err, 2),
    })

  rmse_px = float(
      np.sqrt(np.mean([e["reproj_error_px"] ** 2 for e in per_pose_errors]))
  )
  rmse_mm = float(
      np.sqrt(np.mean([e["table_xy_error_mm"] ** 2 for e in per_pose_errors]))
  )

  return {
      "projection_matrix_3x4": m_final,
      "mount_z_offset_m": mount_z_offset_m,
      "num_samples": len(samples),
      "rmse_reprojection_px": round(rmse_px, 2),
      "rmse_localization_mm": round(rmse_mm, 2),
      "per_pose_errors": per_pose_errors,
  }
