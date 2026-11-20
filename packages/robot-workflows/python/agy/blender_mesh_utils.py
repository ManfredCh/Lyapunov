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

"""Zero-magic Blender mesh I/O, declarative organic builders, UV pack, hull clipping, and Cycles PBR baking.

Runs inside headless Blender (`PYTHONDONTWRITEBYTECODE=1 blender -b -P`).

Core functions:
- `clear_scene`: Removes all objects and orphan data blocks and configures SI
  metric units (`1.0 m`).
- `skin_skeleton`, `metaball_sdf`, `swept_tube`, `voxel_smooth_union`,
  `apply_boolean_cutter`: Declarative low-DOF organic and boolean-cutter
  builders.
- `smart_seam_unwrap`, `smart_uv_project` & `pack_shared_uv_atlas`: Native
  Blender C++ conformal / smart UV unwrapping and multi-object
  `bpy.ops.uv.pack_islands` `[0, 1]^2` packing.
- `finalize_and_export_obj`: Non-destructively exports a body-local `.obj` via
  Blender's C++ `bpy.ops.wm.obj_export` (`forward_axis='Y', up_axis='Z'`).
- `export_convex_hull_col`: Builds plane-clipped (`bmesh.ops.bisect_plane`),
  body-local convex collision hulls (`<= max_verts`, default `64`) from single
  or multi-object meshes/curves or 3D point clouds with strict volume checks.
- `bake_pbr_maps`: Bakes multi-material / multi-object `Principled BSDF` graphs
  under `Raw` color management (`basecolor` in sRGB; `roughness`, `metallic`,
  `normal` in linear `Non-Color`).
"""

from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True

import array  # pylint: disable=g-import-not-at-top
from collections.abc import Mapping, Sequence  # pylint: disable=g-import-not-at-top
import hashlib  # pylint: disable=g-import-not-at-top
import math  # pylint: disable=g-import-not-at-top
from typing import Any  # pylint: disable=g-import-not-at-top

import bmesh  # pylint: disable=import-error,g-import-not-at-top
import bpy  # pylint: disable=import-error,g-import-not-at-top
import mathutils  # pylint: disable=import-error,g-import-not-at-top


def clear_scene() -> None:
  """Clears all scene objects, meshes, materials, images, curves, cameras, and lights."""
  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')
  except RuntimeError:
    pass

  for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

  for block_coll in (
      bpy.data.meshes,
      bpy.data.materials,
      bpy.data.images,
      bpy.data.curves,
      bpy.data.cameras,
      bpy.data.lights,
  ):
    for block in list(block_coll):
      block_coll.remove(block)

  scene = bpy.context.scene
  scene.unit_settings.system = 'METRIC'
  scene.unit_settings.scale_length = 1.0


def _select_only(target_obj: bpy.types.Object) -> None:
  """Selects exclusively `target_obj` and sets it as the active scene object."""
  for obj in bpy.data.objects:
    if obj.select_get():
      obj.select_set(False)
  target_obj.select_set(True)
  bpy.context.view_layer.objects.active = target_obj


def _resolve_object_list(raw_objs: Any) -> list[bpy.types.Object]:
  """Resolves a single `Object`/`str` or sequence of `Object`/`str` into `Object`s."""
  if raw_objs is None:
    return []
  if isinstance(raw_objs, (bpy.types.Object, str)):
    items: Sequence[Any] = [raw_objs]
  else:
    items = list(raw_objs)
  resolved: list[bpy.types.Object] = []
  seen: set[bpy.types.Object] = set()
  for item in items:
    if item is None:
      continue
    if isinstance(item, str):
      obj = (
          bpy.data.objects.get(item)
          or bpy.data.objects.get(f'{item}_vis')
          or bpy.data.objects.get(f'{item}_cutter')
          or (
              bpy.data.objects.get(item[:-4]) if item.endswith('_vis') else None
          )
          or bpy.data.objects[item]
      )
    elif isinstance(item, bpy.types.Object):
      obj = item
    else:
      raise TypeError(
          'Expected bpy.types.Object or str object name, got '
          f'{type(item).__name__}'
      )
    if obj not in seen:
      seen.add(obj)
      resolved.append(obj)
  return resolved


def _compute_corner_normals_hash(mesh_data: bpy.types.Mesh) -> str:
  """Computes a fast deterministic checksum over `mesh_data.corner_normals`."""
  n_loops = len(mesh_data.loops)
  if n_loops == 0:
    return 'empty'
  buf = array.array('f', [0.0] * (n_loops * 3))
  mesh_data.corner_normals.foreach_get('vector', buf)
  quant = array.array('i', (int(round(float(x) * 10000.0)) for x in buf))
  return hashlib.blake2b(quant.tobytes(), digest_size=16).hexdigest()


def _apply_weighted_normals(
    target_obj: bpy.types.Object,
    *,
    force_smooth: bool = False,
) -> None:
  """Applies `WEIGHTED_NORMAL(keep_sharp=True)` without altering scene selection."""
  mesh_data = target_obj.data
  if len(mesh_data.polygons) == 0:
    return

  if force_smooth:
    if hasattr(mesh_data, 'shade_smooth'):
      mesh_data.shade_smooth()
    else:
      for poly in mesh_data.polygons:
        poly.use_smooth = True
  else:
    has_smooth = any(poly.use_smooth for poly in mesh_data.polygons)
    has_sharp = any(edge.use_edge_sharp for edge in mesh_data.edges)
    if not has_smooth and not has_sharp:
      return

  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]
  prev_hide_vp = bool(target_obj.hide_viewport)
  target_obj.hide_viewport = False

  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')
    _select_only(target_obj)

    if getattr(mesh_data, 'has_custom_normals', False):
      try:
        with bpy.context.temp_override(
            object=target_obj, active_object=target_obj
        ):
          bpy.ops.mesh.customdata_custom_splitnormals_clear()
      except RuntimeError:
        cn_attr = mesh_data.attributes.get('custom_normal')
        if cn_attr is not None:
          mesh_data.attributes.remove(cn_attr)

    wn_mod = target_obj.modifiers.new(
        name='_WeightedNormal', type='WEIGHTED_NORMAL'
    )
    wn_mod.weight = 100
    wn_mod.keep_sharp = True
    applied = False
    try:
      with bpy.context.temp_override(
          object=target_obj, active_object=target_obj
      ):
        bpy.ops.object.modifier_apply(modifier=wn_mod.name)
      applied = True
    except RuntimeError:
      if wn_mod.name in target_obj.modifiers:
        target_obj.modifiers.remove(wn_mod)
    mesh_data.update()
    if '_wn_managed_normals' in target_obj:
      del target_obj['_wn_managed_normals']
    if applied:
      target_obj['_wn_norm_hash'] = _compute_corner_normals_hash(mesh_data)
  finally:
    target_obj.hide_viewport = prev_hide_vp
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active


def _apply_boolean_modifier_safe(
    target_obj: bpy.types.Object,
    operand_obj: bpy.types.Object,
    operation: str = 'DIFFERENCE',
) -> None:
  """Applies a Blender `BOOLEAN` modifier (`MANIFOLD` with welded `EXACT` fallback)."""
  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]
  tmp_operand: bpy.types.Object | None = None
  tmp_mesh: bpy.types.Mesh | None = None
  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')
    _select_only(target_obj)

    mod = target_obj.modifiers.new(name='_BoolOp', type='BOOLEAN')
    mod.operation = operation
    mod.solver = 'MANIFOLD'
    mod.object = operand_obj
    try:
      bpy.ops.object.modifier_apply(modifier=mod.name)
    except RuntimeError:
      pass

    if mod.name in target_obj.modifiers:
      # Fallback for Blender builds compiled without WITH_MANIFOLD: weld operand
      # copy so split glTF UV vertices form a closed watertight solid for EXACT.
      tmp_mesh = operand_obj.data.copy()
      bm = bmesh.new()
      bm.from_mesh(tmp_mesh)
      bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
      bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
      bm.to_mesh(tmp_mesh)
      bm.free()
      tmp_mesh.update()
      tmp_operand = bpy.data.objects.new('_tmp_bool_operand', tmp_mesh)
      bpy.context.scene.collection.objects.link(tmp_operand)
      tmp_operand.matrix_world = operand_obj.matrix_world.copy()
      mod.solver = 'EXACT'
      if hasattr(mod, 'use_self'):
        mod.use_self = True
      mod.object = tmp_operand
      _select_only(target_obj)
      bpy.ops.object.modifier_apply(modifier=mod.name)
    target_obj.data.update()
  finally:
    if tmp_operand is not None and tmp_operand.name in bpy.data.objects:
      bpy.data.objects.remove(tmp_operand, do_unlink=True)
    if tmp_mesh is not None and tmp_mesh.users == 0:
      bpy.data.meshes.remove(tmp_mesh)
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active


