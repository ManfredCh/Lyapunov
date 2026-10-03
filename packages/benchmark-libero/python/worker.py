"""可选官方套件 worker。模块加载时不导入官方 SDK。"""
from __future__ import annotations

import json
import os
import queue
import re
from pathlib import Path
import sys
import threading
import uuid
from collections import deque
from placement_regions import placement_regions
from scene_projection import ROBOT_ENTITY_ID, SCENE_REVISION, project_frame_entities, project_scene


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")), flush=True)


# 唯一的请求入口：一个只读 stdin 的守护线程把请求即时排队，主线程（唯一物理/世界 owner）
# 按到达顺序消费。批量 step 由主线程执行，它在每个官方 control step 边界看一眼队列，
# 因此 stop/close/shutdown 不必等整批结束——但物理、状态与回执只有主线程能改。
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
    ``__receipt``，它稍后被正常处理时直接回这个真实回执，不重复触碰世界。
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
    """close/shutdown 是整个世界的中断；stop 必须命中当前世界、代次与动作。"""
    if request.get("method") != "stop":
        return True
    args = request.get("args") or {}
    world_id = args.get("worldId")
    if world_id is not None and world_id != world.episode_id:
        return False
    selection = args.get("selection") or {}
    generation = selection.get("expectedGeneration")
    if generation is not None and generation != world.generation:
        return False
    action_id = selection.get("actionId")
    return action_id is None or action_id == action.get("actionId")


def load_sdk():
    if not os.environ.get("LIBERO_CONFIG_PATH"):
        raise RuntimeError("BENCHMARK_SDK_UNAVAILABLE: LIBERO_CONFIG_PATH 未设置；必须由 Lyapunov bench_prepare/bench_load 注入隔离配置，禁止 ~/.libero 交互初始化")
    import numpy as np
    import torch
    from libero.libero import benchmark, get_libero_path
    from libero.libero.envs.env_wrapper import ControlEnv
    return np, torch, benchmark, get_libero_path, ControlEnv


def finite_vector(np, value, expected=None):
    result = np.asarray(value, dtype=np.float32).reshape(-1)
    if expected is not None and result.size != expected:
        raise ValueError("BENCHMARK_ACTION_DIMENSION_MISMATCH")
    if not np.isfinite(result).all():
        raise ValueError("BENCHMARK_ACTION_NOT_FINITE")
    return result


AGENTVIEW_FRAME_NAME = re.compile(r"step-(\d+)-agentview\.png")


