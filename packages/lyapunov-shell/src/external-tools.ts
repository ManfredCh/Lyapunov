/** 外部工具选项复用现有来源目录；这里仅形成用户发起的新会话请求。 */
import {CREATIVE_TOOLS_CATALOG,HF_DEFAULT_MIRROR} from '../../../script/creative-tools-catalog.ts'
import {FASTGS_REPOSITORY,FASTGS_COMMIT} from '../../lyapunov-product-bundle/src/fastgs-metadata.ts'

export interface ExternalToolOption {id:string;name:string;description:string;actionLabel:string;source?:string;prompt:string}
const common='请先检查本机已有安装与当前平台，复用 Lyapunov 现有安装和配置入口，按需下载到本地工具目录。完成后报告安装位置、版本、实际检查结果与仍缺的条件；需要用户接受的许可或登录授权请在会话中说明。'
const modelRule=`所有模型元数据、下载和校验只使用 ${HF_DEFAULT_MIRROR}，镜像失败时停止并说明对象，不改用官方 Hub 端点。`
const descriptions:Record<string,string>={blender:'三维建模、场景编辑与资产处理。',unity:'安装 Unity Hub／编辑器，用于场景制作与交换。',sam3:'本地二维分割模型；下载前检查仓库访问授权。',sam3d:'三维对象生成模型；可按需下载，本产品尚无对应运行适配器。',da3:'DA3 BASE 深度模型；当前内置深度接口使用 DA-V2，下载后需单独检查兼容性。'}
export const EXTERNAL_TOOL_OPTIONS:readonly ExternalToolOption[]=[
 ...CREATIVE_TOOLS_CATALOG.map(entry=>({id:entry.id,name:entry.name,description:descriptions[entry.id]!,actionLabel:'下载／安装',source:entry.model?`${HF_DEFAULT_MIRROR}/${entry.model.modelId}`:entry.source.url,prompt:`请帮我下载并安装 ${entry.name}。${common}${entry.model?` 来源为 ${entry.model.modelId}，目录登记版本为 ${entry.model.revision}；只获取登记文件 ${entry.model.files.join('、')}。${modelRule}下载不代表已接入当前运行接口，请明确说明可用范围。`:` 使用官方来源 ${entry.source.url}。`}`})),
 {id:'blender-mcp',name:'Blender MCP',description:'安装或修复 Blender MCP 服务和编辑器插件，检查真实连接。',actionLabel:'安装／配置',source:'https://github.com/ahujasid/blender-mcp',prompt:`请帮我安装或修复 Blender MCP。${common}复用产品已锁定的 Blender MCP 服务与插件供应入口，并读取原生 MCP 发现与连接回执；不要把 Blender 软件安装与 MCP 连接当成同一件事。`},
 {id:'unity-mcp',name:'Unity MCP',description:'连接 Unity 编辑器的 MCP 服务；先检查编辑器和服务地址。',actionLabel:'安装／配置',source:'https://github.com/CoplayDev/unity-mcp',prompt:`请帮我安装并配置 Unity MCP。${common}现有 Unity MCP 入口只负责显式连接配置，不能据此声称已经安装或启动编辑器。先检查 Unity 和现有 MCP 服务；需要补充服务来源、工程或地址时在本会话询问，最后以原生 MCP 握手和工具发现结果验收。`},
 {id:'fastgs',name:'FastGS',description:'可选的 3D Gaussian Splatting 快速重建工具，按需下载源码和环境。',actionLabel:'下载／安装',source:FASTGS_REPOSITORY,prompt:`请帮我按需下载并安装 FastGS。${common}使用产品现有 FastGS 下载、安装和检查工具，官方来源 ${FASTGS_REPOSITORY}，固定版本 ${FASTGS_COMMIT}。源码、CUDA 环境、权重和数据留在本地，不随产品上传；本次不训练、不下载训练数据。${modelRule}`},
 {id:'mcp',name:'其他 MCP 服务',description:'在新会话中选择并配置其他 MCP 服务。',actionLabel:'选择／配置',prompt:`请帮我接入一个 MCP 服务。先询问我要使用的服务名称或地址，再复用 Lyapunov 的原生 MCP 配置与发现能力完成安装、连接和检查，并在这个会话里给出真实回执。`},
]
export function externalToolOption(id:string):ExternalToolOption {
 const option=EXTERNAL_TOOL_OPTIONS.find(entry=>entry.id===id)
 if(!option)throw new Error('未找到此外部工具。')
 return option
}
