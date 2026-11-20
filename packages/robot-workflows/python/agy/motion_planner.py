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
"""Embodiment- and task-agnostic motion planning, diagnostics, and overlay tool.

Bridges MuJoCo robot kinematics (`MjModel`) with a vectorized pure-NumPy
adaptive Bi-RRT-Connect motion planner and path simplifier so an agent can:
1. Introspect any single-arm or multi-arm MJCF (`describe_robot`,
   `gripper_frame_info`) without reading raw XMLs.
2. Author and iterate on 3D scene (`Scene3D`) and object (`MultiSphereObject`)
   geometry builders using low-level primitives.
3. Visually verify modeled 3D geometry by projecting wireframes/spheres onto
   camera images (`render_scene_overlay`).
4. Check goal poses, grasps, and segments with named collision and clearance
   diagnostics (`check_se3_pose`, `check_arm_config`, `check_arm_segment`).
5. Plan collision-free 6-DoF object paths (`plan_object_se3`), straight-line
   Cartesian contact strokes (`plan_cartesian_stroke`), and coupled arm +
   held-object joint trajectories (`plan_arm`) resampled at `control_dt_s`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
import dataclasses
import math
import os
import re
import time
from typing import Any

import mujoco
import numpy as np
from PIL import Image
from PIL import ImageDraw


# ---------------------------------------------------------------------------
# 1. SE(3) & Rotation Conversions
# ---------------------------------------------------------------------------


def rpy_to_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
  """Returns 3x3 rotation matrix R = Rz(yaw) @ Ry(pitch) @ Rx(roll)."""
  cr, sr = math.cos(roll), math.sin(roll)
  cp, sp = math.cos(pitch), math.sin(pitch)
  cy, sy = math.cos(yaw), math.sin(yaw)
  return np.array(
      [
          [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
          [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
          [-sp, cp * sr, cp * cr],
      ],
      dtype=np.float64,
  )


def matrix_to_rpy(rot: np.ndarray) -> np.ndarray:
  """Extracts [roll, pitch, yaw] matching rpy_to_matrix(roll, pitch, yaw)."""
  r = np.asarray(rot, dtype=np.float64).reshape(3, 3)
  sp = float(np.clip(-r[2, 0], -1.0, 1.0))
  pitch = math.asin(sp)
  cp = math.cos(pitch)
  if abs(cp) > 1e-8:
    roll = math.atan2(float(r[2, 1]), float(r[2, 2]))
    yaw = math.atan2(float(r[1, 0]), float(r[0, 0]))
  else:
    roll = 0.0
    yaw = math.atan2(float(-r[0, 1]), float(r[1, 1]))
  return np.array([roll, pitch, yaw], dtype=np.float64)


def quat_wxyz_to_matrix(quat_wxyz: Sequence[float] | np.ndarray) -> np.ndarray:
  """Converts a [w, x, y, z] quaternion to a 3x3 rotation matrix."""
  q = np.asarray(quat_wxyz, dtype=np.float64).reshape(4)
  n = float(np.linalg.norm(q))
  if n < 1e-12:
    return np.eye(3, dtype=np.float64)
  q = q / n
  mat = np.zeros(9, dtype=np.float64)
  mujoco.mju_quat2Mat(mat, q)
  return mat.reshape(3, 3)


def _slerp_rotation(
    r_start: np.ndarray, r_goal: np.ndarray, alpha: float
) -> np.ndarray:
  """Interpolates from `r_start` to `r_goal` along SO(3) geodesic at `alpha`."""
  t = float(np.clip(alpha, 0.0, 1.0))
  if t <= 0.0:
    return r_start.copy()
  if t >= 1.0:
    return r_goal.copy()
  r_rel = r_start.T @ r_goal
  q_rel = np.zeros(4, dtype=np.float64)
  mujoco.mju_mat2Quat(q_rel, r_rel.reshape(9))
  if q_rel[0] < 0.0:
    q_rel = -q_rel
  sin_half = float(np.linalg.norm(q_rel[1:]))
  if sin_half < 1e-10:
    return r_start.copy()
  axis = q_rel[1:] / sin_half
  angle = 2.0 * math.atan2(sin_half, float(q_rel[0]))
  half_t = 0.5 * t * angle
  q_step = np.array(
      [
          math.cos(half_t),
          math.sin(half_t) * float(axis[0]),
          math.sin(half_t) * float(axis[1]),
          math.sin(half_t) * float(axis[2]),
      ],
      dtype=np.float64,
  )
  return r_start @ quat_wxyz_to_matrix(q_step)


def pose6d_from_pos_rot(
    pos: Sequence[float] | np.ndarray,
    rot: Sequence[Sequence[float]] | np.ndarray | None = None,
) -> np.ndarray:
  """Packs (pos_3d, rot_3x3) into 6D SE(3) vector [x, y, z, yaw, pitch, roll]."""
  p = np.asarray(pos, dtype=np.float64).reshape(3)
  if rot is None:
    return np.array([p[0], p[1], p[2], 0.0, 0.0, 0.0], dtype=np.float64)
  rpy = matrix_to_rpy(np.asarray(rot, dtype=np.float64).reshape(3, 3))
  return np.array([p[0], p[1], p[2], rpy[2], rpy[1], rpy[0]], dtype=np.float64)


def pos_rot_from_pose6d(
    pose6d: Sequence[float] | np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
  """Unpacks 6D SE(3) vector [x, y, z, yaw, pitch, roll] -> (pos, rot)."""
  q = np.asarray(pose6d, dtype=np.float64).reshape(6)
  pos = q[:3].copy()
  rot = rpy_to_matrix(float(q[5]), float(q[4]), float(q[3]))
  return pos, rot


def make_transform(
    pos: Sequence[float] | np.ndarray,
    rot: Sequence[Sequence[float]] | np.ndarray | None = None,
) -> np.ndarray:
  """Builds a 4x4 homogeneous transform matrix from (pos, rot)."""
  tf = np.eye(4, dtype=np.float64)
  tf[:3, 3] = np.asarray(pos, dtype=np.float64).reshape(3)
  if rot is not None:
    tf[:3, :3] = np.asarray(rot, dtype=np.float64).reshape(3, 3)
  return tf


def invert_transform(tf: np.ndarray) -> np.ndarray:
  """Inverts a 4x4 rigid homogeneous transform matrix."""
  t = np.asarray(tf, dtype=np.float64).reshape(4, 4)
  r_inv = t[:3, :3].T
  out = np.eye(4, dtype=np.float64)
  out[:3, :3] = r_inv
  out[:3, 3] = -(r_inv @ t[:3, 3])
  return out


# ---------------------------------------------------------------------------
# 2. Scene3D & Signed-Distance Primitives
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ObstaclePrimitive:
  """Metadata mirror for a single primitive obstacle in Scene3D."""

  name: str
  kind: str  # 'sphere' | 'box' | 'capsule' | 'cylinder'
  center: np.ndarray
  radius: float = 0.0
  half_extents: np.ndarray | None = None
  rotation: np.ndarray | None = None
  point_a: np.ndarray | None = None
  point_b: np.ndarray | None = None
  half_height: float = 0.0
  group: str = ""


def _signed_distance_sphere_to_primitive(
    center: np.ndarray, radius: float, prim: ObstaclePrimitive
) -> float:
  """Returns exact signed distance (m) between sphere (center, radius) and prim.

  Negative values indicate penetration (`penetration_m = -dist`).
  """
  if prim.kind == "sphere":
    return float(np.linalg.norm(center - prim.center)) - (radius + prim.radius)

  if prim.kind == "box":
    assert prim.half_extents is not None
    he = prim.half_extents
    delta = center - prim.center
    local = prim.rotation.T @ delta if prim.rotation is not None else delta
    abs_local = np.abs(local)
    outside = np.maximum(0.0, abs_local - he)
    outside_norm = float(np.linalg.norm(outside))
    if outside_norm > 0.0:
      return outside_norm - radius
    inside_depth = float(np.min(he - abs_local))
    return -inside_depth - radius

  if prim.kind == "capsule":
    assert prim.point_a is not None and prim.point_b is not None
    ab = prim.point_b - prim.point_a
    ab_len_sq = float(np.dot(ab, ab))
    t = 0.0
    if ab_len_sq > 1e-15:
      t = float(
          np.clip(np.dot(center - prim.point_a, ab) / ab_len_sq, 0.0, 1.0)
      )
    closest = prim.point_a + t * ab
    return float(np.linalg.norm(center - closest)) - (radius + prim.radius)

  if prim.kind == "cylinder":
    dx = float(center[0] - prim.center[0])
    dy = float(center[1] - prim.center[1])
    r_xy = math.hypot(dx, dy)
    dr = r_xy - prim.radius
    dz = abs(float(center[2] - prim.center[2])) - prim.half_height
    if dr <= 0.0 and dz <= 0.0:
      return max(dr, dz) - radius
    return math.hypot(max(0.0, dr), max(0.0, dz)) - radius

  raise ValueError(f"Unsupported primitive kind: {prim.kind}")


class Scene3D:
  """Mutable 3D obstacle collection with vectorized signed-distance queries."""

  def __init__(self) -> None:
    self._primitives: list[ObstaclePrimitive] = []
    self._packed_cache: dict[str, Any] | None = None
    self._inflated_cache: dict[
        tuple[float, tuple[str, ...]], dict[str, Any]
    ] = {}

  def _invalidate(self) -> None:
    self._packed_cache = None
    self._inflated_cache.clear()

  def add_sphere(
      self,
      name: str,
      center: Sequence[float] | np.ndarray,
      radius: float,
      group: str = "",
  ) -> Scene3D:
    self._primitives.append(
        ObstaclePrimitive(
            name=str(name),
            kind="sphere",
            center=np.asarray(center, dtype=np.float64).reshape(3).copy(),
            radius=float(radius),
            group=group or str(name),
        )
    )
    self._invalidate()
    return self

  def add_aligned_box(
      self,
      name: str,
      center: Sequence[float] | np.ndarray,
      half_extents: Sequence[float] | np.ndarray,
      group: str = "",
  ) -> Scene3D:
    self._primitives.append(
        ObstaclePrimitive(
            name=str(name),
            kind="box",
            center=np.asarray(center, dtype=np.float64).reshape(3).copy(),
            half_extents=np.asarray(half_extents, dtype=np.float64)
            .reshape(3)
            .copy(),
            rotation=None,
            group=group or str(name),
        )
    )
    self._invalidate()
    return self

  def add_oriented_box(
      self,
      name: str,
      center: Sequence[float] | np.ndarray,
      half_extents: Sequence[float] | np.ndarray,
      rotation: Sequence[Sequence[float]] | np.ndarray,
      group: str = "",
  ) -> Scene3D:
    self._primitives.append(
        ObstaclePrimitive(
            name=str(name),
            kind="box",
            center=np.asarray(center, dtype=np.float64).reshape(3).copy(),
            half_extents=np.asarray(half_extents, dtype=np.float64)
            .reshape(3)
            .copy(),
            rotation=np.asarray(rotation, dtype=np.float64)
            .reshape(3, 3)
            .copy(),
            group=group or str(name),
        )
    )
    self._invalidate()
    return self

  def add_capsule(
      self,
      name: str,
      point_a: Sequence[float] | np.ndarray,
      point_b: Sequence[float] | np.ndarray,
      radius: float,
      group: str = "",
  ) -> Scene3D:
    pa = np.asarray(point_a, dtype=np.float64).reshape(3).copy()
    pb = np.asarray(point_b, dtype=np.float64).reshape(3).copy()
    self._primitives.append(
        ObstaclePrimitive(
            name=str(name),
            kind="capsule",
            center=0.5 * (pa + pb),
            radius=float(radius),
            point_a=pa,
            point_b=pb,
            group=group or str(name),
        )
    )
    self._invalidate()
    return self

  def add_vertical_cylinder(
      self,
      name: str,
      center: Sequence[float] | np.ndarray,
      radius: float,
      height: float,
      group: str = "",
  ) -> Scene3D:
    self._primitives.append(
        ObstaclePrimitive(
            name=str(name),
            kind="cylinder",
            center=np.asarray(center, dtype=np.float64).reshape(3).copy(),
            radius=float(radius),
            half_height=0.5 * max(0.0, float(height)),
            group=group or str(name),
        )
    )
    self._invalidate()
    return self

  def remove(self, name_or_prefix: str, prefix_match: bool = False) -> int:
    """Removes primitives matching `name_or_prefix` (or `group`).

    Returns count.
    """
    before = len(self._primitives)
    if prefix_match:
      self._primitives = [
          p
          for p in self._primitives
          if not (
              p.name.startswith(name_or_prefix)
              or p.group.startswith(name_or_prefix)
          )
      ]
    else:
      self._primitives = [
          p
          for p in self._primitives
          if p.name != name_or_prefix and p.group != name_or_prefix
      ]
    removed = before - len(self._primitives)
    if removed:
      self._invalidate()
    return removed

  def clone(self) -> Scene3D:
    out = Scene3D()
    out._primitives = list(self._primitives)
    return out

  def without(
      self, *names_or_groups: str, prefix_match: bool = False
  ) -> Scene3D:
    """Returns a cloned Scene3D with matching obstacle names/groups removed."""
    cloned = self.clone()
    for target in names_or_groups:
      cloned.remove(target, prefix_match=prefix_match)
    return cloned

  def add_object_spheres(
      self,
      obj: MultiSphereObject,
      pose6d: Sequence[float] | np.ndarray,
      name_prefix: str = "",
      group: str = "",
  ) -> Scene3D:
    """Registers `obj`'s spheres at `pose6d` as static obstacles in `group`."""
    grp = group or obj.name
    prefix = name_prefix or f"{grp}:"
    for label, center, radius in obj.world_spheres(pose6d):
      self.add_sphere(f"{prefix}{label}", center, radius, group=grp)
    return self

  @property
  def primitives(self) -> tuple[ObstaclePrimitive, ...]:
    return tuple(self._primitives)

  def names(self) -> list[str]:
    return [p.name for p in self._primitives]

  def _packed_inflated(
      self,
      inflation_m: float = 0.0,
      skip_inflation_groups: Sequence[str] = ("table",),
  ) -> dict[str, Any]:
    """Returns cached primitive arrays pre-inflated by `inflation_m`."""
    inf = max(0.0, float(inflation_m))
    key = (
        0.0 if inf <= 1e-12 else round(inf, 6),
        tuple(skip_inflation_groups) if inf > 1e-12 else (),
    )
    cached = self._inflated_cache.get(key)
    if cached is not None:
      return cached

    packed = self._packed_primitives()
    num_prims = int(packed["count"])
    if key[0] <= 1e-12 or num_prims == 0:
      out: dict[str, Any] = {
          "count": num_prims,
          "sp_c": packed.get("sp_c"),
          "sp_r": packed.get("sp_r"),
          "bx_c": packed.get("bx_c"),
          "bx_he": packed.get("bx_he"),
          "bx_rot": packed.get("bx_rot"),
          "cp_a": packed.get("cp_a"),
          "cp_ab": packed.get("cp_ab"),
          "cp_len_sq": packed.get("cp_len_sq"),
          "cp_r": packed.get("cp_r"),
          "cy_c": packed.get("cy_c"),
          "cy_r": packed.get("cy_r"),
          "cy_hh": packed.get("cy_hh"),
      }
    else:
      names: tuple[str, ...] = packed["names"]
      groups: tuple[str, ...] = packed["groups"]
      skip_set = set(skip_inflation_groups)
      prim_inf = np.array(
          [
              0.0 if (groups[j] in skip_set or names[j] in skip_set) else key[0]
              for j in range(num_prims)
          ],
          dtype=np.float64,
      )
      sp_idx = packed["sphere_idx"]
      bx_idx = packed["box_idx"]
      cp_idx = packed["cap_idx"]
      cy_idx = packed["cyl_idx"]
      out = {
          "count": num_prims,
          "sp_c": packed.get("sp_c"),
          "sp_r": packed["sp_r"] + prim_inf[sp_idx] if sp_idx.size else None,
          "bx_c": packed.get("bx_c"),
          "bx_he": (
              packed["bx_he"] + prim_inf[bx_idx][:, None]
              if bx_idx.size
              else None
          ),
          "bx_rot": packed.get("bx_rot"),
          "cp_a": packed.get("cp_a"),
          "cp_ab": packed.get("cp_ab"),
          "cp_len_sq": packed.get("cp_len_sq"),
          "cp_r": packed["cp_r"] + prim_inf[cp_idx] if cp_idx.size else None,
          "cy_c": packed.get("cy_c"),
          "cy_r": packed["cy_r"] + prim_inf[cy_idx] if cy_idx.size else None,
          "cy_hh": packed["cy_hh"] + prim_inf[cy_idx] if cy_idx.size else None,
      }

    # Precompute per-primitive and scene world AABBs for broadphase culling.
    if num_prims > 0:
      all_lo: list[np.ndarray] = []
      all_hi: list[np.ndarray] = []
      if out["sp_c"] is not None:
        sp_r_pos = np.maximum(0.0, out["sp_r"])[:, None]
        out["sp_lo"] = out["sp_c"] - sp_r_pos
        out["sp_hi"] = out["sp_c"] + sp_r_pos
        all_lo.append(out["sp_lo"])
        all_hi.append(out["sp_hi"])
      if out["bx_c"] is not None:
        bx_whe = np.einsum(
            "mij,mj->mi", np.abs(out["bx_rot"]), np.maximum(0.0, out["bx_he"])
        )
        out["bx_lo"] = out["bx_c"] - bx_whe
        out["bx_hi"] = out["bx_c"] + bx_whe
        all_lo.append(out["bx_lo"])
        all_hi.append(out["bx_hi"])
      if out["cp_a"] is not None:
        cp_b = out["cp_a"] + out["cp_ab"]
        cp_r_pos = np.maximum(0.0, out["cp_r"])[:, None]
        out["cp_lo"] = np.minimum(out["cp_a"], cp_b) - cp_r_pos
        out["cp_hi"] = np.maximum(out["cp_a"], cp_b) + cp_r_pos
        cp_lsq = out["cp_len_sq"]
        out["cp_inv_lsq"] = np.where(
            cp_lsq > 1e-15, 1.0 / np.maximum(cp_lsq, 1e-15), 0.0
        )
        all_lo.append(out["cp_lo"])
        all_hi.append(out["cp_hi"])
      if out["cy_c"] is not None:
        cy_ext = np.stack(
            [
                np.maximum(0.0, out["cy_r"]),
                np.maximum(0.0, out["cy_r"]),
                np.maximum(0.0, out["cy_hh"]),
            ],
            axis=-1,
        )
        out["cy_lo"] = out["cy_c"] - cy_ext
        out["cy_hi"] = out["cy_c"] + cy_ext
        all_lo.append(out["cy_lo"])
        all_hi.append(out["cy_hi"])
      out["env_lo"] = np.min(np.vstack(all_lo), axis=0)
      out["env_hi"] = np.max(np.vstack(all_hi), axis=0)

    self._inflated_cache[key] = out
    return out

  def _packed_primitives(self) -> dict[str, Any]:
    """Returns cached contiguous NumPy arrays grouped by primitive kind."""
    if self._packed_cache is not None:
      return self._packed_cache
    prims = self._primitives
    sphere_idx = [i for i, p in enumerate(prims) if p.kind == "sphere"]
    box_idx = [i for i, p in enumerate(prims) if p.kind == "box"]
    cap_idx = [i for i, p in enumerate(prims) if p.kind == "capsule"]
    cyl_idx = [i for i, p in enumerate(prims) if p.kind == "cylinder"]

    packed: dict[str, Any] = {
        "count": len(prims),
        "names": tuple(p.name for p in prims),
        "groups": tuple(p.group for p in prims),
        "sphere_idx": np.array(sphere_idx, dtype=np.int32),
        "box_idx": np.array(box_idx, dtype=np.int32),
        "cap_idx": np.array(cap_idx, dtype=np.int32),
        "cyl_idx": np.array(cyl_idx, dtype=np.int32),
    }
    if sphere_idx:
      sp_c = np.array([prims[i].center for i in sphere_idx], dtype=np.float64)
      packed["sp_c"] = sp_c
      packed["sp_norm_sq"] = np.einsum("mc,mc->m", sp_c, sp_c)
      packed["sp_r"] = np.array(
          [prims[i].radius for i in sphere_idx], dtype=np.float64
      )
    if box_idx:
      packed["bx_c"] = np.array(
          [prims[i].center for i in box_idx], dtype=np.float64
      )
      packed["bx_he"] = np.array(
          [prims[i].half_extents for i in box_idx], dtype=np.float64
      )
      packed["bx_rot"] = np.array(
          [
              prims[i].rotation
              if prims[i].rotation is not None
              else np.eye(3, dtype=np.float64)
              for i in box_idx
          ],
          dtype=np.float64,
      )
    if cap_idx:
      cp_a = np.array([prims[i].point_a for i in cap_idx], dtype=np.float64)
      cp_b = np.array([prims[i].point_b for i in cap_idx], dtype=np.float64)
      cp_ab = cp_b - cp_a
      packed["cp_a"] = cp_a
      packed["cp_ab"] = cp_ab
      packed["cp_len_sq"] = np.einsum("mc,mc->m", cp_ab, cp_ab)
      packed["cp_r"] = np.array(
          [prims[i].radius for i in cap_idx], dtype=np.float64
      )
    if cyl_idx:
      packed["cy_c"] = np.array(
          [prims[i].center for i in cyl_idx], dtype=np.float64
      )
      packed["cy_r"] = np.array(
          [prims[i].radius for i in cyl_idx], dtype=np.float64
      )
      packed["cy_hh"] = np.array(
          [prims[i].half_height for i in cyl_idx], dtype=np.float64
      )
    self._packed_cache = packed
    return packed


def _compute_sphere_scene_dist_matrix(
    s_centers: np.ndarray,
    s_radii: np.ndarray,
    scene: Scene3D,
    ignore_obstacles: Sequence[str] = (),
    inflation_m: float = 0.0,
    skip_inflation_groups: Sequence[str] = ("table",),
) -> tuple[np.ndarray | None, tuple[str, ...]]:
  """Computes `(num_spheres, num_prims)` signed-distance matrix vs `scene`."""
  packed = scene._packed_primitives()  # pylint: disable=protected-access
  num_spheres = int(s_centers.shape[0])
  num_prims = int(packed["count"])
  names: tuple[str, ...] = packed["names"]
  if num_spheres == 0 or num_prims == 0:
    return None, names

  groups: tuple[str, ...] = packed["groups"]
  ignore_set = set(ignore_obstacles)
  if ignore_set:
    valid_cols = np.array(
        [
            (names[j] not in ignore_set) and (groups[j] not in ignore_set)
            for j in range(num_prims)
        ],
        dtype=bool,
    )
    if not np.any(valid_cols):
      return None, names
  else:
    valid_cols = None

  inf = max(0.0, float(inflation_m))
  if inf > 1e-12:
    skip_set = set(skip_inflation_groups)
    prim_inf = np.array(
        [
            0.0 if (groups[j] in skip_set or names[j] in skip_set) else inf
            for j in range(num_prims)
        ],
        dtype=np.float64,
    )
  else:
    prim_inf = None

  dist_mat = np.empty((num_spheres, num_prims), dtype=np.float64)
  sp_idx = packed["sphere_idx"]
  if sp_idx.size:
    sp_c = packed["sp_c"]
    buf = np.empty((num_spheres, sp_c.shape[0]), dtype=np.float64)
    tmp = np.empty_like(buf)
    np.subtract(s_centers[:, 0:1], sp_c[None, :, 0], out=buf)
    np.multiply(buf, buf, out=buf)
    np.subtract(s_centers[:, 1:2], sp_c[None, :, 1], out=tmp)
    np.multiply(tmp, tmp, out=tmp)
    np.add(buf, tmp, out=buf)
    np.subtract(s_centers[:, 2:3], sp_c[None, :, 2], out=tmp)
    np.multiply(tmp, tmp, out=tmp)
    np.add(buf, tmp, out=buf)
    np.sqrt(buf, out=buf)
    np.subtract(buf, s_radii[:, None], out=buf)
    sp_r = (
        packed["sp_r"] + prim_inf[sp_idx]
        if prim_inf is not None
        else packed["sp_r"]
    )
    np.subtract(buf, sp_r[None, :], out=buf)
    dist_mat[:, sp_idx] = buf

  bx_idx = packed["box_idx"]
  if bx_idx.size:
    delta = s_centers[:, None, :] - packed["bx_c"][None, :, :]
    bx_rot = packed["bx_rot"]
    local = (
        delta[:, :, 0:1] * bx_rot[None, :, 0, :]
        + delta[:, :, 1:2] * bx_rot[None, :, 1, :]
        + delta[:, :, 2:3] * bx_rot[None, :, 2, :]
    )
    abs_local = np.abs(local)
    bx_he = (
        (packed["bx_he"] + prim_inf[bx_idx][:, None])[None, :, :]
        if prim_inf is not None
        else packed["bx_he"][None, :, :]
    )
    outside = np.maximum(0.0, abs_local - bx_he)
    outside_norm = np.sqrt(np.sum(outside * outside, axis=-1))
    inside_depth = np.min(bx_he - abs_local, axis=-1)
    surf = np.where(outside_norm > 0.0, outside_norm, -inside_depth)
    dist_mat[:, bx_idx] = surf - s_radii[:, None]

  cp_idx = packed["cap_idx"]
  if cp_idx.size:
    cp_a = packed["cp_a"]
    cp_ab = packed["cp_ab"]
    cp_len_sq = packed["cp_len_sq"]
    rel = s_centers[:, None, :] - cp_a[None, :, :]
    proj = (
        rel[:, :, 0] * cp_ab[None, :, 0]
        + rel[:, :, 1] * cp_ab[None, :, 1]
        + rel[:, :, 2] * cp_ab[None, :, 2]
    )
    safe_len_sq = np.where(cp_len_sq > 1e-15, cp_len_sq, 1.0)
    t_val = np.where(
        cp_len_sq[None, :] > 1e-15,
        np.clip(proj / safe_len_sq[None, :], 0.0, 1.0),
        0.0,
    )
    closest = cp_a[None, :, :] + t_val[:, :, None] * cp_ab[None, :, :]
    cdiff = s_centers[:, None, :] - closest
    cp_r = (
        packed["cp_r"] + prim_inf[cp_idx]
        if prim_inf is not None
        else packed["cp_r"]
    )
    dist_mat[:, cp_idx] = np.sqrt(np.sum(cdiff * cdiff, axis=-1)) - (
        s_radii[:, None] + cp_r[None, :]
    )

  cy_idx = packed["cyl_idx"]
  if cy_idx.size:
    delta = s_centers[:, None, :] - packed["cy_c"][None, :, :]
    r_xy = np.hypot(delta[:, :, 0], delta[:, :, 1])
    cy_r = (
        packed["cy_r"] + prim_inf[cy_idx]
        if prim_inf is not None
        else packed["cy_r"]
    )
    cy_hh = (
        packed["cy_hh"] + prim_inf[cy_idx]
        if prim_inf is not None
        else packed["cy_hh"]
    )
    dr = r_xy - cy_r[None, :]
    dz = np.abs(delta[:, :, 2]) - cy_hh[None, :]
    inside = (dr <= 0.0) & (dz <= 0.0)
    surf = np.where(
        inside,
        np.maximum(dr, dz),
        np.hypot(np.maximum(0.0, dr), np.maximum(0.0, dz)),
    )
    dist_mat[:, cy_idx] = surf - s_radii[:, None]

  if valid_cols is not None:
    dist_mat[:, ~valid_cols] = float("inf")
  return dist_mat, names


def _any_spheres_collide_with_scene(
    w_centers: np.ndarray,
    s_radii: np.ndarray,
    scene: Scene3D,
    inflation_m: float = 0.0,
    skip_inflation_groups: Sequence[str] = ("table",),
) -> bool:
  """Two-stage AABB-culled 2D batch collision check for `(S, 3)` or `(K, S, 3)` spheres."""
  if not s_radii.size:
    return False
  packed = scene._packed_inflated(  # pylint: disable=protected-access
      inflation_m=inflation_m,
      skip_inflation_groups=skip_inflation_groups,
  )
  if int(packed["count"]) == 0:
    return False

  if w_centers.ndim == 2:
    pts = w_centers
    r_pts = s_radii
  else:
    k_len, s_len, _ = w_centers.shape
    if k_len == 0:
      return False
    pts = w_centers.reshape(k_len * s_len, 3)
    r_pts = np.tile(s_radii, k_len) if k_len > 1 else s_radii

  max_sr = float(np.max(s_radii))
  u_lo = np.min(pts, axis=0) - max_sr
  u_hi = np.max(pts, axis=0) + max_sr
  env_lo = packed["env_lo"]
  env_hi = packed["env_hi"]
  if (
      u_hi[0] < env_lo[0]
      or u_lo[0] > env_hi[0]
      or u_hi[1] < env_lo[1]
      or u_lo[1] > env_hi[1]
      or u_hi[2] < env_lo[2]
      or u_lo[2] > env_hi[2]
  ):
    return False

  px = pts[:, 0]
  py = pts[:, 1]
  pz = pts[:, 2]
  p_lo_x = px - r_pts
  p_hi_x = px + r_pts
  p_lo_y = py - r_pts
  p_hi_y = py + r_pts
  p_lo_z = pz - r_pts
  p_hi_z = pz + r_pts

  sp_c = packed["sp_c"]
  if sp_c is not None:
    sp_lo = packed["sp_lo"]
    sp_hi = packed["sp_hi"]
    omask = (
        (sp_lo[:, 0] <= u_hi[0])
        & (sp_hi[:, 0] >= u_lo[0])
        & (sp_lo[:, 1] <= u_hi[1])
        & (sp_hi[:, 1] >= u_lo[1])
        & (sp_lo[:, 2] <= u_hi[2])
        & (sp_hi[:, 2] >= u_lo[2])
    )
    if np.any(omask):
      olo = np.min(sp_lo[omask], axis=0)
      ohi = np.max(sp_hi[omask], axis=0)
      pmask = (
          (p_hi_x >= olo[0])
          & (p_lo_x <= ohi[0])
          & (p_hi_y >= olo[1])
          & (p_lo_y <= ohi[1])
          & (p_hi_z >= olo[2])
          & (p_lo_z <= ohi[2])
      )
      if np.any(pmask):
        p_act = pts[pmask]
        rp_act = r_pts[pmask]
        c_m = sp_c[omask]
        r_m = packed["sp_r"][omask]
        buf = np.empty((p_act.shape[0], c_m.shape[0]), dtype=np.float64)
        tmp = np.empty_like(buf)
        np.subtract(p_act[:, 0:1], c_m[None, :, 0], out=buf)
        np.multiply(buf, buf, out=buf)
        np.subtract(p_act[:, 1:2], c_m[None, :, 1], out=tmp)
        np.multiply(tmp, tmp, out=tmp)
        np.add(buf, tmp, out=buf)
        np.subtract(p_act[:, 2:3], c_m[None, :, 2], out=tmp)
        np.multiply(tmp, tmp, out=tmp)
        np.add(buf, tmp, out=buf)
        thresh = rp_act[:, None] + r_m[None, :] - 1e-6
        if bool(np.any(buf < np.where(thresh > 0.0, thresh * thresh, -1.0))):
          return True

  cp_a = packed["cp_a"]
  if cp_a is not None:
    cp_lo = packed["cp_lo"]
    cp_hi = packed["cp_hi"]
    omask = (
        (cp_lo[:, 0] <= u_hi[0])
        & (cp_hi[:, 0] >= u_lo[0])
        & (cp_lo[:, 1] <= u_hi[1])
        & (cp_hi[:, 1] >= u_lo[1])
        & (cp_lo[:, 2] <= u_hi[2])
        & (cp_hi[:, 2] >= u_lo[2])
    )
    if np.any(omask):
      olo = np.min(cp_lo[omask], axis=0)
      ohi = np.max(cp_hi[omask], axis=0)
      pmask = (
          (p_hi_x >= olo[0])
          & (p_lo_x <= ohi[0])
          & (p_hi_y >= olo[1])
          & (p_lo_y <= ohi[1])
          & (p_hi_z >= olo[2])
          & (p_lo_z <= ohi[2])
      )
      if np.any(pmask):
        p_act = pts[pmask]
        rp_act = r_pts[pmask]
        a_m = cp_a[omask]
        ab_m = packed["cp_ab"][omask]
        inv_m = packed["cp_inv_lsq"][omask]
        r_m = packed["cp_r"][omask]
        rel = p_act[:, None, :] - a_m[None, :, :]
        proj = (
            rel[:, :, 0] * ab_m[None, :, 0]
            + rel[:, :, 1] * ab_m[None, :, 1]
            + rel[:, :, 2] * ab_m[None, :, 2]
        )
        t_val = np.clip(proj * inv_m[None, :], 0.0, 1.0)
        cdiff = rel - t_val[:, :, None] * ab_m[None, :, :]
        d2 = (
            cdiff[:, :, 0] * cdiff[:, :, 0]
            + cdiff[:, :, 1] * cdiff[:, :, 1]
            + cdiff[:, :, 2] * cdiff[:, :, 2]
        )
        thresh = rp_act[:, None] + r_m[None, :] - 1e-6
        if bool(np.any(d2 < np.where(thresh > 0.0, thresh * thresh, -1.0))):
          return True

  bx_c = packed["bx_c"]
  if bx_c is not None:
    bx_lo = packed["bx_lo"]
    bx_hi = packed["bx_hi"]
    omask = (
        (bx_lo[:, 0] <= u_hi[0])
        & (bx_hi[:, 0] >= u_lo[0])
        & (bx_lo[:, 1] <= u_hi[1])
        & (bx_hi[:, 1] >= u_lo[1])
        & (bx_lo[:, 2] <= u_hi[2])
        & (bx_hi[:, 2] >= u_lo[2])
    )
    if np.any(omask):
      bx_he_all = packed["bx_he"]
      bx_rot_all = packed["bx_rot"]
      for m_i in np.nonzero(omask)[0]:
        blo = bx_lo[m_i]
        bhi = bx_hi[m_i]
        pmask = (
            (p_hi_x >= blo[0])
            & (p_lo_x <= bhi[0])
            & (p_hi_y >= blo[1])
            & (p_lo_y <= bhi[1])
            & (p_hi_z >= blo[2])
            & (p_lo_z <= bhi[2])
        )
        if not np.any(pmask):
          continue
        delta = pts[pmask] - bx_c[m_i]
        r_mat = bx_rot_all[m_i]
        abs_local = np.abs(
            delta[:, 0:1] * r_mat[0:1, :]
            + delta[:, 1:2] * r_mat[1:2, :]
            + delta[:, 2:3] * r_mat[2:3, :]
        )
        he_i = bx_he_all[m_i]
        outside = np.maximum(0.0, abs_local - he_i)
        out_n = np.sqrt(
            outside[:, 0] * outside[:, 0]
            + outside[:, 1] * outside[:, 1]
            + outside[:, 2] * outside[:, 2]
        )
        inside_depth = np.min(he_i - abs_local, axis=-1)
        surf = np.where(out_n > 0.0, out_n, -inside_depth)
        if bool(np.any(surf - r_pts[pmask] < -1e-6)):
          return True

  cy_c = packed["cy_c"]
  if cy_c is not None:
    cy_lo = packed["cy_lo"]
    cy_hi = packed["cy_hi"]
    omask = (
        (cy_lo[:, 0] <= u_hi[0])
        & (cy_hi[:, 0] >= u_lo[0])
        & (cy_lo[:, 1] <= u_hi[1])
        & (cy_hi[:, 1] >= u_lo[1])
        & (cy_lo[:, 2] <= u_hi[2])
        & (cy_hi[:, 2] >= u_lo[2])
    )
    if np.any(omask):
      olo = np.min(cy_lo[omask], axis=0)
      ohi = np.max(cy_hi[omask], axis=0)
      pmask = (
          (p_hi_x >= olo[0])
          & (p_lo_x <= ohi[0])
          & (p_hi_y >= olo[1])
          & (p_lo_y <= ohi[1])
          & (p_hi_z >= olo[2])
          & (p_lo_z <= ohi[2])
      )
      if np.any(pmask):
        p_act = pts[pmask]
        rp_act = r_pts[pmask]
        c_m = cy_c[omask]
        cy_r = packed["cy_r"][omask][None, :]
        cy_hh = packed["cy_hh"][omask][None, :]
        delta = p_act[:, None, :] - c_m[None, :, :]
        r_xy = np.hypot(delta[:, :, 0], delta[:, :, 1])
        dr = r_xy - cy_r
        dz = np.abs(delta[:, :, 2]) - cy_hh
        inside = (dr <= 0.0) & (dz <= 0.0)
        surf = np.where(
            inside,
            np.maximum(dr, dz),
            np.hypot(np.maximum(0.0, dr), np.maximum(0.0, dz)),
        )
        if bool(np.any(surf - rp_act[:, None] < -1e-6)):
          return True

  return False


