import {spawn} from "node:child_process"
import {createRequire} from "node:module"
import {resolve,join} from "node:path"
import {parseArgs} from "node:util"
import {readRuntimeEnv,RUNTIME_ENV} from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import {ENGINE_CHOICES,isEngineChoice} from "./engine-preference.ts"
const root=resolve(import.meta.dirname,"..")
const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{mode:{type:"string",default:"formal"},"software-rendering":{type:"boolean"},engine:{type:"string"}}})
if(!['formal','developer'].includes(values.mode!))throw new Error("运行模式无效")
// 显式 `--engine` 以 `LYAPUNOV_SIM_ENGINE` 传给主进程（共享解析的环境变量那一层）；缺省不在这里填默认。
if(values.engine!==undefined&&!isEngineChoice(values.engine))throw new Error(`--engine 只接受 ${ENGINE_CHOICES.join("|")}`)
const require=createRequire(join(root,"packages/desktop/package.json"))
const electron=readRuntimeEnv(process.env,"electronBinary")??require("electron") as string
const env:NodeJS.ProcessEnv={...process.env,[RUNTIME_ENV.productRoot]:root,...(values.engine===undefined?{}:{[RUNTIME_ENV.simEngine]:values.engine})};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[join(root,"packages/desktop"),...(values.mode==="developer"?["--developer"]:[]),...(values['software-rendering']?["--software-rendering"]:[]),...positionals],{cwd:root,env,stdio:"inherit"})
process.on("SIGINT",()=>child.kill("SIGINT"));process.on("SIGTERM",()=>child.kill("SIGTERM"))
process.exitCode=await new Promise<number>(resolve=>{child.once("error",error=>{console.error(error);resolve(1)});child.once("exit",code=>resolve(code??1))})
