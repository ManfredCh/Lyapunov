/**
 * W16：打包链唯一的联网点（micromamba LICENSE）必须是**可选**的。
 *
 * 真实缺陷：`script/package-linux.ts` 只能现取 `raw.githubusercontent.com/…/LICENSE`，
 * 一次瞬时断网就让候选构建 #2 静默挂 5 分钟后失败；没有网络的客户 CI 打包直接失败。
 *
 * 这里用**注入的取件器替身**证明三件事（不需要真实构建、不碰网络）：
 *  ① 入库件命中 ⇒ 取件器**调用次数为 0**（替身一旦被调用就直接抛错，双重保险）；
 *  ② `LYAPUNOV_MAMBA_LICENSE` 与 `.runtime/licenses/` 缓存覆盖生效 ⇒ 同样零网络；
 *  ③ 四种来源全缺 ⇒ **fail-closed**，报错带上游 URL 与每个候选的失败原因。
 * 另加：入库件被改动 ⇒ 不拿网络掩盖；网络取件成功 ⇒ 写回缓存，下一次回到离线路径。
 *
 * 2026-09-26 补（验收报告 §C1：身份校验可被静默旁路）：
 *  ④ **登记身份不可用**（meta.json 缺失／损坏／没有 sha256）⇒ 入库件一律 fail-closed，
 *     且不落到缓存/网络 —— 旧行为是 `pinned=null` ⇒ 校验恒真 ⇒ 62 B 假文本被正常采用（进程 `EXIT=0`）；
 *  ⑤ **交付闸门** `mambaLicenseIdentityVerdict()`：`hashMatchesPin` 是三态，`null`/`false` 都不是"通过"；
 *     唯一放行的未证实来源是 `LYAPUNOV_MAMBA_LICENSE`（操作者显式覆盖，仍必须喊出来）。
 *
 * 说明：本文件只跑纯逻辑与临时目录，不出网、不跑真实构建（真实构建会重写各包的 dist 目录）。
 */
import {describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MAMBA_LICENSE_ENV,MAMBA_LICENSE_SPDX,mambaLicenseFileName,mambaLicenseIdentityVerdict,mambaLicenseUrl,resolveMambaLicense,type MambaLicenseRecord} from './mamba-license.ts'

const root=join(import.meta.dirname,'..','..')
const repoLicenseDir=join(root,'distribution/licenses')
const record:Required<Pick<MambaLicenseRecord,'version'|'sha256'|'bytes'>>=JSON.parse(await readFile(join(repoLicenseDir,'micromamba-2.9.0-LICENSE.meta.json'),'utf8'))
const version=record.version
const fileName=mambaLicenseFileName(version)
const url=mambaLicenseUrl(version)
const packager=await readFile(join(root,'script/package-linux.ts'),'utf8')

/** 取件器替身：调用即记账；`text` 为 null 时按"断网"抛错。 */
function fetchDouble(text:string|null,reason='模拟瞬时断网：AbortError: The operation was aborted due to timeout'):{calls:string[];fetch:(url:string)=>Promise<string>}{
  const calls:string[]=[]
  return {calls,fetch:async(fetched:string)=>{calls.push(fetched);if(text===null)throw new Error(reason);return text}}
}
const neverFetch=()=>fetchDouble(null,'取件器不该被调用：本地来源已经命中')

async function tempDir():Promise<string>{return await mkdtemp(join(tmpdir(),'lyapunov-mamba-license-'))}
/** 只放登记身份、不放许可证：让"入库件"这一档成为未命中，用来单独考缓存/网络档。 */
async function vendoredRecordOnly(dir:string){await copyFile(join(repoLicenseDir,`${fileName}.meta.json`),join(dir,`${fileName}.meta.json`))}

/**
 * 验收报告 §C1 里那份 62 B 假文本（逐字节原样）。`TAMPERED_SHA256` 是该文件的 sha256 ——
 * 用例里先钉住它，证明考的是**同一份字节**，不是另写一段假文本凑数。
 */
const TAMPERED_TEXT='TAMPERED LICENSE TEXT - not the real BSD-3-Clause text at all\n'
const TAMPERED_SHA256='7cdd0f61971cf867ec419c9e5262e2328c68596705ca50198dcf75762be2e5fb'

