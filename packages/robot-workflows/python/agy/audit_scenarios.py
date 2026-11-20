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

# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "absl-py>=2.0.0",
#     "mujoco>=3.2.0",
#     "numpy>=1.24.0",
#     "Pillow>=10.0.0",
#     "scipy>=1.10.0",
#     "trimesh>=4.0.0",
# ]
# ///

"""Agent-native 10-scenario pre-audit dynamic test suite for MuJoCo object assets.

Always runs all 10 quantitative + visual physics audit scenarios on any
standalone object `model.xml` (using `mujoco.MjSpec` composition) and produces:
  1. A structured JSON scorecard (`<output_prefix>_scenarios.json`) with raw
     physical metrics, diagnostic flags (`PASS` / `CHECK` / `FAIL` / `INFO`),
     and explicit `agent_note` guidance reminding the agent to use engineering
     judgment for the asset's shape/category.
  2. A 10-panel (`5 cols x 2 rows`) visual contact sheet
     (`<output_prefix>_scenarios.png`) showing keyframes and telemetry overlays.

Scenarios (All Auto-Scaling with Asset Bounding Box & Mass):
  1. `six_pose_drop_and_hover`: Drops from 6 canonical poses (+/-X, +/-Y, +/-Z),
     verifying 0 NaNs, settling speed, floor reaction force = m*g, and exact
     visual-bottom tabletop hover gap (`z_vis_min` in mm).
  2. `tilt_table_sweep`: Sweeps an auto-scaled tilt table (with scaled pivot
     height, catch lip, and mass-scaled servo gain) from 0 deg to 55 deg along
     both X and Y footprint axes to measure critical slip angle
     (`theta_slip_deg`)
     and critical tipping angle (`theta_tip_deg`).
  3. `roll_and_spin_dissipation`: Applies a calibrated horizontal + spin impulse
     on a flat plane (measuring roll-out distance and settling time) and checks
     per-hull CoACD density uniformity (`hull_density_cv`).
  4. `three_axis_ray_and_cavity_probe`: Casts 20x20 orthographic ray grids along
     all 3 principal axes (X, Y, Z) against visual (group 2) vs. collision
     (group 3) geoms to detect plugged top-down cavities AND plugged sideways
     through-holes/handle loops, opening any joints first and dropping scaled
     probe marbles.
  5. `com_aligned_grasp_lift_shake`: Runs a 4-phase closed-loop parallel-jaw
     grasp with auto-scaled finger pads aligned to the asset's CoM height and
     mass-scaled grip/lift forces (Settle -> Clamp -> Scaled Hoist -> 3 Hz
     Shake).
  6. `articulation_sweep_and_pinch`: Sweeps any hinge/slide joints across their
     full range (`rmin <-> rmax`), automatically identifies which limit is OPEN
     vs. CLOSED by measuring link separation, checks for self-collision
     blocking,
     and tests an active pinch on a scaled target block.
  7. `cliff_ledge_overhang_slide`: Slowly pushes the asset across a sharp cliff
     ledge (0% -> 65% footprint overhang) to measure the critical overhang % at
     tip-off and compare against geometric CoM overhang %.
  8. `twin_self_stack_and_nudge`: Lowers a second copy of the asset onto the
     first copy and applies a gentle lateral table nudge to test top-surface
     collider flatness, rim stacking, and multi-body contact stability.
  9. `pendulum_impact_and_site_spawn`: Swings a calibrated striker sphere into
     the resting asset to measure recoil velocity and bounce restitution, and
     spawns test blocks on any `<site>` tags to catch buried or floating sites.
  10. `high_speed_thin_slab_drop`: Drops the asset from 1.0 m (`v ~ 4.4 m/s`)
      onto a thin 10 mm suspended tabletop slab to test for high-velocity
      tunneling, peak solver penetration depth (`mm`), and bounce ratio.
"""

from collections.abc import Sequence
import colorsys
import dataclasses
import json
import math
import os
from typing import Any

from absl import app
from absl import flags
import mujoco
import numpy as np
from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont
from scipy import sparse
from scipy import spatial
import trimesh


def _define_flag_if_absent(
    define_fn: Any, name: str, default: Any, help_str: str, **kwargs: Any
) -> Any:
  if name in flags.FLAGS:
    return flags.FLAGS[name]
  return define_fn(name, default, help_str, **kwargs)


_XML_PATH = _define_flag_if_absent(
    flags.DEFINE_string,
    "xml_path",
    None,
    "Path to the object asset model.xml to audit.",
)
_XML_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "xml",
    None,
    "Alias for --xml_path.",
)
_ASSET_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "asset",
    None,
    "Alias for --xml_path.",
)
_INPUT_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "input",
    None,
    "Alias for --xml_path.",
)
_OUT_DIR = _define_flag_if_absent(
    flags.DEFINE_string,
    "out_dir",
    None,
    "Output directory for the JSON scorecard and PNG contact sheet.",
)
_OUTPUT_DIR_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "output_dir",
    None,
    "Alias for --out_dir.",
)
_LABEL = _define_flag_if_absent(
    flags.DEFINE_string,
    "label",
    None,
    "Optional human-readable label for the asset version.",
)
_THRESHOLDS_JSON = _define_flag_if_absent(
    flags.DEFINE_string,
    "thresholds_json",
    None,
    "Optional JSON string overriding any keys in DEFAULT_THRESHOLDS "
    '(e.g. \'{"hull_density_cv_tol": 0.30, "hover_tol_mm": 1.5}\').',
)
_SCENARIOS = _define_flag_if_absent(
    flags.DEFINE_string,
    "scenarios",
    "all",
    "Which scenarios to run: 'all' (default, runs 1..10) or a comma-separated"
    " subset of scenario numbers (e.g. '1,4' or '1,3,6') for fast/targeted"
    " checks.",
)
_BEFORE_XML = _define_flag_if_absent(
    flags.DEFINE_string,
    "before_xml",
    None,
    "Optional path to the original (Before) model.xml to automatically render"
    " a 3-row x 6-column Before-vs-After comparison sheet with exact uncropped"
    " framing and per-hull distinct color-coding.",
)
_REAL_IMG_PATH = _define_flag_if_absent(
    flags.DEFINE_string,
    "real_img_path",
    None,
    "Optional path to a real-world reference photo to"
    " include in Row 1 of the Before-vs-After comparison sheet.",
)
_COMPARISON_OUT = _define_flag_if_absent(
    flags.DEFINE_string,
    "comparison_out",
    None,
    "Optional output PNG path for the Before-vs-After comparison sheet.",
)
_STATIC_ONLY = _define_flag_if_absent(
    flags.DEFINE_bool,
    "static_only",
    False,
    "If True, runs only the fast (<0.5s) static XML, PBR material, and mesh"
    " topology/UV hygiene check without the 10 dynamic physics simulations.",
)

DEFAULT_THRESHOLDS: dict[str, float] = {
    "hover_tol_mm": 2.0,
    "min_flat_slip_deg": 8.0,
    "hull_density_cv_tol": 0.15,
    "max_residual_ang_speed_rad_s": 0.25,
    "plugged_cavity_rays_tol": 12.0,
    "plugged_cavity_deficit_mm_tol": 8.0,
    "plugged_through_holes_tol": 3.0,
    "grasp_lift_slip_mm_tol": 25.0,
    "grasp_shake_slip_mm_tol": 20.0,
    "ledge_overhang_diff_pct_tol": 25.0,
    "high_speed_drop_scale": 6.0,
    "thin_slab_min_dim_ratio": 0.20,
    "bounce_ratio_tol": 0.35,
}

AGENT_DISCLAIMER = (
    "DIAGNOSTIC SUITE ONLY — USE ENGINEERING JUDGMENT: All 10 scenarios always "
    "run to provide complete physical telemetry, but not every test applies to "
    "every object shape. For example: spheres/cylinders SHOULD roll at <5 deg "
    "on the tilt table and should NOT self-stack; solid blocks have no cavity "
    "to probe; rigid objects have 0 joints; tall goblets should tip before "
    "sliding. Treat 'CHECK' badges as diagnostic clues to evaluate in context, "
    "not blind pass/fail rules."
)


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
  """Loads a bold system font at `size`, falling back to Pillow default."""
  for candidate in (
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
      "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
      "/System/Library/Fonts/Menlo.ttc",
      "/Library/Fonts/Arial Bold.ttf",
  ):
    if os.path.exists(candidate):
      try:
        return ImageFont.truetype(candidate, size=size)
      except OSError:
        pass
  return ImageFont.load_default()


def compute_geom_vertices_world(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    geom_ids: Sequence[int],
) -> np.ndarray:
  """Returns (N, 3) world-space sample/vertex points across `geom_ids`."""
  pts = []
  for gid in geom_ids:
    pos = np.array(data.geom_xpos[gid], dtype=np.float64)
    mat = np.array(data.geom_xmat[gid], dtype=np.float64).reshape(3, 3)
    gtype = int(model.geom_type[gid])
    size = np.array(model.geom_size[gid], dtype=np.float64)
    if gtype == mujoco.mjtGeom.mjGEOM_MESH and model.geom_dataid[gid] >= 0:
      mid = int(model.geom_dataid[gid])
      vadr = int(model.mesh_vertadr[mid])
      vnum = int(model.mesh_vertnum[mid])
      if vnum > 0:
        verts = model.mesh_vert[vadr : vadr + vnum] @ mat.T + pos
        pts.append(verts)
    elif gtype == mujoco.mjtGeom.mjGEOM_SPHERE:
      r = size[0]
      dir_list = []
      for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
          for dz in (-1, 0, 1):
            if (dx, dy, dz) != (0, 0, 0):
              dir_list.append([dx, dy, dz])
      dirs = np.array(dir_list, dtype=np.float64)
      dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
      pts.append(pos + r * dirs)
    elif gtype in (
        mujoco.mjtGeom.mjGEOM_CAPSULE,
        mujoco.mjtGeom.mjGEOM_CYLINDER,
    ):
      r, hh = size[0], size[1]
      angles = np.linspace(0, 2 * np.pi, 16, endpoint=False)
      ring = np.stack([r * np.cos(angles), r * np.sin(angles)], axis=1)
      for z in (-hh, 0.0, hh):
        local = np.column_stack([ring, np.full(16, z)])
        pts.append(local @ mat.T + pos)
      if gtype == mujoco.mjtGeom.mjGEOM_CAPSULE:
        pts.append((np.array([[0, 0, -hh - r], [0, 0, hh + r]]) @ mat.T) + pos)
    else:
      hx, hy, hz = size[0], size[1], size[2]
      corner_list = []
      for sx in (-1, 1):
        for sy in (-1, 1):
          for sz in (-1, 1):
            corner_list.append([sx * hx, sy * hy, sz * hz])
      corners = np.array(corner_list, dtype=np.float64)
      pts.append(corners @ mat.T + pos)
  if not pts:
    return np.zeros((1, 3), dtype=np.float64)
  return np.vstack(pts)


def classify_asset_geoms(
    model: mujoco.MjModel, prefix: str = ""
) -> tuple[list[int], list[int]]:
  """Returns (vis_geom_ids, col_geom_ids) belonging to the asset."""
  vis_ids = []
  col_ids = []
  for gid in range(model.ngeom):
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), gid) or ""
    bname = (
        mujoco.mj_id2name(
            model, int(mujoco.mjtObj.mjOBJ_BODY), int(model.geom_bodyid[gid])
        )
        or ""
    )
    if int(model.geom_bodyid[gid]) == 0:
      continue
    if prefix and not (gname.startswith(prefix) or bname.startswith(prefix)):
      continue
    if gname.startswith("scenario_") or bname.startswith("scenario_"):
      continue
    grp = int(model.geom_group[gid])
    ct = int(model.geom_contype[gid])
    ca = int(model.geom_conaffinity[gid])
    if ct > 0 or ca > 0 or grp == 3:
      col_ids.append(gid)
    if (ct == 0 and ca == 0) or grp in (0, 1, 2):
      if gid not in col_ids:
        vis_ids.append(gid)
  if not vis_ids and col_ids:
    vis_ids = list(col_ids)
  return vis_ids, col_ids


@dataclasses.dataclass(frozen=True)
class _ColliderShape:
  """World-space surface triangles and half-space/SDF collider parameters."""

  geom_id: int
  weld_id: int
  geom_type: int
  pos: np.ndarray
  mat: np.ndarray
  size: np.ndarray
  triangles: np.ndarray
  hull_equations: np.ndarray | None
  aabb_min: np.ndarray
  aabb_max: np.ndarray


def _unit_sphere_triangles(num_lat: int = 10, num_lon: int = 20) -> np.ndarray:
  """Generates unit-sphere surface triangles of shape (T, 3, 3)."""
  phis = np.linspace(0.0, np.pi, num_lat + 1)
  thetas = np.linspace(0.0, 2.0 * np.pi, num_lon, endpoint=False)
  grid_phi, grid_theta = np.meshgrid(phis, thetas, indexing="ij")
  verts = np.stack(
      [
          np.sin(grid_phi) * np.cos(grid_theta),
          np.sin(grid_phi) * np.sin(grid_theta),
          np.cos(grid_phi),
      ],
      axis=-1,
  )
  tris: list[np.ndarray] = []
  for i in range(num_lat):
    for j in range(num_lon):
      jn = (j + 1) % num_lon
      v00, v01 = verts[i, j], verts[i, jn]
      v10, v11 = verts[i + 1, j], verts[i + 1, jn]
      if i > 0:
        tris.append(np.stack([v00, v10, v01], axis=0))
      if i < num_lat - 1:
        tris.append(np.stack([v01, v10, v11], axis=0))
  return np.stack(tris, axis=0)


def _primitive_triangles_local(geom_type: int, size: np.ndarray) -> np.ndarray:
  """Generates local-frame surface triangles (T, 3, 3) for a primitive geom."""
  if geom_type == mujoco.mjtGeom.mjGEOM_BOX:
    sx, sy, sz = float(size[0]), float(size[1]), float(size[2])
    v = np.array(
        [
            [-sx, -sy, -sz],
            [sx, -sy, -sz],
            [sx, sy, -sz],
            [-sx, sy, -sz],
            [-sx, -sy, sz],
            [sx, -sy, sz],
            [sx, sy, sz],
            [-sx, sy, sz],
        ],
        dtype=np.float64,
    )
    faces = np.array(
        [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [2, 3, 7],
            [2, 7, 6],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ],
        dtype=np.int32,
    )
    return v[faces]
  if geom_type == mujoco.mjtGeom.mjGEOM_SPHERE:
    return _unit_sphere_triangles() * float(size[0])
  if geom_type == mujoco.mjtGeom.mjGEOM_ELLIPSOID:
    return _unit_sphere_triangles() * size[:3].reshape(1, 1, 3)
  if geom_type in (
      mujoco.mjtGeom.mjGEOM_CYLINDER,
      mujoco.mjtGeom.mjGEOM_CAPSULE,
  ):
    radius = float(size[0])
    half_h = float(size[1])
    num_seg = 24
    angles = np.linspace(0.0, 2.0 * np.pi, num_seg, endpoint=False)
    cos_a = radius * np.cos(angles)
    sin_a = radius * np.sin(angles)
    tris: list[np.ndarray] = []
    for j in range(num_seg):
      jn = (j + 1) % num_seg
      b0 = np.array([cos_a[j], sin_a[j], -half_h], dtype=np.float64)
      b1 = np.array([cos_a[jn], sin_a[jn], -half_h], dtype=np.float64)
      t0 = np.array([cos_a[j], sin_a[j], half_h], dtype=np.float64)
      t1 = np.array([cos_a[jn], sin_a[jn], half_h], dtype=np.float64)
      tris.append(np.stack([b0, b1, t1], axis=0))
      tris.append(np.stack([b0, t1, t0], axis=0))
      if geom_type == mujoco.mjtGeom.mjGEOM_CYLINDER:
        bc = np.array([0.0, 0.0, -half_h], dtype=np.float64)
        tc = np.array([0.0, 0.0, half_h], dtype=np.float64)
        tris.append(np.stack([bc, b1, b0], axis=0))
        tris.append(np.stack([tc, t0, t1], axis=0))
    if geom_type == mujoco.mjtGeom.mjGEOM_CAPSULE:
      sph = _unit_sphere_triangles(num_lat=8, num_lon=num_seg) * radius
      tri_z = np.mean(sph[:, :, 2], axis=1)
      top_cap = sph[tri_z >= 0.0].copy()
      top_cap[:, :, 2] += half_h
      bot_cap = sph[tri_z < 0.0].copy()
      bot_cap[:, :, 2] -= half_h
      return np.concatenate([np.stack(tris, axis=0), top_cap, bot_cap], axis=0)
    return np.stack(tris, axis=0)
  return _unit_sphere_triangles(num_lat=6, num_lon=12) * float(np.max(size))


def _mesh_graph_hull_vertex_ids(
    model: mujoco.MjModel, mesh_id: int
) -> np.ndarray | None:
  """Returns local vertex IDs of MuJoCo's compiled convex hull for `mesh_id`."""
  try:
    adr = int(model.mesh_graphadr[mesh_id])
  except (AttributeError, IndexError, TypeError):
    return None
  if adr < 0:
    return None
  graph = np.asarray(model.mesh_graph)
  if adr + 2 > len(graph):
    return None
  numvert = int(graph[adr])
  if numvert < 4 or adr + 2 + 2 * numvert > len(graph):
    return None
  ids = graph[adr + 2 + numvert : adr + 2 + 2 * numvert].astype(np.int64)
  vert_num = int(model.mesh_vertnum[mesh_id])
  if np.any(ids < 0) or np.any(ids >= vert_num):
    return None
  return np.unique(ids)


def _geom_world_triangles_and_hull(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    geom_id: int,
    *,
    use_convex_hull: bool,
) -> tuple[np.ndarray, np.ndarray | None]:
  """Extracts world-space triangles (T, 3, 3) and optional hull equations."""
  pos = np.asarray(data.geom_xpos[geom_id], dtype=np.float64)
  mat = np.asarray(data.geom_xmat[geom_id], dtype=np.float64).reshape(3, 3)
  size = np.asarray(model.geom_size[geom_id], dtype=np.float64)
  geom_type = int(model.geom_type[geom_id])

  if (
      geom_type == mujoco.mjtGeom.mjGEOM_MESH
      and model.geom_dataid[geom_id] >= 0
  ):
    mesh_id = int(model.geom_dataid[geom_id])
    vadr = int(model.mesh_vertadr[mesh_id])
    vnum = int(model.mesh_vertnum[mesh_id])
    fadr = int(model.mesh_faceadr[mesh_id])
    fnum = int(model.mesh_facenum[mesh_id])
    if vnum <= 0 or fnum <= 0:
      return np.zeros((0, 3, 3), dtype=np.float64), None
    verts = np.asarray(model.mesh_vert[vadr : vadr + vnum], dtype=np.float64)
    world_verts = pos + verts @ mat.T
    if use_convex_hull and vnum >= 4:
      hull_ids = _mesh_graph_hull_vertex_ids(model, mesh_id)
      hull_pts = world_verts[hull_ids] if hull_ids is not None else world_verts
      for pts, qhull_opts in (
          (hull_pts, None),
          (hull_pts, "QJ"),
          (world_verts, "QJ"),
      ):
        if len(pts) < 4:
          continue
        try:
          hull = spatial.ConvexHull(pts, qhull_options=qhull_opts)
          return (
              hull.points[hull.simplices],
              np.asarray(hull.equations, dtype=np.float64),
          )
        except spatial.QhullError:
          continue
    faces = np.asarray(model.mesh_face[fadr : fadr + fnum], dtype=np.int32)
    return world_verts[faces], None

  local_tris = _primitive_triangles_local(geom_type, size)
  return pos + local_tris @ mat.T, None


def _signed_depth_in_collider(
    points: np.ndarray, collider: _ColliderShape, margin: float = 0.05
) -> np.ndarray:
  """Computes signed distance/depth to a convex collider (<= 0 inside)."""
  num_pts = points.shape[0]
  if num_pts == 0:
    return np.zeros((0,), dtype=np.float64)
  if collider.hull_equations is not None:
    pad = max(float(margin), 1e-3)
    in_box = np.all(
        (points >= collider.aabb_min - pad)
        & (points <= collider.aabb_max + pad),
        axis=1,
    )
    out = np.full((num_pts,), 1.0, dtype=np.float64)
    if np.any(in_box):
      eq = collider.hull_equations
      out[in_box] = np.max(points[in_box] @ eq[:, :3].T + eq[:, 3], axis=1)
    return out

  local = (points - collider.pos) @ collider.mat
  gtype = collider.geom_type
  size = collider.size
  if gtype == mujoco.mjtGeom.mjGEOM_BOX:
    q = np.abs(local) - size[:3]
    return np.linalg.norm(np.maximum(q, 0.0), axis=1) + np.minimum(
        np.max(q, axis=1), 0.0
    )
  if gtype == mujoco.mjtGeom.mjGEOM_SPHERE:
    return np.linalg.norm(local, axis=1) - float(size[0])
  if gtype == mujoco.mjtGeom.mjGEOM_CYLINDER:
    d_rad = np.hypot(local[:, 0], local[:, 1]) - float(size[0])
    d_z = np.abs(local[:, 2]) - float(size[1])
    return np.hypot(np.maximum(d_rad, 0.0), np.maximum(d_z, 0.0)) + np.minimum(
        np.maximum(d_rad, d_z), 0.0
    )
  if gtype == mujoco.mjtGeom.mjGEOM_CAPSULE:
    half_h = float(size[1])
    z_clamped = np.clip(local[:, 2], -half_h, half_h)
    return np.sqrt(
        local[:, 0] ** 2 + local[:, 1] ** 2 + (local[:, 2] - z_clamped) ** 2
    ) - float(size[0])
  if gtype == mujoco.mjtGeom.mjGEOM_ELLIPSOID:
    radii = np.maximum(size[:3], 1e-9)
    return (np.linalg.norm(local / radii, axis=1) - 1.0) * float(np.min(radii))
  return np.linalg.norm(local, axis=1) - float(np.max(size))


