/**
 * P14：Note 图标来源回归（工具栏 SVG 与 SOURCE.json 自绘元数据）。
 *
 * 判据：
 *  · `WorkbenchIcon id="annotation"` 真渲染出用户确认稿的单一路径，stroke-width 1.65、round 端点/连接，
 *    不再内联原 Tabler message-2 的两道文字线；
 *  · 该枚 `data-icon-library` 标为 lyapunov（自绘），其余 Tabler 图标的来路与许可不动；
 *  · SOURCE.json 的 annotation 来源元数据是自绘（path 与共享常量一致、pathSha256 对得上），
 *    并从 icons 映射里退出 message-2；
 *  · viewer 的批注标记路径与 shell 工具栏消费的是同一份共享常量。
 * 离线：只渲染静态标记与读本包源码/元数据，不连模型/引擎/网络。
 */
import {describe,expect,test} from "bun:test"
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import {createElement} from "react"
import {renderToStaticMarkup} from "react-dom/server"
import {NOTE_ICON_PATH,NOTE_ICON_TOOLBAR_STROKE_WIDTH} from "../../lyapunov-contracts/src/note-icon.ts"
import {ANNOTATION_MARKER_PATH} from "../../viewer/src/annotations.ts"
import {WorkbenchIcon} from "../src/vendor/tabler/icons.tsx"

const render=(id:"annotation"|"scene")=>renderToStaticMarkup(createElement(WorkbenchIcon,{id} as never) as never)

describe("P14 Note 图标来源",()=>{
 test("工具栏 annotation 渲染确认稿单一路径，不再内联 message-2 文字线",()=>{
  const html=render("annotation")
  expect(NOTE_ICON_TOOLBAR_STROKE_WIDTH).toBe(1.65)
  expect(html).toContain(`d="${NOTE_ICON_PATH}"`)
  expect(html).toContain('stroke-width="1.65"')
  expect(html).toContain('fill="none"')
  expect(html).toContain('stroke="currentColor"')
  expect(html).toContain('stroke-linecap="round"')
  expect(html).toContain('stroke-linejoin="round"')
  // 原内部两道文字线（Tabler message-2 的 d）已删除，且只剩唯一一条 path。
  expect(html).not.toContain("M8 9h8")
  expect(html).not.toContain("M8 13h6")
  expect((html.match(/<path/g)??[]).length).toBe(1)
 })

 test("annotation 标为 Lyapunov 自绘，其余 Tabler 图标线宽与来路不变",()=>{
  const annotation=render("annotation")
  expect(annotation).toContain('data-icon="annotation"')
  expect(annotation).toContain('data-icon-library="lyapunov"')
  const scene=render("scene")
  expect(scene).toContain('data-icon-library="tabler"')
  expect(scene).toContain('stroke-width="1.7"')
  expect(scene).toContain('d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5"')
 })

 test("SOURCE.json 的 annotation 是自绘元数据，path/pathSha256 与确认常量一致",()=>{
  const source=JSON.parse(readFileSync(new URL("../src/vendor/tabler/SOURCE.json",import.meta.url),"utf8"))
  expect(source.icons.annotation).toBe("lyapunov-note")
  expect(source.icons.annotation).not.toBe("message-2")
  const entry=source.iconSources.annotation
  expect(entry.path).toBe(NOTE_ICON_PATH)
  expect(entry.pathSha256).toBe(createHash("sha256").update(NOTE_ICON_PATH).digest("hex"))
  // 确认稿 note.svg 的整文件 sha256（approval.json 记录），本批输入未变。
  expect(entry.sha256).toBe("ccdc9ef2399b84aaa49524cd1a16c5ab5fd2d7cb2c93acdec10fcce264271013")
  expect(entry.origin).toContain("自绘")
  expect(entry.origin).toContain("非 Tabler")
  expect(entry.marker).toContain("#f2f4f7")
  expect(entry.marker).toContain("#78a9ff")
  // 其余 Tabler 来源条目仍带官方 https url（本批不动其余图标与许可）。
  for(const id of ["robot","engine","capture","recording","physics"])expect(source.iconSources[id].url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/tabler\/tabler-icons\//)
  expect(source.exceptions).toContain("annotation")
 })

 test("viewer 批注标记消费同一份共享路径（工具栏/贴图/PNG 不漂移）",()=>{
  expect(ANNOTATION_MARKER_PATH).toBe(NOTE_ICON_PATH)
  const viewer=readFileSync(new URL("../../viewer/src/annotations.ts",import.meta.url),"utf8")
  expect(viewer).toContain("ANNOTATION_MARKER_PATH = NOTE_ICON_PATH")
  // 旧几何常量已彻底退场，避免测试或实现再引用旧尾杆。
  expect(viewer).not.toContain("ANNOTATION_MARKER_HEAD")
  expect(viewer).not.toContain("ANNOTATION_MARKER_TAIL")
 })
})
