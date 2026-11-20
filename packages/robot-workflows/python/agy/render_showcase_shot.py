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
#     "av>=12.0.0",
#     "mujoco>=3.2.0",
#     "numpy>=1.24.0",
#     "Pillow>=10.0.0",
# ]
# ///

"""Filament PBR Showcase Shot Turntable Video Generator for MuJoCo Assets.

Renders a 360-degree studio turntable video (.mp4) using MuJoCo's Filament PBR
renderer (`mjrf`), automatically sweeping any articulated joints (`hinge` /
`slide`) through their limits, pulsing collision geometry (`group=3`) on and off
to showcase hull fit, and drawing a clean HUD overlay with asset name, physical
dimensions (L x W x H), mass, hull count, and active DoFs.
"""

from collections.abc import Sequence
import glob
import importlib
import math
import os
import subprocess
import sys
import tempfile
from typing import Any

from absl import app
from absl import flags
import mujoco
import numpy as np
from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont

try:
  mjrf: Any = importlib.import_module("mujoco.mjrf")
  filament_renderer: Any = importlib.import_module(
      "mujoco.rendering.filament.renderer"
  )
  _HAS_FILAMENT = True
except ImportError:
  mjrf = None
  filament_renderer = None
  _HAS_FILAMENT = False


def _define_flag_if_absent(
    define_fn: Any, name: str, default: Any, help_str: str, **kwargs: Any
) -> Any:
  if name in flags.FLAGS:
    return flags.FLAGS[name]
  return define_fn(name, default, help_str, **kwargs)


_ASSET = _define_flag_if_absent(
    flags.DEFINE_string,
    "asset",
    None,
    "Path to a local model.xml file.",
)
_XML_PATH_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "xml_path",
    None,
    "Alias for --asset.",
)
_XML_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "xml",
    None,
    "Alias for --asset.",
)
_MODEL_XML_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "model_xml",
    None,
    "Alias for --asset.",
)
_INPUT_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "input",
    None,
    "Alias for --asset.",
)
_BEFORE_XML = _define_flag_if_absent(
    flags.DEFINE_string,
    "before_xml",
    None,
    "Optional path to a 'before' model.xml to render a synchronized"
    " side-by-side BEFORE vs. AFTER video.",
)
_OUTPUT = _define_flag_if_absent(
    flags.DEFINE_string,
    "output",
    None,
    "Output .mp4 video path (e.g. under <ArtifactDir>/).",
)
_OUT_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "out",
    None,
    "Alias for --output.",
)
_OUTPUT_PATH_ALIAS = _define_flag_if_absent(
    flags.DEFINE_string,
    "output_path",
    None,
    "Alias for --output.",
)
_WIDTH = _define_flag_if_absent(
    flags.DEFINE_integer, "width", 960, "Video frame width in pixels."
)
_HEIGHT = _define_flag_if_absent(
    flags.DEFINE_integer, "height", 720, "Video frame height in pixels."
)
_FPS = _define_flag_if_absent(
    flags.DEFINE_integer, "fps", 30, "Frames per second."
)
_DURATION = _define_flag_if_absent(
    flags.DEFINE_float,
    "duration",
    8.0,
    "Total video duration in seconds across 2 turntable orbits.",
)
_CYCLES = _define_flag_if_absent(
    flags.DEFINE_float,
    "articulation_cycles",
    2.0,
    "Number of open/close articulation cycles across the turntable rotation.",
)

# Uniform calm ghost tint used when draping translucent collision hulls over
# textured visual geometry in Chapter 2 (keeps textures clearly readable).
_OVERLAY_GHOST_RGBA = [0.18, 0.85, 0.68, 0.36]

# Distinct semi-transparent palette for isolated per-hull inspection in Chapter 3
_HULL_PALETTE = [
    [0.20, 0.82, 0.45, 0.85],
    [0.25, 0.62, 0.95, 0.85],
    [0.95, 0.55, 0.20, 0.85],
    [0.75, 0.35, 0.92, 0.85],
    [0.20, 0.85, 0.85, 0.85],
    [0.95, 0.32, 0.52, 0.85],
    [0.88, 0.82, 0.22, 0.85],
    [0.45, 0.88, 0.28, 0.85],
]

# Shared neutral studio-grey satin material for untextured mesh shading
# (`group=4`) so pure 3D curvature, edge transitions, and vertex normals read
# cleanly without per-submesh pastel albedo boundaries (`RgbaType::sRGB` [0.45,
# 0.46, 0.47] -> ~18% linear Kodak middle-grey studio clay).
_STUDIO_UNTEXTURED_RGBA = [0.45, 0.46, 0.47, 1.0]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
  """Loads a bold font at `size`, falling back to Pillow's default font."""
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


def _compute_visual_and_collision_bounds(
    model: mujoco.MjModel, data: mujoco.MjData
) -> tuple[np.ndarray, np.ndarray]:
  """Computes world-space [bmin, bmax] across all asset geoms."""
  mins = []
  maxs = []
  for g_id in range(model.ngeom):
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), g_id) or ""
    if gname.startswith("studio_"):
      continue
    pos = np.array(data.geom_xpos[g_id], dtype=np.float64)
    mat = np.array(data.geom_xmat[g_id], dtype=np.float64).reshape(3, 3)
    if (
        model.geom_type[g_id] == mujoco.mjtGeom.mjGEOM_MESH
        and model.geom_dataid[g_id] >= 0
    ):
      m_id = model.geom_dataid[g_id]
      v_adr = model.mesh_vertadr[m_id]
      v_num = model.mesh_vertnum[m_id]
      verts = model.mesh_vert[v_adr : v_adr + v_num] @ mat.T + pos
      mins.append(verts.min(axis=0))
      maxs.append(verts.max(axis=0))
    else:
      half = np.abs(mat) @ np.array(model.geom_aabb[g_id, 3:], dtype=np.float64)
      center = pos + mat @ np.array(model.geom_aabb[g_id, :3], dtype=np.float64)
      mins.append(center - half)
      maxs.append(center + half)
  if not mins:
    return np.array([-0.05, -0.05, 0.0]), np.array([0.05, 0.05, 0.10])
  return np.min(mins, axis=0), np.max(maxs, axis=0)


def _add_custom_numeric(
    spec: mujoco.MjSpec, name: str, data: list[float]
) -> None:
  num = spec.add_numeric()
  num.name = name
  num.size = len(data)
  num.data = data


def _add_custom_text(spec: mujoco.MjSpec, name: str, data: str) -> None:
  txt = spec.add_text()
  txt.name = name
  txt.data = data


def _build_studio_softbox_cubemap_rgb(face_size: int = 128) -> bytes:
  """Synthesizes a 6-face linear-RGB procedural commercial studio softbox cubemap.

  Models a bright product-photography cyclorama light-tent with warm-neutral
  floor bounce (`~0.34..0.42`), a bright 360-degree horizon wrap band
  (`~0.52..0.62`), and a diffused upper light-tent dome (`~0.48..0.68`)
  punctuated by broad overhead, key, fill, and rim softbox panels (`0.95..1.0`)
  so metallic conductors (steel, chrome, aluminum) reflect bright studio
  highlights from every viewing angle while preserving crisp specular ribbons
  and natural gloss-vs-matte contrast on dielectric plastics.

  MuJoCo / Filament cubemap face order (`height = 6 * width`):
    0: +X_gl (+X_mj), 1: -X_gl (-X_mj), 2: +Y_gl (+Z_mj zenith),
    3: -Y_gl (-Z_mj nadir), 4: +Z_gl (-Y_mj), 5: -Z_gl (+Y_mj).

  Args:
    face_size: The width and height of each cubemap face in pixels.

  Returns:
    The 6-face cubemap as a bytes object, suitable for `mjTEXTURE_CUBE`.
  """
  w = int(face_size)
  coords = (2.0 * (np.arange(w, dtype=np.float32) + 0.5) / float(w)) - 1.0
  sc, tc_flip_r = np.meshgrid(coords, -coords, indexing="xy")  # shape (w, w)
  ones = np.ones_like(sc)

  # OpenGL cubemap directions (gx, gy, gz) per face 0..5:
  gl_faces = [
      (ones, tc_flip_r, -sc),  # 0: +X_gl
      (-ones, tc_flip_r, sc),  # 1: -X_gl
      (sc, ones, -tc_flip_r),  # 2: +Y_gl (+Z_mj up)
      (sc, -ones, tc_flip_r),  # 3: -Y_gl (-Z_mj down)
      (sc, tc_flip_r, ones),  # 4: +Z_gl (-Y_mj)
      (-sc, tc_flip_r, -ones),  # 5: -Z_gl (+Y_mj)
  ]

  def _softbox_lobe(
      mx: np.ndarray,
      my: np.ndarray,
      mz: np.ndarray,
      direction: tuple[float, float, float],
      cos_inner: float,
      cos_outer: float,
  ) -> np.ndarray:
    dx, dy, dz = direction
    norm = math.sqrt(dx * dx + dy * dy + dz * dz)
    dot = (mx * (dx / norm)) + (my * (dy / norm)) + (mz * (dz / norm))
    t = np.clip((dot - cos_outer) / max(cos_inner - cos_outer, 1e-4), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)

  face_bufs: list[np.ndarray] = []
  for gx, gy, gz in gl_faces:
    inv_len = 1.0 / np.sqrt(gx * gx + gy * gy + gz * gz)
    # Map OpenGL cubemap ray to MuJoCo Z-up world direction (Rx(+pi/2)):
    mx = gx * inv_len
    my = -gz * inv_len
    mz = gy * inv_len

    # Bright product-photography cyclorama light-tent surround:
    # warm-neutral floor bounce (~0.34..0.42) -> bright horizon wrap band
    # (~0.52..0.62) -> upper light-tent dome (~0.48..0.68), with a localized
    # under-plinth nadir contact shadow pocket directly at -Z.
    up_t = np.clip(0.5 * (mz + 1.0), 0.0, 1.0)
    horiz_band = np.exp(-((mz / 0.32) ** 2))
    nadir_pocket = _softbox_lobe(mx, my, mz, (0.0, 0.0, -1.0), 0.96, 0.84)
    r = 0.34 + 0.16 * up_t + 0.11 * horiz_band - 0.11 * nadir_pocket
    g = 0.35 + 0.17 * up_t + 0.11 * horiz_band - 0.11 * nadir_pocket
    b = 0.37 + 0.19 * up_t + 0.12 * horiz_band - 0.11 * nadir_pocket

    # 1. Broad overhead studio octabox (+Z zenith)
    sb_top = _softbox_lobe(mx, my, mz, (0.10, -0.08, 0.99), 0.85, 0.50)
    # 2. 3/4 upper-front-right key softbox (aligned with studio_key_light)
    sb_key = _softbox_lobe(mx, my, mz, (0.52, -0.46, 0.72), 0.86, 0.54)
    # 3. Opposite rear-left rim strip softbox
    sb_rim = _softbox_lobe(mx, my, mz, (-0.42, 0.68, 0.52), 0.87, 0.58)
    # 4. Broad front-left & rear-right side fill panels so all 6 faces catch
    #    fillets
    sb_fill_a = _softbox_lobe(mx, my, mz, (0.48, 0.66, 0.36), 0.87, 0.58)
    sb_fill_b = _softbox_lobe(mx, my, mz, (-0.64, -0.48, 0.42), 0.88, 0.60)

    r = (
        r
        + 0.48 * sb_top
        + 0.46 * sb_key
        + 0.40 * sb_rim
        + 0.36 * sb_fill_a
        + 0.34 * sb_fill_b
    )
    g = (
        g
        + 0.47 * sb_top
        + 0.45 * sb_key
        + 0.41 * sb_rim
        + 0.37 * sb_fill_a
        + 0.35 * sb_fill_b
    )
    b = (
        b
        + 0.45 * sb_top
        + 0.42 * sb_key
        + 0.43 * sb_rim
        + 0.39 * sb_fill_a
        + 0.37 * sb_fill_b
    )

    rgb_u8 = np.round(
        np.clip(np.stack([r, g, b], axis=-1), 0.0, 1.0) * 255.0
    ).astype(np.uint8)
    face_bufs.append(rgb_u8)

  return np.concatenate(face_bufs, axis=0).tobytes()