def _evaluate_sphere_arrays_against_scene(
    s_labels: Sequence[str],
    s_centers: np.ndarray,
    s_radii: np.ndarray,
    scene: Scene3D,
    ignore_obstacles: Sequence[str] = (),
    clearance_tol_m: float = 0.0,
) -> dict[str, Any]:
  """Vectorized signed-distance & collision evaluation of spheres vs `scene`."""
  dist_mat, names = _compute_sphere_scene_dist_matrix(
      s_centers, s_radii, scene, ignore_obstacles=ignore_obstacles
  )
  if dist_mat is None:
    return {
        "collisions": [],
        "min_clearance_m": None,
        "nearest_pair": None,
    }
  num_prims = int(dist_mat.shape[1])

  tol = max(1e-6, float(clearance_tol_m))
  flat_min = int(np.argmin(dist_mat))
  min_s, min_p = divmod(flat_min, num_prims)
  min_clearance = float(dist_mat[min_s, min_p])
  nearest_pair: dict[str, Any] | None = None
  min_clr_out: float | None = None
  if math.isfinite(min_clearance):
    min_clr_out = 0.0 + round(min_clearance, 5)
    nearest_pair = {
        "part": s_labels[min_s],
        "obstacle": names[min_p],
        "signed_distance_m": min_clr_out,
    }

  hit_s, hit_p = np.nonzero(dist_mat < -tol)
  dedup: dict[tuple[str, str], dict[str, Any]] = {}
  for idx_k in range(int(hit_s.size)):
    si = int(hit_s[idx_k])
    pi = int(hit_p[idx_k])
    pen = 0.0 + round(-float(dist_mat[si, pi]), 5)
    part_lbl = s_labels[si]
    obs_name = names[pi]
    key = (part_lbl, obs_name)
    prev = dedup.get(key)
    if prev is None or pen > prev["penetration_m"]:
      dedup[key] = {
          "part": part_lbl,
          "obstacle": obs_name,
          "penetration_m": pen,
      }
  sorted_collisions = sorted(
      dedup.values(), key=lambda x: -float(x["penetration_m"])
  )
  return {
      "collisions": sorted_collisions,
      "min_clearance_m": min_clr_out,
      "nearest_pair": nearest_pair,
  }


def _evaluate_spheres_against_scene(
    spheres: Sequence[tuple[str, np.ndarray, float]],
    scene: Scene3D,
    ignore_obstacles: Sequence[str] = (),
    clearance_tol_m: float = 0.0,
) -> dict[str, Any]:
  """Computes all collisions and minimum clearance between spheres and scene."""
  if not spheres:
    return {
        "collisions": [],
        "min_clearance_m": None,
        "nearest_pair": None,
    }
  s_labels = [s[0] for s in spheres]
  s_centers = np.array([s[1] for s in spheres], dtype=np.float64).reshape(-1, 3)
  s_radii = np.array([s[2] for s in spheres], dtype=np.float64).reshape(-1)
  return _evaluate_sphere_arrays_against_scene(
      s_labels,
      s_centers,
      s_radii,
      scene,
      ignore_obstacles=ignore_obstacles,
      clearance_tol_m=clearance_tol_m,
  )


# ---------------------------------------------------------------------------
# 3. MultiSphereObject (6-DoF SE(3) Object Model + Gripper Attachment Source)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class LocalSphereSpec:
  label: str
  center: np.ndarray
  radius: float


class MultiSphereObject:
  """6-DoF rigid object parameterized by `[x, y, z, yaw, pitch, roll]`."""

  def __init__(
      self,
      name: str = "object",
      lower_bounds: Sequence[float] | np.ndarray = (
          -0.65,
          -0.65,
          -0.50,
          -math.pi,
          -math.pi,
          -math.pi,
      ),
      upper_bounds: Sequence[float] | np.ndarray = (
          0.65,
          0.65,
          2.20,
          math.pi,
          math.pi,
          math.pi,
      ),
  ) -> None:
    self.name = str(name)
    self._lower = np.asarray(lower_bounds, dtype=np.float64).reshape(6).copy()
    self._upper = np.asarray(upper_bounds, dtype=np.float64).reshape(6).copy()
    self._spheres: list[LocalSphereSpec] = []

  def set_bounds(
      self,
      lower_bounds: Sequence[float] | np.ndarray,
      upper_bounds: Sequence[float] | np.ndarray,
  ) -> MultiSphereObject:
    self._lower = np.asarray(lower_bounds, dtype=np.float64).reshape(6).copy()
    self._upper = np.asarray(upper_bounds, dtype=np.float64).reshape(6).copy()
    return self

  def add_sphere(
      self,
      local_center: Sequence[float] | np.ndarray,
      radius: float,
      label: str = "",
  ) -> MultiSphereObject:
    lbl = label or f"{self.name}_s{len(self._spheres)}"
    self._spheres.append(
        LocalSphereSpec(
            label=lbl,
            center=np.asarray(local_center, dtype=np.float64).reshape(3).copy(),
            radius=float(radius),
        )
    )
    return self

  def add_capsule_spheres(
      self,
      p0: Sequence[float] | np.ndarray,
      p1: Sequence[float] | np.ndarray,
      radius: float,
      num_spheres: int = 5,
      label: str = "",
  ) -> MultiSphereObject:
    a = np.asarray(p0, dtype=np.float64).reshape(3)
    b = np.asarray(p1, dtype=np.float64).reshape(3)
    count = max(1, int(num_spheres))
    prefix = label or f"{self.name}_cap"
    for i in range(count):
      t = 0.5 if count == 1 else i / (count - 1)
      self.add_sphere((1.0 - t) * a + t * b, radius, label=f"{prefix}_{i}")
    return self

  @property
  def spheres(self) -> tuple[LocalSphereSpec, ...]:
    return tuple(self._spheres)

  @property
  def lower_bounds(self) -> np.ndarray:
    return self._lower.copy()

  @property
  def upper_bounds(self) -> np.ndarray:
    return self._upper.copy()

  def world_spheres(
      self, pose6d: Sequence[float] | np.ndarray
  ) -> list[tuple[str, np.ndarray, float]]:
    pos, rot = pos_rot_from_pose6d(pose6d)
    return [(s.label, pos + rot @ s.center, s.radius) for s in self._spheres]


def check_se3_pose(
    obj: MultiSphereObject,
    scene: Scene3D,
    pose6d: Sequence[float] | np.ndarray,
    ignore_obstacles: Sequence[str] = (),
    clearance_tol_m: float = 0.0,
) -> dict[str, Any]:
  """Checks 6-DoF object pose bounds & collisions with named diagnostics."""
  q = np.asarray(pose6d, dtype=np.float64).reshape(6)
  oob = [
      i
      for i in range(6)
      if q[i] < obj.lower_bounds[i] - 1e-5 or q[i] > obj.upper_bounds[i] + 1e-5
  ]
  diag = _evaluate_spheres_against_scene(
      obj.world_spheres(q),
      scene,
      ignore_obstacles=ignore_obstacles,
      clearance_tol_m=clearance_tol_m,
  )
  valid = (not oob) and (not diag["collisions"])
  return {
      "valid": valid,
      "out_of_bounds_dims": oob,
      **diag,
  }


def check_se3_segment(
    obj: MultiSphereObject,
    scene: Scene3D,
    pose_start: Sequence[float] | np.ndarray,
    pose_goal: Sequence[float] | np.ndarray,
    step_size: float = 0.015,
    ignore_obstacles: Sequence[str] = (),
    clearance_tol_m: float = 0.0,
) -> dict[str, Any]:
  """Checks linear SE(3) segment [pose_start, pose_goal] at `step_size`."""
  q0 = np.asarray(pose_start, dtype=np.float64).reshape(6)
  q1 = np.asarray(pose_goal, dtype=np.float64).reshape(6)
  dist = float(np.linalg.norm(q1 - q0))
  n_steps = max(1, int(math.ceil(dist / max(1e-4, step_size))))
  worst_clearance = float("inf")
  for idx in range(n_steps + 1):
    alpha = idx / n_steps
    q = (1.0 - alpha) * q0 + alpha * q1
    res = check_se3_pose(
        obj,
        scene,
        q,
        ignore_obstacles=ignore_obstacles,
        clearance_tol_m=clearance_tol_m,
    )
    if res["min_clearance_m"] is not None:
      worst_clearance = min(worst_clearance, float(res["min_clearance_m"]))
    if not res["valid"]:
      return {
          "valid": False,
          "failed_alpha": round(alpha, 4),
          "failed_pose": np.round(q, 5).tolist(),
          **res,
      }
  return {
      "valid": True,
      "num_checked_poses": n_steps + 1,
      "min_clearance_m": (
          0.0 + round(worst_clearance, 5)
          if math.isfinite(worst_clearance)
          else None
      ),
      "collisions": [],
  }


def _dedup_safety_margins(
    safety_margin_m: float, min_end_clr: float | None
) -> list[float]:
  """Builds deduplicated `(eff_margin, 0.5 * eff_margin, 0.0)` schedule."""
  req = max(0.0, float(safety_margin_m))
  if min_end_clr is None or not math.isfinite(min_end_clr):
    eff = req
  else:
    eff = min(req, 0.75 * max(0.0, float(min_end_clr) - 0.002))
  out: list[float] = []
  for cand in (eff, 0.5 * eff, 0.0):
    val = 0.0 if cand < 5e-4 else round(float(cand), 5)
    if all(abs(val - prev) > 1e-6 for prev in out):
      out.append(val)
  return out


def _min_optional_clearance(
    clr_a: float | None, clr_b: float | None
) -> float | None:
  """Returns minimum of two optional clearances (or whichever is non-None)."""
  if clr_a is not None and clr_b is not None:
    return min(float(clr_a), float(clr_b))
  if clr_a is not None:
    return float(clr_a)
  if clr_b is not None:
    return float(clr_b)
  return None


def _interpolate_waypoints_uniform(
    waypoints: np.ndarray, num_states: int = 40
) -> np.ndarray:
  """Uniformly arc-length interpolates `waypoints` to `num_states` rows."""
  wps = np.asarray(waypoints, dtype=np.float64)
  if wps.shape[0] <= 1 or num_states <= 1:
    return wps.copy()
  seg_lens = np.linalg.norm(np.diff(wps, axis=0), axis=1)
  cum_s = np.concatenate([[0.0], np.cumsum(seg_lens)])
  total_s = float(cum_s[-1])
  if total_s < 1e-12:
    return np.repeat(wps[:1], num_states, axis=0)
  queries = np.linspace(0.0, total_s, int(num_states))
  out = np.zeros((int(num_states), wps.shape[1]), dtype=np.float64)
  out[0] = wps[0]
  out[-1] = wps[-1]
  for k in range(1, int(num_states) - 1):
    s_q = float(queries[k])
    seg_idx = int(np.searchsorted(cum_s, s_q, side="right")) - 1
    seg_idx = max(0, min(seg_idx, len(seg_lens) - 1))
    ds = float(seg_lens[seg_idx])
    if ds > 1e-12:
      u = float(np.clip((s_q - float(cum_s[seg_idx])) / ds, 0.0, 1.0))
    else:
      u = 0.0
    out[k] = (1.0 - u) * wps[seg_idx] + u * wps[seg_idx + 1]
  return out


def _dp_window_shortcut(
    pts: list[np.ndarray],
    is_segment_valid_fn: Callable[[np.ndarray, np.ndarray], bool],
    deadline_s: float,
    max_window_span: int = 24,
) -> list[np.ndarray]:
  """Exact dynamic-programming shortcutting over windows up to `max_window_span`."""
  n = len(pts)
  if n <= 2:
    return pts
  dp = [float("inf")] * n
  prev = [-1] * n
  dp[0] = 0.0
  timed_out = False
  for i in range(n - 1):
    if not math.isfinite(dp[i]):
      continue
    adj_cost = dp[i] + float(np.linalg.norm(pts[i + 1] - pts[i]))
    if adj_cost < dp[i + 1]:
      dp[i + 1] = adj_cost
      prev[i + 1] = i
    if timed_out:
      continue
    if time.perf_counter() >= deadline_s:
      timed_out = True
      continue
    max_j = min(n - 1, i + max_window_span)
    for j in range(max_j, i + 1, -1):
      cand_cost = dp[i] + float(np.linalg.norm(pts[j] - pts[i]))
      if cand_cost + 1e-7 >= dp[j]:
        continue
      if is_segment_valid_fn(pts[i], pts[j]):
        dp[j] = cand_cost
        prev[j] = i
  out: list[np.ndarray] = []
  cur = n - 1
  while cur >= 0:
    out.append(pts[cur])
    cur = prev[cur]
  out.reverse()
  return out


def _greedy_jump_shortcut(
    pts: list[np.ndarray],
    is_segment_valid_fn: Callable[[np.ndarray, np.ndarray], bool],
    deadline_s: float,
) -> list[np.ndarray]:
  """Collapses redundant waypoints in O(K) successful jumps before DP/fractional passes."""
  n = len(pts)
  if n <= 2:
    return pts
  out: list[np.ndarray] = [pts[0]]
  i = 0
  while i < n - 1:
    if time.perf_counter() >= deadline_s or i + 1 == n - 1:
      out.extend(pts[i + 1 :])
      break
    jumped = i + 1
    for j in range(n - 1, i + 1, -1):
      if time.perf_counter() >= deadline_s:
        break
      if is_segment_valid_fn(pts[i], pts[j]):
        jumped = j
        break
    out.append(pts[jumped])
    i = jumped
  return out


_DYADIC_ALPHAS_CACHE: dict[int, tuple[np.ndarray, np.ndarray]] = {}
_HALTON_PRIMES: tuple[int, ...] = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)


def _dyadic_segment_alphas(n_steps: int) -> tuple[np.ndarray, np.ndarray]:
  """Returns `(probe_alphas, remaining_dyadic_alphas)` cached by `n_steps`."""
  cached = _DYADIC_ALPHAS_CACHE.get(n_steps)
  if cached is not None:
    return cached
  if n_steps <= 1:
    res = (
        np.array([1.0, 0.0], dtype=np.float64),
        np.zeros(0, dtype=np.float64),
    )
  elif n_steps <= 5:
    res = (
        np.linspace(1.0, 0.0, n_steps + 1, dtype=np.float64),
        np.zeros(0, dtype=np.float64),
    )
  else:
    probe_k: list[int] = []
    for k_cand in (
        n_steps,
        n_steps // 2,
        n_steps // 4,
        (3 * n_steps) // 4,
        0,
    ):
      if k_cand not in probe_k:
        probe_k.append(k_cand)
    probe_set = set(probe_k)
    probe = np.array([k / n_steps for k in probe_k], dtype=np.float64)
    rem_k = [k for k in range(1, n_steps) if k not in probe_set]
    rem_k.sort(key=lambda k: int(f"{(k * 1024) // n_steps:010b}"[::-1], 2))
    rem = np.array([k / n_steps for k in rem_k], dtype=np.float64)
    res = (probe, rem)
  if len(_DYADIC_ALPHAS_CACHE) < 512:
    _DYADIC_ALPHAS_CACHE[n_steps] = res
  return res


def _halton_point(
    index: int, dim: int, scramble: np.ndarray
) -> np.ndarray:
  """Scrambled low-discrepancy Halton point in `[0, 1)^dim`."""
  out = np.empty(dim, dtype=np.float64)
  n_p = len(_HALTON_PRIMES)
  for d in range(dim):
    base = _HALTON_PRIMES[d % n_p]
    f = 1.0 / base
    val = 0.0
    i = index
    while i > 0:
      val += f * (i % base)
      i //= base
      f /= base
    v = val + float(scramble[d])
    out[d] = v - math.floor(v)
  return out


def _subdivide_preserving_waypoints(
    pts: np.ndarray, target_milestones: int
) -> list[np.ndarray]:
  """Subdivides `pts` up to `target_milestones` while keeping every corner."""
  n_pts = int(pts.shape[0])
  if n_pts <= 1 or target_milestones <= n_pts:
    return [pts[i].copy() for i in range(n_pts)]
  seg_lens = np.linalg.norm(np.diff(pts, axis=0), axis=1)
  total = float(np.sum(seg_lens))
  if total <= 1e-12:
    return [pts[i].copy() for i in range(n_pts)]
  extra_budget = max(0, target_milestones - n_pts)
  out: list[np.ndarray] = [pts[0].copy()]
  for i in range(n_pts - 1):
    n_sub = 1 + int(round(extra_budget * (float(seg_lens[i]) / total)))
    for k in range(1, n_sub + 1):
      u = k / n_sub
      out.append((1.0 - u) * pts[i] + u * pts[i + 1])
  return out


def _geodesic_polish_path(
    coarse_arr: np.ndarray,
    q_min: np.ndarray,
    q_max: np.ndarray,
    is_segment_valid_fn: Callable[[np.ndarray, np.ndarray], bool],
    deadline_s: float,
) -> np.ndarray:
  """Subdivided fine-milestone Gauss-Seidel geodesic pull-tight (`~0.45 rad`)."""
  n_pts = int(coarse_arr.shape[0])
  if n_pts < 3 or time.perf_counter() >= deadline_s:
    return coarse_arr
  coarse_cost = float(
      np.sum(np.linalg.norm(np.diff(coarse_arr, axis=0), axis=1))
  )
  if coarse_cost <= 1e-6:
    return coarse_arr

  target_m = max(n_pts, min(20, int(math.ceil(coarse_cost / 0.45)) + 1))
  fine = _subdivide_preserving_waypoints(coarse_arr, target_m)
  for _ in range(2):
    if len(fine) < 3 or time.perf_counter() >= deadline_s:
      break
    for _ in range(2):
      improved = False
      for parity in (1, 2):
        for i in range(parity, len(fine) - 1, 2):
          if time.perf_counter() >= deadline_s:
            break
          mid = 0.5 * (fine[i - 1] + fine[i + 1])
          cur_c = float(np.linalg.norm(fine[i] - fine[i - 1])) + float(
              np.linalg.norm(fine[i + 1] - fine[i])
          )
          moved = False
          for alpha in (1.0, 0.7, 0.4):
            cand = np.clip(fine[i] + alpha * (mid - fine[i]), q_min, q_max)
            c_cost = float(np.linalg.norm(cand - fine[i - 1])) + float(
                np.linalg.norm(fine[i + 1] - cand)
            )
            if (
                c_cost + 1e-5 < cur_c
                and is_segment_valid_fn(fine[i - 1], cand)
                and is_segment_valid_fn(cand, fine[i + 1])
            ):
              fine[i] = cand
              moved = True
              improved = True
              break
          if not moved:
            slide = fine[i].copy()
            s_cost = cur_c
            for d in range(int(slide.shape[0])):
              delta_d = float(mid[d] - slide[d])
              if abs(delta_d) < 0.015 or time.perf_counter() >= deadline_s:
                continue
              trial = slide.copy()
              trial[d] = float(
                  np.clip(slide[d] + 0.65 * delta_d, q_min[d], q_max[d])
              )
              t_cost = float(np.linalg.norm(trial - fine[i - 1])) + float(
                  np.linalg.norm(fine[i + 1] - trial)
              )
              if (
                  t_cost + 1e-5 < s_cost
                  and is_segment_valid_fn(fine[i - 1], trial)
                  and is_segment_valid_fn(trial, fine[i + 1])
              ):
                slide = trial
                s_cost = t_cost
                improved = True
            fine[i] = slide
      if not improved:
        break
    if time.perf_counter() < deadline_s:
      fine = _dp_window_shortcut(
          fine, is_segment_valid_fn, deadline_s, max_window_span=16
      )
    if len(fine) <= 2:
      break

  fine_arr = np.asarray(fine, dtype=np.float64)
  fine_cost = float(np.sum(np.linalg.norm(np.diff(fine_arr, axis=0), axis=1)))
  return fine_arr if fine_cost < coarse_cost else coarse_arr


def _simplify_path(
    raw_pts: list[np.ndarray],
    q_min: np.ndarray,
    q_max: np.ndarray,
    is_segment_valid_fn: Callable[[np.ndarray, np.ndarray], bool],
    rng: np.random.Generator,
    deadline_s: float,
    fractional_trials: int = 28,
    geodesic_polish: bool = True,
) -> np.ndarray:
  """Simplifies a raw RRT path via DP shortcutting, fractional chords, corner rounding, and optional geodesic pull-tight."""
  if len(raw_pts) <= 2:
    return np.asarray(raw_pts, dtype=np.float64)

  pts = _greedy_jump_shortcut(raw_pts, is_segment_valid_fn, deadline_s)
  if len(pts) > 3 and time.perf_counter() < deadline_s:
    pts = _dp_window_shortcut(
        pts, is_segment_valid_fn, deadline_s, max_window_span=14
    )

  # Coarse Laplacian + coordinate-wise pull-tight while vertex count is small
  # to eliminate redundant wrist/nullspace twists before fractional chords.
  for _ in range(2):
    if len(pts) < 3 or time.perf_counter() >= deadline_s:
      break
    for i in range(1, len(pts) - 1):
      if time.perf_counter() >= deadline_s:
        break
      mid = 0.5 * (pts[i - 1] + pts[i + 1])
      cur_seg_cost = float(np.linalg.norm(pts[i] - pts[i - 1])) + float(
          np.linalg.norm(pts[i + 1] - pts[i])
      )
      moved = False
      for gain in (0.65, 0.35):
        cand = np.clip((1.0 - gain) * pts[i] + gain * mid, q_min, q_max)
        cand_cost = float(np.linalg.norm(cand - pts[i - 1])) + float(
            np.linalg.norm(pts[i + 1] - cand)
        )
        if (
            cand_cost + 1e-5 < cur_seg_cost
            and is_segment_valid_fn(pts[i - 1], cand)
            and is_segment_valid_fn(cand, pts[i + 1])
        ):
          pts[i] = cand
          moved = True
          break
      if not moved:
        slide = pts[i].copy()
        base_cost = cur_seg_cost
        for d in range(int(slide.shape[0])):
          if (
              abs(float(mid[d] - slide[d])) < 0.03
              or time.perf_counter() >= deadline_s
          ):
            continue
          trial = slide.copy()
          trial[d] = float(
              np.clip(0.35 * slide[d] + 0.65 * mid[d], q_min[d], q_max[d])
          )
          t_cost = float(np.linalg.norm(trial - pts[i - 1])) + float(
              np.linalg.norm(pts[i + 1] - trial)
          )
          if (
              t_cost + 1e-5 < base_cost
              and is_segment_valid_fn(pts[i - 1], trial)
              and is_segment_valid_fn(trial, pts[i + 1])
          ):
            slide = trial
            base_cost = t_cost
        pts[i] = slide
  pts = _greedy_jump_shortcut(pts, is_segment_valid_fn, deadline_s)

  for _ in range(fractional_trials):
    if len(pts) < 3 or time.perf_counter() >= deadline_s:
      break
    num_segs = len(pts) - 1
    seg_a = int(rng.integers(0, num_segs))
    seg_b = int(rng.integers(0, num_segs))
    if seg_a == seg_b:
      continue
    if seg_a > seg_b:
      seg_a, seg_b = seg_b, seg_a
    t_a = 0.05 + 0.90 * float(rng.random())
    t_b = 0.05 + 0.90 * float(rng.random())
    q_a = np.clip((1.0 - t_a) * pts[seg_a] + t_a * pts[seg_a + 1], q_min, q_max)
    q_b = np.clip((1.0 - t_b) * pts[seg_b] + t_b * pts[seg_b + 1], q_min, q_max)
    old_len = float(np.linalg.norm(pts[seg_a + 1] - q_a))
    for k in range(seg_a + 1, seg_b):
      old_len += float(np.linalg.norm(pts[k + 1] - pts[k]))
    old_len += float(np.linalg.norm(q_b - pts[seg_b]))
    chord_len = float(np.linalg.norm(q_b - q_a))
    if chord_len + 1e-4 >= old_len:
      continue
    if (
        is_segment_valid_fn(q_a, q_b)
        and is_segment_valid_fn(pts[seg_a], q_a)
        and is_segment_valid_fn(q_b, pts[seg_b + 1])
    ):
      pts = pts[: seg_a + 1] + [q_a, q_b] + pts[seg_b + 1 :]

  if len(pts) >= 3 and time.perf_counter() < deadline_s:
    rounded_pts: list[np.ndarray] = [pts[0]]
    for i in range(1, len(pts) - 1):
      if time.perf_counter() >= deadline_s:
        rounded_pts.extend(pts[i:-1])
        break
      p_prev = rounded_pts[-1]
      p_cur = pts[i]
      p_next = pts[i + 1]
      d_in = float(np.linalg.norm(p_cur - p_prev))
      d_out = float(np.linalg.norm(p_next - p_cur))
      if d_in < 1e-4 or d_out < 1e-4:
        rounded_pts.append(p_cur)
        continue
      did_round = False
      for s in (0.42, 0.25, 0.12):
        q_a = np.clip((1.0 - s) * p_cur + s * p_prev, q_min, q_max)
        q_b = np.clip((1.0 - s) * p_cur + s * p_next, q_min, q_max)
        old_corner = float(np.linalg.norm(p_cur - q_a)) + float(
            np.linalg.norm(q_b - p_cur)
        )
        new_chord = float(np.linalg.norm(q_b - q_a))
        if new_chord + 1e-5 >= old_corner:
          continue
        if (
            is_segment_valid_fn(q_a, q_b)
            and is_segment_valid_fn(p_prev, q_a)
            and is_segment_valid_fn(q_b, p_next)
        ):
          rounded_pts.append(q_a)
          rounded_pts.append(q_b)
          did_round = True
          break
      if not did_round:
        rounded_pts.append(p_cur)
    rounded_pts.append(pts[-1])
    pts = _greedy_jump_shortcut(rounded_pts, is_segment_valid_fn, deadline_s)

  coarse_arr = np.asarray(pts, dtype=np.float64)
  if not geodesic_polish:
    return coarse_arr
  return _geodesic_polish_path(
      coarse_arr, q_min, q_max, is_segment_valid_fn, deadline_s
  )


class _RrtTree:
  """Contiguous NumPy array-backed RRT tree with per-node dynamic-domain radius."""

  def __init__(self, root: np.ndarray, init_cap: int = 256) -> None:
    dim = int(root.shape[0])
    self.nodes = np.empty((max(16, init_cap), dim), dtype=np.float64)
    self.nodes[0] = root
    self.parents: list[int] = [-1]
    self.radii: list[float] = [float("inf")]
    self.size = 1

  def append(self, q: np.ndarray, parent: int, radius: float) -> int:
    """Appends a configuration node to the RRT tree and returns its index."""
    if self.size >= self.nodes.shape[0]:
      grown = np.empty(
          (self.nodes.shape[0] * 2, self.nodes.shape[1]), dtype=np.float64
      )
      grown[: self.size] = self.nodes[: self.size]
      self.nodes = grown
    idx = self.size
    self.nodes[idx] = q
    self.parents.append(parent)
    self.radii.append(radius)
    self.size += 1
    return idx

  def nearest(self, q: np.ndarray) -> tuple[int, float]:
    diffs = self.nodes[: self.size] - q[None, :]
    d2 = np.einsum("ij,ij->i", diffs, diffs)
    idx = int(np.argmin(d2))
    return idx, math.sqrt(float(d2[idx]))

  def trace(self, idx: int) -> list[np.ndarray]:
    chain: list[np.ndarray] = []
    cur = idx
    while cur != -1:
      chain.append(self.nodes[cur].copy())
      cur = self.parents[cur]
    chain.reverse()
    return chain


