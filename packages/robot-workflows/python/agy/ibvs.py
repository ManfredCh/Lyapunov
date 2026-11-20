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
"""Robot-agnostic Image-Based Visual Servoing (IBVS) and ray-plane geometry."""

from collections.abc import Sequence
from typing import Any
import numpy as np

try:
  import cv2
except ImportError:
  cv2 = None


def _canonicalize_axis(
    axis_2d: np.ndarray, prev_angle_rad: float | None = None
) -> tuple[np.ndarray, float]:
  """Resolves +-pi eigenvector sign ambiguity deterministically or continuously."""
  vec = np.asarray(axis_2d, dtype=np.float64)[:2].copy()
  norm = float(np.linalg.norm(vec))
  if norm < 1e-12:
    vec = np.array([1.0, 0.0], dtype=np.float64)
  else:
    vec /= norm
  if prev_angle_rad is not None:
    ref = np.array(
        [np.cos(float(prev_angle_rad)), np.sin(float(prev_angle_rad))],
        dtype=np.float64,
    )
    if float(np.dot(vec, ref)) < 0.0:
      vec = -vec
  elif vec[0] < -1e-9 or (abs(float(vec[0])) <= 1e-9 and vec[1] < 0.0):
    vec = -vec
  return vec, float(np.arctan2(vec[1], vec[0]))


def _extract_contour_points(
    mask_u8: np.ndarray,
    min_area_px: float = 100.0,
    min_aspect: float = 1.0,
    roi_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, float, float, bool] | None:
  """Selects the largest foreground contour satisfying area and aspect bounds.

  Returns:
    `(points_uv, area_px, aspect, is_ordered_contour)` or None. With OpenCV,
    `points_uv` is the ordered outer contour. Without OpenCV, it is every
    foreground pixel in raster order (`is_ordered_contour=False`), so callers
    must not treat consecutive points as contour neighbors.
  """
  work = (np.asarray(mask_u8) > 0).astype(np.uint8) * 255
  if roi_mask is not None:
    roi = np.asarray(roi_mask) > 0
    if roi.shape != work.shape[:2]:
      raise ValueError(
          f"roi_mask shape {roi.shape} must match mask shape {work.shape[:2]}."
      )
    work = np.where(roi, work, np.uint8(0))

  if cv2 is not None:
    contours, _ = cv2.findContours(
        work, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
    )
    best: tuple[float, float, np.ndarray] | None = None
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
    return best[2], best[0], best[1], True

  ys, xs = np.where(work > 0)
  area_val = float(xs.shape[0])
  if area_val < min_area_px:
    return None
  pts = np.column_stack([xs, ys]).astype(np.float64)
  centered = pts - np.mean(pts, axis=0, keepdims=True)
  cov = (centered.T @ centered) / max(1, pts.shape[0] - 1)
  eigvals = np.maximum(np.linalg.eigvalsh(cov), 1e-12)
  aspect_est = float(np.sqrt(eigvals[1] / eigvals[0]))
  if aspect_est < min_aspect:
    return None
  return pts, area_val, aspect_est, False


def _to_gray_u8(image: np.ndarray) -> np.ndarray:
  img = np.asarray(image)
  if img.ndim == 3:
    img = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
  if img.dtype != np.uint8:
    img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
  return img


def _feature_detector(detector: str) -> tuple[Any, int]:
  """Returns a CPU OpenCV feature detector and its descriptor norm."""
  name = detector.lower()
  if name == "sift":
    return cv2.SIFT_create(nfeatures=2000), cv2.NORM_L2
  if name == "orb":
    return cv2.ORB_create(nfeatures=3000), cv2.NORM_HAMMING
  raise ValueError(f"detector must be 'sift' or 'orb'; got {detector!r}.")


