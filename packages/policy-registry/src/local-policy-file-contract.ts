/** 文件分类可在浏览器使用；实际字节、来源与模型合同仍由 Host 的现有读取操作验证。 */
export const LOCAL_POLICY_WEIGHT_EXTENSIONS=['pt','pth','jit','torchscript','onnx','safetensors'] as const
export const localPolicyBundlePath=(path:string):boolean=>/(?:^|[\\/])(?:bundle|[^\\/]+\.bundle)\.json$/i.test(path)
export function localPolicyFileKind(path:string):'bundle'|'weights'|undefined {
 if(localPolicyBundlePath(path))return 'bundle'
 const ext=path.split('.').pop()?.toLowerCase()
 return (LOCAL_POLICY_WEIGHT_EXTENSIONS as readonly string[]).includes(ext??'')?'weights':undefined
}
/** 仅给用户下一步明确文件名；不查找目录、不读取或推断这份 bundle 已存在。 */
export const siblingPolicyBundlePath=(path:string):string=>path.replace(/[^\\/]+$/,'bundle.json')
/** 由本地策略缓存 owner 返回的登记条目；没有 identity 的权重不能准备或应用。 */
export interface LocalPolicyEntry {
 id:string;label:string;registeredAt:string;available:boolean
 identity?:{provider:'github'|'modelscope'|'huggingface'|'packs';modelId:string;revision:string}
 adapterId?:string;sourceBytesVerified:boolean;licenseUnchecked?:boolean
}
/** 缓存真实路径只属于 Host；正式 UI 通过 entryId 请求 owner 解析。 */
export interface LocalPolicyLibraryEntry extends LocalPolicyEntry {filePath:string;missingLicense?:string[]}