def _sample_phs_ellipsoid(
    q0: np.ndarray,
    q1: np.ndarray,
    c_best: float,
    q_min: np.ndarray,
    q_max: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
  """Samples uniformly inside the prolate hyperspheroid `||q-q0|| + ||q-q1|| <= c_best`."""
  dim = int(q0.shape[0])
  diff = q1 - q0
  c_min = float(np.linalg.norm(diff))
  if c_best <= c_min + 1e-6 or c_min <= 1e-9 or dim < 2:
    return rng.uniform(q_min, q_max)
  u = rng.normal(0.0, 1.0, size=dim)
  u_norm = max(1e-12, float(np.linalg.norm(u)))
  ball = u * ((float(rng.random()) ** (1.0 / dim)) / u_norm)
  r_major = 0.5 * c_best
  r_minor = 0.5 * math.sqrt(max(1e-12, c_best * c_best - c_min * c_min))
  axis = diff / c_min
  # Decompose unit-ball vector into parallel (e_0 -> axis) and orthogonal parts
  b_par = ball[0]
  # Map ball[1:] onto hyperplane orthogonal to axis via Householder reflection.
  v = axis.copy()
  v[0] += 1.0 if axis[0] >= 0.0 else -1.0
  v_sq = float(np.dot(v, v))
  scaled = np.empty(dim, dtype=np.float64)
  scaled[0] = r_major * b_par
  scaled[1:] = r_minor * ball[1:]
  if v_sq > 1e-15:
    rot_vec = scaled - (2.0 / v_sq) * float(np.dot(v, scaled)) * v
  else:
    rot_vec = scaled
  return np.clip(0.5 * (q0 + q1) + rot_vec, q_min, q_max)


def _plan_birrt(
    q_start: np.ndarray,
    q_goal: np.ndarray,
    q_min: np.ndarray,
    q_max: np.ndarray,
    step_size: float,
    is_segment_valid_fn: Callable[[np.ndarray, np.ndarray], bool],
    max_iterations: int,
    max_time_ms: float,
    seed: int,
) -> dict[str, Any]:
  """Adaptive bidirectional RRT-Connect with dynamic domain, PHS restart, and simplification."""
  t0 = time.perf_counter()
  budget_s = max(0.05, float(max_time_ms) / 1000.0)
  deadline_s = t0 + budget_s
  q0 = np.asarray(q_start, dtype=np.float64).copy()
  q1 = np.asarray(q_goal, dtype=np.float64).copy()
  dim = int(q0.shape[0])
  straight_dist = float(np.linalg.norm(q1 - q0))

  if is_segment_valid_fn(q0, q1):
    wps = np.stack([q0, q1], axis=0)
    return {
        "solved": True,
        "waypoints": wps,
        "cost": straight_dist,
        "iterations": 1,
        "solve_time_ms": (time.perf_counter() - t0) * 1000.0,
    }

  rng = np.random.default_rng(seed)
  scramble = rng.random(dim)
  halton_idx = [1 + (abs(int(seed)) * 97) % 997]
  q_span = q_max - q_min
  step = max(1e-3, float(step_size))
  cspace_diam = max(1e-3, float(np.linalg.norm(q_span)))
  dd_base = max(4.5 * step, 0.35 * cspace_diam)
  dd_min = max(1.2 * step, 0.12 * cspace_diam)
  dd_alpha = 0.05
  max_iters = max(1, int(max_iterations))
  narrow_thresh = min(400, max(150, max_iters // 10))

  def _run_single_birrt(
      run_deadline_s: float,
      iter_cap: int,
      cost_cap: float | None = None,
      backbone: np.ndarray | None = None,
  ) -> tuple[list[np.ndarray] | None, int]:
    tree_s = _RrtTree(q0)
    tree_g = _RrtTree(q1)
    best_s_idx = 0
    best_g_idx = 0
    best_bridge_dist = straight_dist
    a_is_start = False

    for it in range(1, iter_cap + 1):
      if (it & 15) == 0 and time.perf_counter() >= run_deadline_s:
        return None, it

      # Balance trees using 2:1 ratio threshold so trapped trees aren't starved
      a_sz = tree_s.size if a_is_start else tree_g.size
      b_sz = tree_g.size if a_is_start else tree_s.size
      if (b_sz - a_sz) < max(2, a_sz):
        a_is_start = not a_is_start
      tree_a = tree_s if a_is_start else tree_g
      tree_b = tree_g if a_is_start else tree_s

      in_escape = (cost_cap is None) and (it > narrow_thresh)
      u_draw = float(rng.random())
      if cost_cap is not None:
        if u_draw < 0.05:
          q_rand = tree_b.nodes[0].copy()
        elif backbone is not None and len(backbone) >= 2 and u_draw < 0.40:
          seg_i = int(rng.integers(0, len(backbone) - 1))
          u_seg = float(rng.random())
          center = (1.0 - u_seg) * backbone[seg_i] + u_seg * backbone[seg_i + 1]
          slack = max(0.02, cost_cap - straight_dist)
          tube_r = min(
              1.0, max(0.08, 0.30 * math.sqrt(slack * max(straight_dist, 0.2)))
          )
          g_vec = rng.normal(0.0, 1.0, size=dim)
          g_vec /= max(1e-12, float(np.linalg.norm(g_vec)))
          q_rand = np.clip(
              center + tube_r * (float(rng.random()) ** (1.0 / dim)) * g_vec,
              q_min,
              q_max,
          )
        else:
          q_rand = _sample_phs_ellipsoid(q0, q1, cost_cap, q_min, q_max, rng)
        if (
            float(np.linalg.norm(q_rand - q0))
            + float(np.linalg.norm(q1 - q_rand))
            >= cost_cap
        ):
          continue
      elif u_draw < 0.05:
        q_rand = tree_b.nodes[0].copy()
      elif in_escape and (it & 7) == 0:
        q_s_best = tree_s.nodes[best_s_idx]
        q_g_best = tree_g.nodes[best_g_idx]
        anchor = q_s_best if a_is_start else q_g_best
        target = q_g_best if a_is_start else q_s_best
        mode = (it >> 3) & 3
        u_rand = rng.uniform(q_min, q_max)
        if mode == 0:
          mid = 0.5 * (anchor + target)
          q_rand = np.clip(mid + 0.22 * (u_rand - mid), q_min, q_max)
        elif mode == 1:
          mask = (rng.random(dim) < 0.5).astype(np.float64)
          if not np.any(mask):
            mask[int(rng.integers(0, dim))] = 1.0
          corner = anchor + mask * (target - anchor)
          q_rand = np.clip(corner + 0.18 * (u_rand - corner), q_min, q_max)
        else:
          q_rand = np.clip(target + 0.25 * (u_rand - target), q_min, q_max)
      else:
        h = _halton_point(halton_idx[0], dim, scramble)
        halton_idx[0] += 1
        q_rand = q_min + h * q_span

      near_idx, near_dist = tree_a.nearest(q_rand)
      if near_dist <= 1e-9:
        continue
      near_rad = tree_a.radii[near_idx]
      active_escape = in_escape and ((it & 3) == 0)
      if in_escape:
        eff_rad = (
            near_rad * 1.5
            if (active_escape and math.isfinite(near_rad))
            else near_rad
        )
        if near_dist > eff_rad:
          continue

      q_near = tree_a.nodes[near_idx]
      diff = q_rand - q_near
      q_ext = (
          q_rand.copy()
          if near_dist <= step
          else np.clip(q_near + (step / near_dist) * diff, q_min, q_max)
      )
      if cost_cap is not None and (
          float(np.linalg.norm(q_ext - q0))
          + float(np.linalg.norm(q1 - q_ext))
          >= cost_cap
      ):
        continue
      extended = is_segment_valid_fn(q_near, q_ext)
      salvaged = False

      if not extended and active_escape:
        mask = (rng.random(dim) < 0.5).astype(np.float64)
        if np.any(mask) and not np.all(mask):
          m_diff = diff * mask
          m_norm = float(np.linalg.norm(m_diff))
          if m_norm > 1e-4:
            q_cand = np.clip(
                q_near + min(1.0, step / m_norm) * m_diff, q_min, q_max
            )
            if is_segment_valid_fn(q_near, q_cand):
              q_ext = q_cand
              extended = True
              salvaged = True
        if not extended and near_dist > 0.25 * step:
          q_short = np.clip(q_near + 0.35 * (q_ext - q_near), q_min, q_max)
          if is_segment_valid_fn(q_near, q_short):
            q_ext = q_short
            extended = True
            salvaged = True

      if not extended:
        if in_escape:
          tree_a.radii[near_idx] = (
              dd_base
              if math.isinf(near_rad)
              else max(dd_min, near_rad * (1.0 - dd_alpha))
          )
        continue

      if salvaged:
        shrunk = (
            dd_base
            if math.isinf(near_rad)
            else max(dd_min, near_rad * (1.0 - dd_alpha))
        )
        tree_a.radii[near_idx] = shrunk
        new_rad = shrunk if tree_a.size > 1200 else dd_base
      else:
        if not math.isinf(near_rad):
          tree_a.radii[near_idx] = near_rad * (1.0 + dd_alpha)
        new_rad = float("inf")

      idx_a = tree_a.append(q_ext, near_idx, new_rad)

      # RRT-Connect: march tree_b greedily from its nearest node toward q_ext
      other_idx, other_dist = tree_b.nearest(q_ext)
      if other_dist < best_bridge_dist:
        best_bridge_dist = other_dist
        if a_is_start:
          best_s_idx, best_g_idx = idx_a, other_idx
        else:
          best_s_idx, best_g_idx = other_idx, idx_a

      q_other = tree_b.nodes[other_idx].copy()
      n_steps = max(1, int(math.ceil(other_dist / step)))
      inc = (q_ext - q_other) / n_steps
      prior = q_other
      ray_pts: list[np.ndarray] = []
      completed = 0
      for s_idx in range(n_steps):
        if (
            s_idx > 0
            and (s_idx & 15) == 0
            and time.perf_counter() >= run_deadline_s
        ):
          break
        q_next = (
            q_ext
            if (s_idx + 1 == n_steps)
            else np.clip(prior + inc, q_min, q_max)
        )
        if cost_cap is not None and (
            float(np.linalg.norm(q_next - q0))
            + float(np.linalg.norm(q1 - q_next))
            >= cost_cap
        ):
          break
        if not is_segment_valid_fn(prior, q_next):
          break
        if s_idx + 1 < n_steps:
          ray_pts.append(q_next)
        prior = q_next
        completed += 1

      if completed == n_steps:
        if not ray_pts or is_segment_valid_fn(q_other, q_ext):
          tip_b = other_idx
        else:
          tip_b = other_idx
          for rp in ray_pts:
            tip_b = tree_b.append(rp, tip_b, float("inf"))
        if a_is_start:
          path_s = tree_s.trace(idx_a)
          path_g = tree_g.trace(tip_b)
        else:
          path_s = tree_s.trace(tip_b)
          path_g = tree_g.trace(idx_a)
        path_g.reverse()
        return path_s + path_g, it

      prev_ray_idx = other_idx
      for rp in ray_pts:
        prev_ray_idx = tree_b.append(rp, prev_ray_idx, float("inf"))
      rem_dist = float(np.linalg.norm(q_ext - prior))
      if rem_dist < best_bridge_dist:
        best_bridge_dist = rem_dist
        if a_is_start:
          best_s_idx, best_g_idx = idx_a, prev_ray_idx
        else:
          best_s_idx, best_g_idx = prev_ray_idx, idx_a

    return None, iter_cap

  raw_pts, iters_used = _run_single_birrt(deadline_s, max_iters, cost_cap=None)
  if raw_pts is None:
    return {
        "solved": False,
        "waypoints": np.zeros((0, dim), dtype=np.float64),
        "cost": 0.0,
        "iterations": iters_used,
        "solve_time_ms": (time.perf_counter() - t0) * 1000.0,
    }

  # Stage 1b: Fast coarse shortcutting (deferring subdivided geodesic polish
  # until after Stage 2 homotopy search so detours don't burn budget).
  now = time.perf_counter()
  sc_deadline = min(deadline_s + 0.15, now + max(0.18, 0.22 * budget_s))
  best_wps = _simplify_path(
      raw_pts,
      q_min,
      q_max,
      is_segment_valid_fn,
      rng,
      sc_deadline,
      fractional_trials=20,
      geodesic_polish=False,
  )
  best_cost = float(np.sum(np.linalg.norm(np.diff(best_wps, axis=0), axis=1)))

  # Stage 2: Un-gated anytime PHS ellipsoid + local backbone-tube homotopy
  # search whenever the coarse-simplified path still has a meaningful detour.
  now = time.perf_counter()
  if best_cost > 1.12 * straight_dist:
    phs_budget = min(0.50, 0.35 * budget_s)
    phs_deadline = min(deadline_s + 0.15, now + phs_budget)
    for _ in range(8):
      if (
          time.perf_counter() >= phs_deadline
          or best_cost <= 1.06 * straight_dist
      ):
        break
      # Only bias around `best_wps` once it's already in a reasonable homotopy;
      # on large detours (> 1.65x straight_dist), sample pure PHS globally!
      tube_guide = best_wps if best_cost <= 1.65 * straight_dist else None
      cand_raw, extra_it = _run_single_birrt(
          phs_deadline,
          max(400, max_iters // 4),
          cost_cap=0.98 * best_cost,
          backbone=tube_guide,
      )
      iters_used += extra_it
      if cand_raw is not None:
        sc_dl2 = min(deadline_s + 0.20, time.perf_counter() + 0.14)
        cand_wps = _simplify_path(
            cand_raw,
            q_min,
            q_max,
            is_segment_valid_fn,
            rng,
            sc_dl2,
            fractional_trials=16,
            geodesic_polish=False,
        )
        cand_cost = float(
            np.sum(np.linalg.norm(np.diff(cand_wps, axis=0), axis=1))
        )
        if cand_cost + 1e-4 < best_cost:
          best_wps = cand_wps
          best_cost = cand_cost

  # Stage 3: Subdivided fine-milestone geodesic pull-tight ONCE on winning path!
  geo_dl = min(
      deadline_s + 0.35, time.perf_counter() + max(0.25, 0.25 * budget_s)
  )
  best_wps = _geodesic_polish_path(
      best_wps, q_min, q_max, is_segment_valid_fn, geo_dl
  )
  best_cost = float(np.sum(np.linalg.norm(np.diff(best_wps, axis=0), axis=1)))

  return {
      "solved": True,
      "waypoints": best_wps,
      "cost": best_cost,
      "iterations": iters_used,
      "solve_time_ms": (time.perf_counter() - t0) * 1000.0,
  }


def _se3_world_centers_batch(
    local_centers: np.ndarray, poses_k6: np.ndarray
) -> np.ndarray:
  """Computes `(K, S, 3)` world sphere centers for a batch of `(K, 6)` poses."""
  yaw = poses_k6[:, 3]
  pitch = poses_k6[:, 4]
  roll = poses_k6[:, 5]
  cr, sr = np.cos(roll), np.sin(roll)
  cp, sp = np.cos(pitch), np.sin(pitch)
  cy, sy = np.cos(yaw), np.sin(yaw)
  rot = np.empty((poses_k6.shape[0], 3, 3), dtype=np.float64)
  rot[:, 0, 0] = cy * cp
  rot[:, 0, 1] = cy * sp * sr - sy * cr
  rot[:, 0, 2] = cy * sp * cr + sy * sr
  rot[:, 1, 0] = sy * cp
  rot[:, 1, 1] = sy * sp * sr + cy * cr
  rot[:, 1, 2] = sy * sp * cr - cy * sr
  rot[:, 2, 0] = -sp
  rot[:, 2, 1] = cp * sr
  rot[:, 2, 2] = cp * cr
  return poses_k6[:, None, :3] + np.einsum("kij,sj->ksi", rot, local_centers)


def _is_se3_pose_valid_fast(
    obj: MultiSphereObject,
    local_centers: np.ndarray,
    radii: np.ndarray,
    scene: Scene3D,
    q: np.ndarray,
    inflation_m: float = 0.0,
    skip_inflation_groups: Sequence[str] = ("table",),
) -> bool:
  """Fast vectorized SE(3) validity check supporting obstacle `inflation_m`."""
  if bool(
      np.any((q < obj.lower_bounds - 1e-5) | (q > obj.upper_bounds + 1e-5))
  ):
    return False
  if not radii.size:
    return True
  pos, rot = pos_rot_from_pose6d(q)
  w_centers = pos[None, :] + (rot @ local_centers.T).T
  return not _any_spheres_collide_with_scene(
      w_centers,
      radii,
      scene,
      inflation_m=inflation_m,
      skip_inflation_groups=skip_inflation_groups,
  )


def _is_se3_segment_valid_fast(
    obj: MultiSphereObject,
    local_centers: np.ndarray,
    radii: np.ndarray,
    scene: Scene3D,
    q_a: np.ndarray,
    q_b: np.ndarray,
    step_size: float,
    inflation_m: float = 0.0,
    skip_inflation_groups: Sequence[str] = ("table",),
) -> bool:
  """Vectorized linear SE(3) segment `[q_a, q_b]` collision check."""
  lo = obj.lower_bounds - 1e-5
  hi = obj.upper_bounds + 1e-5
  if bool(np.any((q_b < lo) | (q_b > hi))) or bool(
      np.any((q_a < lo) | (q_a > hi))
  ):
    return False
  if not radii.size:
    return True
  dist = float(np.linalg.norm(q_b - q_a))
  n_steps = max(1, int(math.ceil(dist / max(1e-4, step_size))))
  probe_a, rem_a = _dyadic_segment_alphas(n_steps)
  delta = q_b - q_a
  w_probe = _se3_world_centers_batch(
      local_centers, q_a[None, :] + probe_a[:, None] * delta[None, :]
  )
  if _any_spheres_collide_with_scene(
      w_probe, radii, scene, inflation_m, skip_inflation_groups
  ):
    return False
  if rem_a.size:
    w_rem = _se3_world_centers_batch(
        local_centers, q_a[None, :] + rem_a[:, None] * delta[None, :]
    )
    for start_k in range(0, int(rem_a.size), 16):
      if _any_spheres_collide_with_scene(
          w_rem[start_k : start_k + 16],
          radii,
          scene,
          inflation_m,
          skip_inflation_groups,
      ):
        return False
  return True


def plan_object_se3(
    obj: MultiSphereObject,
    scene: Scene3D,
    start_pose6d: Sequence[float] | np.ndarray,
    goal_pose6d: Sequence[float] | np.ndarray,
    planner_kind: str = "birrt",
    max_iterations: int = 12000,
    max_time_ms: float = 3000.0,
    step_size: float = 0.45,
    motion_step_size: float = 0.015625,
    seed: int = 1,
    num_interpolated_states: int = 40,
    safety_margin_m: float = 0.010,
) -> dict[str, Any]:
  """Plans a collision-free 6-DoF SE(3) object path."""
  del planner_kind
  s = np.asarray(start_pose6d, dtype=np.float64).reshape(6)
  g = np.asarray(goal_pose6d, dtype=np.float64).reshape(6)

  start_check = check_se3_pose(obj, scene, s)
  goal_check = check_se3_pose(obj, scene, g)
  if not start_check["valid"] or not goal_check["valid"]:
    return {
        "solved": False,
        "reason": "start_or_goal_invalid",
        "start_check": start_check,
        "goal_check": goal_check,
        "waypoints": np.zeros((0, 6), dtype=np.float64),
        "interpolated": np.zeros((0, 6), dtype=np.float64),
        "applied_safety_margin_m": 0.0,
    }

  non_table_s = check_se3_pose(obj, scene, s, ignore_obstacles=("table",))
  non_table_g = check_se3_pose(obj, scene, g, ignore_obstacles=("table",))
  min_end_clr = _min_optional_clearance(
      non_table_s["min_clearance_m"], non_table_g["min_clearance_m"]
  )
  margins = _dedup_safety_margins(safety_margin_m, min_end_clr)

  local_c = (
      np.array([sp.center for sp in obj.spheres], dtype=np.float64).reshape(
          -1, 3
      )
      if obj.spheres
      else np.zeros((0, 3), dtype=np.float64)
  )
  local_r = (
      np.array([sp.radius for sp in obj.spheres], dtype=np.float64)
      if obj.spheres
      else np.zeros(0, dtype=np.float64)
  )
  last_res: dict[str, Any] | None = None
  applied_margin = 0.0
  m_step = max(1e-3, float(motion_step_size))
  for m in margins:
    if m > 0.0 and (
        not _is_se3_pose_valid_fast(
            obj, local_c, local_r, scene, s, m, ("table",)
        )
        or not _is_se3_pose_valid_fast(
            obj, local_c, local_r, scene, g, m, ("table",)
        )
    ):
      continue
    iters_m = (
        max(1500, int(0.6 * int(max_iterations)))
        if m > 0.0
        else int(max_iterations)
    )
    time_m = (
        min(float(max_time_ms), max(400.0, 0.5 * float(max_time_ms)))
        if m > 0.0
        else float(max_time_ms)
    )
    res = _plan_birrt(
        q_start=s,
        q_goal=g,
        q_min=obj.lower_bounds,
        q_max=obj.upper_bounds,
        step_size=step_size,
        is_segment_valid_fn=lambda a, b, inf_m=m: _is_se3_segment_valid_fast(
            obj, local_c, local_r, scene, a, b, m_step, inf_m, ("table",)
        ),
        max_iterations=iters_m,
        max_time_ms=time_m,
        seed=seed,
    )
    last_res = res
    if res["solved"] and res["waypoints"].shape[0] >= 2:
      applied_margin = 0.0 + round(float(m), 5)
      break

  assert last_res is not None
  if last_res["solved"] and last_res["waypoints"].shape[0] >= 2:
    interp = _interpolate_waypoints_uniform(
        last_res["waypoints"], num_states=num_interpolated_states
    )
  else:
    interp = last_res["waypoints"]
  return {
      "solved": bool(last_res["solved"]),
      "reason": "ok" if last_res["solved"] else "planner_exhausted",
      "waypoints": last_res["waypoints"],
      "interpolated": interp,
      "cost": round(float(last_res["cost"]), 5),
      "iterations": int(last_res["iterations"]),
      "solve_time_ms": round(float(last_res["solve_time_ms"]), 2),
      "applied_safety_margin_m": applied_margin,
      "start_check": start_check,
      "goal_check": goal_check,
  }


# ---------------------------------------------------------------------------
# 4. Pure-MJCF Introspection & RobotArmPlanner
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class _ChainSphereMeta:
  label: str
  frame_index: int
  local_center: np.ndarray
  radius: float
  self_collision_group: int


def _local_sphere_bounds_dict(
    items: Sequence[_ChainSphereMeta],
) -> dict[str, list[float]] | None:
  """Returns axis-aligned `[min, max]` bounds of `_ChainSphereMeta` in frame."""
  if not items:
    return None
  mins = np.min([m.local_center - m.radius for m in items], axis=0)
  maxs = np.max([m.local_center + m.radius for m in items], axis=0)
  return {
      "x_min_max": [round(float(mins[0]), 4), round(float(maxs[0]), 4)],
      "y_min_max": [round(float(mins[1]), 4), round(float(maxs[1]), 4)],
      "z_min_max": [round(float(mins[2]), 4), round(float(maxs[2]), 4)],
  }


def _densify_mesh_triangles(
    verts_body: np.ndarray, faces: np.ndarray, sample_step: float = 0.016
) -> np.ndarray:
  """Samples long mesh triangles so CAD shafts have no interior vertex holes."""
  if not faces.size:
    return verts_body
  tri_v0 = verts_body[faces[:, 0]]
  tri_v1 = verts_body[faces[:, 1]]
  tri_v2 = verts_body[faces[:, 2]]
  e01 = np.linalg.norm(tri_v1 - tri_v0, axis=1)
  e12 = np.linalg.norm(tri_v2 - tri_v1, axis=1)
  e20 = np.linalg.norm(tri_v0 - tri_v2, axis=1)
  max_edge = np.maximum(e01, np.maximum(e12, e20))
  long_indices = np.nonzero(max_edge > sample_step)[0]
  if not long_indices.size:
    return verts_body

  extra_pts: list[np.ndarray] = [verts_body]
  bary_cache: dict[int, tuple[np.ndarray, np.ndarray]] = {}
  for f_idx in long_indices.tolist():
    n_div = min(
        24, max(2, int(math.ceil(float(max_edge[f_idx]) / sample_step)))
    )
    if n_div not in bary_cache:
      us: list[float] = []
      vs: list[float] = []
      for i in range(n_div + 1):
        u_val = i / n_div
        for j in range(n_div + 1 - i):
          if (
              (i == 0 and j == 0)
              or (i == n_div and j == 0)
              or (i == 0 and j == n_div)
          ):
            continue
          us.append(u_val)
          vs.append(j / n_div)
      bary_cache[n_div] = (
          np.array(us, dtype=np.float64),
          np.array(vs, dtype=np.float64),
      )
    u_arr, v_arr = bary_cache[n_div]
    if u_arr.size:
      p0 = tri_v0[f_idx]
      d1 = tri_v1[f_idx] - p0
      d2 = tri_v2[f_idx] - p0
      extra_pts.append(
          p0[None, :]
          + u_arr[:, None] * d1[None, :]
          + v_arr[:, None] * d2[None, :]
      )
  return np.vstack(extra_pts) if len(extra_pts) > 1 else verts_body


def _sample_geom_local_spheres(
    model: mujoco.MjModel, geom_id: int
) -> list[tuple[np.ndarray, float]]:
  """Approximates a MuJoCo geom in its parent body frame as a union of spheres."""
  gtype = int(model.geom_type[geom_id])
  gpos = np.asarray(model.geom_pos[geom_id], dtype=np.float64).copy()
  gquat = np.asarray(model.geom_quat[geom_id], dtype=np.float64).copy()
  grot = quat_wxyz_to_matrix(gquat)
  gsize = np.asarray(model.geom_size[geom_id], dtype=np.float64).copy()

  if gtype == int(mujoco.mjtGeom.mjGEOM_SPHERE):
    return [(gpos, float(gsize[0]))]

  if gtype == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
    radius = float(gsize[0])
    half_len = float(gsize[1])
    axis_z = grot[:, 2]
    p0 = gpos - axis_z * half_len
    p1 = gpos + axis_z * half_len
    count = max(2, int(math.ceil(2.0 * half_len / max(radius, 0.02))) + 1)
    return [
        ((1.0 - i / (count - 1)) * p0 + (i / (count - 1)) * p1, radius)
        for i in range(count)
    ]

  if gtype == int(mujoco.mjtGeom.mjGEOM_CYLINDER):
    radius = float(gsize[0])
    half_len = float(gsize[1])
    axis_z = grot[:, 2]
    p0 = gpos - axis_z * half_len
    p1 = gpos + axis_z * half_len
    count = max(2, int(math.ceil(2.0 * half_len / max(radius, 0.02))) + 1)
    return [
        ((1.0 - i / (count - 1)) * p0 + (i / (count - 1)) * p1, radius)
        for i in range(count)
    ]

  if gtype == int(mujoco.mjtGeom.mjGEOM_BOX):
    hx, hy, hz = float(gsize[0]), float(gsize[1]), float(gsize[2])
    if max(hx, hy, hz) < 0.004:
      return []  # Ignore tiny 1mm tactile site marker boxes
    r = float(min(hx, hy, hz))
    nx = max(1, int(math.ceil(2.0 * hx / max(2.0 * r, 0.02))))
    ny = max(1, int(math.ceil(2.0 * hy / max(2.0 * r, 0.02))))
    nz = max(1, int(math.ceil(2.0 * hz / max(2.0 * r, 0.02))))
    xs = [0.0] if nx == 1 else np.linspace(-hx + r, hx - r, nx).tolist()
    ys = [0.0] if ny == 1 else np.linspace(-hy + r, hy - r, ny).tolist()
    zs = [0.0] if nz == 1 else np.linspace(-hz + r, hz - r, nz).tolist()
    out: list[tuple[np.ndarray, float]] = []
    for x in xs:
      for y in ys:
        for z in zs:
          out.append((gpos + grot @ np.array([x, y, z]), r))
    return out

  if gtype == int(mujoco.mjtGeom.mjGEOM_MESH):
    mesh_id = int(model.geom_dataid[geom_id])
    if mesh_id < 0:
      return []
    v_adr = int(model.mesh_vertadr[mesh_id])
    v_num = int(model.mesh_vertnum[mesh_id])
    if v_num <= 0:
      return []
    verts_mesh = np.asarray(
        model.mesh_vert[v_adr : v_adr + v_num], dtype=np.float64
    )
    # Note: MuJoCo's compiler already folds mesh_pos/mesh_quat into geom_pos
    # and geom_quat while centering mesh_vert, so body-frame vertices use
    # (gpos, grot) directly without re-applying mesh_pos/mesh_quat.
    verts_body = gpos + (grot @ verts_mesh.T).T
    vmin = np.min(verts_body, axis=0)
    vmax = np.max(verts_body, axis=0)
    span = vmax - vmin
    if float(np.max(span)) < 0.005:
      return []
    f_adr = int(model.mesh_faceadr[mesh_id])
    f_num = int(model.mesh_facenum[mesh_id])
    faces = (
        np.asarray(model.mesh_face[f_adr : f_adr + f_num], dtype=np.int32)
        if f_num > 0
        else np.zeros((0, 3), dtype=np.int32)
    )
    pts_all = _densify_mesh_triangles(verts_body, faces, sample_step=0.016)
    min_span = float(np.min(span))
    is_bulky_mesh = min_span > 0.028
    # Bounded voxel pitch ensures zero interior/surface holes on long STL links
    # while keeping thin finger pads crisp along their closing normal.
    voxel = 0.024 if is_bulky_mesh else 0.020
    keys = np.floor((pts_all - vmin) / (voxel + 1e-9)).astype(np.int64)
    dims = np.maximum(1, np.max(keys, axis=0) + 1)
    flat_keys = (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]
    order = np.argsort(flat_keys, kind="mergesort")
    sorted_fk = flat_keys[order]
    split_pts = np.flatnonzero(np.diff(sorted_fk)) + 1
    starts = np.concatenate([[0], split_pts])
    ends = np.concatenate([split_pts, [int(sorted_fk.size)]])

    spheres: list[tuple[np.ndarray, float]] = []
    half_min_span = 0.5 * min_span
    for g_idx in range(int(starts.size)):
      pts = pts_all[order[int(starts[g_idx]) : int(ends[g_idx])]]
      cmin = np.min(pts, axis=0)
      cmax = np.max(pts, axis=0)
      cspan = cmax - cmin
      c = 0.5 * (cmin + cmax)
      if is_bulky_mesh:
        cell_cover = max(
            0.55 * float(np.max(cspan)),
            0.5 * float(np.linalg.norm(cspan)),
            0.52 * voxel,
        )
        rad = float(
            np.clip(cell_cover, 0.008, min(0.022, max(0.008, half_min_span)))
        )
      else:
        rad = float(
            np.clip(
                0.5 * float(np.min(cspan)),
                0.0025,
                min(0.014, max(0.0025, half_min_span)),
            )
        )
      inset = np.minimum(rad, 0.5 * span)
      c = np.clip(c, vmin + inset, vmax - inset)
      spheres.append((c, rad))
    return spheres

  return []


def _expand_mjcf_candidates(raw_path: str) -> list[str]:
  """Expands a raw MJCF path across asset roots and `/usr/share/mujoco_assets`."""
  p = str(raw_path).strip()
  if not p:
    return []
  out: list[str] = [p]
  asset_roots = [
      r
      for r in (
          os.environ.get("ROBOT_ASSETS_ROOT", ""),
          os.environ.get("MUJOCO_ASSETS_ROOT", ""),
      )
      if r
  ]
  if p.startswith("/usr/share/mujoco_assets/"):
    rel = p.removeprefix("/usr/share/mujoco_assets/")
    for root in asset_roots:
      out.append(os.path.join(root, rel))
    out.append(rel)
  elif not os.path.isabs(p):
    for root in (*asset_roots, "/usr/share/mujoco_assets"):
      out.append(os.path.join(root, p))
  return out


def _pick_primary_xml_in_dir(dir_path: str, max_depth: int = 2) -> str | None:
  """Selects the primary robot/scene MJCF XML inside a bounded model directory."""
  if not dir_path or not os.path.isdir(dir_path):
    return None
  skip_substrings = (
      "keyframe",
      "actuator",
      "object",
      "asset",
      "material",
      "texture",
      "sensor",
      "light",
      "camera_only",
  )
  xml_files: list[str] = []
  base_depth = dir_path.rstrip(os.sep).count(os.sep)
  visited_dirs = 0
  for root, dirs, files in os.walk(dir_path):
    visited_dirs += 1
    if visited_dirs > 120:
      break
    cur_depth = root.rstrip(os.sep).count(os.sep) - base_depth
    if cur_depth >= max_depth:
      dirs[:] = []
    dirs[:] = sorted(d for d in dirs if not d.startswith("."))
    for fname in sorted(files):
      if fname.endswith(".xml"):
        xml_files.append(os.path.join(root, fname))
  if not xml_files:
    return None

  def _score_xml(path: str) -> tuple[int, int, str]:
    bname = os.path.basename(path).lower()
    rel_depth = path.count(os.sep) - base_depth
    if any(tok in bname for tok in skip_substrings):
      return (100, rel_depth, bname)
    try:
      with open(path, "r", encoding="utf-8", errors="ignore") as f:
        head = f.read(16384)
    except OSError:
      return (90, rel_depth, bname)
    if "<mujoco" not in head:
      return (85, rel_depth, bname)
    has_worldbody = "<worldbody" in head
    has_joint_or_inc = ("<joint" in head) or ("<include" in head)
    if not has_worldbody:
      return (80, rel_depth, bname)
    # Prefer standalone robot XML over scene wrapper if scene wrapper only adds floor
    dir_stem = os.path.basename(os.path.abspath(dir_path)).lower()
    stem = bname.removesuffix(".xml")
    if stem in (dir_stem, "robot") and has_joint_or_inc:
      return (0, rel_depth, bname)
    if has_joint_or_inc and stem != "scene":
      return (1, rel_depth, bname)
    if stem == "scene":
      return (2, rel_depth, bname)
    return (3, rel_depth, bname)

  scored = sorted(xml_files, key=_score_xml)
  for cand in scored:
    try:
      m = mujoco.MjModel.from_xml_path(cand)
      if int(m.njnt) > 0:
        return cand
    except Exception:  # pylint: disable=broad-exception-caught
      continue
  return scored[0]


def resolve_mjcf_path(mjcf_path: str | None = None) -> str:
  """Resolves an explicit, env-configured, or workspace robot MJCF XML path."""
  tried: list[str] = []
  if mjcf_path:
    raw = str(mjcf_path).strip()
    if os.path.isdir(raw):
      picked = _pick_primary_xml_in_dir(raw, max_depth=3)
      if picked:
        return picked
    for cand in _expand_mjcf_candidates(raw):
      tried.append(cand)
      if os.path.isfile(cand):
        return cand

  env_mjcf = os.environ.get("ROBOT_MJCF_PATH", "").strip()
  if env_mjcf:
    if os.path.isdir(env_mjcf):
      picked = _pick_primary_xml_in_dir(env_mjcf, max_depth=3)
      if picked:
        return picked
    for cand in _expand_mjcf_candidates(env_mjcf):
      tried.append(cand)
      if os.path.isfile(cand):
        return cand

  ws_dirs = ["."]
  for ws in ws_dirs:
    if not ws:
      continue
    rm_dir = os.path.join(ws, "robot_model")
    tried.append(rm_dir)
    picked = _pick_primary_xml_in_dir(rm_dir, max_depth=3)
    if picked:
      return picked

  # Extract documented MJCF path from workspace README.md if present.
  xml_pat = re.compile(r"(/[^\s`\"'()<>]+?\.xml)")
  for ws in ws_dirs:
    if not ws:
      continue
    readme_p = os.path.join(ws, "README.md")
    if os.path.isfile(readme_p):
      try:
        with open(readme_p, "r", encoding="utf-8", errors="ignore") as f:
          txt = f.read(65536)
        for match in xml_pat.findall(txt):
          for cand in _expand_mjcf_candidates(match):
            tried.append(cand)
            if os.path.isfile(cand):
              return cand
      except OSError:
        pass

  # Check workspace *spec*.json files.
  for ws in ws_dirs:
    if not ws or not os.path.isdir(ws):
      continue
    try:
      ws_files = sorted(os.listdir(ws))
    except OSError:
      continue
    for fname in ws_files:
      low_f = fname.lower()
      if not (low_f.endswith(".json") and "spec" in low_f):
        continue
      spec_p = os.path.join(ws, fname)
      if not os.path.isfile(spec_p):
        continue
      try:
        with open(spec_p, "r", encoding="utf-8", errors="ignore") as f:
          txt = f.read(65536).replace("\\/", "/")
        for match in xml_pat.findall(txt):
          for cand in _expand_mjcf_candidates(match):
            tried.append(cand)
            if os.path.isfile(cand):
              return cand
      except OSError:
        pass

  picked_cwd = _pick_primary_xml_in_dir(".", max_depth=1)
  if picked_cwd:
    return picked_cwd

  # Bounded scan of dedicated asset directories (never walk a monorepo root).
  for asset_dir in (
      os.environ.get("ROBOT_ASSETS_ROOT", ""),
      os.environ.get("MUJOCO_ASSETS_ROOT", ""),
      "/usr/share/mujoco_assets",
  ):
    if not asset_dir or not os.path.isdir(asset_dir):
      continue
    if os.path.exists(os.path.join(asset_dir, "WORKSPACE")):
      continue
    tried.append(asset_dir)
    picked = _pick_primary_xml_in_dir(asset_dir, max_depth=4)
    if picked:
      return picked

  raise FileNotFoundError(
      f"Could not resolve MJCF path from {mjcf_path!r} (checked {tried})."
  )


_resolve_mjcf_path = resolve_mjcf_path


_GRIPPER_JOINT_KEYWORDS: tuple[str, ...] = (
    "finger",
    "gripper",
    "driver",
    "follower",
    "coupler",
    "spring_link",
    "compliance",
    "thumb",
    "index",
    "middle",
    "ring",
    "pinky",
    "knuckle",
    "claw",
    "jaw",
)


def _body_is_descendant(
    model: mujoco.MjModel, body_id: int, root_body_id: int
) -> bool:
  """Returns True if `body_id == root_body_id` or descends from `root_body_id`."""
  cur = int(body_id)
  while cur > 0:
    if cur == root_body_id:
      return True
    cur = int(model.body_parentid[cur])
  return cur == root_body_id


def _body_lca(model: mujoco.MjModel, b1: int, b2: int) -> int:
  """Returns lowest common ancestor body ID of `b1` and `b2`."""
  anc1: set[int] = set()
  cur = int(b1)
  while cur >= 0:
    anc1.add(cur)
    if cur == 0:
      break
    cur = int(model.body_parentid[cur])
  cur = int(b2)
  while cur >= 0:
    if cur in anc1:
      return cur
    if cur == 0:
      break
    cur = int(model.body_parentid[cur])
  return 0


class _GripperController:
  """Articulates arbitrary MuJoCo grippers via actuators, tendons, & equality."""

  def __init__(
      self,
      model: mujoco.MjModel,
      last_joint_body: int,
      ee_site_id: int,
  ) -> None:
    self.model = model
    self.last_joint_body = int(last_joint_body)
    self.ee_site_id = int(ee_site_id)
    self.gripper_bodies: set[int] = {
        b
        for b in range(1, int(model.nbody))
        if b != self.last_joint_body
        and _body_is_descendant(model, b, self.last_joint_body)
    }
    hinge_t = int(mujoco.mjtJoint.mjJNT_HINGE)
    slide_t = int(mujoco.mjtJoint.mjJNT_SLIDE)
    self.gripper_jids: list[int] = [
        jid
        for jid in range(int(model.njnt))
        if int(model.jnt_bodyid[jid]) in self.gripper_bodies
        and int(model.jnt_type[jid]) in (hinge_t, slide_t)
    ]
    self.compliance_jids: set[int] = set()
    for jid in self.gripper_jids:
      jname = (
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), jid) or ""
      ).lower()
      if "compliance" in jname:
        self.compliance_jids.add(jid)

    self.actuator_id: int = -1
    self.actuator_name: str | None = None
    self.ctrlrange: list[float] | None = None
    self.driver_jids: list[int] = []
    self._driver_ranges: list[tuple[float, float]] = []

    if self.gripper_jids:
      g_set = set(self.gripper_jids)
      trn_joint = int(mujoco.mjtTrn.mjTRN_JOINT)
      trn_tendon = int(mujoco.mjtTrn.mjTRN_TENDON)
      wrap_joint = int(mujoco.mjtWrap.mjWRAP_JOINT)
      joint_acts: list[int] = []
      tendon_acts: list[tuple[int, list[int]]] = []
      for aid in range(int(model.nu)):
        ttype = int(model.actuator_trntype[aid])
        tid = int(model.actuator_trnid[aid, 0])
        if ttype == trn_joint and tid in g_set:
          joint_acts.append(aid)
        elif ttype == trn_tendon and 0 <= tid < int(model.ntendon):
          w_adr = int(model.tendon_adr[tid])
          w_num = int(model.tendon_num[tid])
          wrapped = [
              int(model.wrap_objid[w_adr + k])
              for k in range(w_num)
              if int(model.wrap_type[w_adr + k]) == wrap_joint
              and int(model.wrap_objid[w_adr + k]) in g_set
          ]
          if wrapped:
            tendon_acts.append((aid, wrapped))

      if joint_acts:
        self.actuator_id = joint_acts[0]
        self.actuator_name = (
            mujoco.mj_id2name(
                model, int(mujoco.mjtObj.mjOBJ_ACTUATOR), self.actuator_id
            )
            or f"actuator_{self.actuator_id}"
        )
        if int(model.actuator_ctrllimited[self.actuator_id]):
          self.ctrlrange = [
              round(float(model.actuator_ctrlrange[self.actuator_id, 0]), 5),
              round(float(model.actuator_ctrlrange[self.actuator_id, 1]), 5),
          ]
        for aid in joint_acts:
          jid = int(model.actuator_trnid[aid, 0])
          j_lo, j_hi = self._joint_limits(jid)
          # Use position-servo ctrlrange if it directly commands joint position
          if (
              int(model.actuator_ctrllimited[aid])
              and int(model.actuator_dyntype[aid])
              == int(mujoco.mjtDyn.mjDYN_NONE)
              and float(model.actuator_biasprm[aid, 1]) < -1e-6
          ):
            gain = float(model.actuator_gainprm[aid, 0])
            bias = -float(model.actuator_biasprm[aid, 1])
            scale = gain / bias if abs(bias) > 1e-9 else 1.0
            c0 = scale * float(model.actuator_ctrlrange[aid, 0])
            c1 = scale * float(model.actuator_ctrlrange[aid, 1])
            lo_eff = max(j_lo, min(c0, c1))
            hi_eff = min(j_hi, max(c0, c1))
            if hi_eff > lo_eff + 1e-6:
              j_lo, j_hi = lo_eff, hi_eff
          self.driver_jids.append(jid)
          self._driver_ranges.append((j_lo, j_hi))
      elif tendon_acts:
        self.actuator_id, wrapped = tendon_acts[0]
        self.actuator_name = (
            mujoco.mj_id2name(
                model, int(mujoco.mjtObj.mjOBJ_ACTUATOR), self.actuator_id
            )
            or f"actuator_{self.actuator_id}"
        )
        if int(model.actuator_ctrllimited[self.actuator_id]):
          self.ctrlrange = [
              round(float(model.actuator_ctrlrange[self.actuator_id, 0]), 5),
              round(float(model.actuator_ctrlrange[self.actuator_id, 1]), 5),
          ]
        for jid in wrapped:
          self.driver_jids.append(jid)
          self._driver_ranges.append(self._joint_limits(jid))
      else:
        # Standalone XML without actuators: drive top-level finger joints.
        for jid in self.gripper_jids:
          if jid in self.compliance_jids:
            continue
          b = int(model.jnt_bodyid[jid])
          has_upper_jnt = False
          p = int(model.body_parentid[b])
          while p > 0 and p != self.last_joint_body:
            if int(model.body_jntnum[p]) > 0:
              has_upper_jnt = True
              break
            p = int(model.body_parentid[p])
          if not has_upper_jnt:
            self.driver_jids.append(jid)
            self._driver_ranges.append(self._joint_limits(jid))

    # Pre-index mjEQ_JOINT and mjEQ_CONNECT constraints touching gripper subtree
    g_set = set(self.gripper_jids)
    self._eq_joints: list[tuple[int, int, np.ndarray]] = []
    self._eq_connects: list[tuple[int, int, np.ndarray, np.ndarray]] = []
    data0 = mujoco.MjData(model)
    data0.qpos[:] = model.qpos0
    mujoco.mj_kinematics(model, data0)
    for eq_id in range(int(model.neq)):
      eq_t = int(model.eq_type[eq_id])
      if eq_t == int(mujoco.mjtEq.mjEQ_JOINT):
        j1 = int(model.eq_obj1id[eq_id])
        j2 = int(model.eq_obj2id[eq_id])
        if j1 in g_set or j2 in g_set:
          poly = np.asarray(model.eq_data[eq_id, :5], dtype=np.float64).copy()
          self._eq_joints.append((j1, j2, poly))
      elif eq_t == int(mujoco.mjtEq.mjEQ_CONNECT):
        b1 = int(model.eq_obj1id[eq_id])
        b2 = int(model.eq_obj2id[eq_id])
        if b1 in self.gripper_bodies or b2 in self.gripper_bodies:
          a1 = np.asarray(model.eq_data[eq_id, :3], dtype=np.float64).copy()
          p1_0 = np.asarray(data0.xpos[b1], dtype=np.float64)
          r1_0 = np.asarray(data0.xmat[b1], dtype=np.float64).reshape(3, 3)
          p2_0 = np.asarray(data0.xpos[b2], dtype=np.float64)
          r2_0 = np.asarray(data0.xmat[b2], dtype=np.float64).reshape(3, 3)
          w_anchor = p1_0 + r1_0 @ a1
          a2 = r2_0.T @ (w_anchor - p2_0)
          self._eq_connects.append((b1, b2, a1, a2))

    # Calibrate which endpoint of s in {0.0, 1.0} physically opens vs closes jaws
    self.s_open = 0.0
    self.s_closed = 1.0
    if self.driver_jids:
      spread_0 = self._measure_finger_spread(0.0)
      spread_1 = self._measure_finger_spread(1.0)
      if spread_1 > spread_0 + 1e-5:
        self.s_open = 1.0
        self.s_closed = 0.0

  def _joint_limits(self, jid: int) -> tuple[float, float]:
    if int(self.model.jnt_limited[jid]):
      return (
          float(self.model.jnt_range[jid, 0]),
          float(self.model.jnt_range[jid, 1]),
      )
    return (-0.8, 0.8)

  def _apply_raw_s(self, data: mujoco.MjData, s: float) -> None:
    """Sets gripper `qpos` for raw normalized range coordinate `s in [0, 1]`."""
    if not self.driver_jids:
      return
    s_clamped = float(np.clip(s, 0.0, 1.0))
    known: set[int] = set(self.compliance_jids)
    for jid in self.compliance_jids:
      qadr = int(self.model.jnt_qposadr[jid])
      data.qpos[qadr] = float(self.model.qpos0[qadr])

    primary_delta = 0.0
    for idx, (jid, (lo, hi)) in enumerate(
        zip(self.driver_jids, self._driver_ranges, strict=True)
    ):
      qadr = int(self.model.jnt_qposadr[jid])
      val = (1.0 - s_clamped) * lo + s_clamped * hi
      data.qpos[qadr] = val
      if idx == 0:
        primary_delta = val - float(self.model.qpos0[qadr])
      known.add(jid)

    # Propagate mjEQ_JOINT polynomial mimic constraints (both directions)
    for _ in range(3):
      progressed = False
      for j1, j2, poly in self._eq_joints:
        qadr1 = int(self.model.jnt_qposadr[j1])
        qadr2 = int(self.model.jnt_qposadr[j2])
        q1_0 = float(self.model.qpos0[qadr1])
        q2_0 = float(self.model.qpos0[qadr2])
        if j2 in known and j1 not in known:
          dq2 = float(data.qpos[qadr2]) - q2_0
          dq1 = (
              poly[0]
              + poly[1] * dq2
              + poly[2] * (dq2**2)
              + poly[3] * (dq2**3)
              + poly[4] * (dq2**4)
          )
          lo1, hi1 = self._joint_limits(j1)
          data.qpos[qadr1] = float(np.clip(q1_0 + dq1, lo1, hi1))
          known.add(j1)
          progressed = True
        elif j1 in known and j2 not in known:
          lhs = float(data.qpos[qadr1]) - q1_0
          dq2 = (lhs - poly[0]) / poly[1] if abs(poly[1]) > 1e-9 else 0.0
          if np.any(np.abs(poly[2:]) > 1e-12):
            for _ in range(6):
              f_val = (
                  poly[0]
                  + poly[1] * dq2
                  + poly[2] * (dq2**2)
                  + poly[3] * (dq2**3)
                  + poly[4] * (dq2**4)
                  - lhs
              )
              df_val = (
                  poly[1]
                  + 2.0 * poly[2] * dq2
                  + 3.0 * poly[3] * (dq2**2)
                  + 4.0 * poly[4] * (dq2**3)
              )
              if abs(df_val) > 1e-9:
                dq2 -= f_val / df_val
          lo2, hi2 = self._joint_limits(j2)
          data.qpos[qadr2] = float(np.clip(q2_0 + dq2, lo2, hi2))
          known.add(j2)
          progressed = True
      if not progressed:
        break

    passive_jids = [j for j in self.gripper_jids if j not in known]
    if not passive_jids:
      return

    # Seed passive 4-bar linkage joints near parallel-jaw geometry before loop IK
    for jid in passive_jids:
      jname = (
          mujoco.mj_id2name(self.model, int(mujoco.mjtObj.mjOBJ_JOINT), jid)
          or ""
      ).lower()
      qadr = int(self.model.jnt_qposadr[jid])
      lo_p, hi_p = self._joint_limits(jid)
      q0_p = float(self.model.qpos0[qadr])
      if "spring" in jname:
        data.qpos[qadr] = float(np.clip(q0_p + primary_delta, lo_p, hi_p))
      elif "follower" in jname:
        data.qpos[qadr] = float(np.clip(q0_p - primary_delta, lo_p, hi_p))
      else:
        data.qpos[qadr] = q0_p

    if self._eq_connects:
      p_qadrs = np.array(
          [int(self.model.jnt_qposadr[j]) for j in passive_jids], dtype=np.int32
      )
      p_limits = np.array(
          [self._joint_limits(j) for j in passive_jids], dtype=np.float64
      )
      q_seed = data.qpos[p_qadrs].copy()
      n_p = len(passive_jids)
      m_eq = 3 * len(self._eq_connects)
      eps = 1e-5

      def _connect_residual() -> np.ndarray:
        mujoco.mj_kinematics(self.model, data)
        res = np.empty(m_eq, dtype=np.float64)
        for k, (b1, b2, a1, a2) in enumerate(self._eq_connects):
          w1 = np.asarray(data.xpos[b1], dtype=np.float64) + (
              np.asarray(data.xmat[b1], dtype=np.float64).reshape(3, 3) @ a1
          )
          w2 = np.asarray(data.xpos[b2], dtype=np.float64) + (
              np.asarray(data.xmat[b2], dtype=np.float64).reshape(3, 3) @ a2
          )
          res[3 * k : 3 * k + 3] = w1 - w2
        return res

      for _ in range(10):
        r0 = _connect_residual()
        if float(np.linalg.norm(r0)) < 1e-6:
          break
        q_cur = data.qpos[p_qadrs].copy()
        jac = np.zeros((m_eq, n_p), dtype=np.float64)
        for col in range(n_p):
          data.qpos[p_qadrs[col]] = q_cur[col] + eps
          rp = _connect_residual()
          data.qpos[p_qadrs[col]] = q_cur[col]
          jac[:, col] = (rp - r0) / eps
        lhs = jac.T @ jac + 1e-4 * np.eye(n_p, dtype=np.float64)
        rhs = -(jac.T @ r0) - 1e-5 * (q_cur - q_seed)
        dq = np.linalg.solve(lhs, rhs)
        data.qpos[p_qadrs] = np.clip(q_cur + dq, p_limits[:, 0], p_limits[:, 1])

  def _measure_finger_spread(self, s: float) -> float:
    data = mujoco.MjData(self.model)
    data.qpos[:] = self.model.qpos0
    self._apply_raw_s(data, s)
    mujoco.mj_kinematics(self.model, data)
    if self.ee_site_id >= 0:
      ref = np.asarray(data.site_xpos[self.ee_site_id], dtype=np.float64)
    else:
      ref = np.asarray(data.xpos[self.last_joint_body], dtype=np.float64)
    pts: list[np.ndarray] = []
    for gid in range(int(self.model.ngeom)):
      bid = int(self.model.geom_bodyid[gid])
      if bid not in self.gripper_bodies:
        continue
      if int(self.model.geom_group[gid]) == 2:
        continue
      pts.append(np.asarray(data.geom_xpos[gid], dtype=np.float64).copy())
    if not pts:
      pts = [
          np.asarray(data.xpos[b], dtype=np.float64).copy()
          for b in sorted(self.gripper_bodies)
      ]
    if not pts:
      return 0.0
    arr = np.asarray(pts, dtype=np.float64) - ref[None, :]
    return float(np.sqrt(np.mean(np.sum(arr * arr, axis=1))))

  def normalize_cmd(self, gripper_cmd: float) -> float:
    """Normalizes `gripper_cmd` (`[0, 1]` open->closed, or native `ctrlrange`)."""
    val = float(gripper_cmd)
    if -1e-6 <= val <= 1.0 + 1e-6:
      return float(np.clip(val, 0.0, 1.0))
    if (
        self.ctrlrange is not None
        and self.ctrlrange[1] > self.ctrlrange[0] + 1e-9
    ):
      s_raw = float(
          np.clip(
              (val - self.ctrlrange[0])
              / (self.ctrlrange[1] - self.ctrlrange[0]),
              0.0,
              1.0,
          )
      )
      return s_raw if self.s_open < self.s_closed else (1.0 - s_raw)
    return float(np.clip(val, 0.0, 1.0))

  def apply_cmd(self, data: mujoco.MjData, gripper_cmd: float) -> None:
    """Applies `gripper_cmd` (`0.0=open, 1.0=closed` or native ctrl) to `data`."""
    alpha = self.normalize_cmd(gripper_cmd)
    s = (1.0 - alpha) * self.s_open + alpha * self.s_closed
    self._apply_raw_s(data, s)

  @property
  def open_ctrl(self) -> float | None:
    if self.ctrlrange is None:
      return None
    return self.ctrlrange[0] if self.s_open < 0.5 else self.ctrlrange[1]

  @property
  def closed_ctrl(self) -> float | None:
    if self.ctrlrange is None:
      return None
    return self.ctrlrange[1] if self.s_closed > 0.5 else self.ctrlrange[0]


@dataclasses.dataclass(frozen=True)
class _DiscoveredArmSpec:
  arm_name: str
  joint_ids: tuple[int, ...]
  joint_names: tuple[str, ...]
  ee_site_id: int
  ee_site_name: str
  shared_ancestor_bodies: frozenset[int]


def _select_ee_site_for_arm(
    model: mujoco.MjModel, last_joint_body: int
) -> tuple[int, str]:
  """Selects the best rigid TCP/grasp `<site>` under `last_joint_body`."""
  data0 = mujoco.MjData(model)
  data0.qpos[:] = model.qpos0
  mujoco.mj_kinematics(model, data0)
  wrist_pos = np.asarray(data0.xpos[last_joint_body], dtype=np.float64)

  rigid_bodies: set[int] = {last_joint_body}
  for b in range(1, int(model.nbody)):
    if b == last_joint_body or not _body_is_descendant(
        model, b, last_joint_body
    ):
      continue
    cur = b
    has_moving_jnt = False
    while cur > 0 and cur != last_joint_body:
      if int(model.body_jntnum[cur]) > 0:
        has_moving_jnt = True
        break
      cur = int(model.body_parentid[cur])
    if not has_moving_jnt:
      rigid_bodies.add(b)

  skip_tokens = ("tactile", "sensor", "force", "torque", "cam", "zed", "imu")

  def _site_rank(sid: int) -> tuple[int, int, float]:
    sname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_SITE), sid) or ""
    ).lower()
    sbid = int(model.site_bodyid[sid])
    is_rigid = 0 if sbid in rigid_bodies else 1
    leaf = sname.split("/")[-1]
    tokens = set(re.split(r"[/_\-\s]+", sname))
    if any(t in sname for t in skip_tokens):
      tier = 9
    elif (
        "pinch" in leaf
        or "grasp" in leaf
        or ("pinch" in tokens)
        or ("grasp" in tokens)
    ):
      tier = 0
    elif any(k in leaf for k in ("tcp", "grip", "palm")) or any(
        k in tokens for k in ("tcp", "grip", "gripper", "palm")
    ):
      tier = 1
    elif (
        any(k in tokens for k in ("ee", "tool", "tip"))
        or "end_effector" in sname
    ):
      tier = 2
    elif any(k in leaf for k in ("attachment", "flange", "wrist")):
      tier = 3
    else:
      tier = 4
    spos = np.asarray(data0.site_xpos[sid], dtype=np.float64)
    dist = float(np.linalg.norm(spos - wrist_pos))
    return (is_rigid, tier, -dist)

  candidates = [
      sid
      for sid in range(int(model.nsite))
      if _body_is_descendant(
          model, int(model.site_bodyid[sid]), last_joint_body
      )
  ]
  if candidates:
    best_sid = min(candidates, key=_site_rank)
    if _site_rank(best_sid)[1] < 9:
      sname = (
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_SITE), best_sid)
          or f"site_{best_sid}"
      )
      return int(best_sid), sname

  bname = (
      mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_BODY), last_joint_body)
      or f"body_{last_joint_body}"
  )
  return -1, bname


