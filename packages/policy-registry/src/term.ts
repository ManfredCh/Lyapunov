/**
 * 说法（包名/别名/用户措辞）的归一化：**唯一一份**，内容侧检索与客户端模型路由共用。
 *
 * 为什么单独一个模块：它要同时被**宿主侧**（policy-registry 的检索工具、shell 的 pre-step 决策）与
 * **浏览器侧**（包面板要显示/匹配同一批名词）使用。放在 plugin.ts 里会把 node:fs 拉进客户端包，
 * 所以这一小段纯字符串规则单独成文件（无任何导入），两边 import 同一份，不各写一套正则。
 */
/** 别名/说法的归一化：大小写不敏感、去空白与中英标点（与 aliases.json 的 matching.normalize 同口径）。 */
export const packTerm = (value: string) => value.trim().toLowerCase().replace(/[\s　]+/g, '').replace(/[，。、,.;:!?！？（）()\[\]「」『』/\\·—_-]+/g, '')
/** 查询拆词：空白 + 中英标点 + '/'（'/ ' 在别名表里是"多条说法"的分隔符）。 */
export const packTerms = (query: string) => query.replace(/[/\\，。、,.;:!?！？（）()\[\]「」『』·—_-]+/g, ' ').split(/[\s　]+/).filter(Boolean).map(packTerm)
