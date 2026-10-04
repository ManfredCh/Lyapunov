export const accountLocales={
  zh:{guest:"以游客身份继续",guestHint:"本地体验，可在工作台配置自己的模型。",guestLabel:"游客 · 自有模型可配置",guestStarting:"正在进入本地工作台…",language:"语言",theme:"主题",system:"跟随系统",light:"浅色",dark:"深色",title:"欢迎使用 Lyapunov",intro:"用自然语言构建和控制你的 3D 世界。",signInHint:"使用 Lyapunov 账户，在浏览器中完成登录。",or:"或",backToSignIn:"返回登录",restoring:"正在恢复登录…",waiting:"请在浏览器中完成授权，完成后将自动进入工作台。",starting:"正在进入工作台…",login:"使用 Lyapunov 账户登录",cancel:"取消",retry:"重试连接",reconnect:"重新连接",workspace:"返回工作台",isolation:"你的场景、会话和插件使用独立账户目录。",points:"可用点数",available:"可用",reserved:"预留",used:"已用",usageUnavailable:"暂不可用",usageSyncing:"同步中…",usageLedgerUnavailable:"暂无法读取账户流水；已用点数不会猜测。",refresh:"刷新余额与订单",commerceUnavailable:"暂无法读取套餐、订单或付款方式。请检查桌面账户连接后重试。",bridgeUnavailable:"桌面账户桥接能力不可用；原生注入传输能力就绪前无法提供远程账户或计费操作。请从 Lyapunov 桌面应用打开此页面。",switchAccount:"切换账户",logout:"退出登录",plans:"套餐",loadingPlans:"正在读取可用套餐…",orders:"订单记录",loadingOrders:"正在读取订单…",emptyOrders:"暂无订单。",order:"订单",amount:"金额",status:"状态",time:"时间",pending:"待付款",paid:"已付款",cancelled:"已取消",refunded:"已退款",method:"付款方式",alipay:"支付宝",wechat:"微信支付",checkout:"前往付款",credits:"点",updates:"检查更新",latest:"当前已是最新版本",install:"下载并重启安装？",versionFound:"发现版本",needDesktop:"请从 Lyapunov 桌面应用打开账户页面。"},
  en:{guest:"Continue as guest",guestHint:"Explore locally. Bring your own model provider.",guestLabel:"Guest · Configure your own provider",guestStarting:"Entering the local workspace…",language:"Language",theme:"Theme",system:"System",light:"Light",dark:"Dark",title:"Welcome to Lyapunov",intro:"Build and control your 3D world with natural language.",signInHint:"Sign in to your Lyapunov account in your browser.",or:"or",backToSignIn:"Back to sign in",restoring:"Restoring sign-in…",waiting:"Complete authorization in your browser to continue to your workspace.",starting:"Entering your workspace…",login:"Continue with Lyapunov",cancel:"Cancel",retry:"Retry connection",reconnect:"Reconnect",workspace:"Open workspace",isolation:"Your scenes, sessions and plugins use a separate account directory.",points:"Available credits",available:"Available",reserved:"Reserved",used:"Used",usageUnavailable:"Unavailable",usageSyncing:"Syncing…",usageLedgerUnavailable:"Account ledger is unavailable; used credits are not estimated.",refresh:"Refresh balance and orders",commerceUnavailable:"Plans, orders, or payment methods are unavailable. Check the desktop account connection and try again.",bridgeUnavailable:"The desktop account bridge is unavailable; remote account and billing actions require a native injected transport. Open this page from the Lyapunov desktop app.",switchAccount:"Switch account",logout:"Sign out",plans:"Plans",loadingPlans:"Loading available plans…",orders:"Order history",loadingOrders:"Loading orders…",emptyOrders:"No orders yet.",order:"Order",amount:"Amount",status:"Status",time:"Time",pending:"Pending",paid:"Paid",cancelled:"Cancelled",refunded:"Refunded",method:"Payment method",alipay:"Alipay",wechat:"WeChat Pay",checkout:"Continue to payment",credits:"credits",updates:"Check for updates",latest:"You are up to date",install:"Download and restart to install?",versionFound:"New version",needDesktop:"Open the account page from the Lyapunov desktop app."},
} as const
export type AccountLocale=keyof typeof accountLocales
export type AccountTexts=typeof accountLocales[AccountLocale]