def skin_skeleton(
    name: str,
    nodes_xyzr: Sequence[Sequence[Any]],
    edges: Sequence[Any] | None = None,
    *,
    radii: Sequence[Any] | float | None = None,
    subsurf_levels: int = 2,
    subdiv: int | None = None,
) -> bpy.types.Object:
  """Builds a watertight organic mesh from a skeleton graph via `SKIN` + `SUBSURF`.

  Args:
    name: Scene object name.
    nodes_xyzr: Sequence of `(x, y, z, r)`, `(x, y, z, (rx, ry))`, or `(x, y,
      z)` in meters.
    edges: Sequence of `(u_idx, v_idx)` vertex index pairs (defaults to
      sequential chain), or per-node radii if called as `skin_skeleton(name,
      nodes_xyz, radii)`.
    radii: Optional explicit per-node radii (or uniform float radius).
    subsurf_levels: Subdivision surface level (`2` default).
    subdiv: Alias for `subsurf_levels`.
  """
  if subdiv is not None:
    subsurf_levels = int(subdiv)
  old = bpy.data.objects.get(name)
  if old is not None:
    bpy.data.objects.remove(old, do_unlink=True)

  # Detect if the 3rd positional arg `edges` was actually passed as `radii`
  if (
      edges is not None
      and radii is None
      and len(edges) == len(nodes_xyzr)
      and all(len(n) == 3 for n in nodes_xyzr)
      and (
          not hasattr(edges[0], '__len__')
          or any(isinstance(x, float) for x in edges[0])
      )
  ):
    radii = edges
    edges = None

  verts = [(float(n[0]), float(n[1]), float(n[2])) for n in nodes_xyzr]
  if edges is None:
    edge_pairs = [(i, i + 1) for i in range(max(0, len(verts) - 1))]
  else:
    edge_pairs = [(int(a), int(b)) for a, b in edges]
  mesh = bpy.data.meshes.new(name)
  mesh.from_pydata(verts, edge_pairs, [])
  mesh.update()

  obj = bpy.data.objects.new(name, mesh)
  bpy.context.scene.collection.objects.link(obj)
  skin_mod = obj.modifiers.new(name='Skin', type='SKIN')
  skin_mod.use_smooth_shade = True

  for idx, n in enumerate(nodes_xyzr):
    if radii is not None:
      r_val = radii[idx] if hasattr(radii, '__len__') else radii
    else:
      r_val = n[3] if len(n) > 3 else 0.01
    if hasattr(r_val, '__len__'):
      rx, ry = float(r_val[0]), float(r_val[1])
    else:
      rx = ry = float(r_val)
    obj.data.skin_vertices[0].data[idx].radius = (max(rx, 1e-5), max(ry, 1e-5))
  if nodes_xyzr:
    obj.data.skin_vertices[0].data[0].use_root = True

  sub_mod = obj.modifiers.new(name='Subsurf', type='SUBSURF')
  sub_mod.levels = max(0, int(subsurf_levels))
  sub_mod.render_levels = max(0, int(subsurf_levels))

  _select_only(obj)
  bpy.ops.object.modifier_apply(modifier=skin_mod.name)
  if sub_mod.levels > 0:
    bpy.ops.object.modifier_apply(modifier=sub_mod.name)
  else:
    obj.modifiers.remove(sub_mod)
  if hasattr(obj.data, 'shade_smooth'):
    obj.data.shade_smooth()
  obj.data.update()
  return obj


def metaball_sdf(
    name: str,
    elements: Sequence[Mapping[str, Any]],
    *,
    threshold: float = 0.6,
    resolution: float = 0.002,
) -> bpy.types.Object:
  """Evaluates analytical implicit SDF primitives (`BALL`, `CAPSULE`, `ELLIPSOID`, `CUBE`) and converts to mesh.

  Each dict in `elements` supports:
    - `'type'`: `'BALL'` (default), `'CAPSULE'`, `'ELLIPSOID'`, `'CUBE'`,
    `'PLANE'`
    - `'co'` or `'pos'`: `(x, y, z)` in meters
    - `'radius'`: float radius in meters
    - `'size'` or `'size_xyz'`: `(sx, sy, sz)` for `CAPSULE`/`ELLIPSOID`/`CUBE`
    - `'stiffness'`: float blend stiffness (`2.0` default)
    - `'use_negative'`: bool (`True` for thumb indents / subtractive cavities)
  """
  old = bpy.data.objects.get(name)
  if old is not None:
    bpy.data.objects.remove(old, do_unlink=True)

  mball = bpy.data.metaballs.new(name)
  mball.threshold = max(0.01, float(threshold))
  mball.resolution = max(0.0005, float(resolution))
  mball.render_resolution = mball.resolution

  for spec in elements:
    etype = str(spec.get('type', 'BALL')).upper()
    el = mball.elements.new(type=etype)
    co = spec.get('co', spec.get('pos', (0.0, 0.0, 0.0)))
    el.co = (float(co[0]), float(co[1]), float(co[2]))
    el.radius = float(spec.get('radius', 0.01))
    if 'stiffness' in spec:
      el.stiffness = float(spec['stiffness'])
    el.use_negative = bool(spec.get('use_negative', False))
    sz = spec.get('size', spec.get('size_xyz'))
    if sz is not None:
      if hasattr(sz, '__len__'):
        el.size_x = float(sz[0])
        if len(sz) > 1:
          el.size_y = float(sz[1])
        if len(sz) > 2:
          el.size_z = float(sz[2])
      else:
        el.size_x = float(sz)

  m_obj = bpy.data.objects.new(name, mball)
  bpy.context.scene.collection.objects.link(m_obj)
  bpy.context.view_layer.update()
  _select_only(m_obj)
  bpy.ops.object.convert(target='MESH')
  out_obj = bpy.context.active_object
  out_obj.name = name
  out_obj.data.name = name
  if hasattr(out_obj.data, 'shade_smooth'):
    out_obj.data.shade_smooth()
  out_obj.data.update()
  return out_obj


def swept_tube(
    name: str,
    points_xyzr: Sequence[Sequence[float]],
    radius_or_profile: float | Sequence[float] | None = None,
    *,
    bevel_resolution: int = 6,
) -> bpy.types.Object:
  """Builds a 3D `NURBS` curve tube with per-point radius, end caps, and `WELD` modifier."""
  old = bpy.data.objects.get(name)
  if old is not None:
    bpy.data.objects.remove(old, do_unlink=True)

  curve = bpy.data.curves.new(name, type='CURVE')
  curve.dimensions = '3D'
  curve.bevel_depth = 1.0
  curve.bevel_resolution = max(2, int(bevel_resolution))
  curve.use_fill_caps = True

  spline = curve.splines.new('NURBS')
  spline.points.add(len(points_xyzr) - 1)
  for idx, pt in enumerate(points_xyzr):
    spline.points[idx].co = (float(pt[0]), float(pt[1]), float(pt[2]), 1.0)
    if len(pt) > 3:
      r_pt = float(pt[3])
    elif radius_or_profile is not None:
      if hasattr(radius_or_profile, '__len__'):
        r_pt = float(radius_or_profile[min(idx, len(radius_or_profile) - 1)])
      else:
        r_pt = float(radius_or_profile)
    else:
      r_pt = 0.005
    spline.points[idx].radius = r_pt
  spline.use_endpoint_u = True
  spline.order_u = min(4, len(points_xyzr))

  c_obj = bpy.data.objects.new(name, curve)
  bpy.context.scene.collection.objects.link(c_obj)
  bpy.context.view_layer.update()
  _select_only(c_obj)
  bpy.ops.object.convert(target='MESH')
  out_obj = bpy.context.active_object
  out_obj.name = name
  out_obj.data.name = name
  w_mod = out_obj.modifiers.new(name='Weld', type='WELD')
  w_mod.merge_threshold = 1e-5
  bpy.ops.object.modifier_apply(modifier=w_mod.name)
  if hasattr(out_obj.data, 'shade_smooth'):
    out_obj.data.shade_smooth()
  out_obj.data.update()
  return out_obj


