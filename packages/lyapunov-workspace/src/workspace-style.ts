/**
 * 文件工作面与终端抽屉的样式。
 *
 * 前两段是原浮层的样式（`.lyapunov-code`，自包含复合体仍在用，未改一个字符）；
 * 后一段是工作台里的**嵌入式形态**：外壳已经提供 `.lya-wb` 的框架与令牌，这里只补齐
 * 文件/终端自己的几何与控件皮肤，颜色同样取原生主题令牌（`--dsw-alias-*`），明暗跟随主题。
 */
const overlayStyle = `.lyapunov-code{position:fixed;inset:8% 3% 3% 17%;z-index:80;background:var(--bg-primary,#18202a);color:var(--text-primary,#dce5f2);border:1px solid #64758a;border-radius:12px;padding:16px;overflow:auto;box-shadow:0 12px 60px #0008}.lyapunov-code header,.lyapunov-code nav,.code-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}.lyapunov-code header small{flex:1;font-family:monospace}.lyapunov-code button,.lyapunov-code input,.lyapunov-code select{font:inherit;color:inherit;border:1px solid #617287;background:transparent;border-radius:5px;padding:6px 9px}.lyapunov-code button{cursor:pointer}.lyapunov-code button:disabled{opacity:.45}.lyapunov-code button[aria-pressed=true]{background:#345072}.lyapunov-code form{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}.lyapunov-code form input:not([type=checkbox]):not([type=number]){flex:1;min-width:110px}.lyapunov-code input[type=number]{width:70px}.code-columns{display:grid;grid-template-columns:minmax(180px,26%) minmax(0,1fr);gap:16px}.code-tree-hidden{grid-template-columns:minmax(0,1fr)}.code-picker{position:absolute;inset:55px 12% auto;max-height:65vh;overflow:auto;background:var(--bg-primary,#18202a);border:1px solid #789;padding:12px;z-index:2;box-shadow:0 8px 32px #0009}.code-columns aside{max-height:62vh;overflow:auto}.code-entry{display:block!important;text-align:left;width:100%;margin:4px 0;overflow-wrap:anywhere}.code-columns>article{min-width:0}.code-editor{box-sizing:border-box;width:100%;height:56vh;resize:vertical;font:13px/1.55 ui-monospace,monospace;tab-size:2;background:#101720;color:#e6eefe;white-space:pre;padding:12px}.code-terminal,.code-diff{padding:12px;background:#0a1018;color:#cfe1f5;min-height:180px;max-height:50vh;overflow:auto;white-space:pre;font:13px/1.5 ui-monospace,monospace}.diff-line{display:grid!important;grid-template-columns:36px 36px minmax(0,1fr);gap:8px;width:100%;border:0!important;border-radius:0!important;text-align:left;white-space:pre;font:inherit!important;padding:2px 4px!important}.diff-line span{color:#90a0b0;text-align:right}.diff-line code{font:inherit}.diff-line.add{background:#103323}.diff-line.remove{background:#48232a}.diff-line:hover{outline:1px solid #729acc}.diff-meta{color:#98aaca;min-height:1.5em}.code-extra{margin-top:16px;border-top:1px solid #536277;padding-top:12px}.code-extra summary{cursor:pointer}.code-hint{font-size:12px;opacity:.75}.code-error{color:#ffb6aa;white-space:pre-wrap}.code-match{display:block;width:100%;text-align:left;margin:8px 0}.code-match pre{white-space:pre-wrap}@media(max-width:800px){.lyapunov-code{inset:4% 2%}.code-columns{grid-template-columns:1fr}}`
const embeddedStyle = `
.lya-file-surface,.lya-terminal-surface{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;color:var(--lya-text,var(--dsw-alias-label-primary));text-align:left}
.lya-file-surface{padding:14px 16px;overflow:auto;background:var(--lya-bg,var(--dsw-alias-bg-base))}
.lya-file-surface-flat{padding:0;background:transparent}
.lya-file-surface .code-tabs{display:flex;gap:6px;margin:0;padding:0 0 10px;border-bottom:1px solid var(--lya-line)}
.lya-file-surface .code-columns{display:grid;grid-template-columns:minmax(140px,24%) minmax(0,1fr);gap:14px;flex:1;min-height:0;margin:0}
.lya-file-surface .code-tree-hidden{grid-template-columns:minmax(0,1fr)}
.lya-file-surface .code-columns>aside{max-height:none;min-width:0;overflow:auto;display:flex;flex-direction:column;gap:3px;padding-right:10px;border-right:1px solid var(--lya-line)}
.lya-file-surface .code-columns>article,.lya-file-article{display:flex;flex-direction:column;gap:11px;min-width:0;min-height:0;overflow:auto;margin:0}
.lya-file-surface .code-toolbar,.lya-terminal-surface .code-toolbar{margin:0;gap:7px;align-items:center;font-size:12px}
.lya-file-surface :is(button,input,select),.lya-terminal-surface :is(button,input,select){font:inherit;color:var(--lya-text);min-width:0;border-radius:7px;padding:6px 9px}
.lya-file-surface :is(input,select),.lya-terminal-surface :is(input,select){background:var(--lya-bg);border:1px solid var(--lya-line-2)}
.lya-file-surface button,.lya-terminal-surface button{cursor:pointer;background:transparent;border:1px solid transparent;min-height:31px}
.lya-file-surface button:hover:not(:disabled),.lya-terminal-surface button:hover:not(:disabled){background:var(--lya-hover)}
.lya-file-surface button:disabled,.lya-terminal-surface button:disabled{opacity:.4;cursor:default}
.lya-file-surface .code-tabs button[aria-pressed=true]{background:var(--lya-accent-soft);color:var(--lya-accent);font-weight:550}
/* 文件条目：小图标 + 名称；目录加粗、图标用强调色，行 hover 沿用按钮 hover 底色。 */
.lya-file-surface .code-entry{display:flex!important;align-items:center;gap:7px;margin:0;padding:7px 8px;text-align:left;font-size:12px;overflow-wrap:anywhere}
.lya-file-surface .code-entry-icon{flex:0 0 auto;color:var(--lya-muted)}
.lya-file-surface .code-entry[data-kind=directory]{font-weight:600}
.lya-file-surface .code-entry[data-kind=directory] .code-entry-icon{color:var(--lya-accent)}
.lya-file-surface .code-entry-name{flex:1;min-width:0;overflow-wrap:anywhere}
/* 目录树：chevron 占位列，目录 ▸/▾，文件留空对齐；加载行弱色省略号；缩进由行内 padding-left 按深度给。 */
.lya-file-surface .code-chevron{flex:0 0 auto;width:14px;text-align:center;color:var(--lya-muted);font-size:10px;line-height:1}
.lya-file-surface .code-tree-node{min-width:0}
.lya-file-surface .code-entry-loading{color:var(--lya-muted);padding-top:2px;padding-bottom:2px;cursor:default}
/* 原生文件页小节头：小字 uppercase 弱色 + 右侧条目计数（与工作台 .lya-section 同一语义）。 */
.lya-file-surface .code-nav-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 2px 7px;color:var(--lya-muted);font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.lya-file-surface .code-nav-title>span:last-child{letter-spacing:0;font-variant-numeric:tabular-nums}
.lya-file-surface .code-editor{flex:1;min-height:220px;width:100%;height:auto;resize:none;padding:16px;border:1px solid var(--lya-line);border-radius:8px;background:var(--lya-bg);color:var(--lya-text);font:13px/1.8 ui-monospace,"SFMono-Regular",Consolas,monospace}
.lya-terminal-surface .code-terminal{flex:1;min-height:100px;max-height:none;margin:0;padding:16px;border:1px solid var(--lya-line);border-radius:8px;background:var(--lya-chrome);color:var(--lya-text);font:12px/1.8 ui-monospace,"SFMono-Regular",Consolas,monospace}
.lya-file-surface form,.lya-terminal-surface form{display:flex;gap:7px;margin:0;flex-wrap:wrap}
.lya-file-surface form input:not([type=checkbox]):not([type=number]){flex:1;min-width:110px}
.lya-file-surface p[role=status]{margin:0;color:var(--lya-muted);font-size:12px}
.lya-file-surface .code-picker{inset:48px 8% auto;background:var(--lya-bg);border:1px solid var(--lya-line-2);border-radius:10px;max-height:55vh;box-shadow:0 12px 32px #00000020}
.lya-file-surface .code-hint,.lya-terminal-surface .code-hint{font-size:11px;line-height:1.6;color:var(--lya-muted);opacity:1}
.lya-project-files,.lya-scene-history{padding-bottom:8px;border-bottom:1px solid var(--lya-line)}
.lya-project-files[open]>summary{margin-bottom:10px}
.lya-project-files>.lya-field-label{display:block;color:var(--lya-muted);font-size:12px}
.lya-project-files .lya-row{margin-top:10px}

.lya-xterm-wrap{display:flex;flex-direction:column;height:100%;min-height:0;background:#0d1117}
.lya-xterm-toolbar{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
.lya-xterm-toolbar button{background:transparent;border:1px solid rgba(255,255,255,.14);color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.lya-xterm-toolbar button:hover{background:rgba(255,255,255,.08)}
.lya-xterm-status{font-size:12px;opacity:.65}
.lya-xterm{flex:1;min-height:0;padding:6px 0 6px 10px}
.lya-xterm .xterm{height:100%}
`
export const workspaceStyle = overlayStyle + embeddedStyle