def _points_inside_any_collider(
    points: np.ndarray,
    col_shapes: Sequence[_ColliderShape],
    tol: float,
) -> np.ndarray:
  """Returns boolean mask (N,) of points within `tol` of any collider solid."""
  n_pts = int(points.shape[0])
  if n_pts == 0 or not col_shapes:
    return np.zeros((n_pts,), dtype=bool)
  inside = np.zeros((n_pts,), dtype=bool)
  margin = max(float(tol), 1e-3)
  for shape in col_shapes:
    rem = ~inside
    if not np.any(rem):
      break
    depths = _signed_depth_in_collider(points[rem], shape, margin=margin)
    rem_idx = np.flatnonzero(rem)
    inside[rem_idx[depths <= tol]] = True
  return inside


def _sample_triangles_area_weighted(
    triangles: np.ndarray,
    num_samples: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
  """Samples points uniformly by area across a triangle soup (T, 3, 3)."""
  num_tris = triangles.shape[0]
  if num_tris == 0 or num_samples <= 0:
    return np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.int32)
  v0, v1, v2 = triangles[:, 0, :], triangles[:, 1, :], triangles[:, 2, :]
  areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)
  total_area = float(np.sum(areas))
  if total_area <= 1e-18:
    tri_idx = rng.integers(0, num_tris, size=num_samples, dtype=np.int32)
  else:
    probs = areas / total_area
    tri_idx = np.asarray(
        rng.choice(num_tris, size=num_samples, replace=True, p=probs),
        dtype=np.int32,
    )
  r1 = np.sqrt(rng.random(num_samples))[:, None]
  r2 = rng.random(num_samples)[:, None]
  pts = (
      (1.0 - r1) * v0[tri_idx]
      + r1 * (1.0 - r2) * v1[tri_idx]
      + (r1 * r2) * v2[tri_idx]
  )
  return pts, tri_idx


def _point_to_segment_dist_sq(
    pts: np.ndarray, a: np.ndarray, b: np.ndarray
) -> np.ndarray:
  """Computes squared distance from points (..., 3) to segment [a, b]."""
  ab = b - a
  t = np.sum((pts - a) * ab, axis=-1, keepdims=True) / np.maximum(
      np.sum(ab * ab, axis=-1, keepdims=True), 1e-18
  )
  diff = pts - (a + np.clip(t, 0.0, 1.0) * ab)
  return np.sum(diff * diff, axis=-1)


def _query_triangles_distance(
    points: np.ndarray,
    triangles: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
  """Computes exact Euclidean distance from `points` (N, 3) to `triangles`."""
  if points.shape[0] == 0 or triangles.shape[0] == 0:
    return np.zeros((points.shape[0],), dtype=np.float64)
  sampled_pts, sampled_idx = _sample_triangles_area_weighted(
      triangles, 12000, rng
  )
  num_tris = triangles.shape[0]
  step = max(1, num_tris // 15000)
  tri_ids = np.arange(0, num_tris, step, dtype=np.int32)
  anchors = triangles[tri_ids]
  all_pts = np.concatenate(
      [
          sampled_pts,
          anchors[:, 0, :],
          anchors[:, 1, :],
          anchors[:, 2, :],
          np.mean(anchors, axis=1),
      ],
      axis=0,
  )
  ref_tri_idx = np.concatenate(
      [sampled_idx, tri_ids, tri_ids, tri_ids, tri_ids], axis=0
  )
  tree = spatial.cKDTree(all_pts)
  k = min(4, len(ref_tri_idx))
  _, nn_idx = tree.query(points, k=k)
  if k == 1:
    nn_idx = nn_idx[:, None]
  cand_tris = triangles[ref_tri_idx[nn_idx]]

  p = points[:, None, :]
  a, b, c = cand_tris[:, :, 0, :], cand_tris[:, :, 1, :], cand_tris[:, :, 2, :]
  edge_dist_sq = np.minimum(
      _point_to_segment_dist_sq(p, a, b),
      np.minimum(
          _point_to_segment_dist_sq(p, b, c),
          _point_to_segment_dist_sq(p, c, a),
      ),
  )
  normal = np.cross(b - a, c - a)
  norm_sq = np.sum(normal * normal, axis=-1, keepdims=True)
  proj = (
      p
      - (
          np.sum((p - a) * normal, axis=-1, keepdims=True)
          / np.maximum(norm_sq, 1e-18)
      )
      * normal
  )
  c0 = np.sum(np.cross(b - a, proj - a) * normal, axis=-1) >= -1e-12
  c1 = np.sum(np.cross(c - b, proj - b) * normal, axis=-1) >= -1e-12
  c2 = np.sum(np.cross(a - c, proj - c) * normal, axis=-1) >= -1e-12
  inside = c0 & c1 & c2 & (norm_sq[..., 0] > 1e-18)
  plane_diff = p - proj
  plane_dist_sq = np.sum(plane_diff * plane_diff, axis=-1)
  dist_sq = np.where(inside, plane_dist_sq, edge_dist_sq)
  return np.sqrt(np.maximum(np.min(dist_sq, axis=1), 0.0))


def _classify_alignment_geoms(
    model: mujoco.MjModel,
) -> tuple[list[int], list[int]]:
  """Classifies asset visual and collision geoms, ignoring helper boxes."""
  dedicated_vis_by_body: dict[int, list[int]] = {}
  fallback_vis_by_body: dict[int, list[int]] = {}
  col_gids: list[int] = []
  default_rgba = np.array([0.5, 0.5, 0.5, 1.0])

  for gid in range(model.ngeom):
    bid = int(model.geom_bodyid[gid])
    gtype = int(model.geom_type[gid])
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), gid) or ""
    bname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_BODY), bid) or ""
    if (bid == 0 and gtype == mujoco.mjtGeom.mjGEOM_PLANE) or (
        gname.startswith("scenario_") or bname.startswith("scenario_")
    ):
      continue
    ct = int(model.geom_contype[gid])
    ca = int(model.geom_conaffinity[gid])
    grp = int(model.geom_group[gid])
    if ct != 0 or ca != 0:
      col_gids.append(gid)
      if grp < 3:
        fallback_vis_by_body.setdefault(bid, []).append(gid)
      continue
    if grp >= 3:
      continue
    rgba = np.asarray(model.geom_rgba[gid], dtype=np.float64)
    alpha = float(rgba[3])
    matid = int(model.geom_matid[gid])
    if matid >= 0 and np.allclose(rgba, default_rgba):
      alpha = float(model.mat_rgba[matid][3])
    lname = gname.lower()
    is_helper = gtype != mujoco.mjtGeom.mjGEOM_MESH and any(
        tok in lname for tok in ("reg_bbox", "bbox", "bound", "registration")
    )
    if alpha <= 1e-6 or is_helper:
      continue
    dedicated_vis_by_body.setdefault(bid, []).append(gid)

  vis_gids: list[int] = []
  for bid in sorted(set(dedicated_vis_by_body) | set(fallback_vis_by_body)):
    vis_gids.extend(
        dedicated_vis_by_body.get(bid) or fallback_vis_by_body.get(bid, [])
    )
  return vis_gids, col_gids


def _split_welded_triangles(
    triangles: np.ndarray, tri_gids: np.ndarray, weld_tol: float
) -> list[tuple[np.ndarray, int]]:
  """Welds UV-seam vertices within `weld_tol` into connected components."""
  n_tris = int(triangles.shape[0])
  if n_tris == 0:
    return []
  verts = triangles.reshape(-1, 3)
  tol = max(float(weld_tol), 1e-6)
  _, first_idx, inv0 = np.unique(
      np.round(verts / tol).astype(np.int64),
      axis=0,
      return_index=True,
      return_inverse=True,
  )
  n_nodes = len(first_idx)
  u_pts = verts[first_idx]
  _, inv1 = np.unique(
      np.round((u_pts + 0.5 * tol) / tol).astype(np.int64),
      axis=0,
      return_inverse=True,
  )
  order1 = np.argsort(inv1)
  sorted_b = inv1[order1]
  same_b = sorted_b[:-1] == sorted_b[1:]
  shift_u = order1[:-1][same_b]
  shift_v = order1[1:][same_b]

  f0 = inv0.reshape(n_tris, 3)
  rows = np.concatenate([f0[:, 0], f0[:, 1], f0[:, 2], shift_u])
  cols = np.concatenate([f0[:, 1], f0[:, 2], f0[:, 0], shift_v])
  adj = sparse.coo_matrix(
      (np.ones(len(rows), dtype=np.int8), (rows, cols)),
      shape=(n_nodes, n_nodes),
  )
  n_comp, v_labels = sparse.csgraph.connected_components(adj, directed=False)
  tri_labels = v_labels[f0[:, 0]]
  out: list[tuple[np.ndarray, int]] = []
  for cid in range(n_comp):
    mask = tri_labels == cid
    if not np.any(mask):
      continue
    comp_gids, counts = np.unique(tri_gids[mask], return_counts=True)
    primary_gid = int(comp_gids[int(np.argmax(counts))])
    out.append((triangles[mask], primary_gid))
  return out


def _count_needle_penetration_rays(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    vis_gids: list[int],
    col_gids: list[int],
    vis_min: np.ndarray,
    vis_max: np.ndarray,
    grid_res: int = 25,
) -> dict[str, int]:
  """Counts 3-axis orthographic rays that pierce visual geoms but miss colliders.

  A ray cell `(iu, iv)` where `vis_grid[iu, iv]` is True and `col_grid[iu, iv]`
  is False is flagged as a needle penetration gap when either:
    1. It lies between collider hits along the same contiguous visual span in
       `u` or `v` (catching cracks/seams between adjacent hulls or ring segments
       without false-triggering on open through-holes or outer rims), or
    2. Its 5x5 visual neighborhood is completely inside the visual silhouette.

  Args:
    model: Compiled `mujoco.MjModel`.
    data: Forwarded `mujoco.MjData`.
    vis_gids: Active visual geom IDs.
    col_gids: Active collision geom IDs.
    vis_min: 3D world AABB minimum of visual geometry.
    vis_max: 3D world AABB maximum of visual geometry.
    grid_res: Orthographic grid resolution per axis.

  Returns:
    Mapping `{"X": count_x, "Y": count_y, "Z": count_z}` of gap rays per axis.
  """
  gaps_by_axis = {"X": 0, "Y": 0, "Z": 0}
  if not vis_gids or not col_gids or grid_res < 5:
    return gaps_by_axis

  saved_geom_group = np.array(model.geom_group, copy=True)
  grp_vis = np.array([0, 0, 1, 0, 0, 0], dtype=np.uint8)
  grp_col = np.array([0, 0, 0, 1, 0, 0], dtype=np.uint8)
  gid_buf = np.array([-1], dtype=np.int32)
  p = np.zeros(3, dtype=np.float64)
  ray_neg = np.zeros(3, dtype=np.float64)
  ray_pos = np.zeros(3, dtype=np.float64)

  try:
    model.geom_group[:] = 5
    model.geom_group[vis_gids] = 2
    model.geom_group[col_gids] = 3

    for ax_idx, ax_name in ((0, "X"), (1, "Y"), (2, "Z")):
      u_ax = (ax_idx + 1) % 3
      v_ax = (ax_idx + 2) % 3
      span_u = float(vis_max[u_ax] - vis_min[u_ax])
      span_v = float(vis_max[v_ax] - vis_min[v_ax])
      if span_u <= 1e-4 or span_v <= 1e-4:
        continue

      us = np.linspace(
          vis_min[u_ax] + 0.04 * span_u,
          vis_max[u_ax] - 0.04 * span_u,
          grid_res,
      )
      vs = np.linspace(
          vis_min[v_ax] + 0.04 * span_v,
          vis_max[v_ax] - 0.04 * span_v,
          grid_res,
      )
      vis_grid = np.zeros((grid_res, grid_res), dtype=bool)
      col_grid = np.zeros((grid_res, grid_res), dtype=bool)
      ray_neg[:] = 0.0
      ray_neg[ax_idx] = -1.0
      ray_pos[:] = 0.0
      ray_pos[ax_idx] = 1.0
      z_top = float(vis_max[ax_idx]) + 0.10
      z_bot = float(vis_min[ax_idx]) - 0.10

      for iu, uval in enumerate(us):
        for iv, vval in enumerate(vs):
          p[ax_idx] = z_top
          p[u_ax] = uval
          p[v_ax] = vval
          dv = mujoco.mj_ray(model, data, p, ray_neg, grp_vis, 1, -1, gid_buf)
          if dv <= 0:
            p[ax_idx] = z_bot
            dv = mujoco.mj_ray(model, data, p, ray_pos, grp_vis, 1, -1, gid_buf)
          if dv > 0:
            vis_grid[iu, iv] = True
            p[ax_idx] = z_top
            dc = mujoco.mj_ray(model, data, p, ray_neg, grp_col, 1, -1, gid_buf)
            if dc <= 0:
              p[ax_idx] = z_bot
              dc = mujoco.mj_ray(
                  model, data, p, ray_pos, grp_col, 1, -1, gid_buf
              )
            col_grid[iu, iv] = dc > 0

      axis_gaps = 0
      for iu in range(1, grid_res - 1):
        for iv in range(1, grid_res - 1):
          if not vis_grid[iu, iv] or col_grid[iu, iv]:
            continue
          u0 = iu
          while u0 > 0 and vis_grid[u0 - 1, iv]:
            u0 -= 1
          u1 = iu
          while u1 + 1 < grid_res and vis_grid[u1 + 1, iv]:
            u1 += 1
          between_u = bool(
              np.any(col_grid[u0:iu, iv])
              and np.any(col_grid[iu + 1 : u1 + 1, iv])
          )

          v0 = iv
          while v0 > 0 and vis_grid[iu, v0 - 1]:
            v0 -= 1
          v1 = iv
          while v1 + 1 < grid_res and vis_grid[iu, v1 + 1]:
            v1 += 1
          between_v = bool(
              np.any(col_grid[iu, v0:iv])
              and np.any(col_grid[iu, iv + 1 : v1 + 1])
          )

          deep_interior = (
              2 <= iu < grid_res - 2
              and 2 <= iv < grid_res - 2
              and bool(np.all(vis_grid[iu - 2 : iu + 3, iv - 2 : iv + 3]))
          )
          if between_u or between_v or deep_interior:
            axis_gaps += 1
      gaps_by_axis[ax_name] = axis_gaps
  finally:
    model.geom_group[:] = saved_geom_group

  return gaps_by_axis


