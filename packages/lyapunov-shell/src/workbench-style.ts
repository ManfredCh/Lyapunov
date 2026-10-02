import {libraryStyle} from "./library-style.ts"
/**
 * 工作台视觉变量与样式。
 *
 * 颜色不写死：全部取自原生主题令牌（`--dsw-alias-*`，由 ui-theme 按 明/暗 主题发布），
 * 括号里只是令牌缺失时的兜底深色。两处必须成对使用，否则会在某套主题下变成同色：
 * - 强调（选中态、主按钮）：背景 `--dsw-alias-button-primary-fill` + 前景
 *   `--dsw-alias-label-primary-foreground`。这组令牌在明暗下是**互换**的
 *   （明＝深底白字，暗＝浅底黑字），不能拿 `label-primary` 当它的前景。
 * - 悬停/按下：`--dsw-alias-interactive-bg-hover / -active`，明暗两套都是淡淡一层，
 *   不依赖 `bg-layer-*`（明色主题下 bg-layer-1/2/3 全是纯白，会看不出选中）。
 *
 * 布局只在这里定义一次：中央视图 / 工具面板列 / 底部抽屉 / 最右工具栏 / 对话列（360–420）。
 * 按钮分三层：常态 ghost（无常驻描边，悬停才浮起）、强调 primary、危险 stop。
 */
