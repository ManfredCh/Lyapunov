#!/usr/bin/env python3
"""用 pypdf 真实读取 PDF 图纸：区分**矢量图**与**扫描图**，给出真实的矢量路径/文字/页面几何，
并在扫描页上导出原生图像（PNG）供模型读图。

这不是 CAD 内核，也不是 OCR：不把像素矢量化成线条，不做文字识别，不重建墙体。
它只回答三个可核对的问题：
  1. 这一页到底是矢量画出来的、扫描出来的，还是两者叠加（mixed）？
  2. 矢量页里**真实存在**哪些路径算子与文字（带页面坐标），页面本身多大？
  3. 扫描页能不能把原生图像取出来（取不到就如实报失败原因，不拿空白图充数）。

三条硬纪律：
  · **页面单位不是建筑米**：PDF 的页面坐标单位是 1/72 英寸（point），`--scale 1:100` 之前
    `metresKnown` 永远是 false，`metresPerPagePoint` 永远是 null。报告的 mm 是**图纸纸面**尺寸，
    不是建筑尺寸——把 A1 图幅的 mm 当房间尺寸是最典型的误读，本脚本不提供这条捷径。
    图纸文字里出现的 "1:100" 只作为 `scaleStatements` 的**文字证据**列出，不自动升级成换算因子。
  · **矢量与扫描必须分开数**：路径算子计数来自内容流（含 Form XObject 递归，带 CTM 变换），
    图像来自 XObject / inline image 的**实际绘制覆盖面积**；只有覆盖率高的图像才算"整页扫描"，
    一个小 logo 不会把矢量图误判成扫描图。
  · **取不到就说取不到**：嵌入图导出失败（编码不支持、像素超限、栅格化工具缺失）逐页记
    `failures`，绝不静默跳过，也不生成一张空白图冒充扫描件。

输出（stdout 单行，前缀固定）：
  LYAPUNOV_DRAWING_RESULT={...}   成功，退出码 0
  LYAPUNOV_DRAWING_ERROR={...}    可预期的失败（缺文件/不是 PDF/加密/依赖缺失/解析失败），退出码 3
  其它异常（未预期）走 stderr 回溯，退出码 2
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
from collections import Counter

RESULT_PREFIX = "LYAPUNOV_DRAWING_RESULT="
ERROR_PREFIX = "LYAPUNOV_DRAWING_ERROR="
EXIT_OK = 0
EXIT_INTERNAL = 2
EXIT_DRAWING_ERROR = 3
SCRIPT_VERSION = "1"

# 1 point = 1/72 inch（PDF 页面坐标系的定义，不是图纸比例）
MM_PER_POINT = 25.4 / 72.0
DIGITS = 6

# 内容流算子分类（PDF 32000-1 §8/§9）
PATH_CONSTRUCT_OPS = {"m", "l", "c", "v", "y", "h", "re"}
PATH_PAINT_OPS = {"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"}
TEXT_SHOW_OPS = {"Tj", "TJ", "'", '"'}
# 认得但本切片不建模的算子分类：文字状态机与图形状态机各算一类，
# 只有两边都不认的才进 uncountedOps（"没数进去的未知算子"，不该混入正常算子）。
TEXT_STATE_OPS = {"BT", "ET", "Td", "TD", "Tm", "T*", "Tc", "Tw", "Tz", "TL", "Tr", "Ts", "Tf"}
GRAPHICS_STATE_OPS = {"q", "Q", "cm", "w", "J", "j", "M", "d", "ri", "i", "gs", "W", "W*", "BMC", "BDC", "EMC"}
# 一页至少有这么多路径算子才算"有矢量线稿"；图像覆盖率达到这个比例才算"整页扫描"。
# 阈值写死是因为它们决定分流结论：logo 覆盖率通常 <5%，整页扫描件 >50%。
SCAN_COVERAGE = 0.5
MIXED_COVERAGE = 0.3

# 比例尺文字：先找带标签的（"比例尺 1:100" / "SCALE 1:100"），再找裸的 "1:100"。
SCALE_LABELLED = re.compile(r"(?:比例尺?|比\s*例|SCALE|Scale)\s*[:：]?\s*1\s*[:：]\s*(\d{1,5})")
SCALE_BARE = re.compile(r"(?<![\d.])1\s*[:：]\s*(\d{2,5})(?![\d.])")

MAX_SCALE_STATEMENTS = 8


def r(value: float | None, digits: int = DIGITS) -> float | None:
    """浮点归一：JSON 里不出现 -0.0 与 1e-17 这类噪声。"""
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    out = round(float(value), digits)
    return 0.0 if out == 0 else out


def emit(payload: dict, prefix: str) -> None:
    print(prefix + json.dumps(payload, ensure_ascii=False))


def fail(code: str, message: str, **extra) -> int:
    emit({"ok": False, "scriptVersion": SCRIPT_VERSION,
          "error": {"code": code, "message": message, **extra}}, ERROR_PREFIX)
    return EXIT_DRAWING_ERROR


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preflight(path: str) -> tuple[dict | None, int]:
    """不依赖 pypdf 的文件级检查：缺文件 / 不是普通文件 / 空文件 / 不是 PDF。"""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None, fail("DRAWING_FILE_MISSING", f"文件不存在：{path}", path=path)
    except OSError as error:
        return None, fail("DRAWING_FILE_UNREADABLE", f"文件不可读：{error}", path=path)
    if not os.path.isfile(path):
        return None, fail("DRAWING_FILE_NOT_A_FILE", f"不是普通文件：{path}", path=path)
    if st.st_size == 0:
        return None, fail("DRAWING_FILE_EMPTY", f"文件是空的：{path}", path=path)
    with open(path, "rb") as handle:
        # 读多一点：ASCII DXF 的 "SECTION" 要到第 3 个字节之后才出现，只看 8 字节会把它误判成 unknown。
        start = handle.read(512)
    head = start[:8]
    if not start.startswith(b"%PDF-"):
        stripped = start.lstrip(b"\xef\xbb\xbf \t\r\n")
        kind = "unknown"
        if stripped[:3] in (b"AC1", b"AC2") and stripped[:6].rstrip(b"\x00").decode("latin1")[:6] in {
                "AC2.10", "AC2.21", "AC2.22", "AC1001", "AC1002", "AC1003", "AC1004", "AC1005", "AC1006",
                "AC1007", "AC1008", "AC1009", "AC1010", "AC1011", "AC1012", "AC1013", "AC1014", "AC1500",
                "AC1015", "AC1016", "AC1017", "AC1018", "AC1021", "AC1024", "AC1027", "AC1032"}:
            kind = "dwg"
        elif stripped.startswith(b"AutoCAD Binary DXF") or b"SECTION" in stripped[:64]:
            kind = "dxf"
        elif stripped.startswith((b"\x89PNG", b"\xff\xd8\xff", b"II*\x00", b"MM\x00*", b"BM", b"GIF8")):
            kind = "image"
        return None, fail("PDF_HEADER_MISSING",
                          f"这不是 PDF（文件头 {head!r}，看起来是 {kind}）："
                          "本脚本只读 PDF；DXF/DWG 走 cad_inspect，位图图纸直接作为图片交给模型读图",
                          path=path, detected=kind, header=head.hex())
    return {"path": path, "bytes": st.st_size, "head": head}, EXIT_OK


# ---------------------------------------------------------------------------
# 内容流分析：CTM 跟踪 + 路径算子 + 图像覆盖
# ---------------------------------------------------------------------------
def mat_mul(m: list[float], n: list[float]) -> list[float]:
    """PDF 矩阵乘法 m×n（行向量约定：[a b c d e f]，x' = a·x + c·y + e）。"""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return [a * a2 + b * c2, a * b2 + b * d2, c * a2 + d * c2, c * b2 + d * d2, e * a2 + f * c2 + e2,
            e * b2 + f * d2 + f2]


