#!/usr/bin/env python3
"""用 ezdxf 真实读取 DXF（ASCII 或 Binary），输出单位/图层/块定义与引用/曲线几何/尺寸标注/不支持实体。

这不是 CAD 内核：只做"读进来说明事实"，不做布尔运算、不做实体建模、不做 DXF 写回，
曲线也只给**参数**（端点/顶点/bulge/圆心半径/角度/参数区间），不做离散、求交、偏移。

三条硬纪律：
  · 单位只报**文件里的原值**和是否未知（`units.insunits` / `units.presentInFile` / `units.known`），
    文件没说就报未知，绝不默认成毫米或米；调用方可以显式给单位，此时标注 `units.source="caller"`。
  · DWG 不是 DXF：文件头是 DWG 签名（AC10xx）时直接报"需要转换器"，不尝试当成 DXF 解析。
  · 计数与明细分开：`counts` / `entityCounts` / 各 `*Count` 永远是全量，`--max-items` 只截断明细列表，
    并把截断记在 `truncated` 里——不拿"截断后的长度"冒充总数。

输出（stdout 单行，前缀固定）：
  LYAPUNOV_CAD_RESULT={...}   成功，退出码 0
  LYAPUNOV_CAD_ERROR={...}    可预期的失败（缺文件/DWG/依赖缺失/解析失败），退出码 3
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
import sys
from collections import Counter

RESULT_PREFIX = "LYAPUNOV_CAD_RESULT="
ERROR_PREFIX = "LYAPUNOV_CAD_ERROR="
EXIT_OK = 0
EXIT_INTERNAL = 2
EXIT_CAD_ERROR = 3
SCRIPT_VERSION = "2"
# 坐标/矩阵保留位数：DXF 内部是双精度，9 位十进制足够表达毫米级图纸且让 JSON 稳定可比。
DIGITS = 9
# 单条曲线的点上上限（顶点/控制点/拟合点）：超过就截断并记 verticesTotal，
# 避免一张大图把整份报告撑成几十兆；`--max-items` 管的是曲线条数，这里管单条曲线的大小。
MAX_POINTS_PER_CURVE = 128
# 单图层逐实体尺寸（layerBounds[].sizes）的上限：只影响"逐实体开口"的明细条数，
# 超过就记 sizesTruncated=true（entityCount 仍是全量），不静默截断。
MAX_ENTITY_SIZES_PER_LAYER = 512

# ---------------------------------------------------------------------------
# 单位：$INSUNITS 原值 → 名称 + 每单位多少米。
# 名称用于人读，因子用于换算；0（Unitless）与未知码都**没有**因子，必须报未知。
# 表来自 AutoCAD $INSUNITS 定义；ezdxf.units.unit_name 只在有表时用于交叉核对名称。
# ---------------------------------------------------------------------------
UNIT_TABLE = {
    1: ("Inches", 0.0254),
    2: ("Feet", 0.3048),
    3: ("Miles", 1609.344),
    4: ("Millimeters", 0.001),
    5: ("Centimeters", 0.01),
    6: ("Meters", 1.0),
    7: ("Kilometers", 1000.0),
    8: ("Microinches", 2.54e-8),
    9: ("Mils", 2.54e-5),
    10: ("Yards", 0.9144),
    11: ("Angstroms", 1e-10),
    12: ("Nanometers", 1e-9),
    13: ("Microns", 1e-6),
    14: ("Decimeters", 0.1),
    15: ("Decameters", 10.0),
    16: ("Hectometers", 100.0),
    17: ("Gigameters", 1e9),
    18: ("AstronomicalUnits", 1.495978707e11),
    19: ("LightYears", 9.4607304725808e15),
    20: ("Parsecs", 3.0856775814913673e16),
    21: ("USSurveyFeet", 1200.0 / 3937.0),
    22: ("USSurveyInch", 100.0 / 3937.0),
    23: ("USSurveyYard", 3600.0 / 3937.0),
    24: ("USSurveyMile", 6336000.0 / 3937.0),
}
# 调用方显式给单位时接受的名字（--unit）：值同样是米/单位。'um' 与 'µm' 都收。
CALLER_UNITS = {
    "in": ("Inches", 0.0254), "inch": ("Inches", 0.0254),
    "ft": ("Feet", 0.3048), "foot": ("Feet", 0.3048), "feet": ("Feet", 0.3048),
    "mi": ("Miles", 1609.344),
    "mm": ("Millimeters", 0.001),
    "cm": ("Centimeters", 0.01),
    "m": ("Meters", 1.0), "meter": ("Meters", 1.0), "metre": ("Meters", 1.0),
    "km": ("Kilometers", 1000.0),
    "yd": ("Yards", 0.9144),
    "um": ("Microns", 1e-6), "µm": ("Microns", 1e-6), "micron": ("Microns", 1e-6),
    "nm": ("Nanometers", 1e-9),
    "mil": ("Mils", 2.54e-5),
    "dm": ("Decimeters", 0.1),
}

# 本解析器**建模**的实体类型：会进 entityCounts、参与 bounds（见 bounds_entities）。
MODELED_TYPES = {
    "LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE", "POINT",
    "TEXT", "MTEXT", "ATTRIB", "ATTDEF", "INSERT", "DIMENSION", "HATCH",
    "SOLID", "TRACE", "3DFACE", "SHAPE",
}
# 给出**真实几何参数**的曲线类型（geometry.curves）：只报参数，不做离散/求交。
CURVE_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE"}
# 认得但**不建模**的类型：有名字、有理由，但几何不进 bounds（避免读成半截几何还以为完整）。
UNMODELED_REASONS = {
    "RAY": "无限构造射线，没有有限边界，不参与建模",
    "XLINE": "无限构造线，没有有限边界，不参与建模",
    "VIEWPORT": "图纸空间视口，属于出图布局而非模型几何",
    "OLE2FRAME": "内嵌 OLE 对象，内容不在 DXF 几何里",
    "MULTILEADER": "多重引线标注，非建模几何（本切片不解析其文本与箭头）",
    "MLINE": "多线（墙体样式线），需要样式表才能还原，本切片不解析",
    "LEADER": "引线标注，非建模几何",
    "IMAGE": "光栅图像引用，像素不在 DXF 内（需要外部文件）",
    "WIPEOUT": "遮罩区域，出图用",
    "PDFUNDERLAY": "PDF 外部参照，内容不在 DXF 内",
    "DGNUNDERLAY": "DGN 外部参照，内容不在 DXF 内",
    "DWFUNDERLAY": "DWF 外部参照，内容不在 DXF 内",
    "3DSOLID": "ACIS 实体（需要 ACIS 内核才能读懂几何）",
    "BODY": "ACIS 体（需要 ACIS 内核）",
    "REGION": "ACIS 面域（需要 ACIS 内核）",
    "SURFACE": "ACIS 曲面（需要 ACIS 内核）",
    "MESH": "多边形网格（本切片不提取面）",
    "HELIX": "螺旋线（本切片不提取）",
    "LIGHT": "光源对象，非几何",
    "TABLE": "表格对象，非建模几何",
    "TOLERANCE": "形位公差标注，非建模几何",
    "ACAD_TABLE": "表格对象，非建模几何",
}
# 尺寸标注类型（DXF 组码 70 的低 4 位）。
DIM_TYPE_NAMES = {0: "linear/rotated", 1: "aligned", 2: "angular", 3: "diameter", 4: "radius",
                  5: "angular3p", 6: "ordinate"}
# 角度的两类：测量值是度；其余（含 ordinate，它的测量值是一个点）不是长度。
DIM_ANGULAR_TYPES = {2, 5}
DIM_ORDINATE_TYPE = 6
# DXF 组码 70 的位定义（与 ezdxf entities/dimension.py 的注释、Dimension.ORDINATE_TYPE /
# USER_LOCATION_OVERRIDE 常量一致）：
#   32  = 组码 2 的块引用只被这个标注引用（R13+ 总是置位）
#   64  = ordinate 类型位（仅与类型 6 同用）：置位 = X 型，未置位 = Y 型
#   128 = 标注文字被放在了用户指定位置（而不是默认位置）
DIM_BIT_BLOCK_REFERENCE = 32
DIM_BIT_ORDINATE_TYPE = 64
DIM_BIT_TEXT_USER_POSITION = 128


def r(value):
    """浮点入 JSON 前统一收敛位数；NaN/Infinity 报 null（JSON 里没有这两个值）。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            return None
        rounded = round(number, DIGITS)
        return int(rounded) if rounded.is_integer() and abs(rounded) < 1e15 else rounded
    return value


