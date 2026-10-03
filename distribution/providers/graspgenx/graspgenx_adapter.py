#!/usr/bin/env python3
"""Truth-preserving Lyapunov-to-GraspGenX ZMQ adapter.

The Lyapunov planning sidecar sends the request envelope used by the original
GraspGen worker.  GraspGenX has compatible pose/confidence payloads, but it is
a different provider with different metadata and a smaller public ``infer``
wire surface.  This process keeps that identity visible while translating the
supported inference fields to the pinned GraspGenX server.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import msgpack
import msgpack_numpy
import numpy as np
import zmq

msgpack_numpy.patch()

LOGGER = logging.getLogger("lyapunov.graspgenx_adapter")

GRASPGENX_REPOSITORY = "https://github.com/NVlabs/GraspGenX"
GRASPGENX_COMMIT = "b9429097728cb1c430dd78b92edf17ba318aad03"
MODEL_REPOSITORY = "adithyamurali/GraspGenXModel"
MODEL_REVISION = "7c834043c11a11417e31d6d5ea9355801e40a2c1"
GRIPPER_REPOSITORY = "adithyamurali/gripper_descriptions"
GRIPPER_REVISION = "19a03c00d19aeaf052d0f6801f0041982d676e8a"

PROVIDER_ID = "graspgen"
PROVIDER_VERSION = "nv-graspgenx-zmq-adapter-2"
PROTOCOL_REVISION = "nvlabs-graspgenx-b9429097-lyapunov-adapter-v2"
GRIPPER_NAME = "franka_panda"
EXPECTED_POINT_COUNT = 2048

# These sizes and SHA-256 values were resolved from the pinned Hugging Face
# revision.  Hashing the large files is deliberately a one-time startup gate
# before the model is loaded, not a per-request cost.
MODEL_ARTIFACTS: dict[str, tuple[int, str]] = {
    "README.md": (
        169,
        "910ec6bb6ebd3f89391fb6e0697b1b7401a7f65d7b34ecb08c3486048554e80e",
    ),
    "release/gen/config.yaml": (
        4_006,
        "16aedbdc23441a1db818261b865f55bd71451d6224fc514615e0d1ab744b7dcb",
    ),
    "release/gen/epoch_736.pth": (
        1_210_918_342,
        "8b55f31cdb8340a573b4df27b027c15cff326bd6debcb389bf631d2aaab7ac44",
    ),
    "release/dis/config.yaml": (
        4_024,
        "43cf8ea0ade67d938040bde0df318b3f4c9c19e4f88d97052dc175df2c28c8e7",
    ),
    "release/dis/epoch_1056.pth": (
        483_889_478,
        "cbf3f3bdb2e4c03fca8486ed24de0e6a8a859e6bd22bce2f1434a610335abd3e",
    ),
}

GRIPPER_CONFIG_RELATIVE_PATH = (
    "gripper_descriptions/assets/x_grippers/franka_panda/config.json"
)
GRIPPER_CONFIG_SIZE = 1_028
GRIPPER_CONFIG_SHA256 = (
    "a1fe1b7c9d77bbd568e4f656fab65e2da083d4c387f239150e89a6c6451961de"
)
HF_MANIFEST_NAME = ".lyapunov-hf-manifest.json"
LEGACY_HF_MANIFEST_NAME = ".lyaup-hf-manifest.json"
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_GRIPPER_PREFIX = "gripper_descriptions/assets/x_grippers/franka_panda"
GRIPPER_ARTIFACTS: dict[str, tuple[int, str]] = {
    "LICENSE_ASSETS": (
        4_119,
        "cabc2ed9b0e497d20abb50ca75efb754841bf62997f5b1ee98d1d32c221bd314",
    ),
    "README.md": (
        5_856,
        "9cda6967cccd41390f980cb572e9c9aa85cef1837081b9edd8b8142f67559ed9",
    ),
    f"{_GRIPPER_PREFIX}/README.md": (
        62,
        "6d80663e3b3917c7a645c2e41d11032b7471f0354655b577fd51cd361fb05db1",
    ),
    f"{_GRIPPER_PREFIX}/coll_mesh.obj": (
        15_038,
        "6feba508f92c6c6609d6639c4c2883200aaacd31f507370d479b25be1ea0e3b8",
    ),
    GRIPPER_CONFIG_RELATIVE_PATH: (
        GRIPPER_CONFIG_SIZE,
        GRIPPER_CONFIG_SHA256,
    ),
    f"{_GRIPPER_PREFIX}/gripper.urdf": (
        3_728,
        "b49f211b29b61e6bedef627a3ec6bc7c11026099ae2db30cc51fc2d60ff3d93c",
    ),
    f"{_GRIPPER_PREFIX}/gripper_spherical_dof.urdf": (
        4_974,
        "ed1957a3ca7b95a02e5f311263024fda401a65ffe993d31918f0d9a3f9cc7273",
    ),
    f"{_GRIPPER_PREFIX}/material.mtl": (
        198,
        "0d90fe7d688a6da0b82b0f8053231a1c8986de34aa839f8113ed53a610c09227",
    ),
    f"{_GRIPPER_PREFIX}/material_0.png": (
        104,
        "cb6fba891efa7bc1b914783aaaf37d082820eb619cc68f2e87988cb209813e38",
    ),
    f"{_GRIPPER_PREFIX}/meshes/collision/hand.stl": (
        10_084,
        "94493e94f30fe940f2c8ca2f155c3bbe67bbff406d3edf5e261670d2f0f6e2ed",
    ),
    f"{_GRIPPER_PREFIX}/meshes/visual/finger.dae": (
        51_239,
        "caefea762f2d18ca9412cf6c2e64e5007ad03571181d790a8e0c828b1b2035cf",
    ),
    f"{_GRIPPER_PREFIX}/meshes/visual/hand.dae": (
        549_239,
        "fe5d445d509e44a9bd107ff78f0b03c49752c98e5e0a8ebafddf2b6cf5a8b380",
    ),
    f"{_GRIPPER_PREFIX}/points.json": (
        2_013_837,
        "e3dd25866e07a8575e029ba7d076ce864bb70298a83fabd997b0b0317a890287",
    ),
    f"{_GRIPPER_PREFIX}/proc_gripper_only_pointnet_vae_repr.json": (
        4_441,
        "a001d64498fdd3061310ad3f0ac01e6a2f55502c17cee33af87da15ebba18bf5",
    ),
    f"{_GRIPPER_PREFIX}/tsdf.npy": (
        524_736,
        "1ad8fed1231a9cf03b5824c2811cbb1ee03b8a120729d314230e3eedd44f7bed",
    ),
    f"{_GRIPPER_PREFIX}/vis_mesh.obj": (
        1_720_972,
        "a10ae0e4a565baeb73a6cbf67fe97a0b2b5478c2c3b837580e786f5a3a797adf",
    ),
}
GRIPPER_CONFIG_URI = (
    f"https://huggingface.co/datasets/{GRIPPER_REPOSITORY}/blob/{GRIPPER_REVISION}/"
    f"{GRIPPER_CONFIG_RELATIVE_PATH}"
)
MODEL_URI = f"https://huggingface.co/{MODEL_REPOSITORY}/tree/{MODEL_REVISION}"
TERMS_ENVIRONMENT_VARIABLE = "LYAPUNOV_GRASPGENX_TERMS_ACCEPTED"
LEGACY_TERMS_ENVIRONMENT_VARIABLE = "LYAUP_GRASPGENX_TERMS_ACCEPTED"
TERMS_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_GRASPGENX_MODEL_AND_ASSET_TERMS"

_UPSTREAM_INFER_FIELDS = (
    "point_cloud",
    "num_grasps",
    "grasp_threshold",
    "topk_num_grasps",
)
_LEGACY_ONLY_DEFAULTS: dict[str, object] = {
    "min_grasps": 1,
    "max_tries": 1,
    "remove_outliers": True,
}
_INFER_REQUEST_KEYS = {
    "action",
    "gripper_name",
    "include_counts",
    *_UPSTREAM_INFER_FIELDS,
    *_LEGACY_ONLY_DEFAULTS,
}


class AdapterError(RuntimeError):
    """An expected, safe-to-report protocol failure."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail

    def wire_response(self) -> dict[str, str]:
        return {"error": f"{self.code}: {self.detail}"}


