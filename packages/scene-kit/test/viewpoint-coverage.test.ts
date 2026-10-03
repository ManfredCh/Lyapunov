/**
 * ENV-06（N311）：照片**视角覆盖表**必须由真实机位如实推导，且"数量多"不得冒充"覆盖全"。
 *
 * 背景：照片族此前只有参考图的 object/viewpoint 文本注解，没有"哪张照片覆盖了对象的哪个方位、缺口在哪"
 * 的结构化承载 ⇒ 覆盖表按 `(object, 视角键)` 聚合（视角名或**方位桶**去重），缺失视角逐条报出；
 * 没有照片、或全部记录都没有可用机位/视角名 ⇒ **明确报 insufficient**，不返回空表冒充"没有缺口"。
 * 边界：本文件不联网、不起宿主；检索与真机回执在回执 Round 5 段里贴原文。
 */
import { describe, expect, test } from "bun:test"
import { photoCapturedAtFactsOf, photoCropFactsOf, photoOcclusionFactsOf, VIEWPOINT_AZIMUTH_BUCKET_DEG, viewpointCoverageOf, viewpointOfCamera } from "../src/reference-tools.ts"

describe("ENV-06 照片视角覆盖表（viewpointCoverageOf）", () => {
  test("多张真实机位 ⇒ 方位/仰角由 positionM 如实推导，缺口按请求逐条报出", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall", photoId: "a", worldFromCamera: { positionM: [0, 0, 3] } },      // 正前方 az≈0
      { object: "wall", photoId: "b", worldFromCamera: { positionM: [3, 0, 0] } },      // 右侧 az≈90
      { object: "wall", photoId: "c", worldFromCamera: { positionM: [0, 3, 0] } },      // 上方 el≈90
    ], ["front", "right", "top", "back"])
    expect(coverage.insufficient).toBeUndefined()
    const wall = coverage.objects.find(row => row.object === "wall")!
    expect(wall.azimuthsDeg).toEqual([0, 90])
    expect(wall.elevationsDeg).toEqual([0, 90])
    expect(wall.covered).toEqual(["az0/el0", "az90/el0", "az0/el90"])
    // 请求里只有视角名（front/right…）与推导出的桶键不同名 ⇒ 全部报缺（名字对不上就是缺，不猜同义）
    expect(wall.missing).toEqual(["front", "right", "top", "back"])
  })

  test("负对照：同一方位重复多张 ⇒ 仍报『缺』（数量多不等于覆盖全）", () => {
    const repeated = Array.from({ length: 6 }, (_, index) => ({ object: "wall", photoId: `dup-${String(index)}`, worldFromCamera: { positionM: [0, 0, 3] } }))
    const coverage = viewpointCoverageOf([...repeated, { object: "wall", photoId: "back", worldFromCamera: { positionM: [0, 0, -3] } }], ["az0/el0", "az180/el0", "az90/el0"])
    const wall = coverage.objects.find(row => row.object === "wall")!
    expect(wall.covered.length).toBe(2)          // 同一桶只算一次
    expect(wall.azimuthsDeg).toEqual([0, 180])
    expect(wall.missing).toEqual(["az90/el0"])   // 六张同方位照片补不上第三个方位
  })

  test("负对照：无照片 ⇒ insufficient=NO_PHOTOS（明确失败，不返回空表）", () => {
    const coverage = viewpointCoverageOf([], ["front"])
    expect(coverage.objects).toEqual([])
    expect(coverage.insufficient).toContain("NO_PHOTOS")
  })

  test("负对照：有记录但没有机位也没有视角名 ⇒ insufficient=NO_BASELINE，并计入 unusable", () => {
    const coverage = viewpointCoverageOf([{ object: "wall", photoId: "x" }, { object: "wall", photoId: "y", viewpoint: "  " }], ["front"])
    expect(coverage.insufficient).toContain("NO_BASELINE")
    expect(coverage.objects).toEqual([])
  })

  test("视角名优先于方位桶；不可用记录计入 unusable 但不污染已覆盖集合", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall", viewpoint: "Front", worldFromCamera: { positionM: [0, 0, 3] } },
      { object: "wall", photoId: "junk" },
    ], ["front", "back"])
    const wall = coverage.objects.find(row => row.object === "wall")!
    expect(wall.covered).toEqual(["front"])
    expect(wall.missing).toEqual(["back"])
    expect(wall.unusable).toBe(1)
  })

  test("方位桶常量与换算口径（+Z 为 0°、绕 Y 右手为正、仰角以水平面为 0°）", () => {
    expect(VIEWPOINT_AZIMUTH_BUCKET_DEG).toBe(45)
    expect(viewpointOfCamera([0, 0, 2]).azimuthDeg).toBe(0)
    expect(viewpointOfCamera([2, 0, 0]).azimuthDeg).toBe(90)
    expect(viewpointOfCamera([0, 2, 0]).elevationDeg).toBe(90)
    expect(viewpointOfCamera([0, 0, 0]).azimuthDeg).toBe(0)
  })
})