/**
 * 把"没抛错"变成一条**明确的红**：采用 ⇒ `{adopted:true, resolution}`；拒绝 ⇒ `{adopted:false, message}`。
 * 这样断言写的是"不许静默采用"这件事本身，而不是"抛了什么错"（后者在旧代码上根本不会执行到）。
 */
async function resolutionOrMessage(options:Parameters<typeof resolveMambaLicense>[0]):Promise<{adopted:true;resolution:Awaited<ReturnType<typeof resolveMambaLicense>>}|{adopted:false;message:string}>{
  try{return {adopted:true,resolution:await resolveMambaLicense(options)}}catch(error){return {adopted:false,message:(error as Error)?.message??String(error)}}
}

describe('① 入库件命中：不发起任何网络请求', () => {
  test('命中 distribution/licenses 的入库件，取件器调用次数为 0，且身份与登记一致', async () => {
    const cache=await tempDir()
    const fetch=neverFetch()
    try{
      const resolution=await resolveMambaLicense({version,root,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(fetch.calls.length).toBe(0)
      expect(resolution.source).toBe('vendored')
      expect(resolution.location).toBe(join(repoLicenseDir,fileName))
      expect(resolution.sha256).toBe(record.sha256)
      expect(resolution.bytes).toBe(record.bytes)
      expect(resolution.spdx).toBe(MAMBA_LICENSE_SPDX)
      expect(resolution.pinnedSha256).toBe(record.sha256)
      expect(resolution.hashMatchesPin).toBe(true)
      expect(resolution.url).toBe(url)
    }finally{await rm(cache,{recursive:true,force:true})}
  })

  test('按打包脚本的默认路径调用（不覆写 vendoredDir/cacheDir）同样零网络', async () => {
    const fetch=neverFetch()
    const resolution=await resolveMambaLicense({version,root,env:{},fetchLicense:fetch.fetch})
    expect(fetch.calls.length).toBe(0)
    expect(resolution.source).toBe('vendored')                                // 命中入库件，不依赖本机缓存/网络
    expect(resolution.location).toBe(join(root,'distribution/licenses',fileName))
  })

  test('入库件的内容就是上游那份（sha256/字节数双重核对，不是"随便一个文件"）', async () => {
    const text=await readFile(join(repoLicenseDir,fileName))
    const hashed=await crypto.subtle.digest('SHA-256',text)
    expect(Buffer.from(hashed).toString('hex')).toBe(record.sha256)
    expect(text.byteLength).toBe(record.bytes)
    expect(text.byteLength).toBe(1483)
    expect(text.toString('utf8')).toContain('Copyright 2019 QuantStack and the Mamba contributors.')
  })
})

describe('② 环境变量 / 缓存覆盖生效', () => {
  test(`${MAMBA_LICENSE_ENV} 指向的文件被原样采用，零网络`, async () => {
    const dir=await tempDir()
    try{
      const overridden=join(dir,'company-mirror-LICENSE')
      await writeFile(overridden,'客户镜像里的 micromamba 许可证副本\n')
      const fetch=neverFetch()
      const resolution=await resolveMambaLicense({version,root,cacheDir:join(dir,'no-cache'),env:{[MAMBA_LICENSE_ENV]:overridden},fetchLicense:fetch.fetch})
      expect(fetch.calls.length).toBe(0)
      expect(resolution.source).toBe('env')
      expect(resolution.location).toBe(overridden)
      expect(resolution.text).toBe('客户镜像里的 micromamba 许可证副本\n')
      // 显式覆盖是操作者的判断：如实报告它与登记身份不一致，但不替操作者否决。
      expect(resolution.hashMatchesPin).toBe(false)
    }finally{await rm(dir,{recursive:true,force:true})}
  })

  test(`${MAMBA_LICENSE_ENV} 指向不存在的文件 ⇒ 立刻失败（不静默回落到网络）`, async () => {
    const dir=await tempDir()
    try{
      const missing=join(dir,'nope-LICENSE')
      const fetch=neverFetch()
      await expect(resolveMambaLicense({version,root,cacheDir:join(dir,'no-cache'),env:{[MAMBA_LICENSE_ENV]:missing},fetchLicense:fetch.fetch}))
        .rejects.toThrow(new RegExp(`${MAMBA_LICENSE_ENV}[\\s\\S]*不存在`))
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(dir,{recursive:true,force:true})}
  })

  test('.runtime/licenses 缓存命中 ⇒ 零网络，且同样按登记身份校验', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      await copyFile(join(repoLicenseDir,fileName),join(cache,fileName))
      const fetch=neverFetch()
      const resolution=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(fetch.calls.length).toBe(0)
      expect(resolution.source).toBe('cache')
      expect(resolution.sha256).toBe(record.sha256)
      expect(resolution.hashMatchesPin).toBe(true)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('缓存内容对不上登记身份 ⇒ 拒用该候选并继续走网络（缓存可自愈）', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      await writeFile(join(cache,fileName),'被污染或被换过的缓存内容\n')
      const fetch=fetchDouble(await readFile(join(repoLicenseDir,fileName),'utf8'))
      const resolution=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(fetch.calls).toEqual([url])
      expect(resolution.source).toBe('network')
      expect(resolution.sha256).toBe(record.sha256)
      expect(resolution.cached).toBe(true)
      expect(await readFile(join(cache,fileName),'utf8')).toBe(resolution.text)   // 欠佳的缓存被正确内容覆盖
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('网络取件成功后写回缓存：下一次调用命中缓存、零网络', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      const first=fetchDouble(await readFile(join(repoLicenseDir,fileName),'utf8'))
      const fetched=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:first.fetch})
      expect(fetched.source).toBe('network')
      expect(first.calls).toEqual([url])
      expect(existsSync(join(cache,fileName))).toBe(true)
      const second=neverFetch()
      const offline=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:second.fetch})
      expect(second.calls.length).toBe(0)
      expect(offline.source).toBe('cache')
      expect(offline.text).toBe(fetched.text)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })
})