def _discover_robot_arms(
    model: mujoco.MjModel,
) -> dict[str, _DiscoveredArmSpec]:
  """Auto-discovers serial manipulator arm chains and EE TCP sites in `model`."""
  children: dict[int, list[int]] = {b: [] for b in range(int(model.nbody))}
  for b in range(1, int(model.nbody)):
    children[int(model.body_parentid[b])].append(b)

  # Exclude mimic, closed-loop linkage, multi-joint tendon, and finger joints
  non_arm_jids: set[int] = set()
  for eq_id in range(int(model.neq)):
    eq_t = int(model.eq_type[eq_id])
    if eq_t == int(mujoco.mjtEq.mjEQ_JOINT):
      non_arm_jids.add(int(model.eq_obj1id[eq_id]))
      non_arm_jids.add(int(model.eq_obj2id[eq_id]))
    elif eq_t == int(mujoco.mjtEq.mjEQ_CONNECT):
      b1 = int(model.eq_obj1id[eq_id])
      b2 = int(model.eq_obj2id[eq_id])
      lca = _body_lca(model, b1, b2)
      for b in range(1, int(model.nbody)):
        if b != lca and _body_is_descendant(model, b, lca):
          for off in range(int(model.body_jntnum[b])):
            non_arm_jids.add(int(model.body_jntadr[b]) + off)

  wrap_joint = int(mujoco.mjtWrap.mjWRAP_JOINT)
  for tid in range(int(model.ntendon)):
    w_num = int(model.tendon_num[tid])
    if w_num > 1:
      w_adr = int(model.tendon_adr[tid])
      for k in range(w_num):
        if int(model.wrap_type[w_adr + k]) == wrap_joint:
          non_arm_jids.add(int(model.wrap_objid[w_adr + k]))

  trn_joint = int(mujoco.mjtTrn.mjTRN_JOINT)
  for aid in range(int(model.nu)):
    aname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_ACTUATOR), aid) or ""
    ).lower()
    if any(k in aname for k in ("gripper", "finger", "hand", "claw", "jaw")):
      if int(model.actuator_trntype[aid]) == trn_joint:
        non_arm_jids.add(int(model.actuator_trnid[aid, 0]))

  hinge_t = int(mujoco.mjtJoint.mjJNT_HINGE)
  slide_t = int(mujoco.mjtJoint.mjJNT_SLIDE)
  arm_jids_by_body: dict[int, list[int]] = {
      b: [] for b in range(int(model.nbody))
  }
  for jid in range(int(model.njnt)):
    jtype = int(model.jnt_type[jid])
    if jtype not in (hinge_t, slide_t) or jid in non_arm_jids:
      continue
    jname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), jid) or ""
    ).lower()
    if any(k in jname for k in _GRIPPER_JOINT_KEYWORDS):
      continue
    arm_jids_by_body[int(model.jnt_bodyid[jid])].append(jid)

  max_serial: dict[int, int] = {}

  def _calc_serial(b: int) -> int:
    best_child = max((_calc_serial(c) for c in children[b]), default=0)
    val = len(arm_jids_by_body[b]) + best_child
    max_serial[b] = val
    return val

  total_max = _calc_serial(0)
  min_arm_dof = 4 if total_max >= 4 else max(1, total_max)

  raw_chains: list[tuple[int, list[int]]] = []

  def _extract_chains(b: int, split_anc: int) -> None:
    arm_children = [c for c in children[b] if max_serial[c] >= min_arm_dof]
    if len(arm_children) >= 2:
      for c in arm_children:
        _extract_chains(c, b)
      return
    if len(arm_children) == 1 and not arm_jids_by_body[b]:
      _extract_chains(arm_children[0], split_anc)
      return
    # Follow a single serial arm chain down from `b`
    chain_jids: list[int] = []
    cur = b
    while True:
      chain_jids.extend(arm_jids_by_body[cur])
      pos_children = [c for c in children[cur] if max_serial[c] > 0]
      if not pos_children:
        break
      if (
          len(pos_children) >= 2
          and len(chain_jids) >= min_arm_dof
          and max(max_serial[c] for c in pos_children) <= 2
      ):
        # Symmetric short leaf branches at end of arm = multi-finger gripper
        break
      cur = max(pos_children, key=lambda c: max_serial[c])
    if len(chain_jids) >= min_arm_dof:
      raw_chains.append((split_anc, chain_jids))

  _extract_chains(0, 0)
  if not raw_chains:
    return {}

  # Shared ancestor bodies are bodies at or above any multi-arm split point
  shared_bodies: set[int] = {0}
  if len(raw_chains) >= 2:
    for i in range(len(raw_chains)):
      for j in range(i + 1, len(raw_chains)):
        b_i = int(model.jnt_bodyid[raw_chains[i][1][0]])
        b_j = int(model.jnt_bodyid[raw_chains[j][1][0]])
        lca = _body_lca(model, b_i, b_j)
        cur = lca
        while cur > 0:
          shared_bodies.add(cur)
          cur = int(model.body_parentid[cur])

  data0 = mujoco.MjData(model)
  data0.qpos[:] = model.qpos0
  mujoco.mj_kinematics(model, data0)

  named_specs: dict[str, _DiscoveredArmSpec] = {}
  unnamed_entries: list[tuple[float, list[int]]] = []
  for _, jids in raw_chains:
    tokens: set[str] = set()
    for jid in jids:
      jn = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), jid) or ""
      bn = (
          mujoco.mj_id2name(
              model, int(mujoco.mjtObj.mjOBJ_BODY), int(model.jnt_bodyid[jid])
          )
          or ""
      )
      tokens.update(re.split(r"[/_\-\s]+", jn.lower()))
      tokens.update(re.split(r"[/_\-\s]+", bn.lower()))
    side = ""
    if "left" in tokens or "l" in tokens:
      side = "left"
    elif "right" in tokens or "r" in tokens:
      side = "right"
    if side and side not in named_specs:
      jnames = tuple(
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), j)
          or f"joint_{j}"
          for j in jids
      )
      sid, sname = _select_ee_site_for_arm(
          model, int(model.jnt_bodyid[jids[-1]])
      )
      named_specs[side] = _DiscoveredArmSpec(
          arm_name=side,
          joint_ids=tuple(jids),
          joint_names=jnames,
          ee_site_id=sid,
          ee_site_name=sname,
          shared_ancestor_bodies=frozenset(shared_bodies),
      )
    else:
      base_b = int(model.jnt_bodyid[jids[0]])
      unnamed_entries.append((float(data0.xpos[base_b, 1]), jids))

  if unnamed_entries:
    if len(raw_chains) == 1 and not named_specs:
      jids = unnamed_entries[0][1]
      jnames = tuple(
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), j)
          or f"joint_{j}"
          for j in jids
      )
      sid, sname = _select_ee_site_for_arm(
          model, int(model.jnt_bodyid[jids[-1]])
      )
      named_specs["arm"] = _DiscoveredArmSpec(
          arm_name="arm",
          joint_ids=tuple(jids),
          joint_names=jnames,
          ee_site_id=sid,
          ee_site_name=sname,
          shared_ancestor_bodies=frozenset(shared_bodies),
      )
    else:
      unnamed_entries.sort(key=lambda item: -item[0])
      fallback_names = (
          ["left", "right"]
          if len(unnamed_entries) == 2 and not named_specs
          else [f"arm_{idx}" for idx in range(len(unnamed_entries))]
      )
      for aname, (_, jids) in zip(fallback_names, unnamed_entries, strict=True):
        key = aname if aname not in named_specs else f"arm_{len(named_specs)}"
        jnames = tuple(
            mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), j)
            or f"joint_{j}"
            for j in jids
        )
        sid, sname = _select_ee_site_for_arm(
            model, int(model.jnt_bodyid[jids[-1]])
        )
        named_specs[key] = _DiscoveredArmSpec(
            arm_name=key,
            joint_ids=tuple(jids),
            joint_names=jnames,
            ee_site_id=sid,
            ee_site_name=sname,
            shared_ancestor_bodies=frozenset(shared_bodies),
        )

  ordered: dict[str, _DiscoveredArmSpec] = {}
  for pref in ("left", "right", "arm"):
    if pref in named_specs:
      ordered[pref] = named_specs[pref]
  for k, v in named_specs.items():
    if k not in ordered:
      ordered[k] = v
  return ordered


def _format_axis_label_ee(
    vec: Sequence[float] | np.ndarray, signed: bool = True
) -> str:
  """Formats an EE-frame unit vector cleanly (e.g. `'+Z_ee'` or `'±Y_ee'`)."""
  v = np.asarray(vec, dtype=np.float64).reshape(3)
  idx = int(np.argmax(np.abs(v)))
  names = ("X_ee", "Y_ee", "Z_ee")
  if abs(float(v[idx])) > 0.92:
    if not signed:
      return f"±{names[idx]}"
    sign_ch = "+" if float(v[idx]) >= 0.0 else "-"
    return f"{sign_ch}{names[idx]}"
  return f"[{v[0]:+.2f}, {v[1]:+.2f}, {v[2]:+.2f}]_ee"


def describe_robot(mjcf_path: str | None = None) -> dict[str, Any]:
  """Introspects an MJCF robot model and returns a Turn-1 cheat-sheet dict."""
  resolved = resolve_mjcf_path(mjcf_path)
  model = mujoco.MjModel.from_xml_path(resolved)
  arm_specs = _discover_robot_arms(model)
  raw_names_buf = bytes(getattr(model, "names", b""))
  raw_model_name = raw_names_buf.split(b"\x00", 1)[0].decode(
      "utf-8", errors="ignore"
  )
  if not raw_model_name or raw_model_name == "MuJoCo Model":
    raw_model_name = os.path.splitext(os.path.basename(resolved))[0]

  arm_body_sets: set[int] = set()
  for spec in arm_specs.values():
    first_b = int(model.jnt_bodyid[spec.joint_ids[0]])
    for b in range(1, int(model.nbody)):
      if _body_is_descendant(model, b, first_b):
        arm_body_sets.add(b)

  cameras: list[dict[str, Any]] = []
  for cid in range(int(model.ncam)):
    cname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_CAMERA), cid)
        or f"cam_{cid}"
    )
    short = cname.split("/")[-1]
    cbid = int(model.cam_bodyid[cid])
    bname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_BODY), cbid)
        or f"body_{cbid}"
    )
    cameras.append({
        "name": cname,
        "short_name": short,
        "parent_body": bname,
        "is_wrist_camera": cbid in arm_body_sets,
    })

  arms_out: dict[str, dict[str, Any]] = {}
  lines: list[str] = [
      f"Robot: {raw_model_name} ({resolved})",
      "Cameras: "
      + (
          ", ".join(
              f"{c['short_name']}({'wrist' if c['is_wrist_camera'] else 'fixed'})"
              for c in cameras
          )
          if cameras
          else "none"
      ),
  ]
  for arm_name, spec in arm_specs.items():
    planner = RobotArmPlanner(
        mjcf_path=resolved,
        arm=arm_name,
        joint_names=spec.joint_names,
        ee_site_name=spec.ee_site_name if spec.ee_site_id >= 0 else None,
        gripper_cmd=0.0,
    )
    ginfo = planner.gripper_frame_info(0.0)
    g_ctrl = planner._gripper_ctrl  # pylint: disable=protected-access
    arm_entry = {
        "joint_names": list(planner.joint_names),
        "dof": int(planner.dof),
        "q_min": np.round(planner.q_min, 4).tolist(),
        "q_max": np.round(planner.q_max, 4).tolist(),
        "ee_site_name": planner.ee_site_name,
        "gripper_actuator": g_ctrl.actuator_name,
        "gripper_ctrlrange": g_ctrl.ctrlrange,
        "gripper_open_ctrl": g_ctrl.open_ctrl,
        "gripper_closed_ctrl": g_ctrl.closed_ctrl,
        "gripper_frame_info": ginfo,
    }
    arms_out[arm_name] = arm_entry

    app_lbl = _format_axis_label_ee(ginfo["approach_axis_ee"], signed=True)
    cls_lbl = _format_axis_label_ee(ginfo["closing_axis_ee"], signed=False)
    slm_lbl = _format_axis_label_ee(ginfo["slim_axis_ee"], signed=False)
    prots = ginfo["asymmetric_protrusions"]
    prot_str = (
        ", ".join(
            f"{p['axis_ee']}({1e3*p['max_extent_m']:.0f}mm)" for p in prots
        )
        if prots
        else "none"
    )
    lines.append(
        f"Arm '{arm_name}' ({planner.dof}-DoF):"
        f" joints={list(planner.joint_names)}, ee_site='{planner.ee_site_name}'"
    )
    lines.append(f"  q_min={arm_entry['q_min']}, q_max={arm_entry['q_max']}")
    lines.append(
        f"  gripper: actuator={g_ctrl.actuator_name!r}"
        f" mjcf_ctrlrange={g_ctrl.ctrlrange} (mjcf_open={g_ctrl.open_ctrl},"
        f" mjcf_closed={g_ctrl.closed_ctrl}; planner gripper_cmd:"
        " 0.0=open..1.0=closed — check runtime action_spec for command scale)"
    )
    lines.append(
        f"  ee_axes: approach={app_lbl}, closing={cls_lbl}"
        f" (inner_gap open={1e3*ginfo['open_inner_gap_m']:.1f}mm"
        f" closed={1e3*ginfo['closed_inner_gap_m']:.1f}mm;"
        f" outer_w open={1e3*ginfo['open_outer_width_m']:.0f}mm"
        f" closed={1e3*ginfo['closed_outer_width_m']:.0f}mm),"
        f" slim={slm_lbl} (slim_w={1e3*ginfo['slim_profile_width_m']:.0f}mm),"
        f" protrusions={prot_str}"
    )

  return {
      "mjcf_path": resolved,
      "model_name": raw_model_name,
      "arms": arms_out,
      "cameras": cameras,
      "summary_text": "\n".join(lines),
  }


