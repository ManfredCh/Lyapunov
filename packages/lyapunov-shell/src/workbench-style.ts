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
.lya-wb{--lya-bg:var(--dsw-alias-bg-base,#fafaf9);--lya-chrome:color-mix(in srgb,var(--lya-bg) 97%,var(--lya-text) 3%);--lya-raised:var(--dsw-alias-bg-layer-3,#1b2839);--lya-text:var(--dsw-alias-label-primary,#e3eaf5);--lya-muted:var(--dsw-alias-label-secondary,#95a6bd);--lya-caption:var(--dsw-alias-label-tertiary,#8497ad);--lya-line:color-mix(in srgb,var(--lya-text) 8%,transparent);--lya-line-2:color-mix(in srgb,var(--lya-text) 13%,transparent);--lya-line-3:color-mix(in srgb,var(--lya-text) 20%,transparent);--lya-hover:color-mix(in srgb,var(--lya-text) 5%,transparent);--lya-active:color-mix(in srgb,var(--lya-text) 8%,transparent);--lya-emphasis:var(--dsw-alias-button-primary-fill,#e9eef7);--lya-emphasis-hover:var(--dsw-alias-button-primary-hover,#cfdae9);--lya-emphasis-fg:var(--dsw-alias-label-primary-foreground,#0d1420);--lya-danger:var(--dsw-alias-state-error-primary,#d1585f);--lya-ok:var(--dsw-alias-state-success-primary,#77d9af);--lya-warn:var(--dsw-alias-state-warn-label,#f4c47c);--lya-bad:var(--dsw-alias-state-error-primary,#c65760);--lya-accent:var(--dsw-alias-link,#557b98);--lya-accent-soft:color-mix(in srgb,var(--lya-accent) 11%,var(--lya-bg));--lya-r-sm:6px;--lya-r-md:8px;--lya-r-lg:10px;--lya-rail-w:44px;--lya-font-ui:"Noto Sans",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;--lya-font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--lya-shadow-1:0 1px 2px #00000029;--lya-shadow-2:0 16px 38px -26px #000000a6;
 flex:1;min-height:0;height:100%;display:flex;flex-direction:column;background:var(--lya-bg);color:var(--lya-text);font:12px/1.45 var(--lya-font-ui);text-align:left;overflow:hidden}
.lya-workspace-tools{flex:0 0 var(--lya-rail-w);max-width:var(--lya-rail-w);height:100%;background:var(--lya-chrome);pointer-events:auto;position:relative}
.lya-workspace-tools .lya-rail{flex:1;min-height:0;height:100%;border-left:1px solid var(--lya-line-2)}
/* 引擎切换回执：44px 工具轨放不下整行文字，画成轨左缘外侧的小浮卡（单行可读、不挤压轨面）。 */
.lya-rail-engine-notice{position:fixed;right:52px;bottom:48px;z-index:50;margin:0;width:max-content;max-width:min(280px,70vw);padding:6px 10px;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);background:var(--lya-chrome);color:var(--lya-text);font-size:11px;line-height:1.4;box-shadow:var(--lya-shadow-2);pointer-events:auto}
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
.lya-badge{display:inline-flex;align-items:center;border:1px solid var(--lya-line-2);border-radius:99px;padding:1px 8px;color:var(--lya-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.lya-live{color:var(--lya-ok);border-color:var(--lya-ok)}.lya-warning{color:var(--lya-warn)}.lya-error{color:var(--lya-bad)}.lya-muted{color:var(--lya-muted)}.lya-help{color:var(--lya-muted);font-size:11px;line-height:1.45;margin:2px 0}.lya-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.lya-row label{flex:1}.lya-wide{width:100%}
/* 复选行（显示开关等）：按内容排布。窄面板里 flex:1 会把“坐标轴”挤成逐字换行。 */
.lya-row:has(>label>input[type=checkbox]){gap:6px 12px}.lya-row:has(>label>input[type=checkbox])>label{flex:0 0 auto;min-width:max-content;white-space:nowrap}
/* Robot Library 搜索 + 刷新固定一行：输入可收缩，刷新按钮不换行；lya-wide 的 100% 不参与。 */
.lya-library-search{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0}
.lya-library-search>input[type=search]{flex:1 1 0;min-width:0;width:auto}
.lya-library-search>button{flex:0 0 auto;white-space:nowrap}
/* 范围 + 数字同一行：短面板里不再各占一整行。 */
.lya-slider-head{display:block}
.lya-slider-line{display:flex;align-items:center;gap:6px;margin-top:4px;min-width:0}
.lya-slider-line>input[type=range]{flex:1 1 0;min-width:0;width:auto;padding:0}
.lya-slider-line>input[type=number]{flex:0 0 66px;width:66px;min-width:0}
.lya-color-line{display:flex;align-items:center;gap:8px;margin-top:4px;min-width:0}
.lya-environment-select{flex:0 1 190px;min-width:0;max-width:65%}
.lya-import-inline{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-hover)}
/* 重力摘要：配置值与世界读回值并排，未读回不冒充实测。 */
.lya-gravity-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:4px 2px;font-variant-numeric:tabular-nums}
.lya-gravity-summary>strong{font-weight:600}
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
.lya-wb-panel-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--lya-line-3) transparent}
.lya-wb-missing{display:grid;place-items:center;flex:1;padding:20px;text-align:center;color:var(--lya-muted)}
.lya-wb-drawer{flex:0 0 auto;display:flex;flex-direction:column;border-top:1px solid var(--lya-line);background:var(--lya-chrome);min-height:0}
.lya-wb-drawer[hidden]{display:none}
.lya-wb-drawer-handle{height:7px;cursor:row-resize;touch-action:none;background:transparent}
.lya-wb-drawer-handle:hover{background:var(--lya-emphasis)}
.lya-wb-drawer-body{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.lya-wb-layer[data-layer=deliverable]{overflow:auto;gap:12px;scrollbar-width:thin;scrollbar-color:var(--lya-line-3) transparent}
.lya-recordings{flex:0 0 auto;min-width:0}
.lya-recording-view{height:max(180px,calc(var(--lya-drawer-height,240px) - 27px));display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-bg)}
.lya-recording-host{position:absolute;inset:0;z-index:20;display:none;min-width:0;min-height:0;background:#151b24}
.lya-recording-host[data-active]{display:flex}
.lya-recording-host .lya-recording-view{height:100%;min-height:0;border:0;border-radius:0;flex:1}
.lya-recording-host .lya-recording-header{padding:8px 12px;background:color-mix(in srgb,#151b24 86%,transparent)}
.lya-recording-host .lya-recording-canvas{min-height:0}
.lya-recording-host .lya-recording-controls{padding:8px 12px;background:color-mix(in srgb,#151b24 86%,transparent)}
.lya-canvas-toolbar{display:flex;align-items:flex-start;gap:6px;max-width:100%;min-width:0;flex-wrap:wrap;pointer-events:none}
.lya-canvas-toolbar>*{pointer-events:auto}
.lya-frame-actions{display:flex;align-items:center;gap:4px;padding:0;background:transparent;min-width:0;flex-wrap:wrap}
.lya-frame-actions button{width:28px;height:28px;min-height:28px;padding:0;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--lya-line) 82%,transparent);border-radius:6px;background:color-mix(in srgb,var(--lya-chrome) 88%,transparent);color:var(--lya-text);box-shadow:0 2px 8px rgba(0,0,0,.24)}
.lya-frame-actions button:hover:not(:disabled){background:var(--lya-active)}
.lya-frame-actions button:disabled{opacity:.45}
.lya-frame-actions .lya-scene-focus{width:28px;padding:0;font-size:15px;line-height:1;white-space:nowrap}
/* 资源详情只读预览的自有主画布宿主：只是 Main Viewer 的兄弟覆盖层，卸载即恢复原 Viewer/镜头。 */
.lya-resource-preview-host{position:absolute;inset:0;z-index:19;display:none;min-width:0;min-height:0;background:#1a2129}
.lya-resource-preview-host[data-active]{display:flex}
.lya-resource-preview-host:empty{display:none!important}
.lya-resource-preview-host .lya-robot-resource-preview{height:100%;width:100%;flex:1 1 0;min-width:0;min-height:0;margin:0;background:#1a2129}
.lya-resource-preview-host .lya-rrp-head{padding:8px 12px;background:color-mix(in srgb,#151b24 86%,transparent);color:#c9d5e4;flex:0 0 auto}
.lya-resource-preview-host .lya-rrp-stage{height:auto;min-height:0;flex:1;border:0;border-radius:0}
.lya-resource-preview-host .lya-rrp-hint{background:#1a2129e6}
.lya-robot-atomic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.lya-robot-atomic-grid>button{width:100%;justify-content:center;min-height:32px}
/* 设计稿 robot-policy：底部 4 个图标按钮同排（▶ ■ ◎ ↺），不是 2×2 文字按钮。 */
.lya-robot-atomic-grid.lya-robot-atomic-icons{grid-template-columns:repeat(4,minmax(0,1fr))}
.lya-robot-failure{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--lya-danger) 28%,var(--lya-line));border-radius:6px;background:color-mix(in srgb,var(--lya-danger) 8%,transparent);font-size:11px;line-height:1.45}
.lya-robot-failure .lya-row{gap:6px;flex-wrap:wrap}
.lya-robot-policy-summary{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--lya-line);border-radius:6px;background:var(--lya-field)}
.lya-robot-policy-summary strong{font-size:12px;font-weight:600}.lya-robot-policy-summary span{font-size:11px;color:var(--lya-caption)}
.lya-recording-header{display:flex;align-items:center;gap:12px;padding:5px 10px;flex:0 0 auto;border-bottom:1px solid var(--lya-line)}
.lya-recording-heading{display:flex;align-items:baseline;gap:10px;min-width:0;flex:1}.lya-recording-heading strong{white-space:nowrap;font-size:12px}.lya-recording-heading span{font-size:11px;color:var(--lya-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-recording-header button{flex-shrink:0;font-size:12px!important}
.lya-recording-canvas{flex:1;min-height:40px;position:relative;background:#191d25}.lya-recording-canvas canvas{display:block}
.lya-recording-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 8px;flex:0 0 auto;border-top:1px solid var(--lya-line)}
.lya-recording-controls button{font-size:12px!important;white-space:nowrap}.lya-recording-controls input[type=range]{flex:1;min-width:70px;width:120px;padding:0}.lya-recording-controls [data-testid=recording-step]{font:11px/1.5 var(--lya-font-mono);color:var(--lya-muted);white-space:nowrap}
.lya-recording-source{padding:0 10px 5px;font:11px/1.5 var(--lya-font-mono);color:var(--lya-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}
/* Outputs 抽屉装着与右栏同一份 Recording/产物骨架（页头/空态/字段行/清单）——排版与
   .lya-wb-panel 同源，但作用域只到本 layer，不吃面板的 264px/绝对定位/关闭按钮几何。 */
.lya-wb-layer[data-layer=deliverable]{--lya-panel-divider:light-dark(#d7dde5,#2c3138);--lya-field:light-dark(#ffffff,#22262c);--lya-panel-action:light-dark(#2f6bd8,#3578ee)}
.lya-wb-layer[data-layer=deliverable] .lya-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-height:28px}
.lya-wb-layer[data-layer=deliverable] .lya-page-heading{display:flex;flex-direction:column;gap:3px;min-width:0}
.lya-wb-layer[data-layer=deliverable] .lya-eyebrow{font-size:11px;line-height:1.3;color:var(--lya-caption);letter-spacing:0}
.lya-wb-layer[data-layer=deliverable] .lya-page-title{margin:0;font-size:14px;line-height:1.35;font-weight:600;color:var(--lya-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.lya-wb-layer[data-layer=deliverable] .lya-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:88px;padding:12px 8px;text-align:center;color:var(--lya-muted);border:0;border-radius:0;background:transparent}
.lya-wb-layer[data-layer=deliverable] .lya-empty-icon{display:grid;place-items:center;width:22px;height:22px;color:var(--lya-caption)}
.lya-wb-layer[data-layer=deliverable] .lya-empty-state>strong{font-size:12px;font-weight:500;color:var(--lya-text)}
.lya-wb-layer[data-layer=deliverable] .lya-empty-state>span{font-size:11px;line-height:1.4;color:var(--lya-caption)}
.lya-wb-layer[data-layer=deliverable] .lya-empty-state .lya-row{justify-content:center;margin-top:6px}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-page-head{padding-right:0}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-receipt{padding:6px 0;border:0;border-bottom:1px solid var(--lya-panel-divider);border-radius:0;background:transparent}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-receipt:last-child{border-bottom:0}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-receipt .lya-row{gap:6px}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-recording-view{height:220px}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-recording-header{padding:4px 0}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-recording-controls{padding:4px 0}
.lya-wb-layer[data-layer=deliverable] .lya-recording-side .lya-recording-source{padding:4px 0}
.lya-wb-layer[data-layer=deliverable] .lya-field-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 2px;border-bottom:1px solid var(--lya-panel-divider);min-width:0}
.lya-wb-layer[data-layer=deliverable] .lya-field-row:last-child{border-bottom:0}
.lya-wb-layer[data-layer=deliverable] .lya-field-row>.lya-field-label{flex:1;min-width:0;margin:0;font-size:12px;font-weight:400;color:var(--lya-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-layer[data-layer=deliverable] .lya-field-row>.lya-field-value{font-size:11px;color:var(--lya-caption);white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.lya-wb-layer[data-layer=deliverable] .lya-section{min-height:20px;font-size:11px;letter-spacing:0;text-transform:none}
.lya-wb-layer[data-layer=deliverable] .lya-list{display:flex;flex-direction:column;gap:1px;min-width:0}
.lya-wb-layer[data-layer=deliverable] .lya-detail-box{background:transparent;border:1px solid var(--lya-panel-divider);padding:8px;gap:6px}
.lya-wb-layer[data-layer=deliverable] .lya-advanced{border-top:1px solid var(--lya-panel-divider);padding-top:8px;margin-top:2px}
.lya-wb-layer[data-layer=deliverable] .lya-advanced>summary{font-size:12px;padding:3px 0;color:var(--lya-muted)}
.lya-wb-layer[data-layer=deliverable] .lya-help{font-size:11px;line-height:1.45;margin:1px 0;color:var(--lya-muted)}
.lya-wb-layer[data-layer=deliverable] button{min-height:28px;padding:3px 8px;font-size:12px}
.lya-wb-layer[data-layer=deliverable] button.lya-chip{min-height:26px;padding:2px 9px;font-size:11px;font-weight:550;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-sm);background:transparent;color:var(--lya-muted)}
.lya-wb-layer[data-layer=deliverable] button.lya-chip:hover:not(:disabled){color:var(--lya-text);background:var(--lya-hover);border-color:var(--lya-line-3)}
.lya-wb-layer[data-layer=deliverable] .lya-primary{background:var(--lya-panel-action)!important;color:#fff!important;border-color:transparent!important;font-weight:600}
.lya-wb-layer[data-layer=deliverable] .lya-primary:hover:not(:disabled){background:#2f6bd8!important}
.lya-wb-layer[data-layer=deliverable] .lya-stop{background:color-mix(in srgb,var(--lya-danger) 12%,transparent)!important;color:var(--lya-danger)!important;border-color:color-mix(in srgb,var(--lya-danger) 28%,transparent)!important}
.lya-wb-layer[data-layer=deliverable] input,.lya-wb-layer[data-layer=deliverable] select,.lya-wb-layer[data-layer=deliverable] textarea{min-height:28px;padding:4px 8px;background:var(--lya-field);border-color:var(--lya-panel-divider);font-size:12px}
.lya-wb-layer[data-layer=deliverable] input[type=checkbox],.lya-wb-layer[data-layer=deliverable] input[type=range]{min-height:0;padding:0;background:transparent;border:0}
/* 最右工具栏：一条 44px 的图标竖列（P17 视觉减法，宽屏也不在图标下常驻文字）。
   分组小标题（data-group-label）把“工具”和“工作面”两组分开，窄栏隐藏；
   选中态＝底色 + 图标文字转强调色 + 左缘 3px 指示条，悬停/按下与键盘焦点三态都可辨。 */
.lya-rail{flex:0 0 var(--lya-rail-w);width:var(--lya-rail-w);display:flex;flex-direction:column;justify-content:space-between;gap:6px;padding:8px 2px;border-left:1px solid var(--lya-line-2);background:var(--lya-chrome);overflow:auto;overscroll-behavior:contain;scrollbar-width:none}
.lya-rail-group{display:flex;flex-direction:column;gap:2px;flex-shrink:0}
.lya-rail-group[data-group-label]::before{content:attr(data-group-label);display:block;margin:0 0 6px;color:var(--lya-caption);font-size:11px;font-weight:600;line-height:1.2;letter-spacing:0;text-align:center;text-transform:none}
.lya-rail-bottom{padding-top:8px;border-top:1px solid var(--lya-line)}
.lya-rail .lya-rail-item{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;width:100%;min-height:36px;padding:2px 1px;border:0;border-radius:var(--lya-r-sm);background:transparent;color:var(--lya-muted)}
.lya-rail-item::after{content:"";position:absolute;left:-5px;top:50%;width:2px;height:0;border-radius:0 2px 2px 0;background:var(--lya-accent);transform:translateY(-50%)}
.lya-rail-item:hover:not(:disabled){background:var(--lya-hover);color:var(--lya-text)}
.lya-rail-item:hover:not(:disabled)::after{height:10px;opacity:.5}
.lya-rail-item svg{flex:0 0 auto}
/* 图标轨：可见文字一律不常驻（宽屏也不铺）；名称由 aria-label/title 提供，聚焦/悬停提示仍可读。 */
.lya-rail-item .lya-rail-label{display:none}
/* 显式 compact：与默认一致，保留选择器以兼容既有调用方。 */
.lya-rail[data-compact] .lya-rail-label{display:none}
.lya-rail-item[aria-pressed=true]{background:var(--lya-accent-soft);color:var(--lya-accent)}
.lya-rail-item[aria-pressed=true]::after{height:18px}
.lya-rail-item[aria-pressed=true]:hover:not(:disabled){background:color-mix(in srgb,var(--lya-accent) 17%,var(--lya-bg))}
@media(max-width:1180px){.lya-wb{--lya-rail-w:40px}.lya-rail{gap:6px;padding:8px 2px}.lya-rail-group[data-group-label]::before{display:none}.lya-rail .lya-rail-item{gap:0;min-height:34px;padding:2px 0}.lya-rail .lya-rail-item::after{left:-3px}.lya-wb-panel{min-width:200px}}
@media(max-width:900px){.lya-wb-header .lya-status,.lya-wb-header .lya-scene-name{max-width:130px}}
/* 面板内的既有控件（保持原样式语言）。窗口式面板标题栏已删（PanelColumn 无标题栏），
   原 .lya-wb-panel>.lya-panel-title 死样式改造为小节头 .lya-section。 */
.lya-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:600;color:var(--lya-text)}
.lya-panel-title>button{border:0;background:transparent;font-size:16px;line-height:1;padding:0;width:26px;height:26px;min-height:26px;display:grid;place-items:center;border-radius:var(--lya-r-sm);color:var(--lya-muted)}
.lya-panel-title>button:hover:not(:disabled){background:var(--lya-active);color:var(--lya-text)}
/* 小节头：小字 uppercase 弱色标签 + 右侧计数/状态（opencode 小节头语义，无窗口标题栏）。 */
.lya-section{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 1px;color:var(--lya-caption);font-size:11px;font-weight:600;letter-spacing:0;text-transform:none}
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
.lya-wb .lya-robot-card{border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:8px 8px 10px;background:var(--lya-bg)}
.lya-robot-card>legend{padding:0 4px}
/* R-004 机器人库/实例/策略主路径：库行沿用环境候选卡，但必须是整行可点的按钮。 */
.lya-robot-library,.lya-policy-path{display:flex;flex-direction:column;gap:8px;min-width:0}
.lya-robot-library button.lya-env-card{width:100%;text-align:left;font:inherit}
.lya-robot-atomic{display:flex;flex-direction:column;gap:8px}
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
.lya-detail-box{display:flex;flex-direction:column;gap:6px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:8px;background:var(--lya-bg)}
.lya-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:0;font-size:11px;line-height:1.45}
.lya-kv>dt{color:var(--lya-caption);white-space:nowrap}
.lya-kv>dd{margin:0;color:var(--lya-text);overflow-wrap:anywhere}
.lya-tree{overflow:auto;max-height:34vh}.lya-tree-row{display:flex;align-items:center;gap:4px;min-height:30px;border-radius:var(--lya-r-sm)}.lya-tree-row:hover{background:var(--lya-hover)}.lya-tree-row[aria-selected=true]{background:var(--lya-active);box-shadow:inset 2px 0 0 var(--lya-emphasis)}.lya-tree-row button{border:0;background:none;padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}.lya-tree-row button:hover{background:transparent}.lya-tree-row .lya-tree-name{flex:1}
.lya-floating-panel{background:var(--lya-bg);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);padding:10px;box-shadow:0 8px 26px #0005;overflow:auto;display:flex;flex-direction:column;gap:8px}
.lya-modal{position:fixed;inset:0;z-index:60;background:#0006;display:grid;place-items:center}.lya-modal>.lya-floating-panel{width:min(420px,90vw)}
/* 画布上的选中条：只说“选中了谁”，动作都在右面板里，不重复铺同一动作。 */
.lya-selection-bar{position:absolute;left:10px;bottom:10px;display:flex;gap:8px;align-items:center;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:2;box-shadow:var(--lya-shadow-2)}.lya-selection-bar strong{font-size:12.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-selection-bar button{font-size:11.5px;padding:4px 8px}
 /* V10-08：放置条固定在画布底部；基准/坐标收进具名小菜单。 */
 .lya-placement-bar{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:2;box-shadow:var(--lya-shadow-2)}.lya-placement-bar strong{font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-placement-state{font-size:11px;color:var(--lya-muted);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}.lya-placement-bar[data-preview-status=unavailable] .lya-placement-state{color:var(--lya-warn)}.lya-placement-point{font:11px var(--lya-font-mono);color:var(--lya-muted);white-space:nowrap}.lya-placement-bar button{font-size:11.5px;padding:4px 8px}.lya-placement-options{position:relative;font-size:11px;color:var(--lya-muted)}.lya-placement-options>summary{cursor:pointer;white-space:nowrap}.lya-placement-options[open]{position:absolute;bottom:calc(100% + 8px);left:0;min-width:220px;padding:8px;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);background:var(--lya-chrome);box-shadow:var(--lya-shadow-2);z-index:3;display:flex;flex-direction:column;gap:6px}
 /* 临时拾取条（源安装点 / 停放位置）：同一浮层语言，但要压过被隐藏右栏，保证 Cancel/Confirm 可达。 */
 .lya-attach-picking-bar{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 20px);background:var(--lya-chrome);border:1px solid var(--lya-accent);border-radius:var(--lya-r-lg);padding:5px 8px;z-index:3;box-shadow:var(--lya-shadow-2)}
 .lya-attach-picking-bar strong{font-size:12.5px;color:var(--lya-accent);white-space:nowrap}
 .lya-attach-picking-bar .lya-help{flex:1 1 160px;min-width:0}
 .lya-attach-picking-bar button{font-size:11.5px;padding:4px 8px;flex:0 0 auto}
 /* 独立 Attach/Replace 二级页面：单一任务列，原概览被隐藏但挂载。 */
 .lya-attach-page{display:flex;flex-direction:column;gap:12px;min-width:0}
 .lya-attach{display:flex;flex-direction:column;gap:14px;min-width:0}
 .lya-attach-world{display:flex;flex-direction:column;gap:8px;border:1px solid color-mix(in srgb,var(--lya-warn) 45%,transparent);border-radius:var(--lya-r-md);padding:10px;background:color-mix(in srgb,var(--lya-warn) 8%,var(--lya-bg))}
 /* V8 Attach：首屏只保留 Source/Target/Mount 三段紧凑字段；安装面与对接变换进折叠，底部主操作常驻。 */
 .lya-attach-block{display:flex;flex-direction:column;gap:5px;min-width:0}
 .lya-attach-label{font-size:11px;line-height:1.2;letter-spacing:0;text-transform:none;color:var(--lya-caption)}
 .lya-attach-source{display:flex;align-items:center;gap:7px;min-width:0;font-size:12.5px;color:var(--lya-text)}
 .lya-attach-source>strong{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .lya-attach-source-icon{width:16px;height:16px;display:grid;place-items:center;flex:0 0 auto;color:var(--lya-muted);font-size:11px}
 .lya-attach-source-status{font-size:11px;line-height:1.4;margin:0;color:var(--lya-caption);overflow-wrap:anywhere}
 .lya-attach-source-status[data-state=blocked],.lya-attach-source-status[data-state=required]{color:var(--lya-warn)}
 .lya-attach-source-status[data-state=set]{color:var(--lya-muted)}
 .lya-attach-inline-link{border:0!important;background:transparent!important;padding:0!important;min-height:0!important;color:var(--lya-panel-action)!important;font-size:11px!important;line-height:inherit!important;text-align:left;text-decoration:underline;text-underline-offset:2px}
 .lya-attach-fold{border-top:1px solid var(--lya-panel-divider);padding-top:6px;margin-top:1px;min-width:0}
 .lya-attach-fold>summary{display:flex;align-items:center;gap:8px;min-height:26px;font-size:12px;color:var(--lya-text);cursor:pointer;list-style:none;min-width:0}
 .lya-attach-fold>summary::-webkit-details-marker{display:none}
 .lya-attach-fold>summary::before{content:"›";display:inline-block;width:10px;flex:0 0 auto;color:var(--lya-caption);transition:transform .12s}
 .lya-attach-fold[open]>summary::before{transform:rotate(90deg)}
 .lya-attach-fold-hint{font-size:10.5px;color:var(--lya-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;min-width:0;margin-left:auto}
 .lya-attach-fold-hint[data-state=required],.lya-attach-fold-hint[data-state=blocked]{color:var(--lya-warn)}
 .lya-attach-fold-body{display:flex;flex-direction:column;gap:7px;padding:5px 0 2px 18px;min-width:0}
 .lya-attach-status{font-size:11px;line-height:1.4;margin:0;min-height:16px;color:var(--lya-muted)}
 .lya-attach-status[data-state=applied]{color:var(--lya-ok)}
 .lya-attach-status[data-state=warn]{color:var(--lya-warn)}
 .lya-attach-status[data-state=preview]{color:var(--lya-text)}
 .lya-attach-foot{position:sticky;bottom:-16px;z-index:2;margin:auto -16px -16px;padding:10px 16px 14px;background:var(--lya-panel-bg);border-top:1px solid var(--lya-panel-divider);display:flex;flex-direction:column;gap:5px}
 .lya-attach-foot-actions{display:flex;align-items:center;gap:6px;min-width:0}
 .lya-attach-foot-actions>button{min-width:0}
 .lya-attach-foot-actions>button[data-testid=assembly-attach-preview],.lya-attach-foot-actions>button[data-testid=assembly-attach-apply]{flex:1 1 0}
 .lya-attach-details{margin-top:2px}
 .lya-wb-panel .lya-attach{gap:9px}
 .lya-wb-panel .lya-attach-block{gap:4px}
 .lya-wb-panel .lya-attach-label{font-size:11px}
 .lya-wb-panel .lya-attach-fold>summary{min-height:24px;font-size:12px}
 .lya-wb-panel .lya-attach-fold-body{gap:6px;padding-left:16px}
 .lya-wb-panel .lya-attach-source{font-size:12.5px}
  /* Notes 底部浮条：画布底部一条紧凑输入，默认只一行；列表/坐标/说明/截图收进按需菜单。 */
  .lya-notes-bar{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:4;display:flex;align-items:center;gap:8px;max-width:calc(100% - 20px);min-width:0;background:var(--lya-chrome);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);padding:5px 8px;box-shadow:var(--lya-shadow-2)}
  .lya-notes-bar .lya-notes-mark{display:inline-flex;color:var(--lya-accent);flex:0 0 auto}
  .lya-notes-bar .lya-notes-hint{font-size:11.5px;color:var(--lya-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .lya-notes-bar .lya-notes-hint[data-state=blocked]{color:var(--lya-warn)}
  .lya-notes-target{font-size:11.5px;color:var(--lya-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;flex:0 0 auto}
  .lya-notes-bar .lya-notes-input{flex:1 1 200px;min-width:90px;max-width:520px;resize:none;height:30px;padding:5px 8px;line-height:1.4}
  .lya-notes-bar .lya-notes-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .lya-notes-bar .lya-notes-icon{width:28px;height:28px;min-height:28px;padding:0;display:grid;place-items:center;border-radius:var(--lya-r-sm)}
  .lya-notes-bar .lya-notes-send{display:inline-flex;align-items:center;gap:5px;height:28px;min-height:28px;padding:2px 9px!important}
  .lya-notes-bar .lya-notes-send span{font-size:11.5px}
  /* 更多菜单：贴浮条向上弹出，默认收起；不铺满画布。 */
  .lya-notes-more{position:relative}
  .lya-notes-more>summary{list-style:none;width:28px;height:28px;min-height:28px;display:grid;place-items:center;border-radius:var(--lya-r-sm);cursor:pointer;color:inherit}
  .lya-notes-more>summary::-webkit-details-marker{display:none}
  .lya-notes-more>summary:hover{background:var(--lya-hover)}
  .lya-notes-more[open]>summary{background:var(--lya-active)}
  .lya-notes-menu{position:absolute;bottom:calc(100% + 8px);right:0;width:min(320px,80vw);max-height:min(60vh,420px);overflow:auto;display:flex;flex-direction:column;gap:10px;padding:10px 12px;background:var(--lya-bg);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);box-shadow:var(--lya-shadow-2)}
  .lya-notes-section{display:flex;flex-direction:column;gap:6px;min-width:0}
  .lya-notes-section>strong{font-size:11px;color:var(--lya-caption);font-weight:600;letter-spacing:.04em}
  /* 浮条出现时把底部选中条抬起来，两块不互盖。 */
  .lya-wb-canvas[data-notes-open] .lya-selection-bar{bottom:56px}
  /* 窄画布：隐藏实体名，让输入框拿到空间，浮条两端留边。 */
  @media(max-width:1100px){.lya-notes-target{display:none}}
  @media(max-width:640px){.lya-notes-bar{left:8px;right:8px;transform:none;max-width:none}}
  /* 批注列表：编号是显示序号（与标记、截图三处同源），文字直接在列表里编辑，不额外开弹层。 */
  .lya-annotation-list{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:8px}
  .lya-annotation-list li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:8px;background:var(--lya-bg)}
  .lya-annotation-list li[data-active]{border-color:var(--lya-accent);box-shadow:inset 0 0 0 1px var(--lya-accent)}
  .lya-annotation-list li[data-orphan]{border-style:dashed;opacity:.75}
  .lya-annotation-pin{width:22px;height:22px;border-radius:99px;background:#ffd34d;color:#121a24;font:600 12px var(--lya-font-mono);border:1px solid #121a24;padding:0}
  .lya-annotation-body{display:flex;flex-direction:column;gap:4px;min-width:0}
  .lya-annotation-target{font:11px var(--lya-font-mono);color:var(--lya-muted);overflow-wrap:anywhere}
  .lya-annotation-remove{background:none;border:0;color:var(--lya-muted);font-size:15px;line-height:1;padding:2px 4px}
  .lya-annotation-shot{margin:6px 0;display:flex;flex-direction:column;gap:3px}.lya-annotation-shot img{width:100%;border-radius:4px;border:1px solid var(--lya-line)}
.lya-viewport-state{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:24px;pointer-events:none}
.lya-viewport-card{flex:0 1 440px;min-width:0;max-width:100%;max-height:100%;overflow:auto;padding:22px;background:var(--lya-bg);color:var(--lya-text);border:1px solid var(--lya-line-2);border-radius:var(--lya-r-lg);box-shadow:var(--lya-shadow-2);pointer-events:auto;text-align:left}
.lya-viewport-card strong{font-size:15px;font-weight:600;letter-spacing:-.01em}.lya-viewport-card p{margin:10px 0;font-size:12px;line-height:1.7;color:var(--lya-muted)}
.lya-viewport-card details{margin-top:14px}.lya-viewport-card pre{font:11px/1.6 var(--lya-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.lya-scene-empty{text-align:center}.lya-scene-empty .lya-row{justify-content:center;margin:12px 0}
.lya-empty{display:grid;place-items:center;flex:1;min-height:160px;color:var(--lya-muted);padding:25px;text-align:center}
.lya-wb .lya-property-editor{display:flex;flex-direction:column;gap:8px;background:var(--lya-hover);border:0;border-radius:var(--lya-r-md);padding:10px}.lya-property-editor>label.lya-field-label{display:block;font-size:11px;color:var(--lya-muted)}.lya-property-editor>label>input,.lya-property-editor>label>textarea{display:block;margin-top:4px}
.lya-values{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.lya-values label{display:block}.lya-values input{width:100%!important}
.lya-joint{display:grid;grid-template-columns:minmax(75px,1fr) 63px 90px;gap:5px;align-items:center;padding:4px 0;border-bottom:1px solid var(--lya-line)}.lya-joint input{width:90px!important}.lya-joint small{font-size:11px;color:var(--lya-caption)}.lya-joint code{font-family:var(--lya-font-mono);font-size:11px;color:var(--lya-accent-text,var(--lya-muted));text-align:right}
.lya-advanced{border-top:1px solid var(--lya-line);padding-top:8px}.lya-advanced>summary{font-size:12px;padding:4px 0}
.lya-asset-library{display:flex;flex-direction:column;gap:6px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);padding:9px;background:var(--lya-hover)}
.lya-receipt{padding:8px;background:var(--lya-hover);border-radius:var(--lya-r-md);border:1px solid var(--lya-line)}.lya-receipt p{margin:2px 0}.lya-receipt pre{max-height:140px;overflow:auto;font-size:11px;white-space:pre-wrap}
.lya-captures{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.lya-captures figure{margin:0;display:flex;flex-direction:column;gap:4px}.lya-captures img{width:100%;border-radius:4px;border:1px solid var(--lya-line)}
.lya-wb-status{position:relative;min-width:0;max-width:100%;padding:0 12px;display:flex;gap:8px;align-items:center;border-top:1px solid var(--lya-line);background:var(--lya-chrome);color:var(--lya-muted);font-size:11.5px;line-height:1.4;min-height:32px;flex:0 0 auto}
.lya-wb-status button{flex-shrink:0;white-space:nowrap;min-height:26px!important;padding:3px 6px!important;font-size:11.5px!important}.lya-revision{white-space:nowrap;color:var(--lya-muted);flex-shrink:0}.lya-wb-status [data-testid=world-step]{white-space:nowrap;font-variant-numeric:tabular-nums;flex-shrink:0}
.lya-status-message{display:flex;align-items:center;gap:5px;flex:1;min-width:0}.lya-status-summary,.lya-world-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lya-status-summary{flex:1}.lya-world-status{display:flex;align-items:center;gap:5px;min-width:0;max-width:55%;flex:0 1 auto}.lya-world-label{flex:0 1 auto}.lya-world-status[data-world-phase=failed],.lya-world-status[data-world-phase=blocked]{color:var(--lya-bad)}
.lya-status-details{position:absolute;left:8px;right:8px;bottom:calc(100% + 6px);z-index:45;max-height:min(240px,35vh);overflow:auto;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);padding:10px 12px;background:var(--lya-bg);color:var(--lya-text);box-shadow:var(--lya-shadow-2)}.lya-status-details pre{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.6 var(--lya-font-mono)}
/* 底栏默认只留短状态与必要动作；rev/step 等运行读数收进“运行信息”展开区，阻断/失败仍由状态文本常驻。 */
.lya-status-meta{position:relative;flex-shrink:0}.lya-status-meta>summary{cursor:pointer;list-style:none;color:var(--lya-muted);font-size:11.5px;padding:2px 6px;white-space:nowrap}.lya-status-meta>summary::-webkit-details-marker{display:none}.lya-status-meta>summary:hover,.lya-status-meta[open]>summary{color:var(--lya-text)}.lya-status-meta-body{position:absolute;right:0;bottom:calc(100% + 6px);z-index:45;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);background:var(--lya-bg);color:var(--lya-text);box-shadow:var(--lya-shadow-2);white-space:nowrap;font-variant-numeric:tabular-nums}

/* 右上角 文件/终端 图标按钮。 */
.lya-wb-topbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0!important;border-radius:var(--lya-r-sm)}
.lya-wb-topbtn[aria-pressed="true"]{background:var(--lya-active);border-color:var(--lya-line-2)!important}
/* 图标栏：去掉分组小标题占位。 */
.lya-rail-group[data-group-label]::before{content:none}
.lya-rail .lya-rail-item{display:flex;align-items:center;justify-content:center;min-height:36px;padding:2px 0}


/* 应用层并列侧栏宿主：工具窗脱离 sidepage 层，由实际工作台边界定位在图标条左侧。
   宿主带 lya-wb 类（native-workspace.tsx），--lya-* 令牌与控件皮肤对 portal 内容可用；
   宿主自身透明、不裁阴影，背景/描边只画在面板上；未测量时隐藏，避免开窗先覆盖工具轨。 */
.lya-appside-panel-host{position:fixed;top:0;bottom:auto;right:0;width:0;height:0;visibility:hidden;z-index:40;pointer-events:none;background:transparent;overflow:visible}
.lya-appside-panel-host .lya-wb-panel{position:relative;inset:auto;width:100%!important;min-width:0;max-width:none;height:100%;pointer-events:auto;border-left:1px solid var(--lya-line-2);background:var(--lya-chrome);box-shadow:-14px 0 36px rgba(0,0,0,.38);animation:lya-panel-fade-in .18s ease-out}
@keyframes lya-panel-fade-in{from{opacity:0}to{opacity:1}}

/* 场景标题（原 场景▾ 按钮改为纯文本）。 */
.lya-wb-title{font-weight:600;font-size:13px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`

export const workbenchStyle = frameStyle + libraryStyle + `
.lya-viewport-overlays{position:absolute;inset:12px 12px auto;z-index:2;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none}
/* 视口帮助入口：默认只是一枚小 chip，展开才挂载并显示完整键位；可聚焦、可点击、再点关闭。 */
.lya-viewport-help{pointer-events:auto;max-width:min(380px,calc(100% - 8px));min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.lya-wb .lya-viewport-help-toggle{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;min-height:0;border-radius:var(--lya-r-sm);background:color-mix(in srgb,var(--lya-bg) 86%,var(--lya-text) 14%);border:1px solid var(--lya-line-2);color:var(--lya-muted);font-size:11px}
.lya-wb .lya-viewport-help-toggle:hover:not(:disabled){color:var(--lya-text);background:var(--lya-hover)}
.lya-viewport-help[data-open] .lya-viewport-help-toggle{color:var(--lya-text)}
.lya-viewport-help-body{max-width:100%;padding:6px 9px;border-radius:var(--lya-r-sm);background:var(--lya-bg);border:1px solid var(--lya-line-2);color:var(--lya-muted);font-size:11px;line-height:1.45;pointer-events:auto}
.lya-viewport-import{align-self:flex-end;max-width:100%;padding:6px 10px;border-radius:var(--lya-r-sm);background:var(--lya-bg);color:var(--lya-text);pointer-events:auto;font-size:11px}
.lya-viewport-import label{flex-wrap:wrap}.lya-viewport-import select{max-width:100%}
.lya-viewport-overlays>.lya-placement-bar,.lya-viewport-overlays>.lya-attach-picking-bar{position:static;transform:none;align-self:center;max-width:100%;flex-wrap:wrap;justify-content:center;pointer-events:auto}
.lya-viewport-overlays>.lya-attach-picking-bar{z-index:3}
.lya-file-drop-hint{position:absolute;z-index:100;top:16px;left:50%;transform:translateX(-50%);pointer-events:none;padding:12px 20px;border-radius:var(--lya-r-md);background:var(--lya-emphasis);color:var(--lya-emphasis-fg);font-weight:600}
.lya-wb-canvas[data-drop-target]{outline:2px solid var(--lya-emphasis);outline-offset:-3px}

/* ── V9：Lyapunov 自有面板统一骨架（264px / 16px 内边距 / 32px 清单行 / 28px 控件） ──
   选择器全部限定在工具面板、画布浮条与自有状态栏，不经过 body 或通用 button/input，
   原生 Sidebar/Chat/Session/Files/Terminal 的字体、间距与颜色不变。 */
.lya-wb-panel{
  /* color-scheme 从外层原生主题继承；light-dark() 只写在本面板的局部变量上，不碰 .lya-wb/body/原生 Chat/Files/Terminal。 */
  --lya-panel-bg:light-dark(#f7f8fa,#181b1f);
  --lya-field:light-dark(#ffffff,#22262c);
  --lya-panel-divider:light-dark(#d7dde5,#2c3138);
  --lya-panel-text:light-dark(#1a1f26,#e1e6ec);
  --lya-panel-secondary:light-dark(#5b6572,#929ca9);
  --lya-panel-action:light-dark(#2f6bd8,#3578ee);
  /* 面板内共用这一份局部前景/次级/线色；作用域止于 .lya-wb-panel。 */
  --lya-text:var(--lya-panel-text);
  --lya-muted:var(--lya-panel-secondary);
  --lya-caption:var(--lya-panel-secondary);
  --lya-line:var(--lya-panel-divider);
  --lya-line-2:color-mix(in srgb,var(--lya-panel-divider) 78%,transparent);
  --lya-line-3:color-mix(in srgb,var(--lya-panel-divider) 60%,transparent);
  --lya-hover:color-mix(in srgb,var(--lya-panel-text) 6%,transparent);
  --lya-active:color-mix(in srgb,var(--lya-panel-text) 10%,transparent);
  --lya-accent-soft:color-mix(in srgb,var(--lya-panel-action) 13%,var(--lya-panel-bg));
  width:264px!important;min-width:230px;max-width:52%;color:var(--lya-panel-text);background:var(--lya-panel-bg)!important;border-left:1px solid var(--lya-panel-divider)!important;
}
.lya-wb-panel .lya-panel-head{position:absolute;top:8px;right:8px;z-index:3;display:flex;justify-content:flex-end;pointer-events:none}
.lya-wb-panel .lya-panel-close{pointer-events:auto;width:28px;height:28px;min-height:28px;padding:0;display:grid;place-items:center;border-radius:var(--lya-r-sm);color:var(--lya-caption);font-size:17px;line-height:1;background:transparent;border:0}
.lya-wb-panel .lya-panel-close:hover:not(:disabled){background:var(--lya-hover);color:var(--lya-text)}
.lya-wb-panel .lya-wb-panel-body{padding:14px 16px 16px;gap:12px;background:transparent;overflow-x:hidden}
/* 面板 body 的 flex 链必须穿透 active/retained 包装层；否则 PanelPage 的 flex:1 与 footer 的
   margin-top:auto 都失效，底部动作停在内容下面。包装层本身常驻但隐藏时 display:none，不占双份空间。 */
.lya-panel-slot{display:flex;flex-direction:column;gap:0;min-width:0;min-height:0;flex:1 0 auto}
.lya-panel-slot[hidden]{display:none!important}
.lya-panel-seat{display:flex;flex-direction:column;flex:1 0 auto;min-height:0;min-width:0}
.lya-panel-seat[hidden]{display:none!important}
.lya-robot-home:has(.lya-library-resource-page)>.lya-page-head,
.lya-robot-home:has(.lya-library-resource-page)>.lya-segment,
.lya-robot-home:has(.lya-library-resource-page)>details{display:none}
.lya-wb-panel .lya-panel-page{display:flex;flex-direction:column;gap:12px;min-width:0;flex:1 0 auto;padding-right:0}
/* 环境二级页保留 environment-detail-header / environment-world-header 测试锚点；锚点只做兼容宿主，
   display:contents 不产生额外盒子，返回仍由 PanelPage 的 back/onBack 唯一承担。 */
.lya-wb-panel .lya-panel-page.lya-environment-detail{display:contents}
.lya-wb-panel .lya-robot-detail-root{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;flex:1 0 auto}
.lya-wb-panel .lya-robot-detail-root>.lya-robot-atomic{margin-top:auto}
.lya-wb-panel .lya-robot-detail-root>.lya-robot-failure{margin-top:0}
/* footer 在短页贴底、长页随内容到末尾可滚达；仍只作用于自有面板。 */
.lya-wb-panel .lya-back{display:inline-flex;align-items:center;align-self:flex-start;min-height:24px!important;padding:0!important;border:0!important;background:transparent!important;color:var(--lya-caption);font-size:11px!important;letter-spacing:0}
.lya-wb-panel .lya-back:hover:not(:disabled){color:var(--lya-text)!important;background:transparent!important}
.lya-wb-panel .lya-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-height:28px;padding-right:22px}
.lya-wb-panel .lya-page-heading{display:flex;flex-direction:column;gap:3px;min-width:0}
.lya-wb-panel .lya-eyebrow{font-size:11px;line-height:1.3;color:var(--lya-caption);letter-spacing:0}
.lya-wb-panel .lya-page-title{margin:0;font-size:14px;line-height:1.35;font-weight:600;color:var(--lya-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.lya-wb-panel .lya-page-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto;padding-top:1px}
.lya-wb-panel .lya-panel-section{display:flex;flex-direction:column;gap:4px;min-width:0}
.lya-wb-panel .lya-scene-groups{display:flex;flex-direction:column;gap:10px;min-width:0}
.lya-wb-panel .lya-scene-group{display:flex;flex-direction:column;gap:2px;min-width:0}
.lya-wb-panel .lya-scene-group>.lya-section{padding:0 6px}
.lya-wb-panel .lya-section{min-height:20px;font-size:11px;letter-spacing:0;text-transform:none}
.lya-wb-panel .lya-list{display:flex;flex-direction:column;gap:1px;min-width:0}
.lya-wb-panel .lya-list-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--lya-text);text-align:left;font-size:12px;line-height:1.35}
.lya-wb-panel button.lya-list-row{min-height:32px;padding:4px 6px;border:0}
.lya-wb-panel .lya-list-row:hover:not(:disabled){background:var(--lya-hover)}
.lya-wb-panel .lya-list-row[data-selected]{background:var(--lya-accent-soft);box-shadow:inset 2px 0 0 var(--lya-panel-action)}
.lya-wb-panel .lya-row-icon{width:18px;height:18px;display:grid;place-items:center;flex:0 0 auto;color:var(--lya-muted)}
.lya-wb-panel .lya-list-row[data-selected] .lya-row-icon{color:var(--lya-text)}
/* P12：库行真实缩略图（随包官方位图走 model-preview 字节路由）；无位图的行保持 .lya-row-icon 占位。 */
.lya-wb-panel .lya-row-thumb{width:48px;height:48px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--lya-line);border-radius:6px;overflow:hidden;background:var(--lya-hover)}
.lya-wb-panel .lya-row-thumb img{width:100%;height:100%;object-fit:contain;display:block}
.lya-wb-panel .lya-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.lya-wb-panel .lya-row-title{font-size:12px;line-height:1.35;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* P03/P04：264px 行名必须真省略，不能被按钮/行容器硬裁。 */
.lya-wb-panel .lya-tree-row .lya-row-main{min-width:0;overflow:hidden}
.lya-wb-panel .lya-tree-row .lya-row-title{max-width:100%;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-row-subtitle{font-size:11px;line-height:1.35;color:var(--lya-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-row-side{font-size:11px;color:var(--lya-caption);white-space:nowrap;flex:0 0 auto;font-variant-numeric:tabular-nums}
.lya-wb-panel .lya-row-chevron{color:var(--lya-caption);font-size:14px;line-height:1;flex:0 0 auto}
.lya-wb-panel [data-testid=world-warning-details]{min-width:0;overflow-wrap:anywhere}
.lya-wb-panel [data-testid=world-warning-detail] p{margin:4px 0}
.lya-wb-panel .lya-field-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 2px;border-bottom:1px solid var(--lya-panel-divider);min-width:0}
.lya-wb-panel .lya-field-row:last-child{border-bottom:0}
.lya-wb-panel .lya-field-row>.lya-field-label{flex:1;min-width:0;margin:0;font-size:12px;font-weight:400;color:var(--lya-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-field-row>.lya-field-value{font-size:11px;color:var(--lya-caption);white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.lya-wb-panel .lya-panel-foot{position:sticky;bottom:-16px;z-index:2;margin:auto -16px -16px;padding:10px 16px 14px;background:var(--lya-panel-bg);border-top:1px solid var(--lya-panel-divider);display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
.lya-wb-panel .lya-foot-actions{display:flex;align-items:center;gap:6px;min-width:0}
.lya-wb-panel .lya-foot-actions>button{flex:0 0 auto}
.lya-wb-panel .lya-foot-note{font-size:11px;line-height:1.4;color:var(--lya-caption)}
.lya-wb-panel .lya-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:88px;padding:12px 8px;text-align:center;color:var(--lya-muted);border:0;border-radius:0;background:transparent}
.lya-wb-panel .lya-empty-icon{display:grid;place-items:center;width:22px;height:22px;margin-bottom:0;border-radius:0;background:transparent;color:var(--lya-caption)}
.lya-wb-panel .lya-empty-state>strong{font-size:12px;font-weight:500;color:var(--lya-text)}
.lya-wb-panel .lya-empty-state>span{font-size:11px;line-height:1.4;color:var(--lya-caption)}
.lya-wb-panel .lya-empty-state .lya-row{justify-content:center;margin-top:6px}
.lya-wb-panel button{min-height:28px;padding:3px 8px;font-size:12px}
.lya-wb-panel button.lya-chip{min-height:26px;padding:2px 8px;font-size:11px}
.lya-wb-panel input,.lya-wb-panel select,.lya-wb-panel textarea{min-height:28px;padding:4px 8px;background:var(--lya-field);border-color:var(--lya-panel-divider);font-size:12px}
.lya-wb-panel input[type=checkbox]{min-height:0;padding:0;background:transparent;border:0}
.lya-wb-panel input[type=color]{min-height:24px;padding:1px;width:36px}
.lya-wb-panel input[type=range]{min-height:0;padding:0;background:transparent;border:0}
.lya-wb-panel .lya-primary{background:var(--lya-panel-action)!important;color:#fff!important;border-color:transparent!important;font-weight:600}
.lya-wb-panel .lya-primary:hover:not(:disabled){background:#2f6bd8!important}
.lya-wb-panel .lya-stop{background:color-mix(in srgb,var(--lya-danger) 12%,transparent)!important;color:var(--lya-danger)!important;border-color:color-mix(in srgb,var(--lya-danger) 28%,transparent)!important}
.lya-wb-panel .lya-property-editor{background:transparent;border:0;border-radius:0;padding:0;gap:8px}
.lya-wb-panel .lya-robot-card,.lya-wb-panel .lya-robot-atomic{border:0;border-radius:0;padding:0;background:transparent;gap:8px}
.lya-wb-panel .lya-attach,.lya-wb-panel .lya-attach-page{gap:10px}
.lya-wb-panel .lya-attach-world{padding:8px;border-radius:6px}
.lya-wb-panel .lya-property-editor>legend{font-size:11px;letter-spacing:0;color:var(--lya-caption);margin-bottom:2px}
.lya-wb-panel .lya-advanced{border-top:1px solid var(--lya-panel-divider);padding-top:8px;margin-top:2px}
.lya-wb-panel .lya-advanced>summary{font-size:12px;padding:3px 0;color:var(--lya-muted)}
.lya-wb-panel .lya-advanced>summary:hover{color:var(--lya-text)}
.lya-wb-panel .lya-help{font-size:11px;line-height:1.45;margin:1px 0;color:var(--lya-muted)}
.lya-wb-panel .lya-detail-box{background:transparent;border:1px solid var(--lya-panel-divider);padding:8px;gap:6px}
.lya-wb-panel .lya-kv{font-size:11px}
.lya-wb-panel .lya-tree{max-height:none}
.lya-wb-panel [data-testid="world-physics-panel"] .lya-world-status{max-width:100%;width:100%;align-items:flex-start;flex-wrap:wrap}
.lya-wb-panel [data-testid="world-physics-panel"] .lya-world-label{flex:1 1 130px;white-space:normal;overflow:visible;text-overflow:clip}
.lya-wb-panel [data-testid="world-physics-panel"] .lya-status-details-toggle{flex:0 0 auto;white-space:nowrap}
.lya-wb-panel .lya-tree-row{min-height:32px;padding:2px 4px}
.lya-wb-panel .lya-tree-row:hover{background:var(--lya-hover)}
.lya-wb-panel .lya-tree-row[data-selected]{background:var(--lya-accent-soft);box-shadow:inset 2px 0 0 var(--lya-panel-action)}
.lya-wb-panel .lya-tree-toggle{width:18px;height:24px;min-height:24px;padding:0;display:grid;place-items:center;border:0;background:transparent;color:var(--lya-caption);font-size:11px;flex:0 0 auto}
.lya-wb-panel button.lya-row-main{border:0;background:transparent;padding:1px 0;min-height:26px;display:flex;flex-direction:column;align-items:flex-start;gap:0;text-align:left;cursor:pointer;color:inherit;flex:1;min-width:0}
.lya-wb-panel button.lya-row-main:hover:not(:disabled){background:transparent}
.lya-wb-panel .lya-scene-row-actions{display:flex;align-items:center;gap:1px;flex:0 0 auto;opacity:0;pointer-events:none;transition:opacity .12s}
.lya-wb-panel .lya-tree-row:hover .lya-scene-row-actions,.lya-wb-panel .lya-tree-row[data-selected] .lya-scene-row-actions,.lya-wb-panel .lya-tree-row:focus-within .lya-scene-row-actions{opacity:1;pointer-events:auto}
.lya-wb-panel .lya-scene-row-actions .lya-icon-button{width:22px;height:22px;min-height:22px;padding:0;font-size:11px}
.lya-wb-panel .lya-scene-row-actions input[type=checkbox]{width:13px;height:13px}
.lya-wb-panel .lya-segment{padding:2px;background:var(--lya-field);border-radius:6px}
.lya-wb-panel .lya-segment button{min-height:24px;font-size:11px;padding:2px 8px}
.lya-wb-panel .lya-env-card{padding:4px 6px;border:0;border-radius:6px;background:transparent;min-height:32px}
.lya-wb-panel .lya-env-card:hover{background:var(--lya-hover)}
.lya-wb-panel .lya-env-thumb{width:24px;height:24px;border:0;background:transparent}
.lya-wb-panel .lya-env-main>strong{font-size:12px;font-weight:400}
.lya-wb-panel .lya-env-main>span{font-size:11px}
.lya-wb-panel .lya-env-actions .lya-chip{min-width:28px}
.lya-wb-panel .lya-badge{font-size:11px;padding:0 6px;border-radius:99px;min-height:18px}
.lya-wb-panel .lya-values input{min-height:26px;padding:3px 5px}
.lya-wb-panel .lya-notes-bar{/* Notes 浮条不属于面板，这里不放宽 */}

/* V8 主行动与主画布浮条共用 28px 节奏；只作用于 Lyapunov 自有浮条。 */
.lya-placement-bar button,.lya-attach-picking-bar button,.lya-selection-bar button,.lya-notes-bar button{min-height:26px;padding:3px 8px;font-size:11.5px}
.lya-placement-bar,.lya-attach-picking-bar,.lya-selection-bar,.lya-notes-bar{border-radius:8px}
/* 窄窗口：不收缩成不可读；让面板贴住画布右缘并保留 8px 边距，确认/取消仍可达。 */
@media(max-width:980px){
  .lya-wb-panel{width:246px!important;min-width:214px;max-width:calc(100% - 8px)}
  .lya-wb-panel .lya-wb-panel-body{padding:12px 12px 14px}
}

/* V9：二级页/列表/相机/路线/录制共用的小结构（全部限定在 Lyapunov 自有面板）。 */
.lya-wb-panel .lya-object-inspector-head{display:flex;align-items:center;gap:8px;min-height:28px;padding-right:22px}
.lya-wb-panel .lya-object-inspector-head .lya-page-title{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-object-meta{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--lya-caption);padding:0 2px}
/* V9：Policy 选择器标签独占一行，输入吃满 264px 内容宽度，不再和长标签挤成两列。 */
.lya-wb-panel .lya-policy-card>label.lya-field-label{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:100%;min-width:0;font-size:11px;color:var(--lya-muted)}
.lya-wb-panel .lya-policy-card>label.lya-field-label>select,.lya-wb-panel .lya-policy-card>label.lya-field-label>input{width:100%;max-width:100%;min-width:0}
/* V8-14：Start/Stop/Freeze/Restore 在 264px 内容里 2×2 可达；不改 disabled/target 语义。 */
.lya-wb-panel .lya-robot-atomic>.lya-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%}
.lya-wb-panel .lya-robot-atomic>.lya-row>button{width:100%;min-width:0;min-height:28px;padding:3px 6px}
/* V8-19/20：机位二级页返回+名称同栏一行。 */
.lya-wb-panel .lya-camera-subhead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}
.lya-wb-panel .lya-camera-subhead .lya-back{flex:0 0 auto}
.lya-wb-panel .lya-camera-subhead-title{min-width:0;font-size:14px;font-weight:600;color:var(--lya-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-policy-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:36px;padding:2px 0;border-bottom:1px solid var(--lya-panel-divider)}
.lya-wb-panel .lya-policy-status>.lya-badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.lya-wb-panel .lya-attach-page,.lya-wb-panel .lya-attach{flex:1 0 auto}
.lya-wb-panel [data-camera-task]{flex:1 0 auto;min-height:0;min-width:0}
.lya-wb-panel [data-camera-task]>.lya-panel-foot{order:20}
.lya-wb-panel .lya-policy-status .lya-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.lya-wb-panel .lya-policy-status .lya-row-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-policy-status .lya-row-subtitle{font-size:11px;color:var(--lya-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-camera-summary{display:flex;flex-direction:column;gap:2px;min-width:0}
.lya-wb-panel .lya-camera-summary>.lya-row{padding-top:6px;flex-wrap:wrap}
.lya-wb-panel .lya-capture-state{display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 6px;border:1px solid var(--lya-panel-divider);border-radius:6px;background:var(--lya-field)}
.lya-wb-panel .lya-capture-state .lya-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.lya-wb-panel .lya-capture-state .lya-row-title{font-size:12px}
.lya-wb-panel .lya-capture-state .lya-row-subtitle{font-size:11px;color:var(--lya-caption);font-variant-numeric:tabular-nums}
.lya-wb-panel .lya-live-dot{width:7px;height:7px;border-radius:50%;background:var(--lya-danger);box-shadow:0 0 0 3px color-mix(in srgb,var(--lya-danger) 16%,transparent);flex:0 0 auto}
.lya-wb-panel .lya-route-stops{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:0}
.lya-wb-panel .lya-route-stops>li{display:flex;align-items:center;gap:4px;min-height:32px;padding:2px 3px;border-radius:6px;min-width:0}
.lya-wb-panel .lya-route-stops>li[data-selected]{background:var(--lya-accent-soft);box-shadow:inset 2px 0 0 var(--lya-panel-action)}
.lya-wb-panel .lya-route-stops .lya-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:0}
.lya-wb-panel .lya-route-stops .lya-row-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-route-stops .lya-row-subtitle{font-size:11px;color:var(--lya-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-wb-panel .lya-route-stops button{min-height:24px;padding:1px 5px;font-size:11px}
.lya-wb-panel .lya-route-stops input{width:58px!important;min-height:24px;padding:2px 4px}
.lya-wb-panel .lya-route-pin{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--lya-field);border:1px solid var(--lya-panel-divider);color:var(--lya-muted);font-size:11px;font-weight:600;flex:0 0 auto}
.lya-wb-panel .lya-route-pin[aria-pressed=true]{background:var(--lya-panel-action);border-color:var(--lya-panel-action);color:#fff}
.lya-wb-panel .lya-route-pose{display:flex;flex-direction:column;gap:2px;min-width:0;padding:4px 0;border-top:1px solid var(--lya-panel-divider)}
.lya-wb-panel .lya-route-stop-menu{position:relative;flex:0 0 auto}
.lya-wb-panel .lya-route-stop-menu>summary{list-style:none;width:22px;height:24px;min-height:24px;display:grid;place-items:center;border-radius:4px;color:var(--lya-caption);cursor:pointer}
.lya-wb-panel .lya-route-stop-menu>summary::-webkit-details-marker{display:none}
.lya-wb-panel .lya-route-stop-menu[open]>summary,.lya-wb-panel .lya-route-stop-menu>summary:hover{background:var(--lya-hover);color:var(--lya-text)}
.lya-wb-panel .lya-route-stop-editor{position:absolute;right:0;top:calc(100% + 4px);z-index:8;width:190px;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--lya-panel-divider);border-radius:6px;background:var(--lya-panel-bg);box-shadow:var(--lya-shadow-2)}
.lya-wb-panel .lya-route-stop-editor label{display:flex;justify-content:space-between;gap:6px;font-size:11px;color:var(--lya-muted)}
.lya-wb-panel .lya-route-stop-editor input{width:64px!important}
.lya-wb-panel .lya-camera-summary .lya-field-row:last-of-type{border-bottom:0}
.lya-wb-panel .lya-capture-home{display:flex;flex-direction:column;gap:12px;min-width:0}
.lya-wb-panel .lya-capture-route{display:flex;flex-direction:column;gap:12px;min-width:0}
.lya-wb-panel .lya-list-row>.lya-icon-button{width:24px;height:24px;min-height:24px;padding:0;display:grid;place-items:center;color:var(--lya-caption);flex:0 0 auto}
/* 画布底部拍摄小浮条：自由/路线共用，进度/停止/取消只此一处；不占面板首屏。 */
.lya-capture-session-bar{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:8px;max-width:calc(100% - 20px);min-width:0;padding:5px 8px;border:1px solid var(--lya-line-2);border-radius:8px;background:var(--lya-chrome);color:var(--lya-text);box-shadow:var(--lya-shadow-2)}
.lya-capture-session-bar .lya-live-dot{width:7px;height:7px;border-radius:50%;background:var(--lya-danger);box-shadow:0 0 0 3px color-mix(in srgb,var(--lya-danger) 16%,transparent);flex:0 0 auto}
.lya-capture-session-bar .lya-capture-session-main{display:flex;align-items:baseline;gap:7px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lya-capture-session-bar .lya-capture-session-main strong{font-size:11.5px;font-weight:600;flex:0 0 auto}
.lya-capture-session-bar .lya-capture-session-main span{font-size:11px;color:var(--lya-muted);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
.lya-capture-session-bar button{min-height:26px;padding:3px 8px;font-size:11.5px;flex:0 0 auto}
.lya-capture-session-bar .lya-capture-pov{height:54px;width:auto;max-width:112px;border-radius:4px;border:1px solid var(--lya-line-2);background:#000;flex:0 0 auto;object-fit:contain}
.lya-wb-canvas[data-notes-open] .lya-capture-session-bar{bottom:56px}
@media(max-width:640px){.lya-capture-session-bar{left:8px;right:8px;transform:none;max-width:none}.lya-capture-session-bar .lya-capture-session-main span{display:none}}
.lya-wb-panel .lya-channel-row{gap:4px 10px;flex-wrap:wrap}
.lya-wb-panel .lya-channel-row>label{flex:0 0 auto;white-space:nowrap;font-size:11px}
.lya-wb-panel .lya-recording-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.lya-wb-panel .lya-recording-side .lya-page-head{padding-right:0}
.lya-wb-panel .lya-recording-side .lya-receipt{padding:6px 0;border:0;border-bottom:1px solid var(--lya-panel-divider);border-radius:0;background:transparent}
.lya-wb-panel .lya-recording-side .lya-receipt:last-child{border-bottom:0}
.lya-wb-panel .lya-recording-side .lya-receipt .lya-row{gap:6px}
.lya-wb-panel .lya-recording-side .lya-recording-view{height:220px}
.lya-wb-panel .lya-recording-side .lya-recording-header{padding:4px 0}
.lya-wb-panel .lya-recording-side .lya-recording-controls{padding:4px 0}
.lya-wb-panel .lya-recording-side .lya-recording-source{padding:4px 0}

/* 确保 libraryStyle 的旧尺寸不覆盖 V9 面板节奏（同一选择器顺序：放在最后的规则生效）。 */
`
