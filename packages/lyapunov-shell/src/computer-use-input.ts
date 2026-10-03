/**
 * computer-use 合成输入的**作用域、全局快捷键拒绝清单、桌面设置快照/恢复**（W22）。
 *
 * 为什么有这个模块（用户投诉原文：「你每次都会打开辅助屏幕阅览器,然后扬声器一直念，
 * 你打算让其他客户端的用户也听你的声音吗?」）：
 *
 *   Lead 在本机复现的因果链（真凭实据，不是推测）——
 *     `xdotool key --clearmodifiers Super+Alt+s` → 合成按键进**用户的活动桌面会话**
 *     （`DISPLAY=:1`，X11）→ 事件在 WM 之前被 GNOME **全局快捷键** `Super+Alt+S` 捕获
 *     → `org.gnome.desktop.a11y.applications screen-reader-enabled` 由 `false` 变 `true`
 *     → Orca 开始朗读；而 `always-show-universal-access-status=false`，用户**看不到任何指示**。
 *
 * 放大伤害的三个条件，本模块逐个封掉：
 *   1. **作用域**：合成输入必须指名 agent 自己的窗口（驱动契约里的 `target` / `window_id` / `pid`）。
 *      没有目标 ＝ 会落到**用户的活动会话全局层**——那是一条需要**显式同意 + 可见指示**的降级路径，
 *      不是默认路径（`planComputerUseInput`）。
 *   2. **拒绝清单**：凡会被桌面/WM 全局捕获的组合（`Super+*`、`Ctrl+Alt+*`、媒体键、
 *      `Super+Alt+S` 屏幕阅读器、放大镜、粘滞键、输入法切换…）**一律不合成**，
 *      给稳定错误码 + 为什么 + 用户侧怎么自己做（`GLOBAL_SHORTCUT_RULES`）。
 *   3. **快照与恢复**：会话开始前快照 a11y/输入法/键盘布局/无障碍状态图标，
 *      结束**无条件恢复**（含异常退出路径）；快照不可读也要留"我检查过这些键"的记录。
 *
 * 还有第 4 件（可见指示）：a11y 功能开着时 `always-show-universal-access-status` 不得为 false，
 * 且会话期间必须给用户一条看得见的"agent 正在控制输入"的提示（系统通知 + 宿主状态投影）。
 *
 * 第 5 件（残留通道，W22-R）：`move_cursor` 是**合成输入**（驱动契约 `MoveCursorInput` 带 `target?`），
 * 与 `click` 走同一条路（窗口目标 ⇒ 窗口作用域；没有目标 ⇒ 全局层，需显式同意 + 可见指示）；
 * `clipboard_write` **不是**合成输入（不产生键鼠事件，契约里也没有 `target`/`scope`），
 * 但它改的是**用户的系统剪贴板**——一条跨应用、且 gsettings 九键快照**抓不到也恢复不了**的全局状态。
 * 没有可恢复路径 ⇒ 默认不发（`clipboard-not-restorable`），不做"先改了再想办法还原"的赌注。
 * 保真度与隐私论证见 `CUA_GLOBAL_STATE_TOOL_NAMES` 的注释。
 *
 * 第 6 件（残留通道的**读侧**，W22-R2）：`clipboard_read` 与写侧**同一条驱动剪贴板通道**、同样
 * 没有 `target`/`scope`、同样 `privacySensitive`；但它不改用户状态，它把**用户剪贴板里的字节读进
 * agent 上下文**——一条不可撤回的泄漏路径（用户剪贴板里可能是密码/令牌/私信）。
 * 默认拒（`clipboard-read-not-disclosable`），论证见 `CUA_PRIVACY_READ_TOOL_NAMES` 的注释。
 * ⚠️ 写侧与读侧是**两条不同的通道**，`cua_driver_native__clipboard_read` 不在写侧那张表里；
 * 它只可能出现在 `CUA_PRIVACY_READ_TOOL_NAMES`。
 *
 * 第 7 件（**判据缺了"机器状态"这一个输入**，W22-R3；登记在
 * `bugfixHistory/COMPUTER-USE-RESIDUAL-HOLES-20260926.md` §6.1 的残留口子⑤）：
 * `drag` 的裸修饰键豁免（拖动修饰键不是"单发按键"，见 `shortcutVerdictForTool`）**本身是对的**，
 * 但"按住哪个修饰键拖动＝移动/缩放窗口"**取决于这台机器**的 `mouse-button-modifier` ——
 * 本机（Ubuntu 22.04）编译期默认 `'<Super>'`，而上游 3.5.2 之前是 `'<Alt>'`、本机 Ubuntu `:Unity`
 * profile 逐字仍是 `'<Alt>'`。旧实现把"放行"**硬编码** ⇒ 换一台 `<Alt>` 的机器，
 * `drag {modifier:["alt"]}` 就是"按住 Alt 拖动指针下的窗口"而守卫照放。
 * 现在：会话快照里**只读**读一次这条键并记下来（`readDesktopMachineFacts` / `desktopMachineFacts`），
 * 判定按读数**取反**（`dragModifierMachineState` / `rule: drag-moves-user-window`），
 * 测不到就按出厂默认史 fail-closed。豁免没有被删掉：`shift`/`ctrl` 拖动照旧放行。
 *
 * 纪律（与 W4 同一条）：**记录的东西必须是实际发生的事**。这里的返回值一律是"我们真的做了什么"
 * （读了哪些键、改了哪些键、拒绝了什么、为什么），不把"设计意图"写成"已生效"。
 */
import { execFile } from "node:child_process"

/** 稳定错误码。下游按码分支，不解析人话。 */
export const COMPUTER_USE_INPUT_ERRORS = {
  /** 不是 computer-use 的输入类工具（本模块只管输入）。 */
  TOOL_UNKNOWN: "CUA_INPUT_TOOL_UNKNOWN",
  /** 没有可恢复路径的全局状态变更（`clipboard_write` 改用户的系统剪贴板）：不做"改了再想办法还原"的赌注。 */
  CLIPBOARD_WRITE_REFUSED: "CUA_CLIPBOARD_WRITE_REFUSED",
  /** 用户剪贴板是**隐私通道**（`clipboard_read` 把内容读进 agent 上下文）：读走即泄漏，agent 不读。 */
  CLIPBOARD_READ_REFUSED: "CUA_CLIPBOARD_READ_REFUSED",
  /**
   * 这个 `cua_driver_native__*` 名字**不在已分类全表**（`CUA_DRIVER_TOOL_CATALOG`）里：
   * 驱动升级/换版新增或改名的工具。表外不再等于放行（W22-R3 修的就是这条默认语义）。
   */
  DRIVER_TOOL_UNCLASSIFIED: "CUA_DRIVER_TOOL_UNCLASSIFIED",
  /** 遗留 `page` 逃生舱（`execute_javascript` 这类无界页面脚本）：驱动自己都要求操作者先开环境变量，产品侧默认不发。 */
  LEGACY_PAGE_REFUSED: "CUA_LEGACY_PAGE_REFUSED",
  /** `replay_trajectory` 走**驱动自己的派发路径**重放录制动作 ⇒ 绕开本漏斗的每一条判定（含输入作用域与拒绝清单）。 */
  TRAJECTORY_REPLAY_REFUSED: "CUA_TRAJECTORY_REPLAY_REFUSED",
  /** `escalate_session` 把会话观察面扩到**整块桌面**，而且驱动自己写着"没有 deescalate 工具"。 */
  CAPTURE_ESCALATION_REFUSED: "CUA_CAPTURE_ESCALATION_REFUSED",
  /** `install_ffmpeg` 会**真的调用系统包管理器**装包：系统状态变更，本模块没有逆操作。 */
  DEPENDENCY_INSTALL_REFUSED: "CUA_DEPENDENCY_INSTALL_REFUSED",
  /** `kill_app` 强杀用户进程（kill -9 等价）：未保存的状态直接丢，不可撤回。 */
  PROCESS_TERMINATION_REFUSED: "CUA_PROCESS_TERMINATION_REFUSED",
  /** `set_config` 改**持久**驱动配置（capture_mode / 落盘到 ~/.cua-driver/config.json）：没有原值快照，恢复不了。 */
  DRIVER_CONFIG_REFUSED: "CUA_DRIVER_CONFIG_REFUSED",
  /** `set_window_frame` 改用户窗口的几何：驱动只回读"改成了没有"，没有改前几何 ⇒ 没有可恢复路径。 */
  WINDOW_FRAME_REFUSED: "CUA_WINDOW_FRAME_REFUSED",
  /** `bring_to_front` 是驱动里那条**刻意不还原**的置前通道（它自己写"deliberately breaks the no-foreground contract"）。 */
  FOREGROUND_ACTIVATION_REFUSED: "CUA_FOREGROUND_ACTIVATION_REFUSED",
  /** `browser_download` 把网络取回的内容落到用户磁盘：驱动要求宿主破坏性批准，本宿主未验证有这条通道。 */
  BROWSER_DOWNLOAD_REFUSED: "CUA_BROWSER_DOWNLOAD_REFUSED",
  /** `browser_prepare` 会把 DevTools 端点挂到浏览器（含 `strategy.kind=existing_profile`＝用户既有 profile）。 */
  BROWSER_PREPARE_REFUSED: "CUA_BROWSER_PREPARE_REFUSED",
  /** `launch_app` 的 `name` 会被驱动**当命令直接执行**（它自己的解析顺序）⇒ 任意用户会话内执行，不可撤回。 */
  APP_LAUNCH_REFUSED: "CUA_APP_LAUNCH_REFUSED",
  /** `get_desktop_state` 抓**整块屏幕**（含用户所有窗口的像素）：那是用户的数据，读走即泄漏。 */
  DESKTOP_CAPTURE_REFUSED: "CUA_DESKTOP_CAPTURE_REFUSED",
  /** `browser_set_input_files` 把用户本机文件交给页面（可外发）：读走即泄漏，且不可撤回。 */
  LOCAL_FILE_UPLOAD_REFUSED: "CUA_LOCAL_FILE_UPLOAD_REFUSED",
  /** 全局/桌面快捷键：会被 WM/桌面 shell 在窗口之前捕获，agent 不发。 */
  GLOBAL_SHORTCUT: "CUA_GLOBAL_SHORTCUT_REFUSED",
  /** 媒体键/亮度/睡眠/WLAN 这类系统功能键。 */
  MEDIA_KEY: "CUA_MEDIA_KEY_REFUSED",
  /** 无障碍开关（屏幕阅读器/放大镜/粘滞键…）：打开后用户可能停不掉，必须由用户自己开。 */
  A11Y_TOGGLE: "CUA_A11Y_TOGGLE_REFUSED",
  /** 输入法/键盘布局切换。 */
  IME_SHORTCUT: "CUA_IME_SHORTCUT_REFUSED",
  /** 裸修饰键：单独按 Shift/Ctrl/Alt 是粘滞键/慢键的触发序列，也对当前窗口没有意义。 */
  BARE_MODIFIER: "CUA_BARE_MODIFIER_REFUSED",
  /** 没有窗口目标 ⇒ 只能走全局层，而全局层需要用户显式同意。 */
  CONSENT_REQUIRED: "CUA_GLOBAL_INPUT_CONSENT_REQUIRED",
  /** 全局层输入期间没有可见指示（用户不知道谁在控制输入）。 */
  INDICATOR_REQUIRED: "CUA_GLOBAL_INPUT_INDICATOR_REQUIRED",
  /**
   * 契约里**必填**的键字段（`PressKeyInput.key` / `HotkeyInput.keys`）取不出任何可判定的组合：
   * 字段缺失、类型不对、空串或空数组。守卫手里是"要发什么"的空白 ⇒ 一条规则都判不了 ⇒ 不发。
   */
  KEY_FIELD_UNUSABLE: "CUA_KEY_FIELD_UNUSABLE",
  /**
   * `drag` 的修饰键里含**这台机器**绑成「按住它拖动＝移动/缩放窗口」的那个修饰键
   * （`org.gnome.desktop.wm.preferences mouse-button-modifier`）：那一下拖动落到**指针下的窗口**上，
   * 守卫无法证明它一定是 agent 自己的窗口（用户投诉的同一条因果链，只是入口换成拖动）。
   */
  DRAG_WINDOW_MOVE: "CUA_DRAG_WINDOW_MOVE_REFUSED",
  /** 快照读不出来（没有 gsettings/dconf 不可写等）：如实报告，不假装"没动过"。 */
  SNAPSHOT_UNAVAILABLE: "CUA_SNAPSHOT_UNAVAILABLE",
  /** 会话开不出来（快照不可用）：没有"会话结束恢复"的依据，因此连允许的输入也不发。 */
  SESSION_UNAVAILABLE: "CUA_SESSION_UNAVAILABLE",
  /** 恢复失败：原值写不回去，用户被留在被改过的环境里。 */
  RESTORE_FAILED: "CUA_A11Y_RESTORE_FAILED",
} as const

/**
 * 被宿主级单飞串行、并且需要过作用域/拒绝清单的输入类工具（驱动的原始工具名）。
 * **唯一一份**：`plugin.ts` 从它拼 `cua_driver_native__<name>`，不再各写一遍列表。
 *
 * `move_cursor` 为什么在内（W22-R）：驱动契约逐字是
 * `MoveCursorInput { x: number; y: number; target?: ActionTarget; scope?: DesktopScope; session?: string }`
 * —— 它**能**指名窗口（`target` / 扁平 `pid`+`window_id`，本产品门用的就是扁平形状），
 * 而指针是**整块桌面上唯一的那一个**：不纳入就等于"agent 可以不指名任何窗口、不排队地移动用户的真实指针"。
 * 纳进来之后两种结果都在正确的一侧：带窗口/进程目标 ⇒ 与 `click` 同一条窗口作用域；
 * 不带 ⇒ 进全局层，需要用户显式同意 + 可见指示，否则 `CUA_GLOBAL_INPUT_CONSENT_REQUIRED`。
 * （注意 `ActionTarget` 有 `Window` 与 `Desktop` 两个变体：`Desktop` 变体**不带** `window_id`/`pid`，
 *  在 `inputSurfaceOf` 里收不出窗口事实 ⇒ 同样落到"全局层需同意"，不是被当成窗口放行。）
 *
 * **W22-R3 全表审计补进来的 10 个**（判据：**这个工具往目标应用里合成事件/动作**——即"输入"这两个字的本义，
 * 而不是"名字像不像 click"）。改前它们**既不在任何一张表里、也不经本模块**，直接从漏斗交到驱动：
 *   · `mouse_button_down` / `mouse_button_up` / `mouse_drag` / `parallel_mouse_drag`：
 *     裸指针原语（按下 / 抬起 / 拖动 / MPX 并发拖动）。`click`/`drag` 是它们的高层封装 ⇒
 *     **不纳进来等于同一件事有两条路，一条过守卫、一条不过**。
 *   · `set_value`：按 AT-SPI `SetValue` 动作**往别的应用的控件里写值**（`pid` 必填）——写控件就是输入。
 *   · `invoke_menu`：把应用菜单项**真的点下去**（`pid`+`window_id`+`path` 必填，走无障碍动作，不落像素）。
 *   · `browser_click` / `browser_type` / `browser_pointer` / `browser_navigate`：驱动里的浏览器动作族。
 *     `browser_dialog` 本来就在这张表里 ⇒ 同一个族的其余四个不进来就是**只在"对话框"这一格设卡**。
 *     ⚠️ 它们和 `browser_dialog` 一样**没有** `pid`/`window_id` 字段（只有 `target_id`/`tab_id` 这种不透明句柄）
 *     ⇒ 按本模块**既有**的作用域判据，它们落到"全局层"，需要用户显式同意 + 可见指示才发（这是收紧，不是放宽）。
 */
export const CUA_INPUT_TOOL_NAMES = [
  "click", "double_click", "right_click", "drag", "move_cursor", "type_text", "press_key", "hotkey", "scroll", "browser_dialog",
  "mouse_button_down", "mouse_button_up", "mouse_drag", "parallel_mouse_drag", "set_value", "invoke_menu",
  "browser_click", "browser_type", "browser_pointer", "browser_navigate",
] as const
export type CuaInputToolName = typeof CUA_INPUT_TOOL_NAMES[number]

const INPUT_TOOL_SUFFIXES = new Set<string>(CUA_INPUT_TOOL_NAMES)

/** 工具名 → 驱动原始名；不是输入类返回 undefined（本模块对它没有意见，原样放行）。 */
export function cuaInputToolName(tool: string): CuaInputToolName | undefined {
  const prefix = "cua_driver_native__"
  if (!tool.startsWith(prefix)) return undefined
  const raw = tool.slice(prefix.length)
  return INPUT_TOOL_SUFFIXES.has(raw) ? raw as CuaInputToolName : undefined
}

/**
 * 契约里**必填**键字段的输入类工具（VERIFY2 §6.2 残留口子②的收口依据）。
 *
 * `@trycua/cua-driver@0.28.0` 的 `cua_driver_contract.d.ts` 逐字：
 * ```
 * PressKeyInput { key: string; … }            ← `key` 必填（工厂签名在 Required<Omit<…>> 里）
 * HotkeyInput   { keys: Array<string>; … }    ← `keys` 必填（同上）
 * ```
 * 其余输入类工具**没有**键字段，`combos=[]` 对它们是正常形态而不是"证明不了要发什么"：
 * `click`/`double_click`/`right_click`/`move_cursor`（坐标）、`type_text`（文本）、
 * `scroll`（方向）、`browser_dialog`（对话框动作）；`drag` 的 `modifier?` 是**可选**的拖修饰键。
 * ⇒ 只有这两个工具适用"一个组合都收不出来就不发"。
 */