class RobotArmPlanner:
  """Plans collision-free arm + held-object motions from an MJCF robot model."""

  def __init__(
      self,
      mjcf_path: str | None = None,
      arm: str = "left",
      joint_names: Sequence[str] | None = None,
      ee_site_name: str | None = None,
      gripper_cmd: float = 0.0,
  ) -> None:
    self.mjcf_path = _resolve_mjcf_path(mjcf_path)
    self.arm = str(arm)
    self.mj_model = mujoco.MjModel.from_xml_path(self.mjcf_path)
    self.mj_data = mujoco.MjData(self.mj_model)

    arm_specs = _discover_robot_arms(self.mj_model)
    matched_spec: _DiscoveredArmSpec | None = None
    if self.arm in arm_specs:
      matched_spec = arm_specs[self.arm]
    elif len(arm_specs) == 1 and self.arm in ("left", "arm", "default", ""):
      matched_spec = next(iter(arm_specs.values()))
      if joint_names is None:
        self.arm = matched_spec.arm_name

    self._shared_ancestor_bodies: frozenset[int] = (
        matched_spec.shared_ancestor_bodies
        if matched_spec is not None
        else frozenset({0})
    )

    if joint_names is None:
      if matched_spec is None:
        raise ValueError(
            f"Arm {self.arm!r} not found in {self.mjcf_path!r}"
            f" (discovered arms: {list(arm_specs.keys())})."
        )
      joint_names = matched_spec.joint_names
    self.joint_names = tuple(str(j) for j in joint_names)
    self.dof = len(self.joint_names)
    if self.dof == 0:
      raise ValueError(f"Empty joint_names for arm {self.arm!r}.")

    jids: list[int] = []
    q_idx: list[int] = []
    d_idx: list[int] = []
    lo: list[float] = []
    hi: list[float] = []
    slide_t = int(mujoco.mjtJoint.mjJNT_SLIDE)
    for jname in self.joint_names:
      jid = mujoco.mj_name2id(
          self.mj_model, int(mujoco.mjtObj.mjOBJ_JOINT), jname
      )
      if jid < 0:
        raise ValueError(f"Joint {jname!r} not found in {self.mjcf_path!r}.")
      jids.append(int(jid))
      q_idx.append(int(self.mj_model.jnt_qposadr[jid]))
      d_idx.append(int(self.mj_model.jnt_dofadr[jid]))
      j_lo = float(self.mj_model.jnt_range[jid, 0])
      j_hi = float(self.mj_model.jnt_range[jid, 1])
      if (not int(self.mj_model.jnt_limited[jid])) or j_hi <= j_lo + 1e-9:
        if int(self.mj_model.jnt_type[jid]) == slide_t:
          j_lo, j_hi = -1.0, 1.0
        else:
          j_lo, j_hi = -math.pi, math.pi
      lo.append(j_lo)
      hi.append(j_hi)

    self.joint_ids = np.array(jids, dtype=np.int32)
    self.qpos_indices = np.array(q_idx, dtype=np.int32)
    self.dof_indices = np.array(d_idx, dtype=np.int32)
    self.q_min = np.array(lo, dtype=np.float64)
    self.q_max = np.array(hi, dtype=np.float64)
    self._last_joint_body = int(self.mj_model.jnt_bodyid[self.joint_ids[-1]])

    if ee_site_name is not None:
      self.ee_site_name = str(ee_site_name)
      self.ee_site_id = int(
          mujoco.mj_name2id(
              self.mj_model, int(mujoco.mjtObj.mjOBJ_SITE), self.ee_site_name
          )
      )
      if self.ee_site_id < 0:
        raise ValueError(f"EE site {self.ee_site_name!r} not found in MJCF.")
    elif matched_spec is not None:
      self.ee_site_id = int(matched_spec.ee_site_id)
      self.ee_site_name = matched_spec.ee_site_name
    else:
      sid, sname = _select_ee_site_for_arm(self.mj_model, self._last_joint_body)
      self.ee_site_id = sid
      self.ee_site_name = sname

    self._ee_body_id = (
        int(self.mj_model.site_bodyid[self.ee_site_id])
        if self.ee_site_id >= 0
        else self._last_joint_body
    )

    self._gripper_ctrl = _GripperController(
        self.mj_model, self._last_joint_body, self.ee_site_id
    )
    self._gripper_cmd = self._gripper_ctrl.normalize_cmd(gripper_cmd)

    # Check whether the arm subtree uses standard MuJoCo contact masks
    first_joint_body = int(self.mj_model.jnt_bodyid[self.joint_ids[0]])
    has_active = False
    for gid in range(int(self.mj_model.ngeom)):
      bid = int(self.mj_model.geom_bodyid[gid])
      if not _body_is_descendant(self.mj_model, bid, first_joint_body):
        continue
      if int(self.mj_model.geom_group[gid]) == 2:
        continue
      if (
          int(self.mj_model.geom_contype[gid]) != 0
          or int(self.mj_model.geom_conaffinity[gid]) != 0
      ):
        has_active = True
        break
    self._subtree_has_active_contacts = has_active
    self._geom_sphere_cache: dict[int, list[tuple[np.ndarray, float]]] = {}
    self._open_closed_ee_cache: (
        tuple[
            list[tuple[str, int, np.ndarray, float]],
            list[tuple[str, int, np.ndarray, float]],
        ]
        | None
    ) = None
    self._approach_axis_ee = np.array([0.0, 0.0, 1.0], dtype=np.float64)

    self._ee_to_obj_tf: np.ndarray | None = None
    self._attached_spheres_in_ee: list[LocalSphereSpec] = []
    self._ee_frame_index: int = -1
    self._frame_specs_py: list[
        tuple[int, str, int, np.ndarray, np.ndarray, np.ndarray]
    ] = []
    self._fast_frame_specs: list[tuple[Any, ...]] = []
    self._batch_frame_specs: list[tuple[Any, ...]] = []
    self._chain_spheres: list[_ChainSphereMeta] = []
    self._sphere_labels: tuple[str, ...] = ()
    self._sphere_frame_idx = np.zeros(0, dtype=np.int32)
    self._sphere_local_centers = np.zeros((0, 3), dtype=np.float64)
    self._sphere_radii = np.zeros(0, dtype=np.float64)
    self._self_col_pair_i = np.zeros(0, dtype=np.int32)
    self._self_col_pair_j = np.zeros(0, dtype=np.int32)
    self._self_col_r_sum = np.zeros(0, dtype=np.float64)
    self._self_col_r_thresh_sq = np.zeros(0, dtype=np.float64)
    self._sc_buf1 = np.zeros(0, dtype=np.float64)
    self._sc_buf2 = np.zeros(0, dtype=np.float64)
    self._sc_group_spheres: list[np.ndarray] = []
    self._sc_ga_idx = np.zeros(0, dtype=np.int32)
    self._sc_gb_idx = np.zeros(0, dtype=np.int32)
    self._rebuild_chain()

  def _cached_geom_spheres(
      self, geom_id: int
  ) -> list[tuple[np.ndarray, float]]:
    cached = self._geom_sphere_cache.get(geom_id)
    if cached is None:
      cached = _sample_geom_local_spheres(self.mj_model, geom_id)
      self._geom_sphere_cache[geom_id] = cached
    return cached

  def _is_collision_geom(self, geom_id: int) -> bool:
    """Selects collision geoms via contype/conaffinity with group-3 fallback."""
    gtype = int(self.mj_model.geom_type[geom_id])
    if gtype in (
        int(mujoco.mjtGeom.mjGEOM_PLANE),
        int(mujoco.mjtGeom.mjGEOM_HFIELD),
    ):
      return False
    g_group = int(self.mj_model.geom_group[geom_id])
    if g_group == 2:
      return False  # Pure visual mesh group
    g_name = (
        mujoco.mj_id2name(self.mj_model, int(mujoco.mjtObj.mjOBJ_GEOM), geom_id)
        or ""
    ).lower()
    if "visual" in g_name or g_name.endswith("_vis"):
      return False
    contype = int(self.mj_model.geom_contype[geom_id])
    conaffinity = int(self.mj_model.geom_conaffinity[geom_id])
    if contype != 0 or conaffinity != 0:
      return True
    if not self._subtree_has_active_contacts:
      if g_group == 3 or "collision" in g_name or "fingertip" in g_name:
        return True
    return False

  def _rebuild_chain(self) -> None:
    """Constructs kinematic frames & collision spheres matching `mj_model`."""
    ee_body_id = self._ee_body_id
    body_chain: list[int] = []
    cur = ee_body_id
    while cur > 0:
      body_chain.append(cur)
      cur = int(self.mj_model.body_parentid[cur])
    body_chain.reverse()

    joint_id_to_q_index = {
        int(jid): k for k, jid in enumerate(self.joint_ids.tolist())
    }

    frame_specs_py: list[
        tuple[int, str, int, np.ndarray, np.ndarray, np.ndarray]
    ] = []

    def _add_frame(
        name: str,
        parent_f: int,
        jtype_str: str,
        q_idx_f: int,
        pos_f: np.ndarray,
        rot_f: np.ndarray,
        rpy_f: np.ndarray,
        axis_f: np.ndarray,
    ) -> int:
      del name, rpy_f
      f_idx = len(frame_specs_py)
      frame_specs_py.append(
          (parent_f, jtype_str, q_idx_f, pos_f, rot_f, axis_f)
      )
      return f_idx

    body_to_frame: dict[int, int] = {0: -1}
    body_to_group: dict[int, int] = {0: 0}
    cur_group = 0
    z_unit = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    zero3 = np.zeros(3, dtype=np.float64)
    eye3 = np.eye(3, dtype=np.float64)

    for b_id in body_chain:
      parent_b = int(self.mj_model.body_parentid[b_id])
      parent_f = body_to_frame[parent_b]
      b_name = (
          mujoco.mj_id2name(self.mj_model, int(mujoco.mjtObj.mjOBJ_BODY), b_id)
          or f"body_{b_id}"
      )
      b_pos = np.asarray(self.mj_model.body_pos[b_id], dtype=np.float64)
      b_rot = quat_wxyz_to_matrix(self.mj_model.body_quat[b_id])
      b_rpy = matrix_to_rpy(b_rot)

      j_adr = int(self.mj_model.body_jntadr[b_id])
      j_num = int(self.mj_model.body_jntnum[b_id])
      planned_jid = -1
      for j_offset in range(j_num):
        cand = j_adr + j_offset
        if cand in joint_id_to_q_index:
          planned_jid = cand
          break

      if planned_jid < 0:
        f_idx = _add_frame(
            b_name, parent_f, "fixed", -1, b_pos, b_rot, b_rpy, z_unit
        )
      else:
        cur_group += 1
        q_k = joint_id_to_q_index[planned_jid]
        jtype_mj = int(self.mj_model.jnt_type[planned_jid])
        jtype_str = (
            "prismatic"
            if jtype_mj == int(mujoco.mjtJoint.mjJNT_SLIDE)
            else "revolute"
        )
        j_pos = np.asarray(self.mj_model.jnt_pos[planned_jid], dtype=np.float64)
        j_axis = np.asarray(
            self.mj_model.jnt_axis[planned_jid], dtype=np.float64
        )
        q_ref = float(
            self.mj_model.qpos0[int(self.mj_model.jnt_qposadr[planned_jid])]
        )
        # Note: if q_ref != 0, MuJoCo's joint rotation is about (q - q_ref)!
        if float(np.linalg.norm(j_pos)) < 1e-9 and abs(q_ref) < 1e-9:
          f_idx = _add_frame(
              b_name, parent_f, jtype_str, q_k, b_pos, b_rot, b_rpy, j_axis
          )
        else:
          if abs(q_ref) >= 1e-9:
            ax_u = j_axis / max(float(np.linalg.norm(j_axis)), 1e-12)
            if jtype_str == "revolute":
              q_neg = np.zeros(4, dtype=np.float64)
              mujoco.mju_axisAngle2Quat(q_neg, ax_u, -q_ref)
              r_ref_inv = quat_wxyz_to_matrix(q_neg)
              p_post = -j_pos
            else:
              r_ref_inv = eye3
              p_post = -j_pos - ax_u * q_ref
          else:
            r_ref_inv = eye3
            p_post = -j_pos
          f_pre = _add_frame(
              f"{b_name}_pre",
              parent_f,
              "fixed",
              -1,
              b_pos + b_rot @ j_pos,
              b_rot,
              b_rpy,
              z_unit,
          )
          f_j = _add_frame(
              f"{b_name}_jnt",
              f_pre,
              jtype_str,
              q_k,
              zero3,
              eye3,
              zero3,
              j_axis,
          )
          f_idx = _add_frame(
              b_name,
              f_j,
              "fixed",
              -1,
              r_ref_inv @ p_post,
              r_ref_inv,
              matrix_to_rpy(r_ref_inv),
              z_unit,
          )

      body_to_frame[b_id] = int(f_idx)
      body_to_group[b_id] = cur_group

    if self.ee_site_id >= 0:
      s_pos = np.asarray(
          self.mj_model.site_pos[self.ee_site_id], dtype=np.float64
      )
      s_rot = quat_wxyz_to_matrix(self.mj_model.site_quat[self.ee_site_id])
    else:
      s_pos = zero3.copy()
      s_rot = eye3.copy()
    s_rpy = matrix_to_rpy(s_rot)
    ee_parent_f = body_to_frame[ee_body_id]
    ee_f = _add_frame(
        self.ee_site_name, ee_parent_f, "fixed", -1, s_pos, s_rot, s_rpy, z_unit
    )

    first_joint_body = int(self.mj_model.jnt_bodyid[self.joint_ids[0]])
    last_joint_body = self._last_joint_body
    parent_first = int(self.mj_model.body_parentid[first_joint_body])
    parent_first_name = (
        mujoco.mj_id2name(
            self.mj_model, int(mujoco.mjtObj.mjOBJ_BODY), parent_first
        )
        or ""
    ).lower()
    is_env_pedestal = any(
        tok in parent_first_name
        for tok in ("pedestal", "table", "floor", "ground", "stand", "world")
    )
    if (
        parent_first > 0
        and parent_first not in self._shared_ancestor_bodies
        and int(self.mj_model.body_jntnum[parent_first]) == 0
        and not is_env_pedestal
    ):
      arm_root = parent_first
    else:
      arm_root = first_joint_body

    # Evaluate FK once with gripper articulated at _gripper_cmd
    tmp_data = mujoco.MjData(self.mj_model)
    tmp_data.qpos[:] = self.mj_model.qpos0
    self._gripper_ctrl.apply_cmd(tmp_data, self._gripper_cmd)
    mujoco.mj_kinematics(self.mj_model, tmp_data)

    if self.ee_site_id >= 0:
      ee_world_pos = np.asarray(
          tmp_data.site_xpos[self.ee_site_id], dtype=np.float64
      )
      ee_world_rot = np.asarray(
          tmp_data.site_xmat[self.ee_site_id], dtype=np.float64
      ).reshape(3, 3)
    else:
      ee_world_pos = np.asarray(
          tmp_data.xpos[last_joint_body], dtype=np.float64
      )
      ee_world_rot = np.asarray(
          tmp_data.xmat[last_joint_body], dtype=np.float64
      ).reshape(3, 3)

    wrist_w_pos = np.asarray(tmp_data.xpos[last_joint_body], dtype=np.float64)
    wrist_in_ee = ee_world_rot.T @ (wrist_w_pos - ee_world_pos)
    if float(np.linalg.norm(wrist_in_ee)) > 1e-4:
      raw_app = -wrist_in_ee / float(np.linalg.norm(wrist_in_ee))
      dom = int(np.argmax(np.abs(raw_app)))
      if abs(float(raw_app[dom])) > 0.90:
        snapped = np.zeros(3, dtype=np.float64)
        snapped[dom] = 1.0 if float(raw_app[dom]) >= 0.0 else -1.0
        self._approach_axis_ee = snapped
      else:
        self._approach_axis_ee = raw_app
    else:
      self._approach_axis_ee = np.array([0.0, 0.0, 1.0], dtype=np.float64)

    gripper_group = cur_group
    chain_spheres: list[_ChainSphereMeta] = []

    for g_id in range(int(self.mj_model.ngeom)):
      if not self._is_collision_geom(g_id):
        continue
      b_id = int(self.mj_model.geom_bodyid[g_id])
      if not _body_is_descendant(self.mj_model, b_id, arm_root):
        continue
      local_spheres = self._cached_geom_spheres(g_id)
      if not local_spheres:
        continue

      b_short = (
          mujoco.mj_id2name(self.mj_model, int(mujoco.mjtObj.mjOBJ_BODY), b_id)
          or f"body_{b_id}"
      ).split("/")[-1]

      if (
          _body_is_descendant(self.mj_model, b_id, last_joint_body)
          and b_id != last_joint_body
      ):
        # Gripper / wrist-camera housing subtree -> express in ee_f
        b_w_pos = np.asarray(tmp_data.xpos[b_id], dtype=np.float64)
        b_w_rot = np.asarray(tmp_data.xmat[b_id], dtype=np.float64).reshape(
            3, 3
        )
        for idx_s, (c_body, rad) in enumerate(local_spheres):
          c_world = b_w_pos + b_w_rot @ c_body
          c_ee = ee_world_rot.T @ (c_world - ee_world_pos)
          chain_spheres.append(
              _ChainSphereMeta(
                  label=f"gripper:{b_short}_{idx_s}",
                  frame_index=ee_f,
                  local_center=c_ee,
                  radius=rad,
                  self_collision_group=gripper_group,
              )
          )
      else:
        # Walk up rigid child bodies attached to intermediate links 0..dof-1
        anc_b = b_id
        has_unmodeled_joint = False
        while anc_b > 0 and anc_b not in body_to_frame:
          if int(self.mj_model.body_jntnum[anc_b]) > 0:
            has_unmodeled_joint = True
            break
          anc_b = int(self.mj_model.body_parentid[anc_b])
        if has_unmodeled_joint or anc_b not in body_to_frame or anc_b <= 0:
          continue
        f_idx = body_to_frame[anc_b]
        grp = (
            gripper_group
            if anc_b == last_joint_body
            else body_to_group.get(anc_b, 0)
        )
        if b_id == anc_b:
          for idx_s, (c_body, rad) in enumerate(local_spheres):
            chain_spheres.append(
                _ChainSphereMeta(
                    label=f"arm:{b_short}_{idx_s}",
                    frame_index=f_idx,
                    local_center=c_body,
                    radius=rad,
                    self_collision_group=grp,
                )
            )
        else:
          b_w_pos = np.asarray(tmp_data.xpos[b_id], dtype=np.float64)
          b_w_rot = np.asarray(tmp_data.xmat[b_id], dtype=np.float64).reshape(
              3, 3
          )
          a_w_pos = np.asarray(tmp_data.xpos[anc_b], dtype=np.float64)
          a_w_rot = np.asarray(tmp_data.xmat[anc_b], dtype=np.float64).reshape(
              3, 3
          )
          for idx_s, (c_body, rad) in enumerate(local_spheres):
            c_world = b_w_pos + b_w_rot @ c_body
            c_anc = a_w_rot.T @ (c_world - a_w_pos)
            chain_spheres.append(
                _ChainSphereMeta(
                    label=f"arm:{b_short}_{idx_s}",
                    frame_index=f_idx,
                    local_center=c_anc,
                    radius=rad,
                    self_collision_group=grp,
                )
            )

    for s in self._attached_spheres_in_ee:
      chain_spheres.append(
          _ChainSphereMeta(
              label=f"attached:{s.label}",
              frame_index=ee_f,
              local_center=s.center,
              radius=s.radius,
              self_collision_group=gripper_group,
          )
      )

    self._ee_frame_index = ee_f
    self._frame_specs_py = frame_specs_py
    fast_specs: list[tuple[Any, ...]] = []
    batch_specs: list[tuple[Any, ...]] = []
    for parent_f, jtype, q_idx, o_xyz, o_rot, axis in frame_specs_py:
      jcode = 1 if jtype == "revolute" else (2 if jtype == "prismatic" else 0)
      ax_n = max(float(np.linalg.norm(axis)), 1e-12)
      ax_u = np.asarray(axis, dtype=np.float64).reshape(3) / ax_n
      o_xyz_arr = np.asarray(o_xyz, dtype=np.float64).reshape(3).copy()
      o_rot_arr = np.asarray(o_rot, dtype=np.float64).reshape(3, 3).copy()
      rf = o_rot_arr.reshape(9)
      fast_specs.append((
          int(parent_f),
          jcode,
          int(q_idx),
          float(o_xyz_arr[0]),
          float(o_xyz_arr[1]),
          float(o_xyz_arr[2]),
          float(rf[0]),
          float(rf[1]),
          float(rf[2]),
          float(rf[3]),
          float(rf[4]),
          float(rf[5]),
          float(rf[6]),
          float(rf[7]),
          float(rf[8]),
          float(ax_u[0]),
          float(ax_u[1]),
          float(ax_u[2]),
      ))
      batch_specs.append((
          int(parent_f),
          jcode,
          int(q_idx),
          o_xyz_arr,
          o_rot_arr,
          float(ax_u[0]),
          float(ax_u[1]),
          float(ax_u[2]),
          o_rot_arr @ ax_u,
      ))
    self._fast_frame_specs = fast_specs
    self._batch_frame_specs = batch_specs
    self._chain_spheres = chain_spheres
    if chain_spheres:
      self._sphere_labels = tuple(m.label for m in chain_spheres)
      self._sphere_frame_idx = np.array(
          [m.frame_index for m in chain_spheres], dtype=np.int32
      )
      self._sphere_local_centers = np.array(
          [m.local_center for m in chain_spheres], dtype=np.float64
      ).reshape(-1, 3)
      self._sphere_radii = np.array(
          [m.radius for m in chain_spheres], dtype=np.float64
      )
      groups_arr = np.array(
          [m.self_collision_group for m in chain_spheres], dtype=np.int32
      )
      tri_i, tri_j = np.triu_indices(len(chain_spheres), k=1)
      valid_sc = np.abs(groups_arr[tri_i] - groups_arr[tri_j]) > 1
      self._self_col_pair_i = tri_i[valid_sc].astype(np.int32)
      self._self_col_pair_j = tri_j[valid_sc].astype(np.int32)
      self._self_col_r_sum = (
          self._sphere_radii[self._self_col_pair_i]
          + self._sphere_radii[self._self_col_pair_j]
      )
      self._self_col_r_thresh_sq = np.square(
          np.maximum(0.0, self._self_col_r_sum - 1e-6)
      )
      n_sc = int(self._self_col_pair_i.size)
      self._sc_buf1 = np.empty(n_sc, dtype=np.float64)
      self._sc_buf2 = np.empty(n_sc, dtype=np.float64)
      uniq_g = np.unique(groups_arr)
      self._sc_group_spheres = [
          np.nonzero(groups_arr == int(gv))[0].astype(np.int32)
          for gv in uniq_g
      ]
      ga_list: list[int] = []
      gb_list: list[int] = []
      for ia in range(int(uniq_g.size)):
        for ib in range(ia + 1, int(uniq_g.size)):
          if abs(int(uniq_g[ia]) - int(uniq_g[ib])) > 1:
            ga_list.append(ia)
            gb_list.append(ib)
      self._sc_ga_idx = np.array(ga_list, dtype=np.int32)
      self._sc_gb_idx = np.array(gb_list, dtype=np.int32)
    else:
      self._sphere_labels = ()
      self._sphere_frame_idx = np.zeros(0, dtype=np.int32)
      self._sphere_local_centers = np.zeros((0, 3), dtype=np.float64)
      self._sphere_radii = np.zeros(0, dtype=np.float64)
      self._self_col_pair_i = np.zeros(0, dtype=np.int32)
      self._self_col_pair_j = np.zeros(0, dtype=np.int32)
      self._self_col_r_sum = np.zeros(0, dtype=np.float64)
      self._self_col_r_thresh_sq = np.zeros(0, dtype=np.float64)
      self._sc_buf1 = np.zeros(0, dtype=np.float64)
      self._sc_buf2 = np.zeros(0, dtype=np.float64)
      self._sc_group_spheres = []
      self._sc_ga_idx = np.zeros(0, dtype=np.int32)
      self._sc_gb_idx = np.zeros(0, dtype=np.int32)

  def set_gripper_opening(self, gripper_cmd: float) -> RobotArmPlanner:
    """Updates gripper finger collision geometry for `gripper_cmd`."""
    self._gripper_cmd = self._gripper_ctrl.normalize_cmd(gripper_cmd)
    self._rebuild_chain()
    return self

  def attach_object(
      self,
      obj: MultiSphereObject,
      ee_to_obj_tf: np.ndarray,
  ) -> RobotArmPlanner:
    """Welds `obj`'s spheres onto the EE frame given 4x4 `T_ee_obj`."""
    tf = np.asarray(ee_to_obj_tf, dtype=np.float64).reshape(4, 4)
    self._ee_to_obj_tf = tf.copy()
    rot = tf[:3, :3]
    trans = tf[:3, 3]
    self._attached_spheres_in_ee = [
        LocalSphereSpec(
            label=s.label,
            center=trans + rot @ s.center,
            radius=s.radius,
        )
        for s in obj.spheres
    ]
    self._rebuild_chain()
    return self

  def attach_object_at_world_pose(
      self,
      obj: MultiSphereObject,
      q_grasp: Sequence[float] | np.ndarray,
      obj_world_pose6d: Sequence[float] | np.ndarray,
  ) -> np.ndarray:
    """Welds `obj` at `obj_world_pose6d` when the arm is at `q_grasp`.

    Returns:
      The 4x4 rigid grasp transform `T_ee_obj = inv(T_world_ee(q_grasp)) @
      T_world_obj`.
    """
    ee_pos, ee_rot = self.fk(q_grasp)
    obj_pos, obj_rot = pos_rot_from_pose6d(obj_world_pose6d)
    t_world_ee = make_transform(ee_pos, ee_rot)
    t_world_obj = make_transform(obj_pos, obj_rot)
    t_ee_obj = invert_transform(t_world_ee) @ t_world_obj
    self.attach_object(obj, t_ee_obj)
    return t_ee_obj

  def detach_object(self) -> RobotArmPlanner:
    """Removes any welded object spheres from the gripper."""
    self._ee_to_obj_tf = None
    self._attached_spheres_in_ee = []
    self._rebuild_chain()
    return self

  def _copy_attached_object_from(self, source: RobotArmPlanner) -> None:
    """Copies attached object spheres and transform from `source`."""
    spheres = source._attached_spheres_in_ee  # pylint: disable=protected-access
    if not spheres:
      if self._attached_spheres_in_ee:
        self.detach_object()
      return
    self._ee_to_obj_tf = source.ee_to_obj_tf
    self._attached_spheres_in_ee = list(spheres)
    self._rebuild_chain()

  @property
  def ee_to_obj_tf(self) -> np.ndarray | None:
    """Returns copy of active 4x4 `T_ee_obj`, or `None` if detached."""
    return None if self._ee_to_obj_tf is None else self._ee_to_obj_tf.copy()

  def ee_pose_for_object_pose(
      self,
      obj_world_pose6d: Sequence[float] | np.ndarray,
      ee_to_obj_tf: np.ndarray | None = None,
  ) -> tuple[np.ndarray, np.ndarray]:
    """Returns `(ee_pos, ee_rot)` placing the attached object at `obj_world_pose6d`."""
    tf = self._ee_to_obj_tf if ee_to_obj_tf is None else ee_to_obj_tf
    if tf is None:
      raise ValueError(
          "No attached object transform; pass ee_to_obj_tf or call"
          " attach_object first."
      )
    obj_pos, obj_rot = pos_rot_from_pose6d(obj_world_pose6d)
    t_world_ee = make_transform(obj_pos, obj_rot) @ invert_transform(tf)
    return t_world_ee[:3, 3].copy(), t_world_ee[:3, :3].copy()

  def attached_object_pose(
      self,
      q: Sequence[float] | np.ndarray,
      ee_to_obj_tf: np.ndarray | None = None,
  ) -> np.ndarray:
    """Returns 6D world `pose6d` of the attached object at arm config `q`."""
    tf = self._ee_to_obj_tf if ee_to_obj_tf is None else ee_to_obj_tf
    if tf is None:
      raise ValueError(
          "No attached object transform; pass ee_to_obj_tf or call"
          " attach_object first."
      )
    ee_pos, ee_rot = self.fk(q)
    t_world_obj = make_transform(ee_pos, ee_rot) @ np.asarray(
        tf, dtype=np.float64
    ).reshape(4, 4)
    return pose6d_from_pos_rot(t_world_obj[:3, 3], t_world_obj[:3, :3])

  def _sample_gripper_ee_entries(
      self, cmd: float
  ) -> list[tuple[str, int, np.ndarray, float]]:
    """Returns `(label, body_id, center_ee, radius)` for gripper geoms at `cmd`."""
    data = mujoco.MjData(self.mj_model)
    data.qpos[:] = self.mj_model.qpos0
    self._gripper_ctrl.apply_cmd(data, cmd)
    mujoco.mj_kinematics(self.mj_model, data)
    if self.ee_site_id >= 0:
      ee_pos = np.asarray(data.site_xpos[self.ee_site_id], dtype=np.float64)
      ee_rot = np.asarray(
          data.site_xmat[self.ee_site_id], dtype=np.float64
      ).reshape(3, 3)
    else:
      ee_pos = np.asarray(data.xpos[self._last_joint_body], dtype=np.float64)
      ee_rot = np.asarray(
          data.xmat[self._last_joint_body], dtype=np.float64
      ).reshape(3, 3)

    entries: list[tuple[str, int, np.ndarray, float]] = []
    for g_id in range(int(self.mj_model.ngeom)):
      if not self._is_collision_geom(g_id):
        continue
      b_id = int(self.mj_model.geom_bodyid[g_id])
      if b_id == self._last_joint_body or not _body_is_descendant(
          self.mj_model, b_id, self._last_joint_body
      ):
        continue
      local_spheres = self._cached_geom_spheres(g_id)
      if not local_spheres:
        continue
      b_short = (
          mujoco.mj_id2name(self.mj_model, int(mujoco.mjtObj.mjOBJ_BODY), b_id)
          or f"body_{b_id}"
      ).split("/")[-1]
      b_w_pos = np.asarray(data.xpos[b_id], dtype=np.float64)
      b_w_rot = np.asarray(data.xmat[b_id], dtype=np.float64).reshape(3, 3)
      for idx_s, (c_body, rad) in enumerate(local_spheres):
        c_world = b_w_pos + b_w_rot @ c_body
        c_ee = ee_rot.T @ (c_world - ee_pos)
        entries.append((f"gripper:{b_short}_{idx_s}", b_id, c_ee, rad))
    return entries

  def gripper_frame_info(
      self, gripper_cmd: float | None = None
  ) -> dict[str, Any]:
    """Numerically computes EE-frame axes, jaw gaps, widths, and protrusions."""
    cmd = (
        self._gripper_cmd
        if gripper_cmd is None
        else self._gripper_ctrl.normalize_cmd(gripper_cmd)
    )
    if self._open_closed_ee_cache is None:
      self._open_closed_ee_cache = (
          self._sample_gripper_ee_entries(0.0),
          self._sample_gripper_ee_entries(1.0),
      )
    open_entries, closed_entries = self._open_closed_ee_cache
    if abs(cmd - 0.0) <= 1e-6:
      cur_entries = open_entries
    elif abs(cmd - 1.0) <= 1e-6:
      cur_entries = closed_entries
    else:
      cur_entries = self._sample_gripper_ee_entries(cmd)

    n_sp = len(open_entries)
    app_ax = self._approach_axis_ee.copy()

    # Determine closing axis from open->closed sphere displacement covariance
    deltas = (
        np.array(
            [closed_entries[i][2] - open_entries[i][2] for i in range(n_sp)],
            dtype=np.float64,
        ).reshape(-1, 3)
        if n_sp > 0
        else np.zeros((0, 3), dtype=np.float64)
    )
    move_norms = (
        np.linalg.norm(deltas, axis=1)
        if n_sp > 0
        else np.zeros(0, dtype=np.float64)
    )
    moving_mask = move_norms > 1e-4

    if np.any(moving_mask):
      # Project displacements orthogonal to approach axis
      d_mov = deltas[moving_mask]
      d_perp = d_mov - (d_mov @ app_ax)[:, None] * app_ax[None, :]
      cov = d_perp.T @ d_perp
      eigvals, eigvecs = np.linalg.eigh(cov)
      cls_raw = eigvecs[:, int(np.argmax(eigvals))]
      if float(np.linalg.norm(cls_raw)) < 1e-6:
        cls_raw = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    else:
      # Fixed/absent gripper fallback: pick canonical axis orthogonal to approach
      cand_axes = [
          np.array([0.0, 1.0, 0.0]),
          np.array([1.0, 0.0, 0.0]),
          np.array([0.0, 0.0, 1.0]),
      ]
      cls_raw = max(
          cand_axes,
          key=lambda v: float(np.linalg.norm(v - np.dot(v, app_ax) * app_ax)),
      )

    cls_raw = cls_raw - float(np.dot(cls_raw, app_ax)) * app_ax
    cls_raw = cls_raw / max(float(np.linalg.norm(cls_raw)), 1e-12)
    dom_c = int(np.argmax(np.abs(cls_raw)))
    if abs(float(cls_raw[dom_c])) > 0.90:
      cls_ax = np.zeros(3, dtype=np.float64)
      cls_ax[dom_c] = 1.0
      # Re-orthogonalize in case app_ax was slightly non-canonical
      cls_ax = cls_ax - float(np.dot(cls_ax, app_ax)) * app_ax
      cls_ax = cls_ax / max(float(np.linalg.norm(cls_ax)), 1e-12)
    else:
      cls_ax = cls_raw

    # Right-handed triad [slim_ax, cls_ax, app_ax] with det = +1
    slim_ax = np.cross(cls_ax, app_ax)
    slim_ax = slim_ax / max(float(np.linalg.norm(slim_ax)), 1e-12)
    # Prefer positive sign on canonical slim axis while adjusting cls_ax sign
    # so det([slim_ax, cls_ax, app_ax]) == +1 always holds.
    dom_s = int(np.argmax(np.abs(slim_ax)))
    if float(slim_ax[dom_s]) < -0.5:
      slim_ax = -slim_ax
      cls_ax = -cls_ax

    # Partition moving bodies (distal fingertip pads vs full jaw) and static housing
    moving_indices = np.nonzero(moving_mask)[0].tolist()
    housing_indices = np.nonzero(~moving_mask)[0].tolist()

    if moving_indices:
      max_a_by_body: dict[int, float] = {}
      for idx in moving_indices:
        _, bid, c_o, r_o = open_entries[idx]
        a_top = float(np.dot(c_o, app_ax) + r_o)
        prev = max_a_by_body.get(bid)
        if prev is None or a_top > prev:
          max_a_by_body[bid] = a_top
      max_a_all = max(max_a_by_body.values())
      pad_bodies = {
          bid
          for bid, top_a in max_a_by_body.items()
          if top_a >= max_a_all - 0.025
      }
      pad_indices = [
          idx
          for idx in moving_indices
          if open_entries[idx][1] in pad_bodies
          and float(np.dot(open_entries[idx][2], app_ax) + open_entries[idx][3])
          >= max_a_all - 0.080
      ]
      if not pad_indices:
        pad_indices = list(moving_indices)
    else:
      pad_indices = []

    def _to_meta(
        src: Sequence[tuple[str, int, np.ndarray, float]], idxs: Sequence[int]
    ) -> list[_ChainSphereMeta]:
      return [
          _ChainSphereMeta(
              label=src[i][0],
              frame_index=self._ee_frame_index,
              local_center=src[i][2],
              radius=src[i][3],
              self_collision_group=0,
          )
          for i in idxs
      ]

    def _compute_inner_gap(
        src: Sequence[tuple[str, int, np.ndarray, float]],
    ) -> float:
      if not pad_indices:
        return 0.0
      tip_max_a = max(
          float(np.dot(src[i][2], app_ax) + src[i][3]) for i in pad_indices
      )
      tip_idxs = [
          i
          for i in pad_indices
          if float(np.dot(src[i][2], app_ax) + src[i][3]) >= tip_max_a - 0.042
      ]
      if not tip_idxs:
        tip_idxs = pad_indices
      pos_jaw: list[float] = []
      neg_jaw: list[float] = []
      for i in tip_idxs:
        # Classify jaw side by closing displacement or open coordinate
        d_c = float(np.dot(deltas[i], cls_ax))
        y_c = float(np.dot(src[i][2], cls_ax))
        rad = src[i][3]
        if d_c < -1e-4 or (abs(d_c) <= 1e-4 and y_c >= 0.0):
          pos_jaw.append(y_c - rad)
        elif d_c > 1e-4 or (abs(d_c) <= 1e-4 and y_c < 0.0):
          neg_jaw.append(y_c + rad)
      if pos_jaw and neg_jaw:
        return max(0.0, min(pos_jaw) - max(neg_jaw))
      return 0.0

    def _compute_outer_width(
        src: Sequence[tuple[str, int, np.ndarray, float]],
    ) -> float:
      idxs = moving_indices if moving_indices else list(range(len(src)))
      if not idxs:
        return 0.0
      hi_w = max(float(np.dot(src[i][2], cls_ax) + src[i][3]) for i in idxs)
      lo_w = min(float(np.dot(src[i][2], cls_ax) - src[i][3]) for i in idxs)
      return max(0.0, hi_w - lo_w)

    open_gap = _compute_inner_gap(open_entries)
    closed_gap = _compute_inner_gap(closed_entries)
    cur_gap = _compute_inner_gap(cur_entries)
    open_outer_w = _compute_outer_width(open_entries)
    closed_outer_w = _compute_outer_width(closed_entries)

    slim_idxs = pad_indices if pad_indices else list(range(n_sp))
    if slim_idxs:
      slim_hi = max(
          float(np.dot(cur_entries[i][2], slim_ax) + cur_entries[i][3])
          for i in slim_idxs
      )
      slim_lo = min(
          float(np.dot(cur_entries[i][2], slim_ax) - cur_entries[i][3])
          for i in slim_idxs
      )
      slim_w = max(0.0, slim_hi - slim_lo)
    else:
      slim_w = 0.0

    # Detect asymmetric camera/mount protrusions on lateral axes (> 20 mm skew)
    protrusions: list[dict[str, Any]] = []
    if n_sp > 0:
      for lat_vec in (slim_ax, cls_ax):
        pos_ext = max(
            0.0,
            max(
                float(np.dot(open_entries[i][2], lat_vec) + open_entries[i][3])
                for i in range(n_sp)
            ),
        )
        neg_ext = max(
            0.0,
            max(
                float(-np.dot(open_entries[i][2], lat_vec) + open_entries[i][3])
                for i in range(n_sp)
            ),
        )
        asym = abs(pos_ext - neg_ext)
        if asym > 0.020:
          dir_vec = lat_vec if pos_ext > neg_ext else -lat_vec
          max_ext = max(pos_ext, neg_ext)
          opp_ext = min(pos_ext, neg_ext)
          bulge_idxs = [
              i
              for i in range(n_sp)
              if float(np.dot(open_entries[i][2], dir_vec) + open_entries[i][3])
              > opp_ext + 0.010
          ]
          a_min = (
              min(
                  float(np.dot(open_entries[i][2], app_ax) - open_entries[i][3])
                  for i in bulge_idxs
              )
              if bulge_idxs
              else 0.0
          )
          a_max = (
              max(
                  float(np.dot(open_entries[i][2], app_ax) + open_entries[i][3])
                  for i in bulge_idxs
              )
              if bulge_idxs
              else 0.0
          )
          protrusions.append({
              "axis_ee": _format_axis_label_ee(dir_vec, signed=True),
              "direction_ee": np.round(dir_vec, 4).tolist(),
              "max_extent_m": round(max_ext, 4),
              "opposite_extent_m": round(opp_ext, 4),
              "asymmetry_m": round(asym, 4),
              "approach_range_m": [round(a_min, 4), round(a_max, 4)],
          })

    # Top-down world rotation hint: maps approach->[0,0,-1], slim->[1,0,0], cls->[0,-1,0]
    e_basis = np.column_stack([slim_ax, cls_ax, app_ax])
    target_world = np.array(
        [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]],
        dtype=np.float64,
    )
    top_down_rot = target_world @ e_basis.T
    # Snap tiny float noise to exact zeros/ones
    top_down_rot[np.abs(top_down_rot) < 1e-12] = 0.0

    all_cur_meta = _to_meta(cur_entries, range(len(cur_entries)))
    pad_cur_meta = _to_meta(cur_entries, pad_indices)
    housing_cur_meta = _to_meta(cur_entries, housing_indices)
    pad_bounds = _local_sphere_bounds_dict(pad_cur_meta)
    housing_bounds = _local_sphere_bounds_dict(housing_cur_meta)
    all_bounds = _local_sphere_bounds_dict(all_cur_meta)
    housing_a_max = (
        max(
            float(np.dot(m.local_center, app_ax) + m.radius)
            for m in housing_cur_meta
        )
        if housing_cur_meta
        else None
    )

    app_lbl = _format_axis_label_ee(app_ax, signed=True)
    cls_lbl = _format_axis_label_ee(cls_ax, signed=False)
    slm_lbl = _format_axis_label_ee(slim_ax, signed=False)
    prot_desc = (
        "; asymmetric protrusion on "
        + ", ".join(p["axis_ee"] for p in protrusions)
        if protrusions
        else ""
    )

    return {
        "arm": self.arm,
        "ee_site_name": self.ee_site_name,
        "gripper_cmd": round(cmd, 4),
        "approach_axis_ee": np.round(app_ax, 4).tolist(),
        "closing_axis_ee": np.round(cls_ax, 4).tolist(),
        "slim_axis_ee": np.round(slim_ax, 4).tolist(),
        "open_inner_gap_m": round(open_gap, 4),
        "closed_inner_gap_m": round(closed_gap, 4),
        "inner_gap_m": round(cur_gap, 4),
        "sphere_inner_y_gap_m": round(cur_gap, 4),
        "open_outer_width_m": round(open_outer_w, 4),
        "closed_outer_width_m": round(closed_outer_w, 4),
        "slim_profile_width_m": round(slim_w, 4),
        "pad_bounds_ee_m": pad_bounds,
        "pad_sphere_bounds_ee_m": pad_bounds,
        "housing_bounds_ee_m": housing_bounds,
        "gripper_sphere_bounds_ee_m": all_bounds,
        "palm_housing_z_max_ee_m": (
            round(housing_a_max, 4) if housing_a_max is not None else None
        ),
        "asymmetric_protrusions": protrusions,
        "top_down_rot_hint": np.round(top_down_rot, 4).tolist(),
        "axes_in_ee_frame": {
            "approach": f"{app_lbl}: wrist-to-fingertip approach axis",
            "closing": f"{cls_lbl}: jaw opening/closing axis",
            "slim": f"{slm_lbl}: slim finger-pad profile axis{prot_desc}",
        },
    }

  def add_other_arm_to_scene(
      self,
      scene: Scene3D,
      other_arm_q: Sequence[float] | np.ndarray,
      other_gripper_cmd: float = 0.0,
      group_name: str = "other_arm",
      other_planner: RobotArmPlanner | None = None,
      other_joint_names: Sequence[str] | None = None,
  ) -> Scene3D:
    """Registers a non-planned arm at `other_arm_q` into `scene`."""
    if other_planner is not None:
      norm_cmd = other_planner._gripper_ctrl.normalize_cmd(other_gripper_cmd)  # pylint: disable=protected-access
      if abs(norm_cmd - other_planner._gripper_cmd) <= 1e-9:  # pylint: disable=protected-access
        other = other_planner
      else:
        other = RobotArmPlanner(
            mjcf_path=other_planner.mjcf_path,
            arm=other_planner.arm,
            joint_names=other_planner.joint_names,
            ee_site_name=(
                other_planner.ee_site_name
                if other_planner.ee_site_id >= 0
                else None
            ),
            gripper_cmd=other_gripper_cmd,
        )
        other._copy_attached_object_from(  # pylint: disable=protected-access
            other_planner
        )
    elif other_joint_names is not None:
      other_side = "right" if self.arm == "left" else "left"
      other = RobotArmPlanner(
          mjcf_path=self.mjcf_path,
          arm=other_side,
          joint_names=other_joint_names,
          gripper_cmd=other_gripper_cmd,
      )
    else:
      arm_specs = _discover_robot_arms(self.mj_model)
      other_candidates = [k for k in arm_specs if k != self.arm]
      if not other_candidates:
        raise ValueError(
            f"No second arm found in {self.mjcf_path!r}"
            f" (discovered: {list(arm_specs.keys())})."
        )
      other_side = (
          "right"
          if (self.arm == "left" and "right" in other_candidates)
          else (
              "left"
              if (self.arm == "right" and "left" in other_candidates)
              else other_candidates[0]
          )
      )
      other = RobotArmPlanner(
          mjcf_path=self.mjcf_path,
          arm=other_side,
          gripper_cmd=other_gripper_cmd,
      )
    scene.remove(group_name)
    # Skip stationary base bodies preceding the first planned arm joint.
    for label, center, radius in other.world_link_spheres(
        other_arm_q, include_static_base=False
    ):
      scene.add_sphere(
          f"{group_name}:{label}", center, radius, group=group_name
      )
    return scene

  def fk(
      self, q: Sequence[float] | np.ndarray
  ) -> tuple[np.ndarray, np.ndarray]:
    """Computes exact `(ee_pos_3d, ee_rot_3x3)` for `q`."""
    q_arr = np.asarray(q, dtype=np.float64).reshape(self.dof)
    self.mj_data.qpos[self.qpos_indices] = q_arr
    mujoco.mj_kinematics(self.mj_model, self.mj_data)
    if self.ee_site_id >= 0:
      pos = np.asarray(
          self.mj_data.site_xpos[self.ee_site_id], dtype=np.float64
      ).copy()
      rot = (
          np.asarray(self.mj_data.site_xmat[self.ee_site_id], dtype=np.float64)
          .reshape(3, 3)
          .copy()
      )
    else:
      pos = np.asarray(
          self.mj_data.xpos[self._last_joint_body], dtype=np.float64
      ).copy()
      rot = (
          np.asarray(self.mj_data.xmat[self._last_joint_body], dtype=np.float64)
          .reshape(3, 3)
          .copy()
      )
    return pos, rot

  def _compute_fast_frames_tuples(
      self, q: Sequence[float] | np.ndarray
  ) -> tuple[list[tuple[float, float, float]], list[tuple[float, ...]]]:
    """Pure-float FK evaluation without per-frame NumPy dispatch overhead."""
    q_list = [float(x) for x in q]
    pos_out: list[tuple[float, float, float]] = []
    rot_out: list[tuple[float, ...]] = []
    for spec in self._fast_frame_specs:
      (
          parent_f,
          jcode,
          q_idx,
          lx,
          ly,
          lz,
          r00,
          r01,
          r02,
          r10,
          r11,
          r12,
          r20,
          r21,
          r22,
          ax0,
          ax1,
          ax2,
      ) = spec
      if jcode == 1 and q_idx >= 0:
        ang = q_list[q_idx]
        c = math.cos(ang)
        s = math.sin(ang)
        omc = 1.0 - c
        j00 = c + omc * ax0 * ax0
        j01 = omc * ax0 * ax1 - s * ax2
        j02 = omc * ax0 * ax2 + s * ax1
        j10 = omc * ax1 * ax0 + s * ax2
        j11 = c + omc * ax1 * ax1
        j12 = omc * ax1 * ax2 - s * ax0
        j20 = omc * ax2 * ax0 - s * ax1
        j21 = omc * ax2 * ax1 + s * ax0
        j22 = c + omc * ax2 * ax2
        n00 = r00 * j00 + r01 * j10 + r02 * j20
        n01 = r00 * j01 + r01 * j11 + r02 * j21
        n02 = r00 * j02 + r01 * j12 + r02 * j22
        n10 = r10 * j00 + r11 * j10 + r12 * j20
        n11 = r10 * j01 + r11 * j11 + r12 * j21
        n12 = r10 * j02 + r11 * j12 + r12 * j22
        n20 = r20 * j00 + r21 * j10 + r22 * j20
        n21 = r20 * j01 + r21 * j11 + r22 * j21
        n22 = r20 * j02 + r21 * j12 + r22 * j22
        r00, r01, r02 = n00, n01, n02
        r10, r11, r12 = n10, n11, n12
        r20, r21, r22 = n20, n21, n22
      elif jcode == 2 and q_idx >= 0:
        d = q_list[q_idx]
        dx, dy, dz = ax0 * d, ax1 * d, ax2 * d
        lx += r00 * dx + r01 * dy + r02 * dz
        ly += r10 * dx + r11 * dy + r12 * dz
        lz += r20 * dx + r21 * dy + r22 * dz

      if parent_f < 0:
        pos_out.append((lx, ly, lz))
        rot_out.append((r00, r01, r02, r10, r11, r12, r20, r21, r22))
      else:
        px, py, pz = pos_out[parent_f]
        p00, p01, p02, p10, p11, p12, p20, p21, p22 = rot_out[parent_f]
        pos_out.append((
            px + p00 * lx + p01 * ly + p02 * lz,
            py + p10 * lx + p11 * ly + p12 * lz,
            pz + p20 * lx + p21 * ly + p22 * lz,
        ))
        rot_out.append((
            p00 * r00 + p01 * r10 + p02 * r20,
            p00 * r01 + p01 * r11 + p02 * r21,
            p00 * r02 + p01 * r12 + p02 * r22,
            p10 * r00 + p11 * r10 + p12 * r20,
            p10 * r01 + p11 * r11 + p12 * r21,
            p10 * r02 + p11 * r12 + p12 * r22,
            p20 * r00 + p21 * r10 + p22 * r20,
            p20 * r01 + p21 * r11 + p22 * r21,
            p20 * r02 + p21 * r12 + p22 * r22,
        ))
    return pos_out, rot_out

  def _compute_frame_transforms_py(
      self, q: np.ndarray
  ) -> list[tuple[np.ndarray, np.ndarray]]:
    """Evaluates world transforms `(pos, rot)` for all frames in `_frame_specs_py`."""
    pos_out, rot_out = self._compute_fast_frames_tuples(q)
    return [
        (
            np.array(p, dtype=np.float64),
            np.array(r, dtype=np.float64).reshape(3, 3),
        )
        for p, r in zip(pos_out, rot_out, strict=True)
    ]

  def chain_ee_pose(
      self, q: Sequence[float] | np.ndarray
  ) -> tuple[np.ndarray, np.ndarray]:
    """Returns `(pos, rot)` computed via the `KinematicChain` frames."""
    pos_out, rot_out = self._compute_fast_frames_tuples(
        np.asarray(q, dtype=np.float64).reshape(self.dof)
    )
    return (
        np.array(pos_out[self._ee_frame_index], dtype=np.float64),
        np.array(rot_out[self._ee_frame_index], dtype=np.float64).reshape(3, 3),
    )

  def world_link_spheres(
      self,
      q: Sequence[float] | np.ndarray,
      *,
      include_static_base: bool = True,
  ) -> list[tuple[str, np.ndarray, float]]:
    """Returns sphere collision geometries for the arm and attached objects.

    Args:
      q: Joint configuration of the arm.
      include_static_base: If True, includes static base collision spheres
        (group 0) preceding the first articulated joint. If False, omits them.

    Returns:
      A list of `(label, world_center, radius)` tuples.
    """
    tfs = self._compute_frame_transforms_py(
        np.asarray(q, dtype=np.float64).reshape(self.dof)
    )
    out: list[tuple[str, np.ndarray, float]] = []
    for meta in self._chain_spheres:
      if not include_static_base and meta.self_collision_group == 0:
        continue
      f_pos, f_rot = tfs[meta.frame_index]
      out.append((meta.label, f_pos + f_rot @ meta.local_center, meta.radius))
    return out

  def clamp_within_tolerance(
      self, q: Sequence[float] | np.ndarray, tol_rad: float = 5e-3
  ) -> np.ndarray:
    """Clamps minor joint encoder jitter within `tol_rad` of `[q_min, q_max]`."""
    q_arr = np.asarray(q, dtype=np.float64).reshape(self.dof).copy()
    below = self.q_min - q_arr
    above = q_arr - self.q_max
    if np.any(below > tol_rad) or np.any(above > tol_rad):
      return q_arr
    return np.clip(q_arr, self.q_min, self.q_max)

  def _world_sphere_centers_array(self, q_arr: np.ndarray) -> np.ndarray:
    """Computes `(num_spheres, 3)` world centers for all chain spheres at `q`."""
    if not self._sphere_radii.size:
      return np.zeros((0, 3), dtype=np.float64)
    pos_out, rot_out = self._compute_fast_frames_tuples(q_arr)
    f_pos_arr = np.array(pos_out, dtype=np.float64)
    f_rot_arr = np.array(rot_out, dtype=np.float64).reshape(-1, 3, 3)
    rot_s = f_rot_arr[self._sphere_frame_idx]
    loc_s = self._sphere_local_centers
    return f_pos_arr[self._sphere_frame_idx] + (
        rot_s[:, :, 0] * loc_s[:, 0:1]
        + rot_s[:, :, 1] * loc_s[:, 1:2]
        + rot_s[:, :, 2] * loc_s[:, 2:3]
    )

  def _world_sphere_centers_batch(self, q_batch: np.ndarray) -> np.ndarray:
    """Computes `(K, num_spheres, 3)` world centers for `(K, dof)` joint configs."""
    k_len = int(q_batch.shape[0])
    if not self._sphere_radii.size or k_len == 0:
      return np.zeros((k_len, 0, 3), dtype=np.float64)
    pos_list: list[np.ndarray] = []
    rot_list: list[np.ndarray] = []
    for (
        parent_f,
        jcode,
        q_idx,
        o_pos,
        o_rot,
        ax0,
        ax1,
        ax2,
        ax_body,
    ) in self._batch_frame_specs:
      if jcode == 1 and q_idx >= 0:
        ang = q_batch[:, q_idx]
        c = np.cos(ang)
        s = np.sin(ang)
        omc = 1.0 - c
        j_rot = np.empty((k_len, 3, 3), dtype=np.float64)
        j_rot[:, 0, 0] = c + omc * ax0 * ax0
        j_rot[:, 0, 1] = omc * ax0 * ax1 - s * ax2
        j_rot[:, 0, 2] = omc * ax0 * ax2 + s * ax1
        j_rot[:, 1, 0] = omc * ax1 * ax0 + s * ax2
        j_rot[:, 1, 1] = c + omc * ax1 * ax1
        j_rot[:, 1, 2] = omc * ax1 * ax2 - s * ax0
        j_rot[:, 2, 0] = omc * ax2 * ax0 - s * ax1
        j_rot[:, 2, 1] = omc * ax2 * ax1 + s * ax0
        j_rot[:, 2, 2] = c + omc * ax2 * ax2
        l_rot = np.matmul(o_rot, j_rot)
        l_pos = o_pos[None, :]
      elif jcode == 2 and q_idx >= 0:
        q_col = q_batch[:, q_idx : q_idx + 1]
        l_pos = o_pos[None, :] + q_col * ax_body[None, :]
        l_rot = np.broadcast_to(o_rot, (k_len, 3, 3))
      else:
        l_pos = o_pos[None, :]
        l_rot = np.broadcast_to(o_rot, (k_len, 3, 3))

      if parent_f < 0:
        pos_list.append(np.broadcast_to(l_pos, (k_len, 3)))
        rot_list.append(l_rot)
      else:
        p_pos = pos_list[parent_f]
        p_rot = rot_list[parent_f]
        if l_pos.shape[0] == 1:
          step_p = np.matmul(p_rot, o_pos)
        else:
          step_p = np.einsum("kij,kj->ki", p_rot, l_pos)
        pos_list.append(p_pos + step_p)
        rot_list.append(np.matmul(p_rot, l_rot))

    f_pos = np.stack(pos_list, axis=1)
    f_rot = np.stack(rot_list, axis=1)
    s_f = self._sphere_frame_idx
    loc_s = self._sphere_local_centers
    rot_s = f_rot[:, s_f]
    return f_pos[:, s_f] + (
        rot_s[:, :, :, 0] * loc_s[None, :, 0:1]
        + rot_s[:, :, :, 1] * loc_s[None, :, 1:2]
        + rot_s[:, :, :, 2] * loc_s[None, :, 2:3]
    )

  def check_arm_config(
      self,
      scene: Scene3D,
      q: Sequence[float] | np.ndarray,
      check_self_collision: bool = True,
      ignore_obstacles: Sequence[str] = (),
      clearance_tol_m: float = 0.0,
  ) -> dict[str, Any]:
    """Checks joint limits, self-collisions, and `scene` obstacle collisions."""
    q_arr = self.clamp_within_tolerance(q)
    oob_mask = (q_arr < self.q_min - 1e-5) | (q_arr > self.q_max + 1e-5)
    oob = np.nonzero(oob_mask)[0].tolist() if np.any(oob_mask) else []
    w_centers = self._world_sphere_centers_array(q_arr)

    diag = _evaluate_sphere_arrays_against_scene(
        self._sphere_labels,
        w_centers,
        self._sphere_radii,
        scene,
        ignore_obstacles=ignore_obstacles,
        clearance_tol_m=clearance_tol_m,
    )
    self_collisions: list[dict[str, Any]] = []
    if check_self_collision and self._self_col_pair_i.size:
      pi_idx = self._self_col_pair_i
      pj_idx = self._self_col_pair_j
      b1 = self._sc_buf1
      b2 = self._sc_buf2
      np.subtract(w_centers[pi_idx, 0], w_centers[pj_idx, 0], out=b1)
      np.multiply(b1, b1, out=b1)
      np.subtract(w_centers[pi_idx, 1], w_centers[pj_idx, 1], out=b2)
      np.multiply(b2, b2, out=b2)
      np.add(b1, b2, out=b1)
      np.subtract(w_centers[pi_idx, 2], w_centers[pj_idx, 2], out=b2)
      np.multiply(b2, b2, out=b2)
      np.add(b1, b2, out=b1)
      sc_hits = np.nonzero(b1 < self._self_col_r_thresh_sq)[0]
      for idx_k in sc_hits.tolist():
        ia = int(pi_idx[idx_k])
        ib = int(pj_idx[idx_k])
        pen_m = float(self._self_col_r_sum[idx_k] - math.sqrt(float(b1[idx_k])))
        self_collisions.append({
            "part_a": self._sphere_labels[ia],
            "part_b": self._sphere_labels[ib],
            "penetration_m": 0.0 + round(pen_m, 5),
        })

    valid = (not oob) and (not diag["collisions"]) and (not self_collisions)
    return {
        "valid": valid,
        "out_of_bounds_joints": oob,
        "self_collisions": self_collisions,
        **diag,
    }

  def check_arm_segment(
      self,
      scene: Scene3D,
      q_start: Sequence[float] | np.ndarray,
      q_goal: Sequence[float] | np.ndarray,
      step_rad: float = 0.03,
      ignore_obstacles: Sequence[str] = (),
      clearance_tol_m: float = 0.0,
  ) -> dict[str, Any]:
    """Checks linear joint segment `[q_start, q_goal]` at `step_rad` resolution."""
    q0 = self.clamp_within_tolerance(q_start)
    q1 = self.clamp_within_tolerance(q_goal)
    dist = float(np.linalg.norm(q1 - q0))
    n_steps = max(1, int(math.ceil(dist / max(1e-4, step_rad))))
    worst_clearance = float("inf")
    for idx in range(n_steps + 1):
      alpha = idx / n_steps
      q = (1.0 - alpha) * q0 + alpha * q1
      res = self.check_arm_config(
          scene,
          q,
          ignore_obstacles=ignore_obstacles,
          clearance_tol_m=clearance_tol_m,
      )
      if res["min_clearance_m"] is not None:
        worst_clearance = min(worst_clearance, float(res["min_clearance_m"]))
      if not res["valid"]:
        return {
            "valid": False,
            "failed_alpha": round(alpha, 4),
            "failed_q": np.round(q, 5).tolist(),
            **res,
        }
    return {
        "valid": True,
        "num_checked_configs": n_steps + 1,
        "min_clearance_m": (
            0.0 + round(worst_clearance, 5)
            if math.isfinite(worst_clearance)
            else None
        ),
        "collisions": [],
        "self_collisions": [],
    }

  def solve_ik(
      self,
      target_pos: Sequence[float] | np.ndarray,
      target_rot: Sequence[Sequence[float]] | np.ndarray | None = None,
      q_seed: Sequence[float] | np.ndarray | None = None,
      scene: Scene3D | None = None,
      pos_tol_m: float = 1.5e-3,
      rot_tol_rad: float = 2.5e-2,
      num_restarts: int = 16,
      max_iters: int = 220,
      damping: float = 1e-2,
      rng_seed: int = 0,
      ignore_obstacles: Sequence[str] = (),
      clearance_tol_m: float = 0.0,
  ) -> dict[str, Any]:
    """Multi-start damped-least-squares IK with optional collision filtering."""
    tgt_p = np.asarray(target_pos, dtype=np.float64).reshape(3)
    tgt_r = (
        np.asarray(target_rot, dtype=np.float64).reshape(3, 3)
        if target_rot is not None
        else None
    )
    margin = 0.01
    lo = self.q_min + margin
    hi = self.q_max - margin
    mid = 0.5 * (lo + hi)

    rng = np.random.default_rng(rng_seed)
    seeds: list[np.ndarray] = []
    q_seed_clamped: np.ndarray | None = None
    if q_seed is not None:
      q_seed_clamped = np.clip(
          np.asarray(q_seed, dtype=np.float64).reshape(self.dof), lo, hi
      )
      seeds.append(q_seed_clamped.copy())
      if self.dof >= 1:
        for delta_wrist in (
            math.pi,
            -math.pi,
            0.5 * math.pi,
            -0.5 * math.pi,
        ):
          cand_w = float(q_seed_clamped[-1]) + delta_wrist
          if float(lo[-1]) <= cand_w <= float(hi[-1]):
            q_flip = q_seed_clamped.copy()
            q_flip[-1] = cand_w
            seeds.append(q_flip)

    seeds.append(mid.copy())
    if self.dof >= 1:
      for frac in (0.25, 0.75):
        q_mid_w = mid.copy()
        q_mid_w[-1] = float(lo[-1] + frac * (hi[-1] - lo[-1]))
        seeds.append(q_mid_w)

    target_count = max(int(num_restarts), len(seeds))
    rem = target_count - len(seeds)
    for k in range(rem):
      if q_seed_clamped is not None and k % 2 == 0:
        noise = rng.normal(0.0, 0.55, size=self.dof)
        seeds.append(np.clip(q_seed_clamped + noise, lo, hi))
      else:
        seeds.append(rng.uniform(lo, hi))

    jacp = np.zeros((3, self.mj_model.nv), dtype=np.float64)
    jacr = np.zeros((3, self.mj_model.nv), dtype=np.float64)
    best_collision_fail: dict[str, Any] | None = None
    best_ik_only: tuple[float, np.ndarray, float, float] | None = None

    for seed_idx, q0 in enumerate(seeds[: max(1, int(num_restarts))]):
      q = q0.copy()
      null_target = (
          q_seed_clamped
          if (q_seed_clamped is not None and seed_idx == 0)
          else mid
      )
      pos_err_norm = float("inf")
      rot_err_norm = 0.0
      for _ in range(max_iters):
        self.mj_data.qpos[self.qpos_indices] = q
        mujoco.mj_kinematics(self.mj_model, self.mj_data)
        mujoco.mj_comPos(self.mj_model, self.mj_data)
        if self.ee_site_id >= 0:
          cur_p = np.asarray(
              self.mj_data.site_xpos[self.ee_site_id], dtype=np.float64
          )
          cur_r = np.asarray(
              self.mj_data.site_xmat[self.ee_site_id], dtype=np.float64
          ).reshape(3, 3)
        else:
          cur_p = np.asarray(
              self.mj_data.xpos[self._last_joint_body], dtype=np.float64
          )
          cur_r = np.asarray(
              self.mj_data.xmat[self._last_joint_body], dtype=np.float64
          ).reshape(3, 3)
        e_p = tgt_p - cur_p
        pos_err_norm = float(np.linalg.norm(e_p))

        if tgt_r is not None:
          r_err_mat = tgt_r @ cur_r.T
          quat_err = np.zeros(4, dtype=np.float64)
          mujoco.mju_mat2Quat(quat_err, r_err_mat.reshape(9))
          if quat_err[0] < 0.0:
            quat_err = -quat_err
          sin_half = float(np.linalg.norm(quat_err[1:]))
          if sin_half > 1e-9:
            angle = 2.0 * math.atan2(sin_half, float(quat_err[0]))
            e_r = (angle / sin_half) * quat_err[1:]
          else:
            e_r = 2.0 * quat_err[1:]
          rot_err_norm = float(np.linalg.norm(e_r))
        else:
          e_r = np.zeros(3, dtype=np.float64)
          rot_err_norm = 0.0

        if pos_err_norm <= pos_tol_m and (
            tgt_r is None or rot_err_norm <= rot_tol_rad
        ):
          break

        if self.ee_site_id >= 0:
          mujoco.mj_jacSite(
              self.mj_model, self.mj_data, jacp, jacr, self.ee_site_id
          )
        else:
          mujoco.mj_jacBody(
              self.mj_model, self.mj_data, jacp, jacr, self._last_joint_body
          )
        jp = jacp[:, self.dof_indices]
        if tgt_r is not None:
          jr = jacr[:, self.dof_indices]
          j_full = np.vstack([jp, 0.35 * jr])
          err_full = np.concatenate([e_p, 0.35 * e_r])
        else:
          j_full = jp
          err_full = e_p

        jjt = j_full @ j_full.T + (damping * damping) * np.eye(
            j_full.shape[0], dtype=np.float64
        )
        dq = j_full.T @ np.linalg.solve(jjt, err_full)
        j_pinv = j_full.T @ np.linalg.inv(jjt)
        null_proj = np.eye(self.dof) - j_pinv @ j_full
        dq = dq + 0.03 * (null_proj @ (null_target - q))
        max_step = float(np.max(np.abs(dq)))
        if max_step > 0.18:
          dq = dq * (0.18 / max_step)
        q = np.clip(q + dq, lo, hi)

      converged = pos_err_norm <= pos_tol_m and (
          tgt_r is None or rot_err_norm <= rot_tol_rad
      )
      score = pos_err_norm + 0.1 * rot_err_norm
      if best_ik_only is None or score < best_ik_only[0]:
        best_ik_only = (score, q.copy(), pos_err_norm, rot_err_norm)

      if converged:
        if scene is None:
          return {
              "success": True,
              "q": q,
              "pos_err_m": round(pos_err_norm, 6),
              "rot_err_rad": round(rot_err_norm, 5),
              "seed_index": seed_idx,
              "collision_check": None,
          }
        col_check = self.check_arm_config(
            scene,
            q,
            ignore_obstacles=ignore_obstacles,
            clearance_tol_m=clearance_tol_m,
        )
        if col_check["valid"]:
          return {
              "success": True,
              "q": q,
              "pos_err_m": round(pos_err_norm, 6),
              "rot_err_rad": round(rot_err_norm, 5),
              "seed_index": seed_idx,
              "collision_check": col_check,
          }
        if best_collision_fail is None:
          best_collision_fail = {
              "q": q.copy(),
              "pos_err_m": round(pos_err_norm, 6),
              "rot_err_rad": round(rot_err_norm, 5),
              "collision_check": col_check,
          }

    if best_collision_fail is not None:
      return {
          "success": False,
          "reason": "ik_converged_but_in_collision",
          **best_collision_fail,
      }
    assert best_ik_only is not None
    return {
        "success": False,
        "reason": "ik_did_not_converge",
        "q": best_ik_only[1],
        "pos_err_m": round(best_ik_only[2], 6),
        "rot_err_rad": round(best_ik_only[3], 5),
        "collision_check": (
            self.check_arm_config(
                scene,
                best_ik_only[1],
                ignore_obstacles=ignore_obstacles,
                clearance_tol_m=clearance_tol_m,
            )
            if scene is not None
            else None
        ),
    }

  def _raw_distance_vector(
      self, scene: Scene3D, q_arr: np.ndarray, include_self: bool = False
  ) -> np.ndarray:
    """Returns flat unrounded signed-distance vector for `q_arr`."""
    w_centers = self._world_sphere_centers_array(q_arr)
    dist_mat, _ = _compute_sphere_scene_dist_matrix(
        w_centers, self._sphere_radii, scene
    )
    terms: list[np.ndarray] = []
    if dist_mat is not None and dist_mat.size:
      terms.append(dist_mat.ravel())
    if include_self and self._self_col_pair_i.size:
      pi_idx = self._self_col_pair_i
      pj_idx = self._self_col_pair_j
      sdx = w_centers[pi_idx, 0] - w_centers[pj_idx, 0]
      sdy = w_centers[pi_idx, 1] - w_centers[pj_idx, 1]
      sdz = w_centers[pi_idx, 2] - w_centers[pj_idx, 2]
      sc_dists = (
          np.sqrt(sdx * sdx + sdy * sdy + sdz * sdz) - self._self_col_r_sum
      )
      if sc_dists.size:
        terms.append(sc_dists)
    if not terms:
      return np.zeros(0, dtype=np.float64)
    return terms[0] if len(terms) == 1 else np.concatenate(terms)

  def _raw_min_clearance(
      self, scene: Scene3D, q_arr: np.ndarray, include_self: bool = False
  ) -> float:
    """Returns unrounded exact minimum clearance (m) at `q_arr`."""
    d_vec = self._raw_distance_vector(scene, q_arr, include_self=include_self)
    return float(np.min(d_vec)) if d_vec.size else float("inf")

  def _is_escaped_config(
      self,
      scene: Scene3D,
      chk: dict[str, Any],
      q_vec: np.ndarray,
      target_clearance_m: float,
  ) -> bool:
    """Returns True if `q_vec` is collision-free and meets `target_clearance_m`."""
    del scene, q_vec
    if not chk["valid"]:
      return False
    clr = chk["min_clearance_m"]
    if clr is not None and float(clr) < float(target_clearance_m):
      return False
    return True

  def _is_escape_step_safe(
      self,
      scene: Scene3D,
      q_cur: np.ndarray,
      cur_check: dict[str, Any],
      cur_hard_clr: float,
      q_cand: np.ndarray,
      include_self: bool,
  ) -> tuple[bool, dict[str, Any] | None]:
    """Verifies `[q_cur, q_cand]` improves clearance with no new collisions."""
    step_dist = float(np.linalg.norm(q_cand - q_cur))
    if step_dist <= 1e-6:
      return False, None

    cand_check = self.check_arm_config(scene, q_cand)
    if cand_check["out_of_bounds_joints"]:
      return False, None

    cur_obs = {c["obstacle"] for c in cur_check["collisions"]}
    cand_obs = {c["obstacle"] for c in cand_check["collisions"]}
    if not cand_obs.issubset(cur_obs):
      return False, None

    cur_sc = {(c["part_a"], c["part_b"]) for c in cur_check["self_collisions"]}
    cand_sc = {
        (c["part_a"], c["part_b"]) for c in cand_check["self_collisions"]
    }
    if not cand_sc.issubset(cur_sc):
      return False, None

    cand_hard_clr = self._raw_min_clearance(
        scene, q_cand, include_self=include_self
    )
    fixed_oob = bool(cur_check["out_of_bounds_joints"]) and (
        not cand_check["out_of_bounds_joints"]
    )
    if not fixed_oob and cand_hard_clr <= cur_hard_clr + 1e-6:
      return False, None

    cur_oob = set(cur_check["out_of_bounds_joints"])
    n_seg = max(1, int(math.ceil(step_dist / 0.02)))
    for seg_k in range(1, n_seg):
      alpha = seg_k / n_seg
      q_mid = (1.0 - alpha) * q_cur + alpha * q_cand
      mid_check = self.check_arm_config(scene, q_mid)
      if not set(mid_check["out_of_bounds_joints"]).issubset(cur_oob):
        return False, None
      mid_obs = {c["obstacle"] for c in mid_check["collisions"]}
      if not mid_obs.issubset(cur_obs):
        return False, None
      mid_sc = {
          (c["part_a"], c["part_b"]) for c in mid_check["self_collisions"]
      }
      if not mid_sc.issubset(cur_sc):
        return False, None
      mid_hard_clr = self._raw_min_clearance(
          scene, q_mid, include_self=include_self
      )
      if mid_hard_clr < cur_hard_clr - 5e-4:
        return False, None

    return True, cand_check

  def _solve_minimax_escape_delta(
      self,
      d_act: np.ndarray,
      jac_act: np.ndarray,
      dq_lo: np.ndarray,
      dq_hi: np.ndarray,
      target_clearance_m: float,
      step_cap: float,
  ) -> np.ndarray:
    """Computes a feasible joint step maximizing `min(d_act + jac_act @ dq)`."""
    dq = np.zeros(self.dof, dtype=np.float64)
    best_dq = dq.copy()
    best_min = float(np.min(d_act))
    goal_clr = float(target_clearance_m) + 0.003
    tau_opt = 0.001
    base_lr = min(step_cap, 0.20) / 10.0
    for micro in range(60):
      pred = d_act + np.sum(jac_act * dq[None, :], axis=1)
      p_min = float(np.min(pred))
      if p_min > best_min + 1e-9:
        best_min = p_min
        best_dq = dq.copy()
      if p_min >= goal_clr:
        break
      weights = np.exp((p_min - pred) / tau_opt)
      weights /= float(np.sum(weights))
      g_sub = np.sum(jac_act * weights[:, None], axis=0)
      g_sub[(dq <= dq_lo + 1e-7) & (g_sub < 0.0)] = 0.0
      g_sub[(dq >= dq_hi - 1e-7) & (g_sub > 0.0)] = 0.0
      g_norm = float(np.linalg.norm(g_sub))
      if g_norm <= 1e-9:
        break
      lr = base_lr * (1.0 - 0.8 * (micro / 60.0))
      dq = np.clip(dq + lr * (g_sub / g_norm), dq_lo, dq_hi)
      dq_norm = float(np.linalg.norm(dq))
      if dq_norm > step_cap:
        dq = dq * (step_cap / dq_norm)
    pred_end = d_act + np.sum(jac_act * dq[None, :], axis=1)
    if float(np.min(pred_end)) > best_min:
      best_dq = dq
    return best_dq

  def escape_initial_collision(
      self,
      scene: Scene3D,
      q_start: Sequence[float] | np.ndarray,
      target_clearance_m: float = 0.015,
      max_step_rad: float = 0.25,
      num_iters: int = 25,
      control_dt_s: float = 0.04,
  ) -> dict[str, Any]:
    """Retracts `q_start` along the clearance gradient to `target_clearance_m`.

    Iteratively steps `q` along the finite-difference gradient of minimum
    obstacle clearance while clamping within joint limits and checking that no
    new obstacle or self-collisions are introduced along each escape segment.

    Args:
      scene: Static 3D obstacle collection.
      q_start: Initial arm configuration (rad or m).
      target_clearance_m: Desired minimum obstacle clearance (m).
      max_step_rad: Maximum joint-space L2 step norm per iteration.
      num_iters: Maximum gradient-ascent iterations.
      control_dt_s: Control timestep (s) for `q_trajectory` resampling.

    Returns:
      Dict with `'escaped'`, `'q_escaped'`, `'waypoints'`, `'q_trajectory'`,
      `'initial_check'`, and `'final_check'`.
    """
    q0 = self.clamp_within_tolerance(q_start)
    initial_check = self.check_arm_config(scene, q0)
    if self._is_escaped_config(scene, initial_check, q0, target_clearance_m):
      wps = q0.reshape(1, self.dof).copy()
      return {
          "escaped": True,
          "q_escaped": q0.copy(),
          "waypoints": wps,
          "q_trajectory": wps.copy(),
          "initial_check": initial_check,
          "final_check": initial_check,
      }

    lo = self.q_min + 1e-4
    hi = self.q_max - 1e-4
    step_cap = max(1e-4, float(max_step_rad))
    fd_eps = 1e-4
    q_cur = q0.copy()
    cur_check = initial_check
    waypoint_list: list[np.ndarray] = [q0.copy()]

    for iter_idx in range(max(0, int(num_iters))):
      if self._is_escaped_config(scene, cur_check, q_cur, target_clearance_m):
        break
      include_self = bool(cur_check["self_collisions"]) or (
          not scene.primitives
      )
      cur_hard = self._raw_min_clearance(
          scene, q_cur, include_self=include_self
      )
      q_base = np.clip(q_cur, lo, hi)
      d_base = self._raw_distance_vector(
          scene, q_base, include_self=include_self
      )
      cand_deltas: list[np.ndarray] = []

      if d_base.size:
        base_min = float(np.min(d_base))
        active_idx = np.nonzero(d_base <= base_min + 0.035)[0]
        if active_idx.size > 64:
          part = np.argpartition(d_base[active_idx], 64)[:64]
          active_idx = active_idx[part]
        elif active_idx.size == 0:
          active_idx = np.array([int(np.argmin(d_base))], dtype=np.int32)
        d_act = d_base[active_idx]
        jac_act = np.zeros((active_idx.size, self.dof), dtype=np.float64)
        cusp_dir = np.zeros(self.dof, dtype=np.float64)
        min_m = int(np.argmin(d_act))

        for j in range(self.dof):
          qp = q_base.copy()
          qm = q_base.copy()
          qp[j] = min(float(hi[j]), float(q_base[j]) + fd_eps)
          qm[j] = max(float(lo[j]), float(q_base[j]) - fd_eps)
          span = float(qp[j] - qm[j])
          if span <= 1e-12:
            continue
          dp = self._raw_distance_vector(scene, qp, include_self=include_self)[
              active_idx
          ]
          dm = self._raw_distance_vector(scene, qm, include_self=include_self)[
              active_idx
          ]
          jac_act[:, j] = (dp - dm) / span
          if dp[min_m] >= dm[min_m] and dp[min_m] > d_act[min_m]:
            cusp_dir[j] = (dp[min_m] - d_act[min_m]) / max(
                float(qp[j] - q_base[j]), 1e-9
            )
          elif dm[min_m] > dp[min_m] and dm[min_m] > d_act[min_m]:
            cusp_dir[j] = -(dm[min_m] - d_act[min_m]) / max(
                float(q_base[j] - qm[j]), 1e-9
            )

        dq_minimax = self._solve_minimax_escape_delta(
            d_act,
            jac_act,
            lo - q_base,
            hi - q_base,
            target_clearance_m,
            step_cap,
        )
        if float(np.linalg.norm(dq_minimax)) > 1e-6:
          cand_deltas.append(dq_minimax)

        w_soft = np.exp((base_min - d_act) / 0.0025)
        w_soft /= float(np.sum(w_soft))
        g_soft = np.sum(jac_act * w_soft[:, None], axis=0)
        g_hard = jac_act[min_m].copy()
        deficit = max(0.004, float(target_clearance_m) + 0.002 - base_min)
        for g_vec in (g_soft, g_hard, cusp_dir):
          g_f = g_vec.copy()
          g_f[(q_base <= lo + 1e-6) & (g_f < 0.0)] = 0.0
          g_f[(q_base >= hi - 1e-6) & (g_f > 0.0)] = 0.0
          gn = float(np.linalg.norm(g_f))
          if gn > 1e-8:
            mag = min(step_cap, max(min(0.015, step_cap), deficit / gn))
            cand_deltas.append(mag * (g_f / gn))

      rng = np.random.default_rng(iter_idx + 1)
      ref_delta = cand_deltas[0] if cand_deltas else np.zeros(self.dof)
      ref_norm = float(np.linalg.norm(ref_delta))
      for _ in range(8):
        noise = rng.normal(0.0, 1.0, size=self.dof)
        noise_norm = max(float(np.linalg.norm(noise)), 1e-9)
        if ref_norm > 1e-6:
          pert = 0.65 * (ref_delta / ref_norm) + 0.55 * (noise / noise_norm)
        else:
          pert = noise / noise_norm
        pert_norm = max(float(np.linalg.norm(pert)), 1e-9)
        cand_deltas.append(min(step_cap, 0.12) * (pert / pert_norm))

      accepted = False
      for delta_vec in cand_deltas:
        for scale in (1.0, 0.5, 0.25, 0.1, 0.03):
          raw_delta = q_base + scale * delta_vec - q_cur
          d_norm = float(np.linalg.norm(raw_delta))
          if d_norm > step_cap:
            raw_delta = raw_delta * (step_cap / d_norm)
          q_cand = np.clip(q_cur + raw_delta, lo, hi)
          ok, next_check = self._is_escape_step_safe(
              scene, q_cur, cur_check, cur_hard, q_cand, include_self
          )
          if ok and next_check is not None:
            q_cur = q_cand
            cur_check = next_check
            waypoint_list.append(q_cur.copy())
            accepted = True
            break
        if accepted:
          break

      if not accepted:
        break

    escaped = self._is_escaped_config(
        scene, cur_check, q_cur, target_clearance_m
    )
    if not escaped and scene.primitives:
      init_obs = {c["obstacle"] for c in initial_check["collisions"]}
      init_sc = {
          (c["part_a"], c["part_b"]) for c in initial_check["self_collisions"]
      }
      init_hard = self._raw_min_clearance(
          scene, q_cur, include_self=bool(init_sc)
      )
      ee_p, ee_r = self.fk(q_cur)
      retreat_candidates: list[np.ndarray] = []
      if int(self.mj_model.jnt_type[self.joint_ids[0]]) == int(
          mujoco.mjtJoint.mjJNT_HINGE
      ):
        for d0 in (-0.35, 0.35, -0.55, 0.55):
          qc = q_cur.copy()
          qc[0] = float(np.clip(qc[0] + d0, lo[0], hi[0]))
          retreat_candidates.append(qc)
      grav = np.asarray(self.mj_model.opt.gravity, dtype=np.float64)
      grav_n = float(np.linalg.norm(grav))
      up_world = (
          -grav / grav_n
          if grav_n > 1e-6
          else np.array([0.0, 0.0, 1.0], dtype=np.float64)
      )
      app_world = ee_r @ self._approach_axis_ee
      for d_xyz in (
          -0.12 * app_world,
          np.array([0.0, -0.18, 0.0]) + 0.08 * up_world,
          np.array([0.0, 0.18, 0.0]) + 0.08 * up_world,
          np.array([-0.14, 0.0, 0.0]) + 0.08 * up_world,
          np.array([0.14, 0.0, 0.0]) + 0.08 * up_world,
          0.14 * up_world,
      ):
        ik_r = self.solve_ik(
            ee_p + d_xyz,
            ee_r,
            q_seed=q_cur,
            scene=scene,
            num_restarts=4,
            max_iters=90,
        )
        if ik_r["success"]:
          retreat_candidates.append(np.asarray(ik_r["q"], dtype=np.float64))

      best_fb: tuple[float, float, np.ndarray, dict[str, Any]] | None = None
      for qc in retreat_candidates:
        c_chk = self.check_arm_config(scene, qc)
        if not self._is_escaped_config(scene, c_chk, qc, target_clearance_m):
          continue
        seg_len = float(np.linalg.norm(qc - q_cur))
        if seg_len <= 1e-5 or seg_len > 1.2:
          continue
        n_seg = max(2, int(math.ceil(seg_len / 0.03)))
        seg_ok = True
        worst_drop = 0.0
        for sk in range(1, n_seg):
          qm = (1.0 - sk / n_seg) * q_cur + (sk / n_seg) * qc
          m_chk = self.check_arm_config(scene, qm)
          if m_chk["out_of_bounds_joints"]:
            seg_ok = False
            break
          if not {c["obstacle"] for c in m_chk["collisions"]}.issubset(
              init_obs
          ):
            seg_ok = False
            break
          if not {
              (c["part_a"], c["part_b"]) for c in m_chk["self_collisions"]
          }.issubset(init_sc):
            seg_ok = False
            break
          mh = self._raw_min_clearance(scene, qm, include_self=bool(init_sc))
          worst_drop = max(worst_drop, init_hard - mh)
          if worst_drop > 0.020:
            seg_ok = False
            break
        if seg_ok:
          key = (round(worst_drop, 4), seg_len)
          if best_fb is None or key < (best_fb[0], best_fb[1]):
            best_fb = (key[0], key[1], qc.copy(), c_chk)

      if best_fb is not None:
        q_cur = best_fb[2]
        cur_check = best_fb[3]
        waypoint_list.append(q_cur.copy())
        escaped = True

    waypoints = np.vstack(waypoint_list)
    q_traj = resample_waypoints_cosine(
        waypoints, max_joint_vel_rad_s=0.75, control_dt_s=control_dt_s
    )
    return {
        "escaped": escaped,
        "q_escaped": q_cur.copy(),
        "waypoints": waypoints,
        "q_trajectory": q_traj,
        "initial_check": initial_check,
        "final_check": cur_check,
    }

  def plan_cartesian_stroke(
      self,
      q_start: Sequence[float] | np.ndarray,
      target_pos: Sequence[float] | np.ndarray,
      target_rot: Sequence[Sequence[float]] | np.ndarray | None = None,
      num_waypoints: int = 8,
      scene: Scene3D | None = None,
      ignore_obstacles: Sequence[str] = (),
      clearance_tol_m: float = 0.0,
      max_step_rad: float = 0.35,
      max_joint_vel_rad_s: float = 0.55,
      control_dt_s: float = 0.04,
      max_joint_acc_rad_s2: float = 5.0,
  ) -> dict[str, Any]:
    """Plans a straight-line Cartesian EE stroke without wrist branch flips."""
    q_0 = self.clamp_within_tolerance(q_start)
    p_0, r_0 = self.fk(q_0)
    tgt_p = np.asarray(target_pos, dtype=np.float64).reshape(3)
    tgt_r = (
        r_0.copy()
        if target_rot is None
        else np.asarray(target_rot, dtype=np.float64).reshape(3, 3)
    )
    n_wp = max(1, int(num_waypoints))
    step_cap = max(1e-3, float(max_step_rad))
    worst_clearance = float("inf")

    if scene is not None:
      start_chk = self.check_arm_config(
          scene,
          q_0,
          ignore_obstacles=ignore_obstacles,
          clearance_tol_m=clearance_tol_m,
      )
      if start_chk["min_clearance_m"] is not None:
        worst_clearance = min(
            worst_clearance, float(start_chk["min_clearance_m"])
        )
      if not start_chk["valid"]:
        return {
            "solved": False,
            "reason": "start_in_collision",
            "waypoints": np.zeros((0, self.dof), dtype=np.float64),
            "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
            "duration_s": 0.0,
            "min_clearance_m": start_chk["min_clearance_m"],
            "failed_step": 0,
            "failed_detail": start_chk,
        }

    waypoints_list: list[np.ndarray] = [q_0.copy()]
    q_prev = q_0.copy()
    local_rng = np.random.default_rng(0)

    for k in range(1, n_wp + 1):
      alpha = k / n_wp
      p_k = (1.0 - alpha) * p_0 + alpha * tgt_p
      r_k = _slerp_rotation(r_0, tgt_r, alpha)

      ik = self.solve_ik(
          p_k,
          r_k,
          q_seed=q_prev,
          scene=scene,
          pos_tol_m=7.5e-4,
          rot_tol_rad=1.5e-2,
          num_restarts=8,
          ignore_obstacles=ignore_obstacles,
          clearance_tol_m=clearance_tol_m,
      )
      q_cand = ik["q"]
      max_jump = float(np.max(np.abs(q_cand - q_prev)))

      if (not ik["success"]) or (max_jump > step_cap):
        best_local: dict[str, Any] | None = None
        best_local_jump = float("inf")
        for _ in range(6):
          q_pert = np.clip(
              q_prev + local_rng.normal(0.0, 0.04, size=self.dof),
              self.q_min + 0.01,
              self.q_max - 0.01,
          )
          cand_ik = self.solve_ik(
              p_k,
              r_k,
              q_seed=q_pert,
              scene=scene,
              pos_tol_m=1.2e-3,
              rot_tol_rad=2.0e-2,
              num_restarts=1,
              ignore_obstacles=ignore_obstacles,
              clearance_tol_m=clearance_tol_m,
          )
          if cand_ik["success"]:
            jmp = float(np.max(np.abs(cand_ik["q"] - q_prev)))
            if jmp <= step_cap and jmp < best_local_jump:
              best_local = cand_ik
              best_local_jump = jmp
        if best_local is not None:
          ik = best_local
          q_cand = best_local["q"]
          max_jump = best_local_jump

      if not ik["success"]:
        return {
            "solved": False,
            "reason": str(ik.get("reason", "ik_failed")),
            "waypoints": np.vstack(waypoints_list),
            "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
            "duration_s": 0.0,
            "min_clearance_m": (
                0.0 + round(worst_clearance, 5)
                if math.isfinite(worst_clearance)
                else None
            ),
            "failed_step": k,
            "failed_detail": ik,
        }

      if max_jump > step_cap:
        return {
            "solved": False,
            "reason": "branch_jump_exceeded",
            "waypoints": np.vstack(waypoints_list),
            "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
            "duration_s": 0.0,
            "min_clearance_m": (
                0.0 + round(worst_clearance, 5)
                if math.isfinite(worst_clearance)
                else None
            ),
            "failed_step": k,
            "failed_detail": {
                "max_joint_step_rad": round(max_jump, 5),
                "max_step_rad": step_cap,
                "ik": ik,
            },
        }

      if scene is not None:
        seg = self.check_arm_segment(
            scene,
            q_prev,
            q_cand,
            ignore_obstacles=ignore_obstacles,
            clearance_tol_m=clearance_tol_m,
        )
        if seg["min_clearance_m"] is not None:
          worst_clearance = min(worst_clearance, float(seg["min_clearance_m"]))
        if not seg["valid"]:
          return {
              "solved": False,
              "reason": "segment_in_collision",
              "waypoints": np.vstack(waypoints_list),
              "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
              "duration_s": 0.0,
              "min_clearance_m": (
                  0.0 + round(worst_clearance, 5)
                  if math.isfinite(worst_clearance)
                  else None
              ),
              "failed_step": k,
              "failed_detail": seg,
          }

      waypoints_list.append(q_cand.copy())
      q_prev = q_cand.copy()

    waypoints = np.vstack(waypoints_list)
    q_traj = resample_waypoints_cosine(
        waypoints,
        max_joint_vel_rad_s=max_joint_vel_rad_s,
        control_dt_s=control_dt_s,
        max_joint_acc_rad_s2=max_joint_acc_rad_s2,
    )
    return {
        "solved": True,
        "reason": "ok",
        "waypoints": waypoints,
        "q_trajectory": q_traj,
        "duration_s": round(max(0, q_traj.shape[0] - 1) * control_dt_s, 3),
        "min_clearance_m": (
            0.0 + round(worst_clearance, 5)
            if math.isfinite(worst_clearance)
            else None
        ),
    }

  def _any_self_collision_batch(self, w_chunk: np.ndarray) -> bool:
    """Intersection-AABB-culled rigid-group self-collision check on `(K, S, 3)`."""
    n_g = len(self._sc_group_spheres)
    if n_g < 2 or not self._sc_ga_idx.size:
      return False
    k_len = int(w_chunk.shape[0])
    r_3d = self._sphere_radii[None, :, None]
    s_lo = w_chunk - r_3d
    s_hi = w_chunk + r_3d
    g_lo = np.empty((k_len, n_g, 3), dtype=np.float64)
    g_hi = np.empty((k_len, n_g, 3), dtype=np.float64)
    for gi, sp_idx in enumerate(self._sc_group_spheres):
      g_lo[:, gi, :] = np.min(s_lo[:, sp_idx, :], axis=1)
      g_hi[:, gi, :] = np.max(s_hi[:, sp_idx, :], axis=1)

    i_lo = np.maximum(g_lo[:, self._sc_ga_idx, :], g_lo[:, self._sc_gb_idx, :])
    i_hi = np.minimum(g_hi[:, self._sc_ga_idx, :], g_hi[:, self._sc_gb_idx, :])
    ov = (
        (i_lo[:, :, 0] <= i_hi[:, :, 0])
        & (i_lo[:, :, 1] <= i_hi[:, :, 1])
        & (i_lo[:, :, 2] <= i_hi[:, :, 2])
    )
    if not np.any(ov):
      return False

    for p_idx in np.nonzero(np.any(ov, axis=0))[0]:
      k_act = np.nonzero(ov[:, p_idx])[0]
      u_ilo = np.min(i_lo[k_act, p_idx, :], axis=0)
      u_ihi = np.max(i_hi[k_act, p_idx, :], axis=0)
      idx_a = self._sc_group_spheres[int(self._sc_ga_idx[p_idx])]
      idx_b = self._sc_group_spheres[int(self._sc_gb_idx[p_idx])]
      sa_lo = s_lo[k_act][:, idx_a, :]
      sa_hi = s_hi[k_act][:, idx_a, :]
      ma = np.any(
          (sa_hi[:, :, 0] >= u_ilo[0])
          & (sa_lo[:, :, 0] <= u_ihi[0])
          & (sa_hi[:, :, 1] >= u_ilo[1])
          & (sa_lo[:, :, 1] <= u_ihi[1])
          & (sa_hi[:, :, 2] >= u_ilo[2])
          & (sa_lo[:, :, 2] <= u_ihi[2]),
          axis=0,
      )
      if not np.any(ma):
        continue
      sb_lo = s_lo[k_act][:, idx_b, :]
      sb_hi = s_hi[k_act][:, idx_b, :]
      mb = np.any(
          (sb_hi[:, :, 0] >= u_ilo[0])
          & (sb_lo[:, :, 0] <= u_ihi[0])
          & (sb_hi[:, :, 1] >= u_ilo[1])
          & (sb_lo[:, :, 1] <= u_ihi[1])
          & (sb_hi[:, :, 2] >= u_ilo[2])
          & (sb_lo[:, :, 2] <= u_ihi[2]),
          axis=0,
      )
      if not np.any(mb):
        continue
      act_a = idx_a[ma]
      act_b = idx_b[mb]
      wa = w_chunk[k_act][:, act_a, :]
      wb = w_chunk[k_act][:, act_b, :]
      diff = wa[:, :, None, :] - wb[:, None, :, :]
      d2 = (
          diff[:, :, :, 0] * diff[:, :, :, 0]
          + diff[:, :, :, 1] * diff[:, :, :, 1]
          + diff[:, :, :, 2] * diff[:, :, :, 2]
      )
      th = (
          self._sphere_radii[act_a][None, :, None]
          + self._sphere_radii[act_b][None, None, :]
          - 1e-6
      )
      if bool(np.any(d2 < np.where(th > 0.0, th * th, -1.0))):
        return True
    return False

  def _is_arm_config_valid_fast(
      self,
      scene: Scene3D,
      q_arr: np.ndarray,
      inflation_m: float = 0.0,
      skip_inflation_groups: Sequence[str] = ("table",),
  ) -> bool:
    """Fast boolean validity check for joint limits, `scene`, and self-collision."""
    if bool(np.any((q_arr < self.q_min - 1e-5) | (q_arr > self.q_max + 1e-5))):
      return False
    w_centers = self._world_sphere_centers_array(q_arr)
    if _any_spheres_collide_with_scene(
        w_centers,
        self._sphere_radii,
        scene,
        inflation_m=inflation_m,
        skip_inflation_groups=skip_inflation_groups,
    ):
      return False
    if self._sc_ga_idx.size and self._any_self_collision_batch(
        w_centers[None, :, :]
    ):
      return False
    return True

  def _is_arm_segment_valid_fast(
      self,
      scene: Scene3D,
      q_a: np.ndarray,
      q_b: np.ndarray,
      step_rad: float,
      inflation_m: float = 0.0,
      skip_inflation_groups: Sequence[str] = ("table",),
  ) -> bool:
    """Dyadic AABB-culled linear joint segment `[q_a, q_b]` check."""
    lo = self.q_min - 1e-5
    hi = self.q_max + 1e-5
    if bool(np.any((q_b < lo) | (q_b > hi))) or bool(
        np.any((q_a < lo) | (q_a > hi))
    ):
      return False
    dist = float(np.linalg.norm(q_b - q_a))
    n_steps = max(1, int(math.ceil(dist / max(1e-4, step_rad))))
    probe_a, rem_a = _dyadic_segment_alphas(n_steps)
    delta = q_b - q_a
    has_sc = bool(self._sc_ga_idx.size)

    w_probe = self._world_sphere_centers_batch(
        q_a[None, :] + probe_a[:, None] * delta[None, :]
    )
    if _any_spheres_collide_with_scene(
        w_probe, self._sphere_radii, scene, inflation_m, skip_inflation_groups
    ):
      return False
    if has_sc and self._any_self_collision_batch(w_probe):
      return False

    if rem_a.size:
      w_rem = self._world_sphere_centers_batch(
          q_a[None, :] + rem_a[:, None] * delta[None, :]
      )
      for start_k in range(0, int(rem_a.size), 16):
        w_slice = w_rem[start_k : start_k + 16]
        if _any_spheres_collide_with_scene(
            w_slice,
            self._sphere_radii,
            scene,
            inflation_m,
            skip_inflation_groups,
        ):
          return False
        if has_sc and self._any_self_collision_batch(w_slice):
          return False
    return True

  def plan_arm(
      self,
      scene: Scene3D,
      q_start: Sequence[float] | np.ndarray,
      q_goal: Sequence[float] | np.ndarray,
      planner_kind: str = "birrt",
      max_iterations: int = 12000,
      max_time_ms: float = 3000.0,
      step_size: float = 0.75,
      motion_step_size: float = 0.03125,
      max_joint_vel_rad_s: float = 1.25,
      control_dt_s: float = 0.04,
      seed: int = 1,
      max_joint_acc_rad_s2: float = 5.0,
      safety_margin_m: float = 0.015,
      max_cartesian_vel_m_s: float = 0.65,
  ) -> dict[str, Any]:
    """Plans a collision-free arm (+ attached object) trajectory."""
    del planner_kind
    q0 = self.clamp_within_tolerance(q_start)
    q1 = self.clamp_within_tolerance(q_goal)

    start_check = self.check_arm_config(scene, q0)
    goal_check = self.check_arm_config(scene, q1)
    if not start_check["valid"] or not goal_check["valid"]:
      return {
          "solved": False,
          "reason": "start_or_goal_invalid",
          "start_check": start_check,
          "goal_check": goal_check,
          "waypoints": np.zeros((0, self.dof), dtype=np.float64),
          "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
          "duration_s": 0.0,
          "applied_safety_margin_m": 0.0,
      }

    non_table_s = self.check_arm_config(
        scene, q0, check_self_collision=False, ignore_obstacles=("table",)
    )
    non_table_g = self.check_arm_config(
        scene, q1, check_self_collision=False, ignore_obstacles=("table",)
    )
    min_end_clr = _min_optional_clearance(
        non_table_s["min_clearance_m"], non_table_g["min_clearance_m"]
    )
    margins = _dedup_safety_margins(safety_margin_m, min_end_clr)

    last_res: dict[str, Any] | None = None
    applied_margin = 0.0
    m_step = max(1e-3, float(motion_step_size))
    for m in margins:
      if m > 0.0 and (
          not self._is_arm_config_valid_fast(scene, q0, m, ("table",))
          or not self._is_arm_config_valid_fast(scene, q1, m, ("table",))
      ):
        continue
      iters_m = (
          max(1500, int(0.6 * int(max_iterations)))
          if m > 0.0
          else int(max_iterations)
      )
      time_m = (
          min(float(max_time_ms), max(400.0, 0.5 * float(max_time_ms)))
          if m > 0.0
          else float(max_time_ms)
      )
      res = _plan_birrt(
          q_start=q0,
          q_goal=q1,
          q_min=self.q_min,
          q_max=self.q_max,
          step_size=step_size,
          is_segment_valid_fn=lambda a, b, inf_m=m: self._is_arm_segment_valid_fast(
              scene, a, b, m_step, inf_m, ("table",)
          ),
          max_iterations=iters_m,
          max_time_ms=time_m,
          seed=seed,
      )
      last_res = res
      if res["solved"] and res["waypoints"].shape[0] >= 2:
        applied_margin = 0.0 + round(float(m), 5)
        break

    assert last_res is not None
    if not last_res["solved"] or last_res["waypoints"].shape[0] < 2:
      return {
          "solved": False,
          "reason": "planner_exhausted",
          "start_check": start_check,
          "goal_check": goal_check,
          "waypoints": last_res["waypoints"],
          "q_trajectory": np.zeros((0, self.dof), dtype=np.float64),
          "duration_s": 0.0,
          "iterations": int(last_res["iterations"]),
          "solve_time_ms": round(float(last_res["solve_time_ms"]), 2),
          "applied_safety_margin_m": 0.0,
      }

    eff_joint_vel = float(max_joint_vel_rad_s)
    if max_cartesian_vel_m_s > 0.0 and self._sphere_radii.size > 0:
      wps = last_res["waypoints"]
      total_q_len = float(np.sum(np.linalg.norm(np.diff(wps, axis=0), axis=1)))
      n_sub = max(
          int(wps.shape[0]), min(32, int(math.ceil(total_q_len / 0.15)) + 1)
      )
      dense_wps = np.asarray(
          _subdivide_preserving_waypoints(wps, n_sub),
          dtype=np.float64,
      )
      if dense_wps.shape[0] >= 2:
        dq_inf = np.max(np.abs(np.diff(dense_wps, axis=0)), axis=1)
        valid_dq = dq_inf > 1e-6
        if np.any(valid_dq):
          w_dense = self._world_sphere_centers_batch(dense_wps)
          dw_max = np.max(
              np.linalg.norm(np.diff(w_dense, axis=0), axis=-1), axis=1
          )
          max_lever = float(np.max(dw_max[valid_dq] / dq_inf[valid_dq]))
          if max_lever > 1e-6:
            eff_joint_vel = min(
                eff_joint_vel, float(max_cartesian_vel_m_s) / max_lever
            )

    q_traj = resample_waypoints_cosine(
        last_res["waypoints"],
        max_joint_vel_rad_s=eff_joint_vel,
        control_dt_s=control_dt_s,
        max_joint_acc_rad_s2=max_joint_acc_rad_s2,
    )
    return {
        "solved": True,
        "reason": "ok",
        "waypoints": last_res["waypoints"],
        "q_trajectory": q_traj,
        "duration_s": round((q_traj.shape[0] - 1) * control_dt_s, 3),
        "cost": round(float(last_res["cost"]), 5),
        "iterations": int(last_res["iterations"]),
        "solve_time_ms": round(float(last_res["solve_time_ms"]), 2),
        "applied_safety_margin_m": applied_margin,
        "start_check": start_check,
        "goal_check": goal_check,
    }


