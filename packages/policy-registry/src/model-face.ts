/**
 * 端点给的 `policy.model` 的**形状收束**（唯一一份，宿主侧与浏览器侧面板共用）。
 *
 * 为什么要单独一个模块：宿主侧（`model-routes.ts` 的 `policyModels` 服务）与浏览器侧（包面板）
 * 都要把同一份服务端元数据收成 `PackModelFace`。各写一份就会出现"面板说能取、决策说不能取"这种
 * 两边不一致的读数。本模块**零导入**（只有类型导入，编译后为空），所以浏览器包能安全引用。
 *
 * 纪律：形状不对（旧服务端/被中间层改写）一律返回 **null**（表示"端点没给模型面"），
 * 由调用方自己决定怎么说——**绝不**按包名、件状态或历史猜一个来源出来。
 */
import type { PackModelFace } from './pack-contract.ts'

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
/** 端点未给模型面时的**派生态**（与内容侧声明码不同名：不把"服务端没给"说成"被限制"）。 */
export const MODEL_FACE_UNDECLARED: PackModelFace = {
  source: null, provenance: '', files: [], bytes: null, requiresAuth: null,
  downloadable: false, status: 'blocked', code: 'MODEL_FACE_UNDECLARED',
  detail: '端点未给出 policy.model（服务端元数据缺模型面）；客户端不凭包名推断来源，故不给下载入口',
}
/** 收束一份 `policy.model`：返回 null ⇒ 端点没给（或形状不认识），调用方如实说"事实缺失"。 */
export function packModelFace(raw: unknown): PackModelFace | null {
  if (!isObject(raw) || (raw.status !== 'fetchable' && raw.status !== 'blocked')) return null
  const source = isObject(raw.source) && typeof raw.source.provider === 'string' && typeof raw.source.modelId === 'string' && typeof raw.source.revision === 'string'
    ? { provider: raw.source.provider, modelId: raw.source.modelId, revision: raw.source.revision } : null
  const downloadable = raw.status === 'fetchable' && raw.downloadable === true
  return {
    source,
    provenance: typeof raw.provenance === 'string' ? raw.provenance : '',
    files: (Array.isArray(raw.files) ? raw.files : []).filter((file: unknown): file is string => typeof file === 'string' && file.length > 0),
    bytes: Number.isSafeInteger(raw.bytes) && raw.bytes >= 0 ? Number(raw.bytes) : null,
    // 取件前提照抄（不认识就 null）：面板只说端点给的那一种，不替端点猜凭据种类。
    requiresAuth: typeof raw.requiresAuth === 'string' && raw.requiresAuth ? raw.requiresAuth : null,
    downloadable,
    status: downloadable ? 'fetchable' : 'blocked',
    code: typeof raw.code === 'string' && raw.code ? raw.code : null,
    detail: typeof raw.detail === 'string' && raw.detail ? raw.detail : null,
  }
}