@dataclass(frozen=True)
class AdapterConfig:
    listen_host: str = "0.0.0.0"
    listen_port: int = 5556
    upstream_endpoint: str = "tcp://127.0.0.1:5557"
    upstream_timeout_ms: int = 120_000
    gripper_name: str = GRIPPER_NAME
    pins_verified: bool = False


class ZmqRequestClient:
    """One-shot REQ client; a fresh socket avoids poisoned REQ state on timeout."""

    def __init__(self, endpoint: str, timeout_ms: int):
        self.endpoint = endpoint
        self.timeout_ms = timeout_ms

    def request(self, payload: Mapping[str, object]) -> dict[str, object]:
        context = zmq.Context()
        socket = context.socket(zmq.REQ)
        socket.setsockopt(zmq.SNDTIMEO, self.timeout_ms)
        socket.setsockopt(zmq.RCVTIMEO, self.timeout_ms)
        socket.setsockopt(zmq.LINGER, 0)
        try:
            socket.connect(self.endpoint)
            socket.send(msgpack.packb(dict(payload), use_bin_type=True))
            response = msgpack.unpackb(socket.recv(), raw=False)
        except zmq.Again as exc:
            raise AdapterError("upstream_timeout", "GraspGenX did not reply") from exc
        except Exception as exc:
            raise AdapterError(
                "upstream_unavailable", "GraspGenX transport failed"
            ) from exc
        finally:
            socket.close(linger=0)
            context.term()

        if not isinstance(response, dict):
            raise AdapterError("upstream_invalid", "GraspGenX reply is not a map")
        if "error" in response:
            LOGGER.warning("GraspGenX rejected a request: %s", response.get("error"))
            raise AdapterError("upstream_error", "GraspGenX rejected the request")
        return response


