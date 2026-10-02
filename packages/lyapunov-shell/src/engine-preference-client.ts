/**
 * 物理引擎偏好的客户端读写（**唯一 owner 仍是 `script/engine-preference.ts`**，这里只读/写它的投影）。
 *
 * 为什么抽成 hook：工具轨在两种模式下由**两个不同组件**渲染——原生工作台模式是
 * `WorkspaceTools`（native-workspace.tsx），非原生模式是 `Workbench`（workbench.tsx）。
 * 两处各写一份「读 runtime-info + 调 ui_engine_switch」必然漂移：实测先只接了 Workbench 那份，
 * 原生模式下按钮就是空壳（既不写偏好、标签也恒显示"—"）。这里只负责状态与命令，
 * 提示/报错文案仍由各自组件决定（两处的展示位置不同）。
 */
import {useCallback, useEffect, useMemo, useState} from "react"
import {workbenchAPI} from "./workbench-api.ts"

/** Host 回写的引擎状态：`engine` 是**运行中**的值，`preference` 是偏好文件里的值。 */
export interface EnginePreferenceState { engine: string | null; preference: string | null }

/** 引擎偏好 hook：`switchEngine` 只写偏好文件、不重启 Host（引擎在启动时装配 Provider）。 */
export function useEnginePreference(sessionId: string | undefined): {
  state: EnginePreferenceState
  switchEngine: (next: "isaac" | "mujoco") => Promise<{ preference: string | null }>
} {
  const api = useMemo(() => workbenchAPI(sessionId ?? ""), [sessionId])
  const [state, setState] = useState<EnginePreferenceState>({engine: null, preference: null})
  useEffect(() => {
    let active = true
    void fetch("/api/lyapunov/runtime-info")
      .then(response => (response.ok ? response.json() : undefined))
      .then((value?: { engine?: string | null; enginePreference?: string | null }) => {
        if (active && value) setState({engine: value.engine ?? null, preference: value.enginePreference ?? null})
      })
      .catch(() => { /* 读不到就保持"—"，切换按钮仍可用 */ })
    return () => { active = false }
  }, [])
  const switchEngine = useCallback(
    (next: "isaac" | "mujoco") => api.command<{ preference?: string | null }>("ui_engine_switch", {engine: next})
      .then(value => {
        const preference = value?.preference ?? next
        setState(current => ({...current, preference}))
        return {preference}
      }),
    [api],
  )
  return {state, switchEngine}
}
