"""Optional Gymnasium Ant-v5 benchmark worker.

The SDK is imported only after the worker is explicitly launched. The worker
uses Gymnasium's own reset/step/TimeLimit and reports reward/termination as the
evaluator; Ant-v5 has no binary success predicate.

Every episode writes its own product artifacts under
``<outputDir>/<episodeId>/``:

* ``episode.json`` -- final score record (terminal state, cumulative return,
  recording summary, release/close status). Written atomically on the terminal
  step and again on stop/close.
* ``steps.jsonl`` -- append-only per-step trajectory log: applied action,
  official reward, running episode return, terminated/truncated flags, torso
  position/velocity, reward terms and the rendered frame path. A failed append
  is reported as ``trajectory.error`` with ``lines``/``failures``/``complete``
  (in ``episode.json`` and in every receipt ``record``) and is never erased by
  a later successful ``episode.json`` write.
* ``generation-1/step-%06d-antview.png`` -- official ``env.render()`` frames.

Only the Python bookkeeping test injects ``World(..., env_factory=...)`` with a
stub environment; the served worker always builds the official
``gymnasium.make("Ant-v5")`` environment, and a stub run must never be reported
as a real Ant-v5 episode.
"""
from __future__ import annotations
import json, math, os, queue, sys, threading, uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

RECORD_SCHEMA_VERSION = 1
BENCH_ID = "gymnasium-mujoco"
TASK_ID = "Ant-v5"
RECORD_NAME = "episode.json"
TRAJECTORY_NAME = "steps.jsonl"
FRAME_DIRECTORY = "generation-1"


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")), flush=True)


# 唯一的请求入口：一个只读 stdin 的守护线程把请求即时排队，主线程（唯一 env.step 调用者）
# 按到达顺序消费。批量 step 由主线程执行，它在每个官方 control step 边界看一眼队列，
# 因此 stop/close/shutdown 不必等整批结束——但环境、状态与回执只有主线程能改。
REQUESTS = queue.Queue()
PENDING = deque()
INTERRUPTS = ("stop", "close", "shutdown")


def read_requests(stream):
    """唯一的 stdin 读取者：只解析并排队，绝不触碰官方环境。"""
    try:
        for line in stream:
            try:
                request = json.loads(line)
            except ValueError as error:
                REQUESTS.put({"method": "__protocol_error__", "id": None, "message": str(error)})
                continue
            REQUESTS.put(request)
    finally:
        # stdin EOF 等价于宿主关闭管道：合成 shutdown，保证 worker 一定退出。
        REQUESTS.put({"method": "shutdown", "id": "__eof", "args": {}})


def take_interrupt(matches):
    """官方 control step 边界取一次中断请求；其余请求按到达顺序排队到 PENDING。

    stop 只在本批次被真正打断后才算被主线程应用：被应用的请求对象会由 step 记上
    ``__receipt``，它稍后被正常处理时直接回这个真实回执，不重复触碰环境。
    """
    found = None
    while True:
        try:
            request = REQUESTS.get_nowait()
        except queue.Empty:
            return found
        PENDING.append(request)
        if found is None and isinstance(request, dict) and request.get("method") in INTERRUPTS and matches(request):
            found = request


def interrupt_matches(world, action, request):
    """shutdown 是进程级中断，close/stop 必须命中当前世界；stop 还要命中当前代次与动作。"""
    method = request.get("method")
    if method == "shutdown":
        return True
    args = request.get("args") or {}
    world_id = args.get("worldId")
    if world_id is not None and world_id != world.episode_id:
        return False
    if method == "close":
        return True
    selection = args.get("selection") or {}
    generation = selection.get("expectedGeneration")
    if generation is not None and generation != world.generation:
        return False
    action_id = selection.get("actionId")
    return action_id is None or action_id == action.get("actionId")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def num(value, default=0.0):
    """JSON-safe finite float.

    Records are written with ``allow_nan=False``, so a non-finite reward term
    must not silently poison the record. The raw official value stays available
    through the live frame/receipt; only the record field falls back here.
    """
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def plain(value):
    """Convert numpy scalar payload values to native Python scalars.

    Gymnasium's Ant-v5 info dict mixes native floats with numpy scalars (for
    example reward_ctrl is numpy.float32), and numpy scalars are not JSON
    serializable. Only the container type changes: the float value is
    preserved exactly via .item(), so official rewards are never rescaled,
    rounded, or reinterpreted.
    """
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, bool):
        return value
    item = getattr(value, "item", None)
    if callable(item) and getattr(value, "shape", None) == ():
        return plain(item())
    return value


