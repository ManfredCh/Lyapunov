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
"""Lyapunov adaptation: standalone Gauntlet common-random-number schedule."""

from collections.abc import Mapping
import dataclasses
import hashlib
import hmac
import math
import os
from typing import Any
import zlib

import numpy as np

TIERS = ("T0", "T1", "T2", "T3", "T4")
FAULTS = ("camera_freeze", "dead_gripper")
TRIGGERS = ("arm_motion", "gripper_close")
DISTURBANCES = ("slip", "push", "knockout")
@dataclasses.dataclass(frozen=True)
class PSpec:
  """One episode's sampled perturbation; T0 is all defaults."""

  tier: str = "T0"
  idx: int = 0
  friction_scale: float = 1.0
  mass_scale: float = 1.0
  damping_scale: float = 1.0
  gain_scale: float = 1.0
  gravcomp_delta: float = 0.0
  cam_offset_m: tuple[float, ...] = (0.0, 0.0, 0.0)
  cam_tilt_deg: float = 0.0
  table_dz_m: float = 0.0  # Applied as the inverse robot-mount offset.
  table_tilt_deg: float = 0.0
  target_xy_m: tuple[float, ...] = (0.0, 0.0)
  target_yaw_deg: float = 0.0
  dest_xy_m: tuple[float, ...] = (0.0, 0.0)
  proprio_noise: float = 0.0
  proprio_bias: float = 0.0
  hue_deg: float = 0.0
  sat_scale: float = 1.0
  rgb_gain: float = 1.0
  rgb_noise: float = 0.0
  depth_noise_m: float = 0.0
  depth_dropout: float = 0.0
  frame_delay: int = 0
  disturbance: str = ""
  push_dir_rad: float = 0.0
  fault: str = ""
  fault_trigger: str = ""
  fault_delay: int = 0
  fault_restamp: bool = False


_MODERATE = dict(
    proprio_noise=(0.001, 0.001), proprio_bias=(0.002, 0.002),
    rgb_noise=(2.5, 2.5), depth_noise_m=(0.001, 0.001),
    depth_dropout=(0.005, 0.005),
)
# Uniform `(lo, hi)` per field; tuple fields draw one value per component.
TIER_RANGES: Mapping[str, Mapping[str, tuple[float, float]]] = {
    "T0": {},
    "T1": dict(
        _MODERATE, friction_scale=(0.85, 1.15), mass_scale=(0.85, 1.15),
        damping_scale=(0.9, 1.1),
        gain_scale=(0.92, 1.08), table_dz_m=(-0.008, 0.008),
        target_xy_m=(-0.03, 0.03), target_yaw_deg=(-25.0, 25.0),
        dest_xy_m=(-0.02, 0.02), hue_deg=(-4.0, 4.0), sat_scale=(0.9, 1.1),
        rgb_gain=(0.92, 1.08),
    ),
    "T2": dict(
        proprio_noise=(0.002, 0.002), proprio_bias=(0.004, 0.004),
        rgb_noise=(6.0, 6.0), depth_noise_m=(0.002, 0.002),
        depth_dropout=(0.02, 0.02), frame_delay=(0, 1),
        friction_scale=(0.6, 1.4), mass_scale=(0.65, 1.45),
        damping_scale=(0.75, 1.3),
        gain_scale=(0.8, 1.2), table_dz_m=(-0.02, 0.02),
        table_tilt_deg=(-1.5, 1.5), target_xy_m=(-0.06, 0.06),
        target_yaw_deg=(-60.0, 60.0), dest_xy_m=(-0.035, 0.035),
        hue_deg=(-14.0, 14.0), sat_scale=(0.7, 1.3), rgb_gain=(0.8, 1.2),
    ),
    "T3": dict(
        _MODERATE, friction_scale=(0.75, 1.15), table_dz_m=(-0.02, 0.02),
        target_xy_m=(-0.025, 0.025),
    ),
    "T4": dict(
        _MODERATE, mass_scale=(0.85, 1.2), target_xy_m=(-0.02, 0.02),
        gain_scale=(0.85, 1.15), gravcomp_delta=(-0.1, 0.1),
        cam_offset_m=(-0.003, 0.003), cam_tilt_deg=(-0.5, 0.5),
    ),
}
_INT_FIELDS = ("frame_delay",)


@dataclasses.dataclass(frozen=True)
class Streams:
  """Independent child generators so each consumer's draws are isolated."""

  spec: np.random.Generator
  sensor: np.random.Generator


def streams(
    base_seed: int, task_id: str, tier: str, idx: int, *,
    secret: str | None = None,
) -> Streams:
  """Derives the CRN streams for `(base_seed, task_id, tier, idx)`."""
  key = os.environ.get("GAUNTLET_CRN_SECRET", "") if secret is None else secret
  if key:
    msg = f"{int(base_seed)}|{task_id}|{tier}|{idx}".encode("utf-8")
    digest = hmac.new(key.encode("utf-8"), msg, hashlib.sha256).digest()
    entropy: Any = list(np.frombuffer(digest[:16], dtype=np.uint32))
  else:
    entropy = [int(base_seed), zlib.crc32(task_id.encode()), TIERS.index(tier), idx]
  ss = np.random.SeedSequence(entropy)
  spec, sensor = (np.random.default_rng(s) for s in ss.spawn(2))
  return Streams(spec=spec, sensor=sensor)


def sample(tier: str, idx: int, rng: np.random.Generator) -> PSpec:
  """Samples a `PSpec` for `tier`; draws happen in a fixed field order."""
  defaults = PSpec()
  values: dict[str, Any] = {"tier": tier, "idx": idx}
  for field, (lo, hi) in TIER_RANGES[tier].items():
    default = getattr(defaults, field)
    if isinstance(default, tuple):
      values[field] = tuple(float(v) for v in rng.uniform(lo, hi, len(default)))
    elif field in _INT_FIELDS:
      values[field] = int(rng.integers(int(lo), int(hi) + 1))
    else:
      values[field] = float(rng.uniform(lo, hi))
  if tier == "T3":
    values["disturbance"] = DISTURBANCES[idx % 3]
    values["push_dir_rad"] = float(rng.uniform(0.0, 2.0 * math.pi))
  if tier == "T4" and rng.random() < 0.5:
    values["fault"] = FAULTS[int(rng.integers(2))]
    values["fault_trigger"] = TRIGGERS[int(rng.integers(2))]
    hi = 110 if values["fault_trigger"] == "arm_motion" else 67
    values["fault_delay"] = int(rng.integers(3, hi))
    if values["fault"] == "camera_freeze":
      values["fault_restamp"] = bool(rng.integers(2))
  return PSpec(**values)