class GraspGenXAdapter:
    def __init__(self, config: AdapterConfig, upstream: ZmqRequestClient):
        self.config = config
        self.upstream = upstream

    def dispatch(self, request: object) -> dict[str, object]:
        if not isinstance(request, dict):
            raise AdapterError("invalid_request", "request must be a map")
        action = request.get("action")
        if action == "health":
            if set(request) != {"action"}:
                raise AdapterError(
                    "invalid_request", "health accepts only the action field"
                )
            return self._health()
        if action == "metadata":
            if set(request) != {"action"}:
                raise AdapterError(
                    "invalid_request", "metadata accepts only the action field"
                )
            return self._metadata()
        if action == "infer":
            return self._infer(request)
        raise AdapterError("unknown_action", f"unsupported action {action!r}")

    def _health(self) -> dict[str, object]:
        response = self.upstream.request({"action": "health"})
        if response != {"status": "ok"}:
            raise AdapterError("upstream_invalid", "unexpected health response")
        upstream_metadata = self.upstream.request({"action": "metadata"})
        self._validate_upstream_metadata(upstream_metadata)
        return {
            "status": "ok",
            "provider_id": PROVIDER_ID,
            "provider_version": PROVIDER_VERSION,
            "protocol_revision": PROTOCOL_REVISION,
            "source_commit": GRASPGENX_COMMIT,
            "model_name": MODEL_URI,
            "model_revision": MODEL_REVISION,
            "gripper_config": GRIPPER_CONFIG_URI,
            "gripper_revision": GRIPPER_REVISION,
            "panda_config_sha256": GRIPPER_CONFIG_SHA256,
            "pins_verified": self.config.pins_verified,
        }

    def _metadata(self) -> dict[str, object]:
        if not self.config.pins_verified:
            raise AdapterError(
                "pins_unverified", "runtime source/model/gripper pins were not verified"
            )
        upstream = self.upstream.request({"action": "metadata"})
        self._validate_upstream_metadata(upstream)
        # This exact, compact field set is frozen by the GraspGenX provider
        # descriptor.  Immutable URIs keep the historical names truthful.
        return {
            "gripper_name": self.config.gripper_name,
            "model_name": MODEL_URI,
            "gripper_config": GRIPPER_CONFIG_URI,
            "provider_id": PROVIDER_ID,
            "provider_version": PROVIDER_VERSION,
            "protocol_revision": PROTOCOL_REVISION,
            "source_commit": GRASPGENX_COMMIT,
            "model_revision": MODEL_REVISION,
            "gripper_revision": GRIPPER_REVISION,
            "panda_config_sha256": GRIPPER_CONFIG_SHA256,
            "pins_verified": self.config.pins_verified,
        }

    def _validate_upstream_metadata(self, metadata: Mapping[str, object]) -> None:
        default_gripper = metadata.get("default_gripper")
        loaded_grippers = metadata.get("loaded_grippers")
        model = metadata.get("model")
        actions = metadata.get("actions")

        if default_gripper != self.config.gripper_name:
            raise AdapterError(
                "upstream_identity_mismatch",
                "GraspGenX default gripper is not franka_panda",
            )
        if (
            not isinstance(loaded_grippers, list)
            or self.config.gripper_name not in loaded_grippers
        ):
            raise AdapterError(
                "upstream_identity_mismatch",
                "GraspGenX has not loaded franka_panda",
            )
        if not isinstance(actions, list) or not {
            "health",
            "metadata",
            "infer",
        }.issubset(set(actions)):
            raise AdapterError(
                "upstream_identity_mismatch", "GraspGenX infer is unavailable"
            )
        if not isinstance(model, dict):
            raise AdapterError(
                "upstream_identity_mismatch", "GraspGenX model metadata is missing"
            )
        if (
            model.get("generator_backbone") != "ptv3vanilla"
            or model.get("discriminator_backbone") != "ptv3vanilla"
            or model.get("grasp_repr") != "r3_so3"
        ):
            raise AdapterError(
                "upstream_identity_mismatch",
                "unexpected GraspGenX release-model architecture",
            )

    def _infer(self, request: Mapping[str, object]) -> dict[str, object]:
        if not self.config.pins_verified:
            raise AdapterError(
                "pins_unverified", "runtime source/model/gripper pins were not verified"
            )
        unknown = set(request) - _INFER_REQUEST_KEYS
        if unknown:
            raise AdapterError(
                "invalid_request", f"unexpected infer fields: {sorted(unknown)}"
            )

        requested_gripper = request.get("gripper_name", self.config.gripper_name)
        if requested_gripper != self.config.gripper_name:
            raise AdapterError(
                "invalid_request", "this Lyapunov adapter is pinned to franka_panda"
            )

        point_cloud = request.get("point_cloud")
        if (
            not isinstance(point_cloud, np.ndarray)
            or point_cloud.dtype != np.float32
            or point_cloud.shape != (EXPECTED_POINT_COUNT, 3)
            or not np.isfinite(point_cloud).all()
        ):
            raise AdapterError(
                "invalid_request",
                f"point_cloud must be finite float32 ({EXPECTED_POINT_COUNT}, 3)",
            )

        num_grasps = _bounded_int(request, "num_grasps", 200, 1, 4096)
        topk_num_grasps = _bounded_int(request, "topk_num_grasps", 100, 1, num_grasps)
        include_counts = request.get("include_counts", False)
        if type(include_counts) is not bool:
            raise AdapterError("invalid_request", "include_counts must be boolean")
        grasp_threshold = _finite_float(request, "grasp_threshold", -1.0)
        if grasp_threshold < -1.0 or grasp_threshold > 1.0:
            raise AdapterError("invalid_request", "grasp_threshold must be in [-1, 1]")

        for name, expected in _LEGACY_ONLY_DEFAULTS.items():
            value = request.get(name, expected)
            if type(value) is not type(expected) or value != expected:
                raise AdapterError(
                    "unsupported_legacy_control",
                    f"{name}={value!r} is not supported by the pinned adapter",
                )

        upstream_request: dict[str, object] = {
            "action": "infer",
            "point_cloud": np.ascontiguousarray(point_cloud),
            "gripper_name": self.config.gripper_name,
            "num_grasps": num_grasps,
            "grasp_threshold": grasp_threshold,
            "topk_num_grasps": topk_num_grasps,
        }
        response = self.upstream.request(upstream_request)
        return self._translate_infer_response(response, topk_num_grasps, include_counts)

    def _translate_infer_response(
        self, response: Mapping[str, object], topk_num_grasps: int,
        include_counts: bool = False,
    ) -> dict[str, object]:
        expected_keys = {"grasps", "confidences", "gripper_name", "timing"}
        if set(response) != expected_keys:
            raise AdapterError(
                "upstream_invalid", "unexpected GraspGenX infer response fields"
            )
        if response.get("gripper_name") != self.config.gripper_name:
            raise AdapterError(
                "upstream_identity_mismatch", "GraspGenX returned another gripper"
            )

        grasps = response.get("grasps")
        confidences = response.get("confidences")
        timing = response.get("timing")
        if (
            not isinstance(grasps, np.ndarray)
            or grasps.dtype != np.float32
            or grasps.ndim != 3
            or grasps.shape[1:] != (4, 4)
            or not np.isfinite(grasps).all()
        ):
            raise AdapterError("upstream_invalid", "invalid GraspGenX grasp tensor")
        if (
            not isinstance(confidences, np.ndarray)
            or confidences.dtype != np.float32
            or confidences.shape != (len(grasps),)
            or not np.isfinite(confidences).all()
        ):
            raise AdapterError(
                "upstream_invalid", "invalid GraspGenX confidence tensor"
            )
        if (
            not isinstance(timing, dict)
            or set(timing) != {"infer_ms"}
            or not _is_nonnegative_number(timing.get("infer_ms"))
        ):
            raise AdapterError("upstream_invalid", "invalid GraspGenX timing")

        # 固定上游的min_grasps=40可能合并多轮top-k；本接口的K是返回上限。
        # 先验证完整真实数组，再按原分数稳定排序取K，不重采样、不改分数/姿态。
        upstream_raw_count = len(grasps)
        if upstream_raw_count > topk_num_grasps:
            indices = np.argsort(-confidences, kind="stable")[:topk_num_grasps]
            grasps, confidences = grasps[indices], confidences[indices]
            LOGGER.info(
                "Applied global candidate cap: upstream_raw_count=%d returned_count=%d",
                upstream_raw_count, len(grasps),
            )

        # The DSH response validator requires exactly these four keys.
        # Provider identity remains available through the mandatory metadata
        # probe performed before inference.
        result = {
            "grasps": np.ascontiguousarray(grasps),
            "confidences": np.ascontiguousarray(confidences),
            "num_grasps": len(grasps),
            "timing": {"infer_ms": float(timing["infer_ms"])},
        }
        if include_counts:
            result["counts"] = {
                "upstream_raw_count": upstream_raw_count,
                "returned_count": len(grasps),
            }
        return result


