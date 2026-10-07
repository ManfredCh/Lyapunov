/** 外部工具选项复用现有来源目录；这里仅形成用户发起的新会话请求。
 *
 * `kind` 供设置界面分组（软件 / MCP 桥接 / 模型 / 其它），不改变各工具的真实能力边界。
 * 所有进入模型的自然语言提示一律为英文（产品界面由调用方按语言投影）。
 */
import {CREATIVE_TOOLS_CATALOG,HF_DEFAULT_MIRROR} from '../../../script/creative-tools-catalog.ts'
import {FASTGS_REPOSITORY,FASTGS_COMMIT} from '../../lyapunov-product-bundle/src/fastgs-metadata.ts'

export type ExternalToolKind='software'|'bridge'|'model'|'tool'
export interface ExternalToolOption {id:string;name:string;kind:ExternalToolKind;description:string;actionLabel:string;source?:string;prompt:string}
const common='First inspect the existing local installation and the current platform, reuse Lyapunov existing installation and configuration entry points, and download into the local tool directory only when needed. When done, report the install location, version, what was actually checked, and what is still missing. Explain in this conversation any license or login the user still has to accept. '
const modelRule=`Use only ${HF_DEFAULT_MIRROR} for all model metadata, downloads and checks. If the mirror fails, stop and name the object; do not fall back to the official Hub endpoint. `
const descriptions:Record<string,string>={blender:'三维建模、场景编辑与资产处理。',unity:'安装 Unity Hub／编辑器，用于场景制作与交换。',sam3:'本地二维分割模型；下载前检查仓库访问授权。',sam3d:'三维对象生成模型；可按需下载，本产品尚无对应运行适配器。',da3:'DA3 BASE 深度模型；当前内置深度接口使用 DA-V2，下载后需单独检查兼容性。'}
export const EXTERNAL_TOOL_OPTIONS:readonly ExternalToolOption[]=[
 ...CREATIVE_TOOLS_CATALOG.map(entry=>({id:entry.id,name:entry.name,kind:(entry.kind==='software'?'software':'model') as ExternalToolKind,description:descriptions[entry.id]!,actionLabel:'下载／安装',source:entry.model?`${HF_DEFAULT_MIRROR}/${entry.model.modelId}`:entry.source.url,prompt:`Please download and install ${entry.name}. ${common}${entry.model?`The source is ${entry.model.modelId}, the catalogued revision is ${entry.model.revision}; fetch only the catalogued files ${entry.model.files.join(', ')}. ${modelRule}Downloading does not mean the current runtime interface supports it; state the real usable scope explicitly.`:`Use the official source ${entry.source.url}. `}`})),
 {id:'blender-mcp',name:'Blender MCP',kind:'bridge',description:'安装或修复 Blender MCP 服务和编辑器插件，检查真实连接。',actionLabel:'安装／配置',source:'https://github.com/ahujasid/blender-mcp',prompt:`Please install or repair Blender MCP. ${common}Reuse the product's locked Blender MCP service and add-on supply entry, and read the native MCP discovery and connection receipt; do not treat installing Blender software and connecting MCP as the same thing. This bridge is a third-party integration (currently published as mcp-for-blender), not an official Blender component.`},
 {id:'unity-mcp',name:'Unity MCP',kind:'bridge',description:'连接 Unity 编辑器的 MCP 服务；先检查编辑器和服务地址。',actionLabel:'安装／配置',source:'https://github.com/CoplayDev/unity-mcp',prompt:`Please install and configure Unity MCP. ${common}The existing Unity MCP entry only performs explicit connection configuration; it cannot by itself claim that the editor is installed or running. First inspect Unity and the existing MCP service; ask in this conversation when the service source, project or address is missing, and finish by verifying the native MCP handshake and tool discovery. This bridge is a third-party integration (CoplayDev/unity-mcp), not an official Unity component.`},
 {id:'fastgs',name:'FastGS',kind:'tool',description:'可选的 3D Gaussian Splatting 快速重建工具，按需下载源码和环境。',actionLabel:'下载／安装',source:FASTGS_REPOSITORY,prompt:`Please download and install FastGS on demand. ${common}Use the product's existing FastGS download, install and check tools. The official source is ${FASTGS_REPOSITORY}, pinned at ${FASTGS_COMMIT}. Keep source, CUDA environment, weights and data local; do not upload them with the product. Do not train or download training data in this turn. ${modelRule}`},
 {id:'mcp',name:'其他 MCP 服务',kind:'bridge',description:'在新会话中选择并配置其他 MCP 服务。',actionLabel:'选择／配置',prompt:`Please connect an MCP service. First ask me for the service name or address, then reuse Lyapunov native MCP configuration and discovery to install, connect and check it, and give a real receipt in this conversation. Do not invent server or tool names; report the concrete missing item when the connection cannot be established.`},
]
export function externalToolOption(id:string):ExternalToolOption {
 const option=EXTERNAL_TOOL_OPTIONS.find(entry=>entry.id===id)
 if(!option)throw new Error('未找到此外部工具。')
 return option
}