def vec(v):
    """ezdxf 的 Vec3/tuple → [x, y, z]；缺失给 null。"""
    if v is None:
        return None
    try:
        return [r(v[0]), r(v[1]), r(v[2] if len(v) > 2 else 0.0)]
    except (TypeError, IndexError):
        return None


def emit(payload: dict, prefix: str) -> None:
    print(prefix + json.dumps(payload, ensure_ascii=False))


def fail(code: str, message: str, **extra) -> int:
    emit({"ok": False, "scriptVersion": SCRIPT_VERSION,
          "error": {"code": code, "message": message, **extra}}, ERROR_PREFIX)
    return EXIT_CAD_ERROR


def preflight(path: str) -> tuple[dict | None, int]:
    """不依赖 ezdxf 的文件级前置检查：缺文件 / DWG / 空文件。

    返回 (文件事实, 退出码)；无错误时退出码为 EXIT_OK。DWG 必须在读签名时就拒绝，
    绝不能落到 ezdxf 去"顺手试一下"——那会把 DWG 当成坏 DXF 报错，掩盖真正原因。
    ASCII 与 Binary DXF 都放行（ezdxf.readfile 两者都读，binary 走 binary_tags_loader）。
    """
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None, fail("CAD_FILE_MISSING", f"文件不存在：{path}", path=path)
    except OSError as error:
        return None, fail("CAD_FILE_UNREADABLE", f"文件不可读：{error}", path=path)
    if not os.path.isfile(path):
        return None, fail("CAD_FILE_NOT_A_FILE", f"不是普通文件：{path}", path=path)
    if st.st_size == 0:
        return None, fail("CAD_FILE_EMPTY", f"文件是空的：{path}", path=path)
    with open(path, "rb") as handle:
        head = handle.read(64)
    binary = head.startswith(b"AutoCAD Binary DXF")
    signature = head[:6]
    if not binary and re.match(rb"AC1\d{3}$", signature):
        return None, fail(
            "DWG_REQUIRES_CONVERTER",
            "文件头是 DWG 签名（%s），不是 DXF：DWG 需要外部转换器，本任务不把它当 DXF 解析。"
            "可用 ODA File Converter（ezdxf 的 odafc 附加件依赖它）或 LibreDWG 的 dwg2dxf 先转成 DXF，"
            "转换后把 DXF 交给本工具，并保留原 DWG 作为来源。" % signature.decode("ascii", "replace"),
            path=path, detected="dwg", signature=signature.decode("ascii", "replace"))
    return {"path": path, "name": os.path.basename(path), "bytes": st.st_size,
            "head": head, "binary": binary}, EXIT_OK


def header_value(doc, name: str):
    """取头变量原值；文件里没有该变量时返回 (None, False)——不落 ezdxf 的默认值。"""
    header = doc.header
    try:
        present = name in header
    except TypeError:
        present = False
    if not present:
        return None, False
    value = header.get(name, None)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value, True


def is_sentinel(value) -> bool:
    """DXF 头里的"未设置"哨兵（±1e20）；不能把它当真实边界报出去。"""
    try:
        return abs(float(value)) >= 1e20
    except (TypeError, ValueError):
        return True


