"""world.py 真实行为测试的共用工具（本目录 `test_world_*.py` 都从这里取工具）。

这组测试不用合成夹具冒充真实运行：每条断言都由**独立的 `blender --background` 进程**跑真实的
`packages/blender/src/world.py`，或读它写下的真实产物（scene.json / GLB / blend / PNG）得出。
结果行的前缀不在这里另立协议，而是运行期从产品源 `packages/blender/src/plugin.ts` 读回。

跑法（需要真实 Blender 可执行文件）：
    python3 packages/blender/test/test_world_operations.py
    python3 packages/blender/test/test_world_derived_mesh.py
    python3 packages/blender/test/test_world_harness.py     # 只自检工具本身，不启动 Blender

环境变量：`BLENDER_EXECUTABLE` 指定二进制（缺省用 PATH 里的 `blender`）；
`LYAPUNOV_BLENDER_TEST_WORKDIR` 指定产物根目录（缺省落在临时目录，不往源码树里写东西）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
PRODUCT_ROOT = TEST_DIR.parent.parent.parent
WORLD_SCRIPT = PRODUCT_ROOT / "packages" / "blender" / "src" / "world.py"
PLUGIN_SOURCE = PRODUCT_ROOT / "packages" / "blender" / "src" / "plugin.ts"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PROBE_PREFIX = "PROBE_RESULT="
DEFAULT_TIMEOUT = 900


# ── 断言收集：每条都打印真实读数，退出码只在失败时为非零 ─────────────────────────
class Checks:
    def __init__(self, title: str):
        self.title = title
        self.rows: list[tuple[str, bool, str]] = []
        self.blocked: str | None = None

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append((name, bool(ok), detail))
        print(f'[{"PASS" if ok else "FAIL"}] {name}' + (f" — {detail}" if detail else ""), flush=True)
        return bool(ok)

    def blocked_on(self, reason: str) -> int:
        """缺少真实运行条件（例如没有 Blender）：如实报 BLOCKED，不伪造成通过也不当成实现失败。"""
        self.blocked = reason
        print(f"BLOCKED: {reason}", flush=True)
        return 3

    def finish(self) -> int:
        failed = [row for row in self.rows if not row[1]]
        print(f"\n{self.title}: {len(self.rows) - len(failed)}/{len(self.rows)} 通过", flush=True)
        return 1 if failed else 0


class Run:
    """一次真实 Blender 调用的结果。"""

    def __init__(self, argv: list[str], code: int, stdout: str, stderr: str, seconds: float):
        self.argv = argv
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
        self.seconds = seconds

    @property
    def result(self) -> dict | None:
        """stdout 里的 LYAPUNOV_RESULT 结果行（前缀来自 plugin.ts）；缺行返回 None，不拿最后一行兜底。"""
        prefix = result_prefix()
        lines = self.stdout.split("\n")
        for line in reversed(lines):
            if line.startswith(prefix):
                return json.loads(line[len(prefix):])
        return None

    def tail(self, limit: int = 400) -> str:
        return (self.stderr or self.stdout)[-limit:].replace("\n", " ")

    @property
    def clean(self) -> bool:
        """真正干净的成功：退出 0 **且**没有 Python 异常堆栈。

        Blender 默认把脚本异常吞成 exit 0，只看退出码会把跑挂的脚本当成功，所以成功路径必须同时看堆栈。
        """
        return self.code == 0 and "Traceback (most recent call last)" not in self.stdout + self.stderr


# ── 产品源里的既有约定（不在这里另立第二份） ─────────────────────────────────────
def result_prefix() -> str:
    """结果行前缀取自 plugin.ts —— world.py 打印的前缀必须与解析方同源。"""
    match = re.search(r"RESULT_PREFIX\s*=\s*'([^']+)'", PLUGIN_SOURCE.read_text())
    if match is None:
        raise RuntimeError(f"PLUGIN_RESULT_PREFIX_NOT_FOUND: {PLUGIN_SOURCE}")
    return match.group(1)


def blender_executable() -> str | None:
    return os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")


def workdir() -> Path:
    """本次测试的产物根目录（默认临时目录，避免把产物写进源码树）。"""
    root = os.environ.get("LYAPUNOV_BLENDER_TEST_WORKDIR") or tempfile.mkdtemp(prefix="lyapunov-blender-test-")
    path = Path(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def fresh_dir(name: str) -> Path:
    path = workdir() / f"{name}-{int(time.time() * 1000)}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_script(name: str, text: str) -> Path:
    """把场景脚本写到临时目录（受测的是 world.py，不是这些脚本）。"""
    path = workdir() / "scripts" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


# ── 跑真实 Blender ──────────────────────────────────────────────────────────────
def _spawn(argv: list[str], timeout: int) -> Run:
    started = time.time()
    process = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    return Run(argv, process.returncode, process.stdout, process.stderr, time.time() - started)


def run_world(args: list[str], scene_script: Path | None = None, source_blend: Path | None = None,
              python_exit_code: bool = False, timeout: int = DEFAULT_TIMEOUT) -> Run:
    """`blender --background [<source.blend>|--factory-startup] [--python <场景脚本>] --python world.py -- <args>`。

    与 plugin.ts 的 argv 形状一致（源工程与 --factory-startup 二选一，场景脚本先于 world.py 执行）；
    `python_exit_code=True` 追加 `--python-exit-code 1`，用来核对两种调用形状下失败都非零退出。
    """
    executable = blender_executable()
    if executable is None:
        raise RuntimeError("BLENDER_EXECUTABLE_MISSING")
    argv = [executable, "--background", str(source_blend) if source_blend else "--factory-startup"]
    if python_exit_code:
        argv += ["--python-exit-code", "1"]
    if scene_script is not None:
        argv += ["--python", str(scene_script)]
    argv += ["--python", str(WORLD_SCRIPT), "--"] + [str(item) for item in args]
    return _spawn(argv, timeout)


def inspect_blend(blend_path: Path, body: str, timeout: int = 300) -> dict:
    """开真实 blend 跑一段只读 Python，取回 `PROBE_RESULT=` 行（用于核对保存下来的源工程）。"""
    executable = blender_executable()
    if executable is None:
        raise RuntimeError("BLENDER_EXECUTABLE_MISSING")
    script = write_script(f"probe-{blend_path.stem}-{int(time.time() * 1000)}.py", PROBE_PRELUDE + body)
    run = _spawn([executable, "--background", str(blend_path), "--python-exit-code", "1", "--python", str(script)], timeout)
    if run.code != 0:
        raise RuntimeError(f"BLEND_PROBE_FAILED exit={run.code}: {run.tail()}")
    for line in reversed(run.stdout.split("\n")):
        if line.startswith(PROBE_PREFIX):
            return json.loads(line[len(PROBE_PREFIX):])
    raise RuntimeError(f"BLEND_PROBE_NO_RESULT: {run.tail()}")


PROBE_PRELUDE = '''"""只读探针：把重开后的源工程事实写成 PROBE_RESULT 行。"""
import bpy, json
'''

# 对象级事实：名字/类型/父级/位姿/材质/自定义属性；文字与曲线另带可编辑性读数。
# 这段只往 `report` 里填字典、不打印，所以既能给只读探针用，也能被场景脚本用来在导出前落盘现场。
FACTS_CODE = '''
report = {}

def jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)): return value
    if hasattr(value, "to_list"): return value.to_list()
    try: return list(value)
    except TypeError: return str(value)

for obj in bpy.context.scene.objects:
    item = {"type": obj.type, "parent": obj.parent.name if obj.parent else None,
            "location": [round(value, 6) for value in obj.location],
            "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
            "props": {key: jsonable(obj[key]) for key in obj.keys() if key.startswith("lyapunov_")}}
    if obj.type == "FONT":
        item["body"] = obj.data.body
        item["extrude"] = round(obj.data.extrude, 6)
    if obj.type == "CURVE":
        item["bevelDepth"] = round(obj.data.bevel_depth, 6)
        item["splines"] = len(obj.data.splines)
    if obj.type == "MESH":
        item["uvLayers"] = [layer.name for layer in obj.data.uv_layers]
        item["polygons"] = len(obj.data.polygons)
    report[obj.name] = item
report["_sceneProps"] = {key: jsonable(bpy.context.scene[key]) for key in bpy.context.scene.keys() if key.startswith("lyapunov_")}
'''

SCENE_FACTS_BODY = FACTS_CODE + 'print("PROBE_RESULT=" + json.dumps(report, ensure_ascii=False))\n'


def scene_facts(blend_path: Path) -> dict:
    """重开源工程取回对象级事实（用于"不破坏用户对象""层级仍在""文字仍可编辑"这类核对）。"""
    return inspect_blend(blend_path, SCENE_FACTS_BODY)


# ── 产物解析（stdlib，不依赖 Blender） ──────────────────────────────────────────
def glb_json(path: Path) -> dict:
    """按 GLB 头/chunk 约定解析 JSON chunk（与 scene-kit glbJSON 同一套校验）。"""
    data = path.read_bytes()
    if len(data) < 20 or struct.unpack_from("<I", data, 0)[0] != 0x46546C67 or struct.unpack_from("<I", data, 4)[0] != 2 \
            or struct.unpack_from("<I", data, 8)[0] != len(data):
        raise ValueError(f"INVALID_GLB_HEADER: {path}")
    chunk_length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != 0x4E4F534A or 20 + chunk_length > len(data):
        raise ValueError(f"INVALID_GLB_JSON_CHUNK: {path}")
    payload = json.loads(data[20:20 + chunk_length].decode("utf-8"))
    if not str(payload.get("asset", {}).get("version", "")).startswith("2."):
        raise ValueError(f"UNSUPPORTED_GLTF_VERSION: {path}")
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError(f"INVALID_GLB_CHUNK: {path}")
        offset += 8 + struct.unpack_from("<I", data, offset)[0]
    if offset != len(data):
        raise ValueError(f"INVALID_GLB_LENGTH: {path}")
    return payload


def glb_facts(path: Path) -> dict:
    """GLB 的实质读数：网格数、图元属性（含 TEXCOORD_0/UV）、材质名与颜色、贴图数、节点名。"""
    payload = glb_json(path)
    primitives = [primitive for mesh in payload.get("meshes", []) for primitive in mesh.get("primitives", [])]
    return {
        "bytes": path.stat().st_size,
        "nodes": [node.get("name") for node in payload.get("nodes", [])],
        "meshCount": len(payload.get("meshes", [])),
        "attributes": sorted({key for primitive in primitives for key in primitive.get("attributes", {})}),
        "materials": [material.get("name") for material in payload.get("materials", [])],
        # 材质引用要看到颜色才分得清"带的是哪一个材质"：glTF 缺省 baseColorFactor 是白的。
        "materialBaseColors": {material.get("name"): (material.get("pbrMetallicRoughness") or {}).get("baseColorFactor", [1, 1, 1, 1])
                               for material in payload.get("materials", [])},
        "images": len(payload.get("images", [])),
    }


def color_match(actual, expected, tolerance: float = 1e-3) -> bool:
    """baseColorFactor 的比对（浮点，按容差；长度也要一致）。"""
    return isinstance(actual, list) and len(actual) == len(expected) \
        and all(abs(value - want) <= tolerance for value, want in zip(actual, expected))


def png_facts(path: Path) -> dict:
    """PNG 的真实头信息（签名 + IHDR 宽高）：用来核对"图真的存在且分辨率是本次要求的"。"""
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        raise ValueError(f"NOT_PNG: {path}")
    if data[12:16] != b"IHDR" or len(data) < 24:
        raise ValueError(f"PNG_WITHOUT_IHDR: {path}")
    width, height = struct.unpack_from(">II", data, 16)
    return {"bytes": len(data), "width": width, "height": height}


def png_pixels(path: Path) -> dict:
    """把 PNG 解到像素（stdlib：zlib + 逐行反滤波），用来核对"渲染图里到底有没有那个东西"。

    只支持 Blender 渲染输出的 8 位 RGB/RGBA 非隔行 PNG；其他形态直接报错而不是猜。
    """
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        raise ValueError(f"NOT_PNG: {path}")
    offset, header, compressed = 8, None, b""
    while offset + 8 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        tag = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        if tag == b"IHDR":
            width, height, depth, color, _compression, _filter, interlace = struct.unpack(">IIBBBBB", payload)
            if depth != 8 or interlace != 0 or color not in (2, 6):
                raise ValueError(f"PNG_UNSUPPORTED_FORMAT: depth={depth} color={color} interlace={interlace} in {path}")
            header = (width, height, 3 if color == 2 else 4)
        elif tag == b"IDAT":
            compressed += payload
        elif tag == b"IEND":
            break
        offset += 12 + length
    if header is None:
        raise ValueError(f"PNG_WITHOUT_IHDR: {path}")
    width, height, channels = header
    raw, stride, rows, previous, cursor = zlib.decompress(compressed), width * channels, [], bytearray(width * channels), 0
    for _ in range(height):
        if cursor >= len(raw):
            raise ValueError(f"PNG_TRUNCATED: {path}")
        filter_type = raw[cursor]
        cursor += 1
        line = bytearray(raw[cursor:cursor + stride])
        if len(line) != stride:
            raise ValueError(f"PNG_TRUNCATED: {path}")
        cursor += stride
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            up = previous[index]
            if filter_type == 0:
                predicted = 0
            elif filter_type == 1:
                predicted = left
            elif filter_type == 2:
                predicted = up
            elif filter_type == 3:
                predicted = (left + up) >> 1
            elif filter_type == 4:
                up_left = previous[index - channels] if index >= channels else 0
                estimate = left + up - up_left
                predicted = left if abs(estimate - left) <= abs(estimate - up) and abs(estimate - left) <= abs(estimate - up_left) \
                    else (up if abs(estimate - up) <= abs(estimate - up_left) else up_left)
            else:
                raise ValueError(f"PNG_UNKNOWN_FILTER: {filter_type} in {path}")
            line[index] = (line[index] + predicted) & 0xFF
        rows.append(bytes(line))
        previous = line
    return {"width": width, "height": height, "channels": channels, "rows": rows}


def png_bytes(width: int, height: int, channels: int, raw: bytes) -> bytes:
    """把已带 filter 字节的原始行打包成 PNG（造输入用，不经过 Blender）。"""
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", width, height, 8, 6 if channels == 4 else 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def write_png(path: Path, width: int, height: int, rgb: tuple = (200, 30, 30)) -> Path:
    """写一张纯色真 PNG：用来铺"上一轮留下的旧图"这种真实场景（旧图是**合法 PNG**）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    row = bytes(rgb) * width
    path.write_bytes(png_bytes(width, height, 3, b"".join(b"\x00" + row for _ in range(height))))
    return path