def voxel_smooth_union(
    name: str,
    objects: Sequence[bpy.types.Object | str],
    *,
    voxel_size: float = 0.0015,
    adaptivity: float = 0.0,
    smooth_iterations: int = 6,
    smooth_iters: int | None = None,
) -> bpy.types.Object:
  """Unions `objects` and applies `REMESH(mode='VOXEL')` + `SMOOTH` for organic fillets."""
  if smooth_iters is not None:
    smooth_iterations = int(smooth_iters)
  resolved = _resolve_object_list(objects)
  if not resolved:
    raise ValueError(
        f'voxel_smooth_union({name!r}) received empty objects list'
    )

  base_obj = resolved[0]
  if base_obj.name != name:
    base_obj.name = name
    base_obj.data.name = name

  for other in resolved[1:]:
    _apply_boolean_modifier_safe(base_obj, other, operation='UNION')
    if other.name in bpy.data.objects:
      bpy.data.objects.remove(other, do_unlink=True)

  _select_only(base_obj)
  rem_mod = base_obj.modifiers.new(name='VoxelRemesh', type='REMESH')
  rem_mod.mode = 'VOXEL'
  rem_mod.voxel_size = max(0.0003, float(voxel_size))
  if hasattr(rem_mod, 'adaptivity') and adaptivity > 0.0:
    rem_mod.adaptivity = float(adaptivity)
  rem_mod.use_smooth_shade = True
  bpy.ops.object.modifier_apply(modifier=rem_mod.name)

  if int(smooth_iterations) > 0:
    sm_mod = base_obj.modifiers.new(name='Smooth', type='SMOOTH')
    sm_mod.iterations = int(smooth_iterations)
    sm_mod.factor = 0.5
    bpy.ops.object.modifier_apply(modifier=sm_mod.name)

  base_obj.data.update()
  return base_obj


def apply_boolean_cutter(
    target_obj: bpy.types.Object | str,
    cutter_obj: bpy.types.Object | str,
    *,
    operation: str = 'DIFFERENCE',
    solver: str = 'MANIFOLD',
) -> bpy.types.Object:
  """Applies a Blender boolean `cutter_obj` (`DIFFERENCE`/`UNION`/`INTERSECT`) to `target_obj`."""
  del solver
  tgt = _resolve_object_list(target_obj)[0]
  cut = _resolve_object_list(cutter_obj)[0]
  _apply_boolean_modifier_safe(tgt, cut, operation=str(operation).upper())
  return tgt


def _compute_uv_span(target_obj: bpy.types.Object) -> float:
  """Returns `max(u_ptp, v_ptp)` across all UV loops of `target_obj`."""
  if not target_obj.data.uv_layers:
    return 0.0
  uv_data = target_obj.data.uv_layers.active.data
  if not uv_data:
    return 0.0
  us = [float(lp.uv.x) for lp in uv_data]
  vs = [float(lp.uv.y) for lp in uv_data]
  return max(max(us) - min(us), max(vs) - min(vs))


def _compute_uv_bbox_tuple(
    target_obj: bpy.types.Object,
) -> tuple[float, float, float, float] | None:
  """Returns `(u_min, v_min, u_max, v_max)` for `target_obj`'s active UV layer, or `None`."""
  if (
      target_obj is None
      or target_obj.type != 'MESH'
      or not target_obj.data.uv_layers
  ):
    return None
  uv_layer = target_obj.data.uv_layers.active or target_obj.data.uv_layers[0]
  if not uv_layer.data:
    return None
  us = [float(lp.uv.x) for lp in uv_layer.data]
  vs = [float(lp.uv.y) for lp in uv_layer.data]
  return (min(us), min(vs), max(us), max(vs))


def _uvs_need_unwrap(target_obj: bpy.types.Object) -> bool:
  """Returns True if `target_obj` has no UVs, degenerate UVs, or UVs outside `[-0.05, 1.05]` (e.g.

  raw millimeter UVs).
  """
  bbox = _compute_uv_bbox_tuple(target_obj)
  if bbox is None:
    return True
  u_min, v_min, u_max, v_max = bbox
  if (
      u_min < -0.05
      or v_min < -0.05
      or u_max > 1.05
      or v_max > 1.05
      or (u_max - u_min) < 1e-5
      or (v_max - v_min) < 1e-5
  ):
    return True
  return False


def _bmesh_box_atlas_unwrap(
    target_obj: bpy.types.Object, margin: float = 0.005
) -> None:
  """Context-free pure-`bmesh` 6-direction (`+-X, +-Y, +-Z`) UV fallback."""
  bm = bmesh.new()
  bm.from_mesh(target_obj.data)
  if not bm.faces:
    bm.free()
    return
  uv_layer = bm.loops.layers.uv.active
  if uv_layer is None:
    uv_layer = bm.loops.layers.uv.new('UVMap')

  bmin = mathutils.Vector((1e9, 1e9, 1e9))
  bmax = mathutils.Vector((-1e9, -1e9, -1e9))
  for v in bm.verts:
    for k in range(3):
      bmin[k] = min(bmin[k], v.co[k])
      bmax[k] = max(bmax[k], v.co[k])
  span = mathutils.Vector((
      max(bmax.x - bmin.x, 1e-6),
      max(bmax.y - bmin.y, 1e-6),
      max(bmax.z - bmin.z, 1e-6),
  ))

  cell_w = 1.0 / 3.0
  cell_h = 1.0 / 2.0
  pad_u = min(0.08, max(0.002, float(margin))) * cell_w
  pad_v = min(0.08, max(0.002, float(margin))) * cell_h
  in_w = cell_w - 2.0 * pad_u
  in_h = cell_h - 2.0 * pad_v

  for face in bm.faces:
    n = face.normal
    ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
    if ax >= ay and ax >= az:
      col, row = (0, 0) if n.x >= 0.0 else (0, 1)
      proj = lambda c: ((c.y - bmin.y) / span.y, (c.z - bmin.z) / span.z)
    elif ay >= ax and ay >= az:
      col, row = (1, 0) if n.y >= 0.0 else (1, 1)
      proj = lambda c: ((c.x - bmin.x) / span.x, (c.z - bmin.z) / span.z)
    else:
      col, row = (2, 0) if n.z >= 0.0 else (2, 1)
      proj = lambda c: ((c.x - bmin.x) / span.x, (c.y - bmin.y) / span.y)

    u_base = col * cell_w + pad_u
    v_base = row * cell_h + pad_v
    for loop in face.loops:
      ru, rv = proj(loop.vert.co)
      loop[uv_layer].uv = (
          u_base + max(0.0, min(1.0, ru)) * in_w,
          v_base + max(0.0, min(1.0, rv)) * in_h,
      )

  bm.to_mesh(target_obj.data)
  bm.free()
  target_obj.data.update()


def smart_seam_unwrap(
    target_obj: bpy.types.Object,
    *,
    angle_limit_deg: float = 66.0,
    margin: float = 0.005,
) -> bpy.types.Object:
  """Unwraps `target_obj` using native Blender conformal unwrap or smart UV project.

  Zero hidden seam injection, zero UV island mirroring, and zero island
  rotation overrides:
  - If `target_obj` already has marked `use_seam` edges (`seam_count > 0`),
    runs `bpy.ops.uv.unwrap(method='CONFORMAL', margin=margin)`.
  - If `seam_count == 0`, runs `bpy.ops.uv.smart_project(angle_limit=...,
    island_margin=margin)`.

  Args:
    target_obj: Blender mesh object to unwrap.
    angle_limit_deg: Angle limit in degrees for `smart_project` when `seam_count
      == 0` (`66.0` default).
    margin: UV island margin in `[0, 1]` space (`0.005` default).

  Returns:
    `target_obj` with unwrapped active UV layer.
  """
  mesh_data = target_obj.data
  if len(mesh_data.polygons) == 0:
    return target_obj

  if not mesh_data.uv_layers:
    mesh_data.uv_layers.new(name='UVMap')

  seam_count = sum(1 for edge in mesh_data.edges if edge.use_seam)

  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]
  prev_hide = bool(target_obj.hide_viewport)
  target_obj.hide_viewport = False
  op_succeeded = False

  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')
    _select_only(target_obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.reveal()
    bpy.ops.mesh.select_all(action='SELECT')
    if seam_count > 0:
      bpy.ops.uv.unwrap(method='CONFORMAL', margin=float(margin))
      op_succeeded = True
      if _uvs_need_unwrap(target_obj):
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(float(angle_limit_deg)),
            island_margin=float(margin),
        )
    else:
      bpy.ops.uv.smart_project(
          angle_limit=math.radians(float(angle_limit_deg)),
          island_margin=float(margin),
      )
      op_succeeded = True
    bpy.ops.object.mode_set(mode='OBJECT')
  except RuntimeError:
    try:
      if (
          bpy.context.active_object
          and bpy.context.active_object.mode != 'OBJECT'
      ):
        bpy.ops.object.mode_set(mode='OBJECT')
    except RuntimeError:
      pass
  finally:
    target_obj.hide_viewport = prev_hide
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active

  if not op_succeeded or _uvs_need_unwrap(target_obj):
    _bmesh_box_atlas_unwrap(target_obj, margin=float(margin))
  mesh_data.update()
  return target_obj


