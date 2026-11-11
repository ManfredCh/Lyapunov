import { useState } from 'react'

type Capabilities = { workflows: Array<{ tool: string; interpreter: boolean; sourceConfigured?: boolean }>; registered: string[] }
type Tr = (zh: string, en: string) => string

const examples = [
  ['asset_prepare_usd', '生成可仿真 USD', 'Prepare native USD', '把工作区的 box.glb 按 Y-up、缩放 0.1、质量 0.25 kg 转成凸包 USD。', 'Convert box.glb from Y-up at scale 0.1 into a 0.25 kg convex-hull USD.'],
  ['nurec_evaluate', 'NuRec 评分', 'Score NuRec', '用指定机位和参考帧给 scene.usdz 做同机位评分。', 'Score scene.usdz against reference frames from the selected camera.'],
  ['lab_mimic_run', 'Lab Mimic 回放与扩增', 'Replay or augment Lab Mimic', '回放工作区已标注的笛卡尔夹具示教，报告实际通过数。', 'Replay the annotated cart demonstrations and report actual successes.'],
  ['simfoundry_match_poses', 'SimFoundry 位姿配准', 'Fit SimFoundry object poses', '对已准备的桌面场景配准物体 0，返回 Z-up 候选。', 'Fit object 0 in the prepared tabletop and return the Z-up candidate.'],
] as const

export function SceneWorkflowHelp({ load, tr }: { load: () => Promise<Capabilities>; tr: Tr }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'failed'>('idle')
  const [capabilities, setCapabilities] = useState<Capabilities>()
  function refresh() {
    setStatus('loading')
    void load().then(result => { setCapabilities(result); setStatus('loaded') }, () => setStatus('failed'))
  }
  return <details className="lya-advanced" data-testid="scene-workflow-help" onToggle={event => {
    if (event.currentTarget.open && status !== 'loading') refresh()
  }}>
    <summary>{tr('这台工作台能做什么？', 'What can this workbench do?')}</summary>
    {status === 'loading' && <p role="status">{tr('正在读取工作流配置…', 'Checking workflow configuration…')}</p>}
    {status === 'failed' && <p role="status">{tr('当前主机无法读取工作流配置。', 'Workflow configuration is unavailable on this Host.')}</p>}
    {capabilities?.registered.length ? <p>{tr('已有入口', 'Registered tools')} · {capabilities.registered.join(' · ')}</p> : null}
    <ul>{examples.map(([tool, zh, en, promptZh, promptEn]) => {
      const row = capabilities?.workflows.find(item => item.tool === tool)
      const label = row === undefined ? undefined : !row.interpreter ? tr('缺少本地解释器', 'Local interpreter required')
        : row.sourceConfigured === false
          ? tool === 'lab_mimic_run' ? tr('可回放，扩增缺少上游源码', 'Replay configured; generation needs upstream source') : tr('缺少固定上游源码', 'Pinned upstream source required')
          : tr('本地运行时已配置', 'Local runtime configured')
      return <li key={tool}><strong>{tr(zh, en)}</strong>{label && <> · {label}</>}<p><code>{tr(promptZh, promptEn)}</code></p></li>
    })}</ul>
    <a href="https://vorynel.com/lyapunov/manual.html#agent-scene-workflows" target="_blank" rel="noreferrer">{tr('工作流操作手册', 'Workflow manual')}</a>
  </details>
}