def encode_agentview_frames(frames, video_path, fps):
    """把 RGB agentview 帧序列编码成 mp4：write_recording 与事后导出共用的唯一编码路径。"""
    import cv2
    height, width = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(video_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("BENCHMARK_RECORDING_FAILED: cv2 VideoWriter 打不开")
    try:
        for frame in frames:
            writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
    finally:
        writer.release()


def export_agentview_recording(frames_dir, video_path, fps=20):
    """事后导出：把已落盘的官方 agentview 帧序列编码为与 write_recording 同一语义的 mp4。

    只读 ``frames_dir`` 里的 ``step-%06d-agentview.png`` 完整序列（同一真实运行的控制步帧），
    不打开物理世界、不发送模型请求、不改写源帧；``video_path`` 必须不存在（只新建，不覆盖）。
    返回与 write_recording 同族的录制清单，外加导出派生字段（derivation / sourceFrames / sha256）。
    """
    import hashlib
    import numpy as np
    from PIL import Image
    if isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0:
        raise ValueError("BENCHMARK_RECORDING_FPS_INVALID")
    if not frames_dir:
        raise ValueError("BENCHMARK_RECORDING_FRAMES_MISSING")
    if not video_path:
        raise ValueError("BENCHMARK_RECORDING_OUTPUT_MISSING")
    frames_dir = Path(frames_dir).resolve()
    video_path = Path(video_path).resolve()
    if not frames_dir.is_dir():
        raise ValueError("BENCHMARK_RECORDING_FRAMES_MISSING: " + str(frames_dir))
    frame_files = []
    for path in frames_dir.iterdir():
        match = AGENTVIEW_FRAME_NAME.fullmatch(path.name)
        if match and path.is_file():
            frame_files.append((int(match.group(1)), path))
    frame_files.sort(key=lambda item: item[0])
    if not frame_files:
        raise ValueError("BENCHMARK_RECORDING_FRAMES_MISSING: 目录里没有 step-*-agentview.png")
    indexes = [item[0] for item in frame_files]
    if indexes != list(range(indexes[-1] + 1)):
        present = set(indexes)
        missing = [str(index) for index in range(indexes[-1] + 1) if index not in present]
        raise ValueError("BENCHMARK_RECORDING_FRAMES_INCOMPLETE: 缺帧 " + ",".join(missing[:8]) + ("...(+%d)" % (len(missing) - 8) if len(missing) > 8 else ""))
    if video_path.exists():
        raise ValueError("BENCHMARK_RECORDING_EXISTS: 拒绝覆盖已有文件 " + str(video_path))
    frames = []
    for _, path in frame_files:
        with Image.open(path) as image:
            frames.append(np.asarray(image.convert("RGB")))
    size = frames[0].shape[:2]
    for index, frame in enumerate(frames):
        if frame.shape[:2] != size:
            raise ValueError("BENCHMARK_RECORDING_FRAME_SIZE_MISMATCH: 第 " + str(frame_files[index][0]) + " 帧尺寸与首帧不一致")
    video_path.parent.mkdir(parents=True, exist_ok=True)
    encode_agentview_frames(frames, video_path, fps)
    frames_digest = hashlib.sha256()
    for _, path in frame_files:
        with path.open("rb") as stream:
            frames_digest.update(hashlib.sha256(stream.read()).digest())
    video_bytes = video_path.read_bytes()
    return {
        "dir": str(video_path.parent),
        "video": str(video_path),
        "frameCount": len(frame_files),
        "fps": fps,
        "camera": "agentview_image",
        "source": "official-env",
        "codec": "mp4v",
        "width": int(size[1]),
        "height": int(size[0]),
        "preview": str(frame_files[0][1]),
        "derivation": "posthoc-export-of-persisted-agentview-frames",
        "sourceFrames": {
            "dir": str(frames_dir),
            "first": str(frame_files[0][1]),
            "mid": str(frame_files[len(frame_files) // 2][1]),
            "last": str(frame_files[-1][1]),
            "firstStepIndex": frame_files[0][0],
            "lastStepIndex": frame_files[-1][0],
            "sha256": frames_digest.hexdigest(),
        },
        "videoSha256": hashlib.sha256(video_bytes).hexdigest(),
        "videoBytes": len(video_bytes),
        "note": "同一真实运行已落盘 agentview 帧的事后导出：未打开物理世界、未发送模型请求、未改写源帧；不是官方运行时自带 mp4。",
    }


class World:
    def __init__(self, scene, options):
        self.scene = scene or {}
        try:
            np, torch, benchmark, get_libero_path, ControlEnv = load_sdk()
        except Exception as error:
            raise RuntimeError("BENCHMARK_SDK_UNAVAILABLE: " + str(error)) from error
        self.np = np
        options = options or {}
        suite = str(options.get("suite") or os.environ.get("LYAPUNOV_BENCH_SUITE") or "libero_10")
        task_id = str(options.get("taskId") or os.environ.get("LYAPUNOV_BENCH_TASK_ID") or "")
        task_index = int(options.get("taskIndex") or os.environ.get("LYAPUNOV_BENCH_TASK_INDEX") or 0)
        self.initial_state_id = int(options.get("initialStateId") or os.environ.get("LYAPUNOV_BENCH_INIT") or 0)
        self.seed = int(options.get("seed") or os.environ.get("LYAPUNOV_BENCH_SEED") or 0)
        horizon = int(options.get("horizonSteps") or os.environ.get("LYAPUNOV_BENCH_HORIZON") or 1000)
        frequency = int(options.get("controlFrequencyHz") or os.environ.get("LYAPUNOV_BENCH_FREQ") or 20)
        self.output = Path(options.get("outputDir") or os.environ.get("LYAPUNOV_BENCH_OUTPUT") or ".runtime/bench/runs").resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        suites = benchmark.get_benchmark_dict()
        if suite.lower() not in suites:
            raise ValueError("BENCHMARK_SUITE_NOT_FOUND")
        self.suite = suites[suite.lower()]()
        if task_id:
            names = [self.suite.get_task(index).name for index in range(self.suite.n_tasks)]
            if task_id not in names:
                raise ValueError("BENCHMARK_TASK_NOT_FOUND")
            task_index = names.index(task_id)
        if not 0 <= task_index < self.suite.n_tasks:
            raise ValueError("BENCHMARK_TASK_INDEX_OUT_OF_RANGE")
        self.task = self.suite.get_task(task_index)
        bddl = Path(get_libero_path("bddl_files")) / self.task.problem_folder / self.task.bddl_file
        init_path = Path(get_libero_path("init_states")) / self.task.problem_folder / self.task.init_states_file
        if not bddl.is_file() or not init_path.is_file():
            raise ValueError("BENCHMARK_TASK_ASSET_MISSING")
        self.env = ControlEnv(
            bddl_file_name=str(bddl),
            robots=["Panda"], controller="OSC_POSE", gripper_types="default",
            use_camera_obs=True, has_renderer=False, has_offscreen_renderer=True,
            render_camera="agentview", camera_heights=256, camera_widths=256,
            control_freq=frequency, horizon=horizon,
        )
        self.env.seed(self.seed)
        self.env.reset()
        states = torch.load(str(init_path), map_location="cpu")
        if not 0 <= self.initial_state_id < len(states):
            raise ValueError("BENCHMARK_INITIAL_STATE_OUT_OF_RANGE")
        self.last_obs = self.env.set_init_state(states[self.initial_state_id])
        self.step_index = 0
        self.episode_id = "official-" + uuid.uuid4().hex
        self.last_success = bool(self.env.check_success())
        self.first_success_step = None
        self.status = "ready"
        self.suite_name = suite
        self.generation = 1
        self.frequency = frequency
        self.timestep = 1.0 / float(frequency)
        self.agent_frames = []
        self.wrist_frames = []
        self.agentview_observation = None
        self.wrist_observation = None
        self.recording = None
        # 已受理过的 actionId（含正在执行的）：stop selection 的“动作存在”判定。
        self.actions = set()
        self.projection = None
        self.scene_error = None
        self.scene_warnings = []
        self.scene_revision = int(self.scene.get("revision", 0))
        self.frame_error = None
        self.build_projection()
        self.capture()

    # ---- 官方模型 -> Scene/Viewer 投影 ----

    def official_sim(self):
        return self.env.env.sim

    def derived_root(self):
        override = os.environ.get("LYAPUNOV_BENCH_DERIVED")
        if override:
            return Path(override)
        return Path(self.output).parent / "derived-assets"

    def robot_root_body(self):
        for robot in getattr(self.env.env, "robots", None) or []:
            name = getattr(getattr(robot, "robot_model", None), "root_body", None)
            if name:
                return str(name)
        return None

    def object_body_names(self):
        sim = self.official_sim()
        result = {}
        for name, body_id in (getattr(self.env.env, "obj_body_id", None) or {}).items():
            try:
                body_name = sim.model.body_id2name(int(body_id))
            except Exception:  # noqa: BLE001 - 单个对象缺名只影响该实体
                body_name = None
            if body_name:
                result[str(name)] = str(body_name)
        return result

    def build_projection(self):
        """把当前官方状态投影成真实 SceneSnapshot；失败只降级视觉，不影响 episode。"""
        try:
            sim = self.official_sim()
            outcome = project_scene(
                sim.model._model, sim.data._data, sim.model.get_xml(),
                scene_id=self.scene.get("sceneId", self.task.name),
                revision=SCENE_REVISION,
                derived_root=self.derived_root(),
                robot_root=self.robot_root_body(),
                object_bodies=self.object_body_names(),
            )
        except Exception as error:  # noqa: BLE001 - 投影故障不能中断官方 episode
            outcome = {"status": "UNAVAILABLE", "code": "BENCHMARK_SCENE_PROJECTION_FAILED",
                       "message": str(error), "warnings": []}
        self.scene_warnings = list(outcome.get("warnings") or [])
        if outcome.get("status") == "AVAILABLE":
            self.projection = outcome
            self.scene_revision = int(outcome["scene"]["revision"])
        else:
            self.projection = None
            self.scene_error = {
                "code": outcome.get("code") or "BENCHMARK_SCENE_UNAVAILABLE",
                "message": outcome.get("message") or "官方 Scene 投影不可用",
            }

    def projection_summary(self):
        if not self.projection:
            summary = {"status": "UNAVAILABLE"}
            if self.scene_error:
                summary["code"] = self.scene_error["code"]
                summary["message"] = self.scene_error["message"]
            if self.scene_warnings:
                summary["warnings"] = self.scene_warnings[:16]
            return summary
        scene = self.projection["scene"]
        robot = next((entity for entity in self.projection["entities"] if entity["entityId"] == ROBOT_ENTITY_ID), None)
        summary = {
            "status": "AVAILABLE", "source": "official-env",
            "sceneId": scene["sceneId"], "sceneRevision": scene["revision"],
            "entityCount": len(scene["entities"]),
            # 实体 ID 与 sensors.objects 的官方对象名一致，便于把观测映射到 Scene。
            "entityIds": [entity["entityId"] for entity in scene["entities"]],
            "robotEntityId": ROBOT_ENTITY_ID,
            "robotJointNames": [record["name"] for record in (robot["joints"] if robot else [])],
        }
        if self.scene_warnings:
            summary["warnings"] = self.scene_warnings[:16]
        return summary

    def projected_entities(self):
        if not self.projection:
            return None
        try:
            sim = self.official_sim()
            return project_frame_entities(sim.model._model, sim.data._data, self.projection)
        except Exception as error:  # noqa: BLE001 - 帧故障回退到单实体，不中断控制
            if not self.frame_error:
                self.frame_error = str(error)
            return None

    def handle(self):
        return {
            "worldId": self.episode_id,
            "sceneId": self.projection["scene"]["sceneId"] if self.projection else self.scene.get("sceneId", self.task.name),
            "engineId": "official-suite", "engineVersion": "official",
            "worldGeneration": 1, "appliedSceneRevision": self.scene_revision,
            "status": self.status, "clock": "manual", "timestepS": self.timestep,
        }

    def rgb(self, obs, key):
        if not isinstance(obs, dict):
            return None
        image = obs.get(key)
        if image is None:
            return None
        array = self.np.asarray(image)
        if array.ndim != 3 or array.shape[-1] < 3:
            return None
        if array.dtype != self.np.uint8:
            array = self.np.clip(array, 0, 255).astype(self.np.uint8)
        return array[..., :3].copy()

    def capture(self):
        """Persist one immutable official observation for this world/step.

        The image path is part of the same provenance tuple as the Frame. Never
        write a shared ``current-agentview.png``: concurrent Hosts must not be
        able to read another episode's pixels.
        """
        agent = self.rgb(self.last_obs, "agentview_image")
        if agent is not None:
            self.agent_frames.append(agent)
            from PIL import Image
            frame_dir = self.output / self.episode_id / f"generation-{self.generation}"
            frame_dir.mkdir(parents=True, exist_ok=True)
            preview = frame_dir / f"step-{self.step_index:06d}-agentview.png"
            # A given step is captured once. Exclusive creation catches an
            # accidental overwrite instead of silently changing provenance.
            with preview.open("xb") as stream:
                Image.fromarray(agent).save(stream, format="PNG")
            self.agentview_observation = {
                "camera": "agentview_image", "source": "official-env",
                "path": str(preview), "mimeType": "image/png",
                "worldId": self.episode_id, "generation": self.generation,
                "stepIndex": self.step_index,
                "frameId": f"{self.episode_id}:{self.generation}:{self.step_index}",
                "width": int(agent.shape[1]), "height": int(agent.shape[0]),
            }
        wrist = self.rgb(self.last_obs, "robot0_eye_in_hand_image")
        if wrist is not None:
            self.wrist_frames.append(wrist)
            # N342：与 agentview_image 同构的当帧腕相机观测。PNG 落同一个 generation 目录
            # （xb 同防覆盖），并由 frame() 以 Frame 自由键 wrist_image 挂出；只增不改既有字段。
            from PIL import Image
            frame_dir = self.output / self.episode_id / f"generation-{self.generation}"
            frame_dir.mkdir(parents=True, exist_ok=True)
            wrist_preview = frame_dir / f"step-{self.step_index:06d}-wrist.png"
            with wrist_preview.open("xb") as stream:
                Image.fromarray(wrist).save(stream, format="PNG")
            self.wrist_observation = {
                "camera": "robot0_eye_in_hand_image", "source": "official-env",
                "path": str(wrist_preview), "mimeType": "image/png",
                "worldId": self.episode_id, "generation": self.generation,
                "stepIndex": self.step_index,
                "frameId": f"{self.episode_id}:{self.generation}:{self.step_index}:wrist",
                "width": int(wrist.shape[1]), "height": int(wrist.shape[0]),
            }

    def write_recording(self):
        if self.recording:
            return self.recording
        from PIL import Image
        run = self.output / self.episode_id
        run.mkdir(parents=True, exist_ok=True)
        frames = self.agent_frames
        first = last = mid = video = None
        if frames:
            first = run / "agentview-first.png"
            last = run / "agentview-last.png"
            mid = run / "agentview-mid.png"
            Image.fromarray(frames[0]).save(first)
            Image.fromarray(frames[-1]).save(last)
            Image.fromarray(frames[len(frames) // 2]).save(mid)
            if self.wrist_frames:
                Image.fromarray(self.wrist_frames[0]).save(run / "wrist-first.png")
                Image.fromarray(self.wrist_frames[-1]).save(run / "wrist-last.png")
            video = run / "agentview.mp4"
            encode_agentview_frames(frames, video, 20)
        self.recording = {
            "dir": str(run),
            "video": str(video) if video else None,
            "firstFrame": str(first) if first else None,
            "midFrame": str(mid) if mid else None,
            "lastFrame": str(last) if last else None,
            "wristFirst": str(run / "wrist-first.png") if self.wrist_frames else None,
            "wristLast": str(run / "wrist-last.png") if self.wrist_frames else None,
            "frameCount": len(frames),
            "fps": 20,
            "camera": "agentview_image",
            "source": "official-env",
            "preview": self.agentview_observation["path"] if self.agentview_observation else None,
        }
        return self.recording

    def frame(self):
        obs = self.last_obs if isinstance(self.last_obs, dict) else {}
        joints = self.np.asarray(obs.get("robot0_joint_pos", self.np.zeros(7)), dtype=self.np.float32).reshape(-1)
        eef = self.np.asarray(obs.get("robot0_eef_pos", self.np.zeros(3)), dtype=self.np.float32).reshape(-1)
        eef_quat = self.np.asarray(obs.get("robot0_eef_quat", self.np.array([0, 0, 0, 1])), dtype=self.np.float32).reshape(-1)
        gripper = self.np.asarray(obs.get("robot0_gripper_qpos", self.np.zeros(2)), dtype=self.np.float32).reshape(-1)
        objects = {}
        for key, value in obs.items():
            if (not isinstance(key, str) or not key.endswith("_pos") or key.startswith("robot0_")
                    or key.endswith("_to_robot0_eef_pos")):
                continue
            array = self.np.asarray(value, dtype=self.np.float32).reshape(-1)
            if array.size != 3 or not self.np.isfinite(array).all():
                continue
            name = key[:-4]
            item = {"positionM": array.tolist(), "source": "official-env"}
            quat = obs.get(f"{name}_quat")
            if quat is not None:
                q = self.np.asarray(quat, dtype=self.np.float32).reshape(-1)
                if q.size >= 4 and self.np.isfinite(q[:4]).all(): item["quaternionXyzw"] = q[:4].tolist()
            # Keep the raw robot-local relation for audit, but publish a
            # world-frame relation so it matches OSC_POSE Cartesian deltas.
            rel = obs.get(f"{name}_to_robot0_eef_pos")
            if rel is not None:
                r = self.np.asarray(rel, dtype=self.np.float32).reshape(-1)
                if r.size == 3 and self.np.isfinite(r).all(): item["rawToEefPositionM"] = r.tolist()
            if eef.size >= 3:
                world_rel = array[:3] - eef[:3]
                if self.np.isfinite(world_rel).all():
                    item["toEefPositionM"] = world_rel.tolist()
                    item["toEefFrame"] = "world"
            rel_q = obs.get(f"{name}_to_robot0_eef_quat")
            if rel_q is not None:
                rq = self.np.asarray(rel_q, dtype=self.np.float32).reshape(-1)
                if rq.size >= 4 and self.np.isfinite(rq[:4]).all(): item["rawToEefQuaternionXyzw"] = rq[:4].tolist()
            item["fields"] = ["positionM", *(["quaternionXyzw"] if "quaternionXyzw" in item else []), *(["toEefPositionM"] if "toEefPositionM" in item else []), *(["toEefFrame"] if "toEefFrame" in item else []), *(["rawToEefPositionM"] if "rawToEefPositionM" in item else []), *(["rawToEefQuaternionXyzw"] if "rawToEefQuaternionXyzw" in item else [])]
            objects[name] = item
        sensors = {"eefPositionM": eef[:3].tolist(), "eefQuaternionXyzw": (eef_quat[:4] if eef_quat.size >= 4 else self.np.array([0, 0, 0, 1])).tolist(), "gripperQpos": gripper.tolist(), "objects": objects, "source": "official-env", "fields": ["robot0_eef_pos", "robot0_eef_quat", "robot0_gripper_qpos", "objects"]}
        regions = placement_regions(self.env.env, self.episode_id, self.generation, self.step_index)
        if regions:
            sensors["placementRegions"] = regions
            sensors["fields"].append("placementRegions")
        if self.agentview_observation is not None:
            sensors["agentview_image"] = dict(self.agentview_observation)
        if self.wrist_observation is not None:
            sensors["wrist_image"] = dict(self.wrist_observation)
        # 实体来自官方 mjData 投影：每个实体都是真实 body 世界位姿 + 官方关节名/角度。
        entities = self.projected_entities()
        if entities is None:
            entities = [{"entityId": ROBOT_ENTITY_ID, "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": [1, 1, 1]},
                         "joints": {"names": [f"joint{i + 1}" for i in range(len(joints))], "positions": joints.tolist(), "velocities": self.np.zeros_like(joints).tolist()},
                         "sensors": sensors}]
        else:
            entities = [item for item in entities]
            for item in entities:
                if item["entityId"] == ROBOT_ENTITY_ID:
                    item["sensors"] = sensors
                    break
            else:
                entities.insert(0, {"entityId": ROBOT_ENTITY_ID, "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": [1, 1, 1]},
                                    "joints": {"names": [f"joint{i + 1}" for i in range(len(joints))], "positions": joints.tolist(), "velocities": self.np.zeros_like(joints).tolist()},
                                    "sensors": sensors})
        return {
            "worldId": self.episode_id, "generation": self.generation, "sceneRevision": self.scene_revision,
            "stepIndex": self.step_index, "simTime": round(self.step_index * self.timestep, 9),
            "frameId": f"{self.episode_id}:{self.generation}:{self.step_index}",
            "entities": entities,
        }

    def step(self, action, interrupt=None):
        continuing = action.get("continueAfterSuccess") is True
        if continuing and self.first_success_step is None and self.status != "success":
            raise ValueError("BENCHMARK_CONTINUATION_REQUIRES_SUCCESS")
        if self.status in ("timeout", "cancelled") or (self.status == "success" and not continuing):
            raise ValueError("BENCHMARK_EPISODE_TERMINAL")
        kind = action.get("kind") or "control"
        if kind == "control":
            driver = self.control_driver(action)
        elif kind == "gripper":
            driver = self.gripper_driver(action)
        elif kind == "joint":
            driver = self.joint_driver(action)
        else:
            raise ValueError("BENCHMARK_ACTION_KIND_UNSUPPORTED")
        self.actions.add(action["actionId"])
        start = self.step_index + 1
        reward = 0.0
        done = False
        stop_request = None
        # DEV-023：逐 episode 必须留下"**实际下发的动作**"。回执此前只带 actionId 与步数，
        # 事后无法从记录回答"这一步到底发了什么"。这里记首/末两个真正交给 env.step 的向量
        # （恒定向量的驱动首末相同；脚本化驱动能看出它确实在变），并带最外层 kind。
        applied_first = None
        applied_last = None
        for _ in range(driver["steps"]):
            # 官方 control step 边界：单步 SDK 调用不可中断，让它自然结束；
            # 剩余批次数在边界上按已到达的 stop/close/shutdown 停下。
            if interrupt is not None:
                stop_request = interrupt()
                if stop_request is not None:
                    break
            values = driver["values"]()
            if values is None:
                break
            applied_last = [float(v) for v in values]
            if applied_first is None:
                applied_first = list(applied_last)
            self.last_obs, reward, done, _info = self.env.step(values)
            self.step_index += 1
            self.last_success = bool(self.env.check_success())
            if self.last_success and self.first_success_step is None:
                self.first_success_step = self.step_index
            self.capture()
            if (self.last_success and not continuing) or done or self.step_index >= self.env.env.horizon:
                break
        if self.last_success:
            self.status = "success"
        elif self.step_index >= self.env.env.horizon or done:
            self.status = "timeout"
        elif stop_request is not None:
            # 官方终态优先：只有尚未终结的 episode 才因真实停止转 cancelled。
            self.status = "cancelled"
        else:
            self.status = "running"
        frame = self.frame()
        effect = {"controlMode": "official-controller", "reward": float(reward), "done": bool(done),
                  "benchmarkStatus": self.status, "evaluator": "official-env.check_success",
                  "requestedStepCount": driver["steps"], "stepsExecuted": self.step_index - start + 1,
                  "appliedControl": {"kind": kind, "first": applied_first, "last": applied_last,
                                     "steps": self.step_index - start + 1}}
        if continuing:
            effect["continuedInteraction"] = True
        effect.update(driver["effect"]())
        if self.status in ("success", "timeout"):
            effect["recording"] = self.write_recording()
        receipt = {"actionId": action["actionId"], "worldId": self.episode_id, "generation": 1,
                   "status": "cancelled" if stop_request is not None else "completed",
                   "startStep": start, "endStep": self.step_index,
                   "finalState": frame, "taskAchieved": self.last_success,
                   "reason": "check_success" if self.last_success else
                             ("horizon" if self.status == "timeout" else
                              ("STOP_CONFIRMED" if stop_request is not None else None)),
                   "effect": effect}
        if stop_request is not None:
            # 停止请求在边界上真实生效：批结束后它按序被处理时回同一份真实回执。
            stop_request["__receipt"] = receipt
        return receipt

    def control_driver(self, action):
        values = finite_vector(self.np, action.get("values", action.get("positions")), 7)
        step_count = action.get("stepCount", 1)
        if isinstance(step_count, bool) or not isinstance(step_count, int) or step_count <= 0:
            raise ValueError("BENCHMARK_STEP_COUNT_INVALID")
        return {"steps": step_count, "values": lambda: values, "effect": dict}

    def servo_steps(self, action):
        duration = action.get("durationS")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not float(duration) > 0:
            raise ValueError("BENCHMARK_DURATION_INVALID")
        return max(1, round(float(duration) * self.frequency))

    def servo_tolerance(self, action, default):
        value = action.get("tolerance", default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not float(value) > 0:
            raise ValueError("BENCHMARK_TOLERANCE_INVALID")
        return float(value)

    def gripper_ranges(self):
        """指关节 (lo, hi)，与 robot0_gripper_qpos 同序。"""
        model = self.official_sim().model._model
        by_address = {}
        for joint_id in range(int(model.njnt)):
            by_address[int(model.jnt_qposadr[joint_id])] = (float(model.jnt_range[joint_id][0]), float(model.jnt_range[joint_id][1]))
        return [by_address[int(address)] for address in self.env.env.robots[0]._ref_gripper_joint_pos_indexes]

    def gripper_max_width(self):
        return sum(hi - lo for lo, hi in self.gripper_ranges())

    def gripper_width(self):
        """夹爪实测开口（m）：两指镜像关节（range [0,0.04] / [-0.04,0]），开口 = 各指离闭合端的行程之和。"""
        obs = self.last_obs if isinstance(self.last_obs, dict) else {}
        qpos = self.np.asarray(obs.get("robot0_gripper_qpos", self.np.zeros(2)), dtype=self.np.float32).reshape(-1)
        width = 0.0
        for index, (lo, hi) in enumerate(self.gripper_ranges()):
            value = float(qpos[index]) if index < qpos.size else float(lo)
            width += (hi - value) if hi <= 0 else (value - lo)
        return width

    def gripper_driver(self, action):
        """夹爪 servo：只发官方 7 维动作的第 7 维（robosuite panda_gripper 约定 -1 开 / +1 合），
        按实测开口与 widthM 之差输出 ±1，到容差或 durationS 上限停。"""
        target = action.get("widthM")
        max_width = self.gripper_max_width()
        if isinstance(target, bool) or not isinstance(target, (int, float)) or not 0 <= float(target) <= max_width:
            raise ValueError("BENCHMARK_GRIPPER_WIDTH_INVALID")
        target = float(target)
        tolerance = self.servo_tolerance(action, 0.005)

        def values():
            error = target - self.gripper_width()
            if abs(error) <= tolerance:
                return None
            command = self.np.zeros(7, dtype=self.np.float32)
            command[6] = -1.0 if error > 0 else 1.0
            return command

        def effect():
            width = self.gripper_width()
            return {"actualWidthM": width, "targetWidthM": target, "targetReached": abs(width - target) <= tolerance}

        return {"steps": self.servo_steps(action), "values": values, "effect": effect}

    def joint_driver(self, action):
        """关节 servo：scratch MjData 做 FK 求目标 EEF 位姿，再按官方 OSC_POSE 归一化 delta 步进逼近。
        全程只发 7 维官方动作，不改 qpos；冗余自由度下目标关节角可能不可达，回执如实汇报。"""
        names = action.get("jointNames")
        if (not isinstance(names, list) or not names or len(set(names)) != len(names)
                or not all(isinstance(name, str) and name for name in names)):
            raise ValueError("BENCHMARK_JOINT_NAMES_INVALID")
        targets = finite_vector(self.np, action.get("positions"), len(names))
        tolerance = self.servo_tolerance(action, 0.02)
        np = self.np
        import mujoco
        from robosuite.utils.control_utils import orientation_error
        robot = self.env.env.robots[0]
        model = self.official_sim().model._model
        data = self.official_sim().data._data
        qpos_indexes = [int(value) for value in robot._ref_joint_pos_indexes]
        entries = []
        for index, name in enumerate(names):
            joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if joint_id < 0:
                raise ValueError("BENCHMARK_JOINT_UNKNOWN: " + name)
            address = int(model.jnt_qposadr[joint_id])
            if address not in qpos_indexes:
                raise ValueError("BENCHMARK_JOINT_NOT_CONTROLLED: " + name)
            if int(model.jnt_limited[joint_id]) and not float(model.jnt_range[joint_id][0]) <= float(targets[index]) <= float(model.jnt_range[joint_id][1]):
                raise ValueError("BENCHMARK_JOINT_TARGET_OUT_OF_RANGE: " + name)
            entries.append({"address": address, "obs": qpos_indexes.index(address), "target": float(targets[index])})
        # 控制器跟踪的 EEF 帧就是 grip_site（robosuite 1.4 用 site_xpos/site_xmat 取 ee_pos/ee_ori_mat）。
        eef_site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, str(robot.gripper.important_sites["grip_site"]))
        scratch = mujoco.MjData(model)
        scratch.qpos[:] = data.qpos
        for entry in entries:
            scratch.qpos[entry["address"]] = entry["target"]
        mujoco.mj_forward(model, scratch)
        goal_pos = np.array(scratch.site_xpos[eef_site], dtype=float)
        goal_mat = np.array(scratch.site_xmat[eef_site], dtype=float).reshape(3, 3)
        controller = robot.controller
        # 冗余自由度下笛卡尔 servo 管不到零空间：把 OSC 自带的零空间姿态力矩目标
        # （官方 update_initial_joints 同一机制，纯力矩、不写 qpos）指向目标姿态，
        # 未列出的关节保持当前值；servo 结束再把姿态目标落到实测当前值，机械臂保持不回弹。
        controller.initial_joint = np.array([float(scratch.qpos[address]) for address in qpos_indexes], dtype=float)
        input_max = np.asarray(controller.input_max, dtype=float)
        input_min = np.asarray(controller.input_min, dtype=float)
        output_max = np.asarray(controller.output_max, dtype=float)
        output_min = np.asarray(controller.output_min, dtype=float)
        scale = (output_max - output_min) / (input_max - input_min)
        input_mid = (input_max + input_min) / 2.0
        output_mid = (output_max + output_min) / 2.0

        def measured_joints():
            obs = self.last_obs if isinstance(self.last_obs, dict) else {}
            return np.asarray(obs.get("robot0_joint_pos", np.zeros(7)), dtype=np.float32).reshape(-1)

        def joint_error():
            current = measured_joints()
            return max(abs(float(current[entry["obs"]]) - entry["target"]) for entry in entries)

        def values():
            if joint_error() <= tolerance:
                return None
            delta = np.concatenate([
                goal_pos - np.array(data.site_xpos[eef_site], dtype=float),
                orientation_error(goal_mat, np.array(data.site_xmat[eef_site], dtype=float).reshape(3, 3)),
            ])
            command = np.zeros(7, dtype=np.float32)
            command[:6] = np.clip((delta - output_mid) / scale + input_mid, -1.0, 1.0)
            return command

        def effect():
            error = joint_error()
            current = measured_joints()
            controller.initial_joint = np.array([float(value) for value in current], dtype=float)
            return {"jointNames": list(names),
                    "measuredJointPositions": [round(float(value), 9) for value in current],
                    "targetJointPositions": [entry["target"] for entry in entries],
                    "maxJointErrorRad": round(float(error), 9),
                    "targetReached": bool(error <= tolerance)}

        return {"steps": self.servo_steps(action), "values": values, "effect": effect}

    def stop(self, selection=None):
        """真实停止：官方终态（success/timeout）是已发生的事实，优先保留；
        只有尚未终结的 episode 才转 cancelled。selection 先校验再触碰世界状态。"""
        selection = selection or {}
        generation = selection.get("expectedGeneration")
        if generation is not None and generation != self.generation:
            raise ValueError("STALE_GENERATION")
        action_id = selection.get("actionId")
        if action_id is not None and action_id not in self.actions:
            raise ValueError("ACTION_NOT_FOUND")
        if self.status not in ("success", "timeout", "cancelled"):
            self.status = "cancelled"
        return {"stopped": True, "stepIndex": self.step_index, "generation": self.generation,
                "status": self.status, "receipts": []}

    def close(self):
        self.env.close()
        self.status = "closed"


world = None
emit({"event": "ready", "engine": "official-suite", "version": "optional"})
threading.Thread(target=read_requests, args=(sys.stdin,), name="benchmark-requests", daemon=True).start()
while True:
    # 批内被搬到 PENDING 的请求按到达顺序在主循环里正常处理。
    request = PENDING.popleft() if PENDING else REQUESTS.get()
    try:
        if request.get("method") == "__protocol_error__":
            emit({"id": None, "error": {"code": "BENCHMARK_ERROR", "message": str(request.get("message", ""))}})
            continue
        method, args = request["method"], request.get("args", {})
        if method == "shutdown":
            if world:
                world.close()
            emit({"id": request["id"], "result": None})
            break
        if method == "open":
            if world:
                raise ValueError("WORLD_EXISTS")
            world = World(args.get("snapshot"), args.get("options", {}))
            result = dict(world.handle())
            result["projection"] = world.projection_summary()
            # 只有 open 携带完整 Scene 文档；list_worlds 保持轻量。
            if world.projection:
                result["scene"] = world.projection["scene"]
            emit({"id": request["id"], "result": result})
        elif method == "export_recording":
            # 事后导出：不需要活动世界，只读已落盘的完整 agentview 帧序列。
            emit({"id": request["id"], "result": export_agentview_recording(
                args.get("framesDir"), args.get("videoPath"), args.get("fps", 20))})
        elif method == "list_worlds":
            emit({"id": request["id"], "result": [world.handle()] if world else []})
        elif world is None:
            raise ValueError("WORLD_NOT_FOUND")
        elif method == "observe":
            emit({"id": request["id"], "result": world.frame()})
        elif method == "describe":
            robot = next((entity for entity in (world.projection["entities"] if world.projection else [])
                          if entity["entityId"] == ROBOT_ENTITY_ID), None)
            joints = [{"name": record["name"],
                       "type": "slide" if record["type"] == 2 else "hinge",
                       "unit": "m" if record["type"] == 2 else "rad"} for record in (robot["joints"] if robot else [])]
            controlled = [str(name) for name in getattr(world.env.env.robots[0], "robot_joints", None) or []]
            emit({"id": request["id"], "result": {"entityId": "official-robot", "modelVersion": world.task.name, "expectedGeneration": 1, "collisionContextVersion": world.task.name, "joints": joints, "controlledJointNames": controlled, "controller": {"controlMode": "official-controller", "dimensions": 7, "frequencyHz": 20, "coordinateFrame": "world-frame Cartesian position delta and world-frame axis-angle delta", "axisNames": ["world_dx", "world_dy", "world_dz", "world_droll", "world_dpitch", "world_dyaw", "gripper_open_close"], "units": ["normalized world dx [-1,1] -> ±0.05 m", "normalized world dy [-1,1] -> ±0.05 m", "normalized world dz [-1,1] -> ±0.05 m", "normalized world droll [-1,1] -> ±0.5 rad", "normalized world dpitch [-1,1] -> ±0.5 rad", "normalized world dyaw [-1,1] -> ±0.5 rad", "gripper open_close [-1,1]"], "gripper": {"maxWidthM": world.gripper_max_width()}}}})
        elif method == "execute":
            action = args["action"]
            emit({"id": request["id"], "result": world.step(action, interrupt=lambda: take_interrupt(lambda pending: interrupt_matches(world, action, pending)))})
        elif method == "receipt":
            raise ValueError("ACTION_NOT_FOUND")
        elif method == "stop":
            applied = request.get("__receipt")
            if applied is not None:
                # 本 stop 在批内边界上已经真实生效：回执记录实际执行步数，不重复停一次。
                emit({"id": request["id"], "result": {"stopped": True, "stepIndex": world.step_index,
                                                       "generation": world.generation, "status": world.status,
                                                       "receipts": [applied]}})
            else:
                emit({"id": request["id"], "result": world.stop(args.get("selection") or {})})
        elif method == "close":
            world.close()
            world = None
            emit({"id": request["id"], "result": None})
        elif method in ("sync", "assist", "capture"):
            raise ValueError("UNSUPPORTED")
        else:
            raise ValueError("UNKNOWN_METHOD")
    except Exception as error:
        emit({"id": request.get("id"), "error": {"code": "BENCHMARK_SDK_UNAVAILABLE" if "BENCHMARK_SDK_UNAVAILABLE" in str(error) else getattr(error, "code", "BENCHMARK_ERROR"), "message": str(error)}})