def smart_uv_project(
    objects: (
        bpy.types.Object
        | str
        | list[bpy.types.Object | str]
        | Sequence[bpy.types.Object | str]
    ),
    *,
    angle_limit_deg: float = 66.0,
    island_margin: float = 0.01,
    margin: float | None = None,
) -> list[bpy.types.Object]:
  """Unwraps each mesh object in `objects` individually into `[0, 1]^2` via `bpy.ops.uv.smart_project`.

  Never packs multiple objects into a shared atlas.
  """
  eff_margin = float(margin if margin is not None else island_margin)
  resolved = _resolve_object_list(objects)
  valid = [o for o in resolved if o.type == 'MESH' and len(o.data.polygons) > 0]
  if not valid:
    return []

  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]

  try:
    for target_obj in valid:
      mesh_data = target_obj.data
      if not mesh_data.uv_layers:
        mesh_data.uv_layers.new(name='UVMap')
      prev_hide = bool(target_obj.hide_viewport)
      target_obj.hide_viewport = False
      op_succeeded = False
      try:
        if (
            bpy.context.active_object
            and bpy.context.active_object.mode != 'OBJECT'
        ):
          bpy.ops.object.mode_set(mode='OBJECT')
        _select_only(target_obj)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_mode(type='FACE')
        bpy.ops.mesh.reveal()
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(float(angle_limit_deg)),
            island_margin=eff_margin,
        )
        op_succeeded = True
        bpy.ops.object.mode_set(mode='OBJECT')
      except RuntimeError:
        try:
          if (
              bpy.context.active_object
              and bpy.context.active_object.mode != 'OBJECT'
          ):
            bpy.ops.object.mode_set(mode='OBJECT')
        except RuntimeError:
          pass
      finally:
        target_obj.hide_viewport = prev_hide

      if not op_succeeded or _uvs_need_unwrap(target_obj):
        _bmesh_box_atlas_unwrap(target_obj, margin=eff_margin)
      mesh_data.update()
  finally:
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active

  return valid


def pack_shared_uv_atlas(
    objs: (
        bpy.types.Object
        | str
        | list[bpy.types.Object | str]
        | Sequence[bpy.types.Object | str]
    ),
    *,
    margin: float = 0.005,
    rotate: bool = True,
    align_minimal_bbox: bool = True,
    match_3d_area: bool = True,
) -> None:
  """Packs UV islands of `1` or more mesh objects into `[0, 1]^2` via Blender C++ operators.

  Uses multi-object edit mode (`bpy.ops.uv.unwrap(method='CONFORMAL')`,
  `bpy.ops.uv.average_islands_scale()`, and `bpy.ops.uv.pack_islands`) while
  preserving custom analytical split normals.
  """
  del align_minimal_bbox  # Handled natively by C++ pack_islands
  resolved = _resolve_object_list(objs)
  valid = [o for o in resolved if o.type == 'MESH' and len(o.data.polygons) > 0]
  if not valid:
    return

  bpy.context.view_layer.update()
  for obj in valid:
    if not obj.data.uv_layers:
      obj.data.uv_layers.new(name='UVMap')
    if _uvs_need_unwrap(obj):
      smart_uv_project([obj], angle_limit_deg=66.0, island_margin=float(margin))

  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]
  prev_hide = {o: bool(o.hide_viewport) for o in valid}

  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')

    for o in bpy.data.objects:
      o.select_set(False)
    for o in valid:
      o.hide_viewport = False
      o.select_set(True)
    bpy.context.view_layer.objects.active = valid[0]

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.reveal()
    bpy.ops.mesh.select_all(action='SELECT')
    try:
      bpy.ops.uv.unwrap(method='CONFORMAL', margin=float(margin))
    except RuntimeError:
      pass
    if match_3d_area:
      try:
        bpy.ops.uv.average_islands_scale()
      except RuntimeError:
        pass
    bpy.ops.uv.pack_islands(
        rotate=bool(rotate),
        rotate_method='CARDINAL',
        scale=True,
        margin=float(margin),
        shape_method='AABB',
    )
    bpy.ops.object.mode_set(mode='OBJECT')
  finally:
    try:
      if (
          bpy.context.active_object
          and bpy.context.active_object.mode != 'OBJECT'
      ):
        bpy.ops.object.mode_set(mode='OBJECT')
    except RuntimeError:
      pass
    for o, h_val in prev_hide.items():
      o.hide_viewport = h_val
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active

  for obj in valid:
    if _uvs_need_unwrap(obj):
      smart_uv_project([obj], angle_limit_deg=66.0, island_margin=float(margin))
    obj.data.update()

  if len(valid) > 1:
    full_span_count = sum(1 for o in valid if _compute_uv_span(o) > 0.65)
    if full_span_count > 1:
      n_objs = len(valid)
      n_cols = max(1, int(math.ceil(math.sqrt(n_objs))))
      n_rows = max(1, int(math.ceil(n_objs / n_cols)))
      cell_w = 1.0 / n_cols
      cell_h = 1.0 / n_rows
      pad = min(0.02, max(0.002, float(margin)))
      for idx, obj in enumerate(valid):
        uv_layer = obj.data.uv_layers.active
        if uv_layer is None or len(uv_layer.data) == 0:
          continue
        us = [float(d.uv.x) for d in uv_layer.data]
        vs = [float(d.uv.y) for d in uv_layer.data]
        umin, umax = min(us), max(us)
        vmin, vmax = min(vs), max(vs)
        du = max(umax - umin, 1e-6)
        dv = max(vmax - vmin, 1e-6)
        col = idx % n_cols
        row = idx // n_cols
        u0 = col * cell_w + pad
        v0 = row * cell_h + pad
        u1 = (col + 1) * cell_w - pad
        v1 = (row + 1) * cell_h - pad
        for d in uv_layer.data:
          d.uv.x = u0 + ((float(d.uv.x) - umin) / du) * max(1e-4, u1 - u0)
          d.uv.y = v0 + ((float(d.uv.y) - vmin) / dv) * max(1e-4, v1 - v0)
        obj.data.update()


def _export_single_object_via_wm_obj(
    target_obj: bpy.types.Object,
    out_obj_path: str,
    *,
    triangulate: bool = True,
    export_uv: bool = True,
    export_normals: bool = True,
    origin_vec: mathutils.Vector | None = None,
) -> None:
  """Exports `target_obj` to `out_obj_path` via Blender C++ `bpy.ops.wm.obj_export`."""
  os.makedirs(os.path.dirname(os.path.abspath(out_obj_path)), exist_ok=True)
  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]
  prev_hide_vp = bool(target_obj.hide_viewport)
  orig_mat = target_obj.matrix_world.copy()

  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')
    target_obj.hide_viewport = False
    if origin_vec is not None and origin_vec.length_squared > 1e-18:
      shifted = orig_mat.copy()
      shifted.translation = orig_mat.translation - origin_vec
      target_obj.matrix_world = shifted
      bpy.context.view_layer.update()

    _select_only(target_obj)
    bpy.ops.wm.obj_export(
        filepath=os.path.abspath(out_obj_path),
        export_selected_objects=True,
        apply_modifiers=True,
        export_triangulated_mesh=bool(triangulate),
        export_uv=bool(export_uv),
        export_normals=bool(export_normals),
        export_materials=False,
        forward_axis='Y',
        up_axis='Z',
    )
  finally:
    target_obj.matrix_world = orig_mat
    target_obj.hide_viewport = prev_hide_vp
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active
    bpy.context.view_layer.update()