const KEY_REQUIRED_TOOLS: ReadonlySet<CuaInputToolName> = new Set<CuaInputToolName>(["press_key", "hotkey"])

/**
 * **不是**合成输入、但会改动用户的**全局共享状态**、而本模块**没有可恢复路径**的工具。
 * 与 `CUA_INPUT_TOOL_NAMES` **互斥**（同一个工具不允许同时出现在两张表里）。
 *
 * 唯一成员 `clipboard_write` 的依据（W22-R，全部逐字来自驱动契约与驱动二进制）：
 *   1. 契约 `ClipboardWriteInput { text?: string; imagePath?: string; filePath?: string; session?: string }`
 *      —— **没有** `target`/`scope`，所以既不能归到窗口作用域，也不是"合成输入"（不产生键鼠事件）。
 *   2. 它**真的会改用户的系统剪贴板**：驱动 SDK 有 `CuaDriver.clipboard_write(...)` 绑定，
 *      原生库里链着 `wl-clipboard-rs`（Wayland）与 `clipboard-rs` 的 X11 后端
 *      （`Failed to take ownership of the clipboard` / `Failed to write clipboard data` /
 *      `X11 CLIPBOARD` 这类字符串就在 .so 里）。
 *   3. **快照/恢复在这条通道上不成立**（所以不做 W22 那种"改前快照 + 改后恢复"）：
 *      · `ClipboardReadOutput { supported; types: Array<string>; text?; privacySensitive; … }`
 *        只给**类型清单 + 可选文本**，图片/文件/多 MIME 的**字节读不回来** ⇒ "恢复"会把
 *        用户原本的图片/文件剪贴板**换成一段文本**，比不改更糟；
 *      · X11 上剪贴板内容**属于持有者进程**（惰性传输）：写回等于把持有者换成 agent，
 *        agent 退出后内容可能直接消失 —— 这不是一个可信的逆操作；
 *      · 读剪贴板本身就是**隐私敏感**（契约里 `privacySensitive: true`，且明写"不入遥测"），
 *        把内容抄进会话状态/回执，等于给它开了第二条泄漏路径。
 *   4. 因此口径是 **fail-closed：没有可恢复路径的全局状态变更，默认不发**，并且**不拿
 *      "用户已同意全局输入"去推断"用户同意丢剪贴板"**（两件事不是同一个同意对象）。
 *      用户侧替代：要让内容进剪贴板，请用户自己复制；agent 需要往窗口里送文本用 `type_text`。
 *
 * ⚠️ 若产品确实需要"agent 用剪贴板"这个能力，正确做法是**另立一单**：驱动侧授权
 * （原生库自己有 `Allow Cua to replace the current system clipboard` 这条 protected-resource 授权）
 * + 保真度与隐私设计，而不是在这里把 `clipboard_write` 塞回输入类。
 *
 * **W22-R3 全表审计补进来的 11 个**（判据＝这张表本来的语义：**没有可恢复路径**的用户状态变更，
 * 即"本模块拿不出可信的逆操作"，而不是"看起来危险"）。逐条的落点证据见 `CUA_DRIVER_TOOL_CATALOG`
 * 的 `why` 与回执 `bugfixHistory/CUA-DRIVER-TOOL-AUDIT-20260927.md` §4：
 *   · `replay_trajectory` —— 按**驱动自己的派发路径**重放录制动作 ⇒ 能把 `click`/`press_key`/`hotkey`
 *     整批重放出去，**不经过本漏斗的任何一条判定**（作用域/拒绝清单/单飞全绕开）。
 *   · `escalate_session` —— 把会话观察面扩到整块桌面；驱动逐字写着 "No deescalate_session tool exists"。
 *   · `install_ffmpeg` —— 真的调系统包管理器装包（网络 + 系统状态）。
 *   · `kill_app` —— kill -9 等价，未保存状态直接丢。
 *   · `set_config` —— 改**持久**驱动配置（`~/.cua-driver/config.json`），没有原值快照。
 *   · `set_window_frame` —— 只回读"改成了没有"，没有改前几何。
 *   · `bring_to_front` —— 驱动里那条**刻意不还原**的置前通道。
 *   · `browser_download` —— 网络内容落用户磁盘。
 *   · `browser_prepare` —— 把 DevTools 端点挂到浏览器（含用户既有 profile 那条通道）。
 *   · `launch_app` —— `name` 会被**当命令直接执行** ⇒ 任意用户会话内执行。
 *   · `page` —— 遗留逃生舱（`execute_javascript` 等无界页面脚本；驱动自己要求操作者先开环境变量）。
 */
export const CUA_GLOBAL_STATE_TOOL_NAMES = [
  "clipboard_write",
  "replay_trajectory", "escalate_session", "install_ffmpeg", "kill_app", "set_config",
  "set_window_frame", "bring_to_front", "browser_download", "browser_prepare", "launch_app", "page",
] as const
export type CuaGlobalStateToolName = typeof CUA_GLOBAL_STATE_TOOL_NAMES[number]

const GLOBAL_STATE_TOOL_SUFFIXES = new Set<string>(CUA_GLOBAL_STATE_TOOL_NAMES)

/** 工具名 → 驱动原始名；不是"没有可恢复路径的全局状态变更类"返回 undefined。 */
export function cuaGlobalStateToolName(tool: string): CuaGlobalStateToolName | undefined {
  const prefix = "cua_driver_native__"
  if (!tool.startsWith(prefix)) return undefined
  const raw = tool.slice(prefix.length)
  return GLOBAL_STATE_TOOL_SUFFIXES.has(raw) ? raw as CuaGlobalStateToolName : undefined
}

/**
 * **不是**合成输入、**也不改**用户状态，但会把**用户的隐私数据读进 agent 上下文**的工具
 * （即"隐私通道"）。与 `CUA_INPUT_TOOL_NAMES`、`CUA_GLOBAL_STATE_TOOL_NAMES` **三者互斥**。
 *
 * 唯一成员 `clipboard_read` 的依据（W22-R2，逐字来自驱动契约；写侧四条理由逐条适用，且更强）：
 *   1. 契约 `ClipboardReadInput { includeText: boolean; session?: string }`
 *      —— **没有** `target`/`scope`：既不能归到窗口作用域，也不是合成输入。
 *   2. 它返回的正是**用户**的系统剪贴板内容：`ClipboardReadOutput { supported; types: Array<string>;
 *      text?; privacySensitive; contentRedactedFromTelemetry }`。契约自己写着
 *      "Clipboard content is privacy-sensitive and is never retained in telemetry" ——
 *      **不入遥测**是驱动对"能不能留"的回答；它没有、也不可能替产品回答"**能不能读**"。
 *   3. 它与写侧走**同一条**驱动剪贴板通道：原生库的工具名注册段里 `clipboard_read` 与
 *      `clipboard_write` 相邻，SDK 各有 `CuaDriver.clipboard_read(...)` 绑定 ⇒ 这不是一条死名字。
 *   4. **读是不可撤回的泄漏**（比写侧更硬的 fail-closed 理由）：写侧最坏是"用户的剪贴板被换掉"
 *      —— 会变、用户看得见、还能自己再复制一次；读侧一旦成功，用户剪贴板里的
 *      密码/令牌/私信就进了模型上下文与会话日志，**用户既看不见也没有撤回入口**。
 *      用户剪贴板里放着密码是完全正常的用法 ⇒ 默认必须是不读。
 *   5. `includeText:false` 也**不是**安全的降级：`types` 仍然告诉 agent 用户剪贴板里
 *      是文本/图片/文件 URL（多 MIME 清单），"用户刚复制了某个文件"本身就是要保护的事实。
 *      ⇒ 三种载荷（`includeText:true` / `false` / 空入参）**同一条**拒绝，不做分档。
 *
 * 用户侧替代（写在拒绝回执里）：要让 agent 看到某段文字，请用户**自己**把它贴进对话
 * （那是用户看得见、可撤销的动作）；要 agent 把文字送进它自己的窗口用 `type_text`。
 *
 * ⚠️ 若产品确实需要"用户显式同意后让 agent 读剪贴板"，正确做法是**另立一单**：
 * 驱动侧的逐次授权（写侧有 `Allow Cua to replace the current system clipboard` 这条
 * protected-resource 授权串，读侧**没有**对等的产品侧授权）、读的**可见指示**（读的那一刻
 * 用户看得见"正在读剪贴板"）、以及"读到的字节不进会话日志/不发给模型"的设计。
 * 在此之前默认拒 —— **不拿"用户已同意全局输入"去推断"用户同意公开剪贴板"**：两件事不是同一个同意对象。
 *
 * **W22-R3 全表审计补进来的 2 个**（判据＝这张表本来的语义：把**用户的数据**读进 agent 上下文，
 * 读走即泄漏）：
 *   · `get_desktop_state` —— 驱动契约逐字 "Capture the full display"：整块屏幕的像素，
 *     **含用户其它所有窗口的内容**（不是 agent 自己那个窗口）。窗口作用域的替代品是 `get_window_state`
 *     （`pid`+`window_id` 必填），要整屏请另立一单带用户逐次同意 + 读的那一刻可见指示。
 *   · `browser_set_input_files` —— 把**用户本机文件**（`files`：绝对路径清单）交给页面（可外发）；
 *     驱动"rejects symlinks and non-regular files, and never returns local paths"只解决回显，
 *     不解决"用户的文件内容进了页面"这件事。
 */
export const CUA_PRIVACY_READ_TOOL_NAMES = ["clipboard_read", "get_desktop_state", "browser_set_input_files"] as const
export type CuaPrivacyReadToolName = typeof CUA_PRIVACY_READ_TOOL_NAMES[number]

const PRIVACY_READ_TOOL_SUFFIXES = new Set<string>(CUA_PRIVACY_READ_TOOL_NAMES)

/** 工具名 → 驱动原始名；不是"隐私通道类"返回 undefined。 */
export function cuaPrivacyReadToolName(tool: string): CuaPrivacyReadToolName | undefined {
  const prefix = "cua_driver_native__"
  if (!tool.startsWith(prefix)) return undefined
  const raw = tool.slice(prefix.length)
  return PRIVACY_READ_TOOL_SUFFIXES.has(raw) ? raw as CuaPrivacyReadToolName : undefined
}

// ── 驱动工具**全表**与"表外"的默认语义（W22-R3）───────────────────────────────
//
// 为什么有这一节：漏斗改前只有一条判据——`if(!三张表.has(name)) return next()`。
// 而驱动侧是 `listToolsJson()` **列什么就注册什么**（上游
// `computer-use-cua-driver-native/src/index.ts:93-118`，名字一律 `cua_driver_native__<name>`）⇒
// **表外的一切第一行就交回驱动**。于是"守卫对某个工具没有意见"这句话，在产品路径上
// 根本不是"我看过它、它没问题"，而是"我根本没走到判定"——W22-R2 的 `clipboard_read` 就是活证据。
//
// 全表从哪来（**没有实例化驱动**，见回执 §2 的来源与边界）：`.runtime/computer-use-blender-xqB7P8/
// model-tool-catalog.json`（2026-09-24 的一次真实产品运行里**模型可见的工具清单**，59 个
// `cua_driver_native__*`，带驱动自己发布的 description/parameters），并与
// `@trycua/cua-driver@0.28.0` 的 `cua_driver_contract.d.ts`（28 个工具契约类型）、
// 原生库符号（`cua_driver_contract::inputs::*Input::input_schema`）与 `libcua_driver_sdk.so`
// 的字符串表（能力/授权表里出现的工具名）交叉核对。
//
// 判据（不是"名字像不像危险"，而是"**这个工具能碰到什么用户对象**"）：
//   · 往目标应用里**合成事件/动作** ⇒ `input`（进 `CUA_INPUT_TOOL_NAMES`，过作用域/拒绝清单/单飞）；
//   · 改用户可见状态而**本模块拿不出可信的逆操作** ⇒ `state`（进 `CUA_GLOBAL_STATE_TOOL_NAMES`，默认不发）；
//   · 把**用户的数据**读进 agent 上下文 ⇒ `read`（进 `CUA_PRIVACY_READ_TOOL_NAMES`，默认不读）；
//   · 其余 ⇒ `pass`（**逐条**写下它能不能碰到用户对象、以及为什么可以原样放行）。
// `input`/`state`/`read` 三张表**两两互斥**，且与 `pass` 一起**恰好铺满全表**（有用例逐条钉住）。
//
// 表外的默认语义（本单的核心判定，两个方向的读数见回执 §5）：
//   · **在册的** `pass` 工具 ⇒ 原样放行（下一条判据 `cuaDriverToolPassThrough`）；
//   · **不在全表里的** `cua_driver_native__*`（驱动升级新增/改名）⇒ **不放行**，
//     交给守卫判 `CUA_DRIVER_TOOL_UNCLASSIFIED` —— 这正是"表外一律原样放行"这个缺口的收口。
//     没有取"表外一律拒"：那会把 computer-use 的正常回路（`list_windows` → `get_window_state` →
//     输入）一起关掉，读数见回执 §5 方向 (a)。

/** 驱动工具的注册前缀（上游 `computer-use-cua-driver-native/src/index.ts:96` 逐字）。 */
export const CUA_DRIVER_TOOL_PREFIX = "cua_driver_native__"

/** 全表里每个工具的**类别**（决定它进哪张表）。 */
export type CuaDriverToolClass = "input" | "state" | "read" | "pass"

export interface CuaDriverToolSpec {
  /** 驱动里的原始工具名（不带前缀）。 */
  readonly tool: string
  readonly klass: CuaDriverToolClass
  /** **这个工具能碰到什么用户对象**（"无"＝碰不到，或只碰会话/驱动自己的东西）。 */
  readonly object: string
  /** 为什么落这一类（逐条来自驱动自己发布的工具说明/契约/原生库字符串）。 */
  readonly why: string
}

/**
 * 全表（59 个，来源见上）。字段顺序：`[类别, 能碰到的用户对象, 为什么]`。
 * ⚠️ 这里只是**分类**；"进不进拒绝表"由下面三张表决定，一致性有用例钉住（改一边不改另一边会红）。
 */