class AdapterServer:
    """Single-worker REP server; GraspGenX itself also serializes inference."""

    def __init__(self, adapter: GraspGenXAdapter):
        self.adapter = adapter
        self.stop_event = threading.Event()
        self.ready_event = threading.Event()
        self.bound_endpoint: str | None = None

    def stop(self) -> None:
        self.stop_event.set()

    def serve_forever(
        self, supervised_process: subprocess.Popen[Any] | None = None
    ) -> None:
        context = zmq.Context()
        socket = context.socket(zmq.REP)
        socket.setsockopt(zmq.LINGER, 0)
        socket.setsockopt(zmq.RCVTIMEO, 200)
        try:
            if self.adapter.config.listen_port == 0:
                port = socket.bind_to_random_port(
                    f"tcp://{self.adapter.config.listen_host}"
                )
                self.bound_endpoint = f"tcp://{self.adapter.config.listen_host}:{port}"
            else:
                self.bound_endpoint = (
                    f"tcp://{self.adapter.config.listen_host}:"
                    f"{self.adapter.config.listen_port}"
                )
                socket.bind(self.bound_endpoint)
            LOGGER.info("GraspGenX adapter listening on %s", self.bound_endpoint)
            self.ready_event.set()

            while not self.stop_event.is_set():
                if (
                    supervised_process is not None
                    and supervised_process.poll() is not None
                ):
                    raise RuntimeError(
                        "supervised GraspGenX server exited with status "
                        f"{supervised_process.returncode}"
                    )
                try:
                    raw_request = socket.recv()
                except zmq.Again:
                    continue
                try:
                    request = msgpack.unpackb(raw_request, raw=False)
                    response = self.adapter.dispatch(request)
                except AdapterError as exc:
                    LOGGER.warning("Adapter request rejected [%s]: %s", exc.code, exc)
                    response = exc.wire_response()
                except Exception:
                    LOGGER.exception("Unexpected adapter failure")
                    response = {"error": "adapter_internal: unexpected adapter failure"}
                socket.send(msgpack.packb(response, use_bin_type=True))
        finally:
            self.ready_event.set()
            socket.close(linger=0)
            context.term()


