/** 素材浏览与复用的独立视觉规则，不影响原生对话样式。 */
export const libraryStyle = `
/* 素材库由本体按“找到、了解、加入场景”的操作顺序设计；排版沿用工作台的圆角/描边/文字层级令牌。 */
.lya-library{display:flex;flex-direction:column;gap:16px}
.lya-library-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.lya-eyebrow{display:block;color:var(--lya-caption);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.lya-library-heading h3{display:flex;align-items:center;gap:8px;margin:6px 0 0;font-size:17px;font-weight:620;letter-spacing:-.01em;line-height:1.25}
.lya-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 6px;border-radius:9px;background:var(--lya-hover);color:var(--lya-muted);font-size:11px;font-weight:600;letter-spacing:0;font-variant-numeric:tabular-nums}
.lya-icon-button{width:28px;height:28px;min-height:28px!important;padding:0!important;display:grid;place-items:center;border-radius:var(--lya-r-sm);color:var(--lya-muted)}
.lya-icon-button:hover:not(:disabled){color:var(--lya-text)}
.lya-library-intro{margin:0;color:var(--lya-muted);font-size:12px;line-height:1.7}
.lya-wb .lya-library-import{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;min-height:34px;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);background:var(--lya-bg);font-size:12.5px;font-weight:550}
.lya-wb .lya-library-import:hover:not(:disabled){border-color:var(--lya-line-3);background:var(--lya-hover)}
.lya-library-import>span{font-size:15px;font-weight:400;line-height:1;color:var(--lya-muted)}
.lya-library-search{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 10px;border:1px solid var(--lya-line-2);border-radius:var(--lya-r-md);background:var(--lya-bg);color:var(--lya-caption)}
.lya-wb .lya-library-search input{flex:1;min-width:0;padding:6px 0;border:0;background:transparent;font-size:12.5px}
.lya-library-search:focus-within{border-color:var(--lya-accent);box-shadow:0 0 0 3px var(--lya-accent-soft)}
.lya-wb .lya-library-search input:focus-visible{outline:none}
.lya-wb .lya-library-search button{padding:2px 4px;font-size:11px;color:var(--lya-muted)}
.lya-library-filter{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--lya-caption);font-size:11.5px}
.lya-library-filter label{gap:6px}
.lya-library-list{display:flex;flex-direction:column;gap:10px}
.lya-asset-card{padding:11px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-bg)}
.lya-asset-card:hover{border-color:var(--lya-line-2)}
.lya-asset-overview{display:flex;align-items:center;gap:10px;margin-bottom:11px;min-width:0}
.lya-asset-mark{display:grid;place-items:center;width:42px;height:42px;flex:none;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-chrome);color:var(--lya-accent)}
.lya-asset-description{display:flex;flex-direction:column;gap:4px;min-width:0}
.lya-asset-description>strong{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lya-asset-description>span{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.04em;color:var(--lya-caption);flex-wrap:wrap}
.lya-asset-description i{font-style:normal}
.lya-asset-description em{font-style:normal;color:var(--lya-warn)}
.lya-wb .lya-asset-use{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:32px;padding:6px 10px;border-radius:var(--lya-r-md);background:var(--lya-accent-soft);color:var(--lya-accent);font-size:12px;font-weight:550}
.lya-wb .lya-asset-use:hover:not(:disabled){background:color-mix(in srgb,var(--lya-accent) 18%,var(--lya-bg))}
.lya-asset-requirement{margin:7px 0 0;color:var(--lya-caption);font-size:11px}
.lya-asset-details{margin-top:8px}
.lya-asset-details>summary{padding:6px 0;font-size:11.5px;color:var(--lya-caption)}
.lya-asset-details dl{margin:2px 0 10px;font-size:11px;line-height:1.6}
.lya-asset-details dt{color:var(--lya-caption);margin-top:8px}
.lya-asset-details dd{margin:3px 0 0;color:var(--lya-muted);overflow-wrap:anywhere}
.lya-asset-tags{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.lya-asset-tags>span{padding:2px 6px;border-radius:var(--lya-r-sm);background:var(--lya-hover);color:var(--lya-muted);font-size:10.5px;overflow-wrap:anywhere;max-width:100%}
.lya-asset-actions{display:flex;flex-wrap:wrap;gap:3px}
.lya-wb .lya-asset-actions button{min-height:26px;padding:3px 7px;font-size:11.5px}
.lya-asset-card[data-deleted=false] .lya-asset-actions button:last-child{color:var(--lya-danger)}
.lya-library-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 8px 30px;text-align:center}
.lya-library-empty-mark{display:grid;place-items:center;width:44px;height:44px;margin-bottom:4px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-chrome);color:var(--lya-caption)}
.lya-library-empty strong{font-size:13.5px;font-weight:600;color:var(--lya-text)}
.lya-library-empty p{margin:0;color:var(--lya-muted);font-size:11.5px;line-height:1.7;max-width:220px}
.lya-library-empty .lya-text-link{margin-top:2px}
.lya-wb .lya-text-link{color:var(--lya-accent);font-size:12px}
.lya-builtin{display:flex;flex-direction:column;gap:10px}
.lya-builtin-group{display:flex;flex-direction:column;gap:6px}
/* 域面板（机器人/物件/环境）的素材列表：沿用内置分组的行节奏，次要入口靠左不铺满。 */
.lya-domain{display:flex;flex-direction:column;gap:6px}
.lya-wb .lya-domain>.lya-text-link{align-self:flex-start;margin-top:2px;text-align:left}
.lya-library-import-section{padding:12px;border:1px solid var(--lya-line);border-radius:var(--lya-r-md);background:var(--lya-chrome)}
.lya-library-import-section[open]>summary{margin-bottom:10px}
.lya-wb :where(.lya-wb-header,.lya-wb-surface,.lya-rail,.lya-modal,.lya-wb-panel) :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--lya-accent);outline-offset:2px}
/* 按工作面的实际宽度响应：窄工作面把属性放在画布下方，仍可看到编辑结果。 */
@container workbench-surface (max-width:480px){
 .lya-wb-panel{left:0;width:100%!important;max-width:none;border-left:0;border-top:1px solid var(--lya-line)}
 .lya-wb-main:has(>.lya-wb-panel)>.lya-wb-centre{min-height:clamp(120px,34%,200px)}
 .lya-wb-panel-body{padding:12px 16px 14px}
 .lya-library-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;align-items:start}
 /* 浏览素材和环境时让出画布空间；加入后自动返回画布。对象编辑仍保留上下对照。 */
 .lya-wb-main:has(>.lya-wb-panel:is([data-tool=asset],[data-tool=environment]))>.lya-wb-centre{display:none}
 .lya-wb-panel:is([data-tool=asset],[data-tool=environment]){flex:1;height:auto;max-height:none;border-top:0}
 .lya-wb-panel:is([data-tool=asset],[data-tool=environment])>.lya-wb-panel-body{padding:16px 20px 20px}
}
.lya-wb[data-global-panel=true] .lya-wb-header,.lya-wb[data-global-panel=true] .lya-wb-admin,.lya-wb[data-global-panel=true] .lya-wb-surface,.lya-wb[data-global-panel=true] .lya-rail,.lya-wb[data-global-panel=true] .lya-wb-splitter,.lya-wb[data-global-panel=true] .lya-wb-status{display:none}
.lya-wb[data-global-panel=true] .lya-wb-conversation{display:flex;flex:1;max-width:none;width:auto!important;border:0}
@media(max-height:650px){.lya-wb-drawer{max-height:38%}.lya-rail-item{min-height:38px!important;gap:3px!important}.lya-rail-item .lya-rail-label{display:none!important}.lya-rail-group[data-group-label]::before{margin-bottom:4px}}
@media(prefers-reduced-motion:reduce){.lya-wb *{transition:none!important;scroll-behavior:auto!important}}
`
