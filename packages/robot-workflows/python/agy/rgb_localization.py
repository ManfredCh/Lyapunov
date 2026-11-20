# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Robot-agnostic RGB metric 3D localization: ray-plane, homography & stereo."""

from typing import Any
import numpy as np

try:
  import cv2
except ImportError:
  cv2 = None


def _canonicalize_2d_axis(
    vec_2d: np.ndarray, prev_yaw_rad: float | None = None
) -> tuple[np.ndarray, float]:
  vec = np.asarray(vec_2d, dtype=np.float64)[:2].copy()
  norm = float(np.linalg.norm(vec))
  vec = np.array([1.0, 0.0], dtype=np.float64) if norm < 1e-12 else vec / norm
  if prev_yaw_rad is not None:
    ref = np.array(
        [np.cos(float(prev_yaw_rad)), np.sin(float(prev_yaw_rad))],
        dtype=np.float64,
    )
    if float(np.dot(vec, ref)) < 0.0:
      vec = -vec
  elif vec[0] < -1e-9 or (abs(float(vec[0])) <= 1e-9 and vec[1] < 0.0):
    vec = -vec
  return vec, float(np.arctan2(vec[1], vec[0]))


def ray_plane_contour_pose(
    mask_u8: np.ndarray,
    k_mat: np.ndarray,
    t_world_cam: np.ndarray,
    z_plane_m: float,
    min_area_px: float = 100.0,
    min_aspect: float = 1.0,
    roi_mask: np.ndarray | None = None,
    prev_yaw_rad: float | None = None,
) -> dict[str, float] | None:
  """Projects a foreground mask onto z = z_plane_m for perspective-free 3D pose."""
  work = (np.asarray(mask_u8) > 0).astype(np.uint8) * 255
  if roi_mask is not None:
    roi = np.asarray(roi_mask) > 0
    if roi.shape != work.shape[:2]:
      raise ValueError(
          f"roi_mask shape {roi.shape} must match mask shape {work.shape[:2]}."
      )
    work = np.where(roi, work, np.uint8(0))

  is_ordered_contour = False
  if cv2 is not None:
    contours, _ = cv2.findContours(
        work, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
    )
    best = None
    for cnt in contours:
      area = float(cv2.contourArea(cnt))
      if area < min_area_px:
        continue
      (_, _), (w, h), _ = cv2.minAreaRect(cnt)
      short = min(float(w), float(h))
      if short < 1.5:
        continue
      aspect = max(float(w), float(h)) / short
      if aspect >= min_aspect and (best is None or area > best[0]):
        best = (area, aspect, cnt.reshape(-1, 2).astype(np.float64))
    if best is None:
      return None
    _, aspect_val, pts_uv = best
    is_ordered_contour = True
  else:
    ys, xs = np.where(work > 0)
    if xs.shape[0] < min_area_px:
      return None
    pts_uv = np.column_stack([xs, ys]).astype(np.float64)
    centered_uv = pts_uv - np.mean(pts_uv, axis=0, keepdims=True)
    cov_uv = (centered_uv.T @ centered_uv) / max(1, pts_uv.shape[0] - 1)
    eig_uv = np.maximum(np.linalg.eigvalsh(cov_uv), 1e-12)
    aspect_val = float(np.sqrt(eig_uv[1] / eig_uv[0]))
    if aspect_val < min_aspect:
      return None

  k_arr = np.asarray(k_mat, dtype=np.float64)
  fx, fy = float(k_arr[0, 0]), float(k_arr[1, 1])
  cx, cy = float(k_arr[0, 2]), float(k_arr[1, 2])
  t_wc = np.asarray(t_world_cam, dtype=np.float64)
  p_cam = t_wc[:3, 3]
  r_cam = t_wc[:3, :3]

  rays_c = np.column_stack([
      (pts_uv[:, 0] - cx) / fx,
      (pts_uv[:, 1] - cy) / fy,
      np.ones(pts_uv.shape[0], dtype=np.float64),
  ])
  rays_w = rays_c @ r_cam.T
  non_parallel = np.abs(rays_w[:, 2]) > 1e-6
  if np.count_nonzero(non_parallel) < 4:
    return None
  rays_w = rays_w[non_parallel]
  pts_uv_np = pts_uv[non_parallel]
  dz = float(z_plane_m) - float(p_cam[2])
  s = dz / rays_w[:, 2]
  in_front = s > 0.0
  if np.count_nonzero(in_front) < 4:
    return None
  xy_w = p_cam[:2] + s[in_front, None] * rays_w[in_front, :2]

  if is_ordered_contour:
    seg_next = np.linalg.norm(np.roll(xy_w, -1, axis=0) - xy_w, axis=1)
    seg_prev = np.linalg.norm(xy_w - np.roll(xy_w, 1, axis=0), axis=1)
    weights = 0.5 * (seg_next + seg_prev)
  else:
    pts_uv_valid = pts_uv_np[in_front]
    rays_u = (
        np.column_stack([
            (pts_uv_valid[:, 0] + 1.0 - cx) / fx,
            (pts_uv_valid[:, 1] - cy) / fy,
            np.ones(pts_uv_valid.shape[0], dtype=np.float64),
        ])
        @ r_cam.T
    )
    rays_v = (
        np.column_stack([
            (pts_uv_valid[:, 0] - cx) / fx,
            (pts_uv_valid[:, 1] + 1.0 - cy) / fy,
            np.ones(pts_uv_valid.shape[0], dtype=np.float64),
        ])
        @ r_cam.T
    )
    s_u = dz / np.where(np.abs(rays_u[:, 2]) > 1e-6, rays_u[:, 2], 1e-6)
    s_v = dz / np.where(np.abs(rays_v[:, 2]) > 1e-6, rays_v[:, 2], 1e-6)
    du_xy = (p_cam[:2] + s_u[:, None] * rays_u[:, :2]) - xy_w
    dv_xy = (p_cam[:2] + s_v[:, None] * rays_v[:, :2]) - xy_w
    weights = np.abs(du_xy[:, 0] * dv_xy[:, 1] - du_xy[:, 1] * dv_xy[:, 0])
  w_sum = float(np.sum(weights))
  w_norm = (
      np.full(xy_w.shape[0], 1.0 / xy_w.shape[0], dtype=np.float64)
      if w_sum <= 1e-12
      else weights / w_sum
  )

  mean_xy = np.sum(xy_w * w_norm[:, None], axis=0)
  centered = xy_w - mean_xy
  cov = (centered * w_norm[:, None]).T @ centered
  eigvals, eigvecs = np.linalg.eigh(cov)
  major, yaw_rad = _canonicalize_2d_axis(eigvecs[:, 1], prev_yaw_rad)
  minor = np.array([-major[1], major[0]], dtype=np.float64)
  anisotropy = float(max(eigvals[1], 0.0) / max(eigvals[0], 1e-12))

  proj_major = centered @ major
  proj_minor = centered @ minor
  obb_xy = (
      mean_xy
      + 0.5 * (float(proj_major.min()) + float(proj_major.max())) * major
      + 0.5 * (float(proj_minor.min()) + float(proj_minor.max())) * minor
  )
  return {
      "x_m": float(obb_xy[0]),
      "y_m": float(obb_xy[1]),
      "z_m": float(z_plane_m),
      "yaw_rad": yaw_rad,
      "anisotropy": anisotropy,
      "length_m": float(proj_major.max() - proj_major.min()),
      "width_m": float(proj_minor.max() - proj_minor.min()),
      "aspect": aspect_val,
  }