def _bounded_int(
    request: Mapping[str, object], name: str, default: int, lower: int, upper: int
) -> int:
    value = request.get(name, default)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not lower <= value <= upper
    ):
        raise AdapterError(
            "invalid_request", f"{name} must be an integer in [{lower}, {upper}]"
        )
    return value


def _finite_float(request: Mapping[str, object], name: str, default: float) -> float:
    value = request.get(name, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise AdapterError("invalid_request", f"{name} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise AdapterError("invalid_request", f"{name} must be finite")
    return result


def _is_nonnegative_number(value: object) -> bool:
    return bool(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) >= 0.0
    )


def _git_head(directory: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(f"cannot verify Git revision at {directory}") from exc
    return result.stdout.strip()


def _verify_git_checkout(directory: Path, expected_revision: str, label: str) -> None:
    actual = _git_head(directory)
    if actual != expected_revision:
        raise RuntimeError(
            f"{label} revision mismatch: expected {expected_revision}, got {actual}"
        )


def _manifest_relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise RuntimeError("HF manifest contains an invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or "." in path.parts or ".." in path.parts:
        raise RuntimeError(f"HF manifest path escapes its revision root: {value!r}")
    return path.as_posix()


def _verify_hf_manifest(
    root: Path,
    *,
    repository_type: str,
    repository: str,
    revision: str,
    required_files: Mapping[str, tuple[int, str] | None],
) -> None:
    manifest_path = root / HF_MANIFEST_NAME
    if not manifest_path.is_file():
        # Explicit compatibility read for pre-migration asset volumes.
        manifest_path = root / LEGACY_HF_MANIFEST_NAME
    if manifest_path.is_symlink():
        raise RuntimeError(f"HF manifest must not be a symlink: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read pinned HF manifest: {manifest_path}") from exc
    if not isinstance(manifest, dict) or set(manifest) != {
        "schema_version",
        "repository_type",
        "repository",
        "revision",
        "files",
    }:
        raise RuntimeError(f"invalid HF manifest envelope: {manifest_path}")
    expected_identity = {
        "schema_version": 1,
        "repository_type": repository_type,
        "repository": repository,
        "revision": revision,
    }
    for key, expected in expected_identity.items():
        if manifest.get(key) != expected:
            raise RuntimeError(
                f"HF manifest identity mismatch for {key}: {manifest_path}"
            )

    raw_files = manifest.get("files")
    if not isinstance(raw_files, dict) or not raw_files:
        raise RuntimeError(f"HF manifest has no files: {manifest_path}")
    files: dict[str, tuple[int, str]] = {}
    for raw_relative, raw_record in raw_files.items():
        relative = _manifest_relative_path(raw_relative)
        if relative in {HF_MANIFEST_NAME, LEGACY_HF_MANIFEST_NAME} or relative in files:
            raise RuntimeError(f"duplicate/reserved HF manifest path: {relative}")
        if not isinstance(raw_record, dict) or set(raw_record) != {"size", "sha256"}:
            raise RuntimeError(f"invalid HF manifest record: {relative}")
        size = raw_record.get("size")
        digest = raw_record.get("sha256")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(digest, str)
            or _SHA256_PATTERN.fullmatch(digest) is None
        ):
            raise RuntimeError(f"invalid HF artifact identity: {relative}")
        files[relative] = (size, digest)

    # Production callers pass the complete immutable revision payload.  An
    # extra checkpoint could otherwise change find_latest_checkpoint() while
    # still being self-consistently listed in a forged local manifest.
    if required_files and set(files) != set(required_files):
        missing = sorted(set(required_files) - set(files))
        extra = sorted(set(files) - set(required_files))
        raise RuntimeError(
            f"HF manifest pinned file set mismatch: missing={missing}, extra={extra}"
        )

    actual_files: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"HF revision volume contains a symlink: {path}")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if relative in {HF_MANIFEST_NAME, LEGACY_HF_MANIFEST_NAME} or relative.startswith(".cache/"):
                continue
            actual_files.add(relative)
    if actual_files != set(files):
        missing = sorted(set(files) - actual_files)
        untracked = sorted(actual_files - set(files))
        raise RuntimeError(
            f"HF manifest file set mismatch: missing={missing}, untracked={untracked}"
        )

    for relative, expected in required_files.items():
        record = files.get(relative)
        if record is None:
            raise RuntimeError(f"HF manifest omits required artifact: {relative}")
        if expected is not None and record != expected:
            raise RuntimeError(f"HF manifest pins the wrong artifact: {relative}")
    for relative, (size, digest) in files.items():
        _verify_artifact(root, relative, size, digest)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_artifact(
    root: Path, relative: str, expected_size: int, expected_sha256: str
) -> None:
    path = root / relative
    try:
        actual_size = path.stat().st_size
    except OSError as exc:
        raise RuntimeError(f"missing pinned artifact: {path}") from exc
    if actual_size != expected_size:
        raise RuntimeError(
            f"artifact size mismatch for {relative}: "
            f"expected {expected_size}, got {actual_size}"
        )
    actual_sha256 = _sha256(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"artifact digest mismatch for {relative}: "
            f"expected {expected_sha256}, got {actual_sha256}"
        )


def verify_runtime_pins(source_dir: Path, model_dir: Path, gripper_dir: Path) -> None:
    _verify_git_checkout(source_dir, GRASPGENX_COMMIT, "GraspGenX source")
    _verify_hf_manifest(
        model_dir,
        repository_type="model",
        repository=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        required_files=MODEL_ARTIFACTS,
    )
    _verify_hf_manifest(
        gripper_dir,
        repository_type="dataset",
        repository=GRIPPER_REPOSITORY,
        revision=GRIPPER_REVISION,
        required_files=GRIPPER_ARTIFACTS,
    )


def _wait_for_upstream(
    client: ZmqRequestClient,
    adapter: GraspGenXAdapter,
    process: subprocess.Popen[Any],
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"GraspGenX server exited during startup with status {process.returncode}"
            )
        try:
            metadata = client.request({"action": "metadata"})
            adapter._validate_upstream_metadata(metadata)
            return
        except AdapterError as exc:
            last_error = exc
            time.sleep(0.25)
    raise RuntimeError(
        "timed out waiting for the pinned GraspGenX server"
    ) from last_error


def _terminate_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _environment_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw is not None else default


def _require_terms_acknowledgement(environment: Mapping[str, str]) -> None:
    if environment.get(TERMS_ENVIRONMENT_VARIABLE, environment.get(LEGACY_TERMS_ENVIRONMENT_VARIABLE)) != TERMS_ACKNOWLEDGEMENT:
        raise RuntimeError(
            f"set {TERMS_ENVIRONMENT_VARIABLE}={TERMS_ACKNOWLEDGEMENT} "
            "after reviewing the GraspGenX model and asset terms; the legacy LYAUP variable is read only for compatibility"
        )


def _default_paths() -> tuple[Path, Path, Path]:
    source = Path(os.environ.get("GRASPGENX_SOURCE_DIR", "/opt/graspgenx"))
    model = Path(
        os.environ.get("GRASPGENX_CHECKPOINT_DIR", f"/models/{MODEL_REVISION}")
    )
    gripper = Path(
        os.environ.get("GRASPGENX_GRIPPER_CFG_DIR", f"/grippers/{GRIPPER_REVISION}")
    )
    return source, model, gripper


def _build_parser() -> argparse.ArgumentParser:
    source, model, gripper = _default_paths()
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="run the protocol adapter")
    serve.add_argument(
        "--listen-host", default=os.environ.get("GRASPGENX_ADAPTER_HOST", "0.0.0.0")
    )
    serve.add_argument(
        "--listen-port",
        type=int,
        default=_environment_int("GRASPGENX_ADAPTER_PORT", 5556),
    )
    serve.add_argument(
        "--upstream-endpoint",
        default=os.environ.get("GRASPGENX_UPSTREAM_ENDPOINT", "tcp://127.0.0.1:5557"),
    )
    serve.add_argument(
        "--upstream-timeout-ms",
        type=int,
        default=_environment_int("GRASPGENX_UPSTREAM_TIMEOUT_MS", 120_000),
    )
    serve.add_argument("--source-dir", type=Path, default=source)
    serve.add_argument("--model-dir", type=Path, default=model)
    serve.add_argument("--gripper-dir", type=Path, default=gripper)
    serve.add_argument("--verify-pins", action="store_true")
    serve.add_argument("--launch-upstream", action="store_true")
    serve.add_argument(
        "--startup-timeout-seconds",
        type=float,
        default=float(os.environ.get("GRASPGENX_STARTUP_TIMEOUT_SECONDS", "600")),
    )

    healthcheck = subparsers.add_parser(
        "healthcheck", help="verify adapter identity and live upstream metadata"
    )
    healthcheck.add_argument(
        "--endpoint",
        default=os.environ.get("GRASPGENX_ADAPTER_ENDPOINT", "tcp://127.0.0.1:5556"),
    )
    healthcheck.add_argument("--timeout-ms", type=int, default=10_000)
    return parser