const CUA_DRIVER_TOOL_TABLE: Readonly<Record<string, readonly [CuaDriverToolClass, string, string]>> = {
  // —— input：往目标应用里合成事件/动作 ——
  click: ["input", "用户的窗口/应用（合成指针点击；可指名窗口，也可不带目标）", "合成输入：往目标应用发指针事件（驱动里 click 这一族的高层封装）。"],
  double_click: ["input", "同上", "合成输入（XSendEvent 双 click）。"],
  right_click: ["input", "同上", "合成输入（右键）。"],
  drag: ["input", "指针下的用户窗口（按住-拖动-释放）", "合成输入。"],
  move_cursor: ["input", "整块桌面上**唯一的那一个**指针", "合成输入：不带目标时动的是用户的真实 OS 指针。"],
  type_text: ["input", "目标窗口里正在编辑的文本", "合成输入（键盘文本）。"],
  press_key: ["input", "同上", "合成输入（单键）。"],
  hotkey: ["input", "同上", "合成输入（组合键；会被桌面/WM 全局快捷键捕获的那一类）。"],
  scroll: ["input", "目标窗口的滚动位置", "合成输入（滚轮）。"],
  browser_dialog: ["input", "用户浏览器里那个页面自己的对话框（alert/confirm/prompt/beforeunload）", "输入族：接收/关闭对话框会改页面状态（W22 起就在表里）。"],
  mouse_button_down: ["input", "指针下的用户窗口（按下后**保持按住**，直到 up）", "裸指针原语（click/drag 的底层）：同一件事不能一条路守卫、一条路不守卫。"],
  mouse_button_up: ["input", "同上", "裸指针原语（释放；不释放就一直按着）。"],
  mouse_drag: ["input", "同上", "裸指针原语（拖动已按住的键）。"],
  parallel_mouse_drag: ["input", "多个用户窗口（MPX 虚拟主指针并发拖动）", "裸指针原语。⚠️ 参数里**没有**顶层 `pid`/`window_id`（只有 `drags[]` 里的窗口局部坐标）⇒ 按本模块既有判据落\"全局层\"，需用户显式同意 + 可见指示；这是收紧不是放宽（回执 §6 登记了这条代价）。"],
  set_value: ["input", "用户应用里那个控件的值（AT-SPI SetValue）", "输入族：往**别的应用**的控件里写值（`pid` 必填）。"],
  invoke_menu: ["input", "用户应用的菜单项（点下去就执行，含 Quit/Save-as 这类）", "输入族：走无障碍动作真的点菜单项（`pid`+`window_id`+`path` 必填）。"],
  browser_click: ["input", "用户浏览器已精确绑定标签页的页面", "输入族（浏览器动作）。无窗口字段 ⇒ 既有判据下落全局层。"],
  browser_type: ["input", "同上（往页面输入框写文本）", "输入族（浏览器动作）。无窗口字段 ⇒ 同上。"],
  browser_pointer: ["input", "同上（悬停/右键/双击/滚动/拖拽）", "输入族（浏览器动作）。无窗口字段 ⇒ 同上。"],
  browser_navigate: ["input", "用户浏览器标签页的地址/内容/历史", "输入族（浏览器动作）。无窗口字段 ⇒ 同上。"],
  // —— state：没有可恢复路径的用户状态变更 ——
  clipboard_write: ["state", "用户的系统剪贴板", "见 `CUA_GLOBAL_STATE_TOOL_NAMES` 的四条理由（无 target/scope、快照恢复在这条通道上不成立、读回也只有类型清单）。"],
  replay_trajectory: ["state", "用户桌面（重放已录制的动作＝任意合成输入）", "驱动逐字：\"re-invoking every turn's tool call … via the same dispatch path an MCP / CLI call uses\" ⇒ 走**驱动自己的**派发路径，**绕开本漏斗的每一条判定**（作用域/拒绝清单/单飞全绕开）。"],
  escalate_session: ["state", "会话观察面（从窗口扩到**整块桌面**）", "驱动逐字：\"No deescalate_session tool exists\" ⇒ 扩出去就收不回来。"],
  install_ffmpeg: ["state", "本机系统（真的调包管理器装包）", "驱动逐字：\"pass `confirm: true` to actually run it\"（网络 + 系统状态变更），本模块没有逆操作。"],
  kill_app: ["state", "用户的进程（含未保存状态）", "驱动逐字：\"Force-terminate a process by pid (kill -9 equivalent)\"、\"Unsaved state is lost\"。"],
  set_config: ["state", "驱动的**持久**配置（`~/.cua-driver/config.json`）", "驱动逐字：\"capture_mode / max_image_dimension take effect immediately\"、key 持久落盘；没有原值快照 ⇒ 恢复不了。"],
  set_window_frame: ["state", "用户窗口的位置/大小", "驱动只回读\"改成了没有\"（`readback`），没有改前几何 ⇒ 没有可恢复路径。"],
  bring_to_front: ["state", "用户的焦点/活动窗口", "驱动逐字：\"Persistently activate a window … deliberately breaks the no-foreground contract\"，且这条通道**不做** act-then-restore（正常梯子是输入工具自己的 `delivery_mode:foreground`）。"],
  browser_download: ["state", "用户磁盘（网络取回的内容）", "驱动逐字：\"save it inside an explicitly approved directory. Requires MCP-host destructive-tool approval\"——本宿主是否实现那条批准流程**未验证**（回执 §9 登记）⇒ 不把\"驱动会拦\"当作我们的判据。"],
  browser_prepare: ["state", "浏览器进程与 DevTools 端点（含 `strategy.kind=existing_profile`＝**用户既有 profile**）", "驱动契约逐字有 `existing_profile` 这条通道（`window_id` 作为批准锚点）；把 DevTools 挂到用户已登录的浏览器 = 拿到他的会话。产品侧没有对等的授权对象 ⇒ 默认不发。"],
  launch_app: ["state", "用户会话（可以启动任意命令/URL）", "驱动逐字：`name` \"tried as a direct command, then matched against installed .desktop applications, then handed to xdg-open\" ⇒ 任意用户会话内执行，已经跑起来的命令收不回来。"],
  page: ["state", "用户浏览器页面（含 `execute_javascript` 这类无界脚本）", "驱动逐字：\"Legacy browser compatibility tool\"、mutating actions 需要操作者先设 `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1`；只在\"对话框\"这一格设卡而放过无界脚本是说不过去的。只读替代品是 `get_browser_state`。"],
  // —— read：把用户数据读进 agent 上下文 ——
  clipboard_read: ["read", "用户的系统剪贴板（可能是密码/令牌/私信）", "见 `CUA_PRIVACY_READ_TOOL_NAMES` 的五条理由（不可撤回的泄漏；`includeText:false` 也泄漏类型）。"],
  get_desktop_state: ["read", "**整块屏幕**的像素（含用户其它所有窗口的内容）", "驱动逐字：\"Capture the full display in the desktop action coordinate frame\"；窗口作用域的替代品是 `get_window_state`（`pid`+`window_id` 必填）。"],
  browser_set_input_files: ["read", "**用户本机文件**（内容交给页面，可外发）", "驱动逐字：\"Assign one or more explicit absolute local files to an exact live `<input type=file>` ref\"；\"never returns local paths\" 只解决回显。"],
  // —— pass：下面每一条都逐条写了"能不能碰到用户对象"与放行理由 ——
  get_window_state: ["pass", "**被点名的那个窗口**的全部无障碍文本/控件/截图（可以是用户的窗口）", "① 契约里 `pid`+`window_id` **必填** ⇒ 观测量被窗口目标限定，走的正是本模块既有的作用域判据（与输入类同一条：指名了窗口＝窗口作用域）② 它是 computer-use 正常回路的观测入口（上游 GUIDANCE：先取窗口快照再动作），禁它等于把功能整体关掉。⚠️ 已知边界（与输入类同一个）：无法证明那个窗口一定是 agent 自己的窗口。"],
  zoom: ["pass", "被点名窗口的一个裁剪区域（JPEG）", "`window_id`+`x1,y1,x2,y2` 必填 ⇒ 与 `get_window_state` 同一条窗口作用域判据。"],
  verify_state: ["pass", "被点名窗口的无障碍状态 + 可选截图", "`pid`+`window_id` 必填（同一条窗口作用域判据）；谓词结果只有 satisfied/unsatisfied/unknown，不返回窗口内容本身（截图是可选证据）。"],
  get_browser_state: ["pass", "已精确绑定标签页的页面内容（无障碍/DOM/布局/视口）", "只读；绑定是 exact-or-refuse（拒绝启发式绑定），且它正是浏览器工作流的观测入口。要禁它请另立一单（连带 `browser_*` 一起设计），本单不半开半关。"],
  list_windows: ["pass", "用户窗口清单（标题/边界/z 序）", "只给结构与几何；而\"指名 agent 自己窗口\"的靶点选择依赖它 ⇒ 禁它等于把 computer-use 整体关掉（方向 (a) 的读数）。⚠️ 窗口标题可能敏感，登记为已知边界。"],
  list_apps: ["pass", "用户机器上装了什么/跑了什么（应用身份）", "靶点选择必需：只给应用身份与启动路径，不含窗口内容；要看内容必须再点名一个窗口（`get_window_state`）。"],
  get_accessibility_tree: ["pass", "用户桌面结构：进程清单 + 可见窗口边界/pid", "驱动自己的说明：\"a fast discovery read\"（要单个窗口的完整 AT-SPI 子树请用 `get_window_state`）⇒ 只有结构与几何，没有窗口内容。"],
  get_cursor_position: ["pass", "用户指针坐标（一个点，不含内容）", "desktop 坐标系的坐标源：一个点，不含任何内容；真正动指针仍要过输入表的窗口作用域判定。"],
  get_screen_size: ["pass", "主显示器尺寸/缩放因子的**读数**（不含内容）", "坐标换算必需的几何读数（宽/高/scale_factor），不含任何内容。"],
  get_agent_cursor_state: ["pass", "无（agent 自己的会话光标状态）", "驱动自己的光标（逐字：不动用户指针）。"],
  set_agent_cursor_enabled: ["pass", "agent 自己的会话光标（用户屏幕上可见的叠加层）", "改的是**agent 自己的**光标，会话结束会清理 ⇒ 有可恢复路径。"],
  set_agent_cursor_motion: ["pass", "同上（只改运动物理/可见时序）", "同 `set_agent_cursor_enabled`：只改**agent 自己**会话光标的运动物理与可见时序，会话结束清理 ⇒ 有可恢复路径。"],
  set_agent_cursor_theme: ["pass", "同上（选一个已安装的光标主题）", "同 `set_agent_cursor_enabled`：只给**agent 自己**的会话光标选一个已安装主题，会话结束清理 ⇒ 有可恢复路径。"],
  check_permissions: ["pass", "无（只读本机权限状态；`prompt=true` 那条 OS 弹窗由驱动自己判 \"never_agent_controllable\"、必须由可信宿主发起）", "只读诊断；不含用户内容。"],
  health_report: ["pass", "无（驱动自检：版本/能力/权限/平台）", "只读诊断。"],
  get_config: ["pass", "无（驱动配置的**只读**视图）", "只读。"],
  get_recording_state: ["pass", "无（本会话录制状态与输出目录）", "只读。"],
  start_recording: ["pass", "被操作窗口的**改前/改后截图 + 无障碍状态**（写进 `output_dir`）", "⚠️ 这一格是**有意的取舍**：它确实把用户窗口的画面落到磁盘且没有逆操作；但 2026-09-24 的真实产品运行（`.runtime/computer-use-blender-xqB7P8/tool-results.jsonl`）里模型**真的调了** `start_recording`/`stop_recording` ⇒ 硬拒会把产品自己在用的证据链关掉。处置：保持放行，把\"录制对象＝被操作的那个窗口 + 显式 `output_dir`\"登记为已知边界（回执 §7-4）。"],
  stop_recording: ["pass", "无（停止录制：只会**减少**采集）", "只往安全方向走（驱动逐字：manual stop 是 unconditional）。"],
  start_session: ["pass", "无（建/取会话；`capture_scope` 是遗留输入）", "生命周期；不含用户对象。"],
  end_session: ["pass", "无（只收尾自己的会话：光标/录制/配置清理钩子）", "只收尾自己的会话；拒它反而会把会话留在打开状态（比放行更糟）。"],
  get_session: ["pass", "无（本 transport 的会话生命周期状态）", "只读、content-free。"],
  get_session_state: ["pass", "无（遗留会话的 capture 策略）", "只读别名（deprecated）。"],
  list_sessions: ["pass", "无（本 transport 的会话摘要；不枚举别的调用方）", "只读、content-free。"],
}

/** 全表（59 条）。`tool` 是驱动原始名；查询请用 `cuaDriverToolSpec`（前缀可带可不带）。 */
export const CUA_DRIVER_TOOL_CATALOG: readonly CuaDriverToolSpec[] = Object.entries(CUA_DRIVER_TOOL_TABLE)
  .map(([tool, [klass, object, why]]) => ({ tool, klass, object, why }))

/** 全表里的工具名（驱动原始名，59 个）。 */
export const CUA_DRIVER_TOOL_NAMES: readonly string[] = CUA_DRIVER_TOOL_CATALOG.map(entry => entry.tool)

const DRIVER_TOOL_BY_NAME = new Map<string, CuaDriverToolSpec>(CUA_DRIVER_TOOL_CATALOG.map(entry => [entry.tool, entry]))

/** `cua_driver_native__<name>` → `<name>`；不是驱动工具返回 undefined。 */
export function cuaRawDriverToolName(tool: string): string | undefined {
  return tool.startsWith(CUA_DRIVER_TOOL_PREFIX) ? tool.slice(CUA_DRIVER_TOOL_PREFIX.length) : undefined
}

/** 工具名（带不带前缀都认）→ 全表条目；不在全表里返回 undefined。 */
export function cuaDriverToolSpec(tool: string): CuaDriverToolSpec | undefined {
  return DRIVER_TOOL_BY_NAME.get(cuaRawDriverToolName(tool) ?? tool)
}

/**
 * 漏斗的第一个问题：这次调用**能不能原样交回驱动**？
 *   · 不是 `cua_driver_native__*` ⇒ 能（本模块不管别的域的工具体）；
 *   · 在册的 `pass` 工具 ⇒ 能（每一条的放行理由写在 `CUA_DRIVER_TOOL_CATALOG` 里）；
 *   · 其余（三张表里的 + **不在全表里的**）⇒ 不能，交给 `planComputerUseInput` 判。
 * 这就是"表外不再等于放行"的**唯一**落点（`plugin.ts` 的漏斗只调这一个函数）。
 */
export function cuaDriverToolPassThrough(tool: string): boolean {
  const raw = cuaRawDriverToolName(tool)
  if (raw === undefined) return true
  return DRIVER_TOOL_BY_NAME.get(raw)?.klass === "pass"
}

/**
 * 拒绝表：`state` + `read` 两类工具的逐条处置（稳定码 + `rule` + 为什么 + 用户侧怎么办）。
 * 键是**驱动原始名**；`clipboard_write` / `clipboard_read` 两条的文案与 W22-R / W22-R2 逐字相同
 * （那两条是既有判据，本单**不放宽**、也不改口径）。
 */
interface CuaDriverToolRefusal { readonly code: string; readonly rule: string; readonly reason: string; readonly advice: string }