describe('③ 全部缺失：fail-closed，报错带 URL 与原因', () => {
  test('入库件/缓存/环境变量全缺 + 网络失败 ⇒ 抛错，信息含上游 URL、各候选路径与网络失败原因', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      const reason='模拟瞬时断网：AbortError: The operation was aborted due to timeout'
      const fetch=fetchDouble(null,reason)
      const attempt=resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      await expect(attempt).rejects.toThrow(/无法取得 micromamba 2\.9\.0 的许可证/)
      const message=await attempt.then(()=>'',error=>(error as Error).message)
      expect(fetch.calls).toEqual([url])
      expect(message).toContain(url)                                    // 上游 URL
      expect(message).toContain(join(vendored,fileName))                 // 入库件候选路径
      expect(message).toContain(join(cache,fileName))                    // 缓存候选路径
      expect(message).toContain(MAMBA_LICENSE_ENV)                       // 覆盖变量
      expect(message).toContain(reason)                                  // 真实原因，不是"取不到"三个字
      expect(message).toContain('fail-closed')
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('网络拿回来的内容与登记身份不一致 ⇒ 同样 fail-closed（tag 被重打/中间人不能混过去）', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      const fetch=fetchDouble('上游换了一份不一样的内容\n')
      await expect(resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch}))
        .rejects.toThrow(/上游内容与登记身份不一致[\s\S]*登记 sha256=/)
      expect(existsSync(join(cache,fileName))).toBe(false)               // 对不上的内容不许进缓存
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('入库件被改动 ⇒ fail-closed，且不拿网络掩盖', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      await writeFile(join(vendored,fileName),'被改过的入库许可证\n')
      const fetch=neverFetch()
      await expect(resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch}))
        .rejects.toThrow(/入库许可证已被改动[\s\S]*登记 sha256=/)
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })
})