def resolve_units(doc, caller_unit: str | None) -> tuple[dict, list[str]]:
    """单位事实：原值、是否来自文件、是否已知、换算因子、来源、是否与调用方冲突。"""
    warnings: list[str] = []
    raw, present = header_value(doc, "$INSUNITS")
    if raw is not None and not isinstance(raw, int):
        try:
            raw = int(raw)
        except (TypeError, ValueError):
            raw = None
    measurement, measurement_present = header_value(doc, "$MEASUREMENT")
    lunits, lunits_present = header_value(doc, "$LUNITS")
    aunits, aunits_present = header_value(doc, "$AUNITS")
    named = UNIT_TABLE.get(raw) if raw is not None else None
    header_known = named is not None and raw not in (0, None)
    units = {
        "insunits": raw,
        "presentInFile": present,
        "name": named[0] if header_known else None,
        "metresPerUnit": named[1] if header_known else None,
        "known": header_known,
        "source": "header" if header_known else "unknown",
        "callerSupplied": None,
        "measurement": measurement,
        "measurementInFile": measurement_present,
        "lunits": lunits,
        "lunitsInFile": lunits_present,
        "aunits": aunits,
        "aunitsInFile": aunits_present,
        "conflict": False,
        "note": "",
    }
    if not present:
        units["note"] = "文件里没有 $INSUNITS 头变量（例如 R12）：单位未知，不做任何默认。"
        warnings.append("CAD_UNIT_UNKNOWN: 文件未声明单位（$INSUNITS 缺失），metresPerUnit=null；"
                        "需要米制时由调用方显式给单位（会标注 units.source=\"caller\"）。")
    elif raw == 0:
        units["note"] = "$INSUNITS=0（Unitless）：图纸没有单位声明，不做任何默认。"
        warnings.append("CAD_UNIT_UNKNOWN: $INSUNITS=0（Unitless），metresPerUnit=null；"
                        "需要米制时由调用方显式给单位（会标注 units.source=\"caller\"）。")
    elif not header_known:
        units["note"] = f"$INSUNITS={raw} 不在已知单位表里：按未知处理，不做任何默认。"
        warnings.append(f"CAD_UNIT_UNKNOWN_CODE: $INSUNITS={raw} 未知，metresPerUnit=null。")
    if caller_unit is not None:
        name, factor = CALLER_UNITS[caller_unit]
        units["callerSupplied"] = {"requested": caller_unit, "name": name, "metresPerUnit": factor}
        units["name"] = name
        units["metresPerUnit"] = factor
        units["known"] = True
        units["source"] = "caller"
        if header_known:
            ratio = abs(named[1] - factor) / named[1] if named[1] else 0.0
            if ratio > 1e-9:
                units["conflict"] = True
                units["note"] = (f"调用方给了 {caller_unit}（{factor} m/单位），文件里是 "
                                 f"{named[0]}（{named[1]} m/单位）：按调用方单位换算，并在此记录冲突。")
                warnings.append("CAD_UNIT_CONFLICT: 调用方单位与文件 $INSUNITS 不一致，"
                                "已按调用方换算并标注 units.source=\"caller\"。")
            else:
                units["note"] = f"调用方单位与文件 $INSUNITS 一致（{named[0]}）。"
        else:
            units["note"] = (f"文件单位未知，使用调用方显式提供的 {name}（{factor} m/单位）；"
                             "原始 $INSUNITS 保留在 units.insunits。")
    return units, warnings


def bounds_of(entities, fast: bool):
    """用 ezdxf.bbox 求真实几何边界；失败时如实返回 None 并说明。"""
    from ezdxf import bbox
    try:
        box = bbox.extents(entities, fast=fast)
    except Exception as error:  # bbox 对个别实体/字体问题会抛，边界缺失不能连累整份报告
        return None, f"bbox 计算失败：{type(error).__name__}: {error}"
    if not box.has_data:
        return None, "没有可求边界的实体（bounds 为空）"
    return {"min": vec(box.extmin), "max": vec(box.extmax)}, None


def bounds_entities(msp) -> tuple[list, Counter]:
    """参与 bounds 的实体 = 建模子集；返回 (实体列表, 被排除的类型计数)。

    这条过滤是**必须**的：unsupported 里明确写着"未参与 bounds"，就不能把整个模型空间
    原样递给 bbox 让结论靠巧合成立（XLINE/代理实体在 ezdxf 里 bbox 为空，换一种实体就未必）。
    """
    included, excluded = [], Counter()
    for entity in msp:
        dxftype = entity.dxftype()
        if dxftype in MODELED_TYPES:
            included.append(entity)
        else:
            excluded[dxftype] += 1
    return included, excluded


def scale_bounds(bounds, factor):
    """同一份 min/max 换到米制；尺寸只由 size_of 算一次（两处各算一次会差最后一位）。"""
    if bounds is None or factor is None:
        return None
    lo, hi = bounds["min"], bounds["max"]
    return {
        "min": [r(lo[i] * factor) for i in range(3)],
        "max": [r(hi[i] * factor) for i in range(3)],
    }


def size_of(bounds):
    if bounds is None:
        return None
    lo, hi = bounds["min"], bounds["max"]
    return [r(hi[i] - lo[i]) for i in range(3)]


def collect_layers(doc, entity_counter: Counter, max_items: int) -> tuple[list, bool]:
    layers, truncated = [], False
    for layer in doc.layers:
        if len(layers) >= max_items:
            truncated = True
            break
        dxf = layer.dxf
        try:
            true_color = layer.rgb
            true_color = [r(true_color[0]), r(true_color[1]), r(true_color[2])] if true_color is not None else None
        except Exception:
            true_color = None
        off, frozen, locked = bool(layer.is_off()), bool(layer.is_frozen()), bool(layer.is_locked())
        layers.append({
            "name": dxf.name,
            "color": r(dxf.get("color", None)),
            "trueColor": true_color,
            "linetype": dxf.get("linetype", None),
            "lineweight": r(dxf.get("lineweight", None)),
            "off": off,
            "frozen": frozen,
            "locked": locked,
            "visible": not (off or frozen),
            "entityCount": entity_counter.get(dxf.name, 0),
        })
    return layers, truncated