export const CUA_DRIVER_TOOL_REFUSALS: Readonly<Record<string, CuaDriverToolRefusal>> = {
  clipboard_write: {
    code: COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_WRITE_REFUSED,
    rule: "clipboard-not-restorable",
    reason: "clipboard_write 改的是**用户的系统剪贴板**：驱动契约里没有 `target`/`scope`（无法归到窗口作用域），而本模块的 gsettings 快照抓不到也恢复不了剪贴板内容（读回来只有类型清单 + 可选文本，图片/文件/多 MIME 的字节读不回来）。没有可恢复路径的全局状态变更，agent 不发。",
    advice: "要往 agent 自己的窗口里送文本，请用 `type_text`（窗口作用域）；要让内容进用户剪贴板，请让用户自己复制。",
  },
  clipboard_read: {
    code: COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_READ_REFUSED,
    rule: "clipboard-read-not-disclosable",
    reason: "clipboard_read 读的是**用户**的系统剪贴板（驱动契约里 `ClipboardReadOutput.privacySensitive` 为真，并明写\"不入遥测\"）：用户剪贴板里可能是密码/令牌/私信，读走就进了 agent 上下文与会话日志，**用户既看不见也没有撤回入口**。这条通道没有 `target`/`scope`（无法归到窗口作用域），`includeText:false` 也仍会给出用户复制的是什么类型（文本/图片/文件）⇒ 本模块不分档，一律不读。",
    advice: "要让 agent 看到某段文字，请**用户自己**把它贴进对话（用户看得见、可撤销）；要 agent 把文字送进它自己的窗口请用 `type_text`。确实需要 agent 读剪贴板，请另立一单带驱动侧逐次授权与读的那一刻可见指示。",
  },
  replay_trajectory: {
    code: COMPUTER_USE_INPUT_ERRORS.TRAJECTORY_REPLAY_REFUSED,
    rule: "trajectory-replay-bypasses-input-guard",
    reason: "replay_trajectory 按**驱动自己的派发路径**重放录制下来的每一个工具调用（驱动逐字：\"via the same dispatch path an MCP / CLI call uses\"）⇒ `click`/`press_key`/`hotkey` 这些输入会被**绕过本漏斗**整批发出去：作用域判定、全局快捷键拒绝清单、宿主级单飞一条都不生效。一次放行就等于把守卫整体短路。",
    advice: "要让 agent 重做某个动作序列，请把动作重新作为普通工具调用发出来（那样每一次都过守卫）；需要轨迹重放请另立一单，把\"重放的每一步都要重新过判定\"设计进去。",
  },
  escalate_session: {
    code: COMPUTER_USE_INPUT_ERRORS.CAPTURE_ESCALATION_REFUSED,
    rule: "capture-escalation-not-reversible",
    reason: "escalate_session 把会话的观察面从\"一个窗口\"扩到**整块桌面**，而驱动自己逐字写着 \"No deescalate_session tool exists\" ⇒ 扩出去收不回来；它还是驱动标注的 deprecated 兼容工具，新调用方本来就不该用它。",
    advice: "要做 desktop 作用域的动作，请让**用户**显式同意本次 computer-use 会话（可见指示 + 同意），并按动作粒度指明目标；不要用这条一次性放大观察面的遗留通道。",
  },
  install_ffmpeg: {
    code: COMPUTER_USE_INPUT_ERRORS.DEPENDENCY_INSTALL_REFUSED,
    rule: "dependency-install-not-reversible",
    reason: "install_ffmpeg 带 `confirm:true` 时**真的调用系统包管理器**装包（驱动逐字：\"pass `confirm: true` to actually run it\"）：这是对用户机器的系统状态变更，本模块没有可信的逆操作，也不该替用户决定装什么。",
    advice: "需要 ffmpeg 请让用户自己装（或由产品的环境预检在用户可见的安装流程里做）；agent 不替用户改系统包集合。",
  },
  kill_app: {
    code: COMPUTER_USE_INPUT_ERRORS.PROCESS_TERMINATION_REFUSED,
    rule: "process-termination-not-reversible",
    reason: "kill_app 是 kill -9 等价（驱动逐字：\"Force-terminate a process by pid\"、\"Unsaved state is lost\"）：用户的未保存内容直接丢，杀了就回不来。它自己也只是\"cooperative close 失败后的升级手段\"。",
    advice: "要关掉某个应用，请让**用户自己**关（或者由用户显式授权一次终止）；agent 不单方面杀用户的进程。",
  },
  set_config: {
    code: COMPUTER_USE_INPUT_ERRORS.DRIVER_CONFIG_REFUSED,
    rule: "driver-config-not-restorable",
    reason: "set_config 改的是驱动的**持久**配置（驱动逐字：capture_mode / max_image_dimension 立即生效，experimental_pip 这类键落盘到 `~/.cua-driver/config.json`）：本模块没有改前快照，改错了恢复不了，而它改的正是采集/图像尺寸这类**隐私姿态**。",
    advice: "需要改驱动配置请在**产品配置面**（用户看得见、可回退）做，或由用户/运维在宿主侧配置；不作为工具调用的一部分。",
  },
  set_window_frame: {
    code: COMPUTER_USE_INPUT_ERRORS.WINDOW_FRAME_REFUSED,
    rule: "window-frame-not-restorable",
    reason: "set_window_frame 改用户窗口的位置/大小：驱动只做\"读回确认改成没改成\"（`X11 geometry readback`），**没有**改前几何 ⇒ 本模块拿不出可信的逆操作（把窗口摆回原位需要先有快照）。",
    advice: "需要窗口尺寸请让用户自己调整，或先由用户授权一个\"摆窗口\"的动作；agent 不改用户窗口的几何。",
  },
  bring_to_front: {
    code: COMPUTER_USE_INPUT_ERRORS.FOREGROUND_ACTIVATION_REFUSED,
    rule: "foreground-activation-not-restored",
    reason: "bring_to_front 是驱动里**刻意不还原**的那条置前通道（逐字：\"Persistently activate a window … deliberately breaks the no-foreground contract\"，\"not part of the normal input ladder\"）⇒ 它把焦点从用户手里拿走且不还回去。正常梯子是输入工具自己的 `delivery_mode:\"foreground\"`（那条会 activate-act-restore）。",
    advice: "需要前台交付请在**输入工具自己**的参数里用 `delivery_mode:\"foreground\"`（它会自己还原原先的活动窗口）；不要用这条一次性抢焦点的通道。",
  },
  browser_download: {
    code: COMPUTER_USE_INPUT_ERRORS.BROWSER_DOWNLOAD_REFUSED,
    rule: "browser-download-writes-user-disk",
    reason: "browser_download 把网络取回的内容落到用户磁盘（驱动逐字：\"save it inside an explicitly approved directory. Requires MCP-host destructive-tool approval\"）：落盘即不可撤回，而\"本宿主确实实现了那条破坏性批准流程\"这件事**本单没有验证**（回执 §9 登记）⇒ 不把\"驱动会拦\"当成我们的判据。",
    advice: "要让用户拿到某个文件，请把下载**交给用户自己**（或走产品自己的、用户可见的取件流程）；agent 不替用户往磁盘写下载内容。",
  },
  browser_prepare: {
    code: COMPUTER_USE_INPUT_ERRORS.BROWSER_PREPARE_REFUSED,
    rule: "browser-prepare-exposes-devtools",
    reason: "browser_prepare 会把 **DevTools 端点**挂到一个浏览器上；驱动契约里明确有 `strategy.kind=\"existing_profile\"`（挂到**用户既有的浏览器 profile**，用 `window_id` 当批准锚点）⇒ 那条通道等于拿到用户已登录的会话。产品侧没有与它对应的授权对象，而 DevTools 一旦挂上就等于\"页面脚本可以驱动这个浏览器\"。",
    advice: "需要浏览器自动化请走产品自己的浏览器能力包（用户在界面里看得见、可关）；确需驱动侧浏览器通道请另立一单，把\"用户逐次授权 + 用哪个 profile\"设计进去。",
  },
  launch_app: {
    code: COMPUTER_USE_INPUT_ERRORS.APP_LAUNCH_REFUSED,
    rule: "app-launch-runs-arbitrary-command",
    reason: "launch_app 的 `name` 会被驱动**当命令直接执行**（逐字：\"tried as a direct command, then matched against installed .desktop applications, then handed to xdg-open\"）⇒ 这是一条任意用户会话内执行通道（还能通过 `urls`/`launch_path` 拉起任意东西），跑起来的进程收不回来。",
    advice: "要打开某个应用/文件，请让**用户自己**打开（或先由用户授权）；agent 只操作已经在运行、且被它指名了窗口的应用。",
  },
  page: {
    code: COMPUTER_USE_INPUT_ERRORS.LEGACY_PAGE_REFUSED,
    rule: "legacy-page-escape-hatch",
    reason: "page 是驱动的遗留兼容工具，含 `execute_javascript` 这类**无界页面脚本**（驱动自己的策略行把它标成 \"unbounded_authenticated_page_script / not_grantable_in_standard_or_bounded\"，并要求操作者先设 `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1`）：它的变更动作等于在用户已登录的页面里跑任意脚本，只读动作也把页面内容整份读出来。",
    advice: "只读的页面观察请用 `get_browser_state`；要执行脚本请另立一单，把用户授权与\"脚本在哪个页面\"设计进去。",
  },
  get_desktop_state: {
    code: COMPUTER_USE_INPUT_ERRORS.DESKTOP_CAPTURE_REFUSED,
    rule: "desktop-capture-not-disclosable",
    reason: "get_desktop_state 抓的是**整块屏幕**（驱动逐字：\"Capture the full display\"）——不是 agent 自己那个窗口，而是用户桌面上所有窗口的像素（可能是私信、密码管理器、别人的会议画面）。它没有 `target`/`scope`（无法归到窗口作用域），`screenshot_out_file` 还会把整屏 PNG 写进任意路径。",
    advice: "要看 agent 正在操作的那个窗口，请用 `get_window_state`（`pid`+`window_id` 必填，窗口作用域）；确实需要整屏，请**用户**显式同意并让读的那一刻有可见指示（另立一单）。",
  },
  browser_set_input_files: {
    code: COMPUTER_USE_INPUT_ERRORS.LOCAL_FILE_UPLOAD_REFUSED,
    rule: "local-file-upload-not-disclosable",
    reason: "browser_set_input_files 把**用户本机文件**（`files`：绝对路径清单）直接交给一个页面（驱动逐字：\"Assign one or more explicit absolute local files to an exact live `<input type=file>` ref\"）⇒ 用户的文件内容进了页面、可以立刻外发，读走即泄漏且不可撤回。驱动\"rejects symlinks and non-regular files, and never returns local paths\"只解决**回显**，不解决\"文件内容交给了谁\"。",
    advice: "要让 agent 处理某个文件，请**用户自己**把文件放进对话/工作区（用户看得见、可撤销）；确需页面上传请另立一单，把\"哪个文件、传给哪个页面、用户逐次同意\"设计进去。",
  },
}

/** 工具名（带不带前缀都认）→ 拒绝条目；不在拒绝表里返回 undefined。 */
export function cuaDriverToolRefusal(tool: string): CuaDriverToolRefusal | undefined {
  const raw = cuaRawDriverToolName(tool)
  return raw === undefined ? undefined : CUA_DRIVER_TOOL_REFUSALS[raw]
}

// ── 组合键解析与拒绝清单 ─────────────────────────────────────────────────────

export interface KeyChord {
  /** 规范化修饰键集合（小写、有序）：`super` / `ctrl` / `alt` / `shift`。 */
  readonly modifiers: readonly string[]
  /** 规范化主键（小写）：`s`、`tab`、`space`、`xf86audioraisevolume`…；纯修饰键组合为 `""`。 */
  readonly key: string
  /** 原始写法（回执里原样给用户/模型看）。 */
  readonly raw: string
}

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  super: "super", win: "super", meta: "super", cmd: "super", command: "super", "⌘": "super", mod4: "super",
  ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
  alt: "alt", option: "alt", opt: "alt", "⌥": "alt",
  shift: "shift", "⇧": "shift",
}

/**
 * X11 **keysym** 拼写的修饰键（xdotool / 驱动 SDK 实际发的就是这些名字）。
 *
 * 为什么必须单独一张表（W22 验收 §2.2b）：`MODIFIER_ALIASES` 只认 `shift`/`super` 这类"口语别名"，
 * 而真实按键流里的名字是 `Shift_L` / `Control_L` / `Alt_L` / `Super_L` / `Meta_L`（左右各一份），
 * 驱动还能收 `KEY_LEFTMETA`（evdev 风格）。漏掉它们 ⇒ **裸修饰键规则整条被绕过**：
 * 连按 5 次 `Shift_L` 就是粘滞键的触发序列，而守卫当时一律放行。
 * 模块注释一直声称接受 `KEY_LEFTMETA` —— 这张表让那句话成真。
 */
const MODIFIER_KEYSYMS: Readonly<Record<string, string>> = {
  shift_l: "shift", shift_r: "shift",
  control_l: "ctrl", control_r: "ctrl", ctrl_l: "ctrl", ctrl_r: "ctrl",
  alt_l: "alt", alt_r: "alt", meta_l: "super", meta_r: "super",
  super_l: "super", super_r: "super", hyper_l: "super", hyper_r: "super",
  iso_level3_shift: "alt", iso_level5_shift: "alt",
}

/**
 * Linux **evdev** 键名（`KEY_LEFTMETA` / `KEY_RIGHTCTRL` / `KEY_LEFTALT`…）的归一。
 * 它和 X keysym 不是同一种拼法：位置前缀 `left`/`right` 在 evdev 里在**前面**，在 keysym 里是后缀 `_L`/`_R`。
 * 归一顺序：去 `<...>` → 小写 → 去 `key_` → 换成长度前缀形式 → 查 `MODIFIER_KEYSYMS`。
 * 不这么做的后果（W22 验收实测）：`KEY_LEFTMETA`/`KEY_LEFTCTRL` 一律放行，
 * 而模块注释**声称**接受这种写法 —— 声称与行为不一致本身就是一个缺陷。
 */
const EVDEV_POSITION_PREFIXES: Readonly<Record<string, string>> = { left: "_l", right: "_r" }

/**
 * 把一个"写法"归一成修饰键名；不是修饰键返回 undefined。
 * `KEY_LEFTMETA` / `KEY_LEFTCTRL` / `<Super_L>` / `Meta_L` / `super` 都归到同一个修饰键名。
 */
export function normalizeModifierName(value: string): string | undefined {
  let bare = value.trim().replace(/^<|>$/g, "").toLowerCase()
  if (bare.startsWith("key_")) bare = bare.slice(4)
  const direct = MODIFIER_ALIASES[bare] ?? MODIFIER_KEYSYMS[bare]
  if (direct) return direct
  const prefix = Object.keys(EVDEV_POSITION_PREFIXES).find(candidate => bare.startsWith(candidate))
  if (!prefix) return undefined
  return MODIFIER_KEYSYMS[`${bare.slice(prefix.length)}${EVDEV_POSITION_PREFIXES[prefix]!}`]
}

const MODIFIER_ORDER = ["super", "ctrl", "alt", "shift"] as const

/** 修饰键集合归一：去重 + 按固定顺序排（同一组键的不同写法必须落到同一个 `KeyChord`）。 */
function normalizeModifiers(names: readonly string[]): string[] {
  const modifiers: string[] = []
  for (const name of names) {
    const modifier = normalizeModifierName(name)
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier)
  }
  return modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a as typeof MODIFIER_ORDER[number]) - MODIFIER_ORDER.indexOf(b as typeof MODIFIER_ORDER[number]))
}

/** 主键写法归一：小写、去 xdotool 的 `<...>`、去 evdev 的 `KEY_` 前缀。 */
const normalizeKeyName = (value: string): string => {
  const bare = value.trim().replace(/^<|>$/g, "").toLowerCase()
  return bare.startsWith("key_") ? bare.slice(4) : bare
}

/**
 * 解析一个键组合。接受 `Super+Alt+s` / `ctrl+shift+t` / `<ctrl>+c`（xdotool 写法）/ `KEY_LEFTMETA`…
 * 多键序列（`xdotool key a b`）由调用方拆开后逐个传进来：**任一段被拒就整次不发**。
 * 解析不出来返回 undefined —— 调用方按"不认识的组合**不合成**"处理（fail-closed）。
 *
 * **残留尖括号 ⇒ 解析不出来**（VERIFY2 §6.1 / VERIFY2-COMPUTER-USE 残留口子②）：
 * `normalizeKeyName` 只剥**开头 `<` 与结尾 `>`**，所以 GNOME 的绑定写法
 * （`gsettings` 里逐字就是 `['<Alt>F7']`、`<Shift><Alt>Tab` 这种"尖括号修饰键前缀 + 主键"）
 * 会留下一个 `>`：`"<Alt>F7"` → `"alt>f7"` —— 它既不是修饰键也不是合法键名，却被当成
 * "名叫 `alt>f7` 的主键"**溜过** `unparsable` 兜底并放行，而 `<Alt>F7` 正好是 mutter 的
 * `begin-move`（**移动用户的窗口**）。`xdotool`/X keysym 里没有任何合法键名含 `<`/`>`
 * （合法的 `<ctrl>+c` 在**修饰键**位置上已经被 `normalizeModifierName` 整段吃掉，不会走到这里），
 * 所以"归一后还剩尖括号"等价于"这不是驱动认得的写法" ⇒ 一律 fail-closed，不发。
 */
export function parseKeyChord(value: string): KeyChord | undefined {
  const raw = value.trim()
  if (!raw) return undefined
  // 空白分隔的序列（`xdotool key ctrl+c v` 那种）不是一个组合：调用方要先按空白拆成多个组合逐个判，
  // 这里看到空白就 fail-closed —— 否则 `Super+Alt+s` 混在一串里能被当成"一个奇怪的主键"溜过去。
  if (/\s/.test(raw)) return undefined
  const parts = raw.split("+").map(part => part.trim()).filter(Boolean)
  if (!parts.length) return undefined
  const modifiers: string[] = []
  let key = ""
  for (const part of parts) {
    const modifier = normalizeModifierName(part)
    if (modifier) { if (!modifiers.includes(modifier)) modifiers.push(modifier); continue }
    // 一个组合里出现两个主键说明写法不是"单次按键"（例如 "ctrl+c v"）：不合成。
    if (key) return undefined
    key = normalizeKeyName(part)
    // 归一后还剩尖括号 ⇒ 见函数头：`<Alt>F7` 这类 GNOME 绑定写法不是驱动认得的键名。
    if (/[<>]/.test(key)) return undefined
  }
  const sorted = normalizeModifiers(modifiers)
  if (!key && sorted.length === 0) return undefined
  return { modifiers: sorted, key, raw }
}

/** 被系统/桌面/WM 在窗口之前捕获的组合：规则表（顺序即优先级，第一条命中即拒）。 */
export interface ShortcutRefusalRule {
  readonly id: string
  readonly code: string
  readonly matches: (chord: KeyChord) => boolean
  /** 为什么这个组合是系统级的（回执里给用户/模型看）。 */
  readonly why: string
  /** 用户想达到的目的，在哪儿自己做。 */
  readonly advice: string
}

const has = (chord: KeyChord, modifier: string) => chord.modifiers.includes(modifier)

/**
 * XKB **AccessX**（无障碍键盘）切换键：`/usr/share/X11/xkb/compat/accessx` 里这些 keysym 各自带
 * `LockControls` 动作，改的是 **X 服务端**的键盘控制位（不是 gsettings），所以：
 *   · 9 键快照既**抓不到**也**恢复不了**（会话结束写不回原状）；
 *   · 打开后用户的输入行为被改（粘滞/慢键/鼠标键/重复键），用户不知道原因。
 * ⇒ 一律不发。`AccessX_Enable` 是这些开关的总闸，`Caps_Lock`/`Num_Lock` 是跨窗口持久的 X core 状态。
 */
const ACCESSX_KEYSYMS = new Set([
  "accessx_enable", "accessx_feedback_enable", "accessx_timeout_enable",
  "stickykeys_enable", "slowkeys_enable", "bouncekeys_enable", "mousekeys_enable",
  "mousekeys_accel_enable", "mousekeys_default_button_enable", "repeatkeys_enable",
  "overlays_enable", "audiblebell_enable", "togglekeys_enable", "halvekeys_enable",
  "caps_lock", "num_lock", "shift_lock", "scroll_lock",
])