def finalize_and_export_obj(
    target_obj: bpy.types.Object,
    out_obj_path: str,
    *,
    crease_deg: float | None = None,
    world_pos: tuple[float, float, float] | None = None,
    body_pos: tuple[float, float, float] | None = None,
    ensure_uvs: bool = True,
    earclip_in_place: bool = False,
) -> dict[str, int]:
  """Syncs normals if needed and exports `.obj` via Blender's C++ `bpy.ops.wm.obj_export`."""
  bpy.context.view_layer.update()
  mesh_data = target_obj.data

  if ensure_uvs and _uvs_need_unwrap(target_obj):
    smart_uv_project([target_obj], angle_limit_deg=66.0, island_margin=0.01)

  n_ngons = sum(1 for poly in mesh_data.polygons if len(poly.vertices) > 4)
  if earclip_in_place and n_ngons > 0:
    bm = bmesh.new()
    bm.from_mesh(mesh_data)
    ngon_faces = [f for f in bm.faces if len(f.verts) > 4]
    if ngon_faces:
      bmesh.ops.triangulate(
          bm, faces=ngon_faces, quad_method='BEAUTY', ngon_method='EAR_CLIP'
      )
    bm.to_mesh(mesh_data)
    bm.free()
    mesh_data.update()

  if crease_deg is not None:
    bm = bmesh.new()
    bm.from_mesh(mesh_data)
    thresh = math.radians(float(crease_deg))
    for edge in bm.edges:
      if len(edge.link_faces) == 2 and edge.calc_face_angle(0.0) > thresh:
        edge.smooth = False
    bm.to_mesh(mesh_data)
    bm.free()
    mesh_data.update()
    _apply_weighted_normals(target_obj, force_smooth=True)
  elif not getattr(mesh_data, 'has_custom_normals', False):
    _apply_weighted_normals(target_obj, force_smooth=False)

  origin_raw = (
      body_pos
      if body_pos is not None
      else (world_pos if world_pos is not None else (0.0, 0.0, 0.0))
  )
  origin_vec = mathutils.Vector(
      (float(origin_raw[0]), float(origin_raw[1]), float(origin_raw[2]))
  )

  _export_single_object_via_wm_obj(
      target_obj,
      out_obj_path,
      triangulate=True,
      export_uv=bool(mesh_data.uv_layers),
      export_normals=True,
      origin_vec=origin_vec,
  )

  n_verts = len(mesh_data.vertices)
  n_quads = sum(1 for p in mesh_data.polygons if len(p.vertices) == 4)
  n_tris = sum(1 for p in mesh_data.polygons if len(p.vertices) == 3)
  return {
      'verts': n_verts,
      'quads': n_quads,
      'tris': n_tris,
      'earclipped_ngons': n_ngons,
  }


def _select_extreme_hull_points(
    pts: Sequence[mathutils.Vector], cap: int
) -> list[mathutils.Vector]:
  """Selects `cap` non-coplanar extreme hull vertices via support + farthest-point sampling."""
  n_pts = len(pts)
  if n_pts <= cap:
    return [p.copy() for p in pts]

  bmin = mathutils.Vector((1e9, 1e9, 1e9))
  bmax = mathutils.Vector((-1e9, -1e9, -1e9))
  for p in pts:
    for k in range(3):
      bmin[k] = min(bmin[k], p[k])
      bmax[k] = max(bmax[k], p[k])
  span = bmax - bmin

  # 1. Seed a non-degenerate 3D simplex so even sub-millimeter thin sheets keep
  #    both opposing faces instead of collapsing to 2D.
  k_max = max(range(3), key=lambda k: float(span[k]))
  i0 = min(range(n_pts), key=lambda i: float(pts[i][k_max]))
  i1 = max(range(n_pts), key=lambda i: float(pts[i][k_max]))
  selected: list[int] = [i0]
  if i1 != i0:
    selected.append(i1)

  d01 = pts[i1] - pts[i0]
  if d01.length > 1e-12:
    d01_u = d01.normalized()
    i2 = max(
        range(n_pts),
        key=lambda i: float((pts[i] - pts[i0]).cross(d01_u).length_squared),
    )
    if i2 not in selected:
      selected.append(i2)
    n_plane = d01.cross(pts[i2] - pts[i0])
    if n_plane.length > 1e-12 and len(selected) < cap:
      n_u = n_plane.normalized()
      i3 = min(range(n_pts), key=lambda i: float((pts[i] - pts[i0]).dot(n_u)))
      i4 = max(range(n_pts), key=lambda i: float((pts[i] - pts[i0]).dot(n_u)))
      for cand in (i3, i4):
        if cand not in selected and len(selected) < cap:
          selected.append(cand)

  # 2. Bbox-whitened coordinates give thin and thick axes equal directional weight.
  inv_span = mathutils.Vector((
      1.0 / max(float(span.x), 1e-9),
      1.0 / max(float(span.y), 1e-9),
      1.0 / max(float(span.z), 1e-9),
  ))
  w_pts = [
      mathutils.Vector((
          (p.x - bmin.x) * inv_span.x,
          (p.y - bmin.y) * inv_span.y,
          (p.z - bmin.z) * inv_span.z,
      ))
      for p in pts
  ]

  support_dirs = [
      (1, 0, 0),
      (-1, 0, 0),
      (0, 1, 0),
      (0, -1, 0),
      (0, 0, 1),
      (0, 0, -1),
      (1, 1, 1),
      (1, 1, -1),
      (1, -1, 1),
      (1, -1, -1),
      (-1, 1, 1),
      (-1, 1, -1),
      (-1, -1, 1),
      (-1, -1, -1),
      (1, 1, 0),
      (1, -1, 0),
      (-1, 1, 0),
      (-1, -1, 0),
      (1, 0, 1),
      (1, 0, -1),
      (-1, 0, 1),
      (-1, 0, -1),
      (0, 1, 1),
      (0, 1, -1),
      (0, -1, 1),
      (0, -1, -1),
  ]
  sel_set = set(selected)
  for dx, dy, dz in support_dirs:
    if len(selected) >= cap:
      break
    d_vec = mathutils.Vector((float(dx), float(dy), float(dz))).normalized()
    best_i = max(range(n_pts), key=lambda i: float(w_pts[i].dot(d_vec)))
    if best_i not in sel_set:
      selected.append(best_i)
      sel_set.add(best_i)

  # 3. Fill remaining budget up to `cap` via greedy farthest-point sampling.
  if len(selected) < cap:
    min_d2 = [1e30] * n_pts
    for s_idx in selected:
      ws = w_pts[s_idx]
      for i in range(n_pts):
        d2 = float((w_pts[i] - ws).length_squared)
        if d2 < min_d2[i]:
          min_d2[i] = d2
    while len(selected) < cap:
      best_i = max(range(n_pts), key=lambda i: min_d2[i])
      if best_i in sel_set or min_d2[best_i] <= 1e-18:
        break
      selected.append(best_i)
      sel_set.add(best_i)
      ws = w_pts[best_i]
      for i in range(n_pts):
        d2 = float((w_pts[i] - ws).length_squared)
        if d2 < min_d2[i]:
          min_d2[i] = d2

  return [pts[i].copy() for i in selected]


def _rebuild_clean_hull_bm(bm: Any, pts: Sequence[mathutils.Vector]) -> float:
  """Rebuilds `bm` as a pure triangulated exterior convex hull and returns 3D volume."""
  bm.clear()
  seen: set[tuple[int, int, int]] = set()
  for p in pts:
    qk = (
        int(round(float(p.x) * 1e8)),
        int(round(float(p.y) * 1e8)),
        int(round(float(p.z) * 1e8)),
    )
    if qk not in seen:
      seen.add(qk)
      bm.verts.new(p)

  if len(bm.verts) < 4:
    return 0.0

  hull_res = bmesh.ops.convex_hull(bm, input=bm.verts[:])
  unused_verts = list({
      ele
      for key in ('geom_interior', 'geom_unused')
      for ele in hull_res.get(key, [])
      if isinstance(ele, bmesh.types.BMVert) and ele.is_valid
  })
  if unused_verts:
    bmesh.ops.delete(bm, geom=unused_verts, context='VERTS')

  if not bm.faces or len(bm.verts) < 4:
    return 0.0

  bmesh.ops.triangulate(bm, faces=bm.faces[:])
  bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
  bm.normal_update()

  bm.verts.ensure_lookup_table()
  ref = bm.verts[0].co
  vol6 = 0.0
  for face in bm.faces:
    if len(face.verts) == 3:
      v0 = face.verts[0].co - ref
      v1 = face.verts[1].co - ref
      v2 = face.verts[2].co - ref
      vol6 += float(v0.dot(v1.cross(v2)))
  return abs(vol6) / 6.0