def collect_layer_bounds(msp, layers, fast):
    """逐图层边界（ENV-14 的"开口"折算用）：只对**建模子集**求，与全局 bounds 同一口径、同一次解析。

    **每一层都出一行**（空图层也出：`entityCount:0` + `bounds:null`）——空层不能整行消失，
    否则报告里连"这一层没有可折算几何"都看不到（下游只能靠猜）。算不出边界就 `bounds:null`（不填 0、不猜）。
    另给每一条建模实体**自身**的二维尺寸 `sizes` 与最小角 `origins`（图面单位）：下游据此**逐实体**折算开口
    ——层内改门宽、或**层内平移**（尺寸不变、层包围盒也不变）都能被点名，同层多处开口不会被合并成一条。
    `sizesTruncated` 为真表示 `sizes` 只列了前 `MAX_ENTITY_SIZES_PER_LAYER` 条（`entityCount` 仍是全量）。
    """
    rows = []
    for layer in layers:
        name = layer["name"]
        subset = [entity for entity in msp if entity.dxftype() in MODELED_TYPES and entity.dxf.layer == name]
        box, error = bounds_of(subset, fast=fast) if subset else (None, None)
        sizes, origins = [], []
        for entity in subset[:MAX_ENTITY_SIZES_PER_LAYER]:
            item, _ignored = bounds_of([entity], fast=fast)
            if item is None:
                continue
            lo, hi = item["min"], item["max"]
            sizes.append([r(hi[0] - lo[0]), r(hi[1] - lo[1])])
            origins.append([r(lo[0]), r(lo[1])])
        rows.append({"layer": name, "entityCount": len(subset), "bounds": box, "error": error,
                     "sizes": sizes, "origins": origins,
                     "sizesTruncated": len(subset) > MAX_ENTITY_SIZES_PER_LAYER})
    return rows


def extrusion_of(entity):
    """非 (0,0,1) 的挤出方向才返回：它是 OCS 与 WCS 不同的唯一原因，报出来才能说明坐标空间。"""
    value = entity.dxf.get("extrusion", None)
    if value is None:
        return None
    v = vec(value)
    if v is None or (abs(v[0]) < 1e-12 and abs(v[1]) < 1e-12 and abs(v[2] - 1.0) < 1e-12):
        return None
    return v


def cap_points(points, item_of):
    """按 MAX_POINTS_PER_CURVE 截断一条曲线的点列；返回 (列表, 总数)。"""
    total = len(points)
    listed = [item_of(point) for point in points[:MAX_POINTS_PER_CURVE]]
    return listed, total


def curve_params(entity) -> tuple[dict, bool | None]:
    """按类型取**真实几何参数**；返回 (参数字典, 是否闭合)。闭合语义按类型而定，未知给 None。"""
    dxftype = entity.dxftype()
    dxf = entity.dxf
    if dxftype == "LINE":
        return {"start": vec(dxf.start), "end": vec(dxf.end)}, None
    if dxftype == "LWPOLYLINE":
        raw = [tuple(point) for point in entity.get_points("xyseb")]
        def vertex(point):
            item = {"x": r(point[0]), "y": r(point[1])}
            if abs(point[4]) > 1e-12:
                item["bulge"] = r(point[4])
            if abs(point[2]) > 1e-12:
                item["startWidth"] = r(point[2])
            if abs(point[3]) > 1e-12:
                item["endWidth"] = r(point[3])
            return item
        vertices, total = cap_points(raw, vertex)
        return {"vertexCount": total, "elevation": r(dxf.get("elevation", 0.0)),
                "vertices": vertices, "verticesListed": len(vertices)}, bool(entity.closed)
    if dxftype == "POLYLINE":
        points = list(entity.points())
        bulges = [r(vertex.dxf.get("bulge", 0.0)) for vertex in entity.vertices]
        def vertex_at(index):
            point = points[index]
            item = {"x": r(point[0]), "y": r(point[1])}
            if index < len(bulges) and bulges[index] and abs(bulges[index]) > 1e-12:
                item["bulge"] = bulges[index]
            if len(point) > 2 and abs(point[2]) > 1e-12:
                item["z"] = r(point[2])
            return item
        vertices = [vertex_at(index) for index in range(min(len(points), MAX_POINTS_PER_CURVE))]
        if entity.is_2d_polyline:
            kind = "2d"
        elif entity.is_poly_face_mesh:
            kind = "polyface-mesh"
        elif entity.is_polygon_mesh:
            kind = "polygon-mesh"
        else:
            kind = "3d"
        return {"vertexCount": len(points), "vertices": vertices, "verticesListed": len(vertices),
                "polylineType": kind,
                "elevation": r(dxf.get("elevation", (0, 0, 0))[2]) if entity.is_2d_polyline else None}, bool(entity.is_closed)
    if dxftype == "CIRCLE":
        return {"center": vec(dxf.center), "radius": r(dxf.radius)}, True
    if dxftype == "ARC":
        return {"center": vec(dxf.center), "radius": r(dxf.radius),
                "startAngle": r(dxf.start_angle), "endAngle": r(dxf.end_angle)}, False
    if dxftype == "ELLIPSE":
        start = float(dxf.start_param)
        end = float(dxf.end_param)
        is_full = abs(start) < 1e-12 and abs(abs(end) - math.tau) < 1e-9
        major = dxf.major_axis
        return {"center": vec(dxf.center), "majorAxis": vec(major),
                "majorAxisLength": r(math.sqrt(sum(float(component) ** 2 for component in major))),
                "ratio": r(dxf.ratio), "startParam": r(start), "endParam": r(end),
                "paramsInRadians": True}, is_full
    if dxftype == "SPLINE":
        control = list(entity.control_points)
        fit = list(entity.fit_points)
        control_listed, control_total = cap_points(control, vec)
        fit_listed, fit_total = cap_points(fit, vec)
        # 节点向量与权重是**重建原样条的必要参数**：只给计数等于让下游自己猜一条曲线。
        # 与顶点/控制点同一套限额：给全量计数 + 截断后的数值列（截断事实由 CAD_CURVE_POINTS_TRUNCATED 声明）。
        knots = [r(value) for value in entity.knots]
        weights = [r(value) for value in entity.weights]
        return {"degree": int(dxf.degree), "controlPointCount": control_total,
                "controlPoints": control_listed, "fitPointCount": fit_total,
                "fitPoints": fit_listed,
                "knotCount": len(knots), "knots": knots[:MAX_POINTS_PER_CURVE],
                "weightCount": len(weights), "weights": weights[:MAX_POINTS_PER_CURVE]}, bool(entity.closed)
    return {}, None