/**
 * **ALT 单修饰 + 非字符键**这一类。
 *
 * ⚠️ reason 文案必须与**实测**一致（本单修正；旧文案把整类都写成"本机实测由 WM 全局抓取"，实测不是）：
 * 本机只读枚举（`gsettings list-recursively` 五张 schema：`org.gnome.desktop.wm.keybindings` /
 * `org.gnome.shell.keybindings` / `org.gnome.mutter.keybindings` /
 * `org.gnome.settings-daemon.plugins.media-keys` / `org.gnome.desktop.wm.preferences`；共 203 条键规格）
 * 里，**修饰键只有 `<Alt>`** 的绑定 15 条，其中落在本表 28 个键里的只有 **11 个**：
 *   `Tab`(switch-windows)、`Escape`(cycle-windows)、`space`(activate-window-menu)、
 *   `Above_Tab`(switch-group)、`F1`(panel-main-menu)、`F2`(panel-run-dialog)、`F4`(close)、
 *   `F6`(cycle-group)、`F7`(begin-move)、`F8`(begin-resize)、`F10`(toggle-maximized)。
 *   （另 4 条 `<Alt>` 绑定是三条媒体键与 `<Alt>Print`，分别由 `media-keys` / `sysrq` 接住。）
 * 剩下 **17 个**键（`Left`/`Right`/`Up`/`Down`/`Home`/`End`/`Page_Up`/`Page_Down`/`Delete`/`BackSpace`/
 * `Insert`/`F3`/`F5`/`F9`/`F11`/`F12`/`ISO_Next_Group`）本机**没有** Alt-only 绑定（本机方向键的真实绑定是
 * `<Control><Alt>` / `<Super><Alt>`，已被 `vt-switch-and-desktop` / `super-combos` 接住）
 * ⇒ 它们是**按类别保守拒绝**（这一类在别的 GNOME 版本/发行版/其它 WM 上有绑定），**不是**"本机实测被抓取"。
 * 代价明确：`Alt+Left/Right`（前进/后退）、`Alt+BackSpace`（readline 删词）、`Alt+Home` 这类应用内写法
 * 在本机也发不出去（方向 fail-closed，**非安全问题**）。本单**不收窄清单** —— 收窄清单＝放宽判据，
 * 要放宽必须另立一单并给出"不引入风险"的判据（见回执）。
 *
 * 为什么是"类别"而不是一张越长越旧的显式键名表（W22 验收 §2.1 抓到 7 条放行）：
 * 旧规则只列了 `tab/escape/f1/f2/f4/f10`，而 `Alt+F7`（begin-move）/`Alt+F8`（begin-resize）/
 * `Alt+F6`（cycle-group）/`Alt+Space`（activate-window-menu）/`Alt+Above_Tab`（switch-group）
 * 全是**作用在用户的窗口上**的全局抓取。这里按"`Alt` + 非字符键"整类覆盖，
 * 同时**故意不碰** `Alt+<字符>`：那是很多键盘布局输入第三层字符的正常写法（`Alt+Shift+n` 那种
 * 已被 `ime-switch` 先接住），不能误伤。
 */
const WM_ALT_KEYS = new Set([
  "tab", "escape", "space", "above_tab", "iso_next_group",
  "up", "down", "left", "right",
  "home", "end", "page_up", "page_down", "delete", "backspace", "insert",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
])

export const GLOBAL_SHORTCUT_RULES: readonly ShortcutRefusalRule[] = [
  {
    id: "a11y-screen-reader",
    code: COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE,
    matches: chord => has(chord, "super") && has(chord, "alt") && chord.key === "s",
    why: "`Super+Alt+S` 是 GNOME 的**屏幕阅读器开关**（Orca）：合成这一次按键会把用户的活动会话打开成朗读状态，而 agent 停下后它仍然开着。",
    advice: "要读屏请让用户自己在「设置 → 无障碍」里开/关；agent 需要屏幕上的文字请改用截图/OCR 或直接读文件。",
  },
  {
    id: "a11y-magnifier",
    code: COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE,
    matches: chord => has(chord, "super") && has(chord, "alt") && ["8", "=", "-", "equal", "minus", "kp_add", "kp_subtract"].includes(chord.key),
    why: "`Super+Alt+8`/`Super+Alt+=`/`Super+Alt+-` 是 GNOME 的**放大镜开关与缩放**：系统级无障碍功能，打开后用户可能找不到关闭入口。",
    advice: "需要放大画面请让用户自己在「设置 → 无障碍 → 缩放」里开；agent 要看细节请用更高分辨率的截图请求。",
  },
  {
    id: "a11y-sticky-keys",
    code: COMPUTER_USE_INPUT_ERRORS.BARE_MODIFIER,
    // 只拒"单发/叠发**修饰键本身**"（`press_key {key:"Shift"}` / `keys:["Shift_L"]` / `keys:["shift","shift"]`）。
    // `alt+shift`/`super+shift` 除外：那两条是输入法/布局切换，由下一条 `ime-switch` 接住。
    // `drag {modifier:[…]}` **不走这条规则** —— 拖动修饰键不是"按键"，见 `planComputerUseInput` 里的例外。
    matches: chord => !chord.key && chord.modifiers.length >= 1 && !(has(chord, "alt") && has(chord, "shift")) && !(has(chord, "super") && has(chord, "shift")),
    why: "只发修饰键（单独或叠加，尤其连按 5 次 Shift）会触发**粘滞键/慢键**这类系统无障碍功能，且对当前窗口没有任何输入意义。",
    advice: "要按住修饰键做组合输入，请把组合键一次性交给 agent 的窗口作用域输入；不要单发修饰键。",
  },
  {
    id: "media-keys",
    code: COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY,
    matches: chord => chord.key.startsWith("xf86") || ["audioraisevolume", "audiolowervolume", "audiomute", "audiomicmute", "audiplay", "audionext", "audioprev", "audiostop", "monbrightnessup", "monbrightnessdown", "displayoff", "sleep", "suspend", "hibernate", "wlan", "bluetooth", "touchpad toggle", "touchpadtoggle", "kbdillumup", "kbdillumdown", "kbdillumtoggle", "eject", "poweroff", "standby"].includes(chord.key),
    why: "媒体键/亮度键/睡眠/无线开关由桌面或硬件直接处理：合成它们会改用户的音量、亮度甚至把机器挂起。",
    advice: "需要静音/调音量这类效果，请让用户自己按键，或改用在 agent 自己窗口内可完成的替代动作。",
  },
  {
    id: "ime-switch",
    code: COMPUTER_USE_INPUT_ERRORS.IME_SHORTCUT,
    matches: chord => (has(chord, "super") && chord.key === "space") || (has(chord, "ctrl") && chord.key === "space") || (has(chord, "alt") && chord.key === "shift") || (has(chord, "super") && chord.key === "shift")
      // 纯修饰键的 `Alt+Shift` / `Super+Shift`：也是输入法/键盘布局切换（修饰键在解析里没有 key）。
      || (!chord.key && ((has(chord, "alt") && has(chord, "shift")) || (has(chord, "super") && has(chord, "shift")))),
    why: "`Super+Space`/`Ctrl+Space`/`Alt+Shift` 是**输入法/键盘布局切换**：宿主全局捕获，改了之后用户打的字会变成另一种布局。",
    advice: "文本输入请用 `type_text` 把完整文本送进 agent 自己的窗口（不依赖用户当前输入法），不要切换用户的输入法。",
  },
  {
    id: "wm-window-switch",
    code: COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT,
    // `Alt` + 非字符键：**整类保守拒绝**（其中哪些在本机实测有绑定、哪些没有，逐条见 WM_ALT_KEYS 的注释）。
    matches: chord => has(chord, "alt") && chord.key !== "" && WM_ALT_KEYS.has(chord.key),
    why: "`Alt` + 非字符键这一类里，本机**只读实测**有 `<Alt>` 绑定的 11 个是 `Alt+Tab`(switch-windows)、`Alt+Escape`(cycle-windows)、`Alt+Space`(activate-window-menu)、`Alt+Above_Tab`(switch-group)、`Alt+F1`(panel-main-menu)、`Alt+F2`(panel-run-dialog)、`Alt+F4`(close)、`Alt+F6`(cycle-group)、`Alt+F7`(begin-move)、`Alt+F8`(begin-resize)、`Alt+F10`(toggle-maximized) —— 它们由**窗口管理器**在窗口之前全局抓取：合成它们会移动/缩放/切换/关闭**用户的**窗口，而不是 agent 自己的。同类的另 17 个键（`Alt+方向键`/`Alt+Home`/`Alt+End`/`Alt+Page_Up`/`Alt+Page_Down`/`Alt+Delete`/`Alt+BackSpace`/`Alt+Insert`/`Alt+F3`/`Alt+F5`/`Alt+F9`/`Alt+F11`/`Alt+F12`/`Alt+ISO_Next_Group`）本机这次枚举里**没有**绑定，是被**整类保守拒绝**（别的 GNOME 版本/发行版/其它 WM 上有），不是「本机实测被抓取」——方向是 fail-closed，代价是这些应用内写法在本机也发不出去。",
    advice: "要在 agent 自己的窗口之间切换，请用该窗口内部的应用级操作；不要用 WM 快捷键。",
  },
  {
    id: "accessx-toggle",
    code: COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE,
    // XKB AccessX 切换键与 X core 锁键：改的是 **X 服务端**状态，gsettings 快照抓不到也恢复不了。
    matches: chord => ACCESSX_KEYSYMS.has(chord.key),
    why: "`AccessX_Enable`/`StickyKeys_Enable`/`SlowKeys_Enable`/`BounceKeys_Enable`/`MouseKeys_Enable`/`RepeatKeys_Enable`/`Caps_Lock`/`Num_Lock` 这类键改的是 **X 服务端**的键盘控制位（不是 gsettings）：本模块的 9 键快照既抓不到也恢复不了，合成它们会把用户的输入行为改掉而用户不知道原因。",
    advice: "无障碍键盘功能请让用户自己在「设置 → 无障碍 → 输入辅助」里开；agent 不要发 AccessX/锁键。",
  },
  {
    id: "vt-switch-and-desktop",
    code: COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT,
    matches: chord => has(chord, "ctrl") && has(chord, "alt"),
    why: "`Ctrl+Alt+*` 是控制台/VT 切换与桌面级快捷键（`Ctrl+Alt+F1..F12` 会切走用户的整个图形会话）。",
    advice: "这类系统级动作请让用户自己执行；agent 不发 `Ctrl+Alt+*`。",
  },
  {
    id: "super-combos",
    code: COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT,
    matches: chord => has(chord, "super"),
    why: "任何带 `Super`（Win/Cmd）的组合都会先被桌面 shell 捕获（锁屏、通知、活动概览、输入法、无障碍…），根本到不了 agent 自己的窗口。",
    advice: "改用应用内的等价操作（菜单/快捷键表里 non-Super 的那一个），或让用户自己按。",
  },
  {
    id: "sysrq",
    code: COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT,
    matches: chord => chord.key === "sysrq" || chord.key === "print",
    why: "`SysRq`/`Print` 由内核/桌面全局处理（SysRq 组合可以直接重启或杀掉进程）。",
    advice: "不要合成 SysRq/Print；需要截图请用 agent 自己的采集通道。",
  },
]

/** 一次组合键的判定：拒绝时给**规则、码、为什么、用户怎么做**（不给自由文本让人猜）。 */
export type ShortcutVerdict =
  | { readonly refused: false }
  | { readonly refused: true; readonly code: string; readonly rule: string; readonly why: string; readonly advice: string; readonly combo: string }

/** 判定一个组合键是否属于"系统会先捕获"的那一类（纯函数，可单独验）。 */
export function globalShortcutVerdict(combo: string): ShortcutVerdict {
  const chord = parseKeyChord(combo)
  // 兜底即"**未识别语法**"：凡解析不出来的写法，守卫都无法证明它只会进 agent 自己的窗口。
  // 这里点名 GNOME 的绑定写法（`<Alt>F7` / `<Shift><Alt>Tab`，`gsettings` 里逐字就是这样存的），
  // 因为它是**唯一**一种"桌面自己认、而驱动不认"的写法：`<Alt>F7` 正是 mutter 的 begin-move。
  if (!chord) return { refused: true, code: COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT, rule: "unparsable", why: `键组合 ${JSON.stringify(combo)} 解析不出来（**未识别语法**）：含空白分隔的多段、或尖括号没归一到修饰键（GNOME 的绑定写法 \`<Alt>F7\`/\`<Shift><Alt>Tab\` 就是这一类）——无法证明它只会进 agent 自己的窗口。`, advice: "用驱动认得的写法（例如 `ctrl+c`、`Return`，或 xdotool 的 `<ctrl>+c`）；认不出来的组合 agent 不发。", combo }
  for (const rule of GLOBAL_SHORTCUT_RULES) {
    if (rule.matches(chord)) return { refused: true, code: rule.code, rule: rule.id, why: rule.why, advice: rule.advice, combo }
  }
  return { refused: false }
}

/**
 * 同一个判定，但带上**是哪个工具在发**这个上下文（W22 一号发现的收口之一）。
 *
 * 唯一的例外是 `drag`：`DragInput.modifier` 是**拖动的修饰键**（`shift` 拖动＝选择/拖放，
 * `ctrl` 拖动＝复制），它不是一个"按键"事件，所以不适用 `a11y-sticky-keys` 那条"单发修饰键"规则。
 * 而 `super`/`ctrl+alt` 这样的**桌面级**修饰键仍然照拒（`super-combos` / `vt-switch-and-desktop`
 * 都不看主键）—— Super+拖动就是移动用户的窗口。
 * 其余工具一律用同一张规则表：**没有"这个工具就放宽"的口子**。
 *
 * **豁免按机器状态取反**（残留口子⑤ 的收口，见 `dragModifierMachineState`）：那条豁免**留在这里不动**
 * （删掉它会在"拖动修饰键＝Super"这类机器上误拒 `shift`/`ctrl` 拖动），但**这台机器**把
 * `mouse-button-modifier` 绑成哪个修饰键，就决定"按住它拖动"会不会动**用户的**窗口 ——
 * 实测到了就拒，测不到就按出厂默认史 fail-closed。判据是**机器读数**，不是"猜这台机器像本机"。
 */
export function shortcutVerdictForTool(tool: CuaInputToolName, combo: string, context: DragShortcutContext = {}): ShortcutVerdict {
  const chord = parseKeyChord(combo)
  if (!chord) return globalShortcutVerdict(combo)
  const dragModifier = tool === "drag" && !chord.key && chord.modifiers.length > 0
  for (const rule of GLOBAL_SHORTCUT_RULES) {
    if (dragModifier && rule.id === "a11y-sticky-keys") continue
    if (rule.matches(chord)) return { refused: true, code: rule.code, rule: rule.id, why: rule.why, advice: rule.advice, combo }
  }
  // 规则表**接不住**的那一条：拖动修饰键里含这台机器的「拖动移动窗口」修饰键。
  // 放在规则表**之后** ⇒ `super`（super-combos）、`ctrl+alt`（vt-switch）、`alt+shift`（ime-switch）
  // 这些既有拒绝的**理由不变**；本检查只接住"拖动修饰键**只有**它一个"那种写法（`drag {modifier:["alt"]}`）。
  if (dragModifier && context.machine) {
    const held = chord.modifiers.filter(modifier => context.machine!.modifiers.includes(modifier))
    if (held.length) return {
      refused: true,
      code: COMPUTER_USE_INPUT_ERRORS.DRAG_WINDOW_MOVE,
      rule: DRAG_WINDOW_MOVE_RULE,
      why: dragWindowMoveWhy(held, context.machine),
      advice: DRAG_WINDOW_MOVE_ADVICE,
      combo,
    }
  }
  return { refused: false }
}

// ── 机器状态：这台机器把「修饰键 + 拖动」绑成「移动/缩放窗口」用的是哪个修饰键 ───────────
//
// 为什么守卫必须拿到这一条（`bugfixHistory/COMPUTER-USE-RESIDUAL-HOLES-20260926.md` §6.1 登记的设计缺口）：
// `drag` 跳过 `a11y-sticky-keys` 之后，`drag {modifier:["alt"]}` 被放行 —— 而这条放行**是对是错取决于机器**：
//   · 本机（Ubuntu 22.04 / gsettings-desktop-schemas 42.0）`mouse-button-modifier` 的**编译期默认值**就是
//     `'<Super>'`：`GSETTINGS_BACKEND=memory gsettings get …` 与 `gschemas.compiled` 的 schema XML 都逐字如此
//     （`/usr/share/glib-2.0/schemas/org.gnome.desktop.wm.preferences.gschema.xml:6-7`）
//     ⇒ 本机按住 `Alt` 拖动**不会**移动窗口 ⇒ 放行是对的（上一次回执的校准依据）；
//   · 但 `'<Super>'` **不是** GNOME 一贯的默认：上游 `gsettings-desktop-schemas` 3.5.2 的 NEWS 逐字是
//     "Change the default mouse-button-modifier to Super (#607797)" ⇒ **3.5.2 之前默认是 `'<Alt>'`**；
//     而且**本机同一份 schemas 里** Ubuntu 的 `:Unity` profile override 逐字仍是
//     `mouse-button-modifier = '<Alt>'`（`10_ubuntu-settings.gschema.override:169`）
//     ⇒ 「`<Alt>` ＝ Alt+拖动移动用户的窗口」这种机器形态**今天仍然在出厂/发行版里存在**。
// 旧实现把"放行"**硬编码**了：换一台 `<Alt>` 的机器，`drag {modifier:["alt"]}` 就是「按住 Alt 拖动指针下的
// 窗口」而守卫照放 —— 这不是概率问题，是**判据缺了"机器状态"这一个输入**（守卫没有任何机器状态输入）。
// ⇒ 现在按机器状态取反：实测到的拖动修饰键落在拖动的修饰键里 ⇒ 拒；测不到 ⇒ 按出厂默认史 fail-closed 拒，
//   并把**读数来源**写进 reason（实测原文 / 兜底），不把"我以为"写成"这台机器是"。

/** 机器状态读数的来源与内容（`gsettings get org.gnome.desktop.wm.preferences mouse-button-modifier`，只读）。 */
export interface DesktopMachineFacts {
  /** `gsettings get` 的**原文**（逐字，不归一）；`null` ＝ 这次没读到。 */
  readonly mouseButtonModifierRaw: string | null
  /** 归一后的修饰键名（`'<Alt>'` → `["alt"]`）；**读不到或认不出来**时为 `null`（＝不知道）。 */
  readonly desktopDragModifiers: readonly string[] | null
  /** 这次读数可不可用（`gsettings` 退出码 0 **且**值认得出来）。`false` ⇒ 调用方必须按"不知道"处理。 */
  readonly readable: boolean
  readonly error?: string
}

