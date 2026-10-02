/**
 * DEV-025 成因分类的定向测试：把"格式不支持 / 解码器缺失 / 依赖缺失 / 配准或轴向 / 正常"分开。
 *
 * 这里证明的是**判据**（哪一类成因、稳定码叫什么、异常文本怎么归类），不证明画面里真的画出来了——
 * 真实 splat 的像素判定由 headless Chrome + PIL 的 Viewer 验收覆盖（`.runtime/lane-dev025/`）。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from 'typescript'
import {
  assessSplatDecoded, assessSplatFailure, assessSplatInput, splatExtensionOf, splatWarningCode, SPLAT_FILE_TYPE_NAMES,
} from "../src/splat-support.ts"

/** 源守卫按实际构造参数判定；冷/缓存两条路径必须显式启用LOD，空白和注释不能代签。 */
function assertSplatLodConstruction(source:string):void {
 const file=ts.createSourceFile('viewer.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 const viewer=file.statements.find((node):node is ts.ClassDeclaration=>ts.isClassDeclaration(node)&&node.name?.text==='SceneViewer')
 const load=viewer?.members.find((node):node is ts.MethodDeclaration=>ts.isMethodDeclaration(node)&&node.name.getText(file)==='loadVisual')
 if(!load?.body)throw Error('SPLAT_LOAD_VISUAL_MISSING')
 const meshes:ts.ObjectLiteralExpression[]=[];let selector=false
 const visit=(node:ts.Node)=>{
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='initializationLod'&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(file)==='splatInitializationLod'&&node.initializer.arguments.length===1&&node.initializer.arguments[0]!.getText(file)==='sourcePoints')selector=true
  if(ts.isNewExpression(node)&&node.expression.getText(file)==='SplatMesh'){
   const input=node.arguments?.[0]
   if(!input||!ts.isObjectLiteralExpression(input)||input.properties.some(ts.isSpreadAssignment))throw Error('SPLAT_CONSTRUCTION_PARAMETERS_MISSING')
   meshes.push(input)
  }
  ts.forEachChild(node,visit)
 }
 visit(load.body)
 if(!selector)throw Error('SPLAT_LOD_SELECTOR_MISSING')
 if(meshes.length!==2)throw Error('SPLAT_COLD_AND_RETAINED_CONSTRUCTORS_MISSING')
 const value=(object:ts.ObjectLiteralExpression,name:string)=>{
  const property=object.properties.find(node=>(ts.isPropertyAssignment(node)||ts.isShorthandPropertyAssignment(node))&&node.name.getText(file)===name)
  return property&&ts.isPropertyAssignment(property)?property.initializer:property&&ts.isShorthandPropertyAssignment(property)?property.name:undefined
 }
 if(meshes.some(object=>value(object,'enableLod')?.kind!==ts.SyntaxKind.TrueKeyword))throw Error('SPLAT_LOD_DISABLED')
 const cold=meshes.filter(object=>value(object,'url')),retained=meshes.filter(object=>value(object,'packedSplats'))
 if(cold.length!==1||retained.length!==1)throw Error('SPLAT_COLD_AND_RETAINED_CONSTRUCTORS_MISSING')
 if(value(cold[0]!,'lod')?.getText(file)!=='initializationLod')throw Error('SPLAT_LOD_SELECTION_MISSING')
}

describe("splat 输入侧成因分类", () => {
  test("扩展名解析：大小写无关、无扩展名给空串（不猜）", () => {
    expect(splatExtensionOf("Luxury-Suite.SPZ")).toBe("spz")
    expect(splatExtensionOf("tearoom.splat")).toBe("splat")
    expect(splatExtensionOf("no-extension")).toBe("")
    expect(splatExtensionOf("trailing.")).toBe("")
  })

  test("认识的扩展名 + 依赖可用 ⇒ ok（只是可尝试，不等于已出图）", () => {
    const assessed = assessSplatInput("luxury-suite.spz", { dependencyAvailable: true })
    expect(assessed.supported).toBe(true)
    expect(assessed.cause).toBe("ok")
    expect(assessed.fileTypeName).toBe("SPZ")
    expect(Object.keys(SPLAT_FILE_TYPE_NAMES).sort()).toEqual(["ksplat", "ply", "rad", "sog", "splat", "spz"])
  })

  test("负对照①：不认识的扩展名 ⇒ unsupported-format（明确说不在支持表里）", () => {
    const assessed = assessSplatInput("scan.xyz", { dependencyAvailable: true })
    expect(assessed.supported).toBe(false)
    expect(assessed.cause).toBe("unsupported-format")
    expect(assessed.detail).toContain(".xyz")
    expect(assessed.detail).toContain(".spz")
  })

  test("负对照②：依赖被移除 ⇒ dependency-missing（点名 @sparkjsdev/spark，不退化成通用失败）", () => {
    const assessed = assessSplatInput("luxury-suite.spz", { dependencyAvailable: false })
    expect(assessed.supported).toBe(false)
    expect(assessed.cause).toBe("dependency-missing")
    expect(assessed.detail).toContain("@sparkjsdev/spark")
    expect(assessed.detail).toContain("SPZ")
  })
})