describe("ENV-06 R2：遮挡 / 裁切事实（photoOcclusionFactsOf / photoCropFactsOf）", () => {
  test("遮挡：真实深度跳变超过阈值 ⇒ 如实推导为被遮挡；明确低于阈值 ⇒ 不得报成遮挡（负对照 a）", () => {
    const occluded = photoOcclusionFactsOf({ object: "wall", photoId: "a", depthJump: { maxAbsJumpM: 0.1387, thresholdM: 0.1365 } })
    expect(occluded.occluded).toBe(true)
    expect(occluded.derived).toBe(true)
    expect(occluded.reason).toContain("0.1387")
    const notOccluded = photoOcclusionFactsOf({ object: "wall", photoId: "b", depthJump: { maxAbsJumpM: 0.0569, thresholdM: 0.1362 } })
    expect(notOccluded.occluded).toBe(false)
    expect(notOccluded.derived).toBe(true)
    // 没有任何证据 ⇒ 不声称被遮挡，且 derived:false
    const unknown = photoOcclusionFactsOf({ object: "wall", photoId: "c" })
    expect(unknown.occluded).toBe(false)
    expect(unknown.derived).toBe(false)
    expect(unknown.reason).toContain("未给遮挡证据")
  })

  test("遮挡：标了 occluded:true 却不给 reason ⇒ 明确失败（不静默接受）", () => {
    expect(() => photoOcclusionFactsOf({ object: "wall", occlusion: { occluded: true } })).toThrow("PHOTO_OCCLUSION_REASON_REQUIRED")
    expect(photoOcclusionFactsOf({ object: "wall", occlusion: { occluded: true, reason: "前景立柱挡住墙面下半" } }).occluded).toBe(true)
  })

  test("裁切：imageSize==frameSize ⇒ 推导整帧（derived:true）；有裁切但缺偏移 ⇒ 不编造矩形", () => {
    const full = photoCropFactsOf({ object: "wall", imageSize: { width: 320, height: 240 }, frameSize: { width: 320, height: 240 } })
    expect(full).toEqual({ kind: "full", rect: [0, 0, 320, 240], derived: true, note: expect.stringContaining("整帧未裁切") })
    const cropped = photoCropFactsOf({ object: "wall", imageSize: { width: 160, height: 120 }, frameSize: { width: 320, height: 240 } })
    expect(cropped.derived).toBe(false)
    expect(cropped.rect).toBeUndefined()
    expect(cropped.note).toContain("缺偏移")
  })

  test("负对照 b：非法裁切矩形（越界 / 负宽）⇒ 必须明确失败", () => {
    expect(() => photoCropFactsOf({ object: "wall", photoId: "oob", imageSize: { width: 320, height: 240 }, crop: { kind: "cropBox", rect: [300, 200, 50, 50] } })).toThrow("PHOTO_CROP_RECT_INVALID")
    expect(() => photoCropFactsOf({ object: "wall", photoId: "neg", crop: { kind: "userRect", rect: [10, 10, -5, 20] } })).toThrow("PHOTO_CROP_RECT_INVALID")
    expect(() => photoCropFactsOf({ object: "wall", photoId: "bad-kind", crop: { kind: "weird" as never } })).toThrow("PHOTO_CROP_KIND_INVALID")
  })

  test("覆盖表回执带上逐照片的遮挡/裁切事实（photos[]）", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall", photoId: "a", viewpoint: "front", imageSize: { width: 320, height: 240 }, frameSize: { width: 320, height: 240 }, depthJump: { maxAbsJumpM: 0.2, thresholdM: 0.1365 } },
      { object: "wall", photoId: "b", viewpoint: "right", depthJump: { maxAbsJumpM: 0.01, thresholdM: 0.1362 } },
    ], ["front", "back"])
    expect(coverage.photos.map(p => [p.photoId, p.occlusion.occluded, p.crop.kind])).toEqual([["a", true, "full"], ["b", false, "full"]])
    expect(coverage.objects[0]!.missing).toEqual(["back"])
  })
})