def _healthcheck(endpoint: str, timeout_ms: int, require_verified: bool) -> int:
    client = ZmqRequestClient(endpoint, timeout_ms)
    health = client.request({"action": "health"})
    expected = {
        "status": "ok",
        "provider_id": PROVIDER_ID,
        "provider_version": PROVIDER_VERSION,
        "source_commit": GRASPGENX_COMMIT,
        "model_revision": MODEL_REVISION,
        "gripper_revision": GRIPPER_REVISION,
    }
    for key, value in expected.items():
        if health.get(key) != value:
            raise RuntimeError(f"adapter health check identity mismatch: {key}")
    if require_verified and health.get("pins_verified") is not True:
        raise RuntimeError("adapter health check requires verified runtime pins")
    expected_metadata = {
        "gripper_name": GRIPPER_NAME,
        "model_name": MODEL_URI,
        "gripper_config": GRIPPER_CONFIG_URI,
        "provider_id": PROVIDER_ID,
        "provider_version": PROVIDER_VERSION,
        "protocol_revision": PROTOCOL_REVISION,
        "source_commit": GRASPGENX_COMMIT,
        "model_revision": MODEL_REVISION,
        "gripper_revision": GRIPPER_REVISION,
        "panda_config_sha256": GRIPPER_CONFIG_SHA256,
        "pins_verified": True,
    }
    metadata = client.request({"action": "metadata"})
    if metadata != expected_metadata:
        raise RuntimeError("adapter health check metadata identity mismatch")
    return 0