describe("解码失败的成因归类", () => {
  test("模块/依赖不可用 ⇒ dependency-missing", () => {
    for (const text of ["Error: Cannot find module '@sparkjsdev/spark'", "TypeError: SplatMesh is not a function", "ERR_MODULE_NOT_FOUND"]) {
      expect(assessSplatFailure(new Error(text), { extension: "spz", dependencyAvailable: true }).cause).toBe("dependency-missing")
    }
  })

  test("取不到资源（404/网络/文件不在）⇒ dependency-missing", () => {
    for (const text of ["404 Not Found", "Failed to fetch", "ENOENT: no such file or directory"]) {
      expect(assessSplatFailure(new Error(text), { extension: "spz", dependencyAvailable: true }).cause).toBe("dependency-missing")
    }
  })

  test("负对照③：损坏/截断/坏魔数 ⇒ unsupported-format（并保留原文）", () => {
    for (const text of ["unexpected end of file", "bad magic 0x00000000", "Invalid header", "gunzip: invalid data"]) {
      const classified = assessSplatFailure(new Error(text), { extension: "spz", dependencyAvailable: true })
      expect(classified.cause).toBe("unsupported-format")
      expect(classified.detail).toContain("spz")
      expect(classified.detail.length).toBeGreaterThan(10)
    }
  })

  test("依赖在但异常说模块不可用 ⇒ 仍归 dependency-missing（不因调用方声明而掩盖）", () => {
    const classified = assessSplatFailure(new Error("Cannot find module './spark-wasm'"), { extension: "splat", dependencyAvailable: true })
    expect(classified.cause).toBe("dependency-missing")
  })
})

describe("解码成功后的成因归类", () => {
  test("0 个高斯点 ⇒ decoder-missing（该格式没有真正可用的解码分支）", () => {
    expect(assessSplatDecoded({ numSplats: 0, bounds: { min: [0, 0, 0], max: [0, 0, 0] } }).cause).toBe("decoder-missing")
  })

  test("包围盒非有限 / 三轴退化 ⇒ registration-or-axis（配准或轴向问题）", () => {
    expect(assessSplatDecoded({ numSplats: 10, bounds: { min: [Number.NaN, 0, 0], max: [1, 1, 1] } }).cause).toBe("registration-or-axis")
    expect(assessSplatDecoded({ numSplats: 10, bounds: { min: [5, 5, 5], max: [5, 5, 5] } }).cause).toBe("registration-or-axis")
    expect(assessSplatDecoded({ numSplats: 10, bounds: null }).cause).toBe("registration-or-axis")
  })

  test("正常解码 ⇒ ok 且给出三轴尺寸（m）", () => {
    const decoded = assessSplatDecoded({ numSplats: 220000, bounds: { min: [-20.912, -11.411, -5.638], max: [9.289, 1.9, 18.449] } })
    expect(decoded.cause).toBe("ok")
    expect(decoded.detail).toContain("30.201")
    expect(decoded.detail).toContain("×")
    const viewerSource = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8")
    // 大文件采用tiny、小/未知场景保留quality；实际分流在splat-runtime回归核验。
    expect(viewerSource).toContain("splatInitializationLod(sourcePoints)")
    expect(()=>assertSplatLodConstruction(viewerSource)).not.toThrow()
    expect(()=>assertSplatLodConstruction(viewerSource.replace(/enableLod:\s*true/g,'enableLod:false'))).toThrow('SPLAT_LOD_DISABLED')
    expect(()=>assertSplatLodConstruction(viewerSource.replace(/lod:\s*initializationLod/g,'lod:false'))).toThrow('SPLAT_LOD_SELECTION_MISSING')
    expect(()=>assertSplatLodConstruction(viewerSource.replace('splatInitializationLod(sourcePoints)','false'))).toThrow('SPLAT_LOD_SELECTOR_MISSING')
    expect(viewerSource).toContain("renderFrameMs")
  })
})

describe("稳定码", () => {
  test("成因 → 警告码一一对应（回执里逐字用这几个词）", () => {
    expect(splatWarningCode("ok")).toBe("VIEWER_SPLAT_OK")
    expect(splatWarningCode("unsupported-format")).toBe("VIEWER_SPLAT_UNSUPPORTED_FORMAT")
    expect(splatWarningCode("decoder-missing")).toBe("VIEWER_SPLAT_DECODER_MISSING")
    expect(splatWarningCode("dependency-missing")).toBe("VIEWER_SPLAT_DEPENDENCY_MISSING")
    expect(splatWarningCode("registration-or-axis")).toBe("VIEWER_SPLAT_REGISTRATION_OR_AXIS")
  })
})