describe("ENV-06 R3：时间（capturedAt）在证据面上原样回显 / 未提供就说未提供", () => {
  test("记录给了时间 ⇒ 原样回显（含时区/毫秒都不改写）+ note 说明来源", () => {
    const facts = photoCapturedAtFactsOf({ object: "wall", photoId: "a", capturedAt: "2026-09-22T06:39:00.123Z" })
    expect(facts.capturedAt).toBe("2026-09-22T06:39:00.123Z")
    expect(facts.capturedAtNote).toContain("原样回显")
  })

  test("负对照：不带时间 / 空白串 ⇒ 明确『未提供』，且**不出现**任何时间值（不臆造）", () => {
    for (const entry of [{ object: "wall", photoId: "b" }, { object: "wall", photoId: "c", capturedAt: "   " }]) {
      const facts = photoCapturedAtFactsOf(entry)
      expect("capturedAt" in facts).toBe(false)
      expect(facts.capturedAtNote).toContain("未提供")
      expect(facts.capturedAtNote).toContain("不做 EXIF 推断")
    }
  })

  test("覆盖表 photos[] 逐条带上时间事实", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall", photoId: "a", viewpoint: "front", capturedAt: "2026-09-22T06:39:00Z" },
      { object: "wall", photoId: "b", viewpoint: "right" },
    ], [])
    const byId = new Map(coverage.photos.map(p => [p.photoId, p]))
    expect(byId.get("a")!.capturedAt).toBe("2026-09-22T06:39:00Z")
    expect("capturedAt" in byId.get("b")!).toBe(false)
    expect(byId.get("b")!.capturedAtNote).toContain("未提供")
  })
})

