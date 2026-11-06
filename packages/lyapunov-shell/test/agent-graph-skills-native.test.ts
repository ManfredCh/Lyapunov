/** 原文件系统技能 Provider + 原 skill 工具；独立工作区没有源码仓的 .agents。 */
import {describe,expect,test} from 'bun:test'
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit'

describe('Agent Graph 原角色协议随插件交付',()=>{
 test('独立工作区可由原技能目录发现并加载三个角色，源码入口指向同一份文件',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'agent-graph-skill-workspace-'))
  const root=resolve(import.meta.dirname,'../../..'), skillRoot=join(root,'packages/lyapunov-shell/skills')
  const ctx=new Context()
  try{
   await mountAgentLoopTestDependencies(ctx)
   await ctx.plugin(SkillRegistry)
   await ctx.plugin(SkillFileSystem,{providerName:'lyapunov-domain',includeDefaultRoots:false,customSkillDirs:[skillRoot],watch:false})
   await ctx.plugin(ToolSkill)
   const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('agent-graph-skill-fixture'),{},{cwd})
   const catalog=await ctx.skills.snapshot({cwd,scope:agent})
   expect(catalog.complete).toBe(true)
   expect(catalog.skills.some(skill=>skill.name==='scene-construction')).toBe(true)
   for(const name of ['skill-campaign','skill-debug','skill-verify']){
    const result=await ctx.tools.execute({name:'skill',arguments:{name},callId:ToolCallId(`load-${name}`),signal:new AbortController().signal,agent})
    expect(result.isError).toBe(false)
    const loaded=result.value as {name:string;content:string;resourceBase:{kind:string;path:string}}
    expect(loaded.name).toBe(name);expect(loaded.resourceBase.kind).toBe('directory')
    expect(await realpath(loaded.resourceBase.path)).toBe(await realpath(join(skillRoot,name)))
    const packaged=join(skillRoot,name,'SKILL.md'),source=join(root,'.agents/skills',name,'SKILL.md')
    expect(await realpath(source)).toBe(await realpath(packaged))
    expect(await readFile(packaged,'utf8')).toContain(loaded.content.trim())
   }
  }finally{await ctx.fiber.dispose();await rm(cwd,{recursive:true,force:true})}
 })
})