/** 桌面只投影现有界面选择；工作台的持久选择仍归 DSH locale 所有。 */
export type DesktopLocaleState={active:AccountLocale;requested?:AccountLocale;revision:number}
export function accountLocale(value:unknown):AccountLocale|undefined {
 if(typeof value!=="string")return
 const primary=value.toLowerCase().split(/[-_]/)[0]
 return primary==="zh"||primary==="en"?primary:undefined
}
export class DesktopLocaleMirror {
 private snapshot:DesktopLocaleState
 private workspaceReported=false
 constructor(initial:AccountLocale){this.snapshot={active:initial,revision:0}}
 getSnapshot(){return this.snapshot}
 report(active:AccountLocale,source:"account"|"workspace",requested=false){
  if(source==="account"&&!requested&&(this.workspaceReported||this.snapshot.requested))return this.snapshot
  if(source==="workspace"&&this.snapshot.requested&&active!==this.snapshot.requested)return this.snapshot
  if(source==="workspace")this.workspaceReported=true
  const selection=source==="account"&&requested?active:source==="workspace"?undefined:this.snapshot.requested
  if(active===this.snapshot.active&&selection===this.snapshot.requested)return this.snapshot
  return this.snapshot={active,...selection?{requested:selection}:{},revision:this.snapshot.revision+1}
 }
}
export const desktopLocales={
 zh:{guest:"游客",exitTitle:"退出 Lyapunov",exitMessage:"保存草稿并退出？",exitDetail:"有 {dirtyDrafts} 份草稿、{runningActions} 项运行任务/动作。保存草稿后停止本工作台并退出；已提交的场景更改保留，旧动作不会自动重发。",exitUnknown:"当前草稿/动作状态无法读取。确认后尝试保存与停止；未确认保存时会保留窗口。",cancel:"取消",saveAndExit:"保存并退出",exitFailedTitle:"尚未退出",exitFailedMessage:"草稿保存或停止未确认，窗口已保留",workspace:"返回工作台",rendererUnavailable:"渲染窗口不可用，草稿状态未确认",rendererTimeout:"渲染窗口退出 {phase} 超时",participantUnconfirmed:"退出参与者未确认",account:"账户",quit:"退出",edit:"编辑",undo:"撤销",redo:"重做",cut:"剪切",copy:"复制",paste:"粘贴",selectAll:"全选",view:"视图",reload:"重新加载",fullscreen:"全屏",devtools:"开发工具"},
 en:{guest:"Guest",exitTitle:"Quit Lyapunov",exitMessage:"Save drafts and quit?",exitDetail:"There are {dirtyDrafts} drafts and {runningActions} running tasks or actions. Save drafts, stop this workspace, and quit. Submitted scene changes are retained; previous actions will not be sent again automatically.",exitUnknown:"The current draft and action state could not be read. Confirmation will attempt to save and stop; the window stays open if saving cannot be confirmed.",cancel:"Cancel",saveAndExit:"Save and quit",exitFailedTitle:"Still open",exitFailedMessage:"Draft saving or stopping could not be confirmed. The window remains open.",workspace:"Return to workspace",rendererUnavailable:"The renderer is unavailable; draft state is unconfirmed.",rendererTimeout:"The renderer timed out during exit {phase}.",participantUnconfirmed:"An exit participant did not confirm completion.",account:"Account",quit:"Quit",edit:"Edit",undo:"Undo",redo:"Redo",cut:"Cut",copy:"Copy",paste:"Paste",selectAll:"Select all",view:"View",reload:"Reload",fullscreen:"Full screen",devtools:"Developer tools"},
} as const