def _append_object_world_mesh_to_bm(
    bm: Any,
    src_obj: bpy.types.Object,
    depsgraph_holder: list[Any],
    col_name: str,
) -> None:
  """Appends `src_obj`'s mesh (or evaluated curve/surface) into `bm` in world space."""
  v_start = len(bm.verts)
  if src_obj.type == 'MESH' and (
      len(src_obj.data.vertices) > 0 or not src_obj.modifiers
  ):
    bm.from_mesh(src_obj.data)
  elif src_obj.type in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'}:
    if not depsgraph_holder:
      depsgraph_holder.append(bpy.context.evaluated_depsgraph_get())
    eval_obj = src_obj.evaluated_get(depsgraph_holder[0])
    eval_mesh = eval_obj.to_mesh()
    try:
      if eval_mesh is not None:
        bm.from_mesh(eval_mesh)
    finally:
      if eval_mesh is not None:
        eval_obj.to_mesh_clear()
  else:
    raise TypeError(
        f'Unsupported Blender object type {src_obj.type!r} for collision hull '
        f'{col_name!r} (object {src_obj.name!r})'
    )
  bm.verts.ensure_lookup_table()
  new_verts = bm.verts[v_start:]
  if new_verts:
    bmesh.ops.transform(bm, matrix=src_obj.matrix_world, verts=new_verts)


def export_convex_hull_col(
    source_obj_or_points: Any,
    out_obj_path: str,
    *,
    clip_bounds_world_m: tuple[Sequence[float], Sequence[float]] | None = None,
    clip_bounds_m: tuple[Sequence[float], Sequence[float]] | None = None,
    max_verts: int = 64,
    name: str | None = None,
    world_pos: tuple[float, float, float] = (0.0, 0.0, 0.0),
    body_pos: tuple[float, float, float] | None = None,
) -> bpy.types.Object:
  """Builds, plane-clips, caps (`<= max_verts`), validates, and exports a convex hull `.obj`.

  Args:
    source_obj_or_points: One of: 1. A single `bpy.types.Object` (`MESH`, or
      `CURVE`/`SURFACE`/`FONT`/`META` evaluated via `depsgraph.to_mesh()`) or
      `str` object name in `bpy.data.objects`. 2. A sequence of
      `bpy.types.Object | str` (e.g. multi-part rigid-body visual meshes), all
      merged in world space into one `BMesh` before 6-plane `bisect_plane`
      clipping. 3. A sequence of 3D world `(x, y, z)` points in meters.
    out_obj_path: Output `*_col.obj` path.
    clip_bounds_world_m: Optional `(cmin_xyz_m, cmax_xyz_m)` world-space axis-
      aligned clipping box. For mesh/curve objects, runs 6 true 3D half-space
      plane cuts (`bmesh.ops.bisect_plane`) so long edges/faces spanning across
      `cmin..cmax` are cleanly sliced at the boundary.
    clip_bounds_m: Optional keyword alias for `clip_bounds_world_m`.
    max_verts: Maximum hull vertex count (`>= 4`, `64` default matching MuJoCo's
      MJX `maxhullvert` limit).
    name: Optional scene object name (defaults to `out_obj_path` stem).
    world_pos: Body origin `(px, py, pz)` in world meters subtracted from hull
      vertices (`body_pos` overrides `world_pos` if given).
    body_pos: Optional alias overriding `world_pos`.

  Returns:
    Scene collision hull `Object` (`location = origin_vec`, `hide_render =
    True`).

  Raises:
    ValueError: If `max_verts < 4`, `clip_bounds_world_m` is inverted, fewer
      than `4` vertices remain after clipping, or 3D hull volume `<= 1e-12 m^3`.
  """
  cap = int(max_verts)
  if cap < 4:
    raise ValueError(f'max_verts must be >= 4; got {max_verts}')

  pos_ref = body_pos if body_pos is not None else world_pos
  origin_vec = mathutils.Vector(
      (float(pos_ref[0]), float(pos_ref[1]), float(pos_ref[2]))
  )
  col_name = name or os.path.splitext(os.path.basename(out_obj_path))[0]

  effective_clip = (
      clip_bounds_world_m if clip_bounds_world_m is not None else clip_bounds_m
  )
  cmin: tuple[float, float, float] | None = None
  cmax: tuple[float, float, float] | None = None
  if effective_clip is not None:
    if (
        len(effective_clip) == 2
        and isinstance(effective_clip[0], Sequence)
        and not isinstance(effective_clip[0], (str, bytes))
    ):
      raw_min, raw_max = effective_clip
      cmin = (float(raw_min[0]), float(raw_min[1]), float(raw_min[2]))
      cmax = (float(raw_max[0]), float(raw_max[1]), float(raw_max[2]))
    elif len(effective_clip) == 6:
      cmin = (
          float(effective_clip[0]),
          float(effective_clip[1]),
          float(effective_clip[2]),
      )
      cmax = (
          float(effective_clip[3]),
          float(effective_clip[4]),
          float(effective_clip[5]),
      )
    else:
      raise ValueError(
          f'clip_bounds_world_m for {col_name!r} must be '
          '((xmin, ymin, zmin), (xmax, ymax, zmax)) or '
          f'(xmin, ymin, zmin, xmax, ymax, zmax); got {effective_clip!r}'
      )
    for k in range(3):
      if cmin[k] > cmax[k]:
        raise ValueError(
            f'Collision hull {col_name!r} has inverted clip_bounds_world_m '
            f'along axis {k}: {cmin} > {cmax}'
        )

  is_obj_source = False
  raw_obj_list: list[bpy.types.Object | str] = []
  if isinstance(source_obj_or_points, (bpy.types.Object, str)):
    is_obj_source = True
    raw_obj_list = [source_obj_or_points]
  elif hasattr(source_obj_or_points, 'data') and hasattr(
      source_obj_or_points.data, 'vertices'
  ):
    is_obj_source = True
    raw_obj_list = [source_obj_or_points]
  elif isinstance(source_obj_or_points, Sequence) and not isinstance(
      source_obj_or_points, (str, bytes)
  ):
    if source_obj_or_points and isinstance(
        source_obj_or_points[0], (bpy.types.Object, str)
    ):
      is_obj_source = True
      raw_obj_list = list(source_obj_or_points)

  bm = bmesh.new()
  try:
    if is_obj_source:
      bpy.context.view_layer.update()
      resolved_objs = _resolve_object_list(raw_obj_list)
      depsgraph_holder: list[Any] = []
      for src_obj in resolved_objs:
        _append_object_world_mesh_to_bm(bm, src_obj, depsgraph_holder, col_name)
      if cmin is not None and cmax is not None and bm.verts:
        plane_cuts = (
            ((cmin[0], 0.0, 0.0), (-1.0, 0.0, 0.0)),
            ((cmax[0], 0.0, 0.0), (1.0, 0.0, 0.0)),
            ((0.0, cmin[1], 0.0), (0.0, -1.0, 0.0)),
            ((0.0, cmax[1], 0.0), (0.0, 1.0, 0.0)),
            ((0.0, 0.0, cmin[2]), (0.0, 0.0, -1.0)),
            ((0.0, 0.0, cmax[2]), (0.0, 0.0, 1.0)),
        )
        for p_co, p_no in plane_cuts:
          if not bm.verts:
            break
          geom_all = bm.verts[:] + bm.edges[:] + bm.faces[:]
          bmesh.ops.bisect_plane(
              bm,
              geom=geom_all,
              dist=1e-7,
              plane_co=p_co,
              plane_no=p_no,
              clear_outer=True,
              clear_inner=False,
          )
      local_pts = [v.co - origin_vec for v in bm.verts]
    else:
      local_pts = []
      for pt in source_obj_or_points:
        w_pt = mathutils.Vector((float(pt[0]), float(pt[1]), float(pt[2])))
        if cmin is not None and cmax is not None:
          if not (
              cmin[0] - 1e-7 <= w_pt.x <= cmax[0] + 1e-7
              and cmin[1] - 1e-7 <= w_pt.y <= cmax[1] + 1e-7
              and cmin[2] - 1e-7 <= w_pt.z <= cmax[2] + 1e-7
          ):
            continue
        local_pts.append(w_pt - origin_vec)

    if len(local_pts) < 4:
      raise ValueError(
          f'Collision hull {col_name!r} ({out_obj_path!r}) has fewer than 4 '
          f'vertices ({len(local_pts)}) after world clipping '
          f'(clip_bounds_world_m={effective_clip}).'
      )

    vol_m3 = _rebuild_clean_hull_bm(bm, local_pts)
    if len(bm.verts) > cap:
      sampled_pts = _select_extreme_hull_points(
          [v.co.copy() for v in bm.verts], cap
      )
      vol_m3 = _rebuild_clean_hull_bm(bm, sampled_pts)

    if len(bm.verts) < 4 or len(bm.faces) < 4 or vol_m3 <= 1e-12:
      raise ValueError(
          f'Collision hull {col_name!r} ({out_obj_path!r}) is degenerate or '
          f'coplanar: verts={len(bm.verts)}, faces={len(bm.faces)}, '
          f'volume={vol_m3:.3e} m^3 (must exceed 1e-12 m^3; '
          f'clip_bounds_world_m={effective_clip}).'
      )

    old_obj = bpy.data.objects.get(col_name)
    if old_obj is not None:
      old_mesh = old_obj.data if old_obj.type == 'MESH' else None
      bpy.data.objects.remove(old_obj, do_unlink=True)
      if old_mesh is not None and old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)

    mesh_data = bpy.data.meshes.new(col_name)
    bm.to_mesh(mesh_data)
    mesh_data.update()
  finally:
    bm.free()

  col_obj = bpy.data.objects.new(col_name, mesh_data)
  bpy.context.scene.collection.objects.link(col_obj)
  col_obj.location = (origin_vec.x, origin_vec.y, origin_vec.z)
  col_obj.hide_render = True
  bpy.context.view_layer.update()

  _export_single_object_via_wm_obj(
      col_obj,
      out_obj_path,
      triangulate=True,
      export_uv=False,
      export_normals=False,
      origin_vec=origin_vec,
  )
  return col_obj