def image_difference(first: dict, second: dict, threshold: int = 16) -> dict:
    """两张同尺寸图之间"看得见的差异"：显著差异像素数、峰值、均值，以及这些像素的包围盒。

    渲染器逐次之间本来就有微小抖动，所以"两次渲染不同"不能证明画面里有东西。这里量的是**幅度**：
    用同一场景两次渲染定出噪声基线，再看改动场景后的差异是否远高于它（见 test_world_derived_mesh.py）。
    """
    if (first["width"], first["height"], first["channels"]) != (second["width"], second["height"], second["channels"]):
        raise ValueError("IMAGE_SIZE_MISMATCH")
    channels, significant, peak, total = first["channels"], 0, 0, 0
    left, top, right, bottom = first["width"], first["height"], -1, -1
    for y, (row_a, row_b) in enumerate(zip(first["rows"], second["rows"])):
        for x in range(first["width"]):
            base = x * channels
            delta = max(abs(row_a[base + channel] - row_b[base + channel]) for channel in range(3))
            peak = max(peak, delta)
            total += delta
            if delta > threshold:
                significant += 1
                left, top = min(left, x), min(top, y)
                right, bottom = max(right, x), max(bottom, y)
    box = None if right < 0 else [left, top, right - left + 1, bottom - top + 1]
    return {"significant": significant, "peak": peak, "meanDelta": round(total / (first["width"] * first["height"]), 4), "bbox": box}


