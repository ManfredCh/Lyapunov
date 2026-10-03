"""Controlled-API bookkeeping test for worker.py.

This test imports the real worker module and drives the real ``World`` episode
state machine (terminal flags, cumulative return, trajectory/score artifacts,
release) against an in-process stub environment. It exercises bookkeeping only:
the stub is not Ant-v5, produces no MuJoCo physics and must never be reported
as a real benchmark episode. The official-SDK path is covered by
``test/live-episode.test.ts``.

Run with the isolated environment (needs numpy + Pillow, no MuJoCo):
    .runtime/bench/gymnasium-env/bin/python packages/benchmark-gymnasium/python/test_worker_protocol.py
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np

WORKER_PATH = Path(__file__).with_name("worker.py")
REWARD_PER_STEP = 1.5


def load_worker():
    spec = importlib.util.spec_from_file_location("gymnasium_worker_under_test", WORKER_PATH)
    assert spec and spec.loader, f"cannot load {WORKER_PATH}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StubData:
    def __init__(self):
        self.xpos = np.zeros((2, 3), dtype=np.float64)
        self.xquat = np.array([[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]], dtype=np.float64)
        self.qpos = np.zeros(15, dtype=np.float64)
        self.qvel = np.zeros(14, dtype=np.float64)


class StubEnv:
    """Deterministic stand-in for gymnasium.make("Ant-v5").

    ``terminate_at`` turns the official terminated flag on at that step;
    otherwise the episode truncates at ``horizon``.
    """

    def __init__(self, horizon: int, terminate_at: int | None = None, render_ok: bool = True):
        self.dt = 0.05
        self._max_episode_steps = horizon
        self.horizon = horizon
        self.terminate_at = terminate_at
        self.render_ok = render_ok
        self.steps = 0
        self.closed = False
        self.render_calls = 0
        self.actions: list[list[float]] = []
        self.unwrapped = self
        self.data = StubData()

    def reset(self, seed=None):
        self.steps = 0
        return np.zeros(27, dtype=np.float64), {"reward_ctrl": np.float32(-0.1), "reward_survive": 1.0}

    def step(self, action):
        self.steps += 1
        self.actions.append([float(v) for v in np.asarray(action).reshape(-1)])
        terminated = self.terminate_at is not None and self.steps >= self.terminate_at
        truncated = (not terminated) and self.steps >= self.horizon
        info = {
            "reward_ctrl": np.float32(-0.2),
            "reward_forward": np.float64(0.4),
            "reward_survive": 1.0,
            "x_position": np.float64(0.1 * self.steps),
            "y_position": np.float64(0.0),
            "x_velocity": np.float32(0.5),
            "y_velocity": np.float32(0.0),
        }
        return np.zeros(27, dtype=np.float64), REWARD_PER_STEP, terminated, truncated, info

    def render(self):
        self.render_calls += 1
        if not self.render_ok:
            return None
        return np.zeros((4, 6, 3), dtype=np.uint8)

    def close(self):
        self.closed = True


class Harness:
    def __init__(self, horizon: int, terminate_at: int | None = None, render_ok: bool = True):
        self.worker = load_worker()
        self.root = Path(tempfile.mkdtemp(prefix="lyapunov-gym-worker-test-"))
        self.env = StubEnv(horizon, terminate_at, render_ok)
        self.world = self.worker.World(
            {"sceneId": "stub/Ant-v5", "revision": 0},
            {"seed": 7, "horizonSteps": horizon, "outputDir": str(self.root)},
            sdk=(SimpleNamespace(__version__="stub-gymnasium"), np),
            env_factory=lambda: self.env,
        )

    def read_record(self):
        return json.loads(self.world.record_path.read_text(encoding="utf-8"))

    def read_trajectory(self):
        text = self.world.trajectory_path.read_text(encoding="utf-8").strip()
        return [json.loads(line) for line in text.splitlines()] if text else []

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def case_terminated_path():
    harness = Harness(horizon=5, terminate_at=2)
    try:
        world = harness.world
        check(world.handle()["recordPath"].startswith(str(harness.root)), "handle must expose recordPath")
        first = world.step({"actionId": "a1", "values": [0.0] * 8, "stepCount": 10})
        check(first["endStep"] == 2, f"terminated episode must stop at step 2, got {first['endStep']}")
        check(first["effect"]["terminated"] is True, "official terminated flag must be reported")
        check(first["effect"]["truncated"] is False, "terminated step must not claim truncation")
        check(first["effect"]["terminalReason"] == "terminated", "terminal reason must be terminated")
        check(first["effect"]["benchmarkStatus"] == "failure", "terminated episode maps to failure status")
        check(abs(first["effect"]["episodeReturn"] - 2 * REWARD_PER_STEP) < 1e-9, "cumulative return must sum official rewards")
        check(world.status == "failure", "world status must be failure after termination")
        check(first["effect"]["record"]["written"] is True, "terminal step must finalize episode.json")

        record = harness.read_record()
        check(record["status"] == "failure", "record status must be failure")
        check(record["terminal"]["reason"] == "terminated", "record terminal reason must be terminated")
        check(record["truncated"] is False, "record must not claim truncation")
        check(abs(record["score"]["episodeReturn"] - 2 * REWARD_PER_STEP) < 1e-9, "record episodeReturn must equal cumulative return")
        check(record["score"]["stepCount"] == 2, "record stepCount must be the official step index")
        check(record["trajectory"]["steps"] == 2, "trajectory must contain every stepped substep")
        check(record["trajectory"]["lines"] == 2, "healthy trajectory must count its written lines")
        check(record["trajectory"]["complete"] is True, "healthy trajectory must be reported complete")
        check(record["trajectory"]["error"] is None, "healthy trajectory must carry no error")
        steps = harness.read_trajectory()
        check([step["stepIndex"] for step in steps] == [1, 2], "trajectory step indices must be 1..2")
        check(abs(steps[-1]["episodeReturn"] - 2 * REWARD_PER_STEP) < 1e-9, "trajectory running return must match")
        check(steps[-1]["terminated"] is True, "trajectory must record the terminal flag")
        check(steps[0]["action"] == [0.0] * 8, "trajectory must record the applied action")
        check(record["recording"]["frames"] == 3, "recording must count the reset frame plus every stepped frame")
        check(str(world.frames[0]).endswith("step-000000-antview.png"), "the reset observation must be recorded as frame 0")
        check(record["release"] is None, "no release before stop/close")
        for path in [step["frame"] for step in steps]:
            check(path and Path(path).exists(), "each recorded frame path must exist on disk")

        try:
            world.step({"actionId": "a2", "values": [0.0] * 8})
            raise AssertionError("stepping a terminal episode must fail")
        except ValueError as error:
            check("GYMNASIUM_EPISODE_TERMINAL" in str(error), f"unexpected terminal error: {error}")
    finally:
        harness.cleanup()


def case_truncated_path():
    harness = Harness(horizon=3)
    try:
        world = harness.world
        receipt = world.step({"actionId": "roll", "values": [0.25] * 8, "stepCount": 10})
        check(receipt["endStep"] == 3, f"TimeLimit horizon must stop the batch at 3, got {receipt['endStep']}")
        check(receipt["effect"]["truncated"] is True, "truncation at the official horizon must be reported")
        check(receipt["effect"]["terminated"] is False, "stub never terminated")
        check(receipt["effect"]["terminalReason"] == "horizon", "terminal reason must be horizon")
        check(receipt["effect"]["benchmarkStatus"] == "timeout", "horizon truncation maps to timeout")
        check(abs(receipt["effect"]["episodeReturn"] - 3 * REWARD_PER_STEP) < 1e-9, "cumulative return over the truncated episode")
        record = harness.read_record()
        check(record["status"] == "timeout", "record status must be timeout")
        check(record["truncated"] is True, "record must carry truncated=true")
        check(record["terminal"]["stepIndex"] == 3, "record terminal step must be the horizon")
    finally:
        harness.cleanup()


def case_trajectory_write_failure_is_not_erased():
    """A steps.jsonl I/O failure must stay visible after episode.json succeeds.

    The failure is real I/O: the parent directory of the trajectory path does
    not exist, so the worker's own ``open("a")`` raises. No worker method is
    monkeypatched and no exception is swallowed.
    """
    harness = Harness(horizon=10)
    try:
        world = harness.world
        world.trajectory_path = harness.root / "missing-directory" / "steps.jsonl"
        receipt = world.step({"actionId": "io-fail", "values": [0.0] * 8, "stepCount": 2})
        ref = receipt["effect"]["record"]
        check(ref["trajectoryError"], "receipt must report the trajectory write failure")
        check(ref["trajectoryLines"] == 0, "no trajectory line may be claimed after the failed appends")
        check(ref["trajectorySteps"] == 2, "in-memory stepped substeps are still counted")
        check(ref["trajectoryFailures"] == 2, "every failed append must be counted")
        check(ref["trajectoryComplete"] is False, "receipt must not claim a complete trajectory")
        check(ref["written"] is False, "a running episode has no episode.json yet")

        stopped = world.stop()
        check(stopped["record"]["written"] is True, "episode.json itself must still be written")
        check(stopped["record"]["trajectoryError"], "finalize success must not erase the trajectory failure")
        check(stopped["record"]["trajectoryComplete"] is False, "finalize must keep reporting the gap")

        record = harness.read_record()
        check(record["trajectory"]["error"], "record must persist the trajectory error")
        check(record["trajectory"]["lines"] == 0, "record must report zero written lines")
        check(record["trajectory"]["steps"] == 2, "record still reports the stepped substeps")
        check(record["trajectory"]["failures"] == 2, "record must count the failed appends")
        check(record["trajectory"]["complete"] is False, "record must not claim a complete trajectory")
        check(record["release"]["reason"] == "stop", "release facts still finalize normally")
    finally:
        harness.cleanup()


def case_release_paths():
    harness = Harness(horizon=10)
    try:
        world = harness.world
        world.step({"actionId": "part", "values": [0.0] * 8, "stepCount": 4})
        check(not world.record_path.exists(), "a running episode must not finalize episode.json yet")
        stopped = world.stop()
        check(stopped["status"] == "cancelled", "stop before terminal maps to cancelled")
        check(stopped["terminalReason"] == "cancelled", "stop must set a cancelled terminal reason")
        record = harness.read_record()
        check(record["release"]["reason"] == "stop", "stop must record the release reason")
        check(record["closed"] is None, "stop must not claim the env is closed")
        check(harness.env.closed is False, "stop must not close the official env")
        closed = world.close()
        check(closed["envClosed"] is True, "close must release the official env")
        check(harness.env.closed is True, "stub env close must be invoked")
        record = harness.read_record()
        check(record["closed"]["envClosed"] is True, "record must carry envClosed")
        check(record["release"]["reason"] == "close", "close must update the release reason")
        check(record["terminal"]["reason"] == "cancelled", "close must not overwrite an existing terminal state")
        check(abs(record["score"]["episodeReturn"] - 4 * REWARD_PER_STEP) < 1e-9, "release must keep the cumulative return")
        try:
            world.step({"actionId": "late", "values": [0.0] * 8})
            raise AssertionError("stepping a released episode must fail")
        except ValueError as error:
            check("GYMNASIUM_EPISODE_TERMINAL" in str(error), f"unexpected release error: {error}")
    finally:
        harness.cleanup()


def case_close_without_terminal():
    harness = Harness(horizon=10)
    try:
        world = harness.world
        closed = world.close()
        check(closed["status"] == "closed", "closing a fresh episode marks it closed, not a score")
        record = harness.read_record()
        check(record["terminal"] is None, "a closed-but-unstepped episode has no terminal score")
        check(record["score"]["stepCount"] == 0, "zero-step episode must record zero steps")
        check(record["trajectory"]["steps"] == 0, "zero-step episode must have an empty trajectory")
        check(record["release"]["reason"] == "close", "close must record the release reason")
    finally:
        harness.cleanup()


def case_render_unavailable_is_reported():
    harness = Harness(horizon=2, render_ok=False)
    try:
        world = harness.world
        receipt = world.step({"actionId": "no-render", "values": [0.0] * 8, "stepCount": 2})
        check(receipt["effect"]["record"]["renderAvailable"] is False, "unavailable render must be reported")
        record = harness.read_record()
        check(record["recording"]["frames"] == 0, "no frames may be claimed without a render")
        check(record["recording"]["renderError"], "render error must not be silently dropped")
        check(abs(record["score"]["episodeReturn"] - 2 * REWARD_PER_STEP) < 1e-9, "score must survive a missing render")
    finally:
        harness.cleanup()


def case_env_factory_failure_fails_closed():
    worker = load_worker()
    root = Path(tempfile.mkdtemp(prefix="lyapunov-gym-worker-test-"))
    try:
        def broken_factory():
            raise RuntimeError("stub env construction failed")

        try:
            worker.World({}, {"horizonSteps": 1, "outputDir": str(root)}, sdk=(SimpleNamespace(__version__="stub"), np), env_factory=broken_factory)
            raise AssertionError("a failing env factory must propagate")
        except RuntimeError as error:
            check("stub env construction failed" in str(error), f"unexpected error: {error}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    cases = [
        ("terminated episode records terminal state and cumulative return", case_terminated_path),
        ("horizon truncation records timeout terminal state", case_truncated_path),
        ("trajectory write failure stays visible after a successful record write", case_trajectory_write_failure_is_not_erased),
        ("stop/close release preserves terminal and records release facts", case_release_paths),
        ("close without stepping records an unscored release", case_close_without_terminal),
        ("unavailable render is reported instead of faked", case_render_unavailable_is_reported),
        ("env factory failure fails closed", case_env_factory_failure_fails_closed),
    ]
    failures = 0
    for name, case in cases:
        try:
            case()
            print(f"PASS {name}")
        except Exception as error:  # noqa: BLE001 - test runner must report every case
            failures += 1
            print(f"FAIL {name}: {type(error).__name__}: {error}")
    print(f"{len(cases) - failures}/{len(cases)} controlled bookkeeping cases passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
