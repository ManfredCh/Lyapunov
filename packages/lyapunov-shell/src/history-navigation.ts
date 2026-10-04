import type {HistoryEntryRecord} from './workbench-api.ts'

export type ExistingHistoryEntry=Pick<HistoryEntryRecord,'id'|'cwd'|'cwdExists'|'current'|'archived'>
/** 从本窗口原生引用计数读取主会话；其他保留正文或后台引用不会变成主选择。 */
export function mainSessionId<Id extends string>(snapshot:{byId:Readonly<Record<string,{id:Id;retainedBy:Readonly<Partial<Record<'mainView',number>>>}|undefined>>}):Id|undefined {
 return Object.values(snapshot.byId).find(row=>row!==undefined&&(row.retainedBy.mainView??0)>0)?.id
}
export interface HistoryNavigationPort {
 refresh():Promise<void>
 snapshot():{phase:string;byId:Readonly<Record<string,{id:string;cwd?:string;retainedBy:Readonly<Partial<Record<'mainView',number>>>}|undefined>>}
 open(sessionId:string):void
}

/** 历史目录提供候选，原生Session目录提供地址权威；只选择同SID，不新建/复制/改cwd。 */
export async function openExistingHistorySession(entry:ExistingHistoryEntry,port:HistoryNavigationPort,signal?:AbortSignal):Promise<{sessionId:string;opened:true}> {
 if(!entry.current)throw Error('HISTORY_FOREIGN_ROOT_COPY_REQUIRED: 其他运行根的会话须先显式复制恢复。')
 if(entry.archived)throw Error('HISTORY_SESSION_ARCHIVED: 请先在原生设置中解除归档。')
 if(!entry.cwdExists)throw Error('HISTORY_CWD_UNAVAILABLE: 原工作目录不在场，不能换目录假装打开。')
 const origin=mainSessionId(port.snapshot())
 signal?.throwIfAborted()
 await port.refresh()
 signal?.throwIfAborted()
 const current=port.snapshot()
 if(mainSessionId(current)!==origin)throw Error('HISTORY_NAVIGATION_SUPERSEDED: 会话选择已改变，本次历史导航已取消。')
 if(current.phase!=='ready')throw Error('HISTORY_SESSION_DIRECTORY_UNAVAILABLE: 当前原生会话目录尚未就绪。')
 const target=current.byId[entry.id]
 if(!target)throw Error('HISTORY_SESSION_NOT_ADDRESSABLE: 当前原生目录没有该会话；记录仍在，不另造副本。')
 if(target.cwd!==entry.cwd)throw Error('HISTORY_SESSION_CWD_MISMATCH: 原生目录与历史记录的工作目录不一致。')
 port.open(entry.id)
 return {sessionId:entry.id,opened:true}
}