const frameStyle = `
.lya-wb{--lya-bg:var(--dsw-alias-bg-base,#fafaf9);--lya-chrome:color-mix(in srgb,var(--lya-bg) 97%,var(--lya-text) 3%);--lya-raised:var(--dsw-alias-bg-layer-3,#1b2839);--lya-text:var(--dsw-alias-label-primary,#e3eaf5);--lya-muted:var(--dsw-alias-label-secondary,#95a6bd);--lya-caption:var(--dsw-alias-label-tertiary,#8497ad);--lya-line:color-mix(in srgb,var(--lya-text) 8%,transparent);--lya-line-2:color-mix(in srgb,var(--lya-text) 13%,transparent);--lya-line-3:color-mix(in srgb,var(--lya-text) 20%,transparent);--lya-hover:color-mix(in srgb,var(--lya-text) 5%,transparent);--lya-active:color-mix(in srgb,var(--lya-text) 8%,transparent);--lya-emphasis:var(--dsw-alias-button-primary-fill,#e9eef7);--lya-emphasis-hover:var(--dsw-alias-button-primary-hover,#cfdae9);--lya-emphasis-fg:var(--dsw-alias-label-primary-foreground,#0d1420);--lya-danger:var(--dsw-alias-state-error-primary,#d1585f);--lya-ok:var(--dsw-alias-state-success-primary,#77d9af);--lya-warn:var(--dsw-alias-state-warn-label,#f4c47c);--lya-bad:var(--dsw-alias-state-error-primary,#c65760);--lya-accent:var(--dsw-alias-link,#557b98);--lya-accent-soft:color-mix(in srgb,var(--lya-accent) 11%,var(--lya-bg));--lya-r-sm:6px;--lya-r-md:8px;--lya-r-lg:10px;--lya-rail-w:44px;--lya-font-ui:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;--lya-font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--lya-shadow-1:0 1px 2px #00000029;--lya-shadow-2:0 16px 38px -26px #000000a6;
 flex:1;min-height:0;height:100%;display:flex;flex-direction:column;background:var(--lya-bg);color:var(--lya-text);font:13px/1.55 var(--lya-font-ui);text-align:left;overflow:hidden}
.lya-workspace-tools{flex:0 0 var(--lya-rail-w);max-width:var(--lya-rail-w);height:100%;background:var(--lya-chrome)}
.lya-workspace-tools .lya-rail{flex:1;min-height:0;height:100%;border-left:1px solid var(--lya-line-2)}
/* 控件作用域含 .lya-wb-panel：工具窗经 portal 挂到应用层宿主时脱离 .lya-wb-surface，按钮/输入仍要同皮肤。 */
.lya-wb *{box-sizing:border-box}.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel,.lya-wb-status) button,.lya-wb input,.lya-wb select,.lya-wb textarea{font:inherit}
 /* 三层按钮：常态没有常驻描边，只在悬停/按下时浮起。尺寸按“成熟工具面板”的密度：30px 高、12px 字。 */
.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel,.lya-wb-status) button{color:inherit;background:transparent;border:1px solid transparent;border-radius:var(--lya-r-sm);padding:5px 10px;min-height:30px;font-size:12px;cursor:pointer;transition:background .14s,color .14s,border-color .14s}
.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel,.lya-wb-status) button:hover:not(:disabled){background:var(--lya-hover)}
.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel,.lya-wb-status) button:active:not(:disabled){background:var(--lya-active)}
.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel,.lya-wb-status) button:disabled{opacity:.42;cursor:default}
/* 面板里的整行动作按钮（采集 / 读取 / 导出 / 移动到…）：沿用素材与机器人入口那层浅描边，
   禁用时也仍然看得出“这是一个按钮”，而不是一段灰字。 */
.lya-wb-panel-body button.lya-wide:not(.lya-primary):not(.lya-stop){border-color:var(--lya-line-2)}
.lya-wb input,.lya-wb select,.lya-wb textarea{min-width:0;color:var(--lya-text);background:var(--dsw-alias-bg-base,#0d1420);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-sm);padding:5px 8px;font-size:12px}
.lya-wb input::placeholder,.lya-wb textarea::placeholder{color:var(--lya-caption)}
.lya-wb input[type=number]{width:88px}.lya-wb input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary,#2788d6)}.lya-wb input[type=color]{width:38px;height:25px;padding:1px}
.lya-wb label{display:flex;gap:7px;align-items:center}.lya-wb fieldset{border:0;border-radius:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;min-width:0}.lya-wb legend{color:var(--lya-caption);padding:0;margin:0;font-size:11px;font-weight:600;letter-spacing:.06em}.lya-wb summary{cursor:pointer;color:var(--lya-muted)}.lya-wb a{color:var(--dsw-alias-link,#6cb6ff)}
.lya-spacer{flex:1}
/* 强调按钮：主题的强调背景/前景成对使用（明＝深底白字，暗＝浅底黑字）。 */
.lya-primary{background:var(--lya-emphasis)!important;color:var(--lya-emphasis-fg)!important;border-color:transparent!important;font-weight:600}
.lya-primary:hover:not(:disabled){background:var(--lya-emphasis-hover)!important}
.lya-stop{background:color-mix(in srgb,var(--lya-danger) 10%,var(--lya-bg))!important;color:var(--lya-danger)!important;border-color:color-mix(in srgb,var(--lya-danger) 24%,transparent)!important;font-weight:600}
.lya-badge{display:inline-flex;align-items:center;border:1px solid var(--lya-line-2);border-radius:99px;padding:1px 8px;color:var(--lya-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.lya-live{color:var(--lya-ok);border-color:var(--lya-ok)}.lya-warning{color:var(--lya-warn)}.lya-error{color:var(--lya-bad)}.lya-muted{color:var(--lya-muted)}.lya-help{color:var(--lya-muted);font-size:11.5px;line-height:1.6;margin:2px 0}.lya-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.lya-row label{flex:1}.lya-wide{width:100%}
/* 复选行（显示开关等）：按内容排布。窄面板里 flex:1 会把“坐标轴”挤成逐字换行。 */
.lya-row:has(>label>input[type=checkbox]){gap:6px 12px}.lya-row:has(>label>input[type=checkbox])>label{flex:0 0 auto;min-width:max-content;white-space:nowrap}
/* 分段控件（模式切换 / Gizmo 模式）：一格软底，选中用强调对，不靠描边。 */
.lya-segment{display:inline-flex;gap:2px;padding:2px;border-radius:var(--lya-r-md);background:var(--lya-hover)}
.lya-segment button{border:0;border-radius:var(--lya-r-sm);padding:4px 10px;font-size:12px;background:transparent;font-weight:500}
.lya-segment button[aria-pressed=true]{background:var(--lya-bg);color:var(--lya-text);box-shadow:0 1px 4px #00000012,0 0 0 1px var(--lya-line);font-weight:600}
.lya-segment button[aria-pressed=true]:hover:not(:disabled){background:var(--lya-bg)}
/* 顶栏：任务/场景 + 一个模式切换 + 运行状态 + 必要运行/停止。没有别的常驻控件。 */
.lya-wb-header{display:flex;align-items:center;gap:14px;padding:9px 18px;border-bottom:1px solid var(--lya-line);background:var(--lya-chrome);flex:0 0 56px;min-height:56px;min-width:0}
.lya-wb-header .lya-scene-name{max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:620;padding:4px 6px;border-radius:var(--lya-r-sm);background:transparent}
.lya-wb-header .lya-scene-name:hover{background:var(--lya-active)}
.lya-wb-header .lya-status{display:inline-flex;align-items:center;gap:6px;color:var(--lya-muted);font-size:11px;white-space:nowrap;min-width:0;overflow:hidden}
.lya-wb-header .lya-status-dot{width:7px;height:7px;border-radius:50%;background:var(--lya-caption);flex:0 0 auto}
.lya-wb-header .lya-status[data-state=running] .lya-status-dot{background:var(--lya-ok)}
.lya-wb-header .lya-status[data-state=sync] .lya-status-dot{background:var(--lya-warn)}
.lya-wb-admin{padding:5px 10px;margin:0;border-bottom:1px solid var(--lya-line);background:var(--lya-chrome)}
/* 主体：对话列（360–420，画布优先）｜ 拖拽条 ｜ 工作面 ｜ 最右工具栏。 */
.lya-wb-body{flex:1;min-height:0;display:flex;align-items:stretch;min-width:0;container-type:inline-size;container-name:workbench-body}
.lya-wb-conversation{flex:0 0 auto;min-width:360px;max-width:420px;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--lya-line);overflow:hidden}
/* 拖拽条：8px 命中区，跨在列边界上，常态不可见，悬停/拖动时才出一条强调线。 */
.lya-wb-splitter{flex:0 0 8px;margin:0 -4px;cursor:col-resize;touch-action:none;position:relative;z-index:4}
.lya-wb-splitter::after{content:"";position:absolute;top:0;bottom:0;left:3px;width:2px;background:transparent}
.lya-wb-splitter:hover::after,.lya-wb-splitter[data-dragging]::after{background:var(--lya-emphasis)}
.lya-wb-surface{container-type:inline-size;container-name:workbench-surface;flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--lya-bg)}
.lya-wb[data-mode=chat] .lya-wb-surface,.lya-wb[data-mode=chat] .lya-wb-splitter{display:none}
.lya-wb[data-mode=chat] .lya-wb-conversation{flex:1 1 100%;max-width:none;border-right:0}
.lya-wb[data-mode=scene] .lya-wb-conversation,.lya-wb[data-mode=scene] .lya-wb-splitter{display:none}
.lya-wb[data-mode=scene] .lya-wb-surface{flex:1 1 100%}
/* 双栏太窄就不再硬塞：协作模式在窄视口自动收成单工作面（对话专注仍可一键切回）。 */
.lya-wb-main{flex:1;min-height:0;display:flex;align-items:stretch;min-width:0;position:relative}
.lya-wb-centre{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
/* 常驻 layer：可见性只改 display，React 位置不变（Viewer/草稿/PTY 宿主因此不被重建）。 */
.lya-wb-layer{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.lya-wb-layer[hidden]{display:none}
.lya-wb-centre .lya-canvas{flex:1;min-height:0;width:100%}
.lya-wb-centre canvas{display:block}
.lya-wb-canvas{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
/* 工具面板列：300 起，窄的时候先让面板收，不让画布消失。 */
.lya-wb-panel{position:absolute;top:0;bottom:0;right:0;z-index:30;min-width:230px;max-width:52%;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--lya-line);background:var(--lya-chrome);box-shadow:-14px 0 36px rgba(0,0,0,.38);animation:lya-panel-in .18s ease-out}
@keyframes lya-panel-in{from{transform:translateX(48px);opacity:0}to{transform:none;opacity:1}}
.lya-wb-panel-body{flex:1;min-height:0;overflow:auto;padding:13px 15px 17px;display:flex;flex-direction:column;gap:15px;scrollbar-width:thin;scrollbar-color:var(--lya-line-3) transparent}
.lya-wb-missing{display:grid;place-items:center;flex:1;padding:20px;text-align:center;color:var(--lya-muted)}
.lya-wb-drawer{flex:0 0 auto;display:flex;flex-direction:column;border-top:1px solid var(--lya-line);background:var(--lya-chrome);min-height:0}
.lya-wb-drawer[hidden]{display:none}
.lya-wb-drawer-handle{height:7px;cursor:row-resize;touch-action:none;background:transparent}
.lya-wb-drawer-handle:hover{background:var(--lya-emphasis)}
.lya-wb-drawer-body{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.lya-wb-layer[data-layer=deliverable]{overflow:auto;gap:12px;scrollbar-width:thin;scrollbar-color:var(--lya-line-3) transparent}
.lya-recordings{flex:0 0 auto;min-width:0}
.lya-recording-view{height:max(180px,calc(var(--lya-drawer-height,240px) - 27px));display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-bg)}
.lya-recording-header{display:flex;align-items:center;gap:12px;padding:5px 10px;flex:0 0 auto;border-bottom:1px solid var(--lya-line)}
.lya-recording-heading{display:flex;align-items:baseline;gap:10px;min-width:0;flex:1}.lya-recording-heading strong{white-space:nowrap;font-size:12px}.lya-recording-heading span{font-size:11px;color:var(--lya-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-recording-header button{flex-shrink:0;font-size:12px!important}
.lya-recording-canvas{flex:1;min-height:40px;position:relative;background:#191d25}.lya-recording-canvas canvas{display:block}
.lya-recording-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 8px;flex:0 0 auto;border-top:1px solid var(--lya-line)}
.lya-recording-controls button{font-size:12px!important;white-space:nowrap}.lya-recording-controls input[type=range]{flex:1;min-width:70px;width:120px;padding:0}.lya-recording-controls [data-testid=recording-step]{font:11px/1.5 var(--lya-font-mono);color:var(--lya-muted);white-space:nowrap}
.lya-recording-source{padding:0 10px 5px;font:10px/1.5 var(--lya-font-mono);color:var(--lya-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}
/* 最右工具栏：一条 60px 的常驻竖列，九个入口共用同一枚图标的几何与同一套间距/圆角/选中态。
   分组小标题（data-group-label）把“工具”和“工作面”两组分开，窄栏隐藏；
   选中态＝底色 + 图标文字转强调色 + 左缘 3px 指示条，悬停/按下与键盘焦点三态都可辨。 */
.lya-rail{flex:0 0 var(--lya-rail-w);width:var(--lya-rail-w);display:flex;flex-direction:column;justify-content:space-between;gap:10px;padding:10px 5px;border-left:1px solid var(--lya-line-2);background:var(--lya-chrome);overflow:auto;overscroll-behavior:contain;scrollbar-width:none}
.lya-rail-group{display:flex;flex-direction:column;gap:2px;flex-shrink:0}
.lya-rail-group[data-group-label]::before{content:attr(data-group-label);display:block;margin:0 0 6px;color:var(--lya-caption);font-size:9.5px;font-weight:600;line-height:1;letter-spacing:.12em;text-align:center;text-transform:uppercase}
.lya-rail-bottom{padding-top:10px;border-top:1px solid var(--lya-line)}
.lya-rail .lya-rail-item{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;width:100%;min-height:48px;padding:5px 2px;border:0;border-radius:var(--lya-r-sm);background:transparent;color:var(--lya-muted)}
.lya-rail-item::after{content:"";position:absolute;left:-7px;top:50%;width:2px;height:0;border-radius:0 2px 2px 0;background:var(--lya-accent);transform:translateY(-50%)}
.lya-rail-item:hover:not(:disabled){background:var(--lya-hover);color:var(--lya-text)}
.lya-rail-item:hover:not(:disabled)::after{height:10px;opacity:.5}
.lya-rail-item svg{flex:0 0 auto}
.lya-rail-item .lya-rail-label{display:block;width:100%;max-width:100%;font-size:10.5px;line-height:1.25;font-weight:500;letter-spacing:.02em;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit;opacity:.82}
.lya-rail-item:hover .lya-rail-label,.lya-rail-item[aria-pressed=true] .lya-rail-label{opacity:1}
.lya-rail-item[aria-pressed=true]{background:var(--lya-accent-soft);color:var(--lya-accent)}
.lya-rail-item[aria-pressed=true]::after{height:18px}
.lya-rail-item[aria-pressed=true]:hover:not(:disabled){background:color-mix(in srgb,var(--lya-accent) 17%,var(--lya-bg))}
@media(max-width:1180px){.lya-wb{--lya-rail-w:46px}.lya-rail{gap:10px;padding:10px 5px}.lya-rail-group[data-group-label]::before{display:none}.lya-rail .lya-rail-item{gap:4px;min-height:44px;padding:4px 1px}.lya-rail .lya-rail-item::after{left:-5px}.lya-rail .lya-rail-item .lya-rail-label{font-size:10px;letter-spacing:0}.lya-wb-panel{min-width:200px}}
@media(max-width:900px){.lya-wb-header .lya-status,.lya-wb-header .lya-scene-name{max-width:130px}}
/* 面板内的既有控件（保持原样式语言）。窗口式面板标题栏已删（PanelColumn 无标题栏），
   原 .lya-wb-panel>.lya-panel-title 死样式改造为小节头 .lya-section。 */
.lya-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:600;color:var(--lya-text)}
.lya-panel-title>button{border:0;background:transparent;font-size:16px;line-height:1;padding:0;width:26px;height:26px;min-height:26px;display:grid;place-items:center;border-radius:var(--lya-r-sm);color:var(--lya-muted)}
.lya-panel-title>button:hover:not(:disabled){background:var(--lya-active);color:var(--lya-text)}
/* 小节头：小字 uppercase 弱色标签 + 右侧计数/状态（opencode 小节头语义，无窗口标题栏）。 */
.lya-section{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 1px;color:var(--lya-caption);font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.lya-section .lya-section-side{color:var(--lya-muted);font-weight:500;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums}
.lya-section .lya-badge{letter-spacing:0;text-transform:none}
/* 状态徽章语义色：模拟运行＝ok、已选中＝accent、未选中＝默认弱色。 */
.lya-badge-ok{color:var(--lya-ok);border-color:color-mix(in srgb,var(--lya-ok) 40%,transparent);background:color-mix(in srgb,var(--lya-ok) 8%,transparent)}
.lya-badge-accent{color:var(--lya-accent);border-color:color-mix(in srgb,var(--lya-accent) 42%,transparent);background:var(--lya-accent-soft)}
/* 小号描边芯片按钮：次级动作弱描边；主行动（执行类）accent 描边区分。 */
.lya-wb-panel button.lya-chip{min-height:26px;padding:2px 9px;font-size:11.5px;font-weight:550;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-sm);background:transparent;color:var(--lya-muted)}
.lya-wb-panel button.lya-chip:hover:not(:disabled){color:var(--lya-text);background:var(--lya-hover);border-color:var(--lya-line-3)}
.lya-wb-panel button.lya-chip-accent{border-color:color-mix(in srgb,var(--lya-accent) 55%,transparent);color:var(--lya-accent);background:var(--lya-accent-soft)}
.lya-wb-panel button.lya-chip-accent:hover:not(:disabled){color:var(--lya-accent);background:color-mix(in srgb,var(--lya-accent) 18%,var(--lya-bg))}
/* 机器人控制卡：圆角描边卡片包住整个控制区（原为裸 fieldset）。 */
.lya-wb .lya-robot-card{border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:10px 10px 12px;background:var(--lya-bg)}
.lya-robot-card>legend{padding:0 4px}
/* 环境候选卡：40px 缩略图（无图给占位图标）+ 名称/元信息 + 右侧芯片动作，hover 变色。 */
.lya-env-card{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-bg);transition:border-color .14s,background .14s}
.lya-env-card:hover{border-color:var(--lya-line-2);background:var(--lya-hover)}
.lya-env-thumb{width:40px;height:40px;flex:0 0 auto;border:1px solid var(--lya-line);border-radius:var(--lya-r-sm);background:var(--lya-chrome);object-fit:cover}
span.lya-env-thumb{display:grid;place-items:center;color:var(--lya-caption)}
.lya-env-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.lya-env-main>strong{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-env-main>span{font-size:11px;color:var(--lya-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-env-actions{display:flex;gap:4px;flex:0 0 auto}
/* 键值详情盒：弱色标签 + 正色值两列网格（PhysicsDetailBox 语义），替代"·"连成一行的长文本。 */
.lya-detail-box{display:flex;flex-direction:column;gap:8px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:10px;background:var(--lya-bg)}
.lya-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:0;font-size:11.5px;line-height:1.6}
.lya-kv>dt{color:var(--lya-caption);white-space:nowrap}
.lya-kv>dd{margin:0;color:var(--lya-text);overflow-wrap:anywhere}
.lya-tree{overflow:auto;max-height:34vh}.lya-tree-row{display:flex;align-items:center;gap:4px;min-height:30px;border-radius:var(--lya-r-sm)}.lya-tree-row:hover{background:var(--lya-hover)}.lya-tree-row[aria-selected=true]{background:var(--lya-active);box-shadow:inset 2px 0 0 var(--lya-emphasis)}.lya-tree-row button{border:0;background:none;padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}.lya-tree-row button:hover{background:transparent}.lya-tree-row .lya-tree-name{flex:1}
.lya-floating-panel{background:var(--lya-bg);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);padding:10px;box-shadow:0 8px 26px #0005;overflow:auto;display:flex;flex-direction:column;gap:8px}
.lya-modal{position:fixed;inset:0;z-index:60;background:#0006;display:grid;place-items:center}.lya-modal>.lya-floating-panel{width:min(420px,90vw)}
/* 画布上的选中条：只说“选中了谁”，动作都在右面板里，不重复铺同一动作。 */
.lya-selection-bar{position:absolute;left:10px;bottom:10px;display:flex;gap:8px;align-items:center;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:2;box-shadow:var(--lya-shadow-2)}.lya-selection-bar strong{font-size:12.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-selection-bar button{font-size:11.5px;padding:4px 8px}
 /* 放置条：素材落点确认前悬在画布顶部，与选中条同一浮层语言。 */
 .lya-placement-bar{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:2;box-shadow:var(--lya-shadow-2)}.lya-placement-bar strong{font-size:12.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-placement-point{font:11.5px var(--lya-font-mono);color:var(--lya-muted);white-space:nowrap}.lya-placement-bar button{font-size:11.5px;padding:4px 8px}
  /* 批注条：批注模式下的常驻提示（落点/改文字/计数），与放置条同一浮层语言，两者不同时出现。 */
  .lya-annotation-bar{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-accent);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:2;box-shadow:var(--lya-shadow-2)}
  .lya-annotation-bar strong{font-size:12.5px;color:var(--lya-accent)}.lya-annotation-bar span{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lya-annotation-bar button{font-size:11.5px;padding:4px 8px}
  .lya-annotation-count{font:11.5px var(--lya-font-mono);color:var(--lya-text);border:1px solid var(--lya-line-2);border-radius:99px;padding:0 7px}
  /* 批注列表：编号是显示序号（与标记、截图三处同源），文字直接在列表里编辑，不额外开弹层。 */
  .lya-annotation-list{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:8px}
  .lya-annotation-list li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:8px;background:var(--lya-bg)}
  .lya-annotation-list li[data-active]{border-color:var(--lya-accent);box-shadow:inset 0 0 0 1px var(--lya-accent)}
  .lya-annotation-list li[data-orphan]{border-style:dashed;opacity:.75}
  .lya-annotation-pin{width:22px;height:22px;border-radius:99px;background:#ffd34d;color:#121a24;font:600 12px var(--lya-font-mono);border:1px solid #121a24;padding:0}
  .lya-annotation-body{display:flex;flex-direction:column;gap:4px;min-width:0}
  .lya-annotation-target{font:11px var(--lya-font-mono);color:var(--lya-muted);overflow-wrap:anywhere}
  .lya-annotation-remove{background:none;border:0;color:var(--lya-muted);font-size:15px;line-height:1;padding:2px 4px}
  .lya-annotation-live{color:var(--lya-accent)}
  .lya-annotation-shot{margin:6px 0;display:flex;flex-direction:column;gap:3px}.lya-annotation-shot img{width:100%;border-radius:4px;border:1px solid var(--lya-line)}
.lya-scene-empty{position:absolute;inset:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--lya-muted);pointer-events:none;text-align:center}.lya-scene-empty strong{font-size:15px;font-weight:600;color:var(--lya-text);letter-spacing:-.01em}.lya-scene-empty p{margin:4px 0 0;font-size:12px;line-height:1.7;max-width:320px}
.lya-scene-empty .lya-row{pointer-events:auto;justify-content:center;margin:10px 0}
.lya-empty{display:grid;place-items:center;flex:1;min-height:160px;color:var(--lya-muted);padding:25px;text-align:center}
.lya-wb .lya-property-editor{display:flex;flex-direction:column;gap:8px;background:var(--lya-hover);border:0;border-radius:var(--lya-r-md);padding:10px}.lya-property-editor>label.lya-field-label{display:block;font-size:11px;color:var(--lya-muted)}.lya-property-editor>label>input,.lya-property-editor>label>textarea{display:block;margin-top:4px}
.lya-values{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.lya-values label{display:block}.lya-values input{width:100%!important}
.lya-joint{display:grid;grid-template-columns:minmax(75px,1fr) 63px 90px;gap:5px;align-items:center;padding:4px 0;border-bottom:1px solid var(--lya-line)}.lya-joint input{width:90px!important}.lya-joint small{font-size:10px;color:var(--lya-caption)}.lya-joint code{font-family:var(--lya-font-mono);font-size:10px;color:var(--lya-accent-text,var(--lya-muted));text-align:right}
.lya-advanced{border-top:1px solid var(--lya-line);padding-top:8px}.lya-advanced>summary{font-size:12px;padding:4px 0}
.lya-asset-library{display:flex;flex-direction:column;gap:6px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:9px;background:var(--lya-hover)}
.lya-receipt{padding:8px;background:var(--lya-hover);border-radius:var(--lya-r-md);border:1px solid var(--lya-line)}.lya-receipt p{margin:2px 0}.lya-receipt pre{max-height:140px;overflow:auto;font-size:10px;white-space:pre-wrap}
.lya-captures{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.lya-captures figure{margin:0;display:flex;flex-direction:column;gap:4px}.lya-captures img{width:100%;border-radius:4px;border:1px solid var(--lya-line)}
.lya-wb-status{position:relative;min-width:0;max-width:100%;padding:0 12px;display:flex;gap:8px;align-items:center;border-top:1px solid var(--lya-line);background:var(--lya-chrome);color:var(--lya-muted);font-size:11.5px;line-height:1.4;min-height:32px;flex:0 0 auto}
.lya-wb-status button{flex-shrink:0;white-space:nowrap;min-height:26px!important;padding:3px 6px!important;font-size:11.5px!important}.lya-revision{white-space:nowrap;color:var(--lya-muted);flex-shrink:0}.lya-wb-status [data-testid=world-step]{white-space:nowrap;font-variant-numeric:tabular-nums;flex-shrink:0}
.lya-status-message{display:flex;align-items:center;gap:5px;flex:1;min-width:0}.lya-status-summary,.lya-world-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-status-summary{flex:1}.lya-world-status{display:flex;align-items:center;gap:5px;min-width:0;max-width:55%;flex:0 1 auto}.lya-world-label{flex:0 1 auto}.lya-world-status[data-world-phase=failed],.lya-world-status[data-world-phase=blocked]{color:var(--lya-bad)}
.lya-status-details{position:absolute;left:8px;right:8px;bottom:calc(100% + 6px);z-index:45;max-height:min(240px,35vh);overflow:auto;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);padding:10px 12px;background:var(--lya-bg);color:var(--lya-text);box-shadow:var(--lya-shadow-2)}.lya-status-details pre{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.6 var(--lya-font-mono)}

/* 右上角 文件/终端 图标按钮。 */
.lya-wb-topbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0!important;border-radius:var(--lya-r-sm)}
.lya-wb-topbtn[aria-pressed="true"]{background:var(--lya-active);border-color:var(--lya-line-2)!important}
/* 图标栏：去掉分组小标题占位。 */
.lya-rail-group[data-group-label]::before{content:none}
.lya-rail .lya-rail-item{display:flex;align-items:center;justify-content:center;min-height:34px;padding:2px 0}


/* 应用层并列侧栏宿主：工具窗脱离 sidepage 层，由实际工作台边界定位在图标条左侧。
   宿主带 lya-wb 类（native-workspace.tsx），--lya-* 令牌与控件皮肤对 portal 内容可用；
   宿主自身透明、不裁阴影，背景/描边只画在面板上；未测量时隐藏，避免开窗先覆盖工具轨。 */
.lya-appside-panel-host{position:fixed;top:0;bottom:auto;right:0;width:0;height:0;visibility:hidden;z-index:40;pointer-events:none;background:transparent;overflow:visible}
.lya-appside-panel-host .lya-wb-panel{position:relative;inset:auto;width:100%!important;min-width:0;max-width:none;height:100%;pointer-events:auto;border-left:1px solid var(--lya-line-2);background:var(--lya-chrome);box-shadow:-14px 0 36px rgba(0,0,0,.38);animation:lya-panel-fade-in .18s ease-out}
@keyframes lya-panel-fade-in{from{opacity:0}to{opacity:1}}

/* 原生"开合文件标签"按钮与 rail 的文件入口重复，隐藏（折叠入口仍不存在）。 */
[data-sidebar-right-toggle]{display:none!important}
/* 场景标题（原 场景▾ 按钮改为纯文本）。 */
.lya-wb-title{font-weight:600;font-size:13px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`

export const workbenchStyle = frameStyle + libraryStyle + `
.lya-first-person-hint{display:none;position:absolute;left:16px;top:14px;pointer-events:none;color:var(--lya-muted);background:var(--lya-bg);padding:6px 10px;border-radius:var(--lya-r-sm);font-size:11px}
.lya-wb-canvas:has(canvas[data-navigation="first-person"]) .lya-first-person-hint{display:block}
.lya-file-drop-hint{position:absolute;z-index:100;top:16px;left:50%;transform:translateX(-50%);pointer-events:none;padding:12px 20px;border-radius:var(--lya-r-md);background:var(--lya-emphasis);color:var(--lya-emphasis-fg);font-weight:600}
.lya-wb-canvas[data-drop-target]{outline:2px solid var(--lya-emphasis);outline-offset:-3px}
`