def compute_collision_alignment_summary(
    model: mujoco.MjModel,
    data: mujoco.MjData | None = None,
    *,
    num_surface_samples: int = 4096,
) -> dict[str, Any]:
  """Computes seam-filtered surface fit and per-component visual coverage.

  Evaluates compiled MuJoCo visual and collision geometry to catch three failure
  modes missed by whole-asset AABB and flat floor-drop checks:
    1. Bidirectional surface fit (`c2v_p95_mm`, `v2c_p95_mm`): Filters out
       internal hull-to-hull seam faces buried inside neighboring colliders so
       multi-hull decompositions are scored only on their exposed boundary,
       catching diagonal `box`-on-cylinder corner overhang and concave tenting.
    2. Welded per-component visual coverage (`missing_visual_components`): Welds
       UV-split `.obj` seam vertices within each kinematic link (`body_weldid`),
       splits into connected visual components (`>= 5%` of bbox diagonal), and
       flags any component with `< 50%` collision coverage on its link.
    3. 3-axis orthographic ray needle-penetration check (`needle_gap_rays`,
       `needle_gap_rays_by_axis`): Casts a 3-axis (`X`, `Y`, `Z`) orthographic
       ray grid across the visual bounding box (`mj_ray`) and flags interior or
       between-collider rays that pierce visual geometry (`group="2"`) without
       intersecting any collision geom (`group="3"`).

  Args:
    model: Compiled `mujoco.MjModel` of the asset.
    data: Optional `mujoco.MjData` (created and forwarded at `qpos0` if None).
    num_surface_samples: Number of area-weighted surface sample points.

  Returns:
    JSON-serializable dictionary of alignment metrics, component coverage, and
    two-tier diagnostic status (`PASS` / `CHECK` / `FAIL`).
  """
  if data is None:
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

  vis_gids, col_gids = _classify_alignment_geoms(model)
  col_shapes: list[_ColliderShape] = []
  for gid in col_gids:
    tris, equations = _geom_world_triangles_and_hull(
        model, data, gid, use_convex_hull=True
    )
    if tris.shape[0] == 0:
      continue
    flat = tris.reshape(-1, 3)
    bid = int(model.geom_bodyid[gid])
    weld_id = int(model.body_weldid[bid])
    col_shapes.append(
        _ColliderShape(
            geom_id=gid,
            weld_id=weld_id,
            geom_type=int(model.geom_type[gid]),
            pos=np.asarray(data.geom_xpos[gid], dtype=np.float64),
            mat=np.asarray(data.geom_xmat[gid], dtype=np.float64).reshape(3, 3),
            size=np.asarray(model.geom_size[gid], dtype=np.float64),
            triangles=tris,
            hull_equations=equations,
            aabb_min=np.min(flat, axis=0),
            aabb_max=np.max(flat, axis=0),
        )
    )

  vis_entries: list[tuple[int, int, np.ndarray]] = []
  for gid in vis_gids:
    tris, _ = _geom_world_triangles_and_hull(
        model, data, gid, use_convex_hull=False
    )
    if tris.shape[0] > 0:
      bid = int(model.geom_bodyid[gid])
      vis_entries.append((gid, int(model.body_weldid[bid]), tris))

  if not vis_entries:
    return {
        "status": "PASS",
        "issues": [],
        "fit_gate_mm": 2.5,
        "c2v_mean_mm": 0.0,
        "c2v_p95_mm": 0.0,
        "c2v_p98_mm": 0.0,
        "c2v_max_mm": 0.0,
        "bridged_col_area_pct": 0.0,
        "v2c_mean_mm": 0.0,
        "v2c_p95_mm": 0.0,
        "v2c_p99_mm": 0.0,
        "v2c_max_mm": 0.0,
        "uncollided_vis_area_pct": 0.0,
        "n_visual_components": 0,
        "n_collider_islands": len(col_shapes),
        "missing_visual_components": [],
        "needle_gap_rays": 0,
        "needle_gap_rays_by_axis": {"X": 0, "Y": 0, "Z": 0},
    }

  vis_triangles = np.concatenate([t for _, _, t in vis_entries], axis=0)
  flat_vis = vis_triangles.reshape(-1, 3)
  vis_min = np.min(flat_vis, axis=0)
  vis_max = np.max(flat_vis, axis=0)
  diag = max(float(np.linalg.norm(vis_max - vis_min)), 1e-6)
  diag_mm = max(diag * 1000.0, 1.0)
  thin_extent_m = float(np.min(np.maximum(vis_max - vis_min, 1e-6)))
  fit_gate_m = min(max(0.0025, 0.02 * diag), max(0.0025, 0.035 * thin_extent_m))
  fit_gate_mm = fit_gate_m * 1000.0

  if not col_shapes:
    msg = (
        "Asset has visual geometry but 0 active collision geoms"
        " (contype != 0 or conaffinity != 0)."
    )
    return {
        "status": "FAIL",
        "issues": [msg],
        "fit_gate_mm": round(fit_gate_mm, 2),
        "c2v_mean_mm": 0.0,
        "c2v_p95_mm": 0.0,
        "c2v_p98_mm": 0.0,
        "c2v_max_mm": 0.0,
        "bridged_col_area_pct": 0.0,
        "v2c_mean_mm": round(diag_mm, 2),
        "v2c_p95_mm": round(diag_mm, 2),
        "v2c_p99_mm": round(diag_mm, 2),
        "v2c_max_mm": round(diag_mm, 2),
        "uncollided_vis_area_pct": 100.0,
        "n_visual_components": len(vis_entries),
        "n_collider_islands": 0,
        "missing_visual_components": [],
        "needle_gap_rays": 0,
        "needle_gap_rays_by_axis": {"X": 0, "Y": 0, "Z": 0},
    }

  rng = np.random.default_rng(42)

  # 1. Collider-to-visual surface fit with internal-seam filtering.
  col_tri_counts = [c.triangles.shape[0] for c in col_shapes]
  all_col_triangles = np.concatenate([c.triangles for c in col_shapes], axis=0)
  tri_to_col_idx = np.repeat(
      np.arange(len(col_shapes), dtype=np.int32), col_tri_counts
  )
  col_samples, col_sample_tri = _sample_triangles_area_weighted(
      all_col_triangles, num_surface_samples, rng
  )
  col_owner = tri_to_col_idx[col_sample_tri]

  seam_tol = max(0.0015, 0.004 * diag)
  is_internal_seam = np.zeros((col_samples.shape[0],), dtype=bool)
  if len(col_shapes) > 1:
    for c_idx, shape in enumerate(col_shapes):
      other_mask = (col_owner != c_idx) & (~is_internal_seam)
      if not np.any(other_mask):
        continue
      depths = _signed_depth_in_collider(
          col_samples[other_mask], shape, margin=seam_tol
      )
      other_idx = np.flatnonzero(other_mask)
      is_internal_seam[other_idx[depths < seam_tol]] = True

  exposed_col_pts = col_samples[~is_internal_seam]
  if exposed_col_pts.shape[0] == 0:
    exposed_col_pts = col_samples
  c2v_dists = _query_triangles_distance(exposed_col_pts, vis_triangles, rng)
  bridged_surface_ratio = float(np.mean(c2v_dists > fit_gate_m))
  c2v_mean_mm = float(np.mean(c2v_dists) * 1000.0)
  c2v_p95_mm = float(np.percentile(c2v_dists, 95) * 1000.0)
  c2v_p98_mm = float(np.percentile(c2v_dists, 98) * 1000.0)
  c2v_max_mm = float(np.max(c2v_dists) * 1000.0)

  # Touching collider islands via union-find.
  island_tol = max(0.003, 0.005 * diag)
  extra_pts = [c.triangles.reshape(-1, 3) for c in col_shapes]
  extra_owner = [
      np.full(len(p), i, dtype=np.int32) for i, p in enumerate(extra_pts)
  ]
  isl_pts = np.concatenate([col_samples] + extra_pts, axis=0)
  isl_owner = np.concatenate([col_owner] + extra_owner, axis=0)
  uf_parent = list(range(len(col_shapes)))

  def _uf_find(a: int) -> int:
    while uf_parent[a] != a:
      uf_parent[a] = uf_parent[uf_parent[a]]
      a = uf_parent[a]
    return a

  if len(col_shapes) > 1:
    for c_idx, shape in enumerate(col_shapes):
      other_mask = isl_owner != c_idx
      if not np.any(other_mask):
        continue
      depths = _signed_depth_in_collider(
          isl_pts[other_mask], shape, margin=island_tol
      )
      for o in np.unique(isl_owner[other_mask][depths <= island_tol]):
        ra, rb = _uf_find(int(o)), _uf_find(c_idx)
        if ra != rb:
          uf_parent[ra] = rb
  n_collider_islands = len({_uf_find(i) for i in range(len(col_shapes))})

  # 2. Visual-to-collider union coverage distance (0 inside solid colliders).
  vis_samples, _ = _sample_triangles_area_weighted(
      vis_triangles, num_surface_samples, rng
  )
  vert_chunks: list[np.ndarray] = []
  for _, _, g_tris in vis_entries:
    g_verts = g_tris.reshape(-1, 3)
    step = max(1, g_verts.shape[0] // 250)
    vert_chunks.append(g_verts[::step])
  vis_samples = np.concatenate([vis_samples] + vert_chunks, axis=0)
  inside_tol = min(0.0004, 0.001 * diag)
  inside_col = _points_inside_any_collider(vis_samples, col_shapes, inside_tol)
  v2c_dists = np.zeros((vis_samples.shape[0],), dtype=np.float64)
  if np.any(~inside_col):
    v2c_dists[~inside_col] = _query_triangles_distance(
        vis_samples[~inside_col], all_col_triangles, rng
    )
  uncollided_visual_ratio = float(np.mean(v2c_dists > fit_gate_m))
  v2c_mean_mm = float(np.mean(v2c_dists) * 1000.0)
  v2c_p95_raw = float(np.percentile(v2c_dists, 95) * 1000.0)
  v2c_p99_mm = float(np.percentile(v2c_dists, 99) * 1000.0)
  v2c_p95_mm = max(
      v2c_p95_raw,
      0.65 * v2c_p99_mm if v2c_p99_mm > 0.035 * diag_mm else v2c_p95_raw,
  )
  v2c_max_mm = float(np.max(v2c_dists) * 1000.0)

  # 3. Welded per-component visual coverage within each kinematic weld link.
  weld_tol = max(1e-6, 1e-5 * diag)
  cov_gate = max(0.0025, 0.02 * diag)
  by_weld: dict[int, list[tuple[int, np.ndarray]]] = {}
  for gid, weld_id, g_tris in vis_entries:
    by_weld.setdefault(weld_id, []).append((gid, g_tris))
  cols_by_weld: dict[int, list[_ColliderShape]] = {}
  for c in col_shapes:
    cols_by_weld.setdefault(c.weld_id, []).append(c)

  significant_comps: list[tuple[int, int, np.ndarray, float]] = []
  for weld_id, entries in sorted(by_weld.items()):
    w_tris = np.concatenate([t for _, t in entries], axis=0)
    w_gids = np.concatenate(
        [np.full(len(t), gid, dtype=np.int32) for gid, t in entries]
    )
    for comp_tris, primary_gid in _split_welded_triangles(
        w_tris, w_gids, weld_tol
    ):
      c_verts = comp_tris.reshape(-1, 3)
      ext = c_verts.max(axis=0) - c_verts.min(axis=0)
      max_span = float(np.max(ext))
      if max_span < 0.05 * diag or len(c_verts) < 4:
        continue
      sub_v = c_verts[:: max(1, len(c_verts) // 500)]
      centered = sub_v - np.mean(sub_v, axis=0)
      try:
        _, _, vt = np.linalg.svd(centered, full_matrices=False)
        proj = centered @ vt.T
        min_thick = float(np.min(proj.max(axis=0) - proj.min(axis=0)))
      except np.linalg.LinAlgError:
        min_thick = float(np.min(ext))
      if min_thick <= 1e-4:
        continue
      significant_comps.append((weld_id, primary_gid, comp_tris, max_span))

  missing_components: list[dict[str, Any]] = []
  comp_rng = np.random.default_rng(11)
  for comp_idx, (weld_id, primary_gid, comp_tris, max_span) in enumerate(
      significant_comps
  ):
    c_verts = comp_tris.reshape(-1, 3)
    s_pts, _ = _sample_triangles_area_weighted(comp_tris, 400, comp_rng)
    v_step = max(1, len(c_verts) // 200)
    probe_pts = np.concatenate([s_pts, c_verts[::v_step]], axis=0)
    cand_cols = cols_by_weld.get(weld_id) or (
        col_shapes if len(by_weld) == 1 else []
    )
    covered = _points_inside_any_collider(probe_pts, cand_cols, cov_gate)
    cov_frac = float(np.mean(covered)) if len(probe_pts) > 0 else 1.0
    if cov_frac < 0.50:
      bid = int(model.geom_bodyid[primary_gid])
      bname = (
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_BODY), bid)
          or f"body_{bid}"
      )
      gname = (
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), primary_gid)
          or f"geom_{primary_gid}"
      )
      center = 0.5 * (c_verts.min(axis=0) + c_verts.max(axis=0))
      missing_components.append({
          "component_index": comp_idx,
          "body": bname,
          "geom": gname,
          "max_span_mm": round(max_span * 1000.0, 1),
          "coverage_pct": round(cov_frac * 100.0, 1),
          "bbox_center_m": [round(float(x), 4) for x in center],
      })

  gross_fit_gate_mm = max(12.0, 0.08 * diag_mm)
  gross_v2c_gate_mm = max(8.0, 0.05 * diag_mm)
  fail_issues: list[str] = []
  check_issues: list[str] = []

  # 4. 3-axis orthographic ray needle-penetration check.
  needle_gap_rays_by_axis = _count_needle_penetration_rays(
      model, data, vis_gids, col_gids, vis_min, vis_max
  )
  needle_gap_rays = int(sum(needle_gap_rays_by_axis.values()))
  if needle_gap_rays > 0:
    axis_breakdown = ", ".join(
        f"{ax}={cnt}" for ax, cnt in needle_gap_rays_by_axis.items() if cnt > 0
    )
    fail_issues.append(
        f"Collision geometry has open gaps ({needle_gap_rays} orthographic"
        f" ray(s) [{axis_breakdown}] pierced visual mesh without intersecting"
        " any collider)."
    )

  if missing_components:
    summary = ", ".join(
        f"{mc['body']}/{mc['geom']} ({mc['coverage_pct']:.0f}% covered,"
        f" {mc['max_span_mm']:.0f}mm)"
        for mc in missing_components[:6]
    )
    fail_issues.append(
        "Visual component(s) >= 5% of bbox diagonal lack collision coverage"
        f" (< 50%): {summary}."
    )
  if c2v_mean_mm > max(20.0, 0.15 * diag_mm):
    fail_issues.append(
        "Gross collider-to-visual frame or scale mismatch:"
        f" c2v_mean={c2v_mean_mm:.1f}mm, c2v_p95={c2v_p95_mm:.1f}mm."
    )
  elif (
      c2v_p95_mm > gross_fit_gate_mm
      or c2v_mean_mm > 0.6 * gross_fit_gate_mm
      or (bridged_surface_ratio > 0.35 and c2v_p95_mm > 2.5 * fit_gate_mm)
  ):
    check_issues.append(
        "Collider overhang or concave bridging exceeds gate:"
        f" c2v_p95={c2v_p95_mm:.1f}mm (ref tight target {fit_gate_mm:.1f}mm),"
        f" c2v_max={c2v_max_mm:.1f}mm,"
        f" bridged_area={bridged_surface_ratio * 100.0:.1f}%."
    )

  if v2c_p95_mm > gross_v2c_gate_mm or uncollided_visual_ratio > 0.10:
    check_issues.append(
        "Visual geometry protrudes outside colliders:"
        f" v2c_p95={v2c_p95_mm:.1f}mm (gate {gross_v2c_gate_mm:.1f}mm),"
        f" uncollided_vis_area={uncollided_visual_ratio * 100.0:.1f}%."
    )

  status = "FAIL" if fail_issues else ("CHECK" if check_issues else "PASS")
  return {
      "status": status,
      "issues": fail_issues + check_issues,
      "fit_gate_mm": round(fit_gate_mm, 2),
      "c2v_mean_mm": round(c2v_mean_mm, 2),
      "c2v_p95_mm": round(c2v_p95_mm, 2),
      "c2v_p98_mm": round(c2v_p98_mm, 2),
      "c2v_max_mm": round(c2v_max_mm, 2),
      "bridged_col_area_pct": round(bridged_surface_ratio * 100.0, 1),
      "v2c_mean_mm": round(v2c_mean_mm, 2),
      "v2c_p95_mm": round(v2c_p95_mm, 2),
      "v2c_p99_mm": round(v2c_p99_mm, 2),
      "v2c_max_mm": round(v2c_max_mm, 2),
      "uncollided_vis_area_pct": round(uncollided_visual_ratio * 100.0, 1),
      "n_visual_components": len(significant_comps),
      "n_collider_islands": n_collider_islands,
      "missing_visual_components": missing_components,
      "needle_gap_rays": needle_gap_rays,
      "needle_gap_rays_by_axis": needle_gap_rays_by_axis,
  }


def _attach_all_child_bodies(
    carrier: Any, child_spec: Any, prefix: str = "obj_"
) -> None:
  """Attaches all top-level worldbody child bodies onto `carrier`."""
  top_bodies = list(child_spec.worldbody.bodies)
  if not top_bodies:
    return
  frame = carrier.add_frame()
  for b in top_bodies:
    for j in list(b.joints):
      if int(j.type) == int(mujoco.mjtJoint.mjJNT_FREE):
        child_spec.delete(j)
    frame.attach_body(b, prefix, "")


def build_attached_scene_model(
    xml_path: str,
    setup_fn: Any,
) -> tuple[mujoco.MjModel, mujoco.MjData]:
  """Builds a scene with the asset attached on a carrier body."""
  child_spec = mujoco.MjSpec.from_file(xml_path)
  child_spec.compiler.autolimits = True

  parent_spec = mujoco.MjSpec()
  parent_spec.modelname = "scenario_audit_scene"
  parent_spec.compiler.degree = False
  parent_spec.compiler.autolimits = True
  parent_spec.option.integrator = mujoco.mjtIntegrator.mjINT_EULER
  parent_spec.option.timestep = 0.002
  parent_spec.visual.global_.offwidth = 640
  parent_spec.visual.global_.offheight = 480

  # Add skybox & checker floor texture/material
  sky = parent_spec.add_texture(
      name="scenario_sky",
      type=mujoco.mjtTexture.mjTEXTURE_SKYBOX,
      builtin=mujoco.mjtBuiltin.mjBUILTIN_GRADIENT,
      width=256,
      height=1536,
  )
  sky.rgb1 = [0.86, 0.90, 0.96]
  sky.rgb2 = [0.96, 0.98, 1.00]

  chk = parent_spec.add_texture(
      name="scenario_checker",
      type=mujoco.mjtTexture.mjTEXTURE_2D,
      builtin=mujoco.mjtBuiltin.mjBUILTIN_CHECKER,
      width=256,
      height=256,
  )
  chk.rgb1 = [0.84, 0.87, 0.91]
  chk.rgb2 = [0.74, 0.78, 0.84]
  chk.mark = mujoco.mjtMark.mjMARK_EDGE
  chk.markrgb = [0.65, 0.70, 0.76]

  mat = parent_spec.add_material(name="scenario_floor_mat")
  mat.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = "scenario_checker"
  mat.texuniform = True
  mat.texrepeat = [10.0, 10.0]
  mat.reflectance = 0.08

  wb = parent_spec.worldbody
  light1 = wb.add_light(name="scenario_key_light")
  light1.pos = [0.4, -0.5, 1.8]
  light1.dir = [-0.2, 0.25, -1.0]
  light1.diffuse = [0.85, 0.85, 0.85]
  light1.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL

  light2 = wb.add_light(name="scenario_fill_light")
  light2.pos = [-0.5, 0.5, 1.5]
  light2.dir = [0.25, -0.25, -1.0]
  light2.diffuse = [0.45, 0.48, 0.52]
  light2.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL

  setup_fn(parent_spec, child_spec)
  model = parent_spec.compile()
  data = mujoco.MjData(model)
  mujoco.mj_forward(model, data)
  return model, data


def render_scene_frame(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    lookat: Sequence[float],
    distance: float,
    elevation: float = -22.0,
    azimuth: float = 135.0,
    show_col_overlay: bool = False,
    show_sites: bool = False,
    width: int = 380,
    height: int = 260,
) -> Image.Image:
  """Renders an offscreen RGB frame with optional collision group 3 / site group 4 overlay."""
  r = mujoco.Renderer(model, height=height, width=width)
  cam = mujoco.MjvCamera()
  mujoco.mjv_defaultFreeCamera(model, cam)
  cam.lookat[:] = lookat
  cam.distance = distance
  cam.elevation = elevation
  cam.azimuth = azimuth

  opt = mujoco.MjvOption()
  mujoco.mjv_defaultOption(opt)
  opt.geomgroup[0] = 1
  opt.geomgroup[1] = 1
  opt.geomgroup[2] = 1
  opt.geomgroup[3] = 1 if show_col_overlay else 0
  opt.geomgroup[4] = 0
  opt.geomgroup[5] = 0
  opt.sitegroup[0] = 1 if show_sites else 0
  opt.sitegroup[1] = 1 if show_sites else 0
  opt.sitegroup[2] = 1 if show_sites else 0
  opt.sitegroup[3] = 1 if show_sites else 0
  opt.sitegroup[4] = 1 if show_sites else 0

  saved_rgba = None
  if show_col_overlay:
    _, col_ids = classify_asset_geoms(model)
    if len(col_ids) > 1:
      rgbs = np.round(model.geom_rgba[col_ids, :3], 2)
      if len(np.unique(rgbs, axis=0)) == 1:
        saved_rgba = model.geom_rgba.copy()
        for idx, gid in enumerate(col_ids):
          hue = (idx * 0.61803398875) % 1.0
          r_c, g_c, b_c = colorsys.hsv_to_rgb(hue, 0.82, 0.92)
          alpha = float(np.clip(model.geom_rgba[gid, 3], 0.42, 0.60))
          model.geom_rgba[gid] = [r_c, g_c, b_c, alpha]

  r.update_scene(data, camera=cam, scene_option=opt)
  rgb = r.render()
  if saved_rgba is not None:
    model.geom_rgba[:] = saved_rgba
  r.close()
  return Image.fromarray(rgb)


# ---------------------------------------------------------------------------
# Scenario 1: 6-Pose Drop Settle & Tabletop Hover Audit
# ---------------------------------------------------------------------------
def run_scenario_1_six_pose_drop(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Drops the asset from 6 canonical poses and measures hover & settling."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    fl = wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    fl.condim = 6
    fl.friction = [0.7, 0.01, 0.002]
    carrier = wb.add_body(name="carrier", pos=[0, 0, 0.15])
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

  model, data = build_attached_scene_model(xml_path, _setup)
  vis_ids, col_ids = classify_asset_geoms(model, "obj_")
  total_mass = float(np.sum(model.body_mass[1:]))
  expected_mg = total_mass * 9.81

  # Measure upright vertical contact hover & normal force
  mujoco.mj_resetData(model, data)
  data.qpos[3:7] = [1.0, 0.0, 0.0, 0.0]
  data.qpos[0:3] = [0.0, 0.0, max_dim + 0.10]
  mujoco.mj_forward(model, data)
  all_pts0 = compute_geom_vertices_world(model, data, vis_ids + col_ids)
  data.qpos[2] += 0.003 - float(np.min(all_pts0[:, 2]))
  mujoco.mj_forward(model, data)
  for _ in range(200):
    data.qvel[0:2] = 0.0
    data.qvel[3:6] = 0.0
    mujoco.mj_step(model, data)

  vis_pts_up = compute_geom_vertices_world(model, data, vis_ids)
  col_pts_up = compute_geom_vertices_world(model, data, col_ids)
  upright_vis_hover_mm = float(np.min(vis_pts_up[:, 2]) * 1000.0)
  upright_col_min_mm = float(np.min(col_pts_up[:, 2]) * 1000.0)

  floor_gid = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_GEOM), "scenario_floor"
  )
  fn_total = 0.0
  c_force = np.zeros(6, dtype=np.float64)
  for ic in range(data.ncon):
    c = data.contact[ic]
    if int(c.geom1) == floor_gid or int(c.geom2) == floor_gid:
      c_force[:] = 0.0
      mujoco.mj_contactForce(model, data, ic, c_force)
      fn_total += abs(float(c_force[0]))

  pos_up = data.qpos[0:3].copy()
  upright_img = render_scene_frame(
      model,
      data,
      lookat=[
          float(pos_up[0]),
          float(pos_up[1]),
          float(max(span[2] * 0.45, 0.025)),
      ],
      distance=max(max_dim * 2.1, 0.14),
      elevation=-14.0,
      azimuth=135.0,
      show_col_overlay=True,
  )

  # 6 canonical orientations drop (clearance & duration scaled by object size L)
  poses = {
      "+Z_up": [1.0, 0.0, 0.0, 0.0],
      "-Z_up": [0.0, 1.0, 0.0, 0.0],
      "+X_up": [0.7071068, 0.0, -0.7071068, 0.0],
      "-X_up": [0.7071068, 0.0, 0.7071068, 0.0],
      "+Y_up": [0.7071068, 0.7071068, 0.0, 0.0],
      "-Y_up": [0.7071068, -0.7071068, 0.0, 0.0],
  }
  pose_results = {}
  any_nan = False
  max_final_speed = 0.0
  drop_clearance = max(0.25 * max_dim, 0.015)
  settle_steps = int(
      np.clip(450 * math.sqrt(max(max_dim, 0.04) / 0.10), 400, 1200)
  )

  for pname, quat in poses.items():
    mujoco.mj_resetData(model, data)
    data.qpos[3:7] = quat
    data.qpos[0:3] = [0.0, 0.0, max_dim + drop_clearance]
    mujoco.mj_forward(model, data)
    pts = compute_geom_vertices_world(model, data, vis_ids + col_ids)
    min_z = float(np.min(pts[:, 2]))
    data.qpos[2] += drop_clearance - min_z
    mujoco.mj_forward(model, data)

    for _ in range(settle_steps):
      mujoco.mj_step(model, data)
      if np.any(np.isnan(data.qpos)) or np.any(np.isnan(data.qvel)):
        any_nan = True
        break

    lin_spd = float(np.linalg.norm(data.qvel[0:3]))
    ang_spd = float(np.linalg.norm(data.qvel[3:6]))
    max_final_speed = max(max_final_speed, lin_spd)
    v_pts = compute_geom_vertices_world(model, data, vis_ids)
    pose_results[pname] = {
        "vis_min_z_mm": round(float(np.min(v_pts[:, 2]) * 1000.0), 3),
        "final_lin_speed_m_s": round(lin_spd, 5),
        "final_ang_speed_rad_s": round(ang_spd, 5),
    }

  status = "PASS"
  issues = []
  thresh = base_info.get("thresholds", DEFAULT_THRESHOLDS)
  hover_tol_mm = max(
      float(thresh.get("hover_tol_mm", 3.0)), min(span) * 1000.0 * 0.03
  )
  if any_nan:
    status = "FAIL"
    issues.append("NaN encountered during 6-pose drop.")
  elif abs(upright_vis_hover_mm) > hover_tol_mm:
    status = "FAIL"
    issues.append(
        f"Upright visual bottom z={upright_vis_hover_mm:+.2f} mm (tol"
        f" +/-{hover_tol_mm:.1f} mm; positive=hover, negative=sink)."
    )

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Positive upright_vis_hover_mm > 2mm means collision hulls"
              " protrude below the visual mesh (tabletop hover); negative <"
              " -2mm means visual mesh sinks into the floor."
          ),
          "upright_vis_hover_mm": round(upright_vis_hover_mm, 3),
          "upright_col_min_mm": round(upright_col_min_mm, 3),
          "upright_normal_force_N": round(fn_total, 4),
          "expected_weight_N": round(expected_mg, 4),
          "any_nan": any_nan,
          "max_final_speed_m_s": round(max_final_speed, 5),
          "poses": pose_results,
      },
      upright_img,
  )


