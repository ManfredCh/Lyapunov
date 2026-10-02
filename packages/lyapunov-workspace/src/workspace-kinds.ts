/**
 * 原生工作区标签的 **kind / id 常量**（唯一一份）。
 *
 * 为什么要单独一个纯模块：`ui_action` 的 `openResource` 由 shell 的 `Workbench` 派发，
 * 而"HTML 源码"是工作区包注册的**具名 kind**（它故意不参与自动排名，只能点名打开）。
 * shell 与工作区包必须用同一个字符串；抄一份迟早漂移成"点了名却打不开"。
 * 本文件不 import 任何组件或 node 能力，客户端/服务端都能安全 import。
 */
/** HTML 源码编辑器的具名 kind（`patterns` 故意不匹配任何文件地址，只能点名打开）。 */
export const HTML_EDITOR_KIND = "lyapunov.editor.html"
/** HTML 源码编辑器标签 id。 */
export const HTML_EDITOR_ID = "@lyapunov/workspace/html-source"
/** 普通文本编辑器 kind。 */
export const EDITOR_KIND = "lyapunov.editor"
/** 模型预览标签 kind。 */
export const MODEL_KIND = "lyapunov.model"
