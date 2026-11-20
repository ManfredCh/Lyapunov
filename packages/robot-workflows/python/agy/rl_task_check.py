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
"""AST auditor and CUDA-sync smoke tester for MuJoCo Playground RL tasks."""

import argparse
import ast
from collections.abc import Sequence
import json
import os
import pathlib
import sys
from typing import Any

_SYNC_METHODS = frozenset(
    {"item", "cpu", "numpy", "tolist", "nonzero", "new_tensor"}
)
_INPLACE_MODEL_METHODS = frozenset(
    {"copy_", "add_", "sub_", "mul_", "div_", "zero_", "fill_"}
)
_HOT_FN_EXACT = frozenset({
    "step",
    "reset",
    "reset_with_options",
    "on_reset",
    "on_step",
    "produce_features",
    "process_commands",
    "get_substep_measurements",
    "set_substep_commands",
})
_HOT_FN_PREFIXES = ("obs_", "reward_", "termination_", "metric_")


def _attr_chain(node: ast.AST) -> str:
  parts: list[str] = []
  cur = node
  while True:
    if isinstance(cur, ast.Attribute):
      parts.append(cur.attr)
      cur = cur.value
    elif isinstance(cur, ast.Subscript):
      cur = cur.value
    elif isinstance(cur, ast.Name):
      parts.append(cur.id)
      break
    else:
      break
  return ".".join(reversed(parts))


def _is_hot_function(name: str) -> bool:
  return name in _HOT_FN_EXACT or name.startswith(_HOT_FN_PREFIXES)


def _calls_any_or_all_without_dim(node: ast.AST) -> bool:
  for sub in ast.walk(node):
    if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute):
      if sub.func.attr in ("any", "all"):
        has_dim = bool(sub.args) or any(kw.arg == "dim" for kw in sub.keywords)
        if not has_dim:
          return True
  return False


def audit_source(source: str, filename: str = "<string>") -> list[str]:
  """Statically checks task/robot Python source for reaf-sim RL anti-patterns."""
  tree = ast.parse(source, filename=filename)
  issues: list[str] = []
  norm_path = filename.replace("\\", "/")
  in_public_pkg = (
      "/tasks/" in norm_path
      or "/robots/" in norm_path
      or (norm_path.startswith("tasks/") or norm_path.startswith("robots/"))
  )

  for top in tree.body:
    if isinstance(top, (ast.Assign, ast.AnnAssign)):
      targets = top.targets if isinstance(top, ast.Assign) else [top.target]
      for tgt in targets:
        if isinstance(tgt, ast.Name) and tgt.id == "__all__":
          issues.append(f"{filename}:{top.lineno}: prohibited __all__ export.")
      val = top.value
    elif isinstance(top, ast.Expr):
      val = top.value
    else:
      val = None
    if val is not None:
      for sub in ast.walk(val):
        if (
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Attribute)
            and sub.func.attr == "compile"
        ):
          issues.append(
              f"{filename}:{sub.lineno}: module-scope .compile() runs at"
              " import time; move inside a lazy function."
          )

  for node in ast.walk(tree):
    if in_public_pkg and isinstance(node, ast.ImportFrom):
      mod = node.module or ""
      if "._src" in mod or mod.startswith("_src"):
        issues.append(
            f"{filename}:{node.lineno}: private import {mod!r} inside"
            " tasks/ or robots/; use public facades."
        )

    if isinstance(node, ast.AugAssign):
      chain = _attr_chain(node.target)
      if ".model." in f".{chain}." or ".data." in f".{chain}.":
        issues.append(
            f"{filename}:{node.lineno}: augmented assignment on {chain!r}"
            " bypasses or breaks TorchWrapper; use full assignment with"
            " torch.where."
        )

    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
      if node.func.attr in _INPLACE_MODEL_METHODS:
        recv = _attr_chain(node.func.value)
        if ".model." in f".{recv}.":
          issues.append(
              f"{filename}:{node.lineno}: untracked in-place .{node.func.attr}"
              f" on {recv!r} bypasses TorchWrapper SetConstLevel tracking."
          )

    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
      crop_lines: list[int] = []
      resize_lines: list[int] = []
      for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
          fn_name = (
              sub.func.attr
              if isinstance(sub.func, ast.Attribute)
              else (sub.func.id if isinstance(sub.func, ast.Name) else "")
          )
          if "crop" in fn_name.lower():
            crop_lines.append(sub.lineno)
          if fn_name in ("interpolate", "resize"):
            resize_lines.append(sub.lineno)
      if crop_lines and resize_lines and min(resize_lines) < min(crop_lines):
        issues.append(
            f"{filename}:{min(resize_lines)}: resize/interpolate called before"
            f" crop in {node.name}(); center-crop before resizing."
        )

      if node.name == "on_reset":
        for sub in ast.walk(node):
          if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute):
            chain = _attr_chain(sub.func)
            if chain.endswith("device_layer.reset") or chain.endswith(
                "device_layer.forward"
            ):
              issues.append(
                  f"{filename}:{sub.lineno}: prohibited {chain}() inside"
                  " on_reset(); Environment flushes set_const and forward."
              )

      if _is_hot_function(node.name):
        for sub in ast.walk(node):
          if isinstance(sub, ast.Call):
            if isinstance(sub.func, ast.Attribute):
              if sub.func.attr in _SYNC_METHODS:
                issues.append(
                    f"{filename}:{sub.lineno}: host-device sync"
                    f" .{sub.func.attr}() inside hot function {node.name}()."
                )
            elif isinstance(sub.func, ast.Name) and sub.func.id == "bool":
              issues.append(
                  f"{filename}:{sub.lineno}: bool(...) inside hot function"
                  f" {node.name}() risks CUDA host-device sync."
              )
          if isinstance(sub, (ast.If, ast.While, ast.Assert)):
            if _calls_any_or_all_without_dim(sub.test):
              issues.append(
                  f"{filename}:{sub.lineno}: branching on .any()/.all() inside"
                  f" {node.name}() triggers CUDA host-device sync; use"
                  " torch.where."
              )

  return issues


