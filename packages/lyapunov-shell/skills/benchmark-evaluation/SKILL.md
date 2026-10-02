---
name: benchmark-evaluation
description: Contract for official evaluation environments: preparing, cataloging, loading, stepping, judging official success, and recording LIBERO and Gymnasium benchmarks. Use for running LIBERO, loading a benchmark task, or evaluating a policy. Available only in the benchmark workbench with engine=benchmark. Scene and action semantics are covered by scene-construction / action-execution.
---

# Official evaluation environment contract

This is an **evaluation environment**, not a task classification. Loading is a special case of scene construction with an official read-only projection; stepping is a special case of action execution with the official action space. Success is established only by official `env.check_success()`. Action completion, geometric proximity, and visual guesses cannot substitute for it.

## LIBERO (bench_prepare/catalog/load/step/result/close/run_suite)

- Flow: ready `bench_prepare`, then inspect `bench_catalog` (10 tasks each in libero_spatial/object/goal, libero_90, and the ten long-horizon libero_10 tasks). Use `bench_load {suite, taskIndex}` with official reset+set_init_state and a single active world. Each round, read `bench_result` Frame data (EEF/gripper/object poses/placementRegions/agentview image), then call `bench_step`. Finish with `bench_close`; `bench_run_suite` runs the complete suite.
- Action space: seven normalized world-frame delta values (position ±0.05m, axis-angle ±0.5rad, gripper open_close). Use bounds/axisNames declared by the task and the latest worldId/expectedGeneration.
- Projection: official-robot contains articulation (robot0_joint1..7 plus two gripper joints). It can be selected and directly controlled in the panel through official OSC physics servoing. The official world is **read-only**: no editing, history, or project saving.
- Observation: agentview is 128×128, with per-step PNGs saved to bench-runs and optional mp4 export. The five camera-family operations are **unsupported** for benchmark worlds.

## Gymnasium (benchmark-gymnasium)

- Official suites such as Ant-v5 use the same bench_* contract and score-only evaluation. State and scores must come from this invocation's official environment receipt.

## Actual limitations

- Only this task's official `check_success` establishes success. Historical tasks and action counts do not replace current acceptance. Official region checks do not additionally prove long-term stable placement after gripper release. Plan from actual placementRegions instead of visual guesses.
- Camera capture is unsupported for benchmark worlds; use official agentview.

## File boundaries (ENV-04)

- Allowed: task-workspace scripts, references, intermediate artifacts, and exports, using bash/read/write or other file tools.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`). **Do not change product state by editing stored files**, and do not modify product source. Capability is established by skill contracts and product-tool results.