describe("ENV-06 R4：事实校验不得被『算不出视角键』静默绕过（复核方推翻 R232 的两条之一）", () => {
  // 修前 `photos[]` 另算一次 key 且漏掉 `azimuthDeg`/`elevationDeg` ⇒ 只有方位角的记录 key===undefined 被整条 filter 掉，
  // `photoCapturedAtFactsOf`/`photoOcclusionFactsOf`/`photoCropFactsOf` **一次都没执行**（非法输入全部 200 通过）。
  test("回归①：只有 azimuthDeg/elevationDeg（无视角名、无机位）⇒ photos[] 非空，键与覆盖表一致", () => {
    const coverage = viewpointCoverageOf(
      [{ object: "wall-az", photoId: "az-1", azimuthDeg: 90, elevationDeg: 10, imageSize: { width: 320, height: 240 }, frameSize: { width: 320, height: 240 } }],
      ["az90/el0", "az180/el0"],
    )
    expect(coverage.insufficient).toBeUndefined()
    expect(coverage.photos.map(p => [p.photoId, p.viewpoint])).toEqual([["az-1", "az90/el0"]])
    expect(coverage.photos[0]!.crop).toEqual({ kind: "full", rect: [0, 0, 320, 240], derived: true, note: expect.stringContaining("整帧未裁切") })
    expect(coverage.objects[0]!.covered).toEqual(["az90/el0"])
    expect(coverage.objects[0]!.missing).toEqual(["az180/el0"])
  })

  test("回归①b：worldFromCamera 形态的 photos[] 键同样来自唯一那份推导（不再另算）", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-pos", photoId: "pos-1", worldFromCamera: { positionM: [3, 0, 0] } }], [])
    expect(coverage.photos.map(p => p.viewpoint)).toEqual(["az90/el0"])
    expect(coverage.objects[0]!.covered).toEqual(["az90/el0"])
  })

  test("回归②：azimuthDeg 形态下 occluded:true 却不给 reason ⇒ 必须明确失败（修前 200 通过）", () => {
    expect(() => viewpointCoverageOf([{ object: "wall-az", photoId: "occ-1", azimuthDeg: 0, occlusion: { occluded: true } }], [])).toThrow("PHOTO_OCCLUSION_REASON_REQUIRED")
  })

  test("回归③：azimuthDeg 形态下的非法裁切矩形（越界/负宽/非四数）⇒ 必须明确失败（修前三次全 200）", () => {
    for (const rect of [[300, 100, 100, 100], [10, 10, -5, 20], [10, 10, 20]]) {
      expect(() => viewpointCoverageOf([{ object: "wall-az", photoId: "crop-bad", azimuthDeg: 0, imageSize: { width: 320, height: 240 }, crop: { kind: "cropBox", rect } }], [])).toThrow("PHOTO_CROP_RECT_INVALID")
    }
  })

  test("回归④：capturedAt 空白 ⇒ 无时间值、note 写未提供，且**仍出现在 photos[]** 里（修前整条被丢出）", () => {
    for (const capturedAt of ["", "   "]) {
      const coverage = viewpointCoverageOf([{ object: "wall-az", photoId: "time-1", azimuthDeg: 0, capturedAt }], [])
      expect(coverage.photos.length).toBe(1)
      expect(coverage.photos[0]!.viewpoint).toBe("az0/el0")
      expect("capturedAt" in coverage.photos[0]!).toBe(false)
      expect(coverage.photos[0]!.capturedAtNote).toContain("未提供")
    }
  })

  test("负对照：连『算不出视角键』的记录也必须先校验事实 ⇒ 非法 crop 仍抛错（修前落到 NO_BASELINE，不校验）", () => {
    expect(() => viewpointCoverageOf([{ object: "wall-az", photoId: "no-vp", crop: { kind: "userRect", rect: [10, 10, -5, 20] } }], [])).toThrow("PHOTO_CROP_RECT_INVALID")
  })

  test("不可用记录仍计入 unusable；photos[] 只放有视角键的记录（先校验、后过滤）", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall-mix", photoId: "ok", azimuthDeg: 0 },
      { object: "wall-mix", photoId: "junk" },
    ], [])
    expect(coverage.photos.map(p => p.photoId)).toEqual(["ok"])
    expect(coverage.objects[0]!.unusable).toBe(1)
  })
})

