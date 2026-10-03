/** 外部真实固定权重验收；必须显式提供fixture，缺少时失败，不冒充默认代码CI通过。 */
import assert from "node:assert/strict"
import {mkdtemp,writeFile,readFile,rm}from "node:fs/promises"
import {join}from "node:path"
import {tmpdir}from "node:os"
import {policyDirectory}from "../src/source.ts"
import {adoptLocalG1Policy}from "../src/g1-local-policy.ts"
import {G1_23_75_MODEL,G1_23_75_REVISION}from "../src/g1-23-75.ts"

const fixture=process.env.LYAPUNOV_G1_POLICY_FIXTURE
if(!fixture)throw new Error("G1_POLICY_FIXTURE_REQUIRED: 此验收需要已核299424B真实权重；没有运行，不能标通过")
const root=await mkdtemp(join(tmpdir(),"g1-reuse-manifest-"))
try{
 await adoptLocalG1Policy(root,fixture)
 const file=join(policyDirectory(root,"github",G1_23_75_MODEL,G1_23_75_REVISION),"manifest.json"),manifest=JSON.parse(await readFile(file,"utf8"))
 manifest.metadata={...manifest.metadata,previousMetadata:"retained"};manifest.transfers.push({priorTransfer:true});manifest.execution={status:"BLOCKED",reason:"prior-state-retained"}
 manifest.sourceFiles.push({path:"README.md",bytes:3,revision:G1_23_75_REVISION,url:"https://example.invalid/readme"});manifest.files.push({path:"README.md",bytes:3,sha256:"prior",revision:G1_23_75_REVISION,url:"https://example.invalid/readme"})
 const content=JSON.stringify(manifest,null,2)+"\n";await writeFile(file,content)
 await adoptLocalG1Policy(root,fixture)
 assert.equal(await readFile(file,"utf8"),content)
 console.log(JSON.stringify({status:"completed",scope:"真实固定权重同身份重复加载；整份manifest文本逐字保持，默认CI之外的外部fixture验收",checks:["priorMetadata","priorTransfers","priorExecution","sourceClosure","fileClosure","timestamps"]}))
}finally{await rm(root,{recursive:true,force:true})}