_STUDIO_SOFTBOX_CUBEMAP_BYTES: bytes | None = None


def _get_studio_softbox_cubemap_bytes() -> bytes:
  global _STUDIO_SOFTBOX_CUBEMAP_BYTES  # pylint: disable=global-statement
  if _STUDIO_SOFTBOX_CUBEMAP_BYTES is None:
    _STUDIO_SOFTBOX_CUBEMAP_BYTES = _build_studio_softbox_cubemap_rgb(128)
  return _STUDIO_SOFTBOX_CUBEMAP_BYTES


def _prepare_studio_spec(
    asset_path: str,
    *,
    enable_vignette: bool = True,
    exposure: float = 0.0,
    neutral_grade: bool = False,
) -> tuple[mujoco.MjSpec, str, str]:
  """Loads the asset spec and injects studio lighting, skybox, floor & plinth."""
  abs_path = os.path.abspath(asset_path)
  base_dir = os.path.dirname(abs_path)
  cwd_before = os.getcwd()
  try:
    os.chdir(base_dir)
    spec = mujoco.MjSpec.from_file(abs_path)
  finally:
    os.chdir(cwd_before)
  asset_name = spec.modelname or os.path.basename(base_dir)

  # Compile once to inspect bounds so we can place studio lights and plinth.
  cwd_before = os.getcwd()
  try:
    os.chdir(base_dir)
    tmp_model = spec.compile()
    tmp_data = mujoco.MjData(tmp_model)
    mujoco.mj_forward(tmp_model, tmp_data)
    bmin, bmax = _compute_visual_and_collision_bounds(tmp_model, tmp_data)
  finally:
    os.chdir(cwd_before)

  center = 0.5 * (bmin + bmax)
  span = float(max(np.linalg.norm(bmax - bmin), 0.05))
  z_floor = float(bmin[2]) - 0.0004

  # High shadow map, offscreen buffer size & smooth cylinder tessellation.
  spec.visual.global_.offwidth = max(int(_WIDTH.value or 960), 2200)
  spec.visual.global_.offheight = max(int(_HEIGHT.value or 720), 2200)
  spec.visual.quality.shadowsize = 2048
  spec.visual.quality.numslices = 96
  spec.visual.quality.numstacks = 32
  # Keep visual PBR geoms at alpha=1.0 during mjVIS_TRANSPARENT so they use
  # precompiled opaque kPbr shaders while group=3 hulls (rgba alpha=0.52)
  # render as translucent overlays without triggering prepareProgramSlow.
  spec.visual.map.alpha = 1.0

  # Validate that any mesh bound to a material with a normal map has vn and vt.
  normal_mats: set[str] = set()
  for mat in spec.materials:
    try:
      if mat.textures[int(mujoco.mjtTextureRole.mjTEXROLE_NORMAL)]:
        normal_mats.add(mat.name)
    except (IndexError, AttributeError, TypeError):
      pass
  if normal_mats:
    mesh_files = {m.name: getattr(m, "file", "") for m in spec.meshes}
    meshdir = getattr(spec.compiler, "meshdir", "") or ""
    for g in spec.geoms:
      if getattr(g, "material", "") in normal_mats and getattr(
          g, "meshname", ""
      ):
        mfile = mesh_files.get(g.meshname, "")
        if mfile.endswith(".obj"):
          obj_p = os.path.join(base_dir, meshdir, mfile)
          if not os.path.exists(obj_p):
            obj_p = os.path.join(base_dir, mfile)
          if os.path.exists(obj_p):
            has_vn = False
            has_vt = False
            with open(obj_p, "r", encoding="utf-8", errors="ignore") as f_obj:
              for raw_line in f_obj:
                sline = raw_line.split("#", 1)[0].strip()
                if not sline:
                  continue
                tok0 = sline.split(None, 1)[0]
                if tok0 == "vn":
                  has_vn = True
                elif tok0 == "vt":
                  has_vt = True
                if has_vn and has_vt:
                  break
            if not (has_vn and has_vt):
              raise ValueError(
                  f"Mesh '{mfile}' uses normal-mapped material '{g.material}'"
                  " but was exported without vertex normals (vn) or UVs (vt)."
                  " Pass export_normals=True, export_uv=True in"
                  " bpy.ops.wm.obj_export."
              )

  # 1. Studio Gradient Skybox (if not already present)
  has_skybox = any(
      t.type == mujoco.mjtTexture.mjTEXTURE_SKYBOX for t in spec.textures
  )
  if not has_skybox:
    sky = spec.add_texture()
    sky.name = "studio_skybox"
    sky.type = mujoco.mjtTexture.mjTEXTURE_SKYBOX
    sky.builtin = mujoco.mjtBuiltin.mjBUILTIN_GRADIENT
    # Rich studio horizon-to-zenith gradient (slate-blue -> deep slate-indigo).
    sky.rgb1 = [0.28, 0.37, 0.52]
    sky.rgb2 = [0.08, 0.11, 0.17]
    sky.width = 128
    sky.height = 768

  # 2. Procedural 6-Face Commercial Studio Softbox Cubemap IBL (Filament only)
  # Structured overhead/key/fill/rim softbox panels against a calm dark-neutral
  # studio surround preserve natural gloss-vs-matte roughness contrast and
  # specular ribbons along rounded edge fillets.
  if _HAS_FILAMENT:
    ibl_tex = spec.add_texture()
    ibl_tex.name = "studio_ibl_tex"
    ibl_tex.type = mujoco.mjtTexture.mjTEXTURE_CUBE
    ibl_tex.builtin = mujoco.mjtBuiltin.mjBUILTIN_NONE
    ibl_tex.colorspace = mujoco.mjtColorSpace.mjCOLORSPACE_LINEAR
    ibl_tex.width = 128
    ibl_tex.height = 768
    ibl_tex.nchannel = 3
    ibl_tex.data = _get_studio_softbox_cubemap_bytes()

    ibl_light = spec.worldbody.add_light()
    ibl_light.name = "studio_ibl_light"
    ibl_light.type = mujoco.mjtLightType.mjLIGHT_IMAGE
    ibl_light.texture = "studio_ibl_tex"
    ibl_light.intensity = 28000.0

  # 3. Two-Tier Chamfered Studio Turntable Plinth + Reflective Studio Floor
  top_h = max(span * 0.011, 0.0018)
  ring_h = max(span * 0.007, 0.0012)
  base_h = max(span * 0.014, 0.0022)
  platter_r = span * 0.68

  platter_mat = spec.add_material()
  platter_mat.name = "studio_platter_mat"
  platter_mat.rgba = [0.36, 0.40, 0.46, 1.0]
  platter_mat.metallic = 0.12
  platter_mat.roughness = 0.32
  platter_mat.specular = 0.65

  ring_mat = spec.add_material()
  ring_mat.name = "studio_ring_mat"
  ring_mat.rgba = [0.40, 0.50, 0.64, 1.0]
  ring_mat.metallic = 0.78
  ring_mat.roughness = 0.22
  ring_mat.specular = 0.90

  base_mat = spec.add_material()
  base_mat.name = "studio_base_mat"
  base_mat.rgba = [0.12, 0.14, 0.19, 1.0]
  base_mat.metallic = 0.25
  base_mat.roughness = 0.38
  base_mat.specular = 0.55

  # Top turntable stage
  ped_top = spec.worldbody.add_geom()
  ped_top.name = "studio_pedestal_top"
  ped_top.type = mujoco.mjtGeom.mjGEOM_CYLINDER
  ped_top.size = [platter_r, top_h, 0.0]
  ped_top.pos = [float(center[0]), float(center[1]), z_floor - top_h]
  ped_top.material = "studio_platter_mat"
  ped_top.contype = 0
  ped_top.conaffinity = 0
  ped_top.group = 0

  # Brushed metallic accent bevel ring
  ped_ring = spec.worldbody.add_geom()
  ped_ring.name = "studio_pedestal_ring"
  ped_ring.type = mujoco.mjtGeom.mjGEOM_CYLINDER
  ped_ring.size = [platter_r * 1.024, ring_h, 0.0]
  ped_ring.pos = [float(center[0]), float(center[1]), z_floor - top_h * 1.15]
  ped_ring.material = "studio_ring_mat"
  ped_ring.contype = 0
  ped_ring.conaffinity = 0
  ped_ring.group = 0

  # Lower wider plinth base
  z_base_center = z_floor - 2.0 * top_h - base_h
  ped_base = spec.worldbody.add_geom()
  ped_base.name = "studio_pedestal_base"
  ped_base.type = mujoco.mjtGeom.mjGEOM_CYLINDER
  ped_base.size = [platter_r * 1.10, base_h, 0.0]
  ped_base.pos = [float(center[0]), float(center[1]), z_base_center]
  ped_base.material = "studio_base_mat"
  ped_base.contype = 0
  ped_base.conaffinity = 0
  ped_base.group = 0

  # Infinite reflective studio floor right at the bottom of the plinth base
  floor_tex = spec.add_texture()
  floor_tex.name = "studio_floor_tex"
  floor_tex.type = mujoco.mjtTexture.mjTEXTURE_2D
  floor_tex.builtin = mujoco.mjtBuiltin.mjBUILTIN_CHECKER
  floor_tex.mark = mujoco.mjtMark.mjMARK_EDGE
  floor_tex.rgb1 = [0.14, 0.17, 0.23]
  floor_tex.rgb2 = [0.17, 0.20, 0.27]
  floor_tex.markrgb = [0.22, 0.27, 0.35]
  floor_tex.width = 512
  floor_tex.height = 512

  tile_freq = float(np.clip(2.5 / max(span, 0.06), 2.0, 40.0))
  floor_mat = spec.add_material()
  floor_mat.name = "studio_floor_mat"
  floor_mat.textures[int(mujoco.mjtTextureRole.mjTEXROLE_RGB)] = (
      "studio_floor_tex"
  )
  floor_mat.texuniform = True
  floor_mat.texrepeat = [tile_freq, tile_freq]
  floor_mat.reflectance = 0.08
  floor_mat.roughness = 0.36
  floor_mat.metallic = 0.06
  floor_mat.specular = 0.55

  z_ground = z_base_center - base_h
  floor_geom = spec.worldbody.add_geom()
  floor_geom.name = "studio_floor"
  floor_geom.type = mujoco.mjtGeom.mjGEOM_PLANE
  floor_geom.size = [0.0, 0.0, max(span * 0.25, 0.02)]
  floor_geom.pos = [float(center[0]), float(center[1]), z_ground]
  floor_geom.material = "studio_floor_mat"
  floor_geom.contype = 0
  floor_geom.conaffinity = 0
  floor_geom.group = 0

  # 4. Physical 4-Point Studio Lighting Rig (Key + Fill + Rim + Floor Bounce)
  key_dist = max(span * 3.2, 0.55)
  key_dir = np.array([-0.52, 0.46, -0.72], dtype=np.float64)
  key_dir /= np.linalg.norm(key_dir)
  key_pos = center - key_dir * key_dist
  key_light = spec.worldbody.add_light()
  key_light.name = "studio_key_light"
  key_light.type = (
      mujoco.mjtLightType.mjLIGHT_SPOT
      if _HAS_FILAMENT
      else mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
  )
  key_light.pos = [float(key_pos[0]), float(key_pos[1]), float(key_pos[2])]
  key_light.dir = [float(key_dir[0]), float(key_dir[1]), float(key_dir[2])]
  key_light.castshadow = True
  if _HAS_FILAMENT:
    key_light.cutoff = 45.0
    key_light.softness = 0.70
    key_light.range = key_dist * 4.0
    key_light.bulbradius = 0.03
    key_light.diffuse = [1.00, 0.96, 0.90]
    key_light.intensity = float(48000.0 * (key_dist**2))
  else:
    key_light.diffuse = [0.82, 0.80, 0.76]
    key_light.specular = [0.45, 0.45, 0.45]

  fill_light = spec.worldbody.add_light()
  fill_light.name = "studio_fill_light"
  fill_light.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
  fill_light.dir = [0.58, 0.45, -0.48]
  fill_light.castshadow = False
  fill_light.diffuse = (
      [0.76, 0.84, 0.98] if _HAS_FILAMENT else [0.38, 0.44, 0.54]
  )
  if _HAS_FILAMENT:
    fill_light.intensity = 7200.0

  rim_light = spec.worldbody.add_light()
  rim_light.name = "studio_rim_light"
  rim_light.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
  rim_light.dir = [0.34, -0.72, -0.56]
  rim_light.castshadow = False
  rim_light.diffuse = (
      [1.00, 0.93, 0.84] if _HAS_FILAMENT else [0.42, 0.38, 0.34]
  )
  if _HAS_FILAMENT:
    rim_light.intensity = 15500.0

  bounce_light = spec.worldbody.add_light()
  bounce_light.name = "studio_bounce_light"
  bounce_light.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
  bounce_light.dir = [-0.22, 0.26, 0.94]
  bounce_light.castshadow = False
  bounce_light.diffuse = (
      [0.92, 0.94, 0.98] if _HAS_FILAMENT else [0.22, 0.24, 0.28]
  )
  if _HAS_FILAMENT:
    bounce_light.intensity = 5200.0

  # 5. Filament Post-Processing, Shadows & Color Grading
  # Note: Do NOT enable `filament.fog.*` here. In Filament's LocalProgramCache,
  # the FOG shader variant bit is stripped only for opaque draw commands
  # (`!isBlendingCommand`), so enabling scene fog causes `prepareProgramSlow()`
  # to SIGABRT whenever a transparent material (`rgba[3] < 1.0`) or the Phase 2
  # `mjVIS_TRANSPARENT = 1` collision overlay is rendered.
  _add_custom_text(spec, "filament.shadows.type", "pcf")
  _add_custom_numeric(spec, "filament.shadows.map_size", [2048.0])
  _add_custom_numeric(spec, "filament.ao.enabled", [1.0])
  _add_custom_text(spec, "filament.ao.quality", "high")
  _add_custom_numeric(spec, "filament.ao.ssct", [0.0])
  _add_custom_numeric(spec, "filament.bloom.enabled", [1.0])
  _add_custom_numeric(
      spec, "filament.bloom.strength", [0.02 if neutral_grade else 0.03]
  )
  _add_custom_numeric(
      spec, "filament.vignette.enabled", [1.0 if enable_vignette else 0.0]
  )
  _add_custom_numeric(spec, "filament.vignette.midpoint", [0.80])
  _add_custom_text(spec, "filament.cg.tone_mapping", "aces")
  _add_custom_numeric(spec, "filament.cg.exposure", [float(exposure)])
  _add_custom_numeric(
      spec, "filament.cg.contrast", [1.0 if neutral_grade else 1.06]
  )
  _add_custom_numeric(
      spec, "filament.cg.vibrance", [1.0 if neutral_grade else 1.08]
  )

  return spec, base_dir, asset_name