class _MatBakeRig:
  """Tracks temporary bake nodes and original links for one Blender `Material`."""

  def __init__(self, mat: bpy.types.Material):
    self.mat = mat
    self.nt = mat.node_tree
    self.bsdf = next(
        (n for n in self.nt.nodes if n.type == 'BSDF_PRINCIPLED'), None
    )
    self.out_node = next(
        (n for n in self.nt.nodes if n.type == 'OUTPUT_MATERIAL'), None
    )
    self.orig_surface_sources = (
        [lk.from_socket for lk in self.out_node.inputs['Surface'].links]
        if self.out_node is not None
        else []
    )
    self.orig_active = self.nt.nodes.active
    self.orig_selected = [n for n in self.nt.nodes if n.select]
    self.img_node = self.nt.nodes.new('ShaderNodeTexImage')
    self.emit_node = self.nt.nodes.new('ShaderNodeEmission')

  def activate_target_image(self, img: bpy.types.Image) -> None:
    """Assigns `img` as the sole selected active target node in `self.nt`."""
    self.img_node.image = img
    for node in self.nt.nodes:
      node.select = False
    self.img_node.select = True
    self.nt.nodes.active = self.img_node

  def wire_socket_to_emit(self, socket_name: str) -> None:
    """Routes `Principled BSDF` `socket_name` into `emit_node -> Surface`."""
    for lk in list(self.emit_node.inputs['Color'].links):
      self.nt.links.remove(lk)
    for lk in list(self.out_node.inputs['Surface'].links):
      self.nt.links.remove(lk)

    inp = self.bsdf.inputs[socket_name]
    if inp.is_linked:
      self.nt.links.new(
          inp.links[0].from_socket, self.emit_node.inputs['Color']
      )
    else:
      val = inp.default_value
      if hasattr(val, '__len__'):
        rgba = tuple(float(x) for x in val)
        if len(rgba) == 3:
          rgba = (rgba[0], rgba[1], rgba[2], 1.0)
        self.emit_node.inputs['Color'].default_value = rgba
      else:
        fv = float(val)
        self.emit_node.inputs['Color'].default_value = (fv, fv, fv, 1.0)
    self.nt.links.new(
        self.emit_node.outputs['Emission'], self.out_node.inputs['Surface']
    )

  def restore_surface_links(self) -> None:
    """Restores the original `Principled BSDF -> Surface` links."""
    for lk in list(self.emit_node.inputs['Color'].links):
      self.nt.links.remove(lk)
    for lk in list(self.out_node.inputs['Surface'].links):
      self.nt.links.remove(lk)
    for src_sock in self.orig_surface_sources:
      self.nt.links.new(src_sock, self.out_node.inputs['Surface'])

  def cleanup(self) -> None:
    """Restores original links, selection, and active node and deletes temp nodes."""
    self.restore_surface_links()
    if self.img_node.name in self.nt.nodes:
      self.nt.nodes.remove(self.img_node)
    if self.emit_node.name in self.nt.nodes:
      self.nt.nodes.remove(self.emit_node)
    for node in self.nt.nodes:
      node.select = node in self.orig_selected
    if self.orig_active is not None and self.orig_active.name in self.nt.nodes:
      self.nt.nodes.active = self.orig_active


def _collect_group_materials(
    grp_objs: Sequence[bpy.types.Object],
) -> list[bpy.types.Material]:
  """Collects unique valid `Principled BSDF` materials across all slots of `grp_objs`."""
  mats: list[bpy.types.Material] = []
  seen: set[bpy.types.Material] = set()
  for obj in grp_objs:
    for slot in obj.material_slots:
      mat = slot.material
      if mat is None or mat in seen or mat.node_tree is None:
        continue
      has_bsdf = any(n.type == 'BSDF_PRINCIPLED' for n in mat.node_tree.nodes)
      has_out = any(n.type == 'OUTPUT_MATERIAL' for n in mat.node_tree.nodes)
      if has_bsdf and has_out:
        seen.add(mat)
        mats.append(mat)
  return mats


