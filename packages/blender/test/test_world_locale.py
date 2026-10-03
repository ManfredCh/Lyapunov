"""world.py 的**本地化依赖**真机测试：节点的 `.name` 随界面语言变，查找必须按 `type`/`identifier`。

为什么要有这一份：`material()` 曾经写 `node_tree.nodes.get('Principled BSDF')`。`--factory-startup`
（无 source_blend 的调用形状）加载不到用户偏好 ⇒ 界面英语 ⇒ 自动命名的节点叫 'Principled BSDF'，
查找命中；而打开既有工程（带 `source_blend` 的形状）会加载用户偏好，中文界面下同一个节点叫
'原理化 BSDF' ⇒ 查找落空成 `None` ⇒ `.inputs` 崩，`blender_run{source_blend}` 与 A5 的 resume 全断。
本文件把"语言"当**自变量**来断言：在同一个真机进程里依次把
`bpy.context.preferences.view.language` 设成 `en_US` / `zh_HANS`（真机实测：运行期切换会改变
**新建**节点的默认名字），再调用 `world.py` 里真实的查找函数核对行为。

不是合成夹具：断言跑在真实 Blender 里、调的是 `packages/blender/src/world.py` 的真实函数、
贴图走真实 `bpy.data.images.load()` 读真实 PNG 文件的字节。

跑法（`BLENDER_EXECUTABLE` 或 PATH 上的 `blender`；不需要 `LYAPUNOV_CAD_PYTHON`）：
    python3 packages/blender/test/test_world_locale.py
等价的手工形状：
    blender --background --factory-startup --python-exit-code 1 --python packages/blender/test/test_world_locale.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
PRODUCT_ROOT = TEST_DIR.parent.parent.parent
WORLD_SCRIPT = Path(os.environ.get("LYAPUNOV_WORLD_SCRIPT") or PRODUCT_ROOT / "packages" / "blender" / "src" / "world.py").resolve()
PROBE_PREFIX = "PROBE_RESULT="
# 界面语言 → 该语言下**新建**材质的 Principled/输出节点默认名（真机 5.2.2 实测）。
LOCALE_NODE_NAMES = {"en_US": "Principled BSDF", "zh_HANS": "原理化 BSDF"}

# ── 被 world.py 的查找函数直接使用的插槽内部标识（真机实测中英一致） ──────────────
REQUIRED_IDENTIFIERS = {
    "BSDF_PRINCIPLED": {"inputs": ["Base Color", "Roughness", "Normal"], "outputs": ["BSDF"]},
    "TEX_IMAGE": {"inputs": ["Vector"], "outputs": ["Color", "Alpha"]},
    "MIX_RGB": {"inputs": ["Fac", "Color1", "Color2"], "outputs": ["Color"]},
    "NORMAL_MAP": {"inputs": ["Strength", "Color"], "outputs": ["Normal"]},
}


def write_png(path: Path, size: int = 4, rgb: tuple = (140, 90, 40)) -> Path:
    """写一张真实可加载的 PNG（stdlib zlib，不依赖任何图形库）。"""
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return path


def load_world_module():
    """把 products 的 world.py 当模块加载（它的 `__main__` 守卫保证 import 不会跑 main）。"""
    spec = importlib.util.spec_from_file_location("lyapunov_world_under_test", WORLD_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def probe_body() -> dict:
    """**在 Blender 内**执行的真实断言；返回逐条读数（含失败项，不在内部吞异常）。"""
    import bpy

    world = load_world_module()
    rows: list[dict] = []

    def record(name: str, ok: bool, detail: str) -> None:
        rows.append({"name": name, "ok": bool(ok), "detail": detail})

    # 0) 改前形态（把英文节点名写死）没有这些查找函数：如实记 FAIL 后收工，
    #    这样"探针跑在改前 world.py 上"得到的是清晰的失败清单（负向对照），而不是探针自己崩。
    missing_helpers = [name for name in ("node_by_type", "socket_by_identifier", "principled") if not hasattr(world, name)]
    record("world.py 提供语言无关查找函数 node_by_type/socket_by_identifier/principled",
           not missing_helpers, f"缺失={missing_helpers}")
    if missing_helpers:
        return {"rows": rows, "locales": {}}

    workdir = Path(tempfile.mkdtemp(prefix="lyapunov-locale-probe-"))
    texture = write_png(workdir / "probe-diffuse.png")
    original_language = bpy.context.preferences.view.language
    per_locale: dict[str, dict] = {}
    try:
        for language in ("en_US", "zh_HANS"):
            # 语言是本次实验的**唯一**自变量：运行期切换已被真机证实会改变新建节点的默认名字。
            bpy.context.preferences.view.language = language
            facts: dict = {"language_requested": language, "language_now": bpy.context.preferences.view.language}

            fresh = bpy.data.materials.new(f"locale-probe-{language}")
            fresh.use_nodes = True
            tree = fresh.node_tree
            auto = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
            facts["auto_node_name"] = auto.name
            facts["auto_node_type"] = auto.type
            # 旧写法（本缺陷的根因）在这个语言下的命中情况：中文界面必须落空。
            facts["legacy_lookup_found"] = tree.nodes.get("Principled BSDF") is not None
            # 旧写法真的执行一遍：英语下成功、中文下抛 AttributeError —— 这就是线上那条崩溃的复现。
            legacy_error = None
            try:
                tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1.0, 0.0, 0.0, 1.0)
            except AttributeError as error:
                legacy_error = f"{type(error).__name__}: {error}"
            facts["legacy_error"] = legacy_error
            record(f"[{language}] 旧写法 nodes.get('Principled BSDF').inputs[...] 的真实结果",
                   (legacy_error is None) == (language == "en_US"),
                   f"error={legacy_error!r}（英语界面应无错、中文界面应 AttributeError）")
            record(f"[{language}] 新建 Principled 的 .name 随语言变化（自变量真的生效）",
                   auto.name == LOCALE_NODE_NAMES[language],
                   f".name={auto.name!r} 期望={LOCALE_NODE_NAMES[language]!r} pref={bpy.context.preferences.view.language!r}")

            # 1) 按 type 找节点：与 .name 无关 —— 把名字改成垃圾名也照样找到。
            by_type = world.node_by_type(tree, "BSDF_PRINCIPLED")
            auto.name = "zzz-renamed-by-probe"
            by_type_after_rename = world.node_by_type(tree, "BSDF_PRINCIPLED")
            # 注意：不能比 Python 包装对象的 `is`——每次访问 RNA 集合都会得到新的包装对象，要比指针。
            record(f"[{language}] node_by_type 与 .name 无关（改名后仍命中）",
                   by_type is not None and by_type_after_rename is not None
                   and by_type.as_pointer() == by_type_after_rename.as_pointer() and by_type.type == "BSDF_PRINCIPLED",
                   f"type={getattr(by_type, 'type', None)} 改名后仍命中={by_type_after_rename is not None}")
            auto.name = LOCALE_NODE_NAMES[language]

            # 2) 插槽按 identifier 取：base color 真的落在 Base Color 上。
            base = world.socket_by_identifier(by_type, "Base Color")
            facts["base_color_name"] = base.name
            facts["base_color_identifier"] = base.identifier
            record(f"[{language}] socket_by_identifier 取到 Base Color（identifier 语言无关）",
                   base.identifier == "Base Color" and base.as_pointer() == by_type.inputs[0].as_pointer(),
                   f"identifier={base.identifier!r} name={base.name!r} is_inputs0={base.as_pointer() == by_type.inputs[0].as_pointer()}")

            # 3) 插槽 identifier 集合在两个语言下逐字相同（后面跨语言比对；先只记本树）。
            facts["identifiers"] = {node.type: {"inputs": [s.identifier for s in node.inputs],
                                                "outputs": [s.identifier for s in node.outputs]}
                                    for node in tree.nodes}

            # 4) 真实 `material()`：基色真的写进 Principled 的 Base Color。
            color = (0.02, 0.3, 0.8, 1)
            material_error = None
            built = built_bsdf = None
            try:
                built = world.material(f"locale-built-{language}", color)
                built_bsdf = world.node_by_type(built.node_tree, "BSDF_PRINCIPLED")
            except Exception as error:   # 改前的实现就是在这里抛 AttributeError（本单的缺陷）
                material_error = f"{type(error).__name__}: {error}"
            got = list(world.socket_by_identifier(built_bsdf, "Base Color").default_value) if built_bsdf is not None else []
            record(f"[{language}] material() 在中文界面下不崩且基色写入 Base Color",
                   material_error is None and built_bsdf is not None and all(abs(a - b) < 1e-6 for a, b in zip(got, color)),
                   f"baseColor={[round(v, 6) for v in got]} 期望={list(color)} error={material_error!r}")

            # 5) 失败路径仍然如实：缺插槽 / 缺节点都报错，不返回 None 假装成功。
            missing_socket = None
            try:
                world.socket_by_identifier(built_bsdf, "__no_such_socket__")
            except RuntimeError as error:
                missing_socket = str(error)
            record(f"[{language}] 取不到插槽时如实报错（BLENDER_SOCKET_MISSING）",
                   bool(missing_socket) and missing_socket.startswith("BLENDER_SOCKET_MISSING:"),
                   f"error={missing_socket!r}")

            empty = bpy.data.materials.new(f"locale-empty-{language}")
            empty.use_nodes = True
            for node in list(empty.node_tree.nodes):
                empty.node_tree.nodes.remove(node)
            missing_node = None
            try:
                world.principled(empty.node_tree, empty.name)
            except RuntimeError as error:
                missing_node = str(error)
            record(f"[{language}] 没有 Principled 节点时如实报错（BLENDER_PRINCIPLED_MISSING）",
                   bool(missing_node) and missing_node.startswith("BLENDER_PRINCIPLED_MISSING:"),
                   f"error={missing_node!r}")

            # 6) 贴图接线：四张图真的接上 Principled（走 identifier 的节点/插槽路径）。
            entry = {"assetId": "probe-asset", "license": "CC0",
                     "maps": {"Diffuse": str(texture), "Rough": str(texture), "nor_gl": str(texture), "AO": str(texture)}}
            textured = bpy.data.materials.new(f"locale-textured-{language}")
            textured.use_nodes = True
            wired = world.apply_texture_set(textured, entry)
            bsdf = world.node_by_type(textured.node_tree, "BSDF_PRINCIPLED")
            types = sorted(node.type for node in textured.node_tree.nodes)
            linked = {identifier: bool(world.socket_by_identifier(bsdf, identifier).is_linked)
                      for identifier in ("Base Color", "Roughness", "Normal")}
            mix = world.node_by_type(textured.node_tree, "MIX_RGB")
            # 这一棵树里有 BSDF/输出/贴图/混合/法线贴图五类节点，跨语言比对用它的 identifier 全集。
            facts["identifiers_textured"] = {node.type: {"inputs": [s.identifier for s in node.inputs],
                                                         "outputs": [s.identifier for s in node.outputs]}
                                             for node in textured.node_tree.nodes}
            facts["wired"] = wired
            facts["linked"] = linked
            facts["node_types"] = types
            record(f"[{language}] apply_texture_set 把 Diffuse/Rough/nor_gl/AO 接到 Principled",
                   wired is True and all(linked.values()) and mix is not None
                   and abs(world.socket_by_identifier(mix, "Fac").default_value - 1.0) < 1e-6
                   and "MIX_RGB" in types and "NORMAL_MAP" in types and "TEX_IMAGE" in types,
                   f"wired={wired} linked={linked} types={types} fac={getattr(mix, 'blend_type', None)}")
            per_locale[language] = facts
    finally:
        bpy.context.preferences.view.language = original_language
        shutil.rmtree(workdir, ignore_errors=True)

    # 7) 跨语言比对：identifier 集合必须逐字相同；而旧写法在中文下必须落空（复现根因）。
    en, zh = per_locale["en_US"], per_locale["zh_HANS"]
    differing = {node_type: (en["identifiers_textured"].get(node_type), zh["identifiers_textured"].get(node_type))
                 for node_type in REQUIRED_IDENTIFIERS
                 if en["identifiers_textured"].get(node_type) != zh["identifiers_textured"].get(node_type)}
    record("跨语言：五类节点的插槽 identifier 集合逐字相同",
           not differing and all(node_type in en["identifiers_textured"] for node_type in REQUIRED_IDENTIFIERS),
           f"不同项={differing} 覆盖={sorted(en['identifiers_textured'])}")
    record("跨语言：新旧命名下的 .name 确实不同（旧写法落空的机制）",
           en["auto_node_name"] != zh["auto_node_name"],
           f"en={en['auto_node_name']!r} zh={zh['auto_node_name']!r}")
    record("旧写法复现：nodes.get('Principled BSDF') 英语命中 / 中文落空",
           en["legacy_lookup_found"] is True and zh["legacy_lookup_found"] is False,
           f"en_found={en['legacy_lookup_found']} zh_found={zh['legacy_lookup_found']}")
    return {"rows": rows, "locales": per_locale}


def run_in_blender() -> int:
    """在 Blender 内跑断言并打印真实读数；失败即以非零码退出（不伪造成通过）。"""
    try:
        payload = probe_body()
    except Exception:  # 探针自己崩了也是失败，如实打出来
        import traceback
        traceback.print_exc()
        return 2
    passed = [row for row in payload["rows"] if row["ok"]]
    failed = [row for row in payload["rows"] if not row["ok"]]
    for row in payload["rows"]:
        print(f'[{"PASS" if row["ok"] else "FAIL"}] {row["name"]} — {row["detail"]}', flush=True)
    print(PROBE_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)
    print(f"\ntest_world_locale（真机 Blender）: {len(passed)}/{len(payload['rows'])} 通过", flush=True)
    return 1 if failed else 0


def blender_executable() -> str | None:
    return os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")


def drive_from_python() -> int:
    """从普通 python 起一个 `blender --background` 跑自己（本文件的命令行形式）。"""
    executable = blender_executable()
    if executable is None:
        print("BLOCKED: 找不到真实 Blender（BLENDER_EXECUTABLE 或 PATH 上的 blender）", flush=True)
        return 3
    argv = [executable, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(Path(__file__).resolve())]
    process = subprocess.run(argv, capture_output=True, text=True)
    sys.stdout.write(process.stdout)
    sys.stderr.write(process.stderr)
    if process.returncode != 0:
        print(f"BLENDER_PROBE_FAILED exit={process.returncode}", file=sys.stderr)
    return process.returncode


if __name__ == "__main__":
    # 两种入口：Blender 内（有 bpy）直接跑断言；普通 python 起一个真机 Blender 跑自己。
    try:
        import bpy  # noqa: F401
        inside_blender = True
    except ImportError:
        inside_blender = False
    sys.exit(run_in_blender() if inside_blender else drive_from_python())