def match_keypoints(
    image_cur: np.ndarray,
    image_goal: np.ndarray,
    detector: str = "sift",
    ratio: float = 0.75,
    ransac_reproj_px: float = 3.0,
    min_inliers: int = 8,
    max_matches: int = 60,
    mask_cur: np.ndarray | None = None,
    mask_goal: np.ndarray | None = None,
) -> dict[str, Any] | None:
  """Matches keypoints between current and goal images on CPU (OpenCV).

  Detects SIFT (default, more robust) or ORB (faster) features, keeps matches
  that pass Lowe's ratio test, and rejects outliers with a RANSAC homography
  (best for a planar or compact target seen from a distance). The returned
  pixel pairs are ready for
  `Ibvs.compute_step(u_px, v_px, z, u_goal_px, v_goal_px, ...)`.

  Args:
    image_cur: Current camera image (RGB or grayscale).
    image_goal: Goal (reference) image taken at the desired pose.
    detector: `"sift"` or `"orb"`.
    ratio: Lowe ratio-test threshold.
    ransac_reproj_px: RANSAC inlier threshold in pixels.
    min_inliers: Minimum RANSAC inliers; fewer returns None.
    max_matches: Keep at most this many inliers (lowest descriptor distance).
    mask_cur: Optional uint8 mask; detect only where nonzero (e.g. the target,
      excluding gripper fingers).
    mask_goal: Optional uint8 mask for the goal image.

  Returns:
    Dict with `u_px`, `v_px`, `u_goal_px`, `v_goal_px` (inlier arrays),
    `num_inliers`, `num_ratio_matches`, and `homography_cur_from_goal`, or None
    when there are too few reliable matches (re-detect the target instead).

  Raises:
    RuntimeError: If OpenCV is not installed.
  """
  if cv2 is None:
    raise RuntimeError("match_keypoints requires opencv-python.")
  feat, norm = _feature_detector(detector)
  kp_c, des_c = feat.detectAndCompute(_to_gray_u8(image_cur), mask_cur)
  kp_g, des_g = feat.detectAndCompute(_to_gray_u8(image_goal), mask_goal)
  if des_c is None or des_g is None or len(kp_c) < 2 or len(kp_g) < 2:
    return None

  knn = cv2.BFMatcher(norm).knnMatch(des_c, des_g, k=2)
  good = [
      pair[0]
      for pair in knn
      if len(pair) == 2 and pair[0].distance < ratio * pair[1].distance
  ]
  if len(good) < max(4, int(min_inliers)):
    return None

  pts_c = np.float32([kp_c[m.queryIdx].pt for m in good])
  pts_g = np.float32([kp_g[m.trainIdx].pt for m in good])
  h_cg, inlier_mask = cv2.findHomography(
      pts_g, pts_c, cv2.RANSAC, float(ransac_reproj_px)
  )
  if h_cg is None or inlier_mask is None:
    return None
  inliers = np.flatnonzero(inlier_mask.ravel())
  if inliers.size < int(min_inliers):
    return None
  inliers = inliers[np.argsort([good[i].distance for i in inliers])]
  inliers = inliers[: int(max_matches)]
  return {
      "u_px": pts_c[inliers, 0].astype(np.float64),
      "v_px": pts_c[inliers, 1].astype(np.float64),
      "u_goal_px": pts_g[inliers, 0].astype(np.float64),
      "v_goal_px": pts_g[inliers, 1].astype(np.float64),
      "num_inliers": int(np.count_nonzero(inlier_mask)),
      "num_ratio_matches": len(good),
      "homography_cur_from_goal": h_cg,
  }