_PHASE_CHAPTERS = (
    (0.00, 0.50, "1. Textured Visual (360°)", (70, 175, 250)),
    (0.50, 0.78, "2. +Collider Overlay", (50, 215, 165)),
    (0.78, 1.00, "3. Collision Hulls", (245, 165, 45)),
)


def _compute_showcase_frame_state(
    t_norm: float,
    *,
    use_filament: bool = True,
    has_colliders: bool = True,
    fade_half: float = 0.022,
) -> dict[str, Any]:
  """Computes turntable orbit angle, chapter metadata, and cross-fade weights.

  Orbit 1 (`0.00 <= t_norm < 0.50`) completes a full uninterrupted 360-degree
  textured visual rotation. Orbit 2 (`0.50 <= t_norm <= 1.00`) sweeps a second
  360-degree rotation transitioning smoothly via an alpha cross-dissolve into
  the translucent collider overlay (`0.50..0.78`) and isolated per-hull
  collision geometry (`0.78..1.00`).
  """
  t = float(np.clip(t_norm, 0.0, 1.0))
  renderer_tag = "Filament PBR" if use_filament else "MuJoCo PBR"
  phase_specs = (
      {
          "badge": "1/3 · TEXTURED VISUAL (360°)",
          "banner": (
              f"Textured {renderer_tag} Visual Mesh — Full 360° surface &"
              " material showcase"
          ),
          "color": (70, 175, 250),
      },
      {
          "badge": "2/3 · VISUAL + COLLIDER OVERLAY",
          "banner": (
              "Physics Collider Overlay — Translucent ghost hulls shown over"
              " textured mesh"
          ),
          "color": (50, 215, 165),
      },
      {
          "badge": "3/3 · COLLISION HULLS ONLY",
          "banner": (
              "Physics Collision Hulls Only — Simplified convex shapes used for"
              " contact"
          ),
          "color": (245, 165, 45),
      },
  )

  if not has_colliders:
    az_single = (135.0 + 360.0 * t) % 360.0
    return {
        "phase_idx": 0,
        "next_phase_idx": 0,
        "blend_alpha": 0.0,
        "badge_label": "TEXTURED VISUAL (360°)",
        "banner_text": phase_specs[0]["banner"],
        "phase_color": phase_specs[0]["color"],
        "azimuth_cam_deg": az_single,
        "orbit_index": 1,
        "orbit_total": 1,
        "orbit_deg": 360.0 * t,
        "has_colliders": False,
    }

  orbit_index = 1 if t < 0.50 else 2
  orbit_deg = (t / 0.50) * 360.0 if t < 0.50 else ((t - 0.50) / 0.50) * 360.0
  azimuth_cam_deg = (135.0 + 720.0 * t) % 360.0

  if t < 0.50:
    phase_idx = 0
  elif t < 0.78:
    phase_idx = 1
  else:
    phase_idx = 2

  next_phase_idx = phase_idx
  blend_alpha = 0.0
  if fade_half > 0.0:
    for boundary, src_p, dst_p in ((0.50, 0, 1), (0.78, 1, 2)):
      if (boundary - fade_half) <= t < (boundary + fade_half):
        s = (t - (boundary - fade_half)) / (2.0 * fade_half)
        s = float(np.clip(s, 0.0, 1.0))
        blend_alpha = s * s * (3.0 - 2.0 * s)
        next_phase_idx = dst_p
        # Switch displayed HUD chapter label at the midpoint of the cross-fade.
        phase_idx = dst_p if s >= 0.5 else src_p
        break

  return {
      "phase_idx": phase_idx,
      "next_phase_idx": next_phase_idx,
      "blend_alpha": blend_alpha,
      "badge_label": phase_specs[phase_idx]["badge"],
      "banner_text": phase_specs[phase_idx]["banner"],
      "phase_color": phase_specs[phase_idx]["color"],
      "azimuth_cam_deg": azimuth_cam_deg,
      "orbit_index": orbit_index,
      "orbit_total": 2,
      "orbit_deg": orbit_deg,
      "has_colliders": True,
  }


def _blend_rgb_frames(
    frame_a: np.ndarray, frame_b: np.ndarray, alpha: float
) -> np.ndarray:
  """Linearly cross-dissolves two uint8 RGB frames."""
  a = float(np.clip(alpha, 0.0, 1.0))
  if a <= 0.0:
    return frame_a
  if a >= 1.0:
    return frame_b
  blended = (1.0 - a) * frame_a.astype(np.float32) + a * frame_b.astype(
      np.float32
  )
  return np.clip(np.round(blended), 0.0, 255.0).astype(np.uint8)


def _draw_hud_overlay(
    frame_rgb: np.ndarray,
    *,
    asset_name: str,
    dims_mm: tuple[float, float, float],
    mass_kg: float,
    num_vis: int,
    num_col: int,
    joint_info: list[tuple[str, float, str]],
    phase_label: str,
    phase_color: tuple[int, int, int],
    progress: float,
    azimuth_deg: float,
    banner_text: str = "",
    orbit_index: int = 1,
    orbit_total: int = 1,
) -> np.ndarray:
  """Draws a studio HUD overlay with metadata card, callout banner, and chapters."""
  img = Image.fromarray(frame_rgb).convert("RGBA")
  overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
  draw = ImageDraw.Draw(overlay)
  w, h = img.size

  font_title = _load_font(19)
  font_body = _load_font(13)
  font_badge = _load_font(13)
  font_small = _load_font(12)

  # 1. Top-left Asset Metadata Card
  card_x, card_y = 18, 18
  card_w = min(395, max(260, w - 36))
  card_h = 94 + (20 * len(joint_info) if joint_info else 18)
  draw.rounded_rectangle(
      [(card_x, card_y), (card_x + card_w, card_y + card_h)],
      radius=10,
      fill=(15, 18, 24, 212),
      outline=(65, 75, 92, 180),
      width=1,
  )
  draw.rounded_rectangle(
      [(card_x, card_y), (card_x + 5, card_y + card_h)],
      radius=3,
      fill=(phase_color[0], phase_color[1], phase_color[2], 240),
  )

  draw.text(
      (card_x + 16, card_y + 11),
      asset_name,
      font=font_title,
      fill=(242, 246, 252, 255),
  )

  lx, ly, lz = dims_mm
  if max(lx, ly, lz) >= 1000.0:
    dim_str = f"Size (L×W×H): {lx/10.0:.1f} × {ly/10.0:.1f} × {lz/10.0:.1f} cm"
  else:
    dim_str = f"Size (L×W×H): {lx:.1f} × {ly:.1f} × {lz:.1f} mm"
  draw.text(
      (card_x + 16, card_y + 38),
      dim_str,
      font=font_body,
      fill=(185, 196, 212, 255),
  )

  mass_str = f"{mass_kg*1000.0:.0f} g" if mass_kg < 1.0 else f"{mass_kg:.2f} kg"
  spec_str = (
      f"Mass: {mass_str}   |   Visual: {num_vis}   |   Colliders: {num_col}"
  )
  draw.text(
      (card_x + 16, card_y + 58),
      spec_str,
      font=font_body,
      fill=(165, 178, 196, 255),
  )

  if joint_info:
    for idx, (jname, jval, junit) in enumerate(joint_info):
      j_str = f"DoF [{jname}]: {jval:+.1f}{junit}"
      draw.text(
          (card_x + 16, card_y + 78 + idx * 20),
          j_str,
          font=font_body,
          fill=(110, 225, 165, 255),
      )
  else:
    draw.text(
        (card_x + 16, card_y + 78),
        "Articulation: Rigid Body (0 internal DoF)",
        font=font_body,
        fill=(135, 148, 166, 255),
    )

  # 2. Top-right Chapter Mode Pill & Orbit Angle Indicator
  badge_w = min(304, max(210, w - card_w - 48))
  badge_h = 36
  bx = w - badge_w - 18
  by = 18
  draw.rounded_rectangle(
      [(bx, by), (bx + badge_w, by + badge_h)],
      radius=8,
      fill=(15, 18, 24, 218),
      outline=(phase_color[0], phase_color[1], phase_color[2], 230),
      width=2,
  )
  draw.ellipse(
      [(bx + 12, by + 12), (bx + 22, by + 22)],
      fill=(phase_color[0], phase_color[1], phase_color[2], 255),
  )
  draw.text(
      (bx + 30, by + 10),
      phase_label,
      font=font_badge,
      fill=(242, 246, 252, 255),
  )

  orbit_txt = f"Orbit {orbit_index}/{orbit_total} · {azimuth_deg:05.1f}°"
  orbit_w = 166
  draw.rounded_rectangle(
      [(w - orbit_w - 18, by + badge_h + 6), (w - 18, by + badge_h + 30)],
      radius=6,
      fill=(15, 18, 24, 195),
      outline=(65, 75, 92, 165),
      width=1,
  )
  draw.text(
      (w - orbit_w - 8, by + badge_h + 10),
      orbit_txt,
      font=font_small,
      fill=(215, 226, 242, 245),
  )

  # 3. Bottom-center Lower-Third Mode Callout Banner (in viewer focal area)
  bar_y = h - 38
  if banner_text:
    banner_w = min(650, max(280, w - 36))
    banner_h = 34
    ban_x = (w - banner_w) // 2
    ban_y = bar_y - banner_h - 10
    draw.rounded_rectangle(
        [(ban_x, ban_y), (ban_x + banner_w, ban_y + banner_h)],
        radius=8,
        fill=(15, 18, 24, 224),
        outline=(phase_color[0], phase_color[1], phase_color[2], 220),
        width=1,
    )
    draw.rounded_rectangle(
        [(ban_x, ban_y), (ban_x + 5, ban_y + banner_h)],
        radius=3,
        fill=(phase_color[0], phase_color[1], phase_color[2], 245),
    )
    draw.ellipse(
        [(ban_x + 15, ban_y + 12), (ban_x + 25, ban_y + 22)],
        fill=(phase_color[0], phase_color[1], phase_color[2], 255),
    )
    draw.text(
        (ban_x + 33, ban_y + 9),
        banner_text,
        font=font_body,
        fill=(240, 244, 250, 255),
    )

  # 4. Bottom 3-Segment Chapter Timeline Bar
  bar_margin = 18
  bar_h = 22
  total_bar_w = max(120, w - 2 * bar_margin)
  p_clamped = float(np.clip(progress, 0.0, 1.0))

  if num_col > 0:
    seg_gap = 6
    usable_w = total_bar_w - seg_gap * (len(_PHASE_CHAPTERS) - 1)
    for idx, (s0, s1, seg_lbl, seg_col) in enumerate(_PHASE_CHAPTERS):
      sx0 = bar_margin + int(round(s0 * usable_w)) + idx * seg_gap
      sx1 = bar_margin + int(round(s1 * usable_w)) + idx * seg_gap
      seg_w = max(24, sx1 - sx0)
      is_active = (s0 <= p_clamped < s1) or (
          idx == len(_PHASE_CHAPTERS) - 1 and p_clamped >= s1
      )
      draw.rounded_rectangle(
          [(sx0, bar_y), (sx0 + seg_w, bar_y + bar_h)],
          radius=5,
          fill=(20, 24, 32, 205),
          outline=(
              (seg_col[0], seg_col[1], seg_col[2], 235)
              if is_active
              else (65, 75, 92, 160)
          ),
          width=2 if is_active else 1,
      )
      if p_clamped > s0:
        local_frac = float(np.clip((p_clamped - s0) / max(s1 - s0, 1e-6), 0.0, 1.0))
        fill_seg_w = max(8, int(round(seg_w * local_frac)))
        draw.rounded_rectangle(
            [(sx0, bar_y), (sx0 + fill_seg_w, bar_y + bar_h)],
            radius=5,
            fill=(
                seg_col[0],
                seg_col[1],
                seg_col[2],
                145 if is_active else 85,
            ),
        )
      if seg_w >= 110:
        draw.text(
            (sx0 + 10, bar_y + 4),
            seg_lbl,
            font=font_small,
            fill=(245, 248, 252, 255) if is_active else (180, 192, 208, 220),
        )
  else:
    draw.rounded_rectangle(
        [(bar_margin, bar_y), (bar_margin + total_bar_w, bar_y + bar_h)],
        radius=5,
        fill=(20, 24, 32, 205),
        outline=(phase_color[0], phase_color[1], phase_color[2], 220),
        width=1,
    )
    fill_w = max(8, int(round(total_bar_w * p_clamped)))
    draw.rounded_rectangle(
        [(bar_margin, bar_y), (bar_margin + fill_w, bar_y + bar_h)],
        radius=5,
        fill=(phase_color[0], phase_color[1], phase_color[2], 145),
    )
    draw.text(
        (bar_margin + 10, bar_y + 4),
        "Textured Visual (360°)",
        font=font_small,
        fill=(245, 248, 252, 255),
    )

  composited = Image.alpha_composite(img, overlay).convert("RGB")
  return np.asarray(composited, dtype=np.uint8)