/** 机器状态只读读数的两个坐标（产品只读枚举的命令逐字）。 */
export const MOUSE_BUTTON_MODIFIER_SCHEMA = "org.gnome.desktop.wm.preferences"
export const MOUSE_BUTTON_MODIFIER_KEY = "mouse-button-modifier"

/**
 * 把 `gsettings get … mouse-button-modifier` 的原文归一成"按住它拖动会移动/缩放窗口的那个修饰键"。
 * 返回 `null` ＝ **不知道**（值认不出来 ⇒ fail-closed）；返回 `[]` ＝ 明确知道"没有绑定"（空值）。
 * `disabled`/`none` 之类写法本单**没有**证据说明 mutter 会当成"不绑定" ⇒ 一律按"不知道"处理，
 * 不拿猜测当机器状态（"记录的东西必须是实际发生的事"）。
 */
export function desktopDragModifiersOf(rawValue: string | null | undefined): readonly string[] | null {
  if (rawValue === null || rawValue === undefined) return null
  const text = rawValue.trim().replace(/^'|'$/g, "").trim()
  if (!text) return []
  const found: string[] = []
  for (const token of text.split("+").map(part => part.trim()).filter(Boolean)) {
    const parts = token.includes("<") ? token.match(/<[^>]*>/g) ?? [] : [token]
    for (const part of parts) {
      const modifier = normalizeModifierName(part)
      if (!modifier) return null
      if (!found.includes(modifier)) found.push(modifier)
    }
  }
  return found.length ? normalizeModifiers(found) : null
}

/**
 * **不知道**机器状态时的 fail-closed 口径：GNOME 出厂默认**史**里出现过的那些修饰键
 * （3.5.2 之前 `'<Alt>'`、3.5.2 起 `'<Super>'`；本机 Ubuntu 的 `:Unity` profile 也是 `'<Alt>'`）。
 * `super` 本来就被 `super-combos` 无条件拒（不看主键），所以这条兜底实际收紧的只有"`alt` 单独作拖动修饰键"；
 * `shift`/`ctrl` 拖动（选择、拖放、复制）**不受影响** —— 没有任何出厂默认把它们绑成"移动窗口"，
 * 不拿不可达的形态去误伤应用内正常用法。
 */
const ASSUMED_DRAG_MODIFIERS = ["alt", "super"] as const

/** 记在哪：产品路径由 `captureDesktopSettingsSnapshot` 在**开会话时**只读读一次并记下来。 */
let lastMachineFacts: DesktopMachineFacts | undefined

/**
 * 记下一次只读机器读数（传 `undefined` ＝ 清空）。产品路径不需要手动调：会话快照里有这一步。
 * 显式参数（`InputScopeState.mouseButtonModifier`）**优先**于这里记的读数。
 */
export function rememberDesktopMachineFacts(facts: DesktopMachineFacts | undefined): void { lastMachineFacts = facts }

/** 最近一次只读机器读数（可能来自**更早**的会话；`undefined` ＝ 本进程还没读过）。 */
export function desktopMachineFacts(): DesktopMachineFacts | undefined { return lastMachineFacts }

/** 判 `drag` 的拖动修饰键时用得上的机器状态：实测 or fail-closed 兜底。 */
export interface DragModifierMachineState {
  /** 有效集合：**实测**时 ＝ 这台机器真实的拖动修饰键；不知道时 ＝ `ASSUMED_DRAG_MODIFIERS`。 */
  readonly modifiers: readonly string[]
  /** 这个集合是不是**实测**的（`false` ＝ 守卫不知道机器状态，按出厂默认史 fail-closed）。 */
  readonly measured: boolean
  /** 实测时的原文读数（写进 reason；兜底时为 `null`）。 */
  readonly raw: string | null
  /** 读数来源：`caller` ＝ 调用方在 scope 里给了 / `session` ＝ 会话快照里读到的 / `assumed` ＝ 兜底。 */
  readonly source: "caller" | "session" | "assumed"
}

/** `drag` 判定需要的机器状态（省略 ⇒ 用模块记下的最近一次只读读数；都没有 ⇒ fail-closed 兜底）。 */
export interface DragShortcutContext { readonly machine?: DragModifierMachineState }

const DRAG_WINDOW_MOVE_RULE = "drag-moves-user-window"
const DRAG_WINDOW_MOVE_ADVICE = "拖动要选择/拖放/复制请用 `shift` 或 `ctrl` 作修饰键；需要移动或缩放窗口请让用户自己拖。若这台机器确实把「拖动移动窗口」设成了别的键，请把**只读读数**一并交给守卫（`scope.mouseButtonModifier` ＝ `gsettings get org.gnome.desktop.wm.preferences mouse-button-modifier` 的原文）——守卫按机器状态判，不猜。"

/** 拒绝理由必须写清"我用的是哪一次读数、它是不是实测的"（不许把兜底写成"这台机器是…"）。 */
function dragWindowMoveWhy(held: readonly string[], machine: DragModifierMachineState): string {
  const keys = held.map(name => `\`${name}\``).join("、")
  const binding = "`org.gnome.desktop.wm.preferences mouse-button-modifier`"
  const normalized = machine.modifiers.length ? machine.modifiers.map(name => `\`${name}\``).join("+") : "（无）"
  if (machine.measured) return `这次拖动按住 ${keys}，而**这台机器**的 ${binding} 只读读数是 ${JSON.stringify(machine.raw ?? "")}（归一：${normalized}）：按住它拖动＝窗口管理器**移动**（左键）/缩放（中键）**指针下的那个窗口** —— 守卫无法证明指针下一定是 agent 自己的窗口，而不是用户的。`
  const where = machine.source === "caller"
    ? `调用方给的读数 ${JSON.stringify(machine.raw ?? "")} 认不出来`
    : machine.raw === null
      ? "调用方没给、会话也还没开过 ⇒ 本进程还没读过它"
      : `最近一次只读读数 ${JSON.stringify(machine.raw)} 认不出来`
  return `这次拖动按住 ${keys}，而守卫**不知道这台机器的** ${binding}（${where}）：上游默认值在 \`gsettings-desktop-schemas\` 3.5.2 才改成 \`<Super>\`（NEWS #607797），**之前**是 \`<Alt>\`，本机 Ubuntu 的 \`:Unity\` profile 逐字仍是 \`<Alt>\` ⇒ **无法排除**「按住它拖动＝移动用户的窗口」，按出厂默认史 fail-closed，不发。`
}

/**
 * 这次判定用哪一份机器状态：显式入参 → 最近一次只读读数 → fail-closed 兜底。
 * 三者都**不是**模型入参能碰到的东西（`scope` 由宿主给，不由工具参数给）。
 */
export function dragModifierMachineState(scope: InputScopeState): DragModifierMachineState {
  if (scope.mouseButtonModifier !== undefined) {
    const modifiers = desktopDragModifiersOf(scope.mouseButtonModifier)
    return modifiers === null
      ? { modifiers: [...ASSUMED_DRAG_MODIFIERS], measured: false, raw: scope.mouseButtonModifier, source: "caller" }
      : { modifiers, measured: true, raw: scope.mouseButtonModifier, source: "caller" }
  }
  const facts = desktopMachineFacts()
  if (facts?.desktopDragModifiers != null) return { modifiers: facts.desktopDragModifiers, measured: true, raw: facts.mouseButtonModifierRaw, source: "session" }
  return { modifiers: [...ASSUMED_DRAG_MODIFIERS], measured: false, raw: facts?.mouseButtonModifierRaw ?? null, source: "assumed" }
}

/**
 * **只读**读一次机器状态（`gsettings get … mouse-button-modifier`）：这就是"拖动豁免按机器状态取反"的输入。
 * 读不到也如实记（`readable:false` + 原因），**不填默认值** —— 调用方按"不知道"fail-closed。
 */