def fit_plane_homography(pts_uv: np.ndarray, pts_xy: np.ndarray) -> np.ndarray:
  """Fits a 3x3 image-to-plane homography H from >= 4 coplanar correspondences."""
  uv = np.asarray(pts_uv, dtype=np.float64).reshape(-1, 2)
  xy = np.asarray(pts_xy, dtype=np.float64).reshape(-1, 2)
  if uv.shape[0] < 4 or uv.shape != xy.shape:
    raise ValueError(
        "At least 4 matching (u, v) <-> (x, y) pairs are required."
    )
  if cv2 is not None:
    h_mat, _ = cv2.findHomography(uv, xy, method=0)
    if h_mat is None:
      raise RuntimeError("cv2.findHomography failed on degenerate points.")
    return np.asarray(h_mat, dtype=np.float64)

  rows: list[list[float]] = []
  for (u, v), (x, y) in zip(uv, xy):
    rows.append([-u, -v, -1.0, 0.0, 0.0, 0.0, u * x, v * x, x])
    rows.append([0.0, 0.0, 0.0, -u, -v, -1.0, u * y, v * y, y])
  _, _, vh = np.linalg.svd(np.asarray(rows, dtype=np.float64))
  h_mat = vh[-1].reshape(3, 3)
  if abs(float(h_mat[2, 2])) < 1e-12:
    raise RuntimeError("Degenerate points for homography.")
  h_mat = h_mat / h_mat[2, 2]
  if abs(float(np.linalg.det(h_mat))) < 1e-12:
    raise RuntimeError("Degenerate points for homography.")
  return h_mat