# ---------------------------------------------------------------------------
# Scenario 2: Dual-Axis Tilt-Table CoM & Friction Sweep (0 -> 55 deg)
# ---------------------------------------------------------------------------
def run_scenario_2_tilt_table(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Sweeps an auto-scaled tilt table from 0 to 55 deg along X and Y axes."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))
  total_mass_kg = max(float(base_info["total_mass_g"]) * 1e-3, 0.005)

  plank_hx = max(max_dim * 1.85, 0.20)
  plank_hy = max(max_dim * 1.25, 0.14)
  plank_hz = max(max_dim * 0.04, 0.012)
  # Scale pivot height so plank +X end never clips floor even at 60 deg tilt
  pivot_z = plank_hx * math.sin(math.radians(60.0)) + 0.06
  # Scale servo stiffness so heavy objects never sag the tilt table
  kp_tilt = max(2500.0, 250.0 * (total_mass_kg + 2.0) * 9.81 * plank_hx)

  results_by_axis = {}
  snapshot_img = None

  for axis_name, yaw_quat in (
      ("X_axis", [1.0, 0.0, 0.0, 0.0]),
      ("Y_axis", [0.7071068, 0.0, 0.0, 0.7071068]),
  ):

    def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
      wb = parent_spec.worldbody
      fl = wb.add_geom(
          name="scenario_floor",
          type=mujoco.mjtGeom.mjGEOM_PLANE,
          pos=[0, 0, 0.0],
          size=[0, 0, 0.05],
          material="scenario_floor_mat",
      )
      fl.contype = 0
      fl.conaffinity = 0
      table = wb.add_body(name="scenario_tilt_table", pos=[0, 0, pivot_z])
      table.add_joint(
          name="scenario_tilt_hinge",
          type=mujoco.mjtJoint.mjJNT_HINGE,
          axis=[0, 1, 0],
          range=[0.0, 1.05],
          damping=max(60.0, 0.05 * kp_tilt),
          armature=5.0,
      )
      pl = table.add_geom(
          name="scenario_plank",
          type=mujoco.mjtGeom.mjGEOM_BOX,
          size=[plank_hx, plank_hy, plank_hz],
          rgba=[0.28, 0.36, 0.48, 1.0],
      )
      pl.condim = 6
      pl.friction = [0.65, 0.01, 0.001]

      # Scaled catch lip at bottom (+X) edge of plank
      lip_hx = max(0.008, 0.03 * max_dim)
      lip_hz = max(0.018, 0.22 * span[2])
      lip = table.add_geom(
          name="scenario_catch_lip",
          type=mujoco.mjtGeom.mjGEOM_BOX,
          pos=[plank_hx - lip_hx, 0.0, plank_hz + lip_hz],
          size=[lip_hx, plank_hy, lip_hz],
          rgba=[0.20, 0.26, 0.36, 1.0],
      )
      lip.condim = 6

      act = parent_spec.add_actuator(
          name="scenario_tilt_act",
          target="scenario_tilt_hinge",
          trntype=mujoco.mjtTrn.mjTRN_JOINT,
      )
      act.gainprm[0] = kp_tilt
      act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
      act.biasprm[1] = -kp_tilt
      act.biasprm[2] = -0.1 * kp_tilt

      mid_x = float(0.5 * (bmin[0] + bmax[0]))
      mid_y = float(0.5 * (bmin[1] + bmax[1]))
      if axis_name == "X_axis":
        rot_mid_x, rot_mid_y = mid_x, mid_y
      else:
        rot_mid_x, rot_mid_y = -mid_y, mid_x
      carrier = wb.add_body(
          name="carrier",
          pos=[
              -0.15 * plank_hx - rot_mid_x,
              -rot_mid_y,
              pivot_z + plank_hz - bmin[2] + 0.002,
          ],
      )
      carrier.add_freejoint(name="carrier_free")
      _attach_all_child_bodies(carrier, child_spec, "obj_")

    model, data = build_attached_scene_model(xml_path, _setup)
    q_adr = int(model.jnt_qposadr[1])
    data.qpos[q_adr + 3 : q_adr + 7] = yaw_quat
    mujoco.mj_forward(model, data)
    for _ in range(150):
      data.ctrl[0] = 0.0
      mujoco.mj_step(model, data)

    table_id = mujoco.mj_name2id(
        model, int(mujoco.mjtObj.mjOBJ_BODY), "scenario_tilt_table"
    )
    carrier_id = mujoco.mj_name2id(
        model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier"
    )

    def _rel_pos_and_tilt(
        mj_data: mujoco.MjData = data,
        tid: int = table_id,
        cid: int = carrier_id,
    ) -> tuple[np.ndarray, float]:
      t_pos = np.array(mj_data.xpos[tid], dtype=np.float64)
      t_mat = np.array(mj_data.xmat[tid], dtype=np.float64).reshape(3, 3)
      c_pos = np.array(mj_data.xpos[cid], dtype=np.float64)
      c_mat = np.array(mj_data.xmat[cid], dtype=np.float64).reshape(3, 3)
      rel_p = t_mat.T @ (c_pos - t_pos)
      rel_r = t_mat.T @ c_mat
      cos_ang = np.clip(rel_r[2, 2], -1.0, 1.0)
      tilt_deg = math.degrees(math.acos(cos_ang))
      return rel_p[:2].copy(), tilt_deg

    p0_xy, t0 = _rel_pos_and_tilt()
    slip_angle_deg = None
    tip_angle_deg = None
    max_angle_deg = 55.0
    total_steps = 1100
    slip_thresh = max(0.008, 0.04 * max_dim)

    for step in range(total_steps):
      target_rad = math.radians(max_angle_deg) * (step / total_steps)
      data.ctrl[0] = target_rad
      mujoco.mj_step(model, data)
      cur_deg = math.degrees(float(data.qpos[0]))
      rel_xy, dt = _rel_pos_and_tilt()
      disp = float(np.linalg.norm(rel_xy - p0_xy))
      if slip_angle_deg is None and disp > slip_thresh:
        slip_angle_deg = round(cur_deg, 1)
      if tip_angle_deg is None and abs(dt - t0) > 15.0:
        tip_angle_deg = round(cur_deg, 1)
      if axis_name == "X_axis" and step == int(total_steps * 0.62):
        snapshot_img = render_scene_frame(
            model,
            data,
            lookat=[0.0, 0.0, pivot_z],
            distance=max(plank_hx * 2.5, 0.32),
            elevation=-18.0,
            azimuth=118.0,
            show_col_overlay=False,
        )

    results_by_axis[axis_name] = {
        "slip_angle_deg": (
            slip_angle_deg if slip_angle_deg is not None else ">55.0"
        ),
        "tip_angle_deg": (
            tip_angle_deg if tip_angle_deg is not None else ">55.0"
        ),
        "implied_mu": (
            round(math.tan(math.radians(slip_angle_deg)), 3)
            if isinstance(slip_angle_deg, float)
            else None
        ),
    }

  status = "INFO"
  issues = []
  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Diagnostic telemetry: Flat-bottomed objects typically slip at"
              " arctan(mu) ~ 25-42 deg; tall objects tip at"
              " arctan(base_half_width / com_height); spheres/cylinders roll"
              " immediately (<5 deg). Compare tip angle against"
              " com_height_pct_of_z_span"
              f" ({base_info.get('com_height_pct_of_z_span', 50.0)}%) and"
              " z_band_mass_density to verify CoM height is physically"
              " realistic (e.g. weighted pot base vs airy upper foliage)."
          ),
          "com_height_pct_of_z_span": base_info.get(
              "com_height_pct_of_z_span", 50.0
          ),
          "axes": results_by_axis,
      },
      snapshot_img,
  )


# ---------------------------------------------------------------------------
# Scenario 3: Roll-Out & Spin Dissipation + Hull Density Uniformity
# ---------------------------------------------------------------------------
def run_scenario_3_roll_and_isotropy(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Measures tabletop roll/spin settling and per-hull density uniformity."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    fl = wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    fl.condim = 6
    fl.friction = [0.7, 0.01, 0.002]
    carrier = wb.add_body(name="carrier", pos=[0, 0, 0.002 - bmin[2]])
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

  model, data = build_attached_scene_model(xml_path, _setup)
  for _ in range(100):
    mujoco.mj_step(model, data)
  p_start = np.array(data.qpos[:2], dtype=np.float64)

  # Froude-scaled horizontal push (v ~ sqrt(g * L)) & surface-matched spin
  v_push = float(np.clip(1.25 * math.sqrt(9.81 * max_dim), 0.25, 1.50))
  w_spin = float(
      np.clip(v_push / max(0.5 * float(np.min(span)), 0.01), 3.0, 14.0)
  )
  data.qvel[0] = v_push
  data.qvel[4] = w_spin
  data.qvel[5] = w_spin

  settle_step = 1250
  mid_img = None
  for step in range(1250):
    mujoco.mj_step(model, data)
    lin_spd = float(np.linalg.norm(data.qvel[:3]))
    ang_spd = float(np.linalg.norm(data.qvel[3:6]))
    if step > 30 and lin_spd < 2e-3 and ang_spd < 2e-2:
      settle_step = min(settle_step, step)
    if step == 180:
      pos = data.qpos[:3]
      mid_img = render_scene_frame(
          model,
          data,
          lookat=[
              float(pos[0] * 0.5),
              float(pos[1] * 0.5),
              float(max(span[2] * 0.5, 0.03)),
          ],
          distance=max(max_dim * 2.8, 0.25),
          elevation=-22.0,
          azimuth=125.0,
          show_col_overlay=False,
      )

  roll_dist_cm = float(np.linalg.norm(data.qpos[:2] - p_start) * 100.0)
  final_lin = float(np.linalg.norm(data.qvel[:3]))
  final_ang = float(np.linalg.norm(data.qvel[3:6]))
  settled = settle_step < 1250

  status = "INFO"
  issues = []
  hull_cv = base_info.get("hull_density_cv", 0.0)
  trunc_geoms = base_info.get("maxhullvert_truncated_geoms", [])
  if trunc_geoms:
    status = "FAIL"
    issues.append(
        f"{len(trunc_geoms)} collision mesh(es) have >64 raw convex hull"
        " vertices truncated by maxhullvert='64' (causes greedy facet"
        " flattening & volume/density skew; author hulls natively with <=64"
        " vertices)."
    )

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Diagnostic telemetry: Inspect z_band_mass_density,"
              " com_height_pct_of_z_span, and hull_density_cv together."
              " Homogeneous single-material objects should have uniform density"
              " across hulls (hull_density_cv ~ 0), whereas composite /"
              " multi-material objects (e.g., solid pot base + airy foliage"
              " canopy, or metal tool head + handle) SHOULD have different"
              " densities per material region (hull_density_cv > 0.15 is"
              " physically expected and does NOT trigger any warning)."
          ),
          "roll_distance_cm": round(roll_dist_cm, 2),
          "settle_time_s": round(settle_step * model.opt.timestep, 3),
          "settled_within_2p5s": settled,
          "final_lin_speed_m_s": round(final_lin, 5),
          "final_ang_speed_rad_s": round(final_ang, 5),
          "hull_density_cv": round(hull_cv, 4),
          "eff_hull_density_g_cm3": base_info.get(
              "eff_hull_density_g_cm3", 0.0
          ),
          "com_height_pct_of_z_span": base_info.get(
              "com_height_pct_of_z_span", 50.0
          ),
          "z_band_mass_density": base_info.get("z_band_mass_density", {}),
      },
      mid_img,
  )


