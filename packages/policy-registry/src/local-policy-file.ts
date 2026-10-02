import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {LOCAL_POLICY_WEIGHT_EXTENSIONS} from './local-policy-file-contract.ts'
/** 只读明确选定文件的有界格式检查，不反序列化pickle、不执行未知模型、不搜索目录。 */
export async function inspectLocalPolicyFile(path: string) {
  const ext = extname(path).toLowerCase()
  if (!(LOCAL_POLICY_WEIGHT_EXTENSIONS as readonly string[]).includes(ext.slice(1))) return { valid: false, code: 'POLICY_FILE_FORMAT_UNSUPPORTED', detail: '请选择Torch/ONNX/safetensors权重，或正规bundle.json' }
  let size: number
  try { const info = await stat(path); if (!info.isFile()) throw new Error(); size = info.size } catch { return { valid: false, code: 'POLICY_FILE_MISSING', detail: '选定文件不存在或不是文件' } }
  if (size < 16) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: '权重文件过短，未加载或执行' }
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(size, 65536)); await file.read(head, 0, head.length, 0)
    if (ext === '.onnx') {
      if (head[0] !== 8) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: '文件不含ONNX ModelProto头' }
      return { valid: true, format: 'onnx', sizeBytes: size, graphVerified: false }
    }
    if (ext === '.safetensors') {
      const length = Number(head.readBigUInt64LE(0))
      if (!Number.isSafeInteger(length) || length < 2 || length > 1024 * 1024 || length + 8 > size) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'safetensors头长度无效或超过本次有界预检范围' }
      const header = Buffer.alloc(length); await file.read(header, 0, length, 8)
      let parsed: Record<string, any>; try { parsed = JSON.parse(header.toString()) } catch { return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'safetensors头不是合法JSON' } }
      const tensors = Object.entries(parsed).filter(([name]) => name !== '__metadata__')
      if (!tensors.length || tensors.some(([, t]) => !Array.isArray(t.shape) || t.shape.some((n: unknown) => !Number.isSafeInteger(n) || Number(n) < 0) || !Array.isArray(t.data_offsets) || t.data_offsets.length !== 2 || t.data_offsets.some((n: unknown) => !Number.isSafeInteger(n) || Number(n) < 0) || t.data_offsets[0] > t.data_offsets[1] || t.data_offsets[1] > size - length - 8)) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'safetensors张量/字节范围无效' }
      return { valid: true, format: 'safetensors', sizeBytes: size, graphVerified: false }
    }
    if (head.readUInt32LE(0) !== 0x04034b50) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: '文件不是Torch ZIP权重；未知pickle不会执行' }
    const tail = Buffer.alloc(Math.min(size, 65557)); await file.read(tail, 0, tail.length, size - tail.length)
    let end = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break }
    if (end < 0) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'Torch ZIP目录缺失，文件可能截断' }
    const bytes = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16)
    if (bytes > 1024 * 1024 || offset + bytes > size || bytes < 46) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'Torch ZIP目录范围无效' }
    const directory = Buffer.alloc(bytes); await file.read(directory, 0, bytes, offset)
    if (!directory.includes(Buffer.from('data.pkl'))) return { valid: false, code: 'POLICY_FILE_FORMAT_INVALID', detail: 'Torch ZIP没有权重结构' }
    return { valid: true, format: directory.includes(Buffer.from('/code/')) ? 'torchscript' : 'torch-checkpoint', sizeBytes: size, graphVerified: false }
  } finally { await file.close() }
}