def resample_waypoints_cosine(
    waypoints: np.ndarray,
    max_joint_vel_rad_s: float = 1.25,
    control_dt_s: float = 0.04,
    max_joint_acc_rad_s2: float = 5.0,
) -> np.ndarray:
  """Resamples piecewise-linear joint waypoints smoothly at `control_dt_s`."""
  wps = np.asarray(waypoints, dtype=np.float64)
  if wps.shape[0] <= 1:
    return wps.copy()

  # Arc-length parameterization using L_inf joint step so every joint stays
  # within max_joint_vel_rad_s and max_joint_acc_rad_s2 under cosine easing.
  seg_max_delta = np.max(np.abs(np.diff(wps, axis=0)), axis=1)
  cum_s = np.concatenate([[0.0], np.cumsum(seg_max_delta)])
  total_s = float(cum_s[-1])
  if total_s < 1e-8:
    return wps[:1].copy()

  vel_duration = (math.pi / 2.0) * total_s / max(max_joint_vel_rad_s, 0.05)
  min_duration = max(
      vel_duration,
      math.sqrt(0.5 * (math.pi**2) * total_s / max(max_joint_acc_rad_s2, 0.2)),
  )
  num_steps = max(2, int(math.ceil(min_duration / max(control_dt_s, 1e-3))))

  out = np.zeros((num_steps + 1, wps.shape[1]), dtype=np.float64)
  out[0] = wps[0]
  for step_idx in range(1, num_steps + 1):
    # Smooth cosine-eased progress alpha in [0, 1] (zero start/end velocity)
    alpha = 0.5 * (1.0 - math.cos(math.pi * step_idx / num_steps))
    s_query = alpha * total_s
    seg_idx = int(np.searchsorted(cum_s, s_query, side="right")) - 1
    seg_idx = max(0, min(seg_idx, len(seg_max_delta) - 1))
    ds = float(seg_max_delta[seg_idx])
    local_u = (s_query - float(cum_s[seg_idx])) / ds if ds > 1e-12 else 0.0
    local_u = float(np.clip(local_u, 0.0, 1.0))
    out[step_idx] = (1.0 - local_u) * wps[seg_idx] + local_u * wps[seg_idx + 1]
  return out