def apply_matrix(m: list[float], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def box_of_matrix(m: list[float]) -> tuple[float, float, float, float]:
    """单位方格 [0,1]² 经矩阵变换后的外接盒（图像绘制的实际覆盖范围）。"""
    pts = [apply_matrix(m, x, y) for x in (0.0, 1.0) for y in (0.0, 1.0)]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


class PageScan:
    """一页内容流的走查结果：算子计数、真实路径（带 CTM）、图像绘制与覆盖率。"""

    def __init__(self, max_points: int, reader=None):
        self.max_points = max_points
        self.reader = reader
        self.counts = Counter()
        self.paths: list[dict] = []
        self.path_count = 0
        self.path_points_truncated = False
        self.images: list[dict] = []
        self.inline_images = 0
        self.text_ops = 0
        self.text_state_ops = 0
        self.graphics_state_ops = 0
        self.uncounted_ops: Counter = Counter()
        self._ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        self._stack: list[list[float]] = []
        self._current: list[list[float]] | None = None
        self._closed = False
        self._start = (0.0, 0.0)

    # --- 路径段收集（点已按 CTM 变换到页面坐标） ---
    def _begin(self) -> None:
        if self._current is None:
            self._current = []
            self._closed = False

    def _push(self, x: float, y: float) -> None:
        self._begin()
        assert self._current is not None
        if len(self._current) < self.max_points:
            self._current.append([r(x), r(y)])
        else:
            self.path_points_truncated = True

    def _finish(self, paint: str) -> None:
        if self._current is None:
            return
        closed = self._closed or paint in {"s", "b", "b*"}
        self.path_count += 1
        self.paths.append({
            "index": self.path_count - 1,
            "points": self._current,
            "closed": closed,
            "paint": paint,
            "stroked": paint in {"S", "s", "B", "B*", "b", "b*"},
            "filled": paint in {"f", "F", "f*", "B", "B*", "b", "b*"},
            "pointCount": len(self._current),
        })
        self._current = None
        self._closed = False

    def walk(self, operations, xobjects, resources_resolver, depth: int = 0) -> None:
        """走一遍算子序列。xobjects：名字 → XObject 字典；depth 限制 Form 递归。"""
        for operands, operator in operations:
            name = operator.decode("latin1") if isinstance(operator, bytes) else str(operator)
            self.counts[name] += 1
            try:
                if name == "q":
                    self._stack.append(list(self._ctm))
                elif name == "Q":
                    if self._stack:
                        self._ctm = self._stack.pop()
                elif name == "cm":
                    matrix = [float(value) for value in operands[:6]]
                    if len(matrix) == 6:
                        self._ctm = mat_mul(matrix, self._ctm)
                elif name == "m":
                    self._start = apply_matrix(self._ctm, float(operands[0]), float(operands[1]))
                    self._begin()
                    self._push(*self._start)
                elif name == "l":
                    self._push(*apply_matrix(self._ctm, float(operands[0]), float(operands[1])))
                elif name == "c":
                    for index in range(0, 6, 2):
                        self._push(*apply_matrix(self._ctm, float(operands[index]), float(operands[index + 1])))
                elif name in ("v", "y"):
                    self._push(*apply_matrix(self._ctm, float(operands[0]), float(operands[1])))
                    if name == "y":
                        self._push(*apply_matrix(self._ctm, float(operands[2]), float(operands[3])))
                elif name == "h":
                    self._begin()
                    self._closed = True
                    self._push(*self._start)
                elif name == "re":
                    x, y, w, h = (float(value) for value in operands[:4])
                    for corner in ((x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)):
                        self._push(*apply_matrix(self._ctm, corner[0], corner[1]))
                    self._closed = True  # re 构造的就是闭合子路径
                elif name in PATH_PAINT_OPS:
                    if name == "n":  # 只构造不描绘：路径没画出来，不记为图形
                        self._current = None
                    else:
                        self._finish(name)
                elif name in TEXT_SHOW_OPS:
                    self.text_ops += 1
                elif name == "Do":
                    self._handle_xobject(str(operands[0]), xobjects, resources_resolver, depth)
                elif name == "INLINE IMAGE":
                    self._record_inline_image(operands)
                elif name in TEXT_STATE_OPS:
                    self.text_state_ops += 1
                elif name in GRAPHICS_STATE_OPS:
                    self.graphics_state_ops += 1
                else:
                    self.uncounted_ops[name] += 1
            except (TypeError, ValueError, IndexError):
                # 单个算子参数异常不该让整页分析失败：记在 uncounted 里继续走。
                self.uncounted_ops[f"{name}(bad-operands)"] += 1
        if depth == 0:
            self._finish("unpainted")

    def _record_inline_image(self, operands) -> None:
        """inline image（BI…ID…EI）：pypdf 合成为一个 INLINE IMAGE 算子，字典在 operands['settings']。

        inline 图没有 Image XObject，page.images 取不到它；导出时会落到栅格化兜底
        （source=rasterized）。这里照 CTM 记下它的绘制页面框，否则"整页就是一张 inline 图"
        的扫描件既算不出覆盖率、也不会被判成扫描页。
        """
        settings = operands.get("settings") if isinstance(operands, dict) else None
        if not isinstance(settings, dict):
            settings = {}
        self.inline_images += 1
        box = box_of_matrix(self._ctm)

        def dimension(key: str) -> int:
            try:
                return int(float(settings.get(key, 0) or 0))
            except (TypeError, ValueError):
                return 0

        self.images.append({
            "name": f"inline-{self.inline_images}",
            "pageBox": [r(value) for value in box],
            "placedWidth": r(box[2] - box[0]),
            "placedHeight": r(box[3] - box[1]),
            "width": dimension("/W"),
            "height": dimension("/H"),
            "filter": str(settings.get("/F", "")) or None,
            "inline": True,
        })

    def _handle_xobject(self, ref: str, xobjects, resources_resolver, depth: int) -> None:
        target = None
        if xobjects is not None:
            target = xobjects.get(ref)
        if target is None and resources_resolver is not None:
            target = resources_resolver(ref)
        if target is None:
            self.uncounted_ops["Do(unresolved-xobject)"] += 1
            return
        try:
            subtype = str(target.get("/Subtype", ""))
        except AttributeError:
            self.uncounted_ops["Do(unresolved-xobject)"] += 1
            return
        if subtype == "/Image":
            box = box_of_matrix(self._ctm)
            self.images.append({
                "name": ref,
                "pageBox": [r(value) for value in box],
                "placedWidth": r(box[2] - box[0]),
                "placedHeight": r(box[3] - box[1]),
                "width": int(target.get("/Width", 0) or 0),
                "height": int(target.get("/Height", 0) or 0),
                "filter": str(target.get("/Filter", "")) or None,
                "inline": False,
            })
        elif subtype == "/Form" and depth < 4:
            if self.reader is None or not hasattr(target, "get_data"):
                return
            from pypdf.generic import ContentStream  # 局部导入：只有真需要递归时才用

            nested_resources = target.get("/Resources")
            # 连同 Form 自己的 /Resources 递归进去：嵌套 Form（Form 里再 Do 一个 Form）在
            # 绘图仪导出的图纸里很常见，不递归就会漏掉内层画的图。
            self.walk(ContentStream(target, self.reader).operations, xobjects,
                      _xobject_resolver(nested_resources), depth + 1)


def _xobject_resolver(resources):
    if resources is None:
        return None
    try:
        xobjects = resources.get("/XObject")
    except AttributeError:
        return None
    if xobjects is None:
        return None

    def resolve(name: str):
        try:
            return xobjects.get(name)
        except Exception:
            return None

    return resolve


# ---------------------------------------------------------------------------
# 页级事实
# ---------------------------------------------------------------------------
def number_list(value, expect: int) -> list[float] | None:
    try:
        items = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    if len(items) < expect:
        return None
    return [items[i] for i in range(expect)]


def box_facts(box: list[float] | None, user_unit: float) -> dict | None:
    """把页面盒（point）换算成 mm；`userUnit` 是页面自己声明的倍率（1 unit = userUnit/72 inch）。"""
    if box is None:
        return None
    width = abs(box[2] - box[0]) * user_unit
    height = abs(box[3] - box[1]) * user_unit
    return {
        "points": [r(box[0]), r(box[1]), r(box[2]), r(box[3])],
        "widthPoints": r(width),
        "heightPoints": r(height),
        "widthMm": r(width * MM_PER_POINT),
        "heightMm": r(height * MM_PER_POINT),
    }


def analyze_page(reader, page, index: int, max_points: int) -> tuple[dict, list[dict]]:
    """返回 (页面事实, 该页文字项列表)。坏页不让整份报告失败：异常记在页事实里。"""
    from pypdf.generic import ContentStream

    errors: list[str] = []
    try:
        mediabox = number_list(page.mediabox, 4)
    except Exception as error:
        mediabox = None
        errors.append(f"mediaBox: {type(error).__name__}: {error}")
    try:
        cropbox = number_list(page.cropbox, 4) if page.cropbox is not None else None
    except Exception as error:
        cropbox = None
        errors.append(f"cropBox: {type(error).__name__}: {error}")
    try:
        user_unit = float(page.get("/UserUnit", 1) or 1)
    except (TypeError, ValueError):
        user_unit = 1.0
    try:
        rotation = int(page.get("/Rotate", 0) or 0) % 360
    except (TypeError, ValueError):
        rotation = 0
    page_facts: dict = {
        "index": index,
        "label": str(page.get("/T", "") or "") or None,
        "rotation": rotation,
        "mediaBox": [r(value) for value in mediabox] if mediabox else None,
        "cropBox": [r(value) for value in cropbox] if cropbox else None,
        "userUnit": r(user_unit),
        "size": box_facts(mediabox, user_unit),
        "content": {},
        "text": {},
        "images": [],
        "classification": "empty",
        "errors": errors,
    }
    scan = PageScan(max_points, reader)
    try:
        contents = page.get_contents()
        operations = ContentStream(contents, reader).operations if contents is not None else []
        xobjects = None
        try:
            xobjects = page.get("/Resources", {}).get("/XObject")
        except Exception:
            xobjects = None
        scan.walk(operations, xobjects, _xobject_resolver(page.get("/Resources", {})), 0)
    except Exception as error:  # 解析不了的内容流：如实记，不猜
        page_facts["errors"].append(f"content-stream: {type(error).__name__}: {error}")
    # 页面面积（未旋转的页面盒），用于图像覆盖率
    page_area = 0.0
    if mediabox:
        page_area = abs(mediabox[2] - mediabox[0]) * abs(mediabox[3] - mediabox[1])
    image_coverage = 0.0
    images: list[dict] = []
    for entry in scan.images:
        placed = (entry["pageBox"][2] - entry["pageBox"][0]) * (entry["pageBox"][3] - entry["pageBox"][1])
        coverage = (placed / page_area) if page_area > 0 else 0.0
        image_coverage = max(image_coverage, min(coverage, 4.0))
        images.append({**entry, "coverage": r(coverage)})
    # 文字：位置来自 pypdf 的文本抽取（带字宽计算），不是只看算子个数
    text_items: list[dict] = []
    text_chars = 0
    text_error = None
    try:
        def visitor(text, cm, tm, font_dict, font_size):
            nonlocal text_chars
            text_chars += len(text)
            if len(text_items) < 5000 and text.strip():
                point = apply_matrix([float(v) for v in cm], float(tm[4]), float(tm[5]))
                text_items.append({
                    "page": index,
                    "text": text,
                    "x": r(point[0]),
                    "y": r(point[1]),
                    "fontSize": r(float(font_size) if font_size is not None else None),
                })

        page.extract_text(visitor_text=visitor)
    except Exception as error:
        text_error = f"{type(error).__name__}: {error}"
        page_facts["errors"].append(f"text-extraction: {text_error}")
    path_ops = sum(scan.counts[op] for op in PATH_CONSTRUCT_OPS)
    paint_ops = sum(scan.counts[op] for op in PATH_PAINT_OPS)
    has_vector = bool(path_ops or paint_ops or scan.text_ops or text_chars)
    has_scan = bool(images) and image_coverage >= SCAN_COVERAGE
    if has_vector and has_scan:
        classification = "mixed"
    elif has_scan:
        classification = "scanned"
    elif has_vector:
        classification = "vector"
    elif images:
        classification = "image-only"
    else:
        classification = "empty"
    page_facts["content"] = {
        "pathConstructOps": path_ops,
        "pathPaintOps": paint_ops,
        "pathOpsByType": {op: scan.counts.get(op, 0) for op in sorted(PATH_CONSTRUCT_OPS) if scan.counts.get(op)},
        "textShowOps": scan.text_ops,
        "textStateOps": scan.text_state_ops,
        "graphicsStateOps": scan.graphics_state_ops,
        "pathsRecorded": scan.path_count,
        "imagesDrawn": len(images),
        "inlineImages": scan.inline_images,
        "imageCoverage": r(image_coverage),
        "uncountedOps": dict(scan.uncounted_ops.most_common(12)),
        "opsNote": "pathConstructOps/路径明细来自真实内容流（含 Form XObject 递归与 CTM 变换）；"
                   "uncountedOps 是两边都不认的未知算子，正常 PDF 应为空",
    }
    page_facts["text"] = {
        "chars": text_chars,
        "itemCount": len(text_items),
        "sample": "".join(item["text"] for item in text_items)[:200] or None,
        "error": text_error,
    }
    page_facts["images"] = [
        {key: value for key, value in entry.items() if key != "pageBox"} for entry in images
    ]
    page_facts["classification"] = classification
    page_facts["_paths"] = scan.paths
    page_facts["_pathsTruncated"] = scan.path_points_truncated
    return page_facts, text_items


def classify_document(classes: list[str]) -> str:
    unique = {value for value in classes if value != "empty"}
    if not unique:
        return "empty"
    if len(unique) == 1:
        return next(iter(unique))
    return "mixed"


def scale_statements(text_items: list[dict]) -> list[dict]:
    """从图纸文字里找比例尺声明。**只作文字证据列出**，不自动当换算因子。"""
    found: list[dict] = []
    seen: set[tuple[int, int, str]] = set()
    for item in text_items:
        text = item["text"].strip()
        if not text:
            continue
        labelled = SCALE_LABELLED.search(text)
        pattern = labelled or SCALE_BARE.search(text)
        if not pattern:
            continue
        denominator = int(pattern.group(1))
        if denominator <= 0:
            continue
        key = (item["page"], denominator, "label" if labelled else "bare")
        if key in seen:
            continue
        seen.add(key)
        found.append({
            "page": item["page"],
            "text": text[:120],
            "scale": f"1:{denominator}",
            "denominator": denominator,
            "evidence": "label" if labelled else "bare",
            "metresPerPagePoint": r(MM_PER_POINT * denominator / 1000.0, 12),
            "note": "来自图纸文字的推断：仅当该页确实是这个比例、且页面未被缩放/拼版时才成立",
        })
        if len(found) >= MAX_SCALE_STATEMENTS:
            break
    return found


# ---------------------------------------------------------------------------
# 图像导出（扫描页的原生图像）
# ---------------------------------------------------------------------------
def rasterizer_binary(kind: str) -> str | None:
    """本机真实存在的 gs / pdftocairo；没有就返回 None，不编造命令。"""
    return shutil.which(kind)


def add_warning(warnings: list[str], code: str) -> None:
    """同样的告警只留一条（逐页触发时不会把列表刷爆）。"""
    if code not in warnings:
        warnings.append(code)


def page_needs_display_render(page_facts: dict) -> tuple[bool, list[str]]:
    """这页的**嵌入像素**能不能直接当"用户看到的整页"？

    不能的两种情况：页面有 /Rotate（图像资源里的像素没被转），或者 CropBox 与 MediaBox
    不同（图像可能整幅画在 MediaBox 上，用户看到的只是裁切后的窗口）。
    返回 (是否需要整页渲染, 原因列表)。叠加内容（矢量/文字/另一张图）无法从页面字典判定，
    所以嵌入像素一律标 asDisplayed=false，不冒充整页显示效果。
    """
    reasons: list[str] = []
    if int(page_facts.get("rotation") or 0) % 360:
        reasons.append("page-rotation")
    media = page_facts.get("mediaBox")
    crop = page_facts.get("cropBox")
    if media and crop and len(media) == 4 and len(crop) == 4 \
            and any(abs(float(a) - float(b)) > 0.01 for a, b in zip(media, crop)):
        reasons.append("crop-box")
    return bool(reasons), reasons


def probe_rasterizer(preference: str, page_number: int, dpi: int, pdf: str, out: str):
    """找一个能用的栅格化工具并整页跑一页。返回 (来源, 工具版本, 说明) 或 (None, 原因)。

    用途有两处：① 带 /Rotate 或 CropBox 的扫描页要给"用户看到的样子"，嵌入像素不够用；
    ② 嵌入图整个取不出来时的兜底。两处都是**整页渲染**，所以一律按显示框（CropBox）出图，
    并按页面自己的 /Rotate 方向渲染（gs 默认尊重 /Rotate，pdftocairo 也是），
    产物在报告里标 asDisplayed=true——它才是用户看到的那张图。
    """
    candidates = ["gs", "pdftocairo"] if preference in ("auto", "") else [preference]
    for kind in candidates:
        if kind == "none":
            continue
        executable = rasterizer_binary(kind)
        if executable is None:
            continue
        if kind == "gs":
            # gs 默认用 MediaBox；-dUseCropBox 才是用户看到的窗口
            argv = [executable, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dUseCropBox",
                    "-sDEVICE=png16m", f"-r{dpi}", "-dFirstPage=%d" % page_number,
                    "-dLastPage=%d" % page_number, f"-sOutputFile={out}", pdf]
            version_argv = [executable, "--version"]
        else:
            prefix = out[:-4] if out.endswith(".png") else out
            # pdftocairo 默认也是 MediaBox；-cropbox 才按显示窗口出图
            argv = [executable, "-png", "-cropbox", "-r", str(dpi), "-f", str(page_number),
                    "-l", str(page_number), "-singlefile", pdf, prefix]
            version_argv = [executable, "-v"]
        try:
            done = subprocess.run(argv, capture_output=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired) as error:
            continue
        if done.returncode != 0 or not os.path.exists(out):
            continue
        version = "unknown"
        try:
            probe = subprocess.run(version_argv, capture_output=True, timeout=30)
            version = (probe.stdout or probe.stderr).decode("utf-8", "replace").strip().splitlines()[0]
        except Exception:
            pass
        return kind, version, None
    return None, f"没有可用的栅格化工具（尝试过：{', '.join(candidates)}）"


def export_embedded_images(page, out_dir: str, page_index: int, max_pixels: int,
                           max_bytes: int) -> tuple[list[dict], list[dict]]:
    """把一页里嵌入的原生图像写成 PNG（pypdf 解原生像素，Pillow 只做像素上限缩放）。"""
    exported: list[dict] = []
    failures: list[dict] = []
    try:
        images = list(page.images)
    except Exception as error:
        return exported, [{"page": page_index, "reason": f"嵌入图枚举失败：{type(error).__name__}: {error}"}]
    for position, image in enumerate(images, start=1):
        name = getattr(image, "name", f"image-{position}")
        try:
            data = image.data
        except Exception as error:
            failures.append({"page": page_index, "image": name,
                             "reason": f"取原始数据失败：{type(error).__name__}: {error}"})
            continue
        try:
            from PIL import Image  # Pillow 只在这一步需要（转 PNG / 控制像素上限）
            import io

            pil = Image.open(io.BytesIO(data))
            pil.load()
            width, height = pil.size
            downscaled = False
            if max_pixels > 0 and width * height > max_pixels:
                factor = math.sqrt(max_pixels / float(width * height))
                pil = pil.resize((max(1, int(width * factor)), max(1, int(height * factor))))
                downscaled = True
            if pil.mode not in ("L", "LA", "RGB", "RGBA", "P", "1"):
                pil = pil.convert("RGB")
            target = os.path.join(out_dir, f"page-{page_index}-image-{position}.png")
            pil.save(target, format="PNG")
            size = os.path.getsize(target)
            if max_bytes > 0 and size > max_bytes:
                # 再缩一半直到进预算（仍进不了就如实报失败，不硬塞）
                while size > max_bytes and pil.size[0] > 8 and pil.size[1] > 8:
                    pil = pil.resize((pil.size[0] // 2, pil.size[1] // 2))
                    pil.save(target, format="PNG")
                    size = os.path.getsize(target)
                    downscaled = True
                if size > max_bytes:
                    os.unlink(target)
                    failures.append({"page": page_index, "image": name,
                                     "reason": f"导出图 {size} 字节超过单图上限 {max_bytes}"})
                    continue
            exported.append({
                "page": page_index,
                "name": name,
                "path": target,
                "source": "embedded",
                "width": pil.size[0],
                "height": pil.size[1],
                "bytes": size,
                "sha256": sha256_file(target),
                "downscaled": downscaled,
            })
        except Exception as error:
            failures.append({"page": page_index, "image": name,
                             "reason": f"转 PNG 失败：{type(error).__name__}: {error}"})
    if not images:
        failures.append({"page": page_index, "reason": "这页没有可导出的嵌入图像"})
    return exported, failures


def png_size(path: str) -> tuple[int | None, int | None]:
    """PNG 像素尺寸（Pillow 不在就如实给 None，不猜）。"""
    try:
        from PIL import Image
        with Image.open(path) as image:
            return image.size[0], image.size[1]
    except Exception:
        return None, None


def rasterize_page(args, page_facts: dict, pdf: str, suffix: str,
                   reasons: list[str] | None = None) -> tuple[dict | None, str | None]:
    """按**显示效果**整页渲染一页，返回 (图像条目, None) 或 (None, 失败原因)。

    这是"模型看到用户看到的图纸"的那条路：嵌入像素可能既没转 /Rotate、也没裁 CropBox。
    产物标 asDisplayed=true，并带上页面自己的 rotateDegrees / cropBox 供核对。
    """
    index = page_facts["index"]
    target = os.path.join(args.image_dir, f"page-{index}-{suffix}.png")
    kind, version, reason = probe_rasterizer(args.rasterizer, index, args.dpi, pdf, target)
    if not kind:
        return None, f"整页渲染没跑起来（{reason}）"
    width, height = png_size(target)
    reasons = reasons or []
    entry = {
        "page": index,
        "name": f"{suffix}-{index}",
        "path": target,
        "source": "rasterized",
        "asDisplayed": True,
        "tool": kind,
        "toolVersion": version,
        "dpi": args.dpi,
        "width": width,
        "height": height,
        "bytes": os.path.getsize(target),
        "sha256": sha256_file(target),
        "rotateDegrees": int(page_facts.get("rotation") or 0) % 360,
        "cropBox": page_facts.get("cropBox"),
    }
    if reasons:
        entry["reason"] = reasons
        entry["note"] = ("该页带 /Rotate 或 CropBox，嵌入像素不是用户看到的整页；"
                         "这里按显示框（CropBox）与页面旋转整页重新渲染（像素与原始扫描件不逐位相同）")
    else:
        entry["note"] = "原生嵌入图不可用，改为整页栅格化（像素与原始扫描件不逐位相同）"
    return entry, None


def annotate_embedded_entries(page_exported: list[dict], page_facts: dict) -> None:
    """嵌入像素**不等于**整页显示效果：逐条标 asDisplayed=false 并给出显式变换参数。"""
    rotation = int(page_facts.get("rotation") or 0) % 360
    for item in page_exported:
        item["asDisplayed"] = False
        item["rotateDegrees"] = rotation
        item["cropBox"] = page_facts.get("cropBox")
        item["mediaBox"] = page_facts.get("mediaBox")
        item["note"] = ("页面里的嵌入像素（原样解码）：不含页面 /Rotate 的旋转效果与 CropBox 裁切，"
                        "也可能漏掉画在其上的矢量/文字/其它叠图——它不是“用户看到的整页”。"
                        "需要显示效果时按 rotateDegrees/cropBox 自行变换，或让本工具栅格化出整页预览")


# ---------------------------------------------------------------------------
# 主报告
# ---------------------------------------------------------------------------
def build_report(reader, path: str, file_facts: dict, args) -> tuple[dict, list[str], list[dict]]:
    warnings: list[str] = []
    pages: list[dict] = []
    text_items: list[dict] = []
    max_pages = args.max_pages if args.max_pages > 0 else len(reader.pages)
    for index, page in enumerate(reader.pages, start=1):
        if index > max_pages:
            break
        page_facts, page_text = analyze_page(reader, page, index, args.max_points)
        text_items.extend(page_text)
        paths = page_facts.pop("_paths")
        page_facts["pathsTruncated"] = page_facts.pop("_pathsTruncated")
        page_facts["_paths"] = paths
        pages.append(page_facts)
    total_pages = len(reader.pages)
    if max_pages < total_pages:
        warnings.append("PDF_PAGES_TRUNCATED")
        # 只分析了前几页：文档级结论（classification）不能代表没读过的页
        warnings.append("PDF_CLASSIFICATION_PARTIAL")
    # 矢量路径：跨页汇总 + 上限
    all_paths: list[dict] = []
    for page_facts in pages:
        for entry in page_facts["_paths"]:
            all_paths.append({"page": page_facts["index"], **entry})
    listed = all_paths[:args.max_items]
    path_points_truncated = any(page_facts["pathsTruncated"] for page_facts in pages)
    if len(all_paths) > len(listed):
        warnings.append("PDF_PATHS_TRUNCATED")
    if path_points_truncated:
        warnings.append("PDF_PATH_POINTS_TRUNCATED")
    xs: list[float] = []
    ys: list[float] = []
    for entry in all_paths:
        for point in entry["points"]:
            xs.append(point[0])
            ys.append(point[1])
    bbox_points = [min(xs), min(ys), max(xs), max(ys)] if xs and ys else None
    # 文字
    listed_text = text_items[:args.max_items]
    if len(text_items) > len(listed_text):
        warnings.append("PDF_TEXT_TRUNCATED")
    # 单位块
    user_units = sorted({page_facts["userUnit"] for page_facts in pages})
    if len(user_units) > 1:
        warnings.append("PDF_MIXED_USER_UNIT")
    scale = parse_scale(args.scale)
    statements = scale_statements(text_items)
    units = {
        "pageUnit": "point (1/72 inch)",
        "pointsPerInch": 72.0,
        "mmPerPoint": r(MM_PER_POINT, 12),
        "userUnit": user_units[0] if len(user_units) == 1 else user_units,
        "metresKnown": bool(scale),
        "metresSource": "caller-scale" if scale else None,
        "metresPerPagePoint": r(MM_PER_POINT * scale / 1000.0, 12) if scale else None,
        "callerScale": args.scale if scale else None,
        "scaleStatements": statements,
        "note": "页面坐标单位是 1/72 英寸的图纸单位，不是建筑实际尺寸；报告的 mm 是**纸面**尺寸。"
                "没有显式 --scale（例如 1:100）时 metresKnown=false、metresPerPagePoint=null，"
                "本报告不把 page point 当米。文字里的 1:N 只列在 scaleStatements（文字证据，未核对）。",
    }
    page_classes = [page_facts["classification"] for page_facts in pages]
    classification = classify_document(page_classes)
    if classification == "mixed" and len({value for value in page_classes}) > 1 and all(
            value in ("scanned", "vector", "image-only", "empty") for value in page_classes):
        warnings.append("PDF_MIXED_PAGES")
    if classification in ("scanned", "mixed"):
        warnings.append("PDF_HAS_SCANNED_PAGES")
    vector = {
        "pathCount": len(all_paths),
        "pathsListed": len(listed),
        "paths": listed,
        "byPaint": dict(Counter(entry["paint"] for entry in all_paths).most_common()),
        "closedPathCount": sum(1 for entry in all_paths if entry["closed"]),
        "bboxPagePoints": [r(value) for value in bbox_points] if bbox_points else None,
        "bboxPageMm": ([r(value * MM_PER_POINT) for value in bbox_points] if bbox_points else None),
        "bboxMetresByCallerScale": ([r(value * MM_PER_POINT * scale / 1000.0) for value in bbox_points]
                                    if bbox_points and scale else None),
        "note": "路径点是**页面坐标**（已按 CTM/Form 变换到页面空间），不是图纸原点坐标；"
                "覆盖率高的图像 + 路径叠加会标成 mixed。bboxPageMm 是纸面范围，不是建筑尺寸。",
    }
    text = {
        "charCount": sum(page_facts["text"]["chars"] for page_facts in pages),
        "itemCount": len(text_items),
        "itemsListed": len(listed_text),
        "items": listed_text,
        "pagesWithText": sorted({page_facts["index"] for page_facts in pages if page_facts["text"]["chars"]}),
        "note": "文字项坐标是页面坐标；itemsListed 受 --max-items 限制，charCount/itemCount 是全量。",
    }
    for page_facts in pages:
        page_facts.pop("_paths", None)
    report = {
        "ok": True,
        "scriptVersion": SCRIPT_VERSION,
        "source": {
            "engine": "pypdf",
            "engineVersion": getattr(__import__("pypdf"), "__version__", "unknown"),
            "interpreter": sys.executable,
            "interpreterVersion": sys.version.split()[0],
            "pillow": pillow_version(),
        },
        "file": {
            "path": path,
            "name": os.path.basename(path),
            "bytes": file_facts["bytes"],
            "sha256": sha256_file(path),
        },
        "format": {
            "kind": "pdf",
            "header": (reader.pdf_header or "").strip() or None,
            "pageCount": len(reader.pages),
            "pagesAnalyzed": len(pages),
            "encrypted": False,
            "producer": str(reader.metadata.producer) if reader.metadata and reader.metadata.producer else None,
            "creator": str(reader.metadata.creator) if reader.metadata and reader.metadata.creator else None,
        },
        "pages": pages,
        "classification": classification,
        "scope": {
            "pagesTotal": total_pages,
            "pagesAnalyzed": len(pages),
            "unanalyzedPageCount": total_pages - len(pages),
            "classificationCovers": "analyzed-pages-only" if len(pages) < total_pages else "whole-document",
            "note": "classification 与 pages/counts 都只由**真读过的这些页**得出；本脚本按页序只分析前 "
                    "pagesAnalyzed 页（--max-pages 上限），未分析的那些页没有被读过，"
                    "不能推断成同一种（分类也不代表整本）。总页数见 pagesTotal / format.pageCount。",
        },
        "units": units,
        "vector": vector,
        "text": text,
        "counts": {
            "pages": len(reader.pages),
            "pagesAnalyzed": len(pages),
            "vectorPaths": len(all_paths),
            "textItems": len(text_items),
            "scannedPages": sum(1 for value in page_classes if value in ("scanned", "image-only")),
            "mixedPages": sum(1 for value in page_classes if value == "mixed"),
            "vectorPages": sum(1 for value in page_classes if value == "vector"),
            "imagesDrawn": sum(page_facts["content"].get("imagesDrawn", 0) for page_facts in pages),
        },
        "images": {"exported": [], "failures": [], "requestedPages": [],
                   "note": "没有给 --image-dir：本次不导出图像（扫描页需要图像时由调用方显式要求）"},
        "warnings": warnings,
        "truncated": {"maxItems": args.max_items, "maxPointsPerPath": args.max_points,
                      "maxPages": max_pages, "pagesTruncated": max_pages < len(reader.pages),
                      "pathsTruncated": len(all_paths) > len(listed), "textTruncated": len(text_items) > len(listed_text),
                      "pathPointsTruncated": path_points_truncated},
    }
    return report, warnings, pages


def pillow_version() -> str | None:
    try:
        import PIL
        return getattr(PIL, "__version__", "unknown")
    except Exception:
        return None


def is_scale(value: str | None) -> bool:
    return parse_scale(value) is not None


SCALE_ARGUMENT = re.compile(r"^\s*(?:1\s*[:：]\s*)?([0-9]+(?:\.[0-9]+)?)\s*$")


def parse_scale(value: str | None) -> float | None:
    """`--scale 100` 或 `--scale 1:100` → 100.0（1 图纸单位 = 100 实际单位）。"""
    if not value:
        return None
    matched = SCALE_ARGUMENT.match(value)
    if not matched:
        return None
    number = float(matched.group(1))
    return number if number > 0 else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="读取 PDF 图纸并区分矢量/扫描（pypdf）")
    parser.add_argument("--input", required=True, help="PDF 文件路径")
    parser.add_argument("--max-items", type=int, default=200,
                        help="路径/文字明细条数上限（计数不受限）")
    parser.add_argument("--max-points", type=int, default=64, help="单条路径的点数上限")
    parser.add_argument("--max-pages", type=int, default=0, help="最多分析多少页（0 = 全部）")
    parser.add_argument("--image-dir", default=None,
                        help="把扫描页/混合页的原生图像导出到这个目录（不给就不导图）")
    parser.add_argument("--max-images", type=int, default=4, help="最多导出多少张图")
    parser.add_argument("--max-image-pixels", type=int, default=16_000_000, help="单图像素上限（超过则等比缩小）")
    parser.add_argument("--max-image-bytes", type=int, default=8_000_000, help="单图字节上限")
    parser.add_argument("--rasterizer", default="auto", choices=["auto", "gs", "pdftocairo", "none"],
                        help="嵌入图取不出来时的回退栅格化工具")
    parser.add_argument("--dpi", type=int, default=150, help="回退栅格化分辨率")
    parser.add_argument("--scale", default=None,
                        help="调用方显式给的比例尺（如 1:100 或 100），给出后才有 metresPerPagePoint")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    if args.max_items < 1 or args.max_points < 1:
        return fail("DRAWING_ARGUMENT_INVALID", "--max-items 与 --max-points 必须 >= 1")
    if args.scale is not None and not is_scale(args.scale):
        return fail("DRAWING_SCALE_INVALID", f"--scale 不合法：{args.scale!r}（示例：1:100 或 100）")
    path = os.path.expanduser(args.input)
    file_facts, status = preflight(path)
    if file_facts is None:
        return status
    try:
        import pypdf
        from pypdf import PdfReader
    except ImportError as error:
        return fail("DRAWING_PYPDF_MISSING",
                    f"解释器 {sys.executable} 里没有 pypdf（{error}）。请用独立 venv 安装："
                    "uv venv --offline … && uv pip install --offline pypdf pillow，并把该解释器配给绘图工具",
                    interpreter=sys.executable)
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            try:
                if reader.decrypt("") == 0:
                    raise ValueError("空口令无法解密")
            except Exception as error:
                return fail("PDF_ENCRYPTED",
                            f"PDF 已加密且不能空口令打开（{type(error).__name__}）：{error}；"
                            "本脚本不猜口令，请先解密/另存为无口令副本",
                            path=path)
        if len(reader.pages) == 0:
            return fail("PDF_NO_PAGES", f"PDF 里没有页面：{path}", path=path)
    except SystemExit:
        raise
    except Exception as error:
        return fail("PDF_PARSE_FAILED", f"pypdf 无法读取这个 PDF（{type(error).__name__}）：{error}",
                    path=path, interpreter=sys.executable, pypdfVersion=getattr(pypdf, "__version__", None))
    try:
        report, warnings, pages = build_report(reader, path, file_facts, args)
    except Exception as error:  # 未预期：如实报错，不用半份报告冒充成功
        import traceback
        traceback.print_exc(file=sys.stderr)
        return fail("PDF_REPORT_FAILED", f"读取成功但生成报告时失败：{type(error).__name__}: {error}",
                    path=path, interpreter=sys.executable)
    # 图像导出：只对扫描/混合页；这是"扫描 PDF 也能被模型看到"的唯一出口。
    if args.image_dir:
        os.makedirs(args.image_dir, exist_ok=True)
        candidates = [page_facts for page_facts in pages
                      if page_facts["classification"] in ("scanned", "mixed", "image-only")]
        exported: list[dict] = []
        failures: list[dict] = []
        for page_facts in candidates:
            if len(exported) >= args.max_images:
                add_warning(warnings, "PDF_IMAGES_TRUNCATED")
                break
            index = page_facts["index"]
            page = reader.pages[index - 1]
            needs_display, display_reasons = page_needs_display_render(page_facts)
            preview_done = False
            if needs_display and args.rasterizer != "none":
                # 带 /Rotate 或 CropBox：嵌入像素不等于用户看到的整页 → 优先给真页面预览
                entry, reason = rasterize_page(args, page_facts, path, "display", display_reasons)
                if entry:
                    exported.append(entry)
                    add_warning(warnings, "PDF_IMAGE_RASTERIZED")
                    preview_done = True
                else:
                    failures.append({"page": index, "reason": reason})
            if preview_done:
                continue
            page_exported, page_failures = export_embedded_images(
                page, args.image_dir, index, args.max_image_pixels, args.max_image_bytes)
            if page_exported:
                annotate_embedded_entries(page_exported, page_facts)
                if needs_display:
                    # 有旋转/裁切却只给了嵌入像素（栅格化不可用或失败）：必须明说，别当整页显示
                    add_warning(warnings, "PDF_IMAGE_NOT_AS_DISPLAYED")
            elif args.rasterizer != "none":
                # 嵌入图整个取不出来（编码不支持等）：整页栅格化兜底
                entry, reason = rasterize_page(args, page_facts, path, "raster", display_reasons)
                if entry:
                    page_exported = [entry]
                    add_warning(warnings, "PDF_IMAGE_RASTERIZED")
                else:
                    page_failures.append({"page": index, "reason": reason})
            elif not page_failures:
                page_failures.append({"page": index, "reason": "没有可导出的图像"})
            exported.extend(page_exported)
            failures.extend(page_failures)
        exported = exported[: args.max_images]
        report["images"] = {
            "exported": exported, "failures": failures,
            "requestedPages": [page_facts["index"] for page_facts in candidates],
            "note": "asDisplayed=true（source=rasterized）是按页面旋转/裁切整页渲染的预览，就是用户看到的那张图；"
                    "asDisplayed=false（source=embedded）是页面里嵌入的原样像素，可能不含 /Rotate 与 CropBox 的"
                    "显示效果，也可能漏掉画在其上的矢量/文字/叠图，另给了 rotateDegrees/cropBox 供显式变换。",
        }
        if report["classification"] in ("scanned", "image-only") and not exported:
            return fail("PDF_IMAGE_EXPORT_FAILED",
                        "扫描页没有导出任何图像，模型读不到图；原因见 failures",
                        path=path, failures=failures[:8])
        if failures:
            add_warning(warnings, "PDF_IMAGE_EXPORT_PARTIAL")
    report["warnings"] = warnings
    emit(report, RESULT_PREFIX)
    return EXIT_OK


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as fatal:  # 未预期异常：stderr 回溯 + 退出码 2
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"drawing_inspect 未预期失败: {type(fatal).__name__}: {fatal}", file=sys.stderr)
        raise SystemExit(EXIT_INTERNAL)