def audit_task_dir(task_dir: str | pathlib.Path) -> list[str]:
  """Audits all Python files under `task_dir`."""
  root = pathlib.Path(task_dir)
  if root.is_file():
    files = [root]
  else:
    files = sorted(
        p for p in root.rglob("*.py") if "__pycache__" not in p.parts
    )
  issues: list[str] = []
  for path in files:
    issues.extend(audit_source(path.read_text(encoding="utf-8"), str(path)))
  return issues


def _check_finite_tree(tree_obj: Any, label: str) -> dict[str, list[int]]:
  import torch

  shapes: dict[str, list[int]] = {}
  if isinstance(tree_obj, torch.Tensor):
    if not bool(torch.isfinite(tree_obj).all().item()):
      raise RuntimeError(f"Non-finite tensor in {label}.")
    shapes[label] = list(tree_obj.shape)
  elif isinstance(tree_obj, dict):
    for k, v in tree_obj.items():
      shapes.update(_check_finite_tree(v, f"{label}.{k}"))
  return shapes


def _sample_random_action(action_spec: Any, nworld: int, device: str) -> Any:
  import torch

  if isinstance(action_spec, dict):
    return {
        k: _sample_random_action(v, nworld, device)
        for k, v in action_spec.items()
    }
  raw = tuple(action_spec.shape)
  shape = raw if (len(raw) >= 2 and raw[0] == nworld) else (nworld, *raw)
  return torch.empty(shape, dtype=torch.float32, device=device).uniform_(
      -0.5, 0.5
  )