# ---------------------------------------------------------------------------
# 5. Camera Reprojection Visualizer (`render_scene_overlay`)
# ---------------------------------------------------------------------------


def _apply_joint_positions_to_mjdata(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    joint_positions: (
        Mapping[str, Any] | Sequence[float] | np.ndarray | None
    ) = None,
    right_joint_pos: Sequence[float] | np.ndarray | None = None,
) -> None:
  """Populates `data.qpos` from arm-keyed dict, joint-name dict, or sequence."""
  data.qpos[:] = model.qpos0
  if joint_positions is None and right_joint_pos is None:
    return

  arm_specs = _discover_robot_arms(model)

  if right_joint_pos is not None:
    # Legacy bimanual positional/keyword `(left_q, right_q)`
    if joint_positions is not None and not isinstance(joint_positions, Mapping):
      left_spec = arm_specs.get("left")
      if left_spec is not None:
        q_l = np.asarray(joint_positions, dtype=np.float64).ravel()
        for k in range(min(len(q_l), len(left_spec.joint_ids))):
          qadr = int(model.jnt_qposadr[left_spec.joint_ids[k]])
          data.qpos[qadr] = float(q_l[k])
    right_spec = arm_specs.get("right")
    if right_spec is not None:
      q_r = np.asarray(right_joint_pos, dtype=np.float64).ravel()
      for k in range(min(len(q_r), len(right_spec.joint_ids))):
        qadr = int(model.jnt_qposadr[right_spec.joint_ids[k]])
        data.qpos[qadr] = float(q_r[k])
    return

  if isinstance(joint_positions, Mapping):
    # Build lookup by full and leaf joint names as well as discovered arm keys
    jname_to_id: dict[str, int] = {}
    for jid in range(int(model.njnt)):
      jn = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), jid)
      if jn:
        jname_to_id[jn] = jid
        leaf = jn.split("/")[-1]
        if leaf not in jname_to_id:
          jname_to_id[leaf] = jid

    for key, val in joint_positions.items():
      if val is None:
        continue
      k_str = str(key)
      if k_str in arm_specs and not np.isscalar(val):
        spec = arm_specs[k_str]
        q_vec = np.asarray(val, dtype=np.float64).ravel()
        for idx in range(min(len(q_vec), len(spec.joint_ids))):
          qadr = int(model.jnt_qposadr[spec.joint_ids[idx]])
          data.qpos[qadr] = float(q_vec[idx])
      elif (
          len(arm_specs) == 1
          and k_str in ("left", "arm", "default")
          and not np.isscalar(val)
      ):
        spec = next(iter(arm_specs.values()))
        q_vec = np.asarray(val, dtype=np.float64).ravel()
        for idx in range(min(len(q_vec), len(spec.joint_ids))):
          qadr = int(model.jnt_qposadr[spec.joint_ids[idx]])
          data.qpos[qadr] = float(q_vec[idx])
      elif k_str in jname_to_id:
        jid = jname_to_id[k_str]
        qadr = int(model.jnt_qposadr[jid])
        arr = np.asarray(val, dtype=np.float64).ravel()
        if arr.size > 0:
          data.qpos[qadr] = float(arr[0])
    return

  q_seq = np.asarray(joint_positions, dtype=np.float64).ravel()
  if q_seq.size == int(model.nq):
    data.qpos[:] = q_seq
    return
  if len(arm_specs) == 1:
    spec = next(iter(arm_specs.values()))
    for idx in range(min(q_seq.size, len(spec.joint_ids))):
      qadr = int(model.jnt_qposadr[spec.joint_ids[idx]])
      data.qpos[qadr] = float(q_seq[idx])
    return
  total_arm_dof = sum(len(s.joint_ids) for s in arm_specs.values())
  if q_seq.size == total_arm_dof and total_arm_dof > 0:
    offset = 0
    for spec in arm_specs.values():
      for jid in spec.joint_ids:
        data.qpos[int(model.jnt_qposadr[jid])] = float(q_seq[offset])
        offset += 1
  elif arm_specs:
    first_spec = next(iter(arm_specs.values()))
    for idx in range(min(q_seq.size, len(first_spec.joint_ids))):
      qadr = int(model.jnt_qposadr[first_spec.joint_ids[idx]])
      data.qpos[qadr] = float(q_seq[idx])


