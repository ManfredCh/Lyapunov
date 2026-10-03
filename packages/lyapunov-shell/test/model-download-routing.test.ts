import { test, expect } from 'bun:test'
import {
  credentialRequirementText, fileCountText, formatBytes, modelFaceText, weightDownloadArgs, weightSource,
  type ModelRouteLike,
} from '../src/model-download-routing.ts'
// 只做**对账**：取件选择项的目录判据是 `policyFileSelector`（带 node:fs，不能进浏览器包），
// 这里用它钉住本模块那条 `/` 结尾约定没有另立规则（`fileCountText` 按同一约定数件）。
import { policyFileSelector } from '../../policy-registry/src/source.ts'

/**
 * 模型面的**形状与显示口径**测试：用真实内容侧形状的模型面（来源坐标 + 文件清单 + 缓存回执）钉死面板
 * 依赖的那几条事实怎么说——来源坐标、件数、字节、取件前提、落盘状态、取件参数。（"每步要不要下载"的
 * 判定层已随 JEV 一并删除，本文件不再覆盖。）
 */
const face = (over: Partial<ModelRouteLike['model']> = {}) => ({
  source: { provider: 'github', modelId: 'inria-paris-robotics-lab/go2_onnx_controller', revision: 'c1729e1a4aa2e7e1091ccff42be68d42bd054764' },
  provenance: 'inria-paris-robotics-lab/go2_onnx_controller 仓内 onnx_inference/data/model.onnx',
  files: ['onnx_inference/data/model.onnx', 'onnx_controller/src/controller.cpp'],
  bytes: 8_000_000, downloadable: true, status: 'fetchable' as const, code: null, detail: null, requiresAuth: null, ...over,
})
const route = (over: Partial<ModelRouteLike> = {}): ModelRouteLike => ({ packId: 'unitree_go2', aliases: ['宇树Go2', 'Go2'], model: face(), cache: null, ...over })
// G0.5：hf-mirror 上有已复核的固定 revision 与四件清单，但该仓需授权 ⇒ 给入口 + 声明取件前提。
const g05 = (over: Partial<ModelRouteLike> = {}): ModelRouteLike => route({
  packId: 'robotstudio_so101', aliases: ['SO101', 'G0.5'],
  model: face({
    source: { provider: 'huggingface', modelId: 'OpenGalaxea/G05', revision: 'e312be81e90c56a55bcb26b57429bd39a335b449' },
    files: ['g05-so101/checkpoints/model_state_dict.pt', 'action_tokenizer.pt', 'g05-so101/.hydra/config.yaml', 'g05-so101/dataset_stats.json'],
    bytes: 11_947_599_150, requiresAuth: 'huggingface-token',
  }), ...over,
})
// 仍取不到的那一类：来源是 gs:// 且没声明文件级身份（pi05_droid 那个包）。
const unrouted = (over: Partial<ModelRouteLike> = {}): ModelRouteLike => route({
  packId: 'trossen_wx250s', aliases: ['WX250s', 'pi05_droid'],
  model: face({
    source: null, provenance: 'openpi pi05_droid（gs://openpi-assets/checkpoints/pi05_droid）',
    files: [], bytes: null, downloadable: false, status: 'blocked',
    code: 'MODEL_SOURCE_UNSUPPORTED', detail: '来源不在已实现取件来源内，且未声明文件级身份',
  }), ...over,
})

test('权重来源只认可取件的上游来源：packs 小件流不算，未声明可下载的不算', () => {
  // 合同 §0.5：权重的字节不从 packs 小件流拉 —— 声明成 packs 的模型面没有权重取件入口。
  expect(weightSource(route({ model: face({ source: { provider: 'packs', modelId: 'packs/x', revision: 'r1' } }) }))).toBeNull()
  expect(weightSource(route({ model: face({ downloadable: false, status: 'blocked' }) }))).toBeNull()
})

test('取件参数与登记的来源坐标、文件清单一致（面板就按这份参数调 policy_download）', () => {
  expect(weightDownloadArgs(route())).toEqual({ provider: 'github', modelId: 'inria-paris-robotics-lab/go2_onnx_controller', revision: 'c1729e1a4aa2e7e1091ccff42be68d42bd054764', files: ['onnx_inference/data/model.onnx', 'onnx_controller/src/controller.cpp'] })
  // 清单为空 ⇒ 没有可执行的取件参数（面板据此禁用取件按钮）。
  expect(weightDownloadArgs(route({ model: face({ files: [] }) }))).toBeNull()
})