def _register_filament_vfs_providers() -> bool:
  """Registers `filament:` / `font:` VFS providers via MuJoCo's window module."""
  for mod_name in (
      "mujoco.studio.window",
      "mujoco.experimental.studio.window",
  ):
    try:
      importlib.import_module(mod_name)
      return True
    except (ImportError, OSError):
      continue
  return False


def _create_filament_context() -> Any:
  """Creates an offscreen mjrf.Context across macOS, GPU, and headless Linux."""
  if not _HAS_FILAMENT or mjrf is None:
    return None

  # Without registered `filament:` / `font:` VFS resource providers
  # (`pbr.filamat`, etc.), `mjrf.Context` triggers a fatal C `mju_error`.
  if not _register_filament_vfs_providers():
    return None

  if sys.platform == "darwin":
    # On macOS, Filament allocates its own offscreen NSOpenGLContext via
    # PlatformCocoaGL; falling through to Vulkan without a loader aborts in
    # C++ rather than raising a Python exception.
    configs = [
        mjrf.ContextConfig(graphics_api=mjrf.GraphicsApi.GRAPHICS_API_OPENGL)
    ]
  else:
    configs = [
        mjrf.ContextConfig(graphics_api=mjrf.GraphicsApi.GRAPHICS_API_DEFAULT),
        mjrf.ContextConfig(graphics_api=mjrf.GraphicsApi.GRAPHICS_API_OPENGL),
        mjrf.ContextConfig(
            graphics_api=mjrf.GraphicsApi.GRAPHICS_API_VULKAN,
            software_rendering=False,
        ),
        mjrf.ContextConfig(
            graphics_api=mjrf.GraphicsApi.GRAPHICS_API_VULKAN,
            software_rendering=True,
        ),
    ]
  for cfg in configs:
    try:
      return mjrf.Context(cfg)
    except Exception:  # pylint: disable=broad-exception-caught
      continue
  return None


def _get_filament_view_and_buf(
    renderer_bundle: dict[str, Any], vw: int, vh: int
) -> tuple[Any, np.ndarray]:
  """Returns (or lazily creates) a cached Filament View & RGB target buffer."""
  targets_cache = renderer_bundle["targets_cache"]
  key = (int(vw), int(vh))
  if key not in targets_cache:
    t_name = "out_buf" if not targets_cache else f"out_buf_{key[0]}x{key[1]}"
    v_obj = filament_renderer.View(
        scene="studio",
        target=t_name,
        headlight=True,
        headlight_color=(0.96, 0.98, 1.00),
        headlight_intensity=float(
            renderer_bundle.get("headlight_intensity", 1400.0)
        ),
    )
    b_arr = np.empty((key[1], key[0], 3), dtype=np.uint8)
    renderer_bundle["renderer"].target(t_name, b_arr)
    targets_cache[key] = (v_obj, b_arr)
  return targets_cache[key]


def _create_filament_renderer(
    model: mujoco.MjModel,
    width: int | None = 960,
    height: int | None = 720,
    *,
    headlight_intensity: float = 1400.0,
) -> dict[str, Any]:
  """Creates a Filament PBR renderer bundle (with classic OpenGL fallback)."""
  ctx = _create_filament_context()
  use_filament = (
      ctx is not None and filament_renderer is not None and mjrf is not None
  )
  targets_cache: dict[tuple[int, int], tuple[Any, np.ndarray]] = {}
  gl_renderers_cache: dict[tuple[int, int], mujoco.Renderer] = {}

  if use_filament:
    ctx.set_clear_color([0.07, 0.08, 0.11])
    r = filament_renderer.Renderer(ctx)
    scn = r.scene("studio")
    scn.configure_from_model(model)
    resources = mjrf.ModelResources(ctx, model)
    lights = mjrf.ModelLights(scn, resources)
    renderables = mjrf.ModelRenderables(scn, resources)
    bundle: dict[str, Any] = {
        "use_filament": True,
        "ctx": ctx,
        "renderer": r,
        "scene": scn,
        "resources": resources,
        "lights": lights,
        "renderables": renderables,
        "headlight_intensity": float(headlight_intensity),
        "targets_cache": targets_cache,
        "gl_renderers_cache": gl_renderers_cache,
    }
    if width is not None and height is not None:
      _get_filament_view_and_buf(bundle, width, height)
    return bundle

  if width is not None and height is not None:
    gl_key = (int(width), int(height))
    gl_renderers_cache[gl_key] = mujoco.Renderer(
        model, height=gl_key[1], width=gl_key[0]
    )
  return {
      "use_filament": False,
      "ctx": None,
      "renderer": None,
      "scene": None,
      "resources": None,
      "lights": None,
      "renderables": None,
      "headlight_intensity": float(headlight_intensity),
      "targets_cache": targets_cache,
      "gl_renderers_cache": gl_renderers_cache,
  }


def _render_rgb(
    renderer_bundle: dict[str, Any],
    model: mujoco.MjModel,
    data: mujoco.MjData,
    vcam: mujoco.MjvCamera,
    opt: mujoco.MjvOption | None = None,
    *,
    width: int | None = None,
    height: int | None = None,
) -> np.ndarray:
  """Renders a single RGB frame from `renderer_bundle` and returns a copy."""
  if opt is None:
    opt = mujoco.MjvOption()
    mujoco.mjv_defaultOption(opt)
  if renderer_bundle.get("use_filament", False):
    targets_cache = renderer_bundle["targets_cache"]
    if width is not None and height is not None:
      cur_view, cur_buf = _get_filament_view_and_buf(
          renderer_bundle, width, height
      )
    else:
      cur_view, cur_buf = next(iter(targets_cache.values()))
    renderables = renderer_bundle["renderables"]
    lights = renderer_bundle["lights"]
    r = renderer_bundle["renderer"]
    renderables.set_options(opt)
    lights.update(data)
    renderables.update(data)
    cur_view.camera = mujoco.mjv_camera2GLCamera(model, data, vcam)
    r.render([cur_view])
    return cur_buf.copy()

  gl_cache = renderer_bundle["gl_renderers_cache"]
  if width is not None and height is not None:
    gl_key = (int(width), int(height))
    if gl_key not in gl_cache:
      gl_cache[gl_key] = mujoco.Renderer(
          model, height=gl_key[1], width=gl_key[0]
      )
    gl_renderer = gl_cache[gl_key]
  else:
    gl_renderer = next(iter(gl_cache.values()))
  gl_renderer.update_scene(data, camera=vcam, scene_option=opt)
  return gl_renderer.render().copy()


# Canonical camera view presets in UP_POSZ_FORWARD_POSX_RIGHT_NEGY:
# Note: In MuJoCo MjvCamera, azimuth=0 places the camera at -X looking toward +X
# (seeing the BACK -X face), while azimuth=180 places the camera at +X looking
# toward -X (seeing the FRONT +X face).
CANONICAL_VIEW_PRESETS: dict[str, tuple[str, float, float]] = {
    "front_pos_x": ("Front (+X)", 180.0, -18.0),
    "back_neg_x": ("Back (-X)", 0.0, -18.0),
    "right_neg_y": ("Right (-Y)", 90.0, -18.0),
    "left_pos_y": ("Left (+Y)", 270.0, -18.0),
    "top_pos_z": ("Top (+Z)", 180.0, -88.0),
    "bottom_neg_z": ("Bottom (-Z)", 180.0, 88.0),
    "iso_front_right": ("3/4 Front-Right (+X/-Y)", 135.0, -25.0),
    "iso_front_left": ("3/4 Front-Left (+X/+Y)", 225.0, -25.0),
}


def _attach_clay_clones(spec: mujoco.MjSpec) -> int:
  """Attaches uniform neutral studio-grey satin clones of visual geoms in group=4."""
  if not any(m.name == "_studio_untextured_mat" for m in spec.materials):
    untex_mat = spec.add_material()
    untex_mat.name = "_studio_untextured_mat"
    untex_mat.rgba = list(_STUDIO_UNTEXTURED_RGBA)
    untex_mat.metallic = 0.0
    untex_mat.roughness = 0.46
    untex_mat.specular = 0.50

  clay_counter = [0]

  def _add_clay_clones(body_elem: Any) -> None:
    orig_geoms = list(body_elem.geoms)
    for g in orig_geoms:
      gname = getattr(g, "name", "") or ""
      if gname.startswith("studio_") or gname.startswith("_clay_"):
        continue
      if (
          int(getattr(g, "contype", 0)) == 0
          and int(getattr(g, "conaffinity", 0)) == 0
      ):
        if int(getattr(g, "group", 0)) == 4:
          continue
        idx = clay_counter[0]
        g_cls = getattr(g, "classname", None)
        cg = (
            body_elem.add_geom(g_cls)
            if g_cls is not None
            else body_elem.add_geom()
        )
        if g_cls is not None:
          cg.classname = g_cls
        cg.name = f"_clay_{idx}"
        cg.type = g.type
        if getattr(g, "meshname", ""):
          cg.meshname = g.meshname
        if hasattr(g, "fitscale"):
          cg.fitscale = g.fitscale
        cg.size = g.size
        cg.pos = g.pos
        cg.quat = g.quat
        if hasattr(g, "alt"):
          cg.alt = g.alt
        cg.fromto = g.fromto
        cg.group = 4
        cg.contype = 0
        cg.conaffinity = 0
        cg.mass = 0.0
        cg.density = 0.0
        cg.material = "_studio_untextured_mat"
        cg.rgba = list(_STUDIO_UNTEXTURED_RGBA)
        clay_counter[0] += 1
    for child_b in body_elem.bodies:
      _add_clay_clones(child_b)

  _add_clay_clones(spec.worldbody)
  return clay_counter[0]