def _build_mjcf_camera_lookup(model: mujoco.MjModel) -> dict[str, int]:
  """Maps full, short, and `*_rgb_image` camera keys to MuJoCo `cam_id`."""
  lookup: dict[str, int] = {}
  for cid in range(int(model.ncam)):
    cname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_CAMERA), cid)
        or f"cam_{cid}"
    )
    short = cname.split("/")[-1]
    for alias in (
        cname,
        short,
        f"{short}_rgb_image",
        f"{cname}_rgb_image",
        f"{short}_rgb",
        f"{short}_color",
        f"{short}_image",
    ):
      if alias not in lookup:
        lookup[alias] = int(cid)
  return lookup


def get_camera_poses_in_robot_frame(
    mjcf_path: str | None = None,
    joint_positions: (
        Mapping[str, Any] | Sequence[float] | np.ndarray | None
    ) = None,
    right_joint_pos: Sequence[float] | np.ndarray | None = None,
    *,
    left_joint_pos: Sequence[float] | np.ndarray | None = None,
) -> dict[str, dict[str, Any]]:
  """Returns camera `(pos, rot)` in the robot MJCF root frame.

  Pair these extrinsics with runtime camera intrinsics (`focal_px`,
  `principal_point_px`) for ray-plane projection and stereo triangulation so all
  3D points lie in the exact same robot MJCF root frame as `RobotArmPlanner.fk`
  and `Scene3D`.
  """
  model = mujoco.MjModel.from_xml_path(_resolve_mjcf_path(mjcf_path))
  data = mujoco.MjData(model)
  eff_jp = (
      left_joint_pos
      if (joint_positions is None and left_joint_pos is not None)
      else joint_positions
  )
  _apply_joint_positions_to_mjdata(
      model, data, eff_jp, right_joint_pos=right_joint_pos
  )
  mujoco.mj_forward(model, data)

  out: dict[str, dict[str, Any]] = {}
  for cid in range(int(model.ncam)):
    cname = (
        mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_CAMERA), cid)
        or f"cam_{cid}"
    )
    short = cname.split("/")[-1]
    pos = np.asarray(data.cam_xpos[cid], dtype=np.float64).copy()
    rot = np.asarray(data.cam_xmat[cid], dtype=np.float64).reshape(3, 3).copy()
    entry = {"pos": pos, "rot": rot, "mjcf_name": cname}
    out[cname] = entry
    out[short] = entry
    out[f"{short}_rgb_image"] = entry
  return out


def project_point(
    pt_world: Sequence[float] | np.ndarray,
    cam_pos: Sequence[float] | np.ndarray,
    cam_rot: Sequence[Sequence[float]] | np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> tuple[float, float, float] | None:
  """Projects 3D point in robot MJCF frame to `(u_col, v_row, z_depth)`.

  Returns `None` when `pt_world` is behind or within 2 cm of the camera plane.
  """
  pt = np.asarray(pt_world, dtype=np.float64).reshape(3)
  pos = np.asarray(cam_pos, dtype=np.float64).reshape(3)
  rot = np.asarray(cam_rot, dtype=np.float64).reshape(3, 3)
  p_cam = rot.T @ (pt - pos)
  z_depth = float(-p_cam[2])
  if z_depth <= 0.02:
    return None
  u = float(cx) + float(fx) * (float(p_cam[0]) / z_depth)
  v = float(cy) - float(fy) * (float(p_cam[1]) / z_depth)
  return u, v, z_depth


def _project_point_mujoco_cam(
    pt_world: np.ndarray,
    cam_pos: np.ndarray,
    cam_rot: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> tuple[float, float, float] | None:
  """Internal alias for `project_point`."""
  return project_point(pt_world, cam_pos, cam_rot, fx, fy, cx, cy)


def _extract_cam_intrinsics_tuple(
    cam_intrinsics_entry: Mapping[str, Any],
) -> tuple[float, float, float, float]:
  """Extracts `(fx, fy, cx, cy)` from a camera intrinsics mapping entry."""
  focal = cam_intrinsics_entry["focal_px"]
  pp = cam_intrinsics_entry["principal_point_px"]
  return float(focal[0]), float(focal[1]), float(pp[0]), float(pp[1])


def _lookup_camera_entry(
    mapping: Mapping[str, Mapping[str, Any]], cam_key: str
) -> Mapping[str, Any]:
  """Looks up `cam_key` across short, `*_rgb_image`, and MJCF camera keys."""
  short = cam_key.removesuffix("_rgb_image").removesuffix("_rgb").split("/")[-1]
  for cand in (cam_key, f"{short}_rgb_image", short, f"scene/{short}"):
    entry = mapping.get(cand)
    if entry is not None:
      return entry
  for k, v in mapping.items():
    if (
        k.removesuffix("_rgb_image").removesuffix("_rgb").split("/")[-1]
        == short
    ):
      return v
  raise KeyError(
      f"Camera {cam_key!r} not found in mapping keys {list(mapping.keys())!r}."
  )


def pixel_to_ray(
    u_col: float,
    v_row: float,
    cam_pose: Mapping[str, Any],
    cam_intrinsics: Mapping[str, Any],
) -> tuple[np.ndarray, np.ndarray]:
  """Converts pixel `(u_col, v_row)` to `(ray_origin_3d, ray_unit_dir_3d)`.

  Args:
    u_col: Horizontal pixel column (`0 <= u_col < width`, left-to-right).
    v_row: Vertical pixel row (`0 <= v_row < height`, top-to-bottom).
    cam_pose: Single camera entry `{'pos': ..., 'rot': ...}` from
      `get_camera_poses_in_robot_frame(...)`.
    cam_intrinsics: Single camera entry `{'focal_px': [fx, fy],
      'principal_point_px': [cx, cy]}`.

  Returns:
    Tuple `(origin, unit_dir)` as `float64` arrays of shape `(3,)` in the
    robot MJCF root frame.
  """
  fx, fy, cx, cy = _extract_cam_intrinsics_tuple(cam_intrinsics)
  origin = np.asarray(cam_pose["pos"], dtype=np.float64).reshape(3).copy()
  rot = np.asarray(cam_pose["rot"], dtype=np.float64).reshape(3, 3)
  d_cam = np.array(
      [(float(u_col) - cx) / fx, -(float(v_row) - cy) / fy, -1.0],
      dtype=np.float64,
  )
  d_world = rot @ d_cam
  norm = float(np.linalg.norm(d_world))
  return origin, d_world / max(norm, 1e-12)


def intersect_ray_plane(
    u_col: float,
    v_row: float,
    cam_pose: Mapping[str, Any],
    cam_intrinsics: Mapping[str, Any],
    plane_z: float = 0.0,
) -> np.ndarray | None:
  """Intersects a camera pixel ray with horizontal plane `z = plane_z`.

  Returns the 3D point `(x, y, plane_z)` in front of the camera, or `None` if
  the ray does not intersect `z = plane_z` in front of the camera.
  """
  origin, unit_dir = pixel_to_ray(u_col, v_row, cam_pose, cam_intrinsics)
  if abs(float(unit_dir[2])) < 1e-9:
    return None
  t = (float(plane_z) - float(origin[2])) / float(unit_dir[2])
  if t <= 0.0:
    return None
  return origin + t * unit_dir


def triangulate_rays(
    origins: Sequence[Sequence[float] | np.ndarray],
    directions: Sequence[Sequence[float] | np.ndarray],
) -> dict[str, Any]:
  """Triangulates a 3D point from `>= 2` skew rays via least-squares distance."""
  if len(origins) < 2 or len(origins) != len(directions):
    raise ValueError("triangulate_rays requires >= 2 matching (origin, dir).")
  a_mat = np.zeros((3, 3), dtype=np.float64)
  b_vec = np.zeros(3, dtype=np.float64)
  orig_list: list[np.ndarray] = []
  dir_list: list[np.ndarray] = []
  for orig, direction in zip(origins, directions, strict=True):
    o = np.asarray(orig, dtype=np.float64).reshape(3)
    d = np.asarray(direction, dtype=np.float64).reshape(3)
    d_unit = d / max(float(np.linalg.norm(d)), 1e-12)
    proj = np.eye(3, dtype=np.float64) - np.outer(d_unit, d_unit)
    a_mat += proj
    b_vec += proj @ o
    orig_list.append(o)
    dir_list.append(d_unit)

  pt, _, _, _ = np.linalg.lstsq(a_mat, b_vec, rcond=None)
  residuals: list[float] = []
  for o, d_unit in zip(orig_list, dir_list, strict=True):
    diff = pt - o
    perp = diff - float(np.dot(diff, d_unit)) * d_unit
    residuals.append(round(float(np.linalg.norm(perp)), 5))
  return {
      "point_3d": pt,
      "ray_residuals_m": residuals,
      "max_ray_residual_m": round(max(residuals), 5),
      "mean_ray_residual_m": round(float(np.mean(residuals)), 5),
  }


def triangulate_pixels(
    uv_by_camera: Mapping[str, Sequence[float] | np.ndarray],
    cam_poses: Mapping[str, Mapping[str, Any]],
    cam_intrinsics: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
  """Triangulates a 3D point in the robot MJCF root frame from `>= 2` cameras.

  Args:
    uv_by_camera: Mapping of camera key to `(u_col, v_row)` pixel coordinates.
    cam_poses: Full dict returned by `get_camera_poses_in_robot_frame(...)`.
    cam_intrinsics: Mapping of camera key to `{'focal_px': [fx, fy],
      'principal_point_px': [cx, cy]}`.

  Returns:
    Dict with `'point_3d'` (`np.ndarray` shape `(3,)`), `'max_ray_residual_m'`,
    `'mean_ray_residual_m'`, `'ray_residuals_m'` (per camera), and
    `'reprojection_errors_px'` (per camera).
  """
  if len(uv_by_camera) < 2:
    raise ValueError("triangulate_pixels requires >= 2 camera observations.")
  cam_keys = list(uv_by_camera.keys())
  origins: list[np.ndarray] = []
  dirs: list[np.ndarray] = []
  poses_resolved: list[Mapping[str, Any]] = []
  intr_resolved: list[tuple[float, float, float, float]] = []

  for key in cam_keys:
    uv = np.asarray(uv_by_camera[key], dtype=np.float64).reshape(2)
    pose_entry = _lookup_camera_entry(cam_poses, key)
    intr_entry = _lookup_camera_entry(cam_intrinsics, key)
    orig, unit_dir = pixel_to_ray(
        float(uv[0]), float(uv[1]), pose_entry, intr_entry
    )
    origins.append(orig)
    dirs.append(unit_dir)
    poses_resolved.append(pose_entry)
    intr_resolved.append(_extract_cam_intrinsics_tuple(intr_entry))

  tri = triangulate_rays(origins, dirs)
  pt = tri["point_3d"]
  ray_res_by_cam = {
      k: tri["ray_residuals_m"][idx] for idx, k in enumerate(cam_keys)
  }
  reproj_err_by_cam: dict[str, float] = {}
  for idx, key in enumerate(cam_keys):
    uv = np.asarray(uv_by_camera[key], dtype=np.float64).reshape(2)
    fx, fy, cx, cy = intr_resolved[idx]
    proj = project_point(
        pt,
        poses_resolved[idx]["pos"],
        poses_resolved[idx]["rot"],
        fx,
        fy,
        cx,
        cy,
    )
    if proj is None:
      reproj_err_by_cam[key] = float("inf")
    else:
      reproj_err_by_cam[key] = round(
          float(math.hypot(proj[0] - float(uv[0]), proj[1] - float(uv[1]))), 2
      )

  return {
      "point_3d": pt,
      "max_ray_residual_m": tri["max_ray_residual_m"],
      "mean_ray_residual_m": tri["mean_ray_residual_m"],
      "ray_residuals_m": ray_res_by_cam,
      "reprojection_errors_px": reproj_err_by_cam,
  }


def _draw_box_wireframe(
    draw: ImageDraw.ImageDraw,
    center: np.ndarray,
    half_extents: np.ndarray,
    rot: np.ndarray,
    cam_pos: np.ndarray,
    cam_rot: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    color: tuple[int, int, int, int],
) -> tuple[float, float] | None:
  """Projects and draws the 12 edges of a 3D box onto `draw`."""
  signs = np.array(
      [
          [-1, -1, -1],
          [1, -1, -1],
          [1, 1, -1],
          [-1, 1, -1],
          [-1, -1, 1],
          [1, -1, 1],
          [1, 1, 1],
          [-1, 1, 1],
      ],
      dtype=np.float64,
  )
  corners_w = center + (rot @ (signs * half_extents).T).T
  proj = [
      _project_point_mujoco_cam(pt, cam_pos, cam_rot, fx, fy, cx, cy)
      for pt in corners_w
  ]
  edges = (
      (0, 1),
      (1, 2),
      (2, 3),
      (3, 0),
      (4, 5),
      (5, 6),
      (6, 7),
      (7, 4),
      (0, 4),
      (1, 5),
      (2, 6),
      (3, 7),
  )
  for i, j in edges:
    pi, pj = proj[i], proj[j]
    if pi is not None and pj is not None:
      draw.line([(pi[0], pi[1]), (pj[0], pj[1])], fill=color, width=2)
  c_proj = _project_point_mujoco_cam(center, cam_pos, cam_rot, fx, fy, cx, cy)
  return (c_proj[0], c_proj[1]) if c_proj is not None else None


def _draw_cylinder_wireframe(
    draw: ImageDraw.ImageDraw,
    center: np.ndarray,
    radius: float,
    half_height: float,
    cam_pos: np.ndarray,
    cam_rot: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    color: tuple[int, int, int, int],
) -> tuple[float, float] | None:
  """Projects top/bottom circular rings + 4 vertical struts of a cylinder."""
  angles = np.linspace(0.0, 2.0 * math.pi, 16, endpoint=False)
  for z_sign in (-1.0, 1.0):
    ring_pts = [
        np.array([
            center[0] + radius * math.cos(a),
            center[1] + radius * math.sin(a),
            center[2] + z_sign * half_height,
        ])
        for a in angles
    ]
    proj_ring = [
        _project_point_mujoco_cam(pt, cam_pos, cam_rot, fx, fy, cx, cy)
        for pt in ring_pts
    ]
    for k in range(len(proj_ring)):
      p0 = proj_ring[k]
      p1 = proj_ring[(k + 1) % len(proj_ring)]
      if p0 is not None and p1 is not None:
        draw.line([(p0[0], p0[1]), (p1[0], p1[1])], fill=color, width=2)
  for a in (0.0, 0.5 * math.pi, math.pi, 1.5 * math.pi):
    pb = _project_point_mujoco_cam(
        np.array([
            center[0] + radius * math.cos(a),
            center[1] + radius * math.sin(a),
            center[2] - half_height,
        ]),
        cam_pos,
        cam_rot,
        fx,
        fy,
        cx,
        cy,
    )
    pt = _project_point_mujoco_cam(
        np.array([
            center[0] + radius * math.cos(a),
            center[1] + radius * math.sin(a),
            center[2] + half_height,
        ]),
        cam_pos,
        cam_rot,
        fx,
        fy,
        cx,
        cy,
    )
    if pb is not None and pt is not None:
      draw.line([(pb[0], pb[1]), (pt[0], pt[1])], fill=color, width=2)
  c_proj = _project_point_mujoco_cam(center, cam_pos, cam_rot, fx, fy, cx, cy)
  return (c_proj[0], c_proj[1]) if c_proj is not None else None


def render_scene_overlay(
    mjcf_path: str | None,
    joint_positions: Any = None,
    camera_image_paths: Any = None,
    scene: Any = None,
    output_path: Any = None,
    objects: (
        Sequence[tuple[MultiSphereObject, Sequence[float] | np.ndarray]] | str
    ) = (),
    camera_intrinsics: Any = None,
    *,
    left_joint_pos: Sequence[float] | np.ndarray | None = None,
    right_joint_pos: Sequence[float] | np.ndarray | None = None,
) -> str:
  """Projects `scene` obstacles and `objects` onto camera PNGs in robot MJCF root frame.

  Supports both `(mjcf_path, joint_positions, camera_image_paths, scene,
  output_path, ...)` and legacy `(mjcf_path, left_q, right_q,
  camera_image_paths, scene, output_path, ...)` calling conventions.
  """
  # Normalize legacy 6-positional-arg vs new 5-positional/keyword signatures
  legacy_right_q: Sequence[float] | np.ndarray | None = right_joint_pos
  eff_jp: Any = (
      left_joint_pos
      if (joint_positions is None and left_joint_pos is not None)
      else joint_positions
  )

  if isinstance(output_path, Scene3D) and isinstance(scene, Mapping):
    # Legacy positional: (mjcf_path, left_q, right_q, img_paths, scene, out_path, [objects])
    legacy_right_q = camera_image_paths
    real_img_paths: Mapping[str, str] = scene
    real_scene: Scene3D = output_path
    if not isinstance(objects, str):
      raise TypeError("Expected output_path string in positional argument 6.")
    real_out_path: str = objects
    if isinstance(camera_intrinsics, Sequence) and not isinstance(
        camera_intrinsics, Mapping
    ):
      real_objects: Sequence[
          tuple[MultiSphereObject, Sequence[float] | np.ndarray]
      ] = camera_intrinsics
      real_intrinsics: Mapping[str, Mapping[str, Any]] | None = None
    else:
      real_objects = ()
      real_intrinsics = (
          camera_intrinsics if isinstance(camera_intrinsics, Mapping) else None
      )
  else:
    if not isinstance(camera_image_paths, Mapping):
      raise TypeError("camera_image_paths must be a Mapping[str, str].")
    if not isinstance(scene, Scene3D):
      raise TypeError("scene must be a Scene3D instance.")
    if not isinstance(output_path, str):
      raise TypeError("output_path must be a destination file path string.")
    real_img_paths = camera_image_paths
    real_scene = scene
    real_out_path = output_path
    real_objects = () if isinstance(objects, str) else objects
    real_intrinsics = (
        camera_intrinsics if isinstance(camera_intrinsics, Mapping) else None
    )

  model = mujoco.MjModel.from_xml_path(_resolve_mjcf_path(mjcf_path))
  data = mujoco.MjData(model)
  _apply_joint_positions_to_mjdata(
      model, data, eff_jp, right_joint_pos=legacy_right_q
  )
  mujoco.mj_forward(model, data)

  cam_lookup = _build_mjcf_camera_lookup(model)

  panels: list[Image.Image] = []
  for cam_key, img_path in real_img_paths.items():
    if not os.path.exists(img_path):
      continue
    base_img = Image.open(img_path).convert("RGBA")
    img_w, img_h = base_img.size
    overlay = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    short_key = (
        cam_key.removesuffix("_rgb_image").removesuffix("_rgb").split("/")[-1]
    )
    cam_id = cam_lookup.get(cam_key, cam_lookup.get(short_key, -1))
    if cam_id < 0:
      cid = mujoco.mj_name2id(model, int(mujoco.mjtObj.mjOBJ_CAMERA), cam_key)
      if cid >= 0:
        cam_id = int(cid)
    if cam_id < 0:
      continue

    cam_pos = np.asarray(data.cam_xpos[cam_id], dtype=np.float64).copy()
    cam_rot = (
        np.asarray(data.cam_xmat[cam_id], dtype=np.float64).reshape(3, 3).copy()
    )

    spec_entry: Mapping[str, Any] = {}
    if real_intrinsics:
      try:
        spec_entry = _lookup_camera_entry(real_intrinsics, cam_key)
      except KeyError:
        spec_entry = {}
    if "focal_px" in spec_entry and "principal_point_px" in spec_entry:
      fx, fy = float(spec_entry["focal_px"][0]), float(
          spec_entry["focal_px"][1]
      )
      cx, cy = (
          float(spec_entry["principal_point_px"][0]),
          float(spec_entry["principal_point_px"][1]),
      )
    else:
      sensorsize = np.asarray(model.cam_sensorsize[cam_id], dtype=np.float64)
      intrinsic = np.asarray(model.cam_intrinsic[cam_id], dtype=np.float64)
      if sensorsize[0] > 0.0 and intrinsic[0] > 0.0:
        fx = float(intrinsic[0] / sensorsize[0] * img_w)
        fy = float(intrinsic[1] / sensorsize[1] * img_h)
        cx = float((img_w - 1.0) / 2.0 + intrinsic[2] / sensorsize[0] * img_w)
        cy = float((img_h - 1.0) / 2.0 + intrinsic[3] / sensorsize[1] * img_h)
      else:
        fovy = math.radians(float(model.cam_fovy[cam_id]))
        fx = fy = float(0.5 * img_h / math.tan(0.5 * fovy))
        cx, cy = (img_w - 1.0) / 2.0, (img_h - 1.0) / 2.0

    labeled_groups: set[str] = set()
    for prim in real_scene.primitives:
      if prim.group.startswith("other_arm"):
        col = (255, 180, 60, 110)
      elif "table" in prim.group.lower():
        col = (120, 220, 120, 120)
      else:
        col = (255, 95, 65, 190)

      anchor: tuple[float, float] | None = None
      if prim.kind == "sphere":
        pr = _project_point_mujoco_cam(
            prim.center, cam_pos, cam_rot, fx, fy, cx, cy
        )
        if pr is not None:
          r_px = max(2.0, 0.5 * (fx + fy) * prim.radius / pr[2])
          draw.ellipse(
              [pr[0] - r_px, pr[1] - r_px, pr[0] + r_px, pr[1] + r_px],
              outline=col,
              width=2,
          )
          anchor = (pr[0], pr[1])
      elif prim.kind == "box":
        assert prim.half_extents is not None
        rot = prim.rotation if prim.rotation is not None else np.eye(3)
        anchor = _draw_box_wireframe(
            draw,
            prim.center,
            prim.half_extents,
            rot,
            cam_pos,
            cam_rot,
            fx,
            fy,
            cx,
            cy,
            col,
        )
      elif prim.kind == "cylinder":
        anchor = _draw_cylinder_wireframe(
            draw,
            prim.center,
            prim.radius,
            prim.half_height,
            cam_pos,
            cam_rot,
            fx,
            fy,
            cx,
            cy,
            col,
        )
      elif prim.kind == "capsule":
        assert prim.point_a is not None and prim.point_b is not None
        pa = _project_point_mujoco_cam(
            prim.point_a, cam_pos, cam_rot, fx, fy, cx, cy
        )
        pb = _project_point_mujoco_cam(
            prim.point_b, cam_pos, cam_rot, fx, fy, cx, cy
        )
        if pa is not None and pb is not None:
          draw.line([(pa[0], pa[1]), (pb[0], pb[1])], fill=col, width=3)
          for end_p in (pa, pb):
            r_px = max(2.0, 0.5 * (fx + fy) * prim.radius / end_p[2])
            draw.ellipse(
                [
                    end_p[0] - r_px,
                    end_p[1] - r_px,
                    end_p[0] + r_px,
                    end_p[1] + r_px,
                ],
                outline=col,
                width=2,
            )
          anchor = (0.5 * (pa[0] + pb[0]), 0.5 * (pa[1] + pb[1]))

      if anchor is not None and prim.group not in labeled_groups:
        if 0 <= anchor[0] < img_w and 0 <= anchor[1] < img_h:
          draw.text(
              (anchor[0] + 4, anchor[1] - 10),
              prim.group,
              fill=(255, 255, 160, 255),
          )
          labeled_groups.add(prim.group)

    for obj, pose6d in real_objects:
      ws = obj.world_spheres(pose6d)
      for s_idx, (_, s_center, s_rad) in enumerate(ws):
        pr = _project_point_mujoco_cam(
            s_center, cam_pos, cam_rot, fx, fy, cx, cy
        )
        if pr is not None:
          r_px = max(2.0, 0.5 * (fx + fy) * s_rad / pr[2])
          draw.ellipse(
              [pr[0] - r_px, pr[1] - r_px, pr[0] + r_px, pr[1] + r_px],
              outline=(0, 240, 255, 220),
              width=2,
          )
          if s_idx == 0 and 0 <= pr[0] < img_w and 0 <= pr[1] < img_h:
            draw.text(
                (pr[0] + 4, pr[1] - 12),
                obj.name,
                fill=(140, 255, 255, 255),
            )

    draw.rectangle([4, 4, 250, 24], fill=(0, 0, 0, 170))
    draw.text((10, 7), short_key, fill=(255, 255, 255, 255))
    composed = Image.alpha_composite(base_img, overlay).convert("RGB")
    panels.append(composed)

  if not panels:
    raise ValueError("No valid camera images found in camera_image_paths.")

  n_panels = len(panels)
  w, h = panels[0].size
  if n_panels == 1:
    out_img = panels[0]
  else:
    cols = 2 if n_panels <= 4 else 3
    rows = int(math.ceil(n_panels / cols))
    out_img = Image.new("RGB", (cols * w, rows * h))
    for idx, panel in enumerate(panels):
      resized_p = (
          panel
          if panel.size == (w, h)
          else panel.resize((w, h), Image.Resampling.BILINEAR)
      )
      r_idx, c_idx = divmod(idx, cols)
      out_img.paste(resized_p, (c_idx * w, r_idx * h))

  if out_img.width > 1600:
    scale = 1600.0 / out_img.width
    out_img = out_img.resize(
        (1600, int(round(out_img.height * scale))),
        Image.Resampling.BILINEAR,
    )

  os.makedirs(os.path.dirname(os.path.abspath(real_out_path)), exist_ok=True)
  out_img.save(real_out_path, format="PNG")
  return real_out_path