test('文案只讲字节，不把"下好了"说成"能跑了"；字节数未登记如实写', () => {
  // 缓存三态分开说：读不到（null）不得写成"没下过"。
  expect(modelFaceText(route())).toContain('本机缓存未读')
  expect(modelFaceText(route({ cache: { status: 'NOT_DOWNLOADED', files: 0, bytes: 0 } }))).toContain('本机未下载')
  expect(modelFaceText(route({ cache: { status: 'DOWNLOADED', files: 3, bytes: 8_000_000 } }))).toContain('本机缓存 DOWNLOADED（3 件 / 7.6 MiB）')
  expect(formatBytes(null)).toBe('字节数未登记')
  expect(formatBytes(11_947_599_150)).toBe('11 GiB')
})

test('来源缺失分两种：登记了来源说明就原样带出（不编地址），真没登记才说未登记', () => {
  // 仍取不到的那一类：坐标不是已实现取件协议（gs:// 检查点）⇒ 不给 source，但内容侧登记了来源说明。
  const text = modelFaceText(unrouted())
  expect(text).toContain('未登记可校验取件坐标（登记来源说明：openpi pi05_droid')
  expect(text).toContain('0 件 / 字节数未登记')
  // 无来源坐标时缓存无从读起 ⇒ 不写缓存结论（不把"无从读起"说成"未读/没下过"）。
  expect(text).not.toContain('缓存')
  const bare = modelFaceText(route({ model: face({ source: null, provenance: '' }) }))
  expect(bare).toContain('未登记来源坐标')
  // 对照腿：π0.5 三个包现在**有**可校验坐标（ModelScope 等价镜像），文案里必须出现来源与件数口径；
  // 两个 `前缀/` 是**目录选择项**（固定清单上实际选中 29 件），不得写成"2 件权重"。
  const pi05 = route({ packId: 'aloha', aliases: ['ALOHA'], model: face({ source: { provider: 'modelscope', modelId: 'hairuoliu/pi05_base', revision: '171d7c8641a306698b2f82eea84325997de0f34f' }, files: ['assets/', 'params/'], bytes: 12_441_749_581 }) })
  expect(modelFaceText(pi05)).toContain('modelscope:hairuoliu/pi05_base@171d7c8641a3…')
  expect(modelFaceText(pi05)).toContain('2 个目录选择项（实际文件由固定来源清单确定） / 12 GiB')
  expect(modelFaceText(pi05)).not.toContain('2 件')
  // 取件**参数**不受文案修正影响：仍然原样传两个选择项（不改下载行为、不把 29 硬编码进去）。
  expect(weightDownloadArgs(pi05)).toEqual({ provider: 'modelscope', modelId: 'hairuoliu/pi05_base', revision: '171d7c8641a306698b2f82eea84325997de0f34f', files: ['assets/', 'params/'] })
})

test('件数口径：目录选择项不数成"件"（π0.5 的 2 个前缀 ≠ 2 件权重），精确文件清单照旧 N 件', () => {
  // 精确文件清单：G0.5 四件 / Go2 三件 / 空清单照旧说"几件"（对照腿，别把修法扩成"一律不数"）。
  expect(fileCountText(g05().model.files)).toBe('4 件')
  expect(fileCountText(route().model.files)).toBe('2 件')
  expect(fileCountText([])).toBe('0 件')
  // 目录选择项：说清是几项、真实文件数由固定来源清单决定；**不**拿 2 个前缀猜出 29。
  expect(fileCountText(['assets/', 'params/'])).toBe('2 个目录选择项（实际文件由固定来源清单确定）')
  expect(fileCountText(['assets/', 'params/'])).not.toContain('2 件')
  // 混合清单（G1 适配器的 4 精确件 + meshes 目录前缀）两类分开说，前缀不算进"件"。
  const g1 = ['deploy/pre_train/g1/motion.pt', 'deploy/deploy_mujoco/configs/g1.yaml', 'deploy/deploy_mujoco/deploy_mujoco.py', 'resources/robots/g1_description/g1_12dof.xml', 'resources/robots/g1_description/meshes/']
  expect(fileCountText(g1)).toBe('4 件 + 1 个目录选择项（实际文件由固定来源清单确定）')
  expect(fileCountText(['a.pt', 'b.yaml'], 'en')).toBe('2 files')
  expect(fileCountText(['meshes/'], 'en')).toBe('1 directory selector (the actual files are fixed by the source manifest)')
  expect(fileCountText(['a.pt', 'meshes/'], 'en')).toBe('1 file + 1 directory selector (the actual files are fixed by the source manifest)')
  // 与取件选择项的判据同源：`policyFileSelector` 的 prefix 就是"以 `/` 结尾"，`fileCountText` 只复述同一约定
  // （不数成"1 件"的就是目录选择项）。
  for (const file of ['assets/', 'params/', 'a.pt', 'dir/x.yaml', 'resources/robots/g1_description/meshes/'])
    expect([file, fileCountText([file]) !== '1 件']).toEqual([file, policyFileSelector(file).prefix])
})