def curve_record(entity, space: str, block: str | None) -> dict:
    """一条曲线的记录：身份 + 坐标空间 + 单位 + 真实参数。"""
    dxftype = entity.dxftype()
    params, closed = curve_params(entity)
    # 坐标空间逐条如实声明（错了就等于给下游假坐标）：
    #  · LINE / SPLINE / ELLIPSE 与 3D POLYLINE（含网格）的存储坐标是 WCS；
    #  · LWPOLYLINE / CIRCLE / ARC / 2D POLYLINE 是 OCS（另有 extrusion），2D POLYLINE 的 elevation 另存。
    # 依据：ezdxf Polyline.points() 文档 "points of 2D polylines are OCS coordinates,
    # other polyline types return WCS coordinates" 与各实体的 DXFAttr 定义。
    if dxftype in ("LINE", "SPLINE", "ELLIPSE"):
        coordinates = "wcs"
    elif dxftype == "POLYLINE":
        coordinates = "ocs" if entity.is_2d_polyline else "wcs"
    else:
        coordinates = "ocs"
    record = {
        "space": space,
        "block": block,
        "type": dxftype,
        "layer": getattr(entity.dxf, "layer", "0"),
        "handle": getattr(entity.dxf, "handle", None),
        "coordinates": coordinates,
        "units": "drawing-unit",
        "closed": closed,
    }
    extrusion = extrusion_of(entity)
    if extrusion is not None:
        record["extrusion"] = extrusion
    record.update(params)
    return record


def collect_curves(spaces, max_items: int) -> tuple[list, dict, bool]:
    """模型空间 + 用户块的曲线，共用一份 --max-items 预算（模型空间在前）。

    spaces: [(space_kind, block_name, entities)]，space_kind ∈ {"modelspace", "block"}。
    返回 (曲线列表, 每个空间的曲线全量计数, 是否截断)。
    """
    curves, truncated = [], False
    totals: dict = {}
    for space, block, entities in spaces:
        key = "modelspace" if space == "modelspace" else f"block:{block}"
        count = 0
        for entity in entities:
            if entity.dxftype() not in CURVE_TYPES:
                continue
            count += 1
            if len(curves) < max_items:
                curves.append(curve_record(entity, space, block))
            else:
                truncated = True
        totals[key] = count
    return curves, totals, truncated


def collect_geometry(msp, block_curves: list, max_items: int) -> tuple[dict, Counter, dict]:
    """模型空间实体普查（按类型/图层计数，全量）+ 曲线明细（模型空间与用户块共用预算）。"""
    counts: Counter = Counter()
    layer_counts: Counter = Counter()
    open_curves = 0
    for entity in msp:
        dxftype = entity.dxftype()
        counts[dxftype] += 1
        layer_counts[getattr(entity.dxf, "layer", "0")] += 1
        if dxftype in CURVE_TYPES:
            _, closed = curve_params(entity)
            if closed is False:
                open_curves += 1
    spaces = [("modelspace", None, list(msp))] + block_curves
    curves, curve_totals, curves_truncated = collect_curves(spaces, max_items)
    return {
        "entityCounts": dict(sorted(counts.items())),
        "layers": [{"layer": name, "entityCount": count} for name, count in sorted(layer_counts.items())],
        "curves": curves,
        "curveCount": curve_totals.get("modelspace", 0),
        "curvesBySpace": curve_totals,
        "openCurveCount": open_curves,
        "note": "曲线只给参数（端点/顶点和 bulge/圆心半径/角度/参数区间/**SPLINE 的 knots 与 weights**），"
                "不做离散与求交；SPLINE 的 controlPointCount/knotCount/weightCount 是全量计数，"
                "对应的数值列超过单条曲线上限时被截断（见 warnings 的 CAD_CURVE_POINTS_TRUNCATED）；"
                "weights 为空表示文件里**确实没有**权重（非有理样条，权重均为 1），不是「没读出来」；"
                "coordinates=ocs 的实体（LWPOLYLINE/POLYLINE(2d)/CIRCLE/ARC 等）若要换算到世界坐标，"
                "看该条的 extrusion（缺省 =(0,0,1) 时 OCS 与 WCS 相同）；单位是图纸单位，"
                "米制换算用 units.metresPerUnit（单位未知时为 null）；"
                "openCurveCount 只数**明确开口**的曲线（closed=false）——LINE 这类没有闭合概念的类型"
                "closed=null，既不算开口也不算闭合；curveCount 只数模型空间，块内条数看 curvesBySpace。",
    }, counts, {"curves": curves_truncated}


def insert_placements(doc, msp):
    """全部块引用的**位置来源**：模型空间在前，然后是各非布局块定义内部的嵌套 INSERT。

    计数（reference_counts / nested_by_container）与明细（references）都走这一条，
    两边不可能算出不同的 population：只列模型空间的引用会让 nestedReferenceCount 与
    references 对不上，下游也没法沿父链把块内几何放回世界坐标。
    布局块（*Model_Space/*Paper_Space）与图纸空间不在内：它们是容器，不是被引用的块。
    """
    for entity in msp.query("INSERT"):
        yield "modelspace", None, entity
    for block in doc.blocks:
        if block.name.lower().startswith(("*model_space", "*paper_space")):
            continue
        for entity in block:
            if entity.dxftype() == "INSERT":
                yield "block", block.name, entity