describe("ENV-06 R5：命名视角与显式方位冲突 / 空 object 计数 / cropBox 缺 rect 措辞（第三条独立复核的三处新问题）", () => {
  test("回归⑤：视角名 `az90/el0` 与显式 `azimuthDeg:270,elevationDeg:-30` 冲突 ⇒ 必须明确失败（修前 200 且同一回执自相矛盾）", () => {
    expect(() => viewpointCoverageOf([{ object: "wall-conflict", photoId: "c1", viewpoint: "az90/el0", azimuthDeg: 270, elevationDeg: -30 }], ["az90/el0", "az270/el-30"])).toThrow("PHOTO_VIEWPOINT_CONFLICT")
  })

  test("回归⑤b：名字不编码角度（front）⇒ 不冲突；名字与数值一致（az270/el-30）⇒ 不冲突", () => {
    const named = viewpointCoverageOf([{ object: "wall", photoId: "n1", viewpoint: "front", azimuthDeg: 270 }], [])
    expect(named.objects[0]!.covered).toEqual(["front"])
    expect(named.objects[0]!.azimuthsDeg).toEqual([270])
    const consistent = viewpointCoverageOf([{ object: "wall", photoId: "n2", viewpoint: "az270/el-30", azimuthDeg: 270, elevationDeg: -30 }], ["az270/el-30"])
    expect(consistent.objects[0]!.covered).toEqual(["az270/el-30"])
    expect(consistent.objects[0]!.missing).toEqual([])
  })

  test("回归⑥：混排（有效 + 无 object + 空白 object + 无 pose）⇒ 被丢弃的桶计数以 `unattributed` 如实报出（修前整桶消失）", () => {
    const coverage = viewpointCoverageOf([
      { object: "wall-mix", photoId: "ok", azimuthDeg: 0 },
      { object: "", photoId: "no-obj-1", azimuthDeg: 90 },
      { object: "   ", photoId: "blank-obj", azimuthDeg: 180 },
      { object: "wall-mix", photoId: "no-pose" },
    ], ["az0/el0"])
    expect(coverage.unattributed).toBe(2)                                  // 两条没有 object 的记录
    expect(coverage.objects.map(row => [row.object, row.unusable])).toEqual([["wall-mix", 1]])
    expect(coverage.photos.map(p => p.photoId)).toEqual(["ok"])
  })

  test("回归⑥b：没有照片 ⇒ unattributed=0（形状稳定，不因新增字段改变失败分支）", () => {
    const coverage = viewpointCoverageOf([], ["front"])
    expect(coverage.unattributed).toBe(0)
    expect(coverage.insufficient).toContain("NO_PHOTOS")
  })

  test("回归⑦：`crop.kind` 给了但**缺 rect** ⇒ 不编造矩形，且 note 不得声称校验过越界（修前写『已按图像尺寸校验越界』）", () => {
    const facts = photoCropFactsOf({ object: "wall-crop", photoId: "kind-only", crop: { kind: "cropBox" } })
    expect(facts).toEqual({ kind: "cropBox", derived: false, note: expect.stringContaining("没给 rect") })
    expect("rect" in facts).toBe(false)
    expect(facts.note).not.toContain("已按图像尺寸校验")
  })

  test("回归⑦b：给了矩形但没给 imageSize ⇒ 不得声称校验过；矩形+imageSize ⇒ 才写已核对", () => {
    const noSize = photoCropFactsOf({ object: "wall-crop", photoId: "rect-only", crop: { kind: "userRect", rect: [10, 10, 20, 20] } })
    expect(noSize.note).toContain("未做越界校验")
    expect(noSize.rect).toEqual([10, 10, 20, 20])
    const checked = photoCropFactsOf({ object: "wall-crop", photoId: "rect-size", imageSize: { width: 320, height: 240 }, crop: { kind: "cropBox", rect: [10, 10, 20, 20] } })
    expect(checked.note).toContain("都已核对")
  })
})