def entity_map(snapshot: dict) -> dict:
    return {entity["entityId"]: entity for entity in snapshot.get("entities", [])}


def glb_paths(output: Path) -> list[str]:
    return sorted(path.name for path in (output / "visuals").glob("*.glb"))


def all_pngs(output: Path) -> list[str]:
    return sorted(str(path.relative_to(output)) for path in output.rglob("*.png"))


def file_bytes(path: Path) -> bytes:
    return path.read_bytes() if path.is_file() else b""


# ── 自检：工具本身（不启动 Blender） ────────────────────────────────────────────
def self_check() -> int:
    checks = Checks("test_world_harness 自检")
    executable = blender_executable()
    checks.check("world.py 存在", WORLD_SCRIPT.is_file(), str(WORLD_SCRIPT))
    prefix = result_prefix()
    checks.check("结果行前缀取自 plugin.ts", prefix == "LYAPUNOV_RESULT=", repr(prefix))
    checks.check("world.py 打印的前缀与 plugin.ts 一致", f"print('{prefix}'" in WORLD_SCRIPT.read_text(), prefix)
    checks.check("能找到真实 Blender 可执行文件", executable is not None, str(executable or "缺 BLENDER_EXECUTABLE"))
    # 合成一个最小 GLB 与一段 PNG 头，验证解析器自己没写错（真实产物的解析在各测试里核对）。
    json_chunk = json.dumps({"asset": {"version": "2.0"}, "meshes": [{"name": "m", "primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}}]}], "nodes": [{"name": "n"}]}).encode()
    json_chunk += b" " * (-len(json_chunk) % 4)
    body = struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    glb = struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body
    sample = workdir() / "harness-selfcheck.glb"
    sample.write_bytes(glb)
    facts = glb_facts(sample)
    checks.check("GLB 解析器读出网格与 UV 属性", facts["meshCount"] == 1 and facts["attributes"] == ["POSITION", "TEXCOORD_0"], json.dumps(facts, ensure_ascii=False))
    bad_length = workdir() / "harness-selfcheck-truncated.glb"
    bad_length.write_bytes(glb[:-4])
    try:
        glb_json(bad_length)
        checks.check("GLB 解析器拒绝长度不符的字节", False, "截断的 GLB 被接受")
    except ValueError as error:
        checks.check("GLB 解析器拒绝长度不符的字节", True, str(error))
    png = workdir() / "harness-selfcheck.png"
    png.write_bytes(PNG_SIGNATURE + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 160, 120) + b"\x00" * 8)
    checks.check("PNG 解析器读出 IHDR 宽高", png_facts(png)["width"] == 160 and png_facts(png)["height"] == 120, str(png_facts(png)))

    # 2x2 真彩、所有行 filter=0：解码结果必须与写进去的像素逐字节相同。
    plain = workdir() / "harness-selfcheck-plain.png"
    pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
    plain.write_bytes(png_bytes(2, 2, 3, b"\x00" + bytes(pixels[:6]) + b"\x00" + bytes(pixels[6:])))
    decoded = png_pixels(plain)
    checks.check("PNG 解码器还原无滤波像素",
                 decoded["width"] == 2 and decoded["height"] == 2 and decoded["rows"] == [bytes(pixels[:6]), bytes(pixels[6:])],
                 f"{[list(row) for row in decoded['rows']]}")
    # 一行 Sub 滤波：存的是差分，解码后应是原值（滤波器写错会让差异量尺整体失真）。
    sub = workdir() / "harness-selfcheck-sub.png"
    sub.write_bytes(png_bytes(2, 1, 3, b"\x01" + bytes([10, 20, 30, 30, 30, 30])))
    checks.check("PNG 解码器还原 Sub 滤波（差分回到原值）",
                 png_pixels(sub)["rows"] == [bytes([10, 20, 30, 40, 50, 60])],
                 f"{[list(row) for row in png_pixels(sub)['rows']]}")
    first = {"width": 2, "height": 1, "channels": 3, "rows": [bytes([10, 20, 30, 40, 50, 60])]}
    second = {"width": 2, "height": 1, "channels": 3, "rows": [bytes([10, 20, 30, 40, 50, 250])]}
    checks.check("差异量尺只把超阈值的像素算作显著差异",
                 image_difference(first, second, threshold=16) == {"significant": 1, "peak": 190, "meanDelta": 95.0, "bbox": [1, 0, 1, 1]},
                 json.dumps(image_difference(first, second, threshold=16)))
    return checks.finish()


if __name__ == "__main__":
    sys.exit(self_check())