export async function readDesktopMachineFacts(options: { run: CommandRunner; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<DesktopMachineFacts> {
  const result = await options.run(["gsettings", "get", MOUSE_BUTTON_MODIFIER_SCHEMA, MOUSE_BUTTON_MODIFIER_KEY], { env: options.env, timeoutMs: 5000, ...options.signal ? { signal: options.signal } : {} })
    .catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
  const raw = result.code === 0 ? result.stdout.trim() : null
  const modifiers = raw === null ? null : desktopDragModifiersOf(raw)
  const readable = result.code === 0 && modifiers !== null
  return {
    mouseButtonModifierRaw: raw,
    desktopDragModifiers: modifiers,
    readable,
    ...readable ? {} : { error: `${COMPUTER_USE_INPUT_ERRORS.SNAPSHOT_UNAVAILABLE}: ${result.code === 0 ? `mouse-button-modifier 的读数 ${JSON.stringify(raw)} 认不出来` : result.stderr.trim() || `gsettings 退出码 ${String(result.code)}`}` },
  }
}

// ── 输入作用域：窗口优先；全局层需要显式同意 + 可见指示 ─────────────────────

/** 合成输入的作用域事实：来自驱动契约的窗口/进程目标。 */
export interface InputSurfaceFacts {
  /** 驱动契约里的窗口目标（`target` 字符串，或 `window_id`/`windowId`）。 */
  readonly windowId?: string
  /** 驱动契约里的进程目标（`target.pid` 或顶层 `pid`）。 */
  readonly pid?: number
}

export interface InputScopeState {
  /** 用户是否对"必要时走全局层"显式同意过（由用户动作产生，不由模型自称）。 */
  readonly consent: boolean
  /** 此刻是否有用户可见的"agent 正在控制输入"指示。 */
  readonly indicatorVisible: boolean
  /**
   * 此刻是否**已经有一个 computer-use 会话**。
   *
   * 为什么必须单独有这一位（VERIFY2 §5.2 / 本单残留口子④「先有鸡先有蛋」）：
   * **可见指示是会话的产物** —— `openComputerUseSession` 里才跑 `enforceVisibleIndicator`，
   * 而产品侧那个会话只在**首个被放行的输入之后**才开。于是会话还没开时 `indicatorVisible:false`
   * 的真实含义是"**还没有会话去点亮它**"，不是"用户看不到"。两者被同一个 `false` 表达，
   * 全局输入就会**永久全哑**：要指示 → 没会话 → 没有指示 → 拒 → 永远开不出会话。
   *
   * 缺省 `undefined` 表示**调用方没有表态**：按"指示状态已经确定"处理（与旧行为逐字一致），
   * 所以只传 `{consent, indicatorVisible}` 的既有调用方语义不变。
   */
  readonly sessionOpen?: boolean
  /**
   * **这台机器**的 `org.gnome.desktop.wm.preferences mouse-button-modifier` **只读读数原文**
   * （`gsettings get` 的 stdout，例如 `'<Super>'` / `'<Alt>'`；`null` ＝ 读不到）。
   *
   * 为什么必须单独有这一位（残留口子⑤ 的收口）：`drag` 的**裸修饰键豁免**"对不对"取决于机器 ——
   * 按住 `mouse-button-modifier` 拖动＝移动/缩放**指针下的窗口**。判据**不是**"本机是 `<Super>` 所以放行"
   * （那是硬编码），也不是"GNOME 默认是 `<Alt>` 所以一律拒"（那会在本机形态误拒）：是**读数**。
   *
   * 缺省 `undefined` ＝ 调用方没表态 ⇒ 用本模块最近一次只读读数（会话快照里读的那一次，见
   * `desktopMachineFacts()`）；连它也没有 ⇒ 按出厂默认史 fail-closed（`ASSUMED_DRAG_MODIFIERS`），
   * 并把这条拒绝标成 `provisional`（开会话 ＝ 本模块会去读一次，那次重判才是终局）。
   * ⚠️ 这一位**必须来自机器读数**，不许来自模型入参（它和 `consent` 一样是"不许自称"的事实）。
   */
  readonly mouseButtonModifier?: string | null
}

export type ComputerUseInputPlan =
  | { readonly deliver: true; readonly tool: CuaInputToolName; readonly scope: "window" | "global"; readonly surface: InputSurfaceFacts; readonly combos: readonly string[] }
  | {
      readonly deliver: false
      readonly code: string
      readonly rule: string
      readonly reason: string
      readonly advice: string
      readonly combos: readonly string[]
      /**
       * 这条拒绝**只因"守护它需要的事实还没读"而成立**，不是终局判据。
       *
       * 有两种成立条件，语义同一条：**开会话正是"把事实读出来"的那个动作**。
       *   1. `global-needs-indicator`（VERIFY2 §5.2 的收口）：全局层要可见指示，而可见指示是**会话的产物**，
       *      会话又只在首个输入被放行后才开 ⇒ 会话还没开时这一条的含义是"还没有会话去点亮它"。
       *   2. `drag-moves-user-window` 的**兜底分支**（残留口子⑤ 的收口）：`drag` 的拖动修饰键安不安全
       *      取决于机器的 `mouse-button-modifier`，而这个读数就在会话快照里读（`readDesktopMachineFacts`）。
       *      还没读过 ⇒ 按出厂默认史 fail-closed 先拒，但不能当终局。
       * 调用方见到这个标记**必须**：先开会话，再用会话里**真实的**事实重判一次；那次仍拒才是终局。
       * 直接把它当终局 = 全局输入永久全哑 / 拖动豁免永远只能按兜底判。
       *
       * 其余拒绝（工具分类 / 未同意 / 键字段取不出 / 快照不可用 / **已实测到机器读数的**
       * `drag-moves-user-window`）**没有**这个标记，见到即终局 —— 被拒的输入照旧不开会话、不动桌面、不发通知。
       */
      readonly provisional?: true
    }

const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** 从驱动入参里收出"这次输入要发给谁"：`target`（字符串/对象）、`window_id`/`windowId`、`pid`。 */
export function inputSurfaceOf(argumentsValue: unknown): InputSurfaceFacts {
  const args = asRecord(argumentsValue) ?? {}
  const input = asRecord(args.input) ?? args
  const target = input.target ?? args.target
  const targetRecord = asRecord(target)
  // 目标是 `target`（字符串/数字/对象）、legacy 顶层 `window_id`/`windowId`，或对象里的同名字段。
  const windowIdRaw = typeof target === "string" || typeof target === "number"
    ? target
    : targetRecord?.window_id ?? targetRecord?.windowId ?? input.window_id ?? input.windowId ?? args.window_id ?? args.windowId
  const windowId = typeof windowIdRaw === "string" && windowIdRaw.trim() ? windowIdRaw.trim() : typeof windowIdRaw === "number" ? String(windowIdRaw) : undefined
  const pidRaw = targetRecord?.pid ?? input.pid ?? args.pid
  const pid = typeof pidRaw === "number" && Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : typeof pidRaw === "string" && /^\d+$/.test(pidRaw) ? Number(pidRaw) : undefined
  return { ...windowId ? { windowId } : {}, ...pid !== undefined ? { pid } : {} }
}

/** 显式 desktop 目标不能被旁边的窗口编号覆盖；前台投递也不能当成后台窗口操作。 */
export function computerUseSurfaceRefusal(tool: string, argumentsValue: unknown): {code:string;rule:string;reason:string;advice:string;combos:readonly string[]} | undefined {
  if (cuaRawDriverToolName(tool) === undefined) return undefined
  const args = asRecord(argumentsValue) ?? {}, input = asRecord(args.input) ?? args
  const targets = [asRecord(args.target), asRecord(input.target)]
  const desktop = [args.scope,input.scope,args.capture_scope,input.capture_scope].some(value => typeof value === "string" && value.toLowerCase() === "desktop") ||
    targets.some(target => target && [target.type,target.kind,target.tag].some(value => typeof value === "string" && value.toLowerCase() === "desktop")) ||
    targets.some(target => target && (target.display_id !== undefined || target.displayId !== undefined))
  if (desktop) return {code:"CUA_DESKTOP_SCOPE_REFUSED",rule:"desktop-scope-refused",reason:"该调用显式选择了整个桌面；同时填写窗口编号不会把桌面操作缩小到该窗口。",advice:"使用明确的窗口目标和 window 作用域。",combos:[]}
  if ([args.delivery_mode,input.delivery_mode,args.deliveryMode,input.deliveryMode].includes("foreground"))
    return {code:"CUA_FOREGROUND_DELIVERY_REFUSED",rule:"foreground-delivery-refused",reason:"前台投递会占用用户当前桌面的焦点与输入通道。",advice:"使用后台窗口投递；后台拒绝不授权转为前台重试。",combos:[]}
  const raw = cuaRawDriverToolName(tool)
  if (raw === "get_accessibility_tree" || raw === "list_apps")
    return {code:"CUA_DESKTOP_DISCOVERY_REFUSED",rule:"desktop-discovery-refused",reason:"该发现入口会枚举用户整个桌面或应用清单，超出本次窗口操作范围。",advice:"从本任务已知进程取得窗口，并只读取目标窗口。",combos:[]}
  if (raw === "list_windows" && inputSurfaceOf(argumentsValue).pid === undefined)
    return {code:"CUA_WINDOW_SCOPE_REQUIRED",rule:"window-scope-required",reason:"枚举窗口必须限定到本任务已知的进程，不能默认遍历整个桌面。",advice:"显式提供 pid 过滤条件。",combos:[]}
  if (["get_window_state","verify_state"].includes(raw ?? "")) {
    const surface = inputSurfaceOf(argumentsValue)
    if (surface.pid === undefined || surface.windowId === undefined)
      return {code:"CUA_WINDOW_SCOPE_REQUIRED",rule:"window-scope-required",reason:"窗口观察需要同时给出进程和窗口编号。",advice:"显式提供 pid 与 window_id。",combos:[]}
  }
  return undefined
}

/** 驱动入参里可能承载"要发的键"的字段（顺序即优先级；`keys`/`key` 是规范形，排在最前）。 */
const COMBO_FIELDS = ["keys", "key", "hotkey", "combination", "combo", "sequence"] as const
/** 驱动入参里可能承载"修饰键"的字段。`PressKeyInput.modifiers` 与 `DragInput.modifier` 都在契约里。 */
const MODIFIER_FIELDS = ["modifiers", "modifier"] as const

const stringsOf = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/**
 * 从驱动入参里收出这次要按的**完整组合**。
 *
 * 形状（`@trycua/cua-driver@0.28.0` 的 `cua_driver_contract.d.ts`，逐字）：
 * ```
 * PressKeyInput { key: string; target?; scope?; session?; modifiers?: Array<string> }
 * DragInput     { fromX; fromY; toX; toY; target?; scope?; session?; durationMs?; steps?; button?; modifier?: Array<string> }
 * HotkeyInput   { keys: Array<string>; target?; scope?; session? }
 * ```
 * 驱动自己的校验文案也是 `Provide 'keys' array (e.g. ["ctrl","c"]) or 'key'+'modifiers' parameters.`
 *
 * **W22 验收 §2.2a 的那个洞**：旧实现只读 `key/keys/hotkey/combination/combo/sequence`，
 * **从不读 `modifiers`/`modifier`** —— 于是
 * `press_key {key:"s",modifiers:["super","alt"]}` 在守卫眼里只是"往窗口里按一下 s"，
 * 用户投诉的 `Super+Alt+S` 原样发得出去。现在两条通道都被读，并且：
 *   · `key` + `modifiers`/`modifier` 合成**同一个完整组合**（`{key:"s",modifiers:["super","alt"]}` → `super+alt+s`）；
 *   · `keys:["ctrl","c"]`（驱动说明书里的**规范形**）归一成 `ctrl+c`，而不是拆成两个"裸修饰键"误拒。
 *
 * **残留口子①（VERIFY2 §6.1，一行级根因）**：交付时的实现把"只有修饰键字段"这条兜底写成
 * `if (!combinations.length)`，而判定集已经被种子 `[...strayModifierNames]` 占成非空 ⇒ 该兜底
 * **永不执行**；于是被静默丢掉的不是杂名而是**真修饰键**：`drag {modifier:["super","x"]}` 只判 `x`，
 * 而 `drag` 是契约里唯一"没有 `key` 字段来强制合并"的工具 ⇒ `Super+拖动＝移动用户的窗口`原样复发。
 * 现在：真修饰键**永远**进判定，杂名**额外追加** —— 是"都要"，不是"二选一"。
 */
export function inputCombosOf(argumentsValue: unknown): string[] {
  const args = asRecord(argumentsValue) ?? {}
  const input = asRecord(args.input) ?? args
  const read = (fields: readonly string[]): string[] => {
    const collected: string[] = []
    for (const field of fields) collected.push(...stringsOf(input[field] ?? args[field]))
    return collected
  }
  const modifierValues = read(MODIFIER_FIELDS)
  const normalizedModifiers = normalizeModifiers(modifierValues)
  // `modifiers`/`modifier` 是驱动契约里的**修饰键**字段：里面若出现归一后不是修饰键的名字，
  // 说明入参把主键塞进了修饰键通道（`modifiers:["XF86AudioRaiseVolume"]`）。那种名字**不能静默丢掉**
  // （丢掉就等于把主键变成空组合 ⇒ 放行），一律单独送进判定。
  const strayModifierNames = modifierValues.filter(name => normalizeModifierName(name) === undefined)
  // 判定集从**空**开始，修饰键通道的两类名字最后再进（见函数尾部）——
  // 不能像旧实现那样拿 `[...strayModifierNames]` 当种子：那样杂名会把 `combinations` 占成非空，
  // 「只给了修饰键字段」的兜底分支永不执行，被静默丢掉的不是杂名而是**真修饰键**。
  const combinations: string[] = []
  // 归一后的修饰键是否已经**被某个组合吸收**（吸收 = 已经在判定集里，不会被静默丢掉）。
  // 目前只有 `key` 通道的合成会吸收（`{key:"s",modifiers:["super","alt"]}` → `super+alt+s`）。
  let modifiersRepresented = false
  for (let index = 0; index < COMBO_FIELDS.length; index += 1) {
    const values = stringsOf(input[COMBO_FIELDS[index]!] ?? args[COMBO_FIELDS[index]!])
    if (!values.length) continue
    // `keys` 是数组形：开头的修饰键与紧随其后的主键属于**同一个**组合（`["ctrl","c"]` → `ctrl+c`）。
    // 没有主键的裸修饰键**原样留下**，让 `a11y-sticky-keys` 规则去拒 —— 不能被"合成"吃掉。
    if (COMBO_FIELDS[index] === "keys") {
      const pending = [...values]
      if (pending.length > 1 && pending[0] !== undefined && normalizeModifierName(pending[0]) !== undefined) {
        const leading: string[] = []
        // 只把**紧跟在开头之后**的那一段修饰键并进同一个组合；碰到主键即停。
        while (pending.length > 1 && pending[0] !== undefined && normalizeModifierName(pending[0]) !== undefined) leading.push(pending.shift()!)
        combinations.push(`${normalizeModifiers(leading).join("+")}+${pending[0]!}`, ...pending.slice(1))
      } else combinations.push(...pending)
      continue
    }
    // `key` 是单值：它带 `modifiers` 时合成完整组合（`{key:"s",modifiers:["super","alt"]}` → `super+alt+s`）。
    // 只有"值本身没有修饰键"时才合并：值的写法里已有修饰键（`key:"ctrl+c"` + `modifiers:["shift"]`）时
    // 以写法自身的语义为准，不叠一层可能改变含义的前缀 —— **但那种写法下修饰键没有被吸收**，
    // 所以收尾时必须让归一后的修饰键单独进判定（否则 `{key:"ctrl+c",modifiers:["super"]}` 会把 super 丢掉）。
    if (COMBO_FIELDS[index] === "key") {
      for (const value of values) {
        const tokens = value.trim().split(/\s+/).filter(Boolean)
        const single = tokens.length === 1 ? tokens[0]! : undefined
        const mergeable = single !== undefined && normalizedModifiers.length > 0 && parseKeyChord(single)?.modifiers.length === 0
        if (mergeable) modifiersRepresented = true
        combinations.push(mergeable ? `${normalizedModifiers.join("+")}+${single}` : value)
      }
      continue
    }
    combinations.push(...values)
  }
  // ── 修饰键通道的收尾（VERIFY2 §6.1 的残留口子①，一行级根因就在这里）─────────────────
  // 契约里 `modifiers`/`modifier` 是**修饰键**字段，归一后的**真修饰键整体**必须进判定：
  //   · 只给了修饰键字段（`drag {modifier:["shift"]}`）或 `key` 字段整个缺失 ⇒ 这就是唯一的组合；
  //     裸 `super` 会被 `super-combos` 拒（Super+拖动＝移动用户窗口），`alt`/`ctrl+alt` 也被各自规则接住；
  //     而 `shift` 单独作**拖动**修饰键是正常用法（选择/拖放），不该被 `a11y-sticky-keys` 当成"单发修饰键"
  //     误拒（那条规则针对**按键** `press_key {key:"Shift"}`，连按 5 次＝粘滞键序列）—— `drag` 的这条例外
  //     在 `shortcutVerdictForTool` 里，不在本函数。
  //   · 也覆盖"合并不成立"的那些写法：`{key:"a b",…}`（多 token）、`{key:"ctrl+c",modifiers:[…]}`（写法自带修饰键）
  //     —— 那时修饰键没被吸收，旧实现同样会把它们静默丢掉。
  // `modifiersRepresented` 为真是**唯一**跳过它的情形：那时修饰键已经作为别的组合的一部分被判过，
  // 再单独判一次会把 `{key:"a",modifiers:["shift"]}`（打大写，正常用法）误拒成"单发修饰键"。
  if (normalizedModifiers.length && !modifiersRepresented) combinations.push(normalizedModifiers.join("+"))
  // 修饰键通道里**非修饰键**的名字（`modifiers:["XF86AudioRaiseVolume"]`）也**不能静默丢掉**
  // （丢掉就等于把主键变成空组合 ⇒ 放行），一律**额外追加**进判定 —— 与真修饰键是"都要"，不是"二选一"。
  combinations.push(...strayModifierNames)
  // 驱动允许 `xdotool key ctrl+c v` 这种**空白分隔的序列**：按空白拆开逐个判定，
  // 否则 `Super+Alt+s` 混在一串里会被当成一个奇怪的主键溜过去。同一组合只判一次（去重不改顺序）。
  return [...new Set(combinations.flatMap(value => value.trim().split(/\s+/)).map(value => value.trim()).filter(Boolean))]
}

/**
 * 合成输入的唯一判据：工具是不是"没有可恢复路径的全局状态变更类" → 工具是不是"隐私通道类" →
 * 工具是不是输入类 → 有没有被全局捕获的键 → 作用域够不够 → 需不需要同意/指示。
 * 返回 `deliver:false` 时调用方**一个字节都不许发**（不是"发了再报错"）。
 */
export function planComputerUseInput(request: { tool: string; arguments: unknown; scope: InputScopeState }): ComputerUseInputPlan {
  const surfaceRefusal = computerUseSurfaceRefusal(request.tool, request.arguments)
  if (surfaceRefusal) return {deliver:false,...surfaceRefusal}
  // 第一判（W22-R3 起是**查表**，不是两条硬编码分支）：这个工具在不在拒绝表里（`state` 全局状态变更 /
  // `read` 隐私通道）。查表与改前的两条 `if` **逐字等价**（`clipboard_write` / `clipboard_read` 的
  // 码/rule/文案一个字没动），只是表里现在有 15 条 —— 每一条都是"能碰到用户对象、而本模块拿不出
  // 可信逆操作（或读走即泄漏）"的工具，逐条理由见 `CUA_DRIVER_TOOL_REFUSALS`。
  const refusal = cuaDriverToolRefusal(request.tool)
  if (refusal) return { deliver: false, code: refusal.code, rule: refusal.rule, reason: refusal.reason, advice: refusal.advice, combos: [] }
  const tool = cuaInputToolName(request.tool)
  if (!tool) {
    // 表外**不再**等于放行：不在全表里的 `cua_driver_native__*`（驱动升级新增/改名）一律不发。
    // 这条判据只认前缀 + 全表，不认"名字像不像危险"。**放宽方向为零**：改前这里根本没有判定，
    // 漏斗在第一行就把调用交回了驱动（`clipboard_read` 就是这么漏的）。
    if (cuaRawDriverToolName(request.tool) !== undefined && cuaDriverToolSpec(request.tool) === undefined) {
      const raw = cuaRawDriverToolName(request.tool)!
      return {
        deliver: false,
        code: COMPUTER_USE_INPUT_ERRORS.DRIVER_TOOL_UNCLASSIFIED,
        rule: "driver-tool-unclassified",
        reason: `${request.tool} 是 computer-use 驱动工具，但**不在**本模块的已分类全表（\`CUA_DRIVER_TOOL_CATALOG\`，${String(CUA_DRIVER_TOOL_NAMES.length)} 个）里：驱动是 \`listToolsJson()\` 列什么就注册什么（上游 \`computer-use-cua-driver-native/src/index.ts:93-118\`），所以这个多半是**驱动升级/换版新增或改名**的工具名。表外不再等于放行——\`${raw}\` 能不能碰到用户对象、有没有可恢复路径，本模块**没有它的判据**，因此默认不发。`,
        advice: "先按新工具的真实契约判定\"它能碰到什么用户对象\"，把它登记进 `CUA_DRIVER_TOOL_CATALOG` 并落进对应的一张表（input / 全局状态 / 隐私通道 / 明确放行的观测类）再放行；在那之前 agent 不用这个工具（要读窗口请用 `get_window_state`，要动窗口请用输入类工具并指名窗口）。",
        combos: [],
      }
    }
    return { deliver: false, code: COMPUTER_USE_INPUT_ERRORS.TOOL_UNKNOWN, rule: "not-an-input-tool", reason: `${request.tool} 不是 computer-use 的输入类工具，本模块不做判定。`, advice: "**在册**的非输入类工具原样放行（清单见 CUA_DRIVER_TOOL_CATALOG）；不在册的驱动工具名不发。输入类工具清单见 CUA_INPUT_TOOL_NAMES。", combos: [] }
  }
  const combos = inputCombosOf(request.arguments)
  // 契约里 `key`/`keys` 是**必填**（见 `KEY_REQUIRED_TOOLS`）：一个组合都收不出来 ⇒ 守卫手里是
  // "要发什么"的空白 ⇒ 一条规则都判不了 ⇒ 放行。这正是 VERIFY2 §6.2 的残留口子③：
  // `{keys:[1,2]}` / `{keys:[{k:"s"}]}` / `{keys:[]}` / `{key:123}` / `{key:null}` / `{key:"  "}` / `{}`
  // 当时**全部 DELIVERED**（`combos=[]`），安全性完全依赖驱动侧的类型校验（Rust 的 `String`/`Vec<String>`）。
  // 守卫的纪律是"证明不了安全就不发"，不能把安全性寄托在**下一层**的类型校验上（守卫存在的理由就是
  // 它是最后一层，而且驱动侧的校验文案/形状都不是本模块能证明的）。这条**只**对契约里必填键字段的
  // 那两个工具生效：`click`/`type_text`/`scroll`/`move_cursor`/`browser_dialog`/`drag` 的 `combos=[]`
  // 是正常形态，不受影响。
  if (KEY_REQUIRED_TOOLS.has(tool) && combos.length === 0)
    return { deliver: false, code: COMPUTER_USE_INPUT_ERRORS.KEY_FIELD_UNUSABLE, rule: "key-field-unusable", reason: `${tool} 的键字段（\`key\`/\`keys\`）取不出任何可判定的组合：字段缺失、不是字符串、或是空串/空数组 —— 守卫拿不到「要发什么」，也就无法证明它只会进 agent 自己的窗口。`, advice: "按驱动契约传 `press_key {key:\"…\"}` 或 `hotkey {keys:[\"ctrl\",\"c\"]}`；键字段写不出来的调用 agent 不发。", combos }
  // 机器状态（这台机器的 `mouse-button-modifier` 只读读数）**只**在这一处解析一次，逐条组合喂给判定：
  // 显式入参 → 本模块最近一次只读读数 → 出厂默认史 fail-closed 兜底。非 `drag` 的工具用不到它。
  const machine = dragModifierMachineState(request.scope)
  for (const combo of combos) {
    const verdict = shortcutVerdictForTool(tool, combo, { machine })
    if (verdict.refused) return {
      deliver: false,
      code: verdict.code,
      rule: verdict.rule,
      reason: verdict.why,
      advice: verdict.advice,
      combos,
      // 机器状态**还没实测过**（调用方没给、会话也还没开过）时的这一条**不是终局**：开会话＝本模块会做一次
      // 只读读数（`captureDesktopSettingsSnapshot` → `readDesktopMachineFacts`），拿真实读数重判一次才是终局。
      // 语义与 `global-needs-indicator` 的 `provisional` 相同。**判据没有放宽**：会话里若读到 `'<Alt>'`，
      // 第二次判定照样拒（那次是终局）；若读到 `'<Super>'`（本机形态），这条拖动确实不是"移动窗口"⇒ 放行。
      ...verdict.rule === DRAG_WINDOW_MOVE_RULE && !machine.measured && request.scope.sessionOpen !== true ? { provisional: true as const } : {},
    }
  }
  const surface = inputSurfaceOf(request.arguments)
  if (surface.windowId !== undefined || surface.pid !== undefined) return { deliver: true, tool, scope: "window", surface, combos }
  // 没有窗口/进程目标 ⇒ 这次输入只能进**用户的活动会话全局层**：
  // 那正是用户投诉的那条路径（合成按键被 WM/桌面全局快捷键捕获），必须显式同意 + 可见指示。
  if (!request.scope.consent) return { deliver: false, code: COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED, rule: "global-needs-consent", reason: "这次输入没有窗口/进程目标 ⇒ 只能打进用户的活动桌面会话（全局层），合成按键会先被桌面/WM 捕获。", advice: "优先给驱动传 `target`（窗口）或 `pid`；确实需要全局输入时，由**用户**显式同意本次 computer-use 会话。", combos }
  // 会话还没开（`sessionOpen === false`）时这一条**不是终局**：可见指示是会话的产物，
  // 此刻 `indicatorVisible:false` 的含义是"还没有会话去点亮它"，而不是"用户看不到"。
  // 当终局处理就是"先有鸡先有蛋"：要指示 ⇒ 没会话 ⇒ 没有指示 ⇒ 拒 ⇒ 会话永远开不出来 ⇒
  // 全局输入永久全哑（VERIFY2 §5.2）。带 `provisional:true` 交回调用方：先开会话（那正是点亮指示的
  // 动作），再拿会话里**真实的**指示状态重判一次；那次仍拒才是终局。**判据没有放宽** ——
  // 没有可见指示的全局输入最终仍旧不发，只是"能不能有指示"这件事改在会话开出来之后回答。
  if (!request.scope.indicatorVisible) return {
    deliver: false,
    code: COMPUTER_USE_INPUT_ERRORS.INDICATOR_REQUIRED,
    rule: "global-needs-indicator",
    reason: "用户已经同意全局输入，但此刻没有用户可见的\"agent 正在控制输入\"指示。",
    advice: "先让可见指示生效（系统通知/状态投影/无障碍状态图标），再发全局输入；没有指示就不发。",
    combos,
    ...request.scope.sessionOpen === false ? { provisional: true as const } : {},
  }
  return { deliver: true, tool, scope: "global", surface, combos }
}

// ── 桌面设置快照与恢复 ──────────────────────────────────────────────────────

/** 命令执行器（可注入：测试用假执行器，产品用真 `gsettings`）。 */
export interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (argv: readonly string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<CommandResult>

/** 默认执行器：真 `gsettings`/`xdotool`/`notify-send`，不经过 shell（无注入面），只读调用者的显示会话。 */
export const realCommandRunner: CommandRunner = (argv, options) => new Promise(resolve => {
  execFile(argv[0]!, argv.slice(1), { env: options.env, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
  })
})

/**
 * 会被 computer-use 触碰（或"触碰了也没人知道"）的桌面设置键。
 * 读不到也要**逐个记录**：这正是"我检查过这些键、没动"的证据。
 */
export interface DesktopSettingKey { readonly id: string; readonly schema: string; readonly key: string; readonly why: string }

export const A11Y_SNAPSHOT_KEYS: readonly DesktopSettingKey[] = [
  { id: "screen-reader-enabled", schema: "org.gnome.desktop.a11y.applications", key: "screen-reader-enabled", why: "屏幕阅读器（Orca）：用户投诉的正是它被合成按键打开" },
  { id: "screen-magnifier-enabled", schema: "org.gnome.desktop.a11y.applications", key: "screen-magnifier-enabled", why: "放大镜：改变整个桌面观感，用户可能找不到关闭入口" },
  { id: "screen-keyboard-enabled", schema: "org.gnome.desktop.a11y.applications", key: "screen-keyboard-enabled", why: "屏幕键盘：会在用户桌面上多出一块常驻窗口" },
  { id: "always-show-universal-access-status", schema: "org.gnome.desktop.a11y", key: "always-show-universal-access-status", why: "无障碍状态图标可见性：为 false 时用户看不到任何无障碍指示" },
  { id: "stickykeys-enable", schema: "org.gnome.desktop.a11y.keyboard", key: "stickykeys-enable", why: "粘滞键：连按修饰键会被系统打开" },
  { id: "slowkeys-enable", schema: "org.gnome.desktop.a11y.keyboard", key: "slowkeys-enable", why: "慢键：让用户的正常打字变慢" },
  { id: "mousekeys-enable", schema: "org.gnome.desktop.a11y.keyboard", key: "mousekeys-enable", why: "鼠标键：把小键盘变成指针" },
  { id: "input-sources", schema: "org.gnome.desktop.input-sources", key: "sources", why: "输入法/键盘布局清单" },
  { id: "input-sources-current", schema: "org.gnome.desktop.input-sources", key: "mru-sources", why: "最近使用的输入法（切换输入法就是改它）" },
]

export interface SnapshotEntry { readonly id: string; readonly schema: string; readonly key: string; readonly why: string; readonly value: string | null; readonly readable: boolean; readonly error?: string }
export interface DesktopSnapshot {
  readonly at: string
  /** 本次快照使用的显示会话（只读调用者的，不从别处借）。 */
  readonly display: string | null
  readonly entries: readonly SnapshotEntry[]
  readonly readableCount: number
  /** 供人看的一句话：读了几项、哪些读不到。 */
  readonly note: string
  /**
   * **机器状态**（只读）：这台机器的 `mouse-button-modifier`（＝按住它拖动会移动/缩放窗口的那个修饰键）。
   *
   * 它**不进** `entries`：`entries` 的口径是"会被 computer-use 触碰、会话结束要按原值恢复的键"，
   * 而这一条**我们从不写**（`restoreDesktopSettings` 只遍历 `entries`）—— 它只用来**判定**
   * （`drag` 的拖动豁免按机器状态取反，见 `dragModifierMachineState`）。
   * 可选：`captureDesktopSettingsSnapshot` 一定会填；显式构造快照的替身可以省略 ＝ 机器状态未知。
   */
  readonly machine?: DesktopMachineFacts
}

export interface SnapshotOptions { readonly env?: NodeJS.ProcessEnv; readonly run?: CommandRunner; readonly signal?: AbortSignal }

const displayOf = (env: NodeJS.ProcessEnv): string | null => env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim() || null

/** 读一次桌面设置快照。任何一项读不到都如实记 `readable:false` + 原因（不吞、不填默认值）。 */
export async function captureDesktopSettingsSnapshot(options: SnapshotOptions = {}): Promise<DesktopSnapshot> {
  const env = options.env ?? process.env, run = options.run ?? realCommandRunner
  const entries: SnapshotEntry[] = []
  for (const key of A11Y_SNAPSHOT_KEYS) {
    if (options.signal?.aborted) break
    const result = await run(["gsettings", "get", key.schema, key.key], { env, timeoutMs: 5000, ...options.signal ? { signal: options.signal } : {} }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
    const value = result.code === 0 ? result.stdout.trim() : null
    entries.push({ ...key, value, readable: result.code === 0, ...result.code === 0 ? {} : { error: `${COMPUTER_USE_INPUT_ERRORS.SNAPSHOT_UNAVAILABLE}: ${result.stderr.trim() || `gsettings 退出码 ${String(result.code)}`}` } })
  }
  const readableCount = entries.filter(entry => entry.readable).length
  const unreadable = entries.filter(entry => !entry.readable).map(entry => entry.id)
  // 机器状态：**只读**读一次 `mouse-button-modifier` 并记在本模块里（`desktopMachineFacts()`）。
  // 为什么放在快照这一步：拖动的修饰键豁免"对不对"取决于机器读数，而**开会话正是读它的那个时刻**
  // （产品路径的 `scope()` 不需要再多传一个字段；第二判就能拿会话里实测的读数重判）。
  // 读不到不填默认值：`readable:false`，判定那边按"不知道"fail-closed。
  const machine = await readDesktopMachineFacts({ run, env, ...options.signal ? { signal: options.signal } : {} })
  rememberDesktopMachineFacts(machine)
  return {
    at: new Date().toISOString(),
    display: displayOf(env),
    entries,
    readableCount,
    machine,
    note: unreadable.length === 0
      ? `已检查 ${String(entries.length)} 个键（a11y/输入法/键盘布局/状态图标）并记下原值；会话结束按原值恢复。`
      : `已检查 ${String(entries.length)} 个键，其中 ${String(unreadable.length)} 个读不到（${unreadable.join("、")}）——这些键无法快照，也**不假装**没动过，恢复时会逐个如实报告。`,
  }
}

export interface RestoreEntryReport { readonly id: string; readonly action: "restored" | "unchanged" | "skipped" | "failed"; readonly before: string | null; readonly now: string | null; readonly error?: string }
export interface RestoreReport {
  readonly at: string
  readonly entries: readonly RestoreEntryReport[]
  readonly restored: readonly string[]
  readonly failed: readonly string[]
  /** 本次会话是否真的改过桌面设置（false 时也要给"检查过、没动"的记录）。 */
  readonly changed: boolean
  readonly note: string
}

/**
 * 无条件恢复：把快照里的原值写回去（只写**现在与快照不同**的键；相同的记 `unchanged`）。
 * 失败逐条如实报告并汇总 `RESTORE_FAILED`——"恢复失败"绝不能当成"恢复成功"。
 */
export async function restoreDesktopSettings(snapshot: DesktopSnapshot, options: SnapshotOptions = {}): Promise<RestoreReport> {
  const env = options.env ?? process.env, run = options.run ?? realCommandRunner
  const entries: RestoreEntryReport[] = []
  for (const entry of snapshot.entries) {
    if (!entry.readable || entry.value === null) { entries.push({ id: entry.id, action: "skipped", before: entry.value, now: null, error: entry.error ?? `${COMPUTER_USE_INPUT_ERRORS.SNAPSHOT_UNAVAILABLE}: 快照里没有可恢复的原值` }); continue }
    const current = await run(["gsettings", "get", entry.schema, entry.key], { env, timeoutMs: 5000 }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
    const now = current.code === 0 ? current.stdout.trim() : null
    if (now === entry.value) { entries.push({ id: entry.id, action: "unchanged", before: entry.value, now }); continue }
    const write = await run(["gsettings", "set", entry.schema, entry.key, entry.value], { env, timeoutMs: 5000 }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
    if (write.code === 0) entries.push({ id: entry.id, action: "restored", before: entry.value, now: entry.value })
    else entries.push({ id: entry.id, action: "failed", before: entry.value, now, error: `${COMPUTER_USE_INPUT_ERRORS.RESTORE_FAILED}: ${entry.schema} ${entry.key} 写回 ${entry.value} 失败（${write.stderr.trim() || `退出码 ${String(write.code)}`}）` })
  }
  const restored = entries.filter(entry => entry.action === "restored").map(entry => entry.id)
  const failed = entries.filter(entry => entry.action === "failed")
  return {
    at: new Date().toISOString(),
    entries,
    restored,
    failed: failed.map(entry => entry.id),
    changed: restored.length > 0,
    note: failed.length === 0
      ? restored.length === 0
        ? `会话期间这些键没有被改动（共检查 ${String(entries.length)} 个）；已逐个核对原值一致。`
        : `已把 ${restored.join("、")} 恢复为会话前的原值；其余键未被改动。`
      : `有 ${String(failed.length)} 个键**没能写回原值**（${failed.map(entry => entry.id).join("、")}）：${failed.map(entry => entry.error ?? "").join("；")}`,
  }
}

// ── 可见指示 + 会话（快照 → 输入 → 无条件恢复）─────────────────────────────

export interface IndicatorState {
  /** 无障碍状态图标：`visible`＝用户看得到；`not-needed`＝没有 a11y 功能开着；`unreadable`＝读不到。 */
  readonly a11yStatusIcon: "visible" | "not-needed" | "unreadable"
  /** 我们自己写进去的可见性改动（恢复时要写回去）。 */
  readonly changedVisibility: boolean
  readonly notification: "sent" | "unavailable" | "failed"
  /** 宿主状态投影（前端据此渲染"agent 正在控制输入"）。 */
  readonly projection: boolean
  /** 四者之一成立即认为用户看得见。 */
  readonly visible: boolean
  readonly note: string
}

const A11Y_ENABLE_KEYS = ["screen-reader-enabled", "screen-magnifier-enabled", "screen-keyboard-enabled", "stickykeys-enable", "slowkeys-enable", "mousekeys-enable"] as const

/**
 * 让用户看得见"agent 正在控制输入"：
 *   · a11y 功能开着而状态图标被关掉时，**把图标打开**（这是用户找回控制入口的唯一线索），并记账以便恢复；
 *   · 发一条桌面通知（`notify-send`，不可用则如实标 `unavailable`）；
 *   · 宿主状态投影由调用方点亮（`projection`）。
 */
export async function enforceVisibleIndicator(input: { snapshot: DesktopSnapshot; projection: boolean; env?: NodeJS.ProcessEnv; run?: CommandRunner; message?: string }): Promise<IndicatorState> {
  const env = input.env ?? process.env, run = input.run ?? realCommandRunner
  const entryOf = (id: string) => input.snapshot.entries.find(entry => entry.id === id)
  const iconEntry = entryOf("always-show-universal-access-status")
  const a11yOn = A11Y_ENABLE_KEYS.some(id => entryOf(id)?.value === "true")
  let a11yStatusIcon: IndicatorState["a11yStatusIcon"] = "not-needed", changedVisibility = false
  if (!a11yOn) a11yStatusIcon = "not-needed"
  else if (!iconEntry?.readable || iconEntry.value === null) a11yStatusIcon = "unreadable"
  else if (iconEntry.value === "true") a11yStatusIcon = "visible"
  else {
    const write = await run(["gsettings", "set", iconEntry.schema, iconEntry.key, "true"], { env, timeoutMs: 5000 }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
    if (write.code === 0) { a11yStatusIcon = "visible"; changedVisibility = true } else a11yStatusIcon = "unreadable"
  }
  const title = "Lyapunov 正在控制输入"
  const body = input.message ?? "agent 正在向它自己的窗口发送合成输入。若要中断：在 agent 面板点停止，或在系统里切走该窗口。"
  const notify = await run(["notify-send", "-a", "Lyapunov", "-u", "normal", title, body], { env, timeoutMs: 5000 }).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
  const notification: IndicatorState["notification"] = notify.code === 0 ? "sent" : notify.stderr.includes("ENOENT") ? "unavailable" : "failed"
  const visible = a11yStatusIcon === "visible" || notification === "sent" || input.projection
  return {
    a11yStatusIcon,
    changedVisibility,
    notification,
    projection: input.projection,
    visible,
    note: `可见指示：无障碍状态图标=${a11yStatusIcon}${changedVisibility ? "（本次由 agent 打开，会话结束会写回原值）" : ""}、桌面通知=${notification}、宿主状态投影=${input.projection ? "已开启" : "未开启"} ⇒ ${visible ? "用户可见" : "**用户看不到**（这种状态下不发全局输入）"}`,
  }
}

export interface ComputerUseSession {
  readonly id: string
  readonly openedAt: string
  readonly snapshot: DesktopSnapshot
  readonly indicator: IndicatorState
  /** 用户对"必要时走全局层"的显式同意（来自用户动作，不由模型自称）。 */
  readonly consent: boolean
  readonly consentReason: string | null
}

export interface OpenSessionOptions extends SnapshotOptions {
  readonly consent?: boolean
  readonly consentReason?: string | null
  /** 宿主状态投影是否已点亮（前端渲染"agent 正在控制输入"）。 */
  readonly projection?: boolean
}

/** 会话开始：**先快照，再点亮可见指示**（顺序不能反：没有快照就没有恢复的依据）。 */
export async function openComputerUseSession(options: OpenSessionOptions = {}): Promise<ComputerUseSession> {
  const snapshot = await captureDesktopSettingsSnapshot(options)
  const indicator = await enforceVisibleIndicator({ snapshot, projection: options.projection ?? true, ...options.env ? { env: options.env } : {}, ...options.run ? { run: options.run } : {} })
  return { id: `cua-${snapshot.at}`, openedAt: snapshot.at, snapshot, indicator, consent: options.consent === true, consentReason: options.consentReason ?? null }
}

/**
 * 会话结束：**无条件恢复**（含异常退出路径——调用方在 `ctx.effect` 的清理里也走这一条），
 * 并把可见指示退回原状。返回的是一份"到底改没改、恢复了什么、有没有失败"的实测报告。
 */
export async function closeComputerUseSession(session: ComputerUseSession, options: SnapshotOptions = {}): Promise<RestoreReport & { readonly indicator: IndicatorState }> {
  const report = await restoreDesktopSettings(session.snapshot, options)
  const env = options.env ?? process.env, run = options.run ?? realCommandRunner
  let indicator = session.indicator
  if (session.indicator.changedVisibility) {
    const write = await run(["gsettings", "set", "org.gnome.desktop.a11y", "always-show-universal-access-status", "false"], { env, timeoutMs: 5000 }).catch(() => ({ code: 1, stdout: "", stderr: "spawn failed" }))
    indicator = {
      ...session.indicator,
      a11yStatusIcon: write.code === 0 ? "not-needed" : "unreadable",
      changedVisibility: write.code !== 0,
      projection: false,
      visible: false,
      note: write.code === 0
        ? "会话结束：无障碍状态图标已写回会话前的 false；宿主状态投影已熄灭。"
        : `${COMPUTER_USE_INPUT_ERRORS.RESTORE_FAILED}: 无障碍状态图标未能写回会话前的值，用户可能仍看到它。`,
    }
  } else {
    indicator = { ...session.indicator, projection: false, visible: false, note: "会话结束：本次没有改动无障碍可见性；宿主状态投影已熄灭。" }
  }
  return { ...report, indicator }
}

/**
 * 把一次 computer-use 输入接进产品路径的唯一入口：
 *   · 拒绝的：**一个字节都不发**，返回结构化错误；
 *   · 允许的：交给 `deliver`（宿主侧的单飞/串行在调用方那一层）。
 * 返回值里带 `reason/advice/combos`，供回执与模型解释"为什么不发"。
 */
export function guardComputerUseInput(request: { tool: string; arguments: unknown; scope: InputScopeState }): ComputerUseInputPlan {
  return planComputerUseInput(request)
}