def smoke_test_env(
    env_id: str,
    *,
    repo_root: str | pathlib.Path | None = None,
    nworld: int = 4,
    steps: int = 5,
    check_cuda_sync: bool = True,
) -> dict[str, Any]:
  """Runs CPU, CUDA sync-debug, and deployment-config checks on `env_id`."""
  if repo_root is not None:
    root_str = str(pathlib.Path(repo_root).resolve())
    if root_str not in sys.path:
      sys.path.insert(0, root_str)

  import torch
  import warp as wp
  from mujoco_playground._src.rl import env_registry
  from reaf.simulation import torch as reaf_sim
  from reaf.simulation.torch import flat_scene

  os.environ.setdefault("MUJOCO_GL", "osmesa")
  wp.config.kernel_cache_dir = os.environ.get(
      "WP_KERNEL_CACHE_DIR", "/tmp/wp_kernel_cache"
  )

  entry = env_registry.get(env_id)
  actor_groups = tuple(entry.runner_cfg.obs_groups["actor"])
  deploy_cfg = flat_scene.make_deployment_config(
      entry.env_cfg_fn(), observation_groups=actor_groups
  )
  if deploy_cfg.sim.nworld != 1 or deploy_cfg.task_layer.rewards:
    raise RuntimeError("make_deployment_config failed to strip training terms.")

  cpu_env = entry.env_builder(nworld=1, device="cpu", impl="cpp")
  try:
    ts = cpu_env.reset()
    obs_shapes = _check_finite_tree(ts.observation, "obs")
    act_spec = cpu_env.action_spec()
    for _ in range(2):
      ts = cpu_env.step(_sample_random_action(act_spec, 1, "cpu"))
      _check_finite_tree(ts.observation, "obs")
      if ts.reward is None:
        raise RuntimeError("Post-step reward is None on training env.")
      _check_finite_tree(ts.reward, "reward")
  finally:
    cpu_env.close()

  cuda_checked = False
  if torch.cuda.is_available():
    gpu_env = entry.env_builder(nworld=nworld, device="cuda:0", impl="warp")
    try:
      gpu_env.auto_reset_mode = reaf_sim.AutoResetMode.NO_SYNC
      act_spec = gpu_env.action_spec()
      gpu_env.reset()
      gpu_env.step(_sample_random_action(act_spec, nworld, "cuda:0"))
      reset_opts = gpu_env.default_reset_options()
      reset_mask = torch.zeros(nworld, dtype=torch.bool, device="cuda:0")
      reset_mask[0] = True
      gpu_env.reset_with_options(options=reset_opts, env_mask=reset_mask)
      torch.cuda.synchronize()

      prev_mode = torch.cuda.get_sync_debug_mode()
      if check_cuda_sync:
        torch.cuda.set_sync_debug_mode("error")
      try:
        for _ in range(steps):
          act = _sample_random_action(act_spec, nworld, "cuda:0")
          ts = gpu_env.step(act)
        gpu_env.reset_with_options(options=reset_opts, env_mask=reset_mask)
      finally:
        if check_cuda_sync:
          torch.cuda.set_sync_debug_mode(prev_mode)
      torch.cuda.synchronize()
      _check_finite_tree(ts.observation, "cuda_obs")
      _check_finite_tree(ts.reward, "cuda_reward")
      cuda_checked = True
    finally:
      gpu_env.close()

  return {
      "ok": True,
      "env_id": env_id,
      "cpu_checked": True,
      "cuda_checked": cuda_checked,
      "obs_shapes": obs_shapes,
  }


def main(argv: Sequence[str] | None = None) -> int:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
      "--action", choices=("all", "audit", "smoke"), default="all"
  )
  parser.add_argument("--repo_root", type=str, default=".")
  parser.add_argument("--task_dir", type=str, nargs="*", default=())
  parser.add_argument("--env_id", type=str, default="")
  parser.add_argument("--nworld", type=int, default=4)
  parser.add_argument("--steps", type=int, default=5)
  args = parser.parse_args(argv)

  if args.action in ("all", "audit") and args.task_dir:
    all_issues: list[str] = []
    for d in args.task_dir:
      all_issues.extend(audit_task_dir(d))
    if all_issues:
      for issue in all_issues:
        print(f"AUDIT_ERROR: {issue}", file=sys.stderr)
      return 1

  result: dict[str, Any] = {"ok": True}
  if args.action in ("all", "smoke") and args.env_id:
    result = smoke_test_env(
        args.env_id,
        repo_root=args.repo_root,
        nworld=args.nworld,
        steps=args.steps,
    )
  print(json.dumps(result, indent=2))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