class Ibvs:
  """Computes damped IBVS camera/EE twists and analytical hover-plane poses."""

  def __init__(
      self,
      fx_px: float,
      fy_px: float,
      cx_px: float,
      cy_px: float,
      gain: float = 0.6,
      damping: float = 1e-2,
      max_linear_vel_m_s: float = 0.08,
      max_angular_vel_rad_s: float = 0.35,
      convergence_tol_px: float = 2.0,
  ) -> None:
    self.fx_px = float(fx_px)
    self.fy_px = float(fy_px)
    self.cx_px = float(cx_px)
    self.cy_px = float(cy_px)
    self.gain = float(gain)
    self.damping = float(damping)
    self.max_linear_vel_m_s = float(max_linear_vel_m_s)
    self.max_angular_vel_rad_s = float(max_angular_vel_rad_s)
    self.convergence_tol_px = float(convergence_tol_px)

  def interaction_matrix(
      self,
      u_px: np.ndarray | Sequence[float] | float,
      v_px: np.ndarray | Sequence[float] | float,
      z_depth_m: np.ndarray | Sequence[float] | float,
  ) -> np.ndarray:
    """Builds the 2N x 6 point interaction matrix L_s for v_cam = [v, w]."""
    u_vec = np.asarray(u_px, dtype=np.float64).reshape(-1)
    v_vec = np.asarray(v_px, dtype=np.float64).reshape(-1)
    if u_vec.size == 0 or u_vec.shape != v_vec.shape:
      raise ValueError("u_px and v_px must be non-empty arrays of equal length.")
    z_arr = np.broadcast_to(
        np.asarray(z_depth_m, dtype=np.float64).reshape(-1), u_vec.shape
    )
    if not (
        np.all(np.isfinite(u_vec))
        and np.all(np.isfinite(v_vec))
        and np.all(np.isfinite(z_arr))
    ):
      raise ValueError("u_px, v_px, and z_depth_m must be finite.")

    x_norm = (u_vec - self.cx_px) / self.fx_px
    y_norm = (v_vec - self.cy_px) / self.fy_px
    z_safe = np.maximum(z_arr, 0.02)

    n_pts = x_norm.shape[0]
    l_mat = np.zeros((2 * n_pts, 6), dtype=np.float64)
    l_mat[0::2, 0] = -1.0 / z_safe
    l_mat[0::2, 2] = x_norm / z_safe
    l_mat[0::2, 3] = x_norm * y_norm
    l_mat[0::2, 4] = -(1.0 + x_norm**2)
    l_mat[0::2, 5] = y_norm

    l_mat[1::2, 1] = -1.0 / z_safe
    l_mat[1::2, 2] = y_norm / z_safe
    l_mat[1::2, 3] = 1.0 + y_norm**2
    l_mat[1::2, 4] = -x_norm * y_norm
    l_mat[1::2, 5] = -x_norm
    return l_mat

  @staticmethod
  def adjoint_se3(t_ee_cam: np.ndarray) -> np.ndarray:
    """Returns 6x6 SE(3) Adjoint for body twist order [vx, vy, vz, wx, wy, wz]."""
    t_mat = np.asarray(t_ee_cam, dtype=np.float64)
    r_ec = t_mat[:3, :3]
    px, py, pz = t_mat[:3, 3]
    p_skew = np.array(
        [[0.0, -pz, py], [pz, 0.0, -px], [-py, px, 0.0]], dtype=np.float64
    )
    adj = np.zeros((6, 6), dtype=np.float64)
    adj[:3, :3] = r_ec
    adj[:3, 3:] = p_skew @ r_ec
    adj[3:, 3:] = r_ec
    return adj

  @staticmethod
  def se3_exp(twist_body: np.ndarray, dt_s: float = 1.0) -> np.ndarray:
    """Maps a 6D body twist [v, w] * dt_s to a 4x4 SE(3) increment matrix."""
    xi = np.asarray(twist_body, dtype=np.float64) * float(dt_s)
    v_vec = xi[:3]
    w_vec = xi[3:]
    theta = float(np.linalg.norm(w_vec))
    t_inc = np.eye(4, dtype=np.float64)
    if theta < 1e-9:
      t_inc[:3, 3] = v_vec
      return t_inc

    wx, wy, wz = w_vec / theta
    k_skew = np.array(
        [[0.0, -wz, wy], [wz, 0.0, -wx], [-wy, wx, 0.0]], dtype=np.float64
    )
    s_th = np.sin(theta)
    c_th = np.cos(theta)
    r_inc = np.eye(3) + s_th * k_skew + (1.0 - c_th) * (k_skew @ k_skew)
    v_jac = (
        np.eye(3)
        + ((1.0 - c_th) / theta) * k_skew
        + ((theta - s_th) / theta) * (k_skew @ k_skew)
    )
    t_inc[:3, :3] = r_inc
    t_inc[:3, 3] = v_jac @ (v_vec / theta) * theta
    return t_inc

  @staticmethod
  def principal_ray_hover_distance(
      t_ee_cam: np.ndarray,
      approach_axis_ee: Sequence[float] | np.ndarray = (0.0, 0.0, 1.0),
  ) -> dict[str, float]:
    """Computes where the camera optical axis (+Z_cam) intersects approach_axis_ee.

    For any angled eye-in-hand camera mount T_ee_cam, returns the exact hover
    clearance h* along approach_axis_ee that projects directly onto the camera
    principal point (cx, cy).
    """
    t_mat = np.asarray(t_ee_cam, dtype=np.float64)
    p_ec = t_mat[:3, 3]
    d_cam = t_mat[:3, 2] / float(np.linalg.norm(t_mat[:3, 2]))
    a_raw = np.asarray(approach_axis_ee, dtype=np.float64)[:3]
    a_ee = a_raw / float(np.linalg.norm(a_raw))

    c_dot = float(np.dot(a_ee, d_cam))
    denom = 1.0 - c_dot * c_dot
    if denom < 1e-6:
      raise ValueError(
          "Camera optical axis is parallel to approach_axis_ee; choose any"
          " workspace hover clearance and use project_ee_point() for (u_goal,"
          " v_goal)."
      )
    a_p = float(np.dot(a_ee, p_ec))
    d_p = float(np.dot(d_cam, p_ec))
    h_star = (a_p - c_dot * d_p) / denom
    s_star = (c_dot * a_p - d_p) / denom
    if s_star <= 0.0:
      raise ValueError(
          f"Optical axis intersects approach_axis_ee behind camera (s*={s_star:.4f} m)."
      )
    gap = float(np.linalg.norm((p_ec + s_star * d_cam) - (h_star * a_ee)))
    return {
        "hover_distance_m": float(h_star),
        "cam_depth_m": float(s_star),
        "ray_axis_gap_m": gap,
    }

  def project_ee_point(
      self,
      p_ee: Sequence[float] | np.ndarray,
      t_ee_cam: np.ndarray,
  ) -> dict[str, float]:
    """Projects a 3D point in EE frame into pixel coordinates (u_px, v_px)."""
    p_hom = np.ones(4, dtype=np.float64)
    p_hom[:3] = np.asarray(p_ee, dtype=np.float64)[:3]
    p_cam = (np.linalg.inv(np.asarray(t_ee_cam, dtype=np.float64)) @ p_hom)[:3]
    if float(p_cam[2]) <= 1e-6:
      raise ValueError(
          f"EE point {p_hom[:3].tolist()} lies behind camera plane (z_cam={p_cam[2]:.4f} m)."
      )
    return {
        "u_px": float(self.cx_px + self.fx_px * p_cam[0] / p_cam[2]),
        "v_px": float(self.cy_px + self.fy_px * p_cam[1] / p_cam[2]),
        "z_cam_m": float(p_cam[2]),
    }

  @staticmethod
  def pca_contour_target(
      mask_u8: np.ndarray,
      min_area_px: float = 100.0,
      min_aspect: float = 1.0,
      roi_mask: np.ndarray | None = None,
      prev_theta_rad: float | None = None,
  ) -> dict[str, float] | None:
    """Extracts ROI-masked contour centroid (u_px, v_px), PCA axis & anisotropy."""
    extracted = _extract_contour_points(
        mask_u8,
        min_area_px=min_area_px,
        min_aspect=min_aspect,
        roi_mask=roi_mask,
    )
    if extracted is None:
      return None
    pts, area_val, aspect_val, _ = extracted

    u_mean = float(np.mean(pts[:, 0]))
    v_mean = float(np.mean(pts[:, 1]))
    centered = pts - np.array([[u_mean, v_mean]], dtype=np.float64)
    cov = (centered.T @ centered) / max(1, pts.shape[0] - 1)
    eigvals, eigvecs = np.linalg.eigh(cov)
    major, theta_rad = _canonicalize_axis(eigvecs[:, 1], prev_theta_rad)
    anisotropy = float(max(eigvals[1], 0.0) / max(eigvals[0], 1e-12))
    return {
        "u_px": u_mean,
        "v_px": v_mean,
        "vx_px": float(major[0]),
        "vy_px": float(major[1]),
        "theta_img_rad": theta_rad,
        "anisotropy": anisotropy,
        "area_px": area_val,
        "aspect": aspect_val,
    }

  @staticmethod
  def ray_plane_xy_and_yaw(
      u_px: float,
      v_px: float,
      vx_px: float,
      vy_px: float,
      fx_px: float,
      fy_px: float,
      cx_px: float,
      cy_px: float,
      t_world_cam: np.ndarray,
      z_plane_m: float,
      prev_yaw_rad: float | None = None,
  ) -> dict[str, float]:
    """Projects image point & tangent direction analytically onto z = z_plane_m."""
    t_wc = np.asarray(t_world_cam, dtype=np.float64)
    p_cam = t_wc[:3, 3]
    r_cam = t_wc[:3, :3]

    ray_c = np.array(
        [
            (float(u_px) - float(cx_px)) / float(fx_px),
            (float(v_px) - float(cy_px)) / float(fy_px),
            1.0,
        ],
        dtype=np.float64,
    )
    ray_w = r_cam @ ray_c
    if abs(float(ray_w[2])) < 1e-9:
      raise ValueError("Camera ray is parallel to horizontal target plane.")
    s0 = (float(z_plane_m) - float(p_cam[2])) / float(ray_w[2])
    if s0 <= 0.0:
      raise ValueError(
          f"Ray intersects z={z_plane_m:.4f} m behind camera (s={s0:.4f})."
      )
    p0 = p_cam + s0 * ray_w

    d_ray_c = np.array(
        [float(vx_px) / float(fx_px), float(vy_px) / float(fy_px), 0.0],
        dtype=np.float64,
    )
    d_ray_w = r_cam @ d_ray_c
    dp_w = s0 * (d_ray_w - (float(d_ray_w[2]) / float(ray_w[2])) * ray_w)
    _, yaw_rad = _canonicalize_axis(dp_w[:2], prev_yaw_rad)
    return {
        "x_m": float(p0[0]),
        "y_m": float(p0[1]),
        "z_m": float(z_plane_m),
        "yaw_rad": yaw_rad,
    }

  @staticmethod
  def ray_plane_contour_pose(
      mask_u8: np.ndarray,
      fx_px: float,
      fy_px: float,
      cx_px: float,
      cy_px: float,
      t_world_cam: np.ndarray,
      z_plane_m: float,
      min_area_px: float = 100.0,
      min_aspect: float = 1.0,
      roi_mask: np.ndarray | None = None,
      prev_yaw_rad: float | None = None,
  ) -> dict[str, float] | None:
    """Back-projects contour onto z = z_plane_m for perspective-free 3D OBB pose.

    Eliminates the 2D pixel-centroid foreshortening bias of tilted cameras by
    computing arc-length-weighted 3D PCA and oriented bounding-box center on the
    target plane in metric world coordinates. Without OpenCV, every foreground
    pixel is used instead, weighted by the plane area it covers.
    """
    extracted = _extract_contour_points(
        mask_u8,
        min_area_px=min_area_px,
        min_aspect=min_aspect,
        roi_mask=roi_mask,
    )
    if extracted is None:
      return None
    pts_uv, _, aspect_val, is_ordered_contour = extracted

    t_wc = np.asarray(t_world_cam, dtype=np.float64)
    p_cam = t_wc[:3, 3]
    r_cam = t_wc[:3, :3]

    def _to_plane(uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
      """Intersects pixel rays with z = z_plane_m; returns (xy_w, valid)."""
      rays_c = np.column_stack([
          (uv[:, 0] - float(cx_px)) / float(fx_px),
          (uv[:, 1] - float(cy_px)) / float(fy_px),
          np.ones(uv.shape[0], dtype=np.float64),
      ])
      rays_w = rays_c @ r_cam.T
      non_parallel = np.abs(rays_w[:, 2]) > 1e-6
      s = np.full(uv.shape[0], -1.0, dtype=np.float64)
      s[non_parallel] = (float(z_plane_m) - float(p_cam[2])) / rays_w[
          non_parallel, 2
      ]
      return p_cam[:2] + s[:, None] * rays_w[:, :2], s > 0.0

    xy_w, valid = _to_plane(pts_uv)
    if is_ordered_contour:
      if np.count_nonzero(valid) < 4:
        return None
      xy_w = xy_w[valid]
      # Arc-length weights prevent near-camera dense pixels from biasing tilted
      # views.
      seg_next = np.linalg.norm(np.roll(xy_w, -1, axis=0) - xy_w, axis=1)
      seg_prev = np.linalg.norm(xy_w - np.roll(xy_w, 1, axis=0), axis=1)
      weights = 0.5 * (seg_next + seg_prev)
    else:
      # Unordered foreground pixels (no OpenCV): weight each pixel by the plane
      # area it covers, so near-camera pixels do not dominate tilted views.
      xy_du, valid_du = _to_plane(pts_uv + np.array([1.0, 0.0]))
      xy_dv, valid_dv = _to_plane(pts_uv + np.array([0.0, 1.0]))
      valid &= valid_du & valid_dv
      if np.count_nonzero(valid) < 4:
        return None
      d_u = xy_du[valid] - xy_w[valid]
      d_v = xy_dv[valid] - xy_w[valid]
      weights = np.abs(d_u[:, 0] * d_v[:, 1] - d_u[:, 1] * d_v[:, 0])
      xy_w = xy_w[valid]
    w_sum = float(np.sum(weights))
    if w_sum <= 1e-12:
      weights = np.ones(xy_w.shape[0], dtype=np.float64)
      w_sum = float(xy_w.shape[0])
    w_norm = weights / w_sum

    mean_xy = np.sum(xy_w * w_norm[:, None], axis=0)
    centered = xy_w - mean_xy
    cov = (centered * w_norm[:, None]).T @ centered
    eigvals, eigvecs = np.linalg.eigh(cov)
    major, yaw_rad = _canonicalize_axis(eigvecs[:, 1], prev_yaw_rad)
    minor = np.array([-major[1], major[0]], dtype=np.float64)
    anisotropy = float(max(eigvals[1], 0.0) / max(eigvals[0], 1e-12))

    proj_major = centered @ major
    proj_minor = centered @ minor
    obb_xy = (
        mean_xy
        + 0.5 * (float(proj_major.min()) + float(proj_major.max())) * major
        + 0.5 * (float(proj_minor.min()) + float(proj_minor.max())) * minor
    )

    p_center_c = (
        np.linalg.inv(t_wc)
        @ np.array([obb_xy[0], obb_xy[1], float(z_plane_m), 1.0], dtype=np.float64)
    )[:3]
    if float(p_center_c[2]) <= 1e-6:
      return None
    u_center = float(cx_px) + float(fx_px) * float(p_center_c[0] / p_center_c[2])
    v_center = float(cy_px) + float(fy_px) * float(p_center_c[1] / p_center_c[2])
    return {
        "x_m": float(obb_xy[0]),
        "y_m": float(obb_xy[1]),
        "z_m": float(z_plane_m),
        "yaw_rad": yaw_rad,
        "anisotropy": anisotropy,
        "length_m": float(proj_major.max() - proj_major.min()),
        "width_m": float(proj_minor.max() - proj_minor.min()),
        "u_px": u_center,
        "v_px": v_center,
        "aspect": aspect_val,
    }

  def compute_step(
      self,
      u_px: np.ndarray | Sequence[float] | float,
      v_px: np.ndarray | Sequence[float] | float,
      z_depth_m: np.ndarray | Sequence[float] | float,
      u_goal_px: np.ndarray | Sequence[float] | float,
      v_goal_px: np.ndarray | Sequence[float] | float,
      t_ee_cam: np.ndarray,
  ) -> dict[str, Any]:
    """Computes damped, screw-preserving camera and EE body twists [v, w]."""
    u_cur = np.asarray(u_px, dtype=np.float64).reshape(-1)
    v_cur = np.asarray(v_px, dtype=np.float64).reshape(-1)
    u_ref = np.asarray(u_goal_px, dtype=np.float64).reshape(-1)
    v_ref = np.asarray(v_goal_px, dtype=np.float64).reshape(-1)
    if u_cur.size == 0 or not (
        u_cur.shape == v_cur.shape == u_ref.shape == v_ref.shape
    ):
      raise ValueError(
          "u_px, v_px, u_goal_px, and v_goal_px must have identical non-zero shape."
      )

    du_px = u_cur - u_ref
    dv_px = v_cur - v_ref
    pixel_error_rms_px = float(np.sqrt(np.mean(du_px**2 + dv_px**2)))

    err_norm = np.empty(2 * u_cur.shape[0], dtype=np.float64)
    err_norm[0::2] = du_px / self.fx_px
    err_norm[1::2] = dv_px / self.fy_px

    l_mat = self.interaction_matrix(u_cur, v_cur, z_depth_m)
    lhs = l_mat.T @ l_mat + (self.damping**2) * np.eye(6, dtype=np.float64)
    v_cam = -self.gain * np.linalg.solve(lhs, l_mat.T @ err_norm)
    v_ee = self.adjoint_se3(t_ee_cam) @ v_cam

    # Scale uniformly across camera & EE limits so the SE(3) screw axis is preserved
    scale = 1.0
    for norm_val, limit_val in (
        (float(np.linalg.norm(v_cam[:3])), self.max_linear_vel_m_s),
        (float(np.linalg.norm(v_cam[3:])), self.max_angular_vel_rad_s),
        (float(np.linalg.norm(v_ee[:3])), self.max_linear_vel_m_s),
        (float(np.linalg.norm(v_ee[3:])), self.max_angular_vel_rad_s),
    ):
      if norm_val > limit_val > 0.0:
        scale = min(scale, limit_val / norm_val)
    if scale < 1.0:
      v_cam = v_cam * scale
      v_ee = v_ee * scale

    return {
        "v_cam": v_cam,
        "v_ee": v_ee,
        "pixel_error_rms_px": pixel_error_rms_px,
        "converged": bool(
            np.median(np.hypot(du_px, dv_px)) < self.convergence_tol_px
        ),
    }