def collect_blocks(doc, msp, max_items: int) -> tuple[dict, dict, list]:
    """块定义 + 块引用。

    **两趟**：先把"模型空间 + 所有块定义内部"的引用全部数完，再投影出每个定义的记录。
    一趟边数边写会让**较早定义**的块漏掉后面定义里对它的嵌套引用（计数随定义顺序变小）。
    definitionCount 是全部非布局块的数量（不受 --max-items 截断），definitions 只是明细。
    """
    layout_blocks = []
    blocks_all = []
    # 第一趟：把所有引用数完（模型空间 + 每个块定义内部的嵌套 INSERT），得到完整的计数表。
    reference_counts: Counter = Counter()
    nested_by_container: Counter = Counter()
    for _space, parent, entity in insert_placements(doc, msp):
        reference_counts[entity.dxf.name] += 1
        if parent is not None:
            nested_by_container[parent] += 1
    for block in doc.blocks:
        if block.name.lower().startswith(("*model_space", "*paper_space")):
            layout_blocks.append(block.name)
            continue
        blocks_all.append(block)
    # 第二趟：用**数完后的**计数表投影每个定义——若边数边写，先定义的块会漏掉
    # 后面定义里对它的嵌套引用（计数随定义顺序变小，实测过）。
    definitions_all = []
    for block in blocks_all:
        name = block.name
        flags = int(block.block.dxf.get("flags", 0))
        inner = Counter(entity.dxftype() for entity in block)
        definitions_all.append({
            "name": name,
            "kind": "anonymous" if flags & 1 else ("xref" if flags & 4 else "user"),
            "basePoint": vec(block.block.dxf.base_point),
            "entityCount": len(block),
            "entityTypes": dict(sorted(inner.items())),
            "referenceCount": reference_counts.get(name, 0),
            "nestedReferenceCount": nested_by_container.get(name, 0),
            "block": block,
        })
    definitions, definitions_truncated = [], False
    user_blocks = []
    for definition in definitions_all:
        block = definition.pop("block")
        if definition["kind"] == "user":
            user_blocks.append(("block", definition["name"], list(block)))
        if len(definitions) < max_items:
            definitions.append(definition)
        else:
            definitions_truncated = True
    references, references_truncated = [], False
    for space, parent, entity in insert_placements(doc, msp):
        if len(references) >= max_items:
            references_truncated = True
            break
        dxf = entity.dxf
        try:
            matrix = entity.matrix44()
            transform = [[r(matrix.get_row(row)[col]) for col in range(4)] for row in range(4)]
        except Exception:
            transform = None
        xscale, yscale, zscale = (float(dxf.get("xscale", 1.0)), float(dxf.get("yscale", 1.0)),
                                  float(dxf.get("zscale", 1.0)))
        references.append({
            "block": dxf.name,
            "space": space,
            "parentBlock": parent,
            "layer": dxf.get("layer", "0"),
            "handle": getattr(dxf, "handle", None),
            "insert": vec(dxf.insert),
            "rotationDeg": r(dxf.get("rotation", 0.0)),
            "scale": [r(xscale), r(yscale), r(zscale)],
            # 等比要**三轴**两两相比：只比 x/y 会把 z 轴拉伸（x=y≠z）当成等比，下游按等比还原就错了。
            "uniformScale": bool(abs(xscale - yscale) < 1e-12 and abs(yscale - zscale) < 1e-12),
            "columns": int(dxf.get("column_count", 1)),
            "rows": int(dxf.get("row_count", 1)),
            "columnSpacing": r(dxf.get("column_spacing", 0.0)),
            "rowSpacing": r(dxf.get("row_spacing", 0.0)),
            "attributes": [attr.dxf.tag for attr in entity.attribs],
            "transform": transform,
        })
    return {
        "definitions": definitions,
        "layoutBlocks": layout_blocks,
        "references": references,
        "definitionCount": len(definitions_all),
        "definitionsListed": len(definitions),
        "referenceCount": sum(reference_counts.values()),
        "modelspaceReferenceCount": len(msp.query("INSERT")),
        "nestedReferenceCount": sum(nested_by_container.values()),
        "anonymousDefinitionCount": sum(1 for item in definitions_all if item["kind"] == "anonymous"),
        "transformOrder": "4x4 行主序，平移在最后一行（ezdxf Matrix44 约定）；按 v' = v·M 右乘（v=(x,y,z,1)）",
        "note": "referenceCount 统计**所有**引用（模型空间 + 块定义内部的嵌套引用），与定义顺序无关；"
                "references 覆盖同一批引用（截断只影响列出条数，计数与 definitions 一样不受影响）："
                "space=modelspace 的引用 parentBlock 为 null，space=block 的引用 parentBlock 是宿主块名。"
                "块内几何见 geometry.curves 中 block=<名字> 的条目（只列用户块），放回世界坐标要**沿引用链**变换："
                "先乘该块自己的引用（block=<名字>、parentBlock=宿主块），再乘宿主块的那条，直到 parentBlock=null 的模型空间引用；"
                "矩阵行主序、平移在最后一行，用 v' = v·M（v=(x,y,z,1)）依次右乘。本函数只给链路，不展开全场几何。",
    }, {"definitions": definitions_truncated, "references": references_truncated}, user_blocks