def render_filament_still(
    asset_path: str,
    views: Sequence[dict[str, Any]],
    *,
    width: int = 800,
    height: int = 800,
    fovy: float | None = None,
    white_bg: bool = False,
    show_plinth: bool = False,
) -> list[np.ndarray]:
  """Renders a batch of still RGB frames in Filament PBR with studio lighting.

  Args:
    asset_path: Path to `model.xml`.
    views: List of view dicts. Each dict may specify: - `preset`: Optional key
      in `CANONICAL_VIEW_PRESETS` (`"front_pos_x"`, `"back_neg_x"`,
      `"right_neg_y"`, `"left_pos_y"`, `"top_pos_z"`, `"bottom_neg_z"`,
      `"iso_front_right"`, `"iso_front_left"`). - `azimuth`: Camera azimuth in
      degrees (overrides preset). - `elevation`: Camera elevation in degrees
      (overrides preset). - `distance`: Camera distance in meters (defaults to
      auto-framed). - `lookat`: Optional 3-element `[x, y, z]` lookat target. -
      `qpos`: Optional `dict[str, float]` mapping joint name -> value, or flat
      list of `qpos` values. - `mode`: `"visual"` (default, Group 2),
      `"overlay"` (Group 2 + Group 3), or `"collision"` (Group 3 hulls only). -
      `out_path`: Optional file path to save the rendered PNG.
    width: Frame width in pixels.
    height: Frame height in pixels.
    fovy: Optional vertical field-of-view in degrees (e.g. `58.0` for smartphone
      close-up perspective).
    white_bg: If True, clears background to white `[0.97, 0.97, 0.98]` and hides
      the studio floor/plinth for clean silhouette comparisons.
    show_plinth: If True (and `not white_bg`), keeps the studio plinth and floor
      visible; if False (default for multi-view / underside inspection), hides
      the studio plinth/floor so bottom (`-Z`) views are unobstructed.

  Returns:
    List of `(height, width, 3)` uint8 RGB numpy arrays, one per entry in
    `views`.
  """
  asset_path = os.path.abspath(asset_path)
  resolved_out_paths = [
      os.path.abspath(str(v["out_path"])) if v.get("out_path") else None
      for v in views
  ]
  spec, base_dir, _ = _prepare_studio_spec(
      asset_path,
      enable_vignette=False,
      exposure=0.22 if white_bg else 0.08,
      neutral_grade=True,
  )
  if fovy is not None:
    spec.visual.global_.fovy = float(fovy)
  if white_bg:
    for tex in spec.textures:
      if tex.name == "studio_skybox":
        tex.rgb1 = [1.0, 1.0, 1.0]
        tex.rgb2 = [1.0, 1.0, 1.0]

  # Add uniform neutral studio-grey satin clones of visual geoms into group=4 so
  # `mode="clay"` renders pure untextured 3D mesh shading & vertex normals
  # without per-submesh pastel color jumps or texture maps.
  _attach_clay_clones(spec)

  cwd_before = os.getcwd()
  try:
    os.chdir(base_dir)
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
  finally:
    os.chdir(cwd_before)

  col_idx = 0
  studio_geom_ids: list[int] = []
  for g_id in range(model.ngeom):
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), g_id) or ""
    if gname.startswith("studio_"):
      studio_geom_ids.append(g_id)
      if white_bg or not show_plinth:
        model.geom_group[g_id] = 5
      continue
    if gname.startswith("_clay_"):
      model.geom_group[g_id] = 4
      continue
    if model.geom_contype[g_id] > 0 or model.geom_conaffinity[g_id] > 0:
      model.geom_rgba[g_id] = _HULL_PALETTE[col_idx % len(_HULL_PALETTE)]
      model.geom_group[g_id] = 3
      col_idx += 1
    elif int(model.geom_group[g_id]) != 4:
      model.geom_group[g_id] = 2

  bmin, bmax = _compute_visual_and_collision_bounds(model, data)
  center = 0.5 * (bmin + bmax)
  span = float(max(np.linalg.norm(bmax - bmin), 0.05))
  base_fovy = float(model.vis.global_.fovy)
  qpos0 = data.qpos.copy()

  renderer_bundle = _create_filament_renderer(
      model, width=None, height=None, headlight_intensity=450.0
  )

  vcam = mujoco.MjvCamera()
  mujoco.mjv_defaultFreeCamera(model, vcam)

  frames: list[np.ndarray] = []
  for v_idx, vcfg in enumerate(views):
    vw = int(vcfg.get("width", width))
    vh = int(vcfg.get("height", height))
    view_white_bg = bool(vcfg.get("white_bg", white_bg))
    view_show_plinth = bool(vcfg.get("show_plinth", show_plinth))
    if renderer_bundle.get("use_filament", False):
      renderer_bundle["ctx"].set_clear_color(
          [0.97, 0.97, 0.98] if view_white_bg else [0.07, 0.08, 0.11]
      )
    for sg_id in studio_geom_ids:
      model.geom_group[sg_id] = (
          5 if (view_white_bg or not view_show_plinth) else 0
      )
    if "fovy" in vcfg and vcfg["fovy"] is not None:
      active_fovy = float(vcfg["fovy"])
    elif fovy is not None:
      active_fovy = float(fovy)
    else:
      active_fovy = base_fovy
    model.vis.global_.fovy = active_fovy

    tan_v = math.tan(math.radians(max(active_fovy, 10.0)) * 0.5)
    tan_min = min(tan_v, (float(vw) / max(float(vh), 1.0)) * tan_v)
    view_default_dist = max((0.5 * span * 1.22) / max(tan_min, 0.10), 0.08)

    data.qpos[:] = qpos0
    q_override = vcfg.get("qpos")
    if isinstance(q_override, dict):
      for jname, jval in q_override.items():
        jid = mujoco.mj_name2id(
            model, int(mujoco.mjtObj.mjOBJ_JOINT), str(jname)
        )
        if jid >= 0:
          data.qpos[int(model.jnt_qposadr[jid])] = float(jval)
    elif q_override is not None:
      arr = np.asarray(q_override, dtype=np.float64)
      n_copy = min(len(arr), len(data.qpos))
      data.qpos[:n_copy] = arr[:n_copy]
    mujoco.mj_forward(model, data)

    preset_key = vcfg.get("preset", "iso_front_right")
    _, p_az, p_el = CANONICAL_VIEW_PRESETS.get(
        preset_key, ("Custom", 135.0, -25.0)
    )
    vcam.azimuth = float(vcfg.get("azimuth", p_az))
    vcam.elevation = float(vcfg.get("elevation", p_el))
    dist_override = vcfg.get("distance")
    look = vcfg.get("lookat")
    vcam.distance = (
        view_default_dist if dist_override is None else float(dist_override)
    )
    vcam.lookat[:] = center if look is None else np.asarray(look, dtype=float)

    opt = mujoco.MjvOption()
    mujoco.mjv_defaultOption(opt)
    mode = str(vcfg.get("mode", "visual")).lower()
    if mode == "overlay":
      opt.geomgroup[:] = [1, 1, 1, 1, 0, 0]
      opt.flags[mujoco.mjtVisFlag.mjVIS_TRANSPARENT] = 1
    elif mode == "collision":
      opt.geomgroup[:] = [1, 0, 0, 1, 0, 0]
    elif mode == "clay":
      opt.geomgroup[:] = [1, 0, 0, 0, 1, 0]
    else:
      opt.geomgroup[:] = [1, 1, 1, 0, 0, 0]

    frame_copy = _render_rgb(
        renderer_bundle, model, data, vcam, opt, width=vw, height=vh
    )
    out_p = resolved_out_paths[v_idx]
    if out_p:
      os.makedirs(os.path.dirname(out_p), exist_ok=True)
      Image.fromarray(frame_copy).save(out_p)
    frames.append(frame_copy)

  return frames


_SIX_VIEW_PRESET_ORDER = (
    "front_pos_x",
    "back_neg_x",
    "right_neg_y",
    "left_pos_y",
    "top_pos_z",
    "bottom_neg_z",
    "iso_front_right",
)

_SIX_VIEW_MODES = (
    ("ROW 1: FILAMENT PBR VISUAL (GROUP 2)", "visual", (28, 52, 78)),
    (
        "ROW 2: UNTEXTURED MESH SHADING (PURE 3D FORM & SURFACE NORMALS)",
        "clay",
        (58, 46, 74),
    ),
    (
        "ROW 3: VISUAL + TRANSLUCENT COLLISION OVERLAY (GROUP 2 + 3)",
        "overlay",
        (26, 62, 46),
    ),
    (
        "ROW 4: COLLISION HULLS ONLY (GROUP 3, PER-HULL COLOR-CODED)",
        "collision",
        (68, 44, 24),
    ),
)


def _assemble_6view_sheet(
    frames: Sequence[np.ndarray],
    out_png: str,
    panel_size: int = 420,
) -> str:
  """Assembles 28 rendered multi-view frames into the 4x7 inspection sheet."""
  n_cols = len(_SIX_VIEW_PRESET_ORDER)
  pad = 8
  banner_h = 28
  label_h = 24
  cell_h = panel_size + label_h
  sheet_w = n_cols * panel_size + (n_cols + 1) * pad
  sheet_h = len(_SIX_VIEW_MODES) * (banner_h + cell_h + pad) + pad
  sheet = Image.new("RGB", (sheet_w, sheet_h), (14, 18, 24))
  draw = ImageDraw.Draw(sheet)
  f_banner = _load_font(13)
  f_lbl = _load_font(12)

  y_cur = pad
  f_idx = 0
  for r_title, _, r_col in _SIX_VIEW_MODES:
    draw.rectangle([pad, y_cur, sheet_w - pad, y_cur + banner_h], fill=r_col)
    draw.text(
        (pad + 10, y_cur + 6), r_title, fill=(242, 246, 252), font=f_banner
    )
    y_cur += banner_h + 4
    for c_idx, pkey in enumerate(_SIX_VIEW_PRESET_ORDER):
      vlabel, _, _ = CANONICAL_VIEW_PRESETS[pkey]
      x0 = pad + c_idx * (panel_size + pad)
      draw.rectangle(
          [x0, y_cur, x0 + panel_size, y_cur + cell_h],
          fill=(22, 26, 34),
          outline=(55, 65, 82),
      )
      draw.text((x0 + 8, y_cur + 4), vlabel, fill=(215, 225, 240), font=f_lbl)
      sheet.paste(Image.fromarray(frames[f_idx]), (x0, y_cur + label_h))
      f_idx += 1
    y_cur += cell_h + pad

  _save_compact_sheet(sheet, out_png)
  return out_png