def load_sdk():
    import gymnasium
    import numpy as np
    return gymnasium, np


def finite_action(np, value):
    result = np.asarray(value, dtype=np.float32).reshape(-1)
    if result.size != 8:
        raise ValueError("GYMNASIUM_ACTION_DIMENSION_MISMATCH")
    if not np.isfinite(result).all():
        raise ValueError("GYMNASIUM_ACTION_NOT_FINITE")
    if (result < -1).any() or (result > 1).any():
        raise ValueError("GYMNASIUM_ACTION_OUT_OF_RANGE")
    return result


class World:
    def __init__(self, scene, options, sdk=None, env_factory=None):
        self.gymnasium, self.np = sdk if sdk is not None else load_sdk()
        scene = scene or {}
        options = options or {}
        self.scene = scene
        self.seed = int(options.get("seed", 0))
        self.horizon = int(options.get("horizonSteps", 1000))
        output = options.get("outputDir", os.environ.get("LYAPUNOV_GYM_OUTPUT", ".runtime/bench/gymnasium-runs"))
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.episode_id = "gymnasium-ant-" + uuid.uuid4().hex
        self.record_dir = self.output / self.episode_id
        self.record_dir.mkdir(parents=True, exist_ok=True)
        self.record_path = self.record_dir / RECORD_NAME
        self.trajectory_path = self.record_dir / TRAJECTORY_NAME
        self.record_written = False
        self.record_error = None
        self.released = False
        self.release_reason = None
        self.release_step = None
        self.env_closed = False
        self.env_close_error = None
        self.step_index = 0
        self.generation = 1
        self.status = "ready"
        self.ended = False
        # 已受理过的 actionId（含正在执行的）：stop selection 的“动作存在/命中”判定。
        self.actions = set()
        self.terminal_reason = None
        self.last_reward = 0.0
        self.last_terminated = False
        self.last_truncated = False
        self.last_info = {}
        self.episode_return = 0.0
        self.frames = []
        self.render_available = False
        self.render_error = None
        self.steps = []
        # Trajectory write facts are kept separate from record write facts: a
        # later successful episode.json write must never erase a failed/
        # incomplete steps.jsonl append.
        self.trajectory_lines = 0
        self.trajectory_failures = 0
        self.trajectory_error = None
        self.image = None
        factory = env_factory
        if factory is None:
            def factory():
                return self.gymnasium.make("Ant-v5", render_mode="rgb_array")
        self.env = None
        try:
            self.env = factory()
            # Gymnasium's TimeLimit is the official horizon wrapper. Keep the
            # requested horizon equal to its default and fail closed otherwise.
            if int(getattr(self.env, "_max_episode_steps", self.horizon)) != self.horizon:
                raise ValueError("GYMNASIUM_HORIZON_MISMATCH")
            self.obs, self.info = self.env.reset(seed=self.seed)
        except Exception:
            self._shutdown_env()
            raise
        self.last_info = dict(self.info or {})
        self.obs_dim = int(self.np.asarray(self.obs).reshape(-1).size)
        self.capture()

    @property
    def dt(self):
        return float(self.env.unwrapped.dt)

    def handle(self):
        return {
            "worldId": self.episode_id,
            "sceneId": self.scene.get("sceneId", "gymnasium/Ant-v5"),
            "engineId": "gymnasium",
            "engineVersion": TASK_ID,
            "worldGeneration": 1,
            "appliedSceneRevision": self.scene.get("revision", 0),
            "status": self.status,
            "clock": "manual",
            "timestepS": self.dt,
            "recordPath": str(self.record_path),
            "trajectoryPath": str(self.trajectory_path),
        }

    def capture(self):
        if self.env_closed:
            return None
        try:
            image = self.env.render()
        except Exception as error:
            self.render_available = False
            self.render_error = f"{type(error).__name__}: {error}"
            self.image = None
            return None
        if image is None:
            self.render_available = False
            if self.render_error is None:
                self.render_error = "render returned None"
            self.image = None
            return None
        try:
            from PIL import Image
            directory = self.record_dir / FRAME_DIRECTORY
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"step-{self.step_index:06d}-antview.png"
            with path.open("xb") as stream:
                Image.fromarray(self.np.asarray(image)[..., :3].astype(self.np.uint8)).save(stream, format="PNG")
            self.frames.append(str(path))
            self.render_available = True
            self.render_error = None
            self.image = {"camera": "antview", "source": "gymnasium.render", "path": str(path), "mimeType": "image/png", "worldId": self.episode_id, "generation": 1, "stepIndex": self.step_index, "frameId": f"{self.episode_id}:1:{self.step_index}"}
            return str(path)
        except Exception as error:
            self.render_available = False
            self.render_error = f"{type(error).__name__}: {error}"
            self.image = None
            return None

    def frame(self):
        # Ant-v5's raw qpos uses MuJoCo's wxyz quaternion. Preserve the raw
        # vector as observation and expose a normalized product transform only
        # for the torso position/orientation projection.
        data = self.env.unwrapped.data
        xpos = data.xpos[1].tolist() if data.xpos.shape[0] > 1 else data.qpos[:3].tolist()
        quat = data.xquat[1].tolist() if data.xquat.shape[0] > 1 else [1, 0, 0, 0]
        entity = {"entityId": "ant", "transform": {"position": [float(x) for x in xpos], "quaternion": [float(quat[1]), float(quat[2]), float(quat[3]), float(quat[0])], "scale": [1, 1, 1]}, "joints": {"names": ["hip_4", "angle_4", "hip_1", "angle_1", "hip_2", "angle_2", "hip_3", "angle_3"], "positions": [float(x) for x in data.qpos[7:15]], "velocities": [float(x) for x in data.qvel[6:14]]}, "sensors": {"observationVector": [float(x) for x in self.np.asarray(self.obs).reshape(-1)], "observationSource": "Gymnasium Ant-v5 _get_obs", "observationStructure": {"qpos": "qpos excluding x/y", "qvel": "qvel", "cfrc_ext": "cfrc_ext excluding world body"}, "xPosition": num(self.last_info.get("x_position", data.qpos[0])), "yPosition": num(self.last_info.get("y_position", data.qpos[1])), "xVelocity": num(self.last_info.get("x_velocity", 0.0)), "yVelocity": num(self.last_info.get("y_velocity", 0.0)), "rewardForward": num(self.last_info.get("reward_forward", 0.0)), "rewardCtrl": num(self.last_info.get("reward_ctrl", 0.0)), "rewardContact": num(self.last_info.get("reward_contact", 0.0)), "rewardSurvive": num(self.last_info.get("reward_survive", 0.0)), "terminated": bool(self.last_terminated), "truncated": bool(self.last_truncated or self.terminal_reason == "horizon")}}
        if self.image:
            entity["sensors"]["antview"] = dict(self.image)
        return {"worldId": self.episode_id, "generation": 1, "sceneRevision": self.scene.get("revision", 0), "stepIndex": self.step_index, "simTime": self.step_index * self.dt, "frameId": f"{self.episode_id}:1:{self.step_index}", "entities": [entity]}

    def describe(self):
        joints = ["hip_4", "angle_4", "hip_1", "angle_1", "hip_2", "angle_2", "hip_3", "angle_3"]
        return {"entityId": "ant", "modelVersion": "Gymnasium Ant-v5 default ant.xml", "expectedGeneration": 1, "collisionContextVersion": "Ant-v5", "joints": [{"name": n, "type": "hinge", "unit": "rad", "actuator": n, "controlMode": "torque"} for n in joints], "controlledJointNames": joints, "controller": {"controlMode": "official-gymnasium-torque", "kind": "controller", "dimensions": 8, "units": ["N*m normalized torque [-1,1]"] * 8, "lower": [-1.0] * 8, "upper": [1.0] * 8, "frequencyHz": 1.0 / self.dt, "coordinateFrame": "Ant body-local actuator torque", "axisNames": joints, "observationFields": ["qpos excluding current x/y", "qvel", "cfrc_ext excluding world body"]}}

    def _append_step(self, values, frame_path):
        record = {
            "stepIndex": self.step_index,
            "action": [float(v) for v in values],
            "reward": self.last_reward,
            "episodeReturn": self.episode_return,
            "terminated": bool(self.last_terminated),
            "truncated": bool(self.last_truncated or self.terminal_reason == "horizon"),
            "frame": frame_path,
            "xPosition": num(self.last_info.get("x_position", 0.0)),
            "yPosition": num(self.last_info.get("y_position", 0.0)),
            "xVelocity": num(self.last_info.get("x_velocity", 0.0)),
            "yVelocity": num(self.last_info.get("y_velocity", 0.0)),
            "rewardForward": num(self.last_info.get("reward_forward", 0.0)),
            "rewardCtrl": num(self.last_info.get("reward_ctrl", 0.0)),
            "rewardContact": num(self.last_info.get("reward_contact", 0.0)),
            "rewardSurvive": num(self.last_info.get("reward_survive", 0.0)),
        }
        self.steps.append(record)
        try:
            with self.trajectory_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
                stream.write("\n")
            self.trajectory_lines += 1
        except Exception as error:
            # First failure wins: a gap in steps.jsonl stays visible even if a
            # later append succeeds or episode.json is written again.
            if self.trajectory_error is None:
                self.trajectory_error = f"trajectory: {type(error).__name__}: {error}"
            self.trajectory_failures += 1

    def record_payload(self, reason):
        truncated = bool(self.last_truncated) or self.terminal_reason == "horizon"
        return {
            "schemaVersion": RECORD_SCHEMA_VERSION,
            "recordKind": "episode",
            "finalizeReason": reason,
            "benchId": BENCH_ID,
            "taskId": TASK_ID,
            "episodeId": self.episode_id,
            "engine": {
                "name": "gymnasium",
                "version": str(getattr(self.gymnasium, "__version__", "unknown")),
                "envId": TASK_ID,
                "mujocoGlBackend": os.environ.get("MUJOCO_GL", "unspecified"),
            },
            "seed": self.seed,
            "horizonSteps": self.horizon,
            "dtS": self.dt,
            "controlFrequencyHz": (1.0 / self.dt) if self.dt > 0 else 0.0,
            "observationDim": self.obs_dim,
            "observationSource": "Gymnasium Ant-v5 _get_obs",
            "evaluator": "Gymnasium Ant-v5 env.step + TimeLimit",
            "score": {
                "kind": "score-only",
                "episodeReturn": self.episode_return,
                "stepCount": self.step_index,
                "meanReward": (self.episode_return / self.step_index) if self.step_index else 0.0,
                "lastReward": self.last_reward,
                "rewardTerms": {key: num(value) for key, value in sorted(self.last_info.items()) if str(key).startswith("reward_")},
            },
            "status": self.status,
            "terminated": bool(self.last_terminated),
            "truncated": truncated,
            "stepIndex": self.step_index,
            "terminal": {
                "reason": self.terminal_reason,
                "stepIndex": self.step_index,
                "episodeReturn": self.episode_return,
                "terminated": bool(self.last_terminated),
                "truncated": truncated,
                "atIso": utc_now(),
            } if self.terminal_reason else None,
            "release": {
                "released": True,
                "reason": self.release_reason,
                "stepIndex": self.release_step,
                "atIso": utc_now(),
            } if self.released else None,
            "closed": {
                "envClosed": bool(self.env_closed),
                "envCloseError": self.env_close_error,
                "atIso": utc_now(),
            } if self.env_closed else None,
            "recording": {
                "directory": str(self.record_dir / FRAME_DIRECTORY),
                "framePattern": "step-%06d-antview.png",
                "frames": len(self.frames),
                "renderAvailable": bool(self.render_available),
                "renderError": self.render_error,
            },
            "trajectory": {
                "path": str(self.trajectory_path),
                # steps: in-memory stepped substeps; lines: rows that actually
                # reached steps.jsonl. complete is false whenever a row is
                # missing, and error keeps the first write failure.
                "steps": len(self.steps),
                "lines": self.trajectory_lines,
                "failures": self.trajectory_failures,
                "complete": self.trajectory_error is None and self.trajectory_lines == len(self.steps),
                "error": self.trajectory_error,
                "firstStep": self.steps[0]["stepIndex"] if self.steps else None,
                "lastStep": self.steps[-1]["stepIndex"] if self.steps else None,
            },
        }

    def record_ref(self):
        return {
            "path": str(self.record_path),
            "trajectoryPath": str(self.trajectory_path),
            "written": bool(self.record_written),
            # recordError is the episode.json write error only; trajectory
            # completeness facts are reported separately and survive finalize.
            "recordError": self.record_error,
            "trajectoryError": self.trajectory_error,
            "trajectoryLines": self.trajectory_lines,
            "trajectorySteps": len(self.steps),
            "trajectoryFailures": self.trajectory_failures,
            "trajectoryComplete": self.trajectory_error is None and self.trajectory_lines == len(self.steps),
            "frames": len(self.frames),
            "renderAvailable": bool(self.render_available),
            "renderError": self.render_error,
        }

    def finalize(self, reason, release_reason=None):
        """Write episode.json atomically. Re-running after the terminal step is
        intentional: stop/close must add release/close facts without discarding
        a terminal state that was already reached."""
        if release_reason is not None:
            if not self.released:
                self.released = True
                self.release_step = self.step_index
            # 记录最后一次释放动作：transport 先 stop 再 close，终态事实仍是 stop 的步数。
            self.release_reason = release_reason
        try:
            temporary = self.record_path.with_name(self.record_path.name + ".tmp")
            with temporary.open("w", encoding="utf-8") as stream:
                stream.write(json.dumps(self.record_payload(reason), ensure_ascii=False, allow_nan=False, separators=(",", ":")))
                stream.write("\n")
            os.replace(temporary, self.record_path)
            self.record_written = True
            self.record_error = None
        except Exception as error:
            self.record_written = False
            self.record_error = f"{type(error).__name__}: {error}"
        return self.record_ref()

    def step(self, action, interrupt=None):
        if self.ended:
            raise ValueError("GYMNASIUM_EPISODE_TERMINAL")
        values = finite_action(self.np, action.get("values", action.get("positions")))
        count = action.get("stepCount", 1)
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise ValueError("GYMNASIUM_STEP_COUNT_INVALID")
        self.actions.add(action["actionId"])
        start = self.step_index + 1
        reward = 0.0
        stop_request = None
        for _ in range(count):
            # 官方 control step 边界：单步 SDK 调用不可中断，让它自然结束；
            # 剩余批次数在边界上按已到达的 stop/close/shutdown 停下。
            if interrupt is not None:
                stop_request = interrupt()
                if stop_request is not None:
                    # 已到达官方终态优先；此处循环尚未 break，说明本步之前未终结。
                    self.ended = True
                    self.terminal_reason = "cancelled"
                    break
            self.obs, reward, self.last_terminated, self.last_truncated, self.last_info = self.env.step(values)
            self.step_index += 1
            self.last_reward = float(reward)
            self.episode_return += self.last_reward
            frame_path = self.capture()
            if self.last_terminated:
                self.terminal_reason = "terminated"
            elif self.last_truncated or self.step_index >= self.horizon:
                self.terminal_reason = "horizon"
            if self.terminal_reason is not None:
                self.ended = True
            self._append_step(values, frame_path)
            if self.terminal_reason is not None:
                break
        if self.terminal_reason == "terminated":
            self.status = "failure"
        elif self.terminal_reason == "horizon":
            self.status = "timeout"
        elif self.terminal_reason == "cancelled":
            self.status = "cancelled"
        else:
            self.status = "running"
        if stop_request is not None:
            record = self.finalize("episode-cancelled")
        else:
            record = self.finalize("episode-terminal") if self.terminal_reason is not None else self.record_ref()
        frame = self.frame()
        receipt = {"actionId": action["actionId"], "worldId": self.episode_id, "generation": self.generation, "status": "cancelled" if stop_request is not None else "completed", "startStep": start, "endStep": self.step_index, "finalState": frame, "taskAchieved": False, "reason": "STOP_CONFIRMED" if stop_request is not None else self.terminal_reason, "effect": {"controlMode": "official-gymnasium-torque", "reward": self.last_reward, "episodeReturn": self.episode_return, "done": bool(self.last_terminated or self.last_truncated), "terminated": bool(self.last_terminated), "truncated": bool(self.last_truncated), "terminalReason": self.terminal_reason, "benchmarkStatus": self.status, "evaluator": "Gymnasium Ant-v5 env.step + TimeLimit", "scoreOnly": True, "requestedStepCount": count, "stepsExecuted": self.step_index - start + 1, "record": record, "info": plain({k: float(v) if isinstance(v, (int, float)) else v for k, v in self.last_info.items()})}}
        if stop_request is not None:
            # 停止请求在边界上真实生效：批结束后它按序被处理时回同一份真实回执。
            stop_request["__receipt"] = receipt
        return receipt

    def stop(self, selection=None, receipts=None):
        """Release the episode without destroying the world. A terminal state
        already reached is preserved; a running episode becomes cancelled.
        selection 先校验再触碰世界状态。"""
        selection = selection or {}
        generation = selection.get("expectedGeneration")
        if generation is not None and generation != self.generation:
            raise ValueError("STALE_GENERATION")
        action_id = selection.get("actionId")
        if action_id is not None and action_id not in self.actions:
            raise ValueError("ACTION_NOT_FOUND")
        if not self.ended:
            self.ended = True
            self.terminal_reason = "cancelled"
            self.status = "cancelled"
        record = self.finalize("stop", release_reason="stop")
        return {"stopped": True, "stepIndex": self.step_index, "receipts": list(receipts or []), "status": self.status, "episodeReturn": self.episode_return, "terminalReason": self.terminal_reason, "record": record}

    def _shutdown_env(self):
        if self.env is None or self.env_closed:
            return self.env_close_error
        try:
            self.env.close()
            self.env_closed = True
            self.env_close_error = None
        except Exception as error:
            self.env_close_error = f"{type(error).__name__}: {error}"
        return self.env_close_error

    def close(self):
        if not self.ended:
            # 未跑过任何终态的 episode 只记录释放事实，不伪造 terminal 分数。
            self.ended = True
            self.status = "closed"
        self._shutdown_env()
        record = self.finalize("close", release_reason="close")
        return {"released": True, "status": self.status, "stepIndex": self.step_index, "episodeReturn": self.episode_return, "terminalReason": self.terminal_reason, "envClosed": bool(self.env_closed), "envCloseError": self.env_close_error, "record": record}