describe('④ 登记身份不可用：入库件一律 fail-closed，不许静默采用', () => {
  test('meta.json 缺失（只拷了 LICENSE 的裁剪检出）⇒ 拒绝采用、点名缺失的文件、不落到网络', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await copyFile(join(repoLicenseDir,fileName),join(vendored,fileName))   // 入库件在、登记身份不在
      const fetch=neverFetch()
      const outcome=await resolutionOrMessage({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(outcome.adopted).toBe(false)                                     // 旧行为：source:"vendored"、hashMatchesPin:null、EXIT=0
      const message=outcome.adopted?'':outcome.message
      expect(message).toMatch(/入库许可证无法核验身份[\s\S]*fail-closed/)
      expect(message).toContain('登记身份文件不存在')                          // 说清缺什么：缺失，不是"对不上"
      expect(message).toContain(join(vendored,`${fileName}.meta.json`))        // 缺的是哪一个文件
      expect(message).toContain(MAMBA_LICENSE_ENV)                            // 给出显式覆盖这条出路
      expect(fetch.calls.length).toBe(0)                                      // 不许用缓存/网络把"不可核验"掩盖过去
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('验收报告 §C1 的原场景：meta.json 缺失 + LICENSE 被换成 62 B 假文本 ⇒ 拒绝采用', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await writeFile(join(vendored,fileName),TAMPERED_TEXT)
      const bytes=await readFile(join(vendored,fileName))
      // 先证明这是**同一份字节**：62 B / sha256 / 前 40 字符与验收报告 §C1 的读数逐字相同
      expect(bytes.byteLength).toBe(62)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(TAMPERED_SHA256)
      expect(bytes.toString('utf8').slice(0,40)).toBe('TAMPERED LICENSE TEXT - not the real BSD')
      const fetch=neverFetch()
      const outcome=await resolutionOrMessage({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(outcome.adopted).toBe(false)                                     // 旧行为：被当作 source:"vendored" 正常采用
      const message=outcome.adopted?'':outcome.message
      expect(message).toMatch(/入库许可证无法核验身份[\s\S]*fail-closed/)
      expect(message).toContain('登记身份文件不存在')
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('meta.json 损坏（不是合法 JSON）⇒ 拒绝采用，报"不是合法 JSON"而不是"不存在"', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await copyFile(join(repoLicenseDir,fileName),join(vendored,fileName))
      await writeFile(join(vendored,`${fileName}.meta.json`),'{"sha256": "41fd98a468e39d319911bd94f4e65d6ad6a7ea66559dd5aa4112f138ff9b629a",  ← 被写坏的登记文件')
      const fetch=neverFetch()
      const outcome=await resolutionOrMessage({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(outcome.adopted).toBe(false)
      const message=outcome.adopted?'':outcome.message
      expect(message).toContain('登记身份文件不是合法 JSON')
      expect(message).not.toContain('登记身份文件不存在')                      // 三种原因分开报，不糊成一句"取不到"
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('meta.json 是合法 JSON 但没有 sha256 ⇒ 拒绝采用，报"没有可用的 sha256 字段"', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await copyFile(join(repoLicenseDir,fileName),join(vendored,fileName))
      await writeFile(join(vendored,`${fileName}.meta.json`),JSON.stringify({package:'micromamba',version,spdx:MAMBA_LICENSE_SPDX}))
      const fetch=neverFetch()
      const outcome=await resolutionOrMessage({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(outcome.adopted).toBe(false)
      const message=outcome.adopted?'':outcome.message
      expect(message).toContain('登记身份文件里没有可用的 sha256 字段')
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('登记身份在、内容被换成 62 B 假文本 ⇒ 报"内容与登记身份不一致"（两个指纹都在报文里）', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await vendoredRecordOnly(vendored)
      await writeFile(join(vendored,fileName),TAMPERED_TEXT)
      const fetch=neverFetch()
      const outcome=await resolutionOrMessage({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:fetch.fetch})
      expect(outcome.adopted).toBe(false)
      const message=outcome.adopted?'':outcome.message
      expect(message).toMatch(/入库许可证已被改动[\s\S]*登记 sha256=/)
      expect(message).toContain(record.sha256)                                // 登记的指纹
      expect(message).toContain(TAMPERED_SHA256)                              // 实际（假文本）的指纹
      expect(fetch.calls.length).toBe(0)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })
})

describe('⑤ 交付闸门：hashMatchesPin 是三态，null / false 都不是"通过"', () => {
  test('核验通过 ⇒ 放行（verified）', async () => {
    const resolution=await resolveMambaLicense({version,root,env:{},fetchLicense:neverFetch().fetch})
    expect(resolution.source).toBe('vendored')
    expect(mambaLicenseIdentityVerdict(resolution)).toEqual({adoptable:true,verified:true,problem:'',disposition:'verified'})
  })

  test('网络兜底取到与上游逐字节相同的字节，但没有登记身份 ⇒ 闸门仍拒绝（字节对 ≠ 身份可核验）', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      const upstream=await readFile(join(repoLicenseDir,fileName),'utf8')
      const resolution=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:async()=>upstream})
      expect(resolution.source).toBe('network')                               // 取件这一层没出错
      expect(resolution.sha256).toBe(record.sha256)                           // 字节与上游/入库件逐字节相同
      expect(resolution.hashMatchesPin).toBe(null)                            // 三态里的第三态：无从核验
      expect(resolution.pinProblem).toContain('登记身份文件不存在')            // 原因随结果一起报出来
      const verdict=mambaLicenseIdentityVerdict(resolution)
      expect(verdict.adoptable).toBe(false)                                   // ⇒ 仍然不许进发行载荷
      expect(verdict.disposition).toBe('refuse')
      expect(verdict.problem).toContain('没有可核验的登记身份')
      expect(verdict.problem).toContain('.meta.json')
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test('缓存命中但没有登记身份 ⇒ 闸门同样拒绝', async () => {
    const vendored=await tempDir(),cache=await tempDir()
    try{
      await copyFile(join(repoLicenseDir,fileName),join(cache,fileName))       // 缓存里有内容，登记身份没有
      const resolution=await resolveMambaLicense({version,root,vendoredDir:vendored,cacheDir:cache,env:{},fetchLicense:neverFetch().fetch})
      expect(resolution.source).toBe('cache')
      expect(resolution.hashMatchesPin).toBe(null)
      expect(mambaLicenseIdentityVerdict(resolution).adoptable).toBe(false)
    }finally{await rm(vendored,{recursive:true,force:true});await rm(cache,{recursive:true,force:true})}
  })

  test(`${MAMBA_LICENSE_ENV} 覆盖：仍采用（操作者显式指定），但闸门标成"未证实 + 由操作者处置"并给出原因`, async () => {
    const dir=await tempDir(),empty=await tempDir()
    try{
      const overridden=join(dir,'company-mirror-LICENSE')
      await writeFile(overridden,'客户镜像里的 micromamba 许可证副本\n')
      const noPin=await resolveMambaLicense({version,root,vendoredDir:empty,cacheDir:join(dir,'no-cache'),env:{[MAMBA_LICENSE_ENV]:overridden},fetchLicense:neverFetch().fetch})
      expect(noPin.source).toBe('env')
      const noPinVerdict=mambaLicenseIdentityVerdict(noPin)
      expect(noPinVerdict.adoptable).toBe(true)                               // 不替操作者否决（W16 口径不变）
      expect(noPinVerdict.verified).toBe(false)
      expect(noPinVerdict.disposition).toBe('operator-override')
      expect(noPinVerdict.problem).toContain('没有可核验的登记身份')
      // 登记身份在、覆盖件与它对不上：同样放行，但问题写清"内容不一致"（两个指纹都在）
      const mismatch=await resolveMambaLicense({version,root,cacheDir:join(dir,'no-cache-2'),env:{[MAMBA_LICENSE_ENV]:overridden},fetchLicense:neverFetch().fetch})
      expect(mismatch.hashMatchesPin).toBe(false)
      const mismatchVerdict=mambaLicenseIdentityVerdict(mismatch)
      expect(mismatchVerdict.adoptable).toBe(true)
      expect(mismatchVerdict.disposition).toBe('operator-override')
      expect(mismatchVerdict.problem).toContain('内容与登记身份不一致')
      expect(mismatchVerdict.problem).toContain(record.sha256)
    }finally{await rm(dir,{recursive:true,force:true});await rm(empty,{recursive:true,force:true})}
  })
})

describe('打包脚本接线（漂移守卫）', () => {
  test('打包脚本走 resolveMambaLicense，且全脚本只剩一处联网点（就是那个有界兜底）', () => {
    expect(packager).toContain("from '../distribution/licenses/mamba-license.ts'")
    expect(packager).toContain('resolveMambaLicense({')
    expect(packager.split('await fetch(').length-1).toBe(1)             // 不新增第二个联网点
    expect(packager).toMatch(/const response=await fetch\(url,\{signal:AbortSignal\.timeout\(30_000\)\}\)/)
  })

  test('有界超时 + 重试的取件器仍保留，但只作为 fetchLicense 兜底接进去', () => {
    expect(packager).toContain('AbortSignal.timeout(30_000)')
    expect(packager).toContain('const attempts=3')
    expect(packager).toMatch(/fetchLicense:\(\)=>fetchMambaLicense\(licenseUrl\)/)
    // 网络取件只出现一次：那次必须就是兜底绑定本身。
    expect(packager.split('fetchMambaLicense(licenseUrl)').length-1).toBe(1)
  })

  test('载荷许可证写的是取件结果，并把它记进 RELEASE.json', () => {
    expect(packager).toContain("await writeFile(join(stage,'runtime/micromamba/LICENSE'),mambaLicense.text)")
    expect(packager).toContain('micromambaLicense:mambaLicenseRecord')
    expect(packager).toContain("payloadLocation:'runtime/micromamba/LICENSE'")
    expect(packager).toContain('source:mambaLicense.source')
  })

  test('打包脚本在把许可证写进载荷**之前**先过交付闸门（顺序断言，不是"存在即可"）', () => {
    const gateAt=packager.indexOf('mambaLicenseIdentityVerdict(mambaLicense)')
    const refuseAt=packager.indexOf('if(!licenseIdentity.adoptable)throw new Error(')
    const unverifiedAt=packager.indexOf("phase:'micromamba-license-identity-unverified'")
    const writeAt=packager.indexOf("await writeFile(join(stage,'runtime/micromamba/LICENSE'),mambaLicense.text)")
    expect(gateAt).toBeGreaterThan(-1)                                        // 闸门被调用
    expect(refuseAt).toBeGreaterThan(-1)                                      // 拒绝分支存在
    expect(unverifiedAt).toBeGreaterThan(-1)                                  // 未证实必须喊出来（env 例外也不是静默）
    expect(writeAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(writeAt)                                      // 闸门排在写载荷**之前**
    expect(refuseAt).toBeLessThan(writeAt)
    expect(packager).toContain("import {MAMBA_LICENSE_ENV,mambaLicenseFileName,mambaLicenseIdentityVerdict")
    expect(packager).toContain('MAMBA_LICENSE_ENV} 指向一份你确认过的副本')     // 拒绝时报文给出显式覆盖这条出路
  })

  /**
   * 2026-09-26 复扫补（LICENSE-PIN-RESIDUALS）：上面那条是**顺序**断言，NC-3 实测删掉闸门后它确实是唯一变红的一条 ——
   * 也就是说"交付闸门真的会挡"在本仓**只有源码字符串读数，没有行为读数**。这一条把能静态钉死的部分钉死：
   * 打包侧**不许**自建第二套豁免（唯一例外 env 由 `mambaLicenseIdentityVerdict()` 判定，行为已由 ⑤ 覆盖）。
   */
  test('打包侧只消费判定结果：不自建第二套豁免、不绕过闸门、adoptable 只消费一次', () => {
    expect(packager).toMatch(/if\(!licenseIdentity\.adoptable\)throw new Error\(/)   // 拒绝分支原样在
    expect(packager).not.toMatch(/licenseIdentity\.source/)                        // 不按来源在打包侧再开口子
    expect(packager).not.toMatch(/source\s*===\s*['"]env['"]/)                     // env 例外不许在打包侧重写
    expect(packager).not.toMatch(/(return|continue)[^\n]*licenseIdentity\.(adoptable|verified)/)  // 无绕过闸门的早退
    expect(packager.split('licenseIdentity.adoptable').length-1).toBe(1)           // 只消费一次（两种处置会让拒绝变可选）
    expect(packager).toMatch(/if\(!licenseIdentity\.verified\)console\.error\(/)   // 未证实必须喊出来
  })
})