def _save_compact_sheet(
    sheet: Image.Image,
    out_path: str,
    *,
    max_long_edge: int | None = None,
    jpeg_quality: int = 92,
) -> None:
  """Saves an inspection sheet at 1:1 caller resolution (unless `max_long_edge` is set)."""
  os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
  w, h = sheet.size
  if max_long_edge is not None and max(w, h) > max_long_edge:
    scale = float(max_long_edge) / float(max(w, h))
    sheet = sheet.resize(
        (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
        Image.Resampling.LANCZOS,
    )
  if out_path.lower().endswith((".jpg", ".jpeg")):
    sheet.convert("RGB").save(
        out_path,
        quality=int(jpeg_quality),
        subsampling=0,
        optimize=True,
    )
  else:
    sheet.save(out_path, optimize=True)


def render_6view_inspection_sheet(
    asset_path: str,
    out_png: str,
    *,
    panel_size: int = 420,
    qpos: dict[str, float] | Sequence[float] | None = None,
) -> str:
  """Renders the mandatory 4-row x 7-column Filament PBR, Clay & Collision sheet.

  Row 1: Group 2 Filament PBR Visual (Textured)
  Row 2: Untextured Clay 3D Geometry (Pure 3D Surface Form & Normals)
  Row 3: Group 2 + Group 3 Semi-Transparent Collision Overlay
  Row 4: Group 3 Per-Hull Color-Coded Collision Hulls Only
  Columns: Front (+X), Back (-X), Right (-Y), Left (+Y), Top (+Z), Bottom (-Z),
    3/4 Iso (`28` frames total).

  Args:
    asset_path: Path to `model.xml`.
    out_png: Output PNG path.
    panel_size: Width and height in pixels of each individual view cell.
    qpos: Optional joint configuration to apply.

  Returns:
    Saved `out_png` path.
  """
  asset_path = os.path.abspath(asset_path)
  abs_out_png = os.path.abspath(out_png)
  views: list[dict[str, Any]] = []
  for _, mode_key, _ in _SIX_VIEW_MODES:
    for pkey in _SIX_VIEW_PRESET_ORDER:
      views.append({"preset": pkey, "mode": mode_key, "qpos": qpos})

  frames = render_filament_still(
      asset_path,
      views,
      width=panel_size,
      height=panel_size,
      white_bg=False,
      show_plinth=False,
  )
  _assemble_6view_sheet(frames, abs_out_png, panel_size=panel_size)
  return out_png


def render_side_by_side_comparison(
    asset_path: str,
    ref_specs: Sequence[dict[str, Any]],
    out_png: str,
    *,
    detail_crops_out_png: str | None = None,
    six_view_out_png: str | None = None,
    six_view_panel_size: int = 420,
    six_view_qpos: dict[str, float] | Sequence[float] | None = None,
    fovy: float = 35.0,
    white_bg: bool = True,
    clay_only: bool = False,
) -> dict[str, str]:
  """Renders Reference vs. Filament PBR + Untextured Clay 3D Geometry + 1:1 Detail Crops."""
  asset_path = os.path.abspath(asset_path)
  abs_out_png = os.path.abspath(out_png)
  abs_detail_png = (
      os.path.abspath(detail_crops_out_png) if detail_crops_out_png else None
  )
  abs_six_png = os.path.abspath(six_view_out_png) if six_view_out_png else None
  panel_w = 520
  rows_rendered: list[
      tuple[str, Image.Image, Image.Image | None, Image.Image]
  ] = []
  detail_triplets: list[
      tuple[str, Image.Image, Image.Image | None, Image.Image]
  ] = []

  prepared_items: list[tuple[dict[str, Any], Image.Image, int]] = []
  batched_views: list[dict[str, Any]] = []
  for spec_item in ref_specs:
    ref_p = os.path.abspath(str(spec_item["ref_path"]))
    ref_im = Image.open(ref_p).convert("RGB")
    rw, rh = ref_im.size
    panel_h = max(240, int(round(panel_w * (rh / max(rw, 1)))))
    render_scale = (
        2 if (detail_crops_out_png and spec_item.get("crop_boxes_norm")) else 1
    )
    v_vis = dict(spec_item)
    v_vis["mode"] = "visual"
    v_vis["width"] = panel_w * render_scale
    v_vis["height"] = panel_h * render_scale
    v_vis["fovy"] = float(spec_item.get("fovy", fovy))
    v_vis["white_bg"] = white_bg
    v_vis["show_plinth"] = not white_bg
    v_clay = dict(v_vis)
    v_clay["mode"] = "clay"
    if not clay_only:
      batched_views.append(v_vis)
    batched_views.append(v_clay)
    prepared_items.append((spec_item, ref_im, panel_h))

  all_frames = (
      render_filament_still(
          asset_path,
          batched_views,
          width=batched_views[0]["width"],
          height=batched_views[0]["height"],
          fovy=fovy,
          white_bg=white_bg,
          show_plinth=not white_bg,
      )
      if batched_views
      else []
  )

  def _square_pixel_box(
      u0: float, v0: float, u1: float, v1: float, img_w: int, img_h: int
  ) -> tuple[int, int, int, int]:
    x0, y0 = float(u0) * img_w, float(v0) * img_h
    x1, y1 = float(u1) * img_w, float(v1) * img_h
    cx, cy = 0.5 * (x0 + x1), 0.5 * (y0 + y1)
    side = min(max(abs(x1 - x0), abs(y1 - y0), 16.0), float(min(img_w, img_h)))
    sx0 = float(np.clip(cx - 0.5 * side, 0.0, max(0.0, img_w - side)))
    sy0 = float(np.clip(cy - 0.5 * side, 0.0, max(0.0, img_h - side)))
    iside = max(1, int(round(side)))
    ix0, iy0 = int(round(sx0)), int(round(sy0))
    return (ix0, iy0, min(img_w, ix0 + iside), min(img_h, iy0 + iside))

  for idx, (spec_item, ref_im, panel_h) in enumerate(prepared_items):
    ref_p = str(spec_item["ref_path"])
    if clay_only:
      sim_full = None
      clay_full = Image.fromarray(all_frames[idx])
      base_size = clay_full.size
    else:
      sim_full = Image.fromarray(all_frames[2 * idx])
      clay_full = Image.fromarray(all_frames[2 * idx + 1])
      base_size = sim_full.size
    ref_full = ref_im.resize(base_size, Image.Resampling.LANCZOS)

    for crop_entry in spec_item.get("crop_boxes_norm", []):
      if len(crop_entry) == 2:
        c_label, ref_norm = crop_entry
        sim_norm = ref_norm
      elif len(crop_entry) == 3:
        c_label, ref_norm, sim_norm = crop_entry
      else:
        raise ValueError(
            "Each crop_boxes_norm entry must be (label, box) or "
            f"(label, ref_box, sim_box), got {crop_entry!r}"
        )
      ru0, rv0, ru1, rv1 = ref_norm
      su0, sv0, su1, sv1 = sim_norm
      w_f, h_f = base_size
      ref_box = _square_pixel_box(ru0, rv0, ru1, rv1, w_f, h_f)
      sim_box = _square_pixel_box(su0, sv0, su1, sv1, w_f, h_f)
      r_crop = ref_full.crop(ref_box).resize(
          (360, 360), Image.Resampling.LANCZOS
      )
      s_crop = (
          sim_full.crop(sim_box).resize((360, 360), Image.Resampling.LANCZOS)
          if sim_full is not None
          else None
      )
      c_crop = clay_full.crop(sim_box).resize(
          (360, 360), Image.Resampling.LANCZOS
      )
      detail_triplets.append((str(c_label), r_crop, s_crop, c_crop))

    ref_panel = ref_im.resize((panel_w, panel_h), Image.Resampling.LANCZOS)
    sim_panel = (
        sim_full.resize((panel_w, panel_h), Image.Resampling.LANCZOS)
        if sim_full is not None
        else None
    )
    clay_panel = clay_full.resize((panel_w, panel_h), Image.Resampling.LANCZOS)
    rows_rendered.append((
        str(spec_item.get("label", os.path.basename(ref_p))),
        ref_panel,
        sim_panel,
        clay_panel,
    ))

  pad = 10
  hdr_h = 30
  n_cols = 2 if clay_only else 3
  sheet_w = n_cols * panel_w + (n_cols + 1) * pad
  sheet_h = sum(r[1].height + hdr_h + pad for r in rows_rendered) + pad
  sheet = Image.new("RGB", (sheet_w, sheet_h), (16, 20, 28))
  draw = ImageDraw.Draw(sheet)
  f_hdr = _load_font(13)

  y_cur = pad
  for r_label, r_im, s_im, c_im in rows_rendered:
    ph = r_im.height
    cols = [(f"REFERENCE: {r_label}", r_im, (32, 48, 68))]
    if s_im is not None:
      cols.append((f"FILAMENT PBR: {r_label}", s_im, (28, 62, 48)))
    cols.append((
        f"CLAY 3D GEOMETRY (Untextured Form): {r_label}",
        c_im,
        (58, 46, 74),
    ))
    for c_idx, (c_title, c_img, c_bg) in enumerate(cols):
      x0 = pad + c_idx * (panel_w + pad)
      draw.rectangle([x0, y_cur, x0 + panel_w, y_cur + hdr_h], fill=c_bg)
      draw.text((x0 + 8, y_cur + 7), c_title, fill=(242, 246, 252), font=f_hdr)
      sheet.paste(c_img, (x0, y_cur + hdr_h))
    y_cur += hdr_h + ph + pad

  _save_compact_sheet(sheet, abs_out_png)
  result = {"comparison_png": out_png}

  if abs_detail_png and detail_crops_out_png and detail_triplets:
    cw = 360
    n_pairs = len(detail_triplets)
    d_cols = 2 if clay_only else 3
    d_w = d_cols * cw + (d_cols + 1) * pad
    d_h = n_pairs * (cw + hdr_h + pad) + pad
    d_sheet = Image.new("RGB", (d_w, d_h), (16, 20, 28))
    d_draw = ImageDraw.Draw(d_sheet)
    dy = pad
    for d_lbl, dr_im, ds_im, dc_im in detail_triplets:
      crop_cols = [(f"REF ZOOM: {d_lbl}", dr_im, (32, 48, 68))]
      if ds_im is not None:
        crop_cols.append((f"PBR ZOOM: {d_lbl}", ds_im, (28, 62, 48)))
      crop_cols.append((f"CLAY 3D FORM: {d_lbl}", dc_im, (58, 46, 74)))
      for c_idx, (sub_lbl, sub_im, sub_bg) in enumerate(crop_cols):
        x0 = pad + c_idx * (cw + pad)
        d_draw.rectangle([x0, dy, x0 + cw, dy + hdr_h], fill=sub_bg)
        d_draw.text((x0 + 8, dy + 7), sub_lbl, fill=(242, 246, 252), font=f_hdr)
        d_sheet.paste(sub_im, (x0, dy + hdr_h))
      dy += hdr_h + cw + pad
    _save_compact_sheet(d_sheet, abs_detail_png)
    result["detail_crops_png"] = detail_crops_out_png

  if abs_six_png and six_view_out_png:
    render_6view_inspection_sheet(
        asset_path,
        abs_six_png,
        panel_size=six_view_panel_size,
        qpos=six_view_qpos,
    )
    result["six_view_png"] = six_view_out_png

  print(f"[RENDER COMPLETE] Saved {list(result.values())}.")
  return result


def render_wireframe_and_uv_sheet(
    asset_path: str,
    out_png: str,
    *,
    panel_size: int = 440,
) -> str:
  """Renders a 2x3 topology wireframe & UV layout inspection sheet from raw OBJs.

  Reads the raw visual `.obj` files referenced by `asset_path` (preserving
  original quads rather than MuJoCo's internal triangulated buffer), transforms
  each visual geom into its compiled MuJoCo world pose
  (`geom_xpos`/`geom_xmat`), checks for inverted face-normal vs. vertex-normal
  winding, and renders Front, Right, Top, 3/4 Iso wireframes (`+Z` up) plus
  per-material UV island tiles.

  Args:
    asset_path: Path to `model.xml`.
    out_png: Output PNG path.
    panel_size: Pixel width/height of each panel cell.

  Returns:
    Saved `out_png` path.
  """
  abs_asset = os.path.abspath(asset_path)
  abs_out_png = os.path.abspath(out_png)
  base_dir = os.path.dirname(abs_asset)
  cwd_before = os.getcwd()
  try:
    os.chdir(base_dir)
    spec = mujoco.MjSpec.from_file(abs_asset)
    meshdir = (
        getattr(spec.compiler, "meshdir", "")
        or getattr(spec, "meshdir", "")
        or ""
    )
    mesh_root = os.path.join(base_dir, meshdir) if meshdir else base_dir
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
  finally:
    os.chdir(cwd_before)

  mesh_world_poses: dict[str, tuple[np.ndarray, np.ndarray, str]] = {}
  for g_id in range(model.ngeom):
    if model.geom_type[g_id] != mujoco.mjtGeom.mjGEOM_MESH:
      continue
    if model.geom_contype[g_id] != 0 or model.geom_conaffinity[g_id] != 0:
      continue
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), g_id) or ""
    if gname.startswith("studio_") or gname.startswith("_clay_"):
      continue
    m_id = int(model.geom_dataid[g_id])
    if m_id < 0:
      continue
    mname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_MESH), m_id) or ""
    mat_id = int(model.geom_matid[g_id])
    mat_name = (
        (
            mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_MATERIAL), mat_id)
            or "default"
        )
        if mat_id >= 0
        else "default"
    )
    if mname and mname not in mesh_world_poses:
      xpos = data.geom_xpos[g_id].copy()
      xmat = data.geom_xmat[g_id].reshape(3, 3).copy()
      mesh_world_poses[mname] = (xpos, xmat, mat_name)

  mesh_colors = [
      (90, 195, 255),
      (255, 175, 85),
      (115, 235, 155),
      (235, 125, 245),
      (255, 225, 95),
      (255, 115, 125),
      (140, 220, 220),
  ]

  raw_meshes = []
  all_v_list = []
  inverted_faces_by_mesh: dict[str, int] = {}
  for m_idx, m in enumerate(spec.meshes):
    if mesh_world_poses and m.name not in mesh_world_poses:
      continue
    if not m.file or not m.file.endswith(".obj"):
      continue
    obj_p = os.path.join(mesh_root, m.file)
    if not os.path.exists(obj_p):
      obj_p = os.path.join(base_dir, m.file)
    if not os.path.exists(obj_p):
      continue
    verts, vnorms, uvs, v_faces, vn_faces, uv_faces = [], [], [], [], [], []
    with open(obj_p, "r", encoding="utf-8", errors="ignore") as f:
      for line in f:
        if line.startswith("v "):
          parts = line.split()
          verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
        elif line.startswith("vn "):
          parts = line.split()
          vnorms.append([float(parts[1]), float(parts[2]), float(parts[3])])
        elif line.startswith("vt "):
          parts = line.split()
          uvs.append([float(parts[1]), float(parts[2])])
        elif line.startswith("f "):
          parts = line.split()[1:]
          vf, tf, nf = [], [], []
          for p in parts:
            toks = p.split("/")
            vf.append(int(toks[0]) - 1)
            if len(toks) > 1 and toks[1]:
              tf.append(int(toks[1]) - 1)
            if len(toks) > 2 and toks[2]:
              nf.append(int(toks[2]) - 1)
          v_faces.append(vf)
          if len(tf) == len(vf):
            uv_faces.append(tf)
          if len(nf) == len(vf):
            vn_faces.append(nf)
    if verts:
      v_arr = np.asarray(verts, dtype=np.float32)
      vn_arr = (
          np.asarray(vnorms, dtype=np.float32)
          if vnorms
          else np.zeros((0, 3), dtype=np.float32)
      )
      uv_arr = (
          np.asarray(uvs, dtype=np.float32)
          if uvs
          else np.zeros((0, 2), dtype=np.float32)
      )

      inv_cnt = 0
      if len(vn_arr) > 0 and len(vn_faces) == len(v_faces):
        for vf, nf in zip(v_faces, vn_faces):
          if len(vf) >= 3:
            p0, p1, p2 = v_arr[vf[0]], v_arr[vf[1]], v_arr[vf[2]]
            fn = np.cross(p1 - p0, p2 - p0)
            vn_avg = np.mean(vn_arr[nf], axis=0)
            if float(np.dot(fn, vn_avg)) < -1e-7:
              inv_cnt += 1
      inverted_faces_by_mesh[m.name or os.path.basename(obj_p)] = inv_cnt

      mat_name = "default"
      if m.name in mesh_world_poses:
        xpos, xmat, mat_name = mesh_world_poses[m.name]
        raw_center = 0.5 * (v_arr.min(axis=0) + v_arr.max(axis=0))
        if (
            np.linalg.norm(xpos) > 1e-4
            and np.linalg.norm(raw_center) < np.linalg.norm(xpos) * 0.65
        ):
          v_arr = (v_arr @ xmat.T) + xpos.astype(np.float32)
      all_v_list.append(v_arr)
      raw_meshes.append((
          m.name or os.path.basename(obj_p),
          v_arr,
          uv_arr,
          v_faces,
          uv_faces,
          mesh_colors[m_idx % len(mesh_colors)],
          mat_name,
      ))

  if all_v_list:
    stacked = np.vstack(all_v_list)
    bmin, bmax = stacked.min(axis=0), stacked.max(axis=0)
  else:
    bmin = np.array([-0.1, -0.1, -0.1], dtype=np.float32)
    bmax = np.array([0.1, 0.1, 0.1], dtype=np.float32)
  center = 0.5 * (bmin + bmax)
  span = float(max(np.max(bmax - bmin), 1e-3))
  scale = (panel_size * 0.78) / span

  views = [
      ("WIREFRAME: FRONT (+X)", 180.0, -14.0),
      ("WIREFRAME: RIGHT (-Y)", 90.0, -14.0),
      ("WIREFRAME: TOP (+Z)", 180.0, -89.0),
      ("WIREFRAME: 3/4 HERO ISO", 135.0, -24.0),
  ]
  panels: list[tuple[str, Image.Image]] = []
  for v_title, az_deg, el_deg in views:
    im = Image.new("RGB", (panel_size, panel_size), (18, 22, 30))
    dr = ImageDraw.Draw(im)
    az = math.radians(az_deg)
    el = math.radians(el_deg)
    fwd = np.array(
        [
            -math.cos(el) * math.cos(az),
            -math.cos(el) * math.sin(az),
            math.sin(el),
        ],
        dtype=np.float32,
    )
    right = np.array([math.sin(az), -math.cos(az), 0.0], dtype=np.float32)
    up = np.cross(fwd, right)
    for _, v_arr, _, v_faces, _, col, _ in raw_meshes:
      vc = v_arr - center
      sx = (vc @ right) * scale + 0.5 * panel_size
      sy = 0.5 * panel_size - (vc @ up) * scale
      pts = np.stack([sx, sy], axis=1)
      seen_edges: set[tuple[int, int]] = set()
      for vf in v_faces:
        nf = len(vf)
        for k in range(nf):
          u_i, v_i = int(vf[k]), int(vf[(k + 1) % nf])
          edge_key = (u_i, v_i) if u_i < v_i else (v_i, u_i)
          if edge_key not in seen_edges:
            seen_edges.add(edge_key)
            dr.line([tuple(pts[u_i]), tuple(pts[v_i])], fill=col, width=1)
    panels.append((v_title, im))

  uv_im = Image.new("RGB", (panel_size, panel_size), (18, 22, 30))
  uv_dr = ImageDraw.Draw(uv_im)
  f_uv = _load_font(11)
  total_quads, total_tris, total_ngons = 0, 0, 0
  mats_seen: list[str] = []
  for _, _, _, v_faces, _, _, mat_name in raw_meshes:
    if mat_name not in mats_seen:
      mats_seen.append(mat_name)
    for vf in v_faces:
      if len(vf) == 4:
        total_quads += 1
      elif len(vf) == 3:
        total_tris += 1
      else:
        total_ngons += 1

  n_mats = max(len(mats_seen), 1)
  grid_n = 1 if n_mats == 1 else (2 if n_mats <= 4 else 3)
  pad_uv = 14
  cell_uv = (panel_size - (grid_n + 1) * pad_uv) // grid_n
  for m_i, mat_key in enumerate(mats_seen[: grid_n * grid_n]):
    gx = m_i % grid_n
    gy = m_i // grid_n
    ox = pad_uv + gx * (cell_uv + pad_uv)
    oy = pad_uv + gy * (cell_uv + pad_uv)
    uv_dr.rectangle(
        [ox, oy, ox + cell_uv, oy + cell_uv], outline=(80, 95, 120), width=1
    )
    uv_dr.text((ox + 4, oy + 2), mat_key[:20], fill=(215, 225, 240), font=f_uv)
    for _, _, uv_arr, _, uv_faces, col, mat_name in raw_meshes:
      if mat_name != mat_key or len(uv_arr) == 0 or not uv_faces:
        continue
      ux = ox + np.clip(uv_arr[:, 0], 0.0, 1.0) * cell_uv
      uy = oy + (1.0 - np.clip(uv_arr[:, 1], 0.0, 1.0)) * cell_uv
      upts = np.stack([ux, uy], axis=1)
      seen_uv_edges: set[tuple[int, int]] = set()
      for tf in uv_faces:
        ntf = len(tf)
        for k in range(ntf):
          u_i, v_i = int(tf[k]), int(tf[(k + 1) % ntf])
          ek = (u_i, v_i) if u_i < v_i else (v_i, u_i)
          if ek not in seen_uv_edges:
            seen_uv_edges.add(ek)
            uv_dr.line([tuple(upts[u_i]), tuple(upts[v_i])], fill=col, width=1)
  panels.append(("UV ATLAS ISLANDS (PER MATERIAL)", uv_im))

  sum_im = Image.new("RGB", (panel_size, panel_size), (18, 22, 30))
  sum_dr = ImageDraw.Draw(sum_im)
  f_title = _load_font(15)
  f_body = _load_font(12)
  total_f = max(total_quads + total_tris + total_ngons, 1)
  total_inv = sum(inverted_faces_by_mesh.values())
  sum_dr.text(
      (20, 20),
      "RAW OBJ TOPOLOGY & UV SUMMARY",
      fill=(235, 242, 252),
      font=f_title,
  )
  sum_dr.text(
      (20, 48),
      f"Faces: {total_f}  |  Quads: {total_quads}  |  Tris: {total_tris}  | "
      f" N-gons: {total_ngons}",
      fill=(210, 220, 235),
      font=f_body,
  )
  sum_dr.text(
      (20, 70),
      "Normal Winding Check:"
      f" {'0 Inverted [OK]' if total_inv == 0 else f'{total_inv} Inverted [FIX!]'}",
      fill=(130, 235, 165) if total_inv == 0 else (255, 110, 110),
      font=f_body,
  )
  y_leg = 102
  for m_name, v_arr, _, v_faces, _, col, mat_name in raw_meshes:
    inv_n = inverted_faces_by_mesh.get(m_name, 0)
    inv_str = f" [INV_VN={inv_n}!]" if inv_n > 0 else ""
    sum_dr.rectangle([20, y_leg + 2, 34, y_leg + 16], fill=col)
    sum_dr.text(
        (42, y_leg),
        f"{m_name} ({mat_name}): {len(v_arr)}v, {len(v_faces)}f{inv_str}",
        fill=(255, 110, 110) if inv_n > 0 else (225, 232, 245),
        font=f_body,
    )
    y_leg += 24
  panels.append(("MESH TOPOLOGY & NORMAL HYGIENE", sum_im))

  pad = 10
  hdr_h = 28
  f_hdr = _load_font(13)
  sheet_w = 3 * panel_size + 4 * pad
  sheet_h = 2 * (panel_size + hdr_h) + 3 * pad
  sheet = Image.new("RGB", (sheet_w, sheet_h), (12, 16, 22))
  s_dr = ImageDraw.Draw(sheet)
  for idx, (p_title, p_im) in enumerate(panels):
    col_i = idx % 3
    row_i = idx // 3
    x0 = pad + col_i * (panel_size + pad)
    y0 = pad + row_i * (panel_size + hdr_h + pad)
    s_dr.rectangle([x0, y0, x0 + panel_size, y0 + hdr_h], fill=(32, 48, 68))
    s_dr.text((x0 + 8, y0 + 6), p_title, fill=(242, 246, 252), font=f_hdr)
    sheet.paste(p_im, (x0, y0 + hdr_h))

  _save_compact_sheet(sheet, abs_out_png)
  return out_png