def _serve(args: argparse.Namespace) -> int:
    if args.listen_port < 1 or args.listen_port > 65535:
        raise ValueError("listen port must be in [1, 65535]")
    if args.upstream_timeout_ms < 1:
        raise ValueError("upstream timeout must be positive")
    if args.startup_timeout_seconds <= 0:
        raise ValueError("startup timeout must be positive")
    if args.launch_upstream and not args.verify_pins:
        raise ValueError("launching GraspGenX requires --verify-pins")
    if args.launch_upstream and args.upstream_endpoint != "tcp://127.0.0.1:5557":
        raise ValueError(
            "the supervised GraspGenX endpoint is fixed at tcp://127.0.0.1:5557"
        )

    # This is deliberately checked before hashing weights or starting the GPU
    # process.  The image does not provide a default acknowledgement.
    _require_terms_acknowledgement(os.environ)

    pins_verified = False
    if args.verify_pins:
        verify_runtime_pins(args.source_dir, args.model_dir, args.gripper_dir)
        pins_verified = True

    upstream_process: subprocess.Popen[Any] | None = None
    if args.launch_upstream:
        server_script = args.source_dir / "client-server" / "graspgenx_server.py"
        checkpoint_root = args.model_dir / "release"
        assets_dir = args.gripper_dir / "gripper_descriptions" / "assets"
        command = [
            sys.executable,
            str(server_script),
            "--config",
            str(checkpoint_root),
            "--assets_dir",
            str(assets_dir),
            "--default_gripper",
            GRIPPER_NAME,
            "--host",
            "127.0.0.1",
            "--port",
            "5557",
        ]
        environment = {
            **os.environ,
            "GRASPGENX_CHECKPOINT_DIR": str(args.model_dir),
            "GRASPGENX_GRIPPER_CFG_DIR": str(args.gripper_dir),
        }
        upstream_process = subprocess.Popen(command, env=environment)

    config = AdapterConfig(
        listen_host=args.listen_host,
        listen_port=args.listen_port,
        upstream_endpoint=args.upstream_endpoint,
        upstream_timeout_ms=args.upstream_timeout_ms,
        pins_verified=pins_verified,
    )
    client = ZmqRequestClient(config.upstream_endpoint, config.upstream_timeout_ms)
    adapter = GraspGenXAdapter(config, client)
    server = AdapterServer(adapter)

    def stop(_signum: int, _frame: object) -> None:
        server.stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        if upstream_process is not None:
            _wait_for_upstream(
                client, adapter, upstream_process, args.startup_timeout_seconds
            )
        server.serve_forever(supervised_process=upstream_process)
    finally:
        if upstream_process is not None:
            _terminate_process(upstream_process)
    return 0


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    args = _build_parser().parse_args()
    if args.command == "healthcheck":
        return _healthcheck(args.endpoint, args.timeout_ms, require_verified=True)
    return _serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