def bake_pbr_maps(
    out_dir: str,
    *,
    material_groups: (
        dict[str, bpy.types.Object | str | list[bpy.types.Object | str]]
        | Mapping[
            str, bpy.types.Object | str | Sequence[bpy.types.Object | str]
        ]
        | None
    ) = None,
    resolution: int = 1024,
    samples: int = 8,
) -> dict[str, dict[str, str]]:
  """Bakes `Principled BSDF` graphs across all material slots & objects under `Raw` view transform.

  Supports multi-material meshes (`obj.material_slots`) and multi-object shared
  UV atlases (`material_groups`). Uses `scene.view_settings.view_transform =
  'Raw'`
  and `look = 'None'` so roughness, metallic, and bright basecolor values `>
  0.8`
  are never compressed by `'Standard'` / `'AgX'` / `'Filmic'` tone-mapping.
  Saves `basecolor` as sRGB PNG and `roughness`, `metallic`, `normal` as linear
  `Non-Color` PNGs, restoring all scene and shader settings in `finally`.

  Args:
    out_dir: Output directory for `<key>_basecolor.png`, `<key>_roughness.png`,
      `<key>_metallic.png`, and `<key>_normal.png`.
    material_groups: Optional mapping `mat_key -> [obj1, obj2, ...]` (or single
      `bpy.types.Object` / `str` object name) sharing a UV atlas. When `None`,
      bakes each visible mesh object independently.
    resolution: Square bake resolution in pixels (`1024` default).
    samples: Cycles sample count (`8` default).

  Returns:
    Mapping `key -> {'basecolor': path, 'roughness': path, 'metallic': path,
    'normal': path}`.
  """
  out_dir = os.path.abspath(out_dir)
  os.makedirs(out_dir, exist_ok=True)
  bpy.context.view_layer.update()

  vis_objs = [
      obj
      for obj in bpy.data.objects
      if obj.type == 'MESH'
      and not obj.hide_render
      and not obj.name.endswith('_col')
      and '_hull_' not in obj.name
  ]
  vis_set = set(vis_objs)

  groups: dict[str, list[bpy.types.Object]] = {}
  if material_groups is not None:
    for key, objs in material_groups.items():
      resolved_grp = _resolve_object_list(objs)
      valid: list[bpy.types.Object] = []
      for o in resolved_grp:
        if o in vis_set and _collect_group_materials([o]):
          if _uvs_need_unwrap(o):
            smart_uv_project([o], angle_limit_deg=66.0, island_margin=0.01)
          if o.data.uv_layers:
            valid.append(o)
      if valid:
        groups[str(key)] = valid
  else:
    for obj in vis_objs:
      if _collect_group_materials([obj]):
        if _uvs_need_unwrap(obj):
          smart_uv_project([obj], angle_limit_deg=66.0, island_margin=0.01)
        if obj.data.uv_layers:
          groups[obj.name] = [obj]

  if not groups:
    return {}

  scene = bpy.context.scene
  prev_engine = scene.render.engine
  prev_device = scene.cycles.device
  prev_samples = scene.cycles.samples
  prev_denoise = scene.cycles.use_denoising
  prev_margin = scene.render.bake.margin
  prev_use_clear = scene.render.bake.use_clear
  prev_vt = scene.view_settings.view_transform
  prev_look = scene.view_settings.look
  prev_exposure = scene.view_settings.exposure
  prev_gamma = scene.view_settings.gamma
  prev_active = bpy.context.view_layer.objects.active
  prev_selected = [o for o in bpy.data.objects if o.select_get()]

  results: dict[str, dict[str, str]] = {}
  try:
    if bpy.context.active_object and bpy.context.active_object.mode != 'OBJECT':
      bpy.ops.object.mode_set(mode='OBJECT')

    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = max(1, int(samples))
    scene.cycles.use_denoising = False
    scene.render.bake.margin = max(4, int(resolution) // 64)
    scene.view_settings.view_transform = 'Raw'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0

    for key, grp_objs in groups.items():
      mats = _collect_group_materials(grp_objs)
      if not mats:
        continue

      rigs = [_MatBakeRig(mat) for mat in mats]
      try:
        bc_p = os.path.join(out_dir, f'{key}_basecolor.png')
        rg_p = os.path.join(out_dir, f'{key}_roughness.png')
        mt_p = os.path.join(out_dir, f'{key}_metallic.png')
        nm_p = os.path.join(out_dir, f'{key}_normal.png')

        for socket_name, out_p, is_srgb in (
            ('Base Color', bc_p, True),
            ('Roughness', rg_p, False),
            ('Metallic', mt_p, False),
        ):
          bake_img = bpy.data.images.new(
              f'_pbr_emit_{key}_{socket_name}',
              width=int(resolution),
              height=int(resolution),
              alpha=False,
          )
          bake_img.colorspace_settings.name = 'sRGB' if is_srgb else 'Non-Color'
          try:
            for rig in rigs:
              rig.wire_socket_to_emit(socket_name)
              rig.activate_target_image(bake_img)
            for idx, obj in enumerate(grp_objs):
              scene.render.bake.use_clear = idx == 0
              _select_only(obj)
              bpy.ops.object.bake(type='EMIT')
            bake_img.filepath_raw = out_p
            bake_img.file_format = 'PNG'
            bake_img.save()
          finally:
            bpy.data.images.remove(bake_img)

        for rig in rigs:
          rig.restore_surface_links()

        norm_img = bpy.data.images.new(
            f'_pbr_norm_{key}',
            width=int(resolution),
            height=int(resolution),
            alpha=False,
        )
        norm_img.colorspace_settings.name = 'Non-Color'
        try:
          for rig in rigs:
            rig.activate_target_image(norm_img)
          for idx, obj in enumerate(grp_objs):
            scene.render.bake.use_clear = idx == 0
            _select_only(obj)
            bpy.ops.object.bake(
                type='NORMAL',
                normal_space='TANGENT',
                normal_r='POS_X',
                normal_g='POS_Y',
                normal_b='POS_Z',
            )
          norm_img.filepath_raw = nm_p
          norm_img.file_format = 'PNG'
          norm_img.save()
        finally:
          bpy.data.images.remove(norm_img)

        results[key] = {
            'basecolor': bc_p,
            'roughness': rg_p,
            'metallic': mt_p,
            'normal': nm_p,
        }
      finally:
        for rig in rigs:
          rig.cleanup()
  finally:
    scene.render.engine = prev_engine
    scene.cycles.device = prev_device
    scene.cycles.samples = prev_samples
    scene.cycles.use_denoising = prev_denoise
    scene.render.bake.margin = prev_margin
    scene.render.bake.use_clear = prev_use_clear
    scene.view_settings.view_transform = prev_vt
    scene.view_settings.look = prev_look
    scene.view_settings.exposure = prev_exposure
    scene.view_settings.gamma = prev_gamma
    for obj in bpy.data.objects:
      want_sel = obj in prev_selected
      if obj.select_get() != want_sel:
        obj.select_set(want_sel)
    if prev_active is not None and prev_active.name in bpy.data.objects:
      bpy.context.view_layer.objects.active = prev_active

  return results


def _srgb_channel_to_linear(val: float) -> float:
  """Converts a single sRGB channel (`0..255` or `0..1`) to linear RGB (`0..1`)."""
  c = max(0.0, min(1.0, float(val)))
  if c <= 0.04045:
    return c / 12.92
  return ((c + 0.055) / 1.055) ** 2.4


def _srgb_tuple_to_linear_rgba(
    rgb: Sequence[float | int],
) -> tuple[float, float, float, float]:
  """Converts a 3- or 4-tuple in `0..255` sRGB or `0..1` sRGB to linear RGBA."""
  vals = [float(x) for x in rgb]
  scale = 1.0 / 255.0 if max(vals[:3]) > 1.001 else 1.0
  r = _srgb_channel_to_linear(vals[0] * scale)
  g = _srgb_channel_to_linear(vals[1] * scale)
  b = _srgb_channel_to_linear(vals[2] * scale)
  a = (vals[3] * scale) if len(vals) >= 4 else 1.0
  return (r, g, b, max(0.0, min(1.0, a)))


def assign_pbr_material(
    objects: bpy.types.Object | str | Sequence[bpy.types.Object | str],
    name: str | None = None,
    *,
    base_color: Sequence[float | int] | None = None,
    base_color_srgb: Sequence[float | int] = (200, 200, 200),
    roughness: float = 0.4,
    metallic: float = 0.0,
    normal_bump_mm: float = 0.0,
    bump_height_mm: float = 0.0,
    bump_scale: float = 250.0,
) -> bpy.types.Material:
  """Assigns a clean `Principled BSDF` material (from 8-bit `0..255` or `0..1` sRGB) to `objects`.

  Binds per-part materials directly to Blender sub-objects before
  `bmu.bake_pbr_maps`.

  Args:
    objects: Single mesh object/name or list of mesh objects/names.
    name: Optional material name. Defaults to `<first_obj_name>_mat`.
    base_color: Alias for `base_color_srgb` (`0..255` or `0..1` sRGB).
    base_color_srgb: `(R, G, B)` in `0..255` sRGB (e.g. from `rgb_sample_boxes`
      `p50`/`p75`) or `0..1` sRGB. Automatically converted to linear RGB.
    roughness: Scalar surface roughness in `[0, 1]`.
    metallic: Scalar metallic factor in `[0, 1]`.
    normal_bump_mm: Alias for `bump_height_mm` in `mm`.
    bump_height_mm: Optional micro-grain / procedural bump height in `mm`.
    bump_scale: 3D noise scale when `bump_height_mm > 0`.

  Returns:
    The created `bpy.types.Material`.
  """
  objs = _resolve_object_list(objects)
  if not objs:
    raise ValueError(
        f'assign_pbr_material: no matching mesh objects for {objects!r}'
    )
  mat_name = name or f'{objs[0].name}_mat'
  mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
  if mat.node_tree is None:
    mat.use_nodes = True
  nt = mat.node_tree
  nt.nodes.clear()

  out_node = nt.nodes.new('ShaderNodeOutputMaterial')
  bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
  color_arg = base_color if base_color is not None else base_color_srgb
  lin_rgba = _srgb_tuple_to_linear_rgba(color_arg)
  bsdf.inputs['Base Color'].default_value = lin_rgba
  bsdf.inputs['Roughness'].default_value = float(max(0.0, min(1.0, roughness)))
  bsdf.inputs['Metallic'].default_value = float(max(0.0, min(1.0, metallic)))
  nt.links.new(bsdf.outputs['BSDF'], out_node.inputs['Surface'])

  eff_bump_mm = (
      float(normal_bump_mm)
      if float(normal_bump_mm) > 0.0
      else float(bump_height_mm)
  )
  if eff_bump_mm > 0.0:
    bump_node = nt.nodes.new('ShaderNodeBump')
    bump_node.inputs['Strength'].default_value = 1.0
    bump_node.inputs['Distance'].default_value = max(eff_bump_mm, 0.05) * 0.001
    coord_node = nt.nodes.new('ShaderNodeTexCoord')
    noise_node = nt.nodes.new('ShaderNodeTexNoise')
    noise_node.inputs['Scale'].default_value = float(bump_scale)
    noise_node.inputs['Detail'].default_value = 4.0
    noise_node.inputs['Roughness'].default_value = 0.6
    nt.links.new(coord_node.outputs['Object'], noise_node.inputs['Vector'])
    nt.links.new(noise_node.outputs['Fac'], bump_node.inputs['Height'])
    nt.links.new(bump_node.outputs['Normal'], bsdf.inputs['Normal'])

  mat['mujoco_authored_pbr'] = True
  for obj in objs:
    if obj.type == 'MESH' and obj.data is not None:
      obj.data.materials.clear()
      obj.data.materials.append(mat)
      obj.color = lin_rgba
  return mat