def serve(stdin):
    worlds = {}
    emit({"event": "ready", "engine": "gymnasium", "version": TASK_ID})
    threading.Thread(target=read_requests, args=(stdin,), name="benchmark-requests", daemon=True).start()
    while True:
        # 批内被搬到 PENDING 的请求按到达顺序在主循环里正常处理。
        request = PENDING.popleft() if PENDING else REQUESTS.get()
        rid = None
        try:
            if request.get("method") == "__protocol_error__":
                emit({"id": None, "error": {"code": "ENGINE_ERROR", "message": str(request.get("message", ""))}})
                continue
            rid, method, args = request.get("id"), request.get("method"), request.get("args", {})
            if method == "shutdown":
                for world in list(worlds.values()):
                    world.close()
                worlds.clear()
                emit({"id": rid, "result": None})
                return
            if method == "list_worlds":
                emit({"id": rid, "result": [world.handle() for world in worlds.values()]}); continue
            if method == "open":
                world = World(args.get("snapshot"), args.get("options", {}))
                worlds[world.episode_id] = world
                emit({"id": rid, "result": world.handle()}); continue
            world = worlds.get(args.get("worldId"))
            if world is None:
                raise ValueError("WORLD_NOT_FOUND")
            if method == "observe":
                result = world.frame()
            elif method == "describe":
                result = world.describe()
            elif method == "execute":
                action = args.get("action", {})
                result = world.step(action, interrupt=lambda: take_interrupt(lambda pending: interrupt_matches(world, action, pending)))
                emit({"id": rid, "result": result})
                emit({"event": "frame", "frame": result["finalState"]})
                continue
            elif method == "receipt":
                raise ValueError("ACTION_NOT_FOUND")
            elif method == "stop":
                applied = request.get("__receipt")
                # 本 stop 在批内边界上已经真实生效：回执记录实际执行步数，不重复停一次。
                result = world.stop(args.get("selection") or {}, [applied] if applied is not None else [])
            elif method == "handle":
                result = world.handle()
            elif method == "close":
                result = world.close()
                worlds.pop(world.episode_id, None)
            else:
                raise ValueError("UNKNOWN_METHOD")
            emit({"id": rid, "result": result})
        except Exception as error:
            emit({"id": rid, "error": {"code": getattr(error, "code", "ENGINE_ERROR"), "message": str(error)}})


def main():
    serve(sys.stdin)


if __name__ == "__main__":
    main()