# ---------------------------------------------------------------------------
# Scenario 4: 3-Axis Ray-Guided Cavity & Through-Hole Probe + Marble Drop
# ---------------------------------------------------------------------------
def run_scenario_4_smart_cavity_probe(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Casts 3-axis (X,Y,Z) rays to find plugged cavities/loops & drops scaled marbles."""
  del base_info
  standalone = mujoco.MjModel.from_xml_path(xml_path)
  s_data = mujoco.MjData(standalone)
  opened_joints = {}
  for jid in range(standalone.njnt):
    jtype = int(standalone.jnt_type[jid])
    if jtype in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE):
      jname = (
          mujoco.mj_id2name(standalone, int(mujoco.mjtObj.mjOBJ_JOINT), jid)
          or f"j_{jid}"
      )
      qadr = int(standalone.jnt_qposadr[jid])
      rmin, rmax = standalone.jnt_range[jid]
      q_open = float(rmin if abs(rmin) > abs(rmax) else rmax)
      s_data.qpos[qadr] = q_open
      opened_joints[jname] = round(q_open, 4)
  mujoco.mj_forward(standalone, s_data)

  vis_ids, _ = classify_asset_geoms(standalone)
  vis_pts = compute_geom_vertices_world(standalone, s_data, vis_ids)
  bmin = vis_pts.min(axis=0)
  bmax = vis_pts.max(axis=0)
  span = bmax - bmin
  max_dim = float(np.max(span))

  grp_vis = np.array([1, 1, 1, 0, 0, 0], dtype=np.uint8)
  grp_col = np.array([0, 0, 0, 1, 0, 0], dtype=np.uint8)

  # 1) Top-down (-Z) 20x20 ray grid for cavities
  xs = np.linspace(bmin[0] + 0.08 * span[0], bmax[0] - 0.08 * span[0], 20)
  ys = np.linspace(bmin[1] + 0.08 * span[1], bmax[1] - 0.08 * span[1], 20)
  z_start = float(bmax[2] + 0.10)
  vec_down = np.array([0.0, 0.0, -1.0], dtype=np.float64)

  plugged_rays = 0
  cavity_targets = []
  max_plug_deficit_mm = 0.0

  for x in xs:
    for y in ys:
      pnt = np.array([x, y, z_start], dtype=np.float64)
      gid_v = np.array([-1], dtype=np.int32)
      gid_c = np.array([-1], dtype=np.int32)
      d_v = mujoco.mj_ray(
          standalone, s_data, pnt, vec_down, grp_vis, 1, -1, gid_v
      )
      d_c = mujoco.mj_ray(
          standalone, s_data, pnt, vec_down, grp_col, 1, -1, gid_c
      )
      if d_v > 0 and d_c > 0:
        z_v = z_start - d_v
        z_c = z_start - d_c
        deficit_mm = (z_c - z_v) * 1000.0
        if deficit_mm > 4.0:
          pnt_low = np.array([x, y, z_v + 0.0035], dtype=np.float64)
          gid_c2 = np.array([-1], dtype=np.int32)
          d_c2 = mujoco.mj_ray(
              standalone, s_data, pnt_low, vec_down, grp_col, 1, -1, gid_c2
          )
          is_open_under_overhang = (d_c2 > 0.0) and (
              abs(d_c2 - 0.0035) < 0.0025
          )
          if not is_open_under_overhang:
            plugged_rays += 1
            max_plug_deficit_mm = max(max_plug_deficit_mm, deficit_mm)
        if (bmax[2] - z_v) > 0.20 * span[2]:
          cavity_targets.append((float(x), float(y), float(z_v), float(z_c)))

  # 2) 3-Axis (X, Y, Z) silhouette through-hole check (plugged handles/loops)
  plugged_through_holes_by_axis = {"X": 0, "Y": 0, "Z": 0}
  clear_through_holes_by_axis = {"X": 0, "Y": 0, "Z": 0}
  for ax_idx, ax_name in ((0, "X"), (1, "Y"), (2, "Z")):
    u_ax = (ax_idx + 1) % 3
    v_ax = (ax_idx + 2) % 3
    us = np.linspace(
        bmin[u_ax] + 0.06 * span[u_ax], bmax[u_ax] - 0.06 * span[u_ax], 18
    )
    vs = np.linspace(
        bmin[v_ax] + 0.06 * span[v_ax], bmax[v_ax] - 0.06 * span[v_ax], 18
    )
    vis_grid = np.zeros((18, 18), dtype=bool)
    col_grid = np.zeros((18, 18), dtype=bool)
    ray_dir = np.zeros(3, dtype=np.float64)
    ray_dir[ax_idx] = -1.0
    for iu, uval in enumerate(us):
      for iv, vval in enumerate(vs):
        p = np.zeros(3, dtype=np.float64)
        p[ax_idx] = bmax[ax_idx] + 0.10
        p[u_ax] = uval
        p[v_ax] = vval
        gv = np.array([-1], dtype=np.int32)
        gc = np.array([-1], dtype=np.int32)
        dv = mujoco.mj_ray(standalone, s_data, p, ray_dir, grp_vis, 1, -1, gv)
        dc = mujoco.mj_ray(standalone, s_data, p, ray_dir, grp_col, 1, -1, gc)
        vis_grid[iu, iv] = dv > 0
        col_grid[iu, iv] = dc > 0
    # A ray is an interior visual hole if vis_grid[iu, iv] is False while
    # surrounded on both sides in u and v by vis_grid True.
    for iu in range(1, 17):
      for iv in range(1, 17):
        if not vis_grid[iu, iv]:
          enclosed_u = np.any(vis_grid[:iu, iv]) and np.any(
              vis_grid[iu + 1 :, iv]
          )
          enclosed_v = np.any(vis_grid[iu, :iv]) and np.any(
              vis_grid[iu, iv + 1 :]
          )
          if enclosed_u and enclosed_v:
            if col_grid[iu, iv]:
              plugged_through_holes_by_axis[ax_name] += 1
            else:
              clear_through_holes_by_axis[ax_name] += 1

  cavity_targets.sort(key=lambda t: t[2])
  chosen_xy = []
  for cx, cy, zv, zc in cavity_targets:
    if all(
        math.hypot(cx - ox, cy - oy) > max(0.012, 0.12 * max_dim)
        for ox, oy, _, _ in chosen_xy
    ):
      chosen_xy.append((cx, cy, zv, zc))
    if len(chosen_xy) >= 6:
      break
  has_detected_cavity = bool(chosen_xy)
  if not chosen_xy:
    cx, cy = float(0.5 * (bmin[0] + bmax[0])), float(0.5 * (bmin[1] + bmax[1]))
    chosen_xy = [
        (
            cx + dx * 0.15 * span[0],
            cy + dy * 0.15 * span[1],
            float(bmax[2]),
            float(bmax[2]),
        )
        for dx, dy in ((0, 0), (-1, -1), (1, -1), (-1, 1), (1, 1))
    ]

  probe_r = float(np.clip(min(span[0], span[1]) * 0.055, 0.0020, 0.045))
  probe_mass = float(max(2500.0 * (4.0 / 3.0) * math.pi * (probe_r**3), 0.0005))

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    carrier = wb.add_body(name="carrier", pos=[0, 0, max(0.002 - bmin[2], 0.0)])
    _attach_all_child_bodies(carrier, child_spec, "obj_")

    for idx, (mx, my, _, _) in enumerate(chosen_xy):
      for layer in range(2):
        mbody = wb.add_body(
            name=f"scenario_marble_{idx}_{layer}",
            pos=[
                mx + (layer - 0.5) * probe_r * 0.5,
                my,
                float(
                    bmax[2]
                    - bmin[2]
                    + max(0.025, 0.3 * span[2])
                    + layer * probe_r * 2.6
                ),
            ],
        )
        mbody.add_freejoint(name=f"scenario_marble_free_{idx}_{layer}")
        mg = mbody.add_geom(
            name=f"scenario_marble_geom_{idx}_{layer}",
            type=mujoco.mjtGeom.mjGEOM_SPHERE,
            size=[probe_r, 0, 0],
            mass=probe_mass,
            rgba=[0.15, 0.82, 0.95, 1.0]
            if layer == 0
            else [0.98, 0.65, 0.15, 1.0],
        )
        mg.condim = 6
        mg.friction = [0.4, 0.005, 0.001]

  model, data = build_attached_scene_model(xml_path, _setup)
  for jid in range(model.njnt):
    jtype = int(model.jnt_type[jid])
    if jtype in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE):
      qadr = int(model.jnt_qposadr[jid])
      rmin, rmax = model.jnt_range[jid]
      q_open = float(rmin if abs(rmin) > abs(rmax) else rmax)
      data.qpos[qadr] = q_open
      dadr = int(model.jnt_dofadr[jid])
      model.dof_damping[dadr] = 50.0
      model.dof_armature[dadr] = max(float(model.dof_armature[dadr]), 0.10)
  mujoco.mj_forward(model, data)

  for _ in range(500):
    mujoco.mj_step(model, data)

  center = 0.5 * (bmin + bmax)
  img = render_scene_frame(
      model,
      data,
      lookat=[
          float(center[0]),
          float(center[1]),
          float(max(center[2] - bmin[2], 0.03)),
      ],
      distance=max(max_dim * 2.2, 0.16),
      elevation=-32.0,
      azimuth=135.0,
      show_col_overlay=True,
  )

  status = "INFO"
  issues = []

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Diagnostic telemetry: Inspect the ray-hit visualization, dropped"
              " marble resting positions, plugged_ray_count_of_400, and"
              " plugged_through_holes_by_axis in context. Open containers"
              " (bowls, mugs), neck undercuts, and functional handle/clip loops"
              " should be unobstructed so marbles enter the cavity and loop"
              " rays pass through; foliage canopies, bristles, and fine"
              " decorative crevices SHOULD be wrapped in smooth envelope hulls."
          ),
          "has_visual_cavity": has_detected_cavity,
          "opened_joints_for_probe": opened_joints,
          "plugged_ray_count_of_400": plugged_rays,
          "max_ray_plug_deficit_mm": round(max_plug_deficit_mm, 2),
          "plugged_through_holes_by_axis": plugged_through_holes_by_axis,
          "clear_through_holes_by_axis": clear_through_holes_by_axis,
          "probe_sphere_radius_mm": round(probe_r * 1000.0, 2),
      },
      img,
  )


# ---------------------------------------------------------------------------
# Scenario 5: Auto-Scaled CoM-Aligned Parallel-Jaw Grasp, Hoist & 3 Hz Shake
# ---------------------------------------------------------------------------
def run_scenario_5_phased_grasp(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Runs an auto-scaled 4-phase closed-loop parallel-jaw grasp, hoist & shake."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))
  total_mass_kg = max(float(base_info["total_mass_g"]) * 1e-3, 0.005)
  com_above_floor = float(base_info.get("com_z_above_floor_m", 0.5 * span[2]))

  grasp_along_x = span[0] <= span[1]
  grasp_width = float(min(span[0], span[1]))
  other_width = float(max(span[0], span[1]))
  strut_thk = max(0.008, 0.025 * max_dim)
  pad_thk = max(0.004, 0.015 * max_dim)
  approach_clearance = max(0.016, 0.10 * grasp_width)
  open_half_gap = (
      0.5 * grasp_width + strut_thk + 2.0 * pad_thk + approach_clearance
  )
  # Close travel = approach_clearance + 18% of grasp_width (reaches narrower
  # waists without crushing to x=0).
  overdrive = max(0.008, 0.18 * grasp_width)
  max_close = approach_clearance + overdrive

  # Scale finger pad size & align vertical grasp center with asset CoM height
  pad_half_depth = float(max(other_width * 0.36, 0.014))
  pad_half_height = float(max(span[2] * 0.38, 0.012))
  target_grasp_z = float(
      np.clip(com_above_floor, 0.25 * span[2], 0.72 * span[2])
  )
  grasp_z = max(0.003 + pad_half_height, target_grasp_z)
  palm_thk = max(0.012, 0.04 * max_dim)
  palm_z = grasp_z + pad_half_height + palm_thk

  # Scale hoist height & actuator gains with asset size and mass (compliant
  # grip avoids QACC spikes).
  target_lift = float(max(0.15, 0.85 * span[2]))
  shake_amp = float(np.clip(0.25 * max_dim, 0.025, 0.08))
  kp_jaw = float(max(180.0, 25.0 * total_mass_kg * 9.81 / overdrive))
  kp_lift = float(max(900.0, 180.0 * total_mass_kg * 9.81 / target_lift))
  kp_shake = float(max(500.0, 120.0 * total_mass_kg * 9.81 / shake_amp))

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    fl = wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    fl.condim = 6
    fl.friction = [0.6, 0.01, 0.001]

    carriage = wb.add_body(
        name="scenario_gripper",
        pos=[
            float(0.5 * (bmin[0] + bmax[0])),
            float(0.5 * (bmin[1] + bmax[1])),
            palm_z,
        ],
        quat=[1, 0, 0, 0] if grasp_along_x else [0.7071068, 0, 0, 0.7071068],
    )
    carriage.add_joint(
        name="scenario_lift",
        type=mujoco.mjtJoint.mjJNT_SLIDE,
        axis=[0, 0, 1],
        range=[-0.05, target_lift * 1.5],
        damping=max(80.0, 0.08 * kp_lift),
        armature=max(2.0, 0.0008 * kp_lift),
    )
    carriage.add_joint(
        name="scenario_shake",
        type=mujoco.mjtJoint.mjJNT_SLIDE,
        axis=[0, 1, 0],
        range=[-shake_amp * 2.0, shake_amp * 2.0],
        damping=max(40.0, 0.06 * kp_shake),
        armature=max(1.0, 0.0008 * kp_shake),
    )
    carriage.add_geom(
        name="scenario_palm",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=[open_half_gap + 0.015, pad_half_depth, palm_thk],
        mass=max(0.8, 0.5 * total_mass_kg),
        rgba=[0.22, 0.26, 0.34, 1.0],
    )

    strut_thk = max(0.008, 0.025 * max_dim)
    pad_thk = max(0.004, 0.015 * max_dim)
    for side, sgn in (("left", -1.0), ("right", 1.0)):
      fbody = carriage.add_body(
          name=f"scenario_{side}_finger",
          pos=[sgn * open_half_gap, 0, -(palm_thk + pad_half_height)],
      )
      fbody.add_joint(
          name=f"scenario_{side}_slide",
          type=mujoco.mjtJoint.mjJNT_SLIDE,
          axis=[-sgn, 0, 0],
          range=[0.0, max_close],
          damping=max(25.0, 0.05 * kp_jaw),
          armature=max(0.5, 0.0008 * kp_jaw),
      )
      fbody.add_geom(
          name=f"scenario_{side}_strut",
          type=mujoco.mjtGeom.mjGEOM_BOX,
          size=[strut_thk, pad_half_depth, pad_half_height],
          mass=max(0.15, 0.1 * total_mass_kg),
          rgba=[0.35, 0.42, 0.54, 1.0],
      )
      pad = fbody.add_geom(
          name=f"scenario_{side}_pad",
          type=mujoco.mjtGeom.mjGEOM_BOX,
          pos=[-sgn * (strut_thk + pad_thk * 0.5), 0, 0],
          size=[pad_thk, pad_half_depth * 0.9, pad_half_height * 0.9],
          mass=max(0.04, 0.04 * total_mass_kg),
          rgba=[0.16, 0.78, 0.56, 1.0],
      )
      pad.condim = 6
      pad.friction = [1.5, 0.02, 0.002]
      pad.solref = [0.004, 1.0]
      pad.solimp = [0.95, 0.99, 0.001, 0.5, 2.0]

    for jname, kp in (
        ("scenario_left_slide", kp_jaw),
        ("scenario_right_slide", kp_jaw),
        ("scenario_lift", kp_lift),
        ("scenario_shake", kp_shake),
    ):
      act = parent_spec.add_actuator(
          name=f"act_{jname}",
          target=jname,
          trntype=mujoco.mjtTrn.mjTRN_JOINT,
      )
      act.gainprm[0] = kp
      act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
      act.biasprm[1] = -kp
      act.biasprm[2] = -0.1 * kp

    carrier = wb.add_body(name="carrier", pos=[0, 0, 0.002 - bmin[2]])
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

  model, data = build_attached_scene_model(xml_path, _setup)
  carrier_id = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier"
  )

  for _ in range(125):
    data.ctrl[:] = [0.0, 0.0, 0.0, 0.0]
    mujoco.mj_step(model, data)

  for step in range(200):
    close_cmd = max_close * min(1.0, (step + 1) / 140.0)
    data.ctrl[0] = close_cmd
    data.ctrl[1] = close_cmd
    data.ctrl[2] = 0.0
    data.ctrl[3] = 0.0
    mujoco.mj_step(model, data)

  z_before_lift = float(data.xpos[carrier_id, 2])
  wrist_z_before = float(data.qpos[0])

  for step in range(300):
    lift_cmd = target_lift * min(1.0, (step + 1) / 200.0)
    data.ctrl[0] = max_close
    data.ctrl[1] = max_close
    data.ctrl[2] = lift_cmd
    data.ctrl[3] = 0.0
    mujoco.mj_step(model, data)

  z_after_lift = float(data.xpos[carrier_id, 2])
  wrist_z_after = float(data.qpos[0])
  actual_wrist_lift = wrist_z_after - wrist_z_before
  actual_obj_lift = z_after_lift - z_before_lift
  lift_slip_mm = (actual_wrist_lift - actual_obj_lift) * 1000.0

  hoist_img = render_scene_frame(
      model,
      data,
      lookat=[
          float(0.5 * (bmin[0] + bmax[0])),
          float(0.5 * (bmin[1] + bmax[1])),
          float(z_after_lift + 0.2 * span[2]),
      ],
      distance=max(max_dim * 2.8, 0.28),
      elevation=-15.0,
      azimuth=135.0,
      show_col_overlay=False,
  )

  for step in range(375):
    t = step * model.opt.timestep
    shake_cmd = shake_amp * math.sin(2.0 * math.pi * 3.0 * t)
    data.ctrl[0] = max_close
    data.ctrl[1] = max_close
    data.ctrl[2] = target_lift
    data.ctrl[3] = shake_cmd
    mujoco.mj_step(model, data)

  z_after_shake = float(data.xpos[carrier_id, 2])
  wrist_z_after_shake = float(data.qpos[0])
  grasp_retained = (z_after_shake - z_before_lift) > (0.45 * target_lift)
  shake_slip_mm = (
      (wrist_z_after_shake - wrist_z_after) - (z_after_shake - z_after_lift)
  ) * 1000.0

  status = "INFO"
  issues = []

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Diagnostic telemetry: Gripper pads auto-scale to object size &"
              " CoM height. Inspect grasp_retained, lift_slip_mm, and"
              " shake_slip_mm in context."
          ),
          "grasp_axis": "X" if grasp_along_x else "Y",
          "grasp_span_cm": round(grasp_width * 100.0, 2),
          "exceeds_standard_16cm_gripper": grasp_width > 0.16,
          "hoist_height_cm": round(actual_obj_lift * 100.0, 2),
          "lift_slip_mm": round(lift_slip_mm, 2),
          "shake_slip_mm": round(shake_slip_mm, 2),
          "grasp_retained": grasp_retained,
      },
      hoist_img,
  )


# ---------------------------------------------------------------------------
# Scenario 6: Articulation Full-Range Sweep, Open/Close Polarity & Pinch
# ---------------------------------------------------------------------------
def run_scenario_6_articulation_sweep(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Sweeps any hinge/slide joints, identifies OPEN vs CLOSED limit, and checks self-collision."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))

  standalone = mujoco.MjModel.from_xml_path(xml_path)
  s_data = mujoco.MjData(standalone)
  mujoco.mj_forward(standalone, s_data)

  joint_reports = []
  issues: list[str] = []
  for jid in range(standalone.njnt):
    jtype = int(standalone.jnt_type[jid])
    if jtype not in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE):
      continue
    jname = (
        mujoco.mj_id2name(standalone, int(mujoco.mjtObj.mjOBJ_JOINT), jid)
        or f"joint_{jid}"
    )
    qadr = int(standalone.jnt_qposadr[jid])
    dadr = int(standalone.jnt_dofadr[jid])
    rmin, rmax = float(standalone.jnt_range[jid, 0]), float(
        standalone.jnt_range[jid, 1]
    )
    child_bid = int(standalone.jnt_bodyid[jid])
    parent_bid = int(standalone.body_parentid[child_bid])

    # Measure mean vertex distance between child geoms and parent/other geoms
    # at rmin vs rmax.
    child_gids = [
        g
        for g in range(standalone.ngeom)
        if int(standalone.geom_bodyid[g]) == child_bid
    ]
    other_gids = [
        g
        for g in range(standalone.ngeom)
        if int(standalone.geom_bodyid[g]) != child_bid
        and int(standalone.geom_bodyid[g]) > 0
    ]

    def _measure_pose(
        q_val: float,
        q_adr: int = qadr,
        c_gids: Sequence[int] = child_gids,
        o_gids: Sequence[int] = other_gids,
        c_bid: int = child_bid,
        p_bid: int = parent_bid,
    ) -> tuple[float, int]:
      mujoco.mj_resetData(standalone, s_data)
      s_data.qpos[q_adr] = q_val
      mujoco.mj_forward(standalone, s_data)
      if c_gids and o_gids:
        c_pts = compute_geom_vertices_world(standalone, s_data, c_gids)
        o_pts = compute_geom_vertices_world(standalone, s_data, o_gids)
        sep = float(np.linalg.norm(c_pts.mean(axis=0) - o_pts.mean(axis=0)))
      else:
        sep = float(np.linalg.norm(s_data.xpos[c_bid] - s_data.xpos[p_bid]))
      return sep, int(s_data.ncon)

    sep_min, ncon_min = _measure_pose(rmin)
    sep_max, ncon_max = _measure_pose(rmax)
    closes_at = "rmax" if sep_max < sep_min else "rmin"
    opens_at = "rmin" if closes_at == "rmax" else "rmax"

    # Dynamic mid-stroke gravity-hold test (0.5 s under gravity from q_mid)
    q_mid = 0.5 * (rmin + rmax)
    mujoco.mj_resetData(standalone, s_data)
    s_data.qpos[qadr] = q_mid
    mujoco.mj_forward(standalone, s_data)
    grav_load = float(abs(s_data.qfrc_bias[dadr]))
    stiffness = float(standalone.jnt_stiffness[jid])
    frictionloss = float(standalone.dof_frictionloss[dadr])
    for _ in range(250):
      mujoco.mj_step(standalone, s_data)
    q_after_grav = float(s_data.qpos[qadr])
    grav_drift = abs(q_after_grav - q_mid)
    span_q = max(abs(rmax - rmin), 1e-6)
    grav_drift_pct = 100.0 * grav_drift / span_q
    holds_gravity = bool(grav_drift_pct <= 10.0 or grav_load <= 0.05)

    if stiffness == 0.0 and grav_load > 0.05 and grav_drift_pct > 10.0:
      unit_f = "N" if jtype == mujoco.mjtJoint.mjJNT_SLIDE else "N*m"
      issues.append(
          f"Joint '{jname}' sagged by {grav_drift:.4f} ({grav_drift_pct:.1f}%"
          f" of range) under gravity in 0.5s (gravity_load={grav_load:.2f}"
          f" {unit_f} > frictionloss={frictionloss:.2f} {unit_f}); set"
          f" frictionloss >= {grav_load * 1.25:.1f} with"
          " solreffriction='0.004 1' if it should hold its position."
      )

    joint_reports.append({
        "joint_id": jid,
        "joint_name": jname,
        "type": "hinge" if jtype == mujoco.mjtJoint.mjJNT_HINGE else "slide",
        "parent_body_id": parent_bid,
        "child_body_id": child_bid,
        "range": [round(rmin, 4), round(rmax, 4)],
        "closes_at_limit": (
            f"{closes_at} ({rmax if closes_at == 'rmax' else rmin:+.3f})"
        ),
        "opens_at_limit": (
            f"{opens_at} ({rmin if opens_at == 'rmin' else rmax:+.3f})"
        ),
        "link_sep_at_rmin_cm": round(sep_min * 100.0, 2),
        "link_sep_at_rmax_cm": round(sep_max * 100.0, 2),
        "internal_contacts_at_limits": [ncon_min, ncon_max],
        "gravity_load_at_mid": round(grav_load, 3),
        "frictionloss": round(frictionloss, 3),
        "stiffness": round(stiffness, 3),
        "mid_pose_gravity_drift_pct": round(grav_drift_pct, 2),
        "holds_against_gravity": holds_gravity,
    })

  # Check for redundant uncoupled sibling hinges on a lightweight pivot body
  # (e.g. tongs/scissors).
  mujoco.mj_resetData(standalone, s_data)
  mujoco.mj_forward(standalone, s_data)
  hinge_reports = [jr for jr in joint_reports if jr["type"] == "hinge"]
  if len(hinge_reports) >= 2 and standalone.neq == 0:
    for idx_a in range(len(hinge_reports)):
      for idx_b in range(idx_a + 1, len(hinge_reports)):
        ja = hinge_reports[idx_a]
        jb = hinge_reports[idx_b]
        if ja["parent_body_id"] == jb["parent_body_id"]:
          p_bid = int(ja["parent_body_id"])
          jid_a, jid_b = int(ja["joint_id"]), int(jb["joint_id"])
          ax_a = (
              s_data.xazing[jid_a]
              if hasattr(s_data, "xazing")
              else s_data.xaxis[jid_a]
          )
          ax_b = (
              s_data.xazing[jid_b]
              if hasattr(s_data, "xazing")
              else s_data.xaxis[jid_b]
          )
          anch_a = s_data.xanchor[jid_a]
          anch_b = s_data.xanchor[jid_b]
          axis_cos = abs(float(np.dot(ax_a, ax_b)))
          anchor_dist = float(np.linalg.norm(anch_a - anch_b))
          parent_mass = float(standalone.body_mass[p_bid])
          child_max_mass = max(
              float(standalone.body_mass[int(ja["child_body_id"])]),
              float(standalone.body_mass[int(jb["child_body_id"])]),
          )
          if (
              axis_cos > 0.92
              and anchor_dist < 0.04
              and parent_mass < 1.2 * child_max_mass
          ):
            issues.append(
                f"Uncoupled colocated sibling hinges ('{ja['joint_name']}',"
                f" '{jb['joint_name']}') on pivot body"
                f" (mass={parent_mass*1000:.1f}g vs"
                f" arm={child_max_mass*1000:.1f}g) with neq=0 leave the pivot"
                " body underconstrained/floppy; merge one arm into the root"
                " body for a single 1-DoF hinge or couple via"
                " <equality><joint>."
            )

  # Render on skybox floor after stepping 0.3 s under gravity from mid-open pose
  def _setup_art(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    c = wb.add_body(name="carrier", pos=[0, 0, max(0.002 - bmin[2], 0.0)])
    _attach_all_child_bodies(c, child_spec, "obj_")

  m_art, d_art = build_attached_scene_model(xml_path, _setup_art)
  if joint_reports:
    for jid in range(m_art.njnt):
      jtype = int(m_art.jnt_type[jid])
      if jtype in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE):
        qadr = int(m_art.jnt_qposadr[jid])
        rmin, rmax = m_art.jnt_range[jid]
        d_art.qpos[qadr] = float(0.5 * (rmin + rmax))
    mujoco.mj_forward(m_art, d_art)
    for _ in range(150):
      mujoco.mj_step(m_art, d_art)

  center = 0.5 * (bmin + bmax)
  img = render_scene_frame(
      m_art,
      d_art,
      lookat=[
          float(center[0]),
          float(center[1]),
          float(max(center[2] - bmin[2], 0.025)),
      ],
      distance=max(max_dim * 2.1, 0.14),
      elevation=-24.0,
      azimuth=135.0,
      show_col_overlay=True,
  )

  status = "INFO" if not joint_reports else ("CHECK" if issues else "PASS")
  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "If articulated joints exist, check closes_at_limit vs"
              " opens_at_limit polarity, verify minimal degrees of freedom"
              " (no uncoupled floppy pivot links), verify"
              " internal_contacts_at_limits do not block motion, and verify"
              " position-holding joints (height slides, friction hinges)"
              " satisfy frictionloss > gravity_load_at_mid so they do not sag"
              " under gravity."
          ),
          "num_articulated_joints": len(joint_reports),
          "joints": joint_reports,
      },
      img,
  )


# ---------------------------------------------------------------------------
# Scenario 7: Cliff-Ledge Overhang Slide (Horizontal CoM & Tip-Off Audit)
# ---------------------------------------------------------------------------
def run_scenario_7_cliff_ledge_overhang(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Slowly slides the asset over a sharp cliff edge to measure critical tip-off overhang %."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  sx, sy, sz = float(span[0]), float(span[1]), float(span[2])
  max_dim = float(np.max(span))
  total_mass_kg = max(float(base_info["total_mass_g"]) * 1e-3, 0.005)

  mid_xy = 0.5 * (bmin[:2] + bmax[:2])
  mid_x, mid_y = float(mid_xy[0]), float(mid_xy[1])
  ledge_hx = max(sx * 1.4, 0.12)
  ledge_hy = max(sy * 1.4, 0.12)
  ledge_hz = max(sz * 0.45, 0.04)
  # Cliff edge is at x = 0.0 (ledge spans x in [-2*ledge_hx, 0.0])
  start_center_x = -0.55 * sx
  carrier_x0 = start_center_x - mid_x
  carrier_y0 = -mid_y
  max_push_dist = 0.85 * sx
  kp_push = max(800.0, 200.0 * total_mass_kg * 9.81 / max(sx, 0.05))

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    ledge = wb.add_geom(
        name="scenario_cliff_ledge",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[-ledge_hx, 0.0, ledge_hz],
        size=[ledge_hx, ledge_hy, ledge_hz],
        rgba=[0.28, 0.35, 0.46, 1.0],
    )
    ledge.condim = 6
    ledge.friction = [0.55, 0.01, 0.001]

    # Low base bumper behind the asset (-X side) so tall objects can tip
    # forward over the cliff edge without leaning their upper back against a
    # full-height pusher wall.
    pusher_x0 = carrier_x0 + bmin[0] - 0.010
    pusher_hh = min(max(sz * 0.12, 0.006), 0.018)
    pusher = wb.add_body(
        name="scenario_pusher",
        pos=[pusher_x0, 0.0, 2.0 * ledge_hz + pusher_hh + 0.002],
    )
    pusher.add_joint(
        name="scenario_push_slide",
        type=mujoco.mjtJoint.mjJNT_SLIDE,
        axis=[1, 0, 0],
        range=[0.0, max_push_dist],
        damping=max(30.0, 0.05 * kp_push),
        armature=max(1.0, 0.0008 * kp_push),
    )
    pg = pusher.add_geom(
        name="scenario_pusher_plate",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=[0.005, max(sy * 0.6, 0.03), pusher_hh],
        rgba=[0.90, 0.50, 0.18, 0.85],
    )
    pg.friction = [0.1, 0.005, 0.001]

    act = parent_spec.add_actuator(
        name="act_push",
        target="scenario_push_slide",
        trntype=mujoco.mjtTrn.mjTRN_JOINT,
    )
    act.gainprm[0] = kp_push
    act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
    act.biasprm[1] = -kp_push
    act.biasprm[2] = -0.1 * kp_push

    carrier = wb.add_body(
        name="carrier",
        pos=[carrier_x0, carrier_y0, 2.0 * ledge_hz - bmin[2] + 0.002],
    )
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

  model, data = build_attached_scene_model(xml_path, _setup)
  vis_ids, _ = classify_asset_geoms(model, "obj_")
  carrier_id = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier"
  )

  for _ in range(100):
    data.ctrl[0] = 0.0
    mujoco.mj_step(model, data)

  c_mat0 = np.array(data.xmat[carrier_id], dtype=np.float64).reshape(3, 3)
  up0 = c_mat0[:, 2].copy()

  tip_overhang_pct = None
  snap_img = None
  total_steps = 700
  for step in range(total_steps):
    data.ctrl[0] = max_push_dist * (step / total_steps)
    mujoco.mj_step(model, data)

    v_pts = compute_geom_vertices_world(model, data, vis_ids)
    max_x = float(np.max(v_pts[:, 0]))
    overhang_pct = float(np.clip((max_x / max(sx, 1e-4)) * 100.0, 0.0, 100.0))

    c_mat = np.array(data.xmat[carrier_id], dtype=np.float64).reshape(3, 3)
    tilt_deg = math.degrees(
        math.acos(np.clip(float(np.dot(c_mat[:, 2], up0)), -1.0, 1.0))
    )

    if tip_overhang_pct is None and tilt_deg > 18.0:
      tip_overhang_pct = round(overhang_pct, 1)
      snap_img = render_scene_frame(
          model,
          data,
          lookat=[0.0, 0.0, 2.0 * ledge_hz + 0.42 * sz],
          distance=max(max_dim * 3.1, 0.24),
          elevation=-18.0,
          azimuth=120.0,
          show_col_overlay=False,
      )

  if snap_img is None:
    snap_img = render_scene_frame(
        model,
        data,
        lookat=[0.0, 0.0, 2.0 * ledge_hz + 0.42 * sz],
        distance=max(max_dim * 3.1, 0.24),
        elevation=-18.0,
        azimuth=120.0,
        show_col_overlay=False,
    )

  expected_com_overhang_pct = round(
      float(
          (bmax[0] - base_info.get("com_local_m", [0, 0, 0])[0])
          / max(sx, 1e-4)
          * 100.0
      ),
      1,
  )
  status = "INFO"
  issues = []

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Diagnostic telemetry: Flat-bottomed box-like objects tip near"
              " ~50% overhang; chamfered-base bottles may hook the pusher rim,"
              " and spheres/cylinders roll off early (~10%). Check"
              " com_local_m directly for horizontal CoM symmetry."
          ),
          "tip_overhang_pct": (
              tip_overhang_pct if tip_overhang_pct is not None else ">75.0"
          ),
          "expected_com_overhang_pct": expected_com_overhang_pct,
      },
      snap_img,
  )


# ---------------------------------------------------------------------------
# Scenario 8: Twin Self-Stack & Table Nudge (Top-Surface & Multi-Body Check)
# ---------------------------------------------------------------------------
def run_scenario_8_twin_self_stack(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Stacks a second copy of the asset on top of the first and nudges the table."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  sx, sy, sz = float(span[0]), float(span[1]), float(span[2])
  max_dim = float(np.max(span))
  total_mass_kg = max(float(base_info["total_mass_g"]) * 1e-3, 0.005)

  table_hx = max(sx * 1.6, 0.15)
  table_hy = max(sy * 1.6, 0.15)
  table_hz = 0.012
  nudge_amp = float(np.clip(0.08 * min(sx, sy), 0.004, 0.015))
  kp_table = max(2000.0, 400.0 * total_mass_kg * 9.81 / nudge_amp)

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    child_spec2 = mujoco.MjSpec.from_file(xml_path)
    child_spec2.compiler.autolimits = True

    wb = parent_spec.worldbody
    wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    table = wb.add_body(name="scenario_stack_table", pos=[0, 0, table_hz])
    table.add_joint(
        name="scenario_table_nudge",
        type=mujoco.mjtJoint.mjJNT_SLIDE,
        axis=[1, 0, 0],
        range=[-0.05, 0.05],
        damping=max(60.0, 0.05 * kp_table),
        armature=max(2.0, 0.0008 * kp_table),
    )
    tg = table.add_geom(
        name="scenario_table_geom",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=[table_hx, table_hy, table_hz],
        rgba=[0.26, 0.34, 0.45, 1.0],
    )
    tg.condim = 6
    tg.friction = [0.75, 0.01, 0.002]

    act = parent_spec.add_actuator(
        name="act_nudge",
        target="scenario_table_nudge",
        trntype=mujoco.mjtTrn.mjTRN_JOINT,
    )
    act.gainprm[0] = kp_table
    act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
    act.biasprm[1] = -kp_table
    act.biasprm[2] = -0.1 * kp_table

    mid_xy = 0.5 * (bmin[:2] + bmax[:2])
    mid_x, mid_y = float(mid_xy[0]), float(mid_xy[1])
    z1 = 2.0 * table_hz - bmin[2] + 0.002
    c1 = wb.add_body(name="carrier_bottom", pos=[-mid_x, -mid_y, z1])
    c1.add_freejoint(name="bottom_free")
    _attach_all_child_bodies(c1, child_spec, "bot_")

    z2 = 2.0 * table_hz + sz - bmin[2] + 0.006
    c2 = wb.add_body(name="carrier_top", pos=[-mid_x, -mid_y, z2])
    c2.add_freejoint(name="top_free")
    _attach_all_child_bodies(c2, child_spec2, "top_")

  model, data = build_attached_scene_model(xml_path, _setup)
  bot_id = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier_bottom"
  )
  top_id = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier_top"
  )

  # Settle stack for 250 steps
  for _ in range(250):
    data.ctrl[0] = 0.0
    mujoco.mj_step(model, data)

  dz_settled = float(data.xpos[top_id, 2] - data.xpos[bot_id, 2])
  settled_on_top = dz_settled > 0.55 * sz

  # Gentle sinusoidal table nudge for 250 steps
  for step in range(250):
    t = step * model.opt.timestep
    data.ctrl[0] = nudge_amp * math.sin(2.0 * math.pi * 2.5 * t)
    mujoco.mj_step(model, data)

  dz_after_nudge = float(data.xpos[top_id, 2] - data.xpos[bot_id, 2])
  retained_after_nudge = dz_after_nudge > 0.55 * sz

  img = render_scene_frame(
      model,
      data,
      lookat=[0.0, 0.0, 2.0 * table_hz + 0.95 * sz],
      distance=max((2.0 * sz + 2.0 * table_hz) * 1.75, max_dim * 3.3, 0.24),
      elevation=-18.0,
      azimuth=130.0,
      show_col_overlay=False,
  )

  return (
      {
          "status": "PASS" if settled_on_top else "INFO",
          "issues": [],
          "agent_note": (
              "Flat-topped objects (boxes, closed lunchboxes, coasters, books) "
              "should stack stably; curved/spherical/open-topped objects "
              "naturally roll or nest off each other."
          ),
          "stacked_stably_static": settled_on_top,
          "retained_after_table_nudge": retained_after_nudge,
          "vertical_separation_ratio_z_over_sz": round(
              dz_settled / max(sz, 1e-4), 3
          ),
      },
      img,
  )


# ---------------------------------------------------------------------------
# Scenario 9: Calibrated Pendulum Impact & Support `<site>` Spawn Verification
# ---------------------------------------------------------------------------
def run_scenario_9_impact_and_sites(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Strikes asset with a calibrated sphere to test recoil/bounce, and tests <site> tags."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  _, sy, sz = float(span[0]), float(span[1]), float(span[2])
  max_dim = float(np.max(span))
  total_mass_kg = max(float(base_info["total_mass_g"]) * 1e-3, 0.005)

  # 1) Inspect <site> elements in standalone model
  standalone = mujoco.MjModel.from_xml_path(xml_path)
  s_data = mujoco.MjData(standalone)
  mujoco.mj_forward(standalone, s_data)
  grp_col = np.array([0, 0, 0, 1, 0, 0], dtype=np.uint8)

  site_reports = []
  site_issues = []
  for sid in range(standalone.nsite):
    sname = (
        mujoco.mj_id2name(standalone, int(mujoco.mjtObj.mjOBJ_SITE), sid)
        or f"site_{sid}"
    )
    sgrp = int(standalone.site_group[sid])
    spos = np.array(s_data.site_xpos[sid], dtype=np.float64)
    # Raycast down from spos + 5cm against collision geoms to check support z
    p_start = np.array([spos[0], spos[1], spos[2] + 0.05], dtype=np.float64)
    gc = np.array([-1], dtype=np.int32)
    dc = mujoco.mj_ray(
        standalone,
        s_data,
        p_start,
        np.array([0.0, 0.0, -1.0]),
        grp_col,
        1,
        -1,
        gc,
    )
    col_z_under_site = (p_start[2] - dc) if dc > 0 else None
    site_offset_mm = (
        round((spos[2] - col_z_under_site) * 1000.0, 2)
        if col_z_under_site is not None
        else None
    )
    if sgrp == 3:
      site_issues.append(f"Site '{sname}' is in group=3 (should be group=4).")
    if spos[2] < float(bmin[2]) - 0.0005:
      site_issues.append(
          f"Site '{sname}' z={spos[2]*1000:.1f}mm is below object bottom"
          f" ({bmin[2]*1000:.1f}mm)."
      )
    site_reports.append({
        "site_name": sname,
        "group": sgrp,
        "pos_m": [round(float(x), 4) for x in spos],
        "height_above_col_surface_mm": site_offset_mm,
    })

  # 2) Volume-scaled striker impact test
  # (striker mass = 0.5 g/cm^3 * V_hull, speed ~ sqrt(g * L))
  mid_xy = 0.5 * (bmin[:2] + bmax[:2])
  mid_x, mid_y = float(mid_xy[0]), float(mid_xy[1])
  striker_mass = float(
      max(0.5 * float(base_info["total_hull_vol_cm3"]) * 1e-3, 0.005)
  )
  striker_r = float(max(0.28 * min(sy, sz), 0.006))
  strike_z = float(
      np.clip(0.45 * sz, striker_r + 0.002, max(sz - 0.005, striker_r + 0.003))
  )
  standoff = max(0.35 * max_dim, 0.03)

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    fl = wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    fl.condim = 6
    fl.friction = [0.55, 0.01, 0.001]

    carrier = wb.add_body(name="carrier", pos=[0, 0, 0.002 - bmin[2]])
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

    striker = wb.add_body(
        name="scenario_striker",
        pos=[bmin[0] - striker_r - standoff, mid_y, strike_z],
    )
    striker.add_freejoint(name="striker_free")
    sg = striker.add_geom(
        name="scenario_striker_geom",
        type=mujoco.mjtGeom.mjGEOM_SPHERE,
        size=[striker_r, 0, 0],
        mass=striker_mass,
        rgba=[0.92, 0.28, 0.22, 1.0],
    )
    sg.condim = 6
    sg.friction = [0.2, 0.005, 0.001]

  model, data = build_attached_scene_model(xml_path, _setup)
  carrier_id = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_BODY), "carrier"
  )
  striker_jid = mujoco.mj_name2id(
      model, int(mujoco.mjtObj.mjOBJ_JOINT), "striker_free"
  )
  s_dof = int(model.jnt_dofadr[striker_jid])

  for _ in range(80):
    mujoco.mj_step(model, data)
  x0 = float(data.xpos[carrier_id, 0])

  # Froude-scaled striker velocity v0 ~ 1.5 * sqrt(g * max_dim)
  v0_striker = float(np.clip(1.5 * math.sqrt(9.81 * max_dim), 0.45, 2.50))
  data.qvel[s_dof] = v0_striker

  peak_obj_vx = 0.0
  snap_img = None
  snap_step = max(40, int((standoff / v0_striker) / 0.002) + 25)
  for step in range(max(350, snap_step + 150)):
    data.qvel[s_dof + 2] = 0.0  # Keep striker level before impact
    mujoco.mj_step(model, data)
    vx_obj = float(data.qvel[0])
    peak_obj_vx = max(peak_obj_vx, vx_obj)
    if step == snap_step:
      snap_img = render_scene_frame(
          model,
          data,
          lookat=[
              float(mid_x + 0.5 * data.xpos[carrier_id, 0]),
              mid_y,
              float(0.5 * sz),
          ],
          distance=max(max_dim * 2.6, 0.20),
          elevation=-20.0,
          azimuth=125.0,
          show_col_overlay=False,
          show_sites=True,
      )

  slide_cm = float((data.xpos[carrier_id, 0] - x0) * 100.0)
  v_inelastic_ref = (striker_mass / (striker_mass + total_mass_kg)) * v0_striker

  status = "FAIL" if site_issues else "INFO"

  return (
      {
          "status": status,
          "issues": site_issues,
          "agent_note": (
              "Striker mass scales with object hull volume (0.5 g/cm3 * V_hull)"
              " and strike speed scales with sqrt(g * L), exposing 10x"
              " mass/density outliers. Also verifies <site> groups (group=4)"
              " and Z-heights."
          ),
          "striker_mass_g": round(striker_mass * 1000.0, 1),
          "striker_speed_m_s": round(v0_striker, 2),
          "peak_object_vx_m_s": round(peak_obj_vx, 3),
          "inelastic_ref_vx_m_s": round(v_inelastic_ref, 3),
          "post_impact_slide_cm": round(slide_cm, 2),
          "num_sites": len(site_reports),
          "sites": site_reports,
      },
      snap_img,
  )


# ---------------------------------------------------------------------------
# Scenario 10: Scaled High-Speed (6x Size) Drop onto Scaled Thin Slab
# ---------------------------------------------------------------------------
def run_scenario_10_high_speed_thin_slab_drop(
    xml_path: str, base_info: dict[str, Any]
) -> tuple[dict[str, Any], Image.Image]:
  """Drops asset from 6x its size onto a scaled thin slab (15% min_dim) to check tunneling, penetration & bounce."""
  bmin = np.array(base_info["vis_min"], dtype=np.float64)
  bmax = np.array(base_info["vis_max"], dtype=np.float64)
  span = bmax - bmin
  max_dim = float(np.max(span))
  min_dim = float(np.min(span))

  # Scale drop height (default 6x max_dim), thin-slab thickness (20% min_dim,
  # >= 2.5x single-step travel at dt=2ms), and suspension height.
  thresh = base_info.get("thresholds", DEFAULT_THRESHOLDS)
  drop_scale = float(thresh.get("high_speed_drop_scale", 6.0))
  slab_ratio = float(thresh.get("thin_slab_min_dim_ratio", 0.20))
  drop_height = float(np.clip(drop_scale * max_dim, 0.20, 2.50))
  v_impact = math.sqrt(2.0 * 9.81 * drop_height)
  min_discrete_slab_thk = max(0.008, 2.5 * v_impact * 0.002)
  slab_thk = float(np.clip(slab_ratio * min_dim, min_discrete_slab_thk, 0.035))
  slab_half_thk = 0.5 * slab_thk
  slab_z_top = float(max(1.2 * max_dim, 0.15))
  slab_hx = max(max_dim * 2.0, 0.16)
  slab_hy = max(max_dim * 2.0, 0.16)

  mid_xy = 0.5 * (bmin[:2] + bmax[:2])
  mid_x, mid_y = float(mid_xy[0]), float(mid_xy[1])

  def _setup(parent_spec: mujoco.MjSpec, child_spec: mujoco.MjSpec) -> None:
    wb = parent_spec.worldbody
    wb.add_geom(
        name="scenario_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.05],
        material="scenario_floor_mat",
    )
    slab = wb.add_geom(
        name="scenario_thin_slab",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[mid_x, mid_y, slab_z_top - slab_half_thk],
        size=[slab_hx, slab_hy, slab_half_thk],
        rgba=[0.24, 0.36, 0.50, 0.90],
    )
    slab.condim = 6
    slab.friction = [0.7, 0.01, 0.002]
    slab.solref = [0.004, 1.0]
    slab.solimp = [0.95, 0.99, 0.001, 0.5, 2.0]

    carrier = wb.add_body(
        name="carrier",
        pos=[0.0, 0.0, slab_z_top + drop_height - bmin[2]],
    )
    carrier.add_freejoint(name="carrier_free")
    _attach_all_child_bodies(carrier, child_spec, "obj_")

  model, data = build_attached_scene_model(xml_path, _setup)
  _, col_ids = classify_asset_geoms(model, "obj_")

  max_penetration_mm = 0.0
  min_col_z = slab_z_top + drop_height
  rebound_peak_z = slab_z_top
  touched_down = False
  rebounded = False
  snap_img = None
  impact_step_est = int(math.sqrt(2.0 * drop_height / 9.81) / 0.002)
  total_steps = impact_step_est + 250

  for step in range(total_steps):
    mujoco.mj_step(model, data)
    c_pts = compute_geom_vertices_world(model, data, col_ids)
    cur_min_z = float(np.min(c_pts[:, 2]))
    min_col_z = min(min_col_z, cur_min_z)

    if cur_min_z <= slab_z_top + 0.002:
      touched_down = True
      pen_mm = max(0.0, (slab_z_top - cur_min_z) * 1000.0)
      max_penetration_mm = max(max_penetration_mm, pen_mm)
    if touched_down and float(data.qvel[2]) > 0.05:
      rebounded = True
    if rebounded:
      rebound_peak_z = max(rebound_peak_z, cur_min_z)

    if touched_down and snap_img is None and step > impact_step_est + 8:
      snap_img = render_scene_frame(
          model,
          data,
          lookat=[mid_x, mid_y, slab_z_top + 0.5 * span[2]],
          distance=max(max_dim * 2.5, 0.18),
          elevation=-16.0,
          azimuth=135.0,
          show_col_overlay=True,
      )

  if snap_img is None:
    snap_img = render_scene_frame(
        model,
        data,
        lookat=[mid_x, mid_y, slab_z_top + 0.5 * span[2]],
        distance=max(max_dim * 2.5, 0.18),
        elevation=-16.0,
        azimuth=135.0,
        show_col_overlay=True,
    )

  c_pts_final = compute_geom_vertices_world(model, data, col_ids)
  final_min_z = float(np.min(c_pts_final[:, 2]))
  tunneled = final_min_z < (slab_z_top - slab_thk - 0.015)
  resting_penetration_mm = (
      max(0.0, (slab_z_top - final_min_z) * 1000.0)
      if not tunneled
      else max_penetration_mm
  )
  bounce_height_cm = max(0.0, (rebound_peak_z - slab_z_top) * 100.0)
  bounce_ratio = bounce_height_cm / (drop_height * 100.0)
  hover_tol_mm = float(thresh.get("hover_tol_mm", 2.0))

  status = "PASS"
  issues = []
  if tunneled:
    status = "FAIL"
    issues.append(
        f"Object tunneled through {slab_thk*1000:.1f} mm tabletop on"
        f" {drop_height:.2f} m (6x size) drop!"
    )
  elif resting_penetration_mm > hover_tol_mm + 1.5:
    status = "FAIL"
    issues.append(
        f"Resting post-impact penetration ({resting_penetration_mm:.1f} mm >"
        f" {hover_tol_mm+1.5:.1f} mm) on thin slab."
    )

  return (
      {
          "status": status,
          "issues": issues,
          "agent_note": (
              "Drops from 6x object max_dim onto a thin slab (20% of object"
              " min_dim) to test scale-invariant tunneling, contact"
              " penetration, and bounce ratio."
          ),
          "drop_height_cm": round(drop_height * 100.0, 1),
          "slab_thickness_mm": round(slab_thk * 1000.0, 1),
          "tunneled_through_thin_slab": tunneled,
          "max_penetration_mm": round(max_penetration_mm, 2),
          "resting_penetration_mm": round(resting_penetration_mm, 2),
          "rebound_height_cm": round(bounce_height_cm, 2),
          "bounce_ratio": round(bounce_ratio, 3),
      },
      snap_img,
  )


def _parse_selected_scenarios(
    scenarios_spec: str | Sequence[int] | None,
) -> list[int]:
  """Parses a scenario selector string or sequence into sorted IDs 1..10."""
  if scenarios_spec is None or scenarios_spec in ("all", ""):
    return list(range(1, 11))
  if isinstance(scenarios_spec, str):
    if scenarios_spec.strip().lower() == "all":
      return list(range(1, 11))
    out = []
    for part in scenarios_spec.split(","):
      part = part.strip()
      if part:
        idx = int(part)
        if 1 <= idx <= 10 and idx not in out:
          out.append(idx)
    return out or list(range(1, 11))
  return [int(x) for x in scenarios_spec if 1 <= int(x) <= 10] or list(
      range(1, 11)
  )


def validate_static_and_mesh_hygiene(xml_path: str) -> dict[str, Any]:
  """Checks static MJCF standards, PBR material rules, and .obj mesh/UV hygiene.

  Checks:
    1. Root <body> name matches modelname and has zero pos/quat offset.
    2. Visual geoms (group="2") have mass=0, density=0, contype=0,
    conaffinity=0.
    3. Every <material> with a <layer role="roughness"/> has scalar
       roughness="1.0" (and metallic="1.0" if <layer role="metallic"/> is used)
       to prevent Filament's r_eff = r_mat * r_tex double-multiplication trap.
    4. Exported visual .obj files use clean triangle or quad/tri topology (both
       triangulated CAD B-Rep meshes and quad/tri Blender meshes are valid;
       warns on >4-vertex N-gons) and have non-degenerate 2D UV coordinates
       (flags single-point UVs on textured meshes).

  Args:
    xml_path: Path to `model.xml`.

  Returns:
    Dict with `passed` (bool), `warnings` (list[str]), `errors` (list[str]),
    and `mesh_topology` (list[dict]).
  """
  errors: list[str] = []
  warnings: list[str] = []
  mesh_stats: list[dict[str, Any]] = []

  abs_xml = os.path.abspath(xml_path)
  xml_dir = os.path.dirname(abs_xml)
  spec = mujoco.MjSpec.from_file(abs_xml)
  m = mujoco.MjModel.from_xml_path(abs_xml)

  # 1. Root body check
  top_bodies = list(spec.worldbody.bodies)
  if len(top_bodies) == 1:
    root_b = top_bodies[0]
    if spec.modelname and root_b.name != spec.modelname:
      warnings.append(
          f"Root <body> name '{root_b.name}' does not match modelname"
          f" '{spec.modelname}'."
      )
    rpos = np.asarray(root_b.pos, dtype=float)
    if np.linalg.norm(rpos) > 1e-5:
      errors.append(
          f"Root <body> '{root_b.name}' has non-zero pos={rpos.tolist()}"
          " (must be [0, 0, 0] with resting base at z=0)."
      )

  # 2. PBR Material scalar-vs-texture multiplication check
  for mat in spec.materials:
    tex_roles = list(mat.textures)
    rough_role = int(mujoco.mjtTextureRole.mjTEXROLE_ROUGHNESS)
    metal_role = int(mujoco.mjtTextureRole.mjTEXROLE_METALLIC)
    orm_role = int(mujoco.mjtTextureRole.mjTEXROLE_ORM)
    has_rough_tex = (
        rough_role < len(tex_roles) and bool(tex_roles[rough_role])
    ) or (orm_role < len(tex_roles) and bool(tex_roles[orm_role]))
    has_metal_tex = (
        metal_role < len(tex_roles) and bool(tex_roles[metal_role])
    ) or (orm_role < len(tex_roles) and bool(tex_roles[orm_role]))
    if (
        has_rough_tex
        and float(mat.roughness) >= 0.0
        and abs(float(mat.roughness) - 1.0) > 0.05
    ):
      errors.append(
          f"<material name='{mat.name}'> attaches a roughness/ORM texture"
          f" layer but sets scalar roughness={mat.roughness:.2f} != 1.0."
          " Filament multiplies scalar roughness by the texture map!"
      )
    if (
        has_metal_tex
        and float(mat.metallic) >= 0.0
        and abs(float(mat.metallic) - 1.0) > 0.05
    ):
      errors.append(
          f"<material name='{mat.name}'> attaches a metallic/ORM texture"
          f" layer but sets scalar metallic={mat.metallic:.2f} != 1.0."
      )

  # 3. Visual geom mass=0 check
  vis_ids, _ = classify_asset_geoms(m)
  spec_geom_mass = {
      g.name: float(g.mass)
      for g in spec.geoms
      if g.name and g.mass is not None and not np.isnan(float(g.mass))
  }
  for gid in vis_ids:
    gname = mujoco.mj_id2name(m, int(mujoco.mjtObj.mjOBJ_GEOM), gid) or str(gid)
    gmass = spec_geom_mass.get(gname, 0.0)
    if int(m.geom_group[gid]) == 2 and gmass > 1e-6:
      warnings.append(
          f"Visual geom '{gname}' (group=2) has non-zero mass"
          f" ({gmass*1000:.2f} g). All mass belongs on group=3"
          " colliders."
      )

  # 4. Raw .obj topology & UV degeneracy check on visual meshes
  textured_mat_ids: set[int] = set()
  for mat in spec.materials:
    if any(bool(t) for t in list(mat.textures)):
      mid_mat = mujoco.mj_name2id(
          m, int(mujoco.mjtObj.mjOBJ_MATERIAL), mat.name
      )
      if mid_mat >= 0:
        textured_mat_ids.add(int(mid_mat))
  textured_vis_meshes: set[int] = {
      int(m.geom_dataid[gid])
      for gid in vis_ids
      if int(m.geom_type[gid]) == int(mujoco.mjtGeom.mjGEOM_MESH)
      and int(m.geom_dataid[gid]) >= 0
      and int(m.geom_matid[gid]) in textured_mat_ids
  }
  meshdir = spec.compiler.meshdir or ""
  vis_mesh_ids = {
      int(m.geom_dataid[gid])
      for gid in vis_ids
      if int(m.geom_type[gid]) == int(mujoco.mjtGeom.mjGEOM_MESH)
      and int(m.geom_dataid[gid]) >= 0
  }
  spec_meshes = {ms.name: ms for ms in spec.meshes if ms.name}
  for mid in sorted(vis_mesh_ids):
    mname = mujoco.mj_id2name(m, int(mujoco.mjtObj.mjOBJ_MESH), mid) or ""
    sm = spec_meshes.get(mname)
    if sm is None or not sm.file:
      continue
    obj_p = os.path.join(xml_dir, meshdir, sm.file)
    if not os.path.isfile(obj_p) or not obj_p.lower().endswith(".obj"):
      continue
    n_verts = 0
    n_tris = 0
    n_quads = 0
    n_ngons = 0
    uv_pts: list[tuple[float, float]] = []
    ref_uv_indices: list[int] = []
    with open(obj_p, "r", encoding="utf-8", errors="ignore") as f:
      for raw_line in f:
        line = raw_line.split("#", 1)[0].strip()
        if not line:
          continue
        parts = line.split()
        cmd = parts[0]
        if cmd == "v" and len(parts) >= 4:
          n_verts += 1
        elif cmd == "vt" and len(parts) >= 3:
          try:
            uv_pts.append((float(parts[1]), float(parts[2])))
          except ValueError:
            pass
        elif cmd == "f":
          tokens = parts[1:]
          deg = len(tokens)
          if deg == 3:
            n_tris += 1
          elif deg == 4:
            n_quads += 1
          elif deg > 4:
            n_ngons += 1
          n_vt_cur = len(uv_pts)
          for tok in tokens:
            inds = tok.split("/")
            if len(inds) > 1 and inds[1]:
              try:
                raw_ti = int(inds[1])
                ti = (n_vt_cur + raw_ti) if raw_ti < 0 else (raw_ti - 1)
                if 0 <= ti < n_vt_cur:
                  ref_uv_indices.append(ti)
              except ValueError:
                pass
    tot_faces = max(n_tris + n_quads + n_ngons, 1)
    quad_ratio = float(n_quads) / float(tot_faces)
    uv_span = 0.0
    if uv_pts:
      uv_all = np.asarray(uv_pts, dtype=np.float64)
      uv_arr = uv_all[sorted(set(ref_uv_indices))] if ref_uv_indices else uv_all
      uv_span = float(np.max(np.ptp(uv_arr, axis=0)))
    if n_ngons > 0:
      warnings.append(
          f"Visual mesh '{sm.file}' contains {n_ngons} >4-vertex N-gons."
          " Ear-clip >4-gons (`ngon_method='EAR_CLIP'` or"
          " `blender_mesh_utils.finalize_and_export_obj`) so MuJoCo's"
          " tinyobjloader never fan-bridges concave notches."
      )
    if uv_pts and uv_span < 1e-3:
      if mid in textured_vis_meshes:
        errors.append(
            f"Textured visual mesh '{sm.file}' has degenerate single-point UVs"
            f" (uv_span={uv_span:.5f}). Assign proper 2D UVs!"
        )
      else:
        warnings.append(
            f"Untextured visual mesh '{sm.file}' has single-point UVs"
            f" (uv_span={uv_span:.5f})."
        )
    mesh_stats.append({
        "mesh": mname,
        "file": sm.file,
        "verts": n_verts,
        "quads": n_quads,
        "tris": n_tris,
        "ngons": n_ngons,
        "quad_ratio": round(quad_ratio, 3),
        "uv_span": round(uv_span, 4),
    })

  return {
      "passed": len(errors) == 0,
      "errors": errors,
      "warnings": warnings,
      "mesh_topology": mesh_stats,
  }


def run_all_scenarios_for_asset(
    xml_path: str,
    out_dir: str,
    label: str = "",
    thresholds: dict[str, float] | None = None,
    scenarios: str | Sequence[int] | None = "all",
) -> dict[str, Any]:
  """Runs selected (or all 10) audit scenarios and writes JSON + PNG sheet."""
  os.makedirs(out_dir, exist_ok=True)
  active_thresholds = dict(DEFAULT_THRESHOLDS)
  if thresholds:
    active_thresholds.update({k: float(v) for k, v in thresholds.items()})
  selected_ids = _parse_selected_scenarios(scenarios)
  m = mujoco.MjModel.from_xml_path(xml_path)
  d = mujoco.MjData(m)
  mujoco.mj_forward(m, d)

  vis_ids, col_ids = classify_asset_geoms(m)
  vis_pts = compute_geom_vertices_world(m, d, vis_ids)
  col_pts = compute_geom_vertices_world(m, d, col_ids)
  vis_min = vis_pts.min(axis=0)
  vis_max = vis_pts.max(axis=0)
  col_min = col_pts.min(axis=0)
  col_max = col_pts.max(axis=0)
  total_mass_g = float(np.sum(m.body_mass[1:]) * 1000.0)

  # Compute composite world CoM of the asset
  masses = m.body_mass[1:]
  xipos = d.xipos[1:]
  com_world = (
      np.sum(xipos * masses[:, None], axis=0) / max(float(np.sum(masses)), 1e-9)
      if len(masses) > 0
      else np.zeros(3)
  )
  com_z_above_floor_m = float(com_world[2] - vis_min[2])

  # Compute per-hull volumes, density uniformity & maxhullvert truncation
  spec_for_mass = mujoco.MjSpec.from_file(xml_path)
  spec_geoms = list(spec_for_mass.geoms)
  spec_geoms_by_name = {sg.name: sg for sg in spec_geoms if sg.name}
  spec_meshes_by_name = {ms.name: ms for ms in spec_for_mass.meshes if ms.name}
  xml_dir = os.path.dirname(os.path.abspath(xml_path))
  meshdir = spec_for_mass.compiler.meshdir or ""
  hull_vols_cm3 = []
  hull_densities = []
  hull_z_vol_mass: list[tuple[float, float, float]] = []
  maxhullvert_truncated_geoms = []
  body_col_stats: dict[str, list[tuple[float, float]]] = {}
  per_geom_records: list[dict[str, Any]] = []
  for gid in col_ids:
    bid = int(m.geom_bodyid[gid])
    bname = (
        mujoco.mj_id2name(m, int(mujoco.mjtObj.mjOBJ_BODY), bid)
        or f"body_{bid}"
    )
    gname_lookup = (
        mujoco.mj_id2name(m, int(mujoco.mjtObj.mjOBJ_GEOM), gid) or ""
    )
    sgeom = spec_geoms_by_name.get(gname_lookup)
    if sgeom is None and len(spec_geoms) == m.ngeom and gid < len(spec_geoms):
      sgeom = spec_geoms[gid]
    raw_mass = (
        float(sgeom.mass)
        if (sgeom is not None and sgeom.mass is not None)
        else float("nan")
    )
    explicit_mass_g = (
        raw_mass * 1000.0
        if (math.isfinite(raw_mass) and raw_mass > 0.0)
        else None
    )
    raw_dens = (
        float(sgeom.density)
        if (sgeom is not None and sgeom.density is not None)
        else float("nan")
    )
    geom_density = (
        raw_dens if (math.isfinite(raw_dens) and raw_dens > 0.0) else None
    )
    gtype = int(m.geom_type[gid])
    size = m.geom_size[gid]
    vol_cm3 = 0.0
    aspect_ratio = 1.0
    if gtype == mujoco.mjtGeom.mjGEOM_MESH and m.geom_dataid[gid] >= 0:
      mid = int(m.geom_dataid[gid])
      vadr = int(m.mesh_vertadr[mid])
      vnum = int(m.mesh_vertnum[mid])
      if vnum >= 4:
        try:
          comp_verts = m.mesh_vert[vadr : vadr + vnum]
          ch = trimesh.convex.convex_hull(comp_verts)
          vol_cm3 = float(ch.volume * 1e6)
          ext = np.sort(np.asarray(ch.extents, dtype=np.float64))
          if ext[0] > 1e-6:
            aspect_ratio = float(ext[2] / ext[0])
          mname = mujoco.mj_id2name(m, int(mujoco.mjtObj.mjOBJ_MESH), mid) or ""
          smesh = spec_meshes_by_name.get(mname)
          if smesh is not None and smesh.file:
            obj_path = os.path.join(xml_dir, meshdir, smesh.file)
            if os.path.isfile(obj_path):
              raw_tm = trimesh.load(obj_path, force="mesh", process=True)
              scale_vec = np.array(smesh.scale, dtype=np.float64)
              if np.all(scale_vec > 0):
                raw_tm.vertices = raw_tm.vertices * scale_vec
              raw_ch = raw_tm.convex_hull
              raw_vnum = int(len(raw_ch.vertices))
              raw_vol_cm3 = float(raw_ch.volume * 1e6)
              if raw_vnum > vnum and (
                  raw_vnum > 64
                  or abs(raw_vol_cm3 - vol_cm3) / max(raw_vol_cm3, 1e-6) > 0.015
              ):
                gname = gname_lookup or f"geom_{gid}"
                maxhullvert_truncated_geoms.append({
                    "geom": gname,
                    "mesh": mname,
                    "raw_hull_verts": raw_vnum,
                    "compiled_verts": vnum,
                    "raw_vol_cm3": round(raw_vol_cm3, 2),
                    "compiled_vol_cm3": round(vol_cm3, 2),
                })
        except Exception:  # pylint: disable=broad-exception-caught
          vol_cm3 = 0.0
    elif gtype == mujoco.mjtGeom.mjGEOM_SPHERE:
      vol_cm3 = float((4.0 / 3.0) * math.pi * (size[0] ** 3) * 1e6)
    elif gtype == mujoco.mjtGeom.mjGEOM_CAPSULE:
      vol_cm3 = float(
          (
              math.pi * (size[0] ** 2) * (2 * size[1])
              + (4.0 / 3.0) * math.pi * (size[0] ** 3)
          )
          * 1e6
      )
    elif gtype == mujoco.mjtGeom.mjGEOM_CYLINDER:
      vol_cm3 = float(math.pi * (size[0] ** 2) * (2 * size[1]) * 1e6)
    elif gtype == mujoco.mjtGeom.mjGEOM_BOX:
      vol_cm3 = float(8.0 * size[0] * size[1] * size[2] * 1e6)
    body_col_stats.setdefault(bname, []).append((vol_cm3, aspect_ratio))
    per_geom_records.append({
        "gid": gid,
        "bid": bid,
        "vol_cm3": vol_cm3,
        "explicit_mass_g": explicit_mass_g,
        "geom_density": geom_density,
    })

  # Resolve effective mass (in grams) for every collision geom, accounting for
  # explicit geom `mass`, inherited/explicit geom `density`, or body `<inertial/>`.
  records_by_bid: dict[int, list[dict[str, Any]]] = {}
  for rec in per_geom_records:
    records_by_bid.setdefault(int(rec["bid"]), []).append(rec)
  for bid, b_recs in records_by_bid.items():
    body_mass_g = float(m.body_mass[bid]) * 1000.0
    sum_exp_g = sum(
        float(r["explicit_mass_g"])
        for r in b_recs
        if r["explicit_mass_g"] is not None
    )
    unassigned = [r for r in b_recs if r["explicit_mass_g"] is None]
    for r in b_recs:
      if r["explicit_mass_g"] is not None:
        r["eff_mass_g"] = float(r["explicit_mass_g"])
    if unassigned:
      rem_body_g = max(0.0, body_mass_g - sum_exp_g)
      weights = []
      for r in unassigned:
        v_c = max(float(r["vol_cm3"]), 0.0)
        d_c = r["geom_density"]
        weights.append(v_c * float(d_c) if d_c is not None else v_c)
      sum_w = sum(weights)
      for r, w_i in zip(unassigned, weights):
        if rem_body_g > 0.0 and sum_w > 0.0:
          r["eff_mass_g"] = rem_body_g * (w_i / sum_w)
        elif rem_body_g > 0.0:
          r["eff_mass_g"] = rem_body_g / float(len(unassigned))
        elif r["geom_density"] is not None and float(r["vol_cm3"]) > 0.0:
          r["eff_mass_g"] = (
              float(r["geom_density"]) * float(r["vol_cm3"]) * 1e-3
          )
        else:
          r["eff_mass_g"] = 0.0

  for rec in per_geom_records:
    vol_cm3 = float(rec["vol_cm3"])
    gmass_g = float(rec.get("eff_mass_g", 0.0))
    gid = int(rec["gid"])
    if vol_cm3 > 1e-4:
      hull_vols_cm3.append(vol_cm3)
      g_verts = compute_geom_vertices_world(m, d, [gid])
      z_c = float(0.5 * (g_verts[:, 2].min() + g_verts[:, 2].max()))
      hull_z_vol_mass.append((z_c, vol_cm3, gmass_g))
      if gmass_g > 0:
        hull_densities.append(gmass_g / vol_cm3)

  n_col_geoms_by_body = {
      bname: len(entries) for bname, entries in body_col_stats.items()
  }
  over_decomposed_bodies = []
  for bname, entries in body_col_stats.items():
    n_b = len(entries)
    if n_b >= 20:
      b_vol = max(sum(v for v, _ in entries), 1e-6)
      micro_vol_frac = min(0.02, 0.25 / max(n_b, 1))
      micro_or_sliver = sum(
          1 for v, ar in entries if (v < micro_vol_frac * b_vol or ar > 8.0)
      )
      if micro_or_sliver >= max(6, int(0.25 * n_b)):
        over_decomposed_bodies.append({
            "body": bname,
            "n_col_geoms": n_b,
            "micro_or_sliver_hulls": micro_or_sliver,
            "body_hull_vol_cm3": round(b_vol, 2),
        })

  total_hull_vol_cm3 = float(sum(hull_vols_cm3)) if hull_vols_cm3 else 1.0
  eff_density = total_mass_g / total_hull_vol_cm3
  hull_density_cv = (
      float(np.std(hull_densities) / np.mean(hull_densities))
      if len(hull_densities) >= 2 and np.mean(hull_densities) > 0
      else 0.0
  )
  vis_height_m = max(float(vis_max[2] - vis_min[2]), 1e-6)
  com_height_pct = round(100.0 * com_z_above_floor_m / vis_height_m, 1)
  z_band_mass_density = {}
  for b_lbl, z_lo, z_hi in (
      ("lower_third", -1e9, float(vis_min[2] + 0.34 * vis_height_m)),
      (
          "mid_third",
          float(vis_min[2] + 0.34 * vis_height_m),
          float(vis_min[2] + 0.67 * vis_height_m),
      ),
      ("upper_third", float(vis_min[2] + 0.67 * vis_height_m), 1e9),
  ):
    b_entries = [(v, gm) for zc, v, gm in hull_z_vol_mass if z_lo <= zc < z_hi]
    if b_entries:
      b_v = sum(v for v, _ in b_entries)
      b_m = sum(gm for _, gm in b_entries)
      z_band_mass_density[b_lbl] = {
          "n_hulls": len(b_entries),
          "vol_cm3": round(b_v, 2),
          "mass_g": round(b_m, 2),
          "mass_pct": round(100.0 * b_m / max(total_mass_g, 1e-6), 1),
          "density_g_cm3": round(b_m / max(b_v, 1e-6), 4),
      }

  collision_alignment = compute_collision_alignment_summary(m, d)

  base_info = {
      "asset_label": label or os.path.basename(os.path.dirname(xml_path)),
      "xml_path": xml_path,
      "total_mass_g": round(total_mass_g, 3),
      "total_hull_vol_cm3": round(total_hull_vol_cm3, 2),
      "eff_hull_density_g_cm3": round(eff_density, 4),
      "hull_density_cv": round(hull_density_cv, 4),
      "com_local_m": [round(float(x), 4) for x in com_world],
      "com_z_above_floor_m": round(com_z_above_floor_m, 4),
      "com_height_pct_of_z_span": com_height_pct,
      "z_band_mass_density": z_band_mass_density,
      "vis_min": [float(x) for x in vis_min],
      "vis_max": [float(x) for x in vis_max],
      "vis_span_cm": [round(float(x * 100.0), 2) for x in vis_max - vis_min],
      "col_span_cm": [round(float(x * 100.0), 2) for x in col_max - col_min],
      "n_vis_geoms": len(vis_ids),
      "n_col_geoms": len(col_ids),
      "n_col_geoms_by_body": n_col_geoms_by_body,
      "over_decomposed_bodies": over_decomposed_bodies,
      "maxhullvert_truncated_geoms": maxhullvert_truncated_geoms,
      "collision_alignment": collision_alignment,
      "static_and_mesh_hygiene": validate_static_and_mesh_hygiene(xml_path),
      "thresholds": active_thresholds,
  }

  scenario_defs = [
      (1, "1_six_pose_drop_and_hover", run_scenario_1_six_pose_drop),
      (2, "2_tilt_table_sweep", run_scenario_2_tilt_table),
      (3, "3_roll_and_isotropy", run_scenario_3_roll_and_isotropy),
      (
          4,
          "4_three_axis_ray_and_cavity_probe",
          run_scenario_4_smart_cavity_probe,
      ),
      (5, "5_com_aligned_grasp_lift_shake", run_scenario_5_phased_grasp),
      (
          6,
          "6_articulation_sweep_and_polarity",
          run_scenario_6_articulation_sweep,
      ),
      (7, "7_cliff_ledge_overhang_slide", run_scenario_7_cliff_ledge_overhang),
      (8, "8_twin_self_stack_and_nudge", run_scenario_8_twin_self_stack),
      (9, "9_pendulum_impact_and_sites", run_scenario_9_impact_and_sites),
      (
          10,
          "10_high_speed_thin_slab_drop",
          run_scenario_10_high_speed_thin_slab_drop,
      ),
  ]

  scenarios_dict: dict[str, Any] = {}
  panels = []
  for sid, skey, sfn in scenario_defs:
    if sid not in selected_ids:
      continue
    s_res, s_img = sfn(xml_path, base_info)
    scenarios_dict[skey] = s_res
    if sid == 1:
      panels.append((
          "1. 6-Pose Drop & Hover",
          s_res["status"],
          s_img,
          (
              f"Hover: {s_res['upright_vis_hover_mm']:+.2f}mm | Fn:"
              f" {s_res['upright_normal_force_N']:.2f}N"
          ),
          (
              f"MaxFinalSpd: {s_res['max_final_speed_m_s']:.4f} m/s | NaNs:"
              f" {s_res['any_nan']}"
          ),
      ))
    elif sid == 2:
      panels.append((
          "2. Auto-Scaled Tilt Sweep",
          s_res["status"],
          s_img,
          (
              "X slip/tip:"
              f" {s_res['axes']['X_axis']['slip_angle_deg']}/{s_res['axes']['X_axis']['tip_angle_deg']} deg"
          ),
          (
              "Y slip/tip:"
              f" {s_res['axes']['Y_axis']['slip_angle_deg']}/{s_res['axes']['Y_axis']['tip_angle_deg']} deg"
          ),
      ))
    elif sid == 3:
      panels.append((
          "3. Roll & Hull Uniformity",
          s_res["status"],
          s_img,
          (
              f"RollDist: {s_res['roll_distance_cm']:.1f}cm | T_settle:"
              f" {s_res['settle_time_s']:.2f}s"
          ),
          (
              f"Hull density CV: {s_res['hull_density_cv']:.3f}"
              f" (w_f={s_res['final_ang_speed_rad_s']:.2f})"
          ),
      ))
    elif sid == 4:
      holes_sum = sum(s_res["plugged_through_holes_by_axis"].values())
      panels.append((
          "4. 3-Axis Ray & Cavity Probe",
          s_res["status"],
          s_img,
          (
              f"PluggedRays: {s_res['plugged_ray_count_of_400']}/400 (max"
              f" {s_res['max_ray_plug_deficit_mm']:.1f}mm)"
          ),
          (
              f"PluggedHoles(XYZ): {holes_sum} |"
              f" r={s_res['probe_sphere_radius_mm']:.1f}mm"
          ),
      ))
    elif sid == 5:
      panels.append((
          "5. CoM-Aligned Grasp & Shake",
          s_res["status"],
          s_img,
          (
              f"Retained: {s_res['grasp_retained']} | Hoist:"
              f" {s_res['hoist_height_cm']:.1f}cm"
          ),
          (
              f"LiftSlip: {s_res['lift_slip_mm']:+.1f}mm | Span:"
              f" {s_res['grasp_span_cm']:.1f}cm"
          ),
      ))
    elif sid == 6:
      if s_res["joints"]:
        j_sum = (
            f"{s_res['joints'][0]['joint_name']}:"
            f" close={s_res['joints'][0]['closes_at_limit']}"
        )
      else:
        j_sum = "Rigid body (0 articulated joints)"
      panels.append((
          "6. Articulation Sweep & Limits",
          s_res["status"],
          s_img,
          f"Joints: {s_res['num_articulated_joints']} | {j_sum[:34]}",
          "Sweeps rmin<->rmax & checks link separation",
      ))
    elif sid == 7:
      panels.append((
          "7. Cliff-Ledge Overhang Slide",
          s_res["status"],
          s_img,
          f"Tip Overhang: {s_res['tip_overhang_pct']}% of X-span",
          f"Geom CoM Overhang: {s_res['expected_com_overhang_pct']:.1f}%",
      ))
    elif sid == 8:
      panels.append((
          "8. Twin Self-Stack & Nudge",
          s_res["status"],
          s_img,
          (
              f"Static Stack: {s_res['stacked_stably_static']} | Nudge"
              f" Retained: {s_res['retained_after_table_nudge']}"
          ),
          (
              "Z-Sep / Height Ratio:"
              f" {s_res['vertical_separation_ratio_z_over_sz']:.2f}x"
          ),
      ))
    elif sid == 9:
      panels.append((
          "9. Scaled Impact & <site> Check",
          s_res["status"],
          s_img,
          (
              f"Striker({s_res['striker_mass_g']:.0f}g):Vx={s_res['peak_object_vx_m_s']:.2f}"
              f" (ref {s_res['inelastic_ref_vx_m_s']:.2f})"
          ),
          f"Sites: {s_res['num_sites']} | Site Issues: {len(s_res['issues'])}",
      ))
    elif sid == 10:
      panels.append((
          "10. 6x-Size Drop on Thin Slab",
          s_res["status"],
          s_img,
          (
              f"Drop {s_res['drop_height_cm']:.0f}cm on"
              f" {s_res['slab_thickness_mm']:.1f}mm Slab |"
              f" Pen:{s_res['max_penetration_mm']:.1f}mm"
          ),
          (
              f"Tunneled: {s_res['tunneled_through_thin_slab']} | BounceRatio:"
              f" {s_res['bounce_ratio']:.2f}"
          ),
      ))

  scorecard = {
      "agent_guidance_disclaimer": AGENT_DISCLAIMER,
      "selected_scenarios": selected_ids,
      "active_thresholds": active_thresholds,
      "asset_info": base_info,
      "scenarios": scenarios_dict,
  }

  # Build dynamic visual contact sheet (up to 5 cols per row)
  n_panels = max(len(panels), 1)
  n_cols = min(5, max(n_panels, 2))
  n_rows = math.ceil(n_panels / n_cols)
  panel_w, panel_h = 380, 260
  row_h = panel_h + 54
  sheet_w = n_cols * panel_w + (n_cols + 1) * 10
  sheet_h = 66 + n_rows * row_h + (n_rows + 1) * 10
  sheet = Image.new("RGB", (sheet_w, sheet_h), (245, 247, 252))
  draw = ImageDraw.Draw(sheet)
  f_title = _load_font(15)
  f_sub = _load_font(12)
  f_small = _load_font(11)

  draw.rectangle([0, 0, sheet_w, 60], fill=(20, 30, 46))
  header_txt = (
      f"{base_info['asset_label']}  |  Mass: {base_info['total_mass_g']:.1f} g"
      f" (rho_eff={base_info['eff_hull_density_g_cm3']:.3f} g/cm3,"
      f" hull_CV={base_info['hull_density_cv']:.2f})  |  Vis AABB:"
      f" {base_info['vis_span_cm']} cm  |  Col Geoms:"
      f" {base_info['n_col_geoms']}"
  )
  draw.text((14, 8), header_txt, fill=(255, 255, 255), font=f_title)
  draw.text(
      (14, 34),
      f"AGENT NOTE (Scenarios {selected_ids}): Use engineering judgment for"
      " asset shape (e.g., spheres roll at <5 deg & don't stack; solid blocks"
      " have 0 cavities).",
      fill=(255, 215, 110),
      font=f_small,
  )

  badge_colors = {
      "PASS": (22, 150, 75),
      "CHECK": (215, 130, 15),
      "INFO": (55, 115, 185),
      "FAIL": (205, 38, 42),
  }

  for idx, (ptitle, pstat, pimg, line1, line2) in enumerate(panels):
    col = idx % n_cols
    row = idx // n_cols
    x0 = 10 + col * (panel_w + 10)
    y0 = 68 + row * (row_h + 10)
    draw.rectangle(
        [x0, y0, x0 + panel_w, y0 + row_h],
        fill=(255, 255, 255),
        outline=(205, 212, 224),
        width=1,
    )
    if pimg is not None:
      sheet.paste(pimg, (x0, y0))
    bcol = badge_colors.get(pstat, (100, 100, 100))
    draw.rectangle([x0 + 8, y0 + 8, x0 + 68, y0 + 28], fill=bcol)
    draw.text((x0 + 13, y0 + 11), pstat, fill=(255, 255, 255), font=f_sub)
    draw.rectangle(
        [x0 + 72, y0 + 8, x0 + panel_w - 8, y0 + 28], fill=(25, 35, 52)
    )
    draw.text((x0 + 78, y0 + 11), ptitle, fill=(255, 255, 255), font=f_sub)

    draw.text((x0 + 8, y0 + panel_h + 6), line1, fill=(25, 35, 50), font=f_sub)
    draw.text(
        (x0 + 8, y0 + panel_h + 26), line2, fill=(85, 95, 115), font=f_sub
    )

  safe_name = (label or "asset").replace(" ", "_").replace("/", "_")
  json_out = os.path.join(out_dir, f"{safe_name}_scenarios.json")
  png_out = os.path.join(out_dir, f"{safe_name}_scenarios.png")
  with open(json_out, "w") as f:
    json.dump(scorecard, f, indent=2)
  sheet.save(png_out)
  scorecard["contact_sheet_png"] = png_out
  scorecard["scorecard_json"] = json_out
  return scorecard


def render_before_vs_after_sheet(
    before_xml: str,
    after_xml: str,
    out_png: str,
    real_img_path: str | None = None,
    label: str = "",
) -> str:
  """Renders an uncropped 3-row x 6-column Before-vs-After comparison sheet."""

  def _load_standalone_for_render(
      xml_p: str,
  ) -> tuple[mujoco.MjModel, mujoco.MjData]:
    spec = mujoco.MjSpec.from_file(xml_p)
    spec.compiler.autolimits = True
    spec.visual.global_.offwidth = 640
    spec.visual.global_.offheight = 640
    wb = spec.worldbody
    for lname, lpos, ldir, ldiff in (
        (
            "cmp_key",
            [0.45, -0.55, 1.6],
            [-0.25, 0.30, -1.0],
            [0.85, 0.85, 0.85],
        ),
        (
            "cmp_fill",
            [-0.55, 0.45, 1.4],
            [0.30, -0.25, -1.0],
            [0.50, 0.52, 0.56],
        ),
        ("cmp_back", [0.0, 0.60, -1.2], [0.0, -0.35, 1.0], [0.38, 0.40, 0.44]),
    ):
      lt = wb.add_light(name=lname)
      lt.pos = lpos
      lt.dir = ldir
      lt.diffuse = ldiff
      lt.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
    m = spec.compile()
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    _, c_ids = classify_asset_geoms(m)
    for idx, gid in enumerate(c_ids):
      hue = (idx * 0.61803398875) % 1.0
      r_c, g_c, b_c = colorsys.hsv_to_rgb(hue, 0.82, 0.92)
      m.geom_rgba[gid] = [r_c, g_c, b_c, 0.55]
    return m, d

  m_bef, d_bef = _load_standalone_for_render(before_xml)
  m_aft, d_aft = _load_standalone_for_render(after_xml)
  v_aft, c_aft = classify_asset_geoms(m_aft)
  pts_aft = compute_geom_vertices_world(m_aft, d_aft, v_aft + c_aft)
  bmin = pts_aft.min(axis=0)
  bmax = pts_aft.max(axis=0)
  center = 0.5 * (bmin + bmax)
  span = bmax - bmin
  max_dim = float(np.max(span))
  half_horiz = 0.5 * float(max(span[0], span[1]))
  half_vert = 0.5 * float(span[2])
  # Compute camera distance with >= 22% frustum margin accounting for
  # front-surface foreshortening.
  fovy_rad = math.radians(float(m_aft.vis.global_.fovy or 45.0))
  cam_dist = max(
      1.80 * max_dim,
      (1.25 * max(half_vert, half_horiz) / math.tan(0.5 * fovy_rad))
      + half_horiz,
      0.08,
  )

  pw, ph = 320, 320

  def _render_view(
      r: mujoco.Renderer,
      m: mujoco.MjModel,
      d: mujoco.MjData,
      az: float,
      el: float,
      show_vis: bool,
      show_col: bool,
  ) -> Image.Image:
    cam = mujoco.MjvCamera()
    mujoco.mjv_defaultFreeCamera(m, cam)
    cam.lookat[:] = center
    cam.distance = cam_dist
    cam.azimuth = az
    cam.elevation = el
    opt = mujoco.MjvOption()
    mujoco.mjv_defaultOption(opt)
    opt.geomgroup[0] = 1 if show_vis else 0
    opt.geomgroup[1] = 1 if show_vis else 0
    opt.geomgroup[2] = 1 if show_vis else 0
    opt.geomgroup[3] = 1 if show_col else 0
    opt.geomgroup[4] = 0
    opt.geomgroup[5] = 0
    saved = m.geom_rgba.copy()
    if show_col and not show_vis:
      _, c_ids = classify_asset_geoms(m)
      for gid in c_ids:
        m.geom_rgba[gid, 3] = 0.92
    r.update_scene(d, camera=cam, scene_option=opt)
    rgb = r.render()
    m.geom_rgba[:] = saved
    return Image.fromarray(rgb)

  views = [
      ("Front (+X)", 0.0, 0.0),
      ("Side (+Y)", 90.0, 0.0),
      ("3/4 Iso", 45.0, -20.0),
      ("Top (+Z)", 0.0, -89.0),
      ("Bottom (-Z)", 0.0, 89.0),
  ]

  r_bef = mujoco.Renderer(m_bef, height=ph, width=pw)
  r_aft = mujoco.Renderer(m_aft, height=ph, width=pw)
  try:
    row1 = []
    if real_img_path and os.path.isfile(real_img_path):
      try:
        r_im = Image.open(real_img_path).convert("RGB")
        r_im.thumbnail((pw - 12, ph - 12), Image.Resampling.LANCZOS)
        bg = Image.new("RGB", (pw, ph), (18, 22, 30))
        bg.paste(r_im, ((pw - r_im.width) // 2, (ph - r_im.height) // 2))
        row1.append(("Real Asset Photo", bg))
      except Exception:  # pylint: disable=broad-exception-caught
        row1.append((
            "Visual: Back (-X)",
            _render_view(r_aft, m_aft, d_aft, 180.0, 0.0, True, False),
        ))
    else:
      row1.append((
          "Visual: Back (-X)",
          _render_view(r_aft, m_aft, d_aft, 180.0, 0.0, True, False),
      ))
    for vtitle, az, el in views:
      row1.append((
          f"Visual: {vtitle}",
          _render_view(r_aft, m_aft, d_aft, az, el, True, False),
      ))

    row2 = []
    for vtitle, az, el in views:
      row2.append((
          f"Before Hulls: {vtitle}",
          _render_view(r_bef, m_bef, d_bef, az, el, False, True),
      ))
    row2.append((
        "Before Overlay: 3/4 Iso",
        _render_view(r_bef, m_bef, d_bef, 45.0, -20.0, True, True),
    ))

    row3 = []
    for vtitle, az, el in views:
      row3.append((
          f"After Hulls: {vtitle}",
          _render_view(r_aft, m_aft, d_aft, az, el, False, True),
      ))
    row3.append((
        "After Overlay: 3/4 Iso",
        _render_view(r_aft, m_aft, d_aft, 45.0, -20.0, True, True),
    ))
  finally:
    r_bef.close()
    r_aft.close()

  n_cols = 6
  header_h = 56
  row_banner_h = 28
  cell_h = ph + 28
  sheet_w = n_cols * pw + (n_cols + 1) * 10
  sheet_h = header_h + 3 * (row_banner_h + cell_h + 12) + 10
  sheet = Image.new("RGB", (sheet_w, sheet_h), (14, 18, 24))
  draw = ImageDraw.Draw(sheet)
  f_title = _load_font(15)
  f_sub = _load_font(12)

  title_lbl = label or os.path.basename(
      os.path.dirname(os.path.abspath(after_xml))
  )
  mass_aft_g = float(np.sum(m_aft.body_mass[1:]) * 1000.0)
  draw.rectangle([0, 0, sheet_w, header_h], fill=(22, 32, 48))
  draw.text(
      (14, 10),
      f"{title_lbl} — Before vs. After 6-View & Per-Hull Color-Coded Collision"
      " Audit",
      fill=(255, 255, 255),
      font=f_title,
  )
  draw.text(
      (14, 32),
      f"Vis AABB: {[round(float(x*100), 2) for x in span]} cm  |  Mass:"
      f" {mass_aft_g:.1f} g  |  Camera Distance: {cam_dist*100:.1f} cm"
      " (Uncropped Full-Margin Framing)",
      fill=(180, 215, 255),
      font=f_sub,
  )

  row_specs = [
      (
          "ROW 1: REAL ASSET PHOTO & VISUAL GEOMETRY (group='2')",
          row1,
          (26, 48, 42),
      ),
      (
          (
              "ROW 2: BEFORE COLLISION HULLS (group='3', Per-Hull Color-Coded &"
              " Overlay)"
          ),
          row2,
          (58, 30, 32),
      ),
      (
          (
              "ROW 3: AFTER REMEDIATED COLLISION HULLS (group='3', Per-Hull"
              " Color-Coded & Overlay)"
          ),
          row3,
          (24, 42, 64),
      ),
  ]
  y_cur = header_h + 8
  for rbanner, rcells, rcol in row_specs:
    draw.rectangle([10, y_cur, sheet_w - 10, y_cur + row_banner_h], fill=rcol)
    draw.text((18, y_cur + 6), rbanner, fill=(240, 245, 255), font=f_sub)
    y_cur += row_banner_h + 4
    for c_idx, (ctitle, cim) in enumerate(rcells):
      x0 = 10 + c_idx * (pw + 10)
      draw.rectangle(
          [x0, y_cur, x0 + pw, y_cur + cell_h],
          fill=(24, 28, 38),
          outline=(55, 65, 82),
      )
      draw.text((x0 + 8, y_cur + 5), ctitle, fill=(220, 228, 242), font=f_sub)
      sheet.paste(cim, (x0, y_cur + 26))
    y_cur += cell_h + 8

  os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
  sheet.save(out_png)
  return out_png


def main(argv: Sequence[str]) -> None:
  if len(argv) > 1:
    raise app.UsageError("Too many command-line arguments.")
  xml_path = (
      _XML_PATH.value
      or _XML_ALIAS.value
      or _ASSET_ALIAS.value
      or _INPUT_ALIAS.value
  )
  out_dir = _OUT_DIR.value or _OUTPUT_DIR_ALIAS.value
  if not xml_path or (not out_dir and not _STATIC_ONLY.value):
    raise app.UsageError(
        "Must provide --xml_path (or --xml / --asset / --input) and --out_dir"
        " (or --output_dir, unless --static_only is set)."
    )
  if _STATIC_ONLY.value:
    hygiene = validate_static_and_mesh_hygiene(xml_path)
    print(json.dumps(hygiene, indent=2))
    return
  custom_thresh = (
      json.loads(_THRESHOLDS_JSON.value) if _THRESHOLDS_JSON.value else None
  )
  res = run_all_scenarios_for_asset(
      xml_path,
      out_dir,
      _LABEL.value or "",
      thresholds=custom_thresh,
      scenarios=_SCENARIOS.value,
  )
  print("Saved:", res["contact_sheet_png"], res["scorecard_json"])
  if _BEFORE_XML.value:
    cmp_out = _COMPARISON_OUT.value or os.path.join(
        out_dir, f"{(_LABEL.value or 'asset')}_before_vs_after.png"
    )
    render_before_vs_after_sheet(
        _BEFORE_XML.value,
        xml_path,
        cmp_out,
        real_img_path=_REAL_IMG_PATH.value,
        label=_LABEL.value or "",
    )
    print("Saved Before-vs-After sheet:", cmp_out)


def cli_main() -> None:
  app.run(main)


if __name__ == "__main__":
  cli_main()