def collect_dimensions(msp, max_items: int) -> tuple[list, bool]:
    dimensions, truncated = [], False
    for dim in msp.query("DIMENSION"):
        if len(dimensions) >= max_items:
            truncated = True
            break
        dxf = dim.dxf
        dimtype = int(dxf.get("dimtype", 0))
        base_type = dimtype & 0x0F
        try:
            measured = dim.get_measurement()
        except Exception:  # 个别标注（缺几何/无匿名块）读不出测量值
            measured = None
        measurement, measurement_point = None, None
        if isinstance(measured, (int, float)):
            measurement = r(measured)
        elif measured is not None:
            # ordinate（类型 6）的"测量值"是一个点（特征位置），不是长度：分开报，别硬塞进 measurement。
            measurement_point = vec(measured)
        text = dxf.get("text", None)
        override = None if text in (None, "", "<>") else text
        dimensions.append({
            "layer": dxf.get("layer", "0"),
            "handle": getattr(dxf, "handle", None),
            "dimtype": dimtype,
            "dimTypeName": DIM_TYPE_NAMES.get(base_type, f"unknown({base_type})"),
            "flags": {
                "blockReference": bool(dimtype & DIM_BIT_BLOCK_REFERENCE),
                "ordinateAxis": (("x" if dimtype & DIM_BIT_ORDINATE_TYPE else "y")
                                 if base_type == DIM_ORDINATE_TYPE else None),
                "textUserPositioned": bool(dimtype & DIM_BIT_TEXT_USER_POSITION),
            },
            "measurement": measurement,
            "measurementPoint": measurement_point,
            "measurementUnit": ("degree" if base_type in DIM_ANGULAR_TYPES
                                else (None if base_type == DIM_ORDINATE_TYPE or measurement is None
                                      else "drawing-unit")),
            "text": text,
            "textOverride": override,
            "defPoint": vec(dxf.get("defpoint", None)),
            "textMidpoint": vec(dxf.get("text_midpoint", None)),
            "dimstyle": dxf.get("dimstyle", None),
        })
    return dimensions, truncated


def collect_unsupported(spaces, factory) -> tuple[list, int]:
    """未知/不支持实体：模型空间与块定义内部都扫，按 (类型, 分类) 分桶并记空间。

    既包括 ezdxf 认得但本解析器不建模的类型，也包括连 ezdxf 都不认识的类型。
    这些实体**不参与** bounds（bounds_entities 只放行 MODELED_TYPES）。
    """
    buckets: dict[tuple[str, str], dict] = {}
    total = 0
    for space, block, entities in spaces:
        label = "modelspace" if space == "modelspace" else f"block:{block}"
        for entity in entities:
            dxftype = entity.dxftype()
            if dxftype in MODELED_TYPES:
                continue
            if dxftype in UNMODELED_REASONS:
                reason = UNMODELED_REASONS[dxftype]
                kind = "recognized-not-modeled"
            elif dxftype in getattr(factory, "ENTITY_CLASSES", {}):
                reason = "ezdxf 认识该类型，但不在本解析器的建模子集里；几何未参与 bounds"
                kind = "recognized-not-modeled"
            else:
                reason = "未知实体类型（ezdxf 也不认识）；几何未参与 bounds"
                kind = "unknown"
            key = (dxftype, kind)
            bucket = buckets.setdefault(key, {"type": dxftype, "kind": kind, "reason": reason,
                                              "count": 0, "layers": [], "spaces": []})
            bucket["count"] += 1
            total += 1
            layer = getattr(entity.dxf, "layer", "0")
            if layer not in bucket["layers"] and len(bucket["layers"]) < 20:
                bucket["layers"].append(layer)
            if label not in bucket["spaces"] and len(bucket["spaces"]) < 20:
                bucket["spaces"].append(label)
    return sorted(buckets.values(), key=lambda item: (-item["count"], item["type"])), total


def build_report(doc, path: str, file_facts: dict, caller_unit: str | None,
                 max_items: int, exact_bounds: bool) -> tuple[dict, list[str]]:
    from ezdxf.entities import factory

    msp = doc.modelspace()
    psp = doc.layout("Layout1") if "Layout1" in doc.layout_names() else None
    units, warnings = resolve_units(doc, caller_unit)
    blocks, blocks_truncated, user_blocks = collect_blocks(doc, msp, max_items)
    geometry, counts, geom_truncated = collect_geometry(msp, user_blocks, max_items)
    dimensions, dims_truncated = collect_dimensions(msp, max_items)
    unsupported, unsupported_total = collect_unsupported(
        [("modelspace", None, list(msp))] + user_blocks, factory)

    included, excluded = bounds_entities(msp)
    bounds, bounds_error = bounds_of(included, fast=not exact_bounds)
    if bounds_error:
        warnings.append(f"CAD_BOUNDS_UNAVAILABLE: {bounds_error}")
    exttmin, extmin_present = header_value(doc, "$EXTMIN")
    extmax, extmax_present = header_value(doc, "$EXTMAX")
    header_extents = None
    if extmin_present and extmax_present and not is_sentinel(exttmin) and not is_sentinel(extmax):
        header_extents = {"min": vec(exttmin), "max": vec(extmax)}
    if unsupported_total:
        warnings.append(f"CAD_UNSUPPORTED_ENTITIES: {unsupported_total} 个实体不在建模子集里，"
                        "未参与 bounds（明细见 unsupported）。")
    # 单条曲线点数被截断（不是条数截断）：单独告警，别混进 CAD_LIST_TRUNCATED 的语义里。
    curve_points_truncated = [curve for curve in geometry["curves"]
                              if curve.get("vertexCount", 0) > curve.get("verticesListed", 0)
                              or curve.get("controlPointCount", 0) > len(curve.get("controlPoints") or [])
                              or curve.get("fitPointCount", 0) > len(curve.get("fitPoints") or [])
                              or curve.get("knotCount", 0) > len(curve.get("knots") or [])
                              or curve.get("weightCount", 0) > len(curve.get("weights") or [])]
    if curve_points_truncated:
        warnings.append(f"CAD_CURVE_POINTS_TRUNCATED: {len(curve_points_truncated)} 条曲线的点列被截到 "
                        f"{MAX_POINTS_PER_CURVE} 个点（总数在各条的 *Count 字段里）。")
    if bounds is None:
        warnings.append("CAD_BOUNDS_EMPTY: 模型空间没有可求边界的几何。")

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)

    factor = units["metresPerUnit"]
    report = {
        "ok": True,
        "scriptVersion": SCRIPT_VERSION,
        "source": {"engine": "ezdxf", "engineVersion": _ezdxf_version(), "interpreter": sys.executable,
                   "interpreterVersion": sys.version.split()[0]},
        "file": {
            "path": os.path.abspath(path),
            "name": file_facts["name"],
            "bytes": file_facts["bytes"],
            "sha256": digest.hexdigest(),
        },
        "format": {
            "kind": "dxf",
            "aciVersion": doc.dxfversion,
            "release": doc.acad_release,
            "encoding": doc.encoding,
            "binary": bool(file_facts.get("binary", False)),
        },
        "units": units,
        "bounds": {
            "mode": "exact" if exact_bounds else "fast",
            "drawingUnits": bounds,
            "sizeDrawingUnits": size_of(bounds),
            "metres": scale_bounds(bounds, factor),
            "sizeMetres": size_of(scale_bounds(bounds, factor)),
            "headerDeclared": header_extents,
            "entityTypes": sorted({entity.dxftype() for entity in included}),
            "entitiesConsidered": len(included),
            "excludedEntityCount": int(sum(excluded.values())),
            "excludedEntityTypes": dict(sorted(excluded.items())),
            "note": "边界只由建模子集实体决定（entityTypes 列出实际参与的类型，excludedEntityTypes 列出"
                    "被排除的类型与个数）；TEXT/MTEXT/DIMENSION/HATCH 及 INSERT 内部的块内容按 ezdxf 的"
                    "bbox 规则参与，unsupported 里的实体一律不参与。",
        },
        "layers": [],
        "blocks": blocks,
        "geometry": geometry,
        "dimensions": dimensions,
        "unsupported": unsupported,
        "unsupportedEntityCount": unsupported_total,
        "counts": {
            "modelspaceEntities": len(msp),
            "paperspaceEntities": len(psp) if psp is not None else 0,
            "layers": len(doc.layers),
            "blocks": len(doc.blocks),
            "blockDefinitions": blocks["definitionCount"],
            "blockReferences": blocks["referenceCount"],
            "curves": geometry["curveCount"],
            "dimensions": len(msp.query("DIMENSION")),
        },
        "warnings": warnings,
        "truncated": {
            "maxItems": max_items,
            "maxPointsPerCurve": MAX_POINTS_PER_CURVE,
            "lists": {**geom_truncated, **blocks_truncated, "dimensions": dims_truncated},
        },
    }
    layers, layers_truncated = collect_layers(doc, Counter(
        {item["layer"]: item["entityCount"] for item in geometry["layers"]}), max_items)
    report["layers"] = layers
    # 逐图层边界（只对建模子集，与全局 bounds 同口径）：ENV-14 的"开口"由下游按图层名 + 跨度折算，
    # 这里只给真实几何事实，不在解析器里判定"哪个图层是门"。
    report["layerBounds"] = collect_layer_bounds(msp, layers, not exact_bounds)
    report["truncated"]["lists"]["layers"] = layers_truncated
    if layers_truncated or any(report["truncated"]["lists"].values()):
        warnings.append(f"CAD_LIST_TRUNCATED: 明细列表按 --max-items={max_items} 截断，计数仍是全量。")
    return report, warnings