describe("ENV-06 R6：等价角不得误判冲突 / 越界必须独立错误码（第四条独立复核的两条新缺口）", () => {
  test("回归⑧：`az0/el0` + `azimuthDeg:360` ⇒ 同一角度，不报冲突（修前 400 PHOTO_VIEWPOINT_CONFLICT）", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-eq", photoId: "q1", viewpoint: "az0/el0", azimuthDeg: 360, elevationDeg: 0 }], ["az0/el0"])
    expect(coverage.objects[0]!.covered).toEqual(["az0/el0"])
    expect(coverage.objects[0]!.missing).toEqual([])
  })

  test("回归⑧b：`az-30/el0` + `azimuthDeg:330` ⇒ 同一角度，不报冲突", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-eq2", photoId: "q6", viewpoint: "az-30/el0", azimuthDeg: 330, elevationDeg: 0 }], ["az-30/el0"])
    expect(coverage.objects[0]!.covered).toEqual(["az-30/el0"])
  })

  test("回归⑧c：不带视角名时方位按模 360 归一 ⇒ `-30` 与 `330` 得到同一个键（修前 az-45 vs az315）", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-neg", photoId: "a", azimuthDeg: -30 }, { object: "wall-neg", photoId: "b", azimuthDeg: 330 }], [])
    expect(coverage.photos.map(p => p.viewpoint)).toEqual(["az315/el0", "az315/el0"])
    expect(coverage.objects[0]!.covered).toEqual(["az315/el0"])   // 同一个键只算一次
    expect(coverage.objects[0]!.azimuthsDeg).toEqual([-30, 330])  // 原始读数照旧回显
  })

  test("回归⑧d：名字与数值只差一个桶内偏移（az10/el0 + 10）⇒ 不误伤", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-bucket", photoId: "c", viewpoint: "az10/el0", azimuthDeg: 10 }], [])
    expect(coverage.objects[0]!.covered).toEqual(["az10/el0"])
  })

  test("回归⑨：仰角越界用**独立错误码**，不与冲突码混用", () => {
    for (const entry of [
      { object: "wall-range2", photoId: "q2b", viewpoint: "az10/el95", azimuthDeg: 10, elevationDeg: 95 },
      { object: "wall-range", photoId: "q2", viewpoint: "az10/el95", elevationDeg: 95 },
      { object: "wall-range3", photoId: "q2c", elevationDeg: -95 },
      { object: "wall-range4", photoId: "q2d", viewpoint: "az10/el95" },
    ]) {
      expect(() => viewpointCoverageOf([entry], [])).toThrow("PHOTO_VIEWPOINT_OUT_OF_RANGE")
      let message = ""
      try { viewpointCoverageOf([entry], []) } catch (error) { message = String((error as Error).message) }
      expect(message).not.toContain("PHOTO_VIEWPOINT_CONFLICT")
    }
  })

  test("回归⑩：真冲突仍是冲突码；`front` 这类不编码角度的名字仍不误伤", () => {
    expect(() => viewpointCoverageOf([{ object: "wall-conflict", photoId: "q3", viewpoint: "az90/el0", azimuthDeg: 270, elevationDeg: -30 }], [])).toThrow("PHOTO_VIEWPOINT_CONFLICT")
    const coverage = viewpointCoverageOf([{ object: "wall-front", photoId: "q4", viewpoint: "front", azimuthDeg: 270 }], ["front"])
    expect(coverage.objects[0]!.covered).toEqual(["front"])
    expect(coverage.objects[0]!.azimuthsDeg).toEqual([270])
  })
})

describe("ENV-06 R7：`missing` 只放可读字符串（对象请求不得变成 `[object Object]`）", () => {
  test("回归⑪：请求项是对象 ⇒ `missing` 里是 `objectId@viewpoint` / `object@name`，**不含** `[object Object]`（修前是 `[object Object]`）", () => {
    const coverage = viewpointCoverageOf([{ object: "wall-r7", photoId: "d1", azimuthDeg: 0 }], [{ objectId: "wall-r7", viewpoint: "top" }, { object: "wall-r7", name: "back" }])
    expect(coverage.objects[0]!.missing).toEqual(["wall-r7@top", "wall-r7@back"])
    expect(JSON.stringify(coverage)).not.toContain("[object Object]")
  })

  test("回归⑪b：对象只给一个字段 ⇒ 用那个字段；字符串请求照旧", () => {
    expect(viewpointCoverageOf([{ object: "wall", azimuthDeg: 0 }], [{ viewpoint: "top" }]).objects[0]!.missing).toEqual(["top"])
    expect(viewpointCoverageOf([{ object: "wall", azimuthDeg: 0 }], [{ objectId: "wall" }]).objects[0]!.missing).toEqual(["wall"])
    expect(viewpointCoverageOf([{ object: "wall", azimuthDeg: 0 }], ["top", "  back  "]).objects[0]!.missing).toEqual(["top", "back"])
  })

  test("回归⑪c：既不是字符串也取不出字段 ⇒ 明确失败，不得静默产出不可读标签", () => {
    for (const bad of [{}, { foo: 1 }, 42, null, ["top"]]) {
      expect(() => viewpointCoverageOf([{ object: "wall", azimuthDeg: 0 }], [bad])).toThrow("PHOTO_VIEWPOINT_REQUEST_INVALID")
    }
  })
})
