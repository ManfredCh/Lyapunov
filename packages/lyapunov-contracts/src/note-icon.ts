/**
 * P14：用户已确认的 Note 图标几何（工具栏入口与场景批注标记**共用同一份**）。
 *
 * 为什么放在 contracts：同一段 24×24 viewBox 路径要同时喂给
 *  · `lyapunov-shell` 的 vendor 图标（React SVG，fill:none + stroke:currentColor，宽 1.65）；
 *  · `viewer` 的 Scene Sprite 贴图（canvas Path2D 填充 + 1.1 单位外描边）；
 *  · `viewer` 的截图 PNG 叠加（同一 canvas Path2D）。
 * 任一处各抄一份字符串，先漂移再变形；几何只在这里定义一次，纯常量、无 React/THREE 依赖。
 *
 * 形状：从 (12,3.5) 起，半径 8.5 的大圆弧转到 (12,20.5)，水平线到 (5,20.5)，
 * 1 单位圆角后竖直向上到 (4,12.5)，再以 8.5 半径圆弧回到起点；尾部落在左下。
 * 锚点取 (5,20.5)：尾部水平底边与圆角相接处，也正是标记要压住实体锚点的那一点。
 */
export const NOTE_ICON_VIEWBOX = 24

/** 用户 2026-10-16 确认稿的单一路径（原样，不得改动）。 */
export const NOTE_ICON_PATH = "M12 3.5a8.5 8.5 0 1 1 0 17H5a1 1 0 0 1-1-1v-7A8.5 8.5 0 0 1 12 3.5Z"

/** 尾部落点（viewBox 24 单位）。贴图绘制与 Sprite 中心都用它换算，不再取横向中心/长杆底端。 */
export const NOTE_ICON_ANCHOR_X = 5
export const NOTE_ICON_ANCHOR_Y = 20.5

/** 锚点的 viewBox 归一化位置（x 右为正、y 下为正）。 */
export const NOTE_ICON_ANCHOR_RATIO_X = NOTE_ICON_ANCHOR_X / NOTE_ICON_VIEWBOX
export const NOTE_ICON_ANCHOR_RATIO_Y = NOTE_ICON_ANCHOR_Y / NOTE_ICON_VIEWBOX

/** 工具栏单线图标：fill none + currentColor，宽 1.65（与选中按钮底色配合，实际 16px）。 */
export const NOTE_ICON_TOOLBAR_STROKE_WIDTH = 1.65

/** 场景标记：填充色 + 1.1 个 viewBox 单位的外描边；默认/选中两套，深浅背景都读得出。 */
export const NOTE_ICON_MARKER_FILL = "#f2f4f7"
export const NOTE_ICON_MARKER_FILL_SELECTED = "#78a9ff"
export const NOTE_ICON_MARKER_STROKE = "#10151d"
export const NOTE_ICON_MARKER_STROKE_SELECTED = "#15213a"
export const NOTE_ICON_MARKER_STROKE_WIDTH = 1.1