def _ezdxf_version() -> str:
    try:
        import ezdxf
        return ezdxf.__version__
    except Exception:
        return "unknown"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="读取 DXF 并输出结构化事实（ezdxf）")
    parser.add_argument("--input", required=True, help="DXF 文件路径（ASCII 或 Binary DXF）")
    parser.add_argument("--unit", default=None,
                        help="调用方显式指定图纸单位（文件未声明或需要覆盖时）：m/mm/cm/dm/km/in/ft/yd/um/nm/mil")
    parser.add_argument("--max-items", type=int, default=500,
                        help="每个明细列表的上限（计数不受限）；单条曲线的点数上限见 MAX_POINTS_PER_CURVE")
    parser.add_argument("--exact-bounds", action="store_true", help="用精确 bbox（慢，大图不建议）")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    if args.max_items < 1:
        return fail("CAD_ARGUMENT_INVALID", "--max-items 必须 >= 1")
    caller_unit = None
    if args.unit is not None:
        caller_unit = args.unit.strip().lower()
        if caller_unit not in CALLER_UNITS:
            return fail("CAD_UNIT_UNSUPPORTED",
                        f"--unit 不支持 {args.unit!r}；可用：{', '.join(sorted(CALLER_UNITS))}")
    path = os.path.expanduser(args.input)
    file_facts, status = preflight(path)
    if file_facts is None:
        return status

    try:
        import ezdxf
    except ImportError as error:
        return fail("CAD_EZDXF_MISSING",
                    f"解释器 {sys.executable} 里没有 ezdxf（{error}）。"
                    "请用离线缓存在独立 venv 里安装：uv venv --offline … && uv pip install --offline ezdxf==1.4.4，"
                    "并把该解释器路径配给 cad 工具（config.python 或 LYAPUNOV_CAD_PYTHON）。",
                    interpreter=sys.executable)
    try:
        doc = ezdxf.readfile(path)
    except Exception as error:
        detail = str(error) or "无附加信息"
        hint = ("二进制 DXF 的文件头不完整或结构损坏" if file_facts.get("binary")
                else "文件可能被截断、不是 DXF，或者版本不受支持")
        return fail("CAD_PARSE_FAILED",
                    f"ezdxf 无法读取这个 DXF（{type(error).__name__}）：{detail}；{hint}",
                    path=path, interpreter=sys.executable, ezdxfVersion=getattr(ezdxf, "__version__", None),
                    binary=bool(file_facts.get("binary", False)))
    try:
        report, warnings = build_report(doc, path, file_facts, caller_unit, args.max_items, args.exact_bounds)
    except Exception as error:  # 预期之外的解析异常：如实报错，别用半份报告冒充成功
        import traceback
        traceback.print_exc(file=sys.stderr)
        return fail("CAD_REPORT_FAILED",
                    f"读取成功但生成报告时失败：{type(error).__name__}: {error}",
                    path=path, interpreter=sys.executable)
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
        print(f"cad_inspect 未预期失败: {type(fatal).__name__}: {fatal}", file=sys.stderr)
        raise SystemExit(EXIT_INTERNAL)