def map_homography_xy_and_yaw(
    u_px: float,
    v_px: float,
    h_mat: np.ndarray,
    vx_px: float | None = None,
    vy_px: float | None = None,
    prev_yaw_rad: float | None = None,
) -> dict[str, float | None]:
  """Maps (u_px, v_px) and optional image tangent analytically via Jacobian of H."""
  h_arr = np.asarray(h_mat, dtype=np.float64)
  p_hom = h_arr @ np.array([float(u_px), float(v_px), 1.0], dtype=np.float64)
  if abs(float(p_hom[2])) < 1e-12:
    raise ValueError("Point maps to infinity under homography.")
  x_m = float(p_hom[0] / p_hom[2])
  y_m = float(p_hom[1] / p_hom[2])

  yaw_rad: float | None = None
  if vx_px is not None and vy_px is not None:
    w_denom = float(p_hom[2])
    j_mat = np.array(
        [
            [
                (h_arr[0, 0] - x_m * h_arr[2, 0]) / w_denom,
                (h_arr[0, 1] - x_m * h_arr[2, 1]) / w_denom,
            ],
            [
                (h_arr[1, 0] - y_m * h_arr[2, 0]) / w_denom,
                (h_arr[1, 1] - y_m * h_arr[2, 1]) / w_denom,
            ],
        ],
        dtype=np.float64,
    )
    dp = j_mat @ np.array([float(vx_px), float(vy_px)], dtype=np.float64)
    _, yaw_rad = _canonicalize_2d_axis(dp, prev_yaw_rad)

  return {"x_m": x_m, "y_m": y_m, "yaw_rad": yaw_rad}


def triangulate_matched_points(
    k1: np.ndarray,
    t_world_cam1: np.ndarray,
    pts1_uv: np.ndarray,
    k2: np.ndarray,
    t_world_cam2: np.ndarray,
    pts2_uv: np.ndarray,
    max_reproj_err_px: float = 2.0,
) -> dict[str, Any]:
  """Triangulates matched 2D points across two calibrated views with reproj gate."""
  uv1 = np.asarray(pts1_uv, dtype=np.float64).reshape(-1, 2)
  uv2 = np.asarray(pts2_uv, dtype=np.float64).reshape(-1, 2)
  if uv1.shape[0] == 0 or uv1.shape != uv2.shape:
    raise ValueError("pts1_uv and pts2_uv must be non-empty (N, 2) arrays.")

  t_cw1 = np.linalg.inv(np.asarray(t_world_cam1, dtype=np.float64))
  t_cw2 = np.linalg.inv(np.asarray(t_world_cam2, dtype=np.float64))
  p1_mat = np.asarray(k1, dtype=np.float64) @ t_cw1[:3, :]
  p2_mat = np.asarray(k2, dtype=np.float64) @ t_cw2[:3, :]

  if cv2 is not None:
    hom_4d = cv2.triangulatePoints(p1_mat, p2_mat, uv1.T, uv2.T)
  else:
    cols = []
    for (u1_i, v1_i), (u2_i, v2_i) in zip(uv1, uv2):
      a_dlt = np.vstack([
          u1_i * p1_mat[2] - p1_mat[0],
          v1_i * p1_mat[2] - p1_mat[1],
          u2_i * p2_mat[2] - p2_mat[0],
          v2_i * p2_mat[2] - p2_mat[1],
      ])
      _, _, vh = np.linalg.svd(a_dlt)
      cols.append(vh[-1])
    hom_4d = np.column_stack(cols)
  valid_w = np.abs(hom_4d[3]) > 1e-12
  pts_3d = (hom_4d[:3, valid_w] / hom_4d[3, valid_w]).T
  uv1 = uv1[valid_w]
  uv2 = uv2[valid_w]
  if pts_3d.shape[0] == 0:
    raise RuntimeError("No finite 3D points recovered from triangulation.")

  pts_hom = np.column_stack(
      [pts_3d, np.ones(pts_3d.shape[0], dtype=np.float64)]
  )
  c1 = (t_cw1 @ pts_hom.T)[:3].T
  c2 = (t_cw2 @ pts_hom.T)[:3].T
  proj1 = (p1_mat @ pts_hom.T).T
  proj2 = (p2_mat @ pts_hom.T).T
  err1 = np.linalg.norm((proj1[:, :2] / proj1[:, 2:3]) - uv1, axis=1)
  err2 = np.linalg.norm((proj2[:, :2] / proj2[:, 2:3]) - uv2, axis=1)

  inliers = (
      (c1[:, 2] > 0.0)
      & (c2[:, 2] > 0.0)
      & (err1 <= float(max_reproj_err_px))
      & (err2 <= float(max_reproj_err_px))
  )
  if not np.any(inliers):
    raise RuntimeError(
        f"0/{pts_3d.shape[0]} triangulated points met reproj <="
        f" {max_reproj_err_px} px."
    )
  good_3d = pts_3d[inliers]
  center_3d = np.median(good_3d, axis=0)

  major_3d: np.ndarray | None = None
  anisotropy = 1.0
  if good_3d.shape[0] >= 3:
    centered = good_3d - np.mean(good_3d, axis=0, keepdims=True)
    cov = (centered.T @ centered) / (good_3d.shape[0] - 1)
    eigvals, eigvecs = np.linalg.eigh(cov)
    major_3d = eigvecs[:, 2]
    anisotropy = float(max(eigvals[2], 0.0) / max(eigvals[1], 1e-12))

  return {
      "center_3d_m": center_3d,
      "inliers_3d_m": good_3d,
      "major_axis_3d": major_3d,
      "anisotropy": anisotropy,
      "num_inliers": int(good_3d.shape[0]),
  }