def _render_showcase_phase_rgb(
    renderer_bundle: dict[str, Any],
    model: mujoco.MjModel,
    data: mujoco.MjData,
    vcam: mujoco.MjvCamera,
    phase_idx: int,
    col_gids: Sequence[int],
) -> np.ndarray:
  """Renders `phase_idx` (`0`=Visual, `1`=Ghost Overlay, `2`=Collision Hulls)."""
  opt = mujoco.MjvOption()
  mujoco.mjv_defaultOption(opt)
  if phase_idx == 1:
    for g_id in col_gids:
      model.geom_rgba[g_id] = _OVERLAY_GHOST_RGBA
    opt.geomgroup[:] = [1, 1, 1, 1, 0, 0]
    opt.flags[mujoco.mjtVisFlag.mjVIS_TRANSPARENT] = 1
  elif phase_idx == 2:
    for idx, g_id in enumerate(col_gids):
      model.geom_rgba[g_id] = _HULL_PALETTE[idx % len(_HULL_PALETTE)]
    opt.geomgroup[:] = [1, 0, 0, 1, 0, 0]
  else:
    opt.geomgroup[:] = [1, 1, 1, 0, 0, 0]
  return _render_rgb(renderer_bundle, model, data, vcam, opt)


def render_showcase_shot_video(
    asset_path: str,
    output_mp4: str,
    width: int = 960,
    height: int = 720,
    fps: int = 30,
    duration: float = 8.0,
    articulation_cycles: float = 2.0,
) -> dict[str, Any]:
  """Renders a 2-orbit Filament PBR turntable video with articulation & collision."""
  asset_path = os.path.abspath(asset_path)
  output_mp4 = os.path.abspath(output_mp4)
  spec, base_dir, asset_name = _prepare_studio_spec(asset_path)

  cwd_before = os.getcwd()
  try:
    os.chdir(base_dir)
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
  finally:
    os.chdir(cwd_before)

  # Partition user geoms into Group 2 (visual) and Group 3 (collision hulls).
  col_gids: list[int] = []
  num_vis = 0
  for g_id in range(model.ngeom):
    gname = mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_GEOM), g_id) or ""
    if gname.startswith("studio_"):
      continue
    if model.geom_contype[g_id] > 0 or model.geom_conaffinity[g_id] > 0:
      model.geom_rgba[g_id] = _OVERLAY_GHOST_RGBA
      model.geom_group[g_id] = 3
      col_gids.append(g_id)
    else:
      model.geom_group[g_id] = 2
      num_vis += 1
  num_col = len(col_gids)

  bmin, bmax = _compute_visual_and_collision_bounds(model, data)
  center = 0.5 * (bmin + bmax)
  extents_mm: tuple[float, float, float] = (
      float((bmax[0] - bmin[0]) * 1000.0),
      float((bmax[1] - bmin[1]) * 1000.0),
      float((bmax[2] - bmin[2]) * 1000.0),
  )
  span = float(max(np.linalg.norm(bmax - bmin), 0.05))
  total_mass = float(np.sum(model.body_mass[1:]))

  # Identify articulated joints (hinge and slide)
  anim_joints = []
  for j_id in range(model.njnt):
    jtype = int(model.jnt_type[j_id])
    if jtype in (
        int(mujoco.mjtJoint.mjJNT_HINGE),
        int(mujoco.mjtJoint.mjJNT_SLIDE),
    ):
      jname = (
          mujoco.mj_id2name(model, int(mujoco.mjtObj.mjOBJ_JOINT), j_id)
          or f"joint_{j_id}"
      )
      qadr = int(model.jnt_qposadr[j_id])
      if model.jnt_limited[j_id]:
        jmin, jmax = float(model.jnt_range[j_id, 0]), float(
            model.jnt_range[j_id, 1]
        )
      else:
        jmin, jmax = (
            (-0.5, 0.5)
            if jtype == int(mujoco.mjtJoint.mjJNT_HINGE)
            else (0.0, 0.1)
        )
      anim_joints.append((j_id, jname, jtype, qadr, jmin, jmax))

  vcam = mujoco.MjvCamera()
  mujoco.mjv_defaultFreeCamera(model, vcam)
  vcam.lookat[:] = center
  vcam.distance = max(span * 1.48, 0.08)

  renderer_bundle = _create_filament_renderer(model, width=width, height=height)
  use_filament = bool(renderer_bundle.get("use_filament", False))

  total_frames = max(1, int(round(fps * duration)))
  os.makedirs(os.path.dirname(os.path.abspath(output_mp4)), exist_ok=True)
  contact_frames = []
  keyframe_indices = {
      0,
      int(total_frames * 0.25),
      int(total_frames * 0.64),
      int(total_frames * 0.89),
  }

  with tempfile.TemporaryDirectory() as tmp_frames_dir:
    for f_idx in range(total_frames):
      t_norm = f_idx / float(max(total_frames - 1, 1))

      # 1. Sweep articulated joints smoothly via cosine wave
      joint_hud_list = []
      for _, jname, jtype, qadr, jmin, jmax in anim_joints:
        alpha = 0.5 * (
            1.0 - math.cos(2.0 * math.pi * articulation_cycles * t_norm)
        )
        qval = jmin + alpha * (jmax - jmin)
        data.qpos[qadr] = qval
        if jtype == int(mujoco.mjtJoint.mjJNT_HINGE):
          joint_hud_list.append((jname, math.degrees(qval), "°"))
        else:
          joint_hud_list.append((jname, qval * 1000.0, " mm"))

      mujoco.mj_forward(model, data)

      # 2. Resolve orbit, chapter phase, and cross-fade blend
      fstate = _compute_showcase_frame_state(
          t_norm,
          use_filament=use_filament,
          has_colliders=(num_col > 0),
      )

      # 3. Update turntable camera orbit
      vcam.azimuth = fstate["azimuth_cam_deg"]
      vcam.elevation = -23.0 - 4.0 * math.sin(2.0 * math.pi * t_norm)

      if fstate["blend_alpha"] > 0.0:
        src_p = 0 if fstate["next_phase_idx"] == 1 else 1
        buf_a = _render_showcase_phase_rgb(
            renderer_bundle, model, data, vcam, src_p, col_gids
        )
        buf_b = _render_showcase_phase_rgb(
            renderer_bundle,
            model,
            data,
            vcam,
            fstate["next_phase_idx"],
            col_gids,
        )
        buf = _blend_rgb_frames(buf_a, buf_b, fstate["blend_alpha"])
      else:
        buf = _render_showcase_phase_rgb(
            renderer_bundle, model, data, vcam, fstate["phase_idx"], col_gids
        )

      # 4. Composite HUD overlay
      hud_frame = _draw_hud_overlay(
          buf,
          asset_name=asset_name,
          dims_mm=extents_mm,
          mass_kg=total_mass,
          num_vis=num_vis,
          num_col=num_col,
          joint_info=joint_hud_list,
          phase_label=fstate["badge_label"],
          phase_color=fstate["phase_color"],
          progress=t_norm,
          azimuth_deg=fstate["orbit_deg"],
          banner_text=fstate["banner_text"],
          orbit_index=fstate["orbit_index"],
          orbit_total=fstate["orbit_total"],
      )

      frame_png = os.path.join(tmp_frames_dir, f"frame_{f_idx:04d}.png")
      Image.fromarray(hud_frame).save(frame_png)

      if f_idx in keyframe_indices:
        contact_frames.append(hud_frame)

    # Prefer in-process PyAV (`av`) so no external `ffmpeg` binary is spawned
    # on platforms that restrict subprocesses.
    encoded_inprocess = False
    try:
      av: Any = importlib.import_module("av")
      frame_files = sorted(
          glob.glob(os.path.join(tmp_frames_dir, "frame_*.png"))
      )
      if frame_files:
        container = av.open(output_mp4, mode="w")
        stream = container.add_stream("libx264", rate=int(fps))
        stream.width = int(width)
        stream.height = int(height)
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "18"}
        for fp in frame_files:
          arr = np.asarray(Image.open(fp).convert("RGB"), dtype=np.uint8)
          vframe = av.VideoFrame.from_ndarray(arr, format="rgb24")
          for packet in stream.encode(vframe):
            container.mux(packet)
        for packet in stream.encode():
          container.mux(packet)
        container.close()
        encoded_inprocess = (
            os.path.exists(output_mp4) and os.path.getsize(output_mp4) > 0
        )
    except Exception:  # pylint: disable=broad-exception-caught
      encoded_inprocess = False

    # 2) Fallback: Encode H.264 MP4 via ffmpeg
    if not encoded_inprocess:
      cmd = [
          "ffmpeg",
          "-y",
          "-framerate",
          str(fps),
          "-i",
          os.path.join(tmp_frames_dir, "frame_%04d.png"),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "18",
          output_mp4,
      ]
      subprocess.run(
          cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
      )

  # Also save a keyframe summary sheet next to the MP4 whenever >= 1 frame
  # exists.
  sheet_png = os.path.splitext(output_mp4)[0] + "_keyframes.png"
  if len(contact_frames) >= 1:
    cw, ch = max(1, width // 2), max(1, height // 2)
    kf_list = list(contact_frames[:4])
    kf_cols = 1 if len(kf_list) == 1 else 2
    kf_rows = (len(kf_list) + kf_cols - 1) // kf_cols
    sheet = Image.new(
        "RGB",
        (cw * kf_cols + 4 * (kf_cols - 1), ch * kf_rows + 4 * (kf_rows - 1)),
        (15, 18, 24),
    )
    for idx, cf in enumerate(kf_list):
      resized = Image.fromarray(cf).resize((cw, ch), Image.Resampling.LANCZOS)
      gx = (idx % kf_cols) * (cw + 4)
      gy = (idx // kf_cols) * (ch + 4)
      sheet.paste(resized, (gx, gy))
    sheet.save(sheet_png)

  return {
      "asset_name": asset_name,
      "output_mp4": output_mp4,
      "keyframes_png": sheet_png,
      "frames": total_frames,
      "dims_mm": extents_mm,
      "mass_kg": total_mass,
      "num_vis": num_vis,
      "num_col": num_col,
      "num_dof": len(anim_joints),
  }


def main(argv: Sequence[str]) -> None:
  if len(argv) > 1:
    raise app.UsageError("Too many command-line arguments.")
  asset_path = (
      _ASSET.value
      or _XML_PATH_ALIAS.value
      or _XML_ALIAS.value
      or _MODEL_XML_ALIAS.value
      or _INPUT_ALIAS.value
  )
  output_mp4 = _OUTPUT.value or _OUT_ALIAS.value or _OUTPUT_PATH_ALIAS.value
  if not asset_path or not output_mp4:
    raise app.UsageError(
        "Must provide --asset (or --xml_path / --xml / --model_xml / --input)"
        " and --output (or --out / --output_path)."
    )
  if _BEFORE_XML.value:
    base_out = os.path.splitext(os.path.abspath(output_mp4))[0]
    before_mp4 = base_out + "_before_panel.mp4"
    after_mp4 = base_out + "_after_panel.mp4"
    render_showcase_shot_video(
        asset_path=_BEFORE_XML.value,
        output_mp4=before_mp4,
        width=_WIDTH.value,
        height=_HEIGHT.value,
        fps=_FPS.value,
        duration=_DURATION.value,
        articulation_cycles=_CYCLES.value,
    )
    render_showcase_shot_video(
        asset_path=asset_path,
        output_mp4=after_mp4,
        width=_WIDTH.value,
        height=_HEIGHT.value,
        fps=_FPS.value,
        duration=_DURATION.value,
        articulation_cycles=_CYCLES.value,
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            before_mp4,
            "-i",
            after_mp4,
            "-filter_complex",
            "[0:v][1:v]hstack=inputs=2[v]",
            "-map",
            "[v]",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "18",
            output_mp4,
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    print(
        "[ShowcaseShot] Saved BEFORE vs. AFTER side-by-side video ->"
        f" {output_mp4}"
    )
    return

  info = render_showcase_shot_video(
      asset_path=asset_path,
      output_mp4=output_mp4,
      width=_WIDTH.value,
      height=_HEIGHT.value,
      fps=_FPS.value,
      duration=_DURATION.value,
      articulation_cycles=_CYCLES.value,
  )
  print(
      f"[ShowcaseShot] Saved Filament turntable video ({info['frames']} frames)"
      f" -> {info['output_mp4']}\n[ShowcaseShot] Saved 4-keyframe summary"
      f" sheet -> {info['keyframes_png']}"
  )


def cli_main() -> None:
  app.run(main)


if __name__ == "__main__":
  cli_main()
