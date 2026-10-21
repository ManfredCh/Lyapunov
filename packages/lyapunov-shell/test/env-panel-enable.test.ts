/** N76：按实际组件输出验证启用入口；V9 的折叠布局不再依赖源码里条件表达式的写法。 */
import {expect,test} from 'bun:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {EnvironmentPanel} from '../src/environment-panel.tsx'
import {composeEnvironment} from '../../viewer/src/environment.ts'
import {createRequire} from 'node:module'
// V8-11 Lighting 二级页用例并入本文件执行：门文件（test-ci.manifest.json / release-gate.ts）已被
// 冻结基线钉死、本轮不得改动，因此不新增被扫描的 *.test.ts，改为从已登记文件 import 该用例模块。
import "./lighting-page-cases.tsx"

const require=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
const {JSDOM}=require('jsdom')

const noop=()=>{}
const base:any={environmentSource:'builtin',colorBackground:'#242a32',warnings:[],ignored:[],sun:{azimuthDeg:35,elevationDeg:45,intensity:1,daylight:1,source:'manual'},clock:{playing:false,offsetHours:0,advancedSeconds:0},timeHours:12,exposure:1,environmentIntensity:.7}
const props:any={status:base,hdris:[],hdriBusy:false,readOnly:false,viewerVisible:true,busy:false,apply:noop,remove:noop,setPlaying:noop,color:'#242a32',setColor:noop,importHdri:noop,refresh:noop,tr:(_cn:string,en:string)=>en}
const render=(patch:any={})=>renderToStaticMarkup(createElement(EnvironmentPanel,{...props,...patch}))

test('无环境组件时设计稿四行仍在、值明确为未声明且禁用；只读时启用动作也禁用',()=>{
 const html=render()
 expect(html).toContain('Lighting preset')
 expect((html.match(/>Enable environment lighting<\/button>/g)??[]).length).toBe(1)
 expect(html.match(/<button[^>]*>Enable environment lighting<\/button>/)?.[0]).not.toContain('disabled')
 // 控件不隐藏：四个常用值以 Not declared 出现，免得整页只剩一个启用按钮。
 expect(html).toContain('Sun elevation')
 expect(html).toContain('Lighting color')
 expect((html.match(/Not declared/g)??[]).length).toBeGreaterThanOrEqual(3)
 expect(html.match(/<input[^>]*type="range"[^>]*>/)?.[0]).toContain('disabled')
 withDocument({},document=>{
  for(const testId of ['environment-lighting-preset','environment-lighting-intensity','environment-lighting-sun-elevation','environment-lighting-color']){
   const control=document.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-testid="${testId}"]`)!
   expect(control).not.toBeNull()
   expect(control.disabled).toBe(true)
  }
  expect((document.querySelector('[data-testid="environment-lighting-sun-elevation"]') as HTMLInputElement).value).toBe('Not declared')
  expect((document.querySelector('[data-testid="environment-lighting-color"]') as HTMLSelectElement).value).toBe('not-declared')
  // 全页只有一个蓝色主按钮，而且不是用它顶替四行控件。
  expect(document.querySelectorAll('.lya-primary')).toHaveLength(1)
 })
 expect(render({readOnly:true}).match(/<button[^>]*>Enable environment lighting<\/button>/)?.[0]).toContain('disabled')
})

test('无场景保留先打开场景说明；已有组件显示真实控件和移除动作，不重复启用',()=>{
 const absent=render({status:undefined})
 expect(absent).toContain('Open a scene')
 expect(absent).not.toContain('Enable environment lighting')
 const component=composeEnvironment(undefined,{}).component
 const html=render({status:{...base,component}})
 expect(html).not.toContain('Enable environment lighting')
 expect(html).toContain('Lighting preset')
 expect(html).toContain('type="range"')
 expect(html).toContain('Remove environment component')
 expect(html).toContain('environment-lighting-advanced')
})

const withDocument=(patch:any,check:(document:Document)=>void)=>{
 const dom=new JSDOM(render(patch))
 try{check(dom.window.document)}finally{dom.window.close()}
}

// 只验证原生 details 的结构/默认状态，不冒充浏览器布局或实机美学验收。
const collapsedByAncestor=(element:Element)=>{
 for(let parent=element.parentElement;parent;parent=parent.parentElement){
  if(parent.tagName==='DETAILS'&&!parent.hasAttribute('open')&&!parent.querySelector(':scope > summary')?.contains(element))return true
 }
 return false
}

test('Lighting 常用控件保留，标题由外层提供，次要动作与高级字段默认收起',()=>{
 const component=composeEnvironment(undefined,{}).component
 for(const status of [undefined,base,{...base,component}])withDocument({status,addAreaLight:noop},document=>{
  expect(document.querySelector('legend,h1,h2,h3')).toBeNull()
  expect(document.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Lighting controls')
  for(const fold of document.querySelectorAll('details'))expect(fold.hasAttribute('open')).toBe(false)
  for(const button of document.querySelectorAll('button')){
   if(button.textContent==='Enable environment lighting')expect(collapsedByAncestor(button)).toBe(false)
   else expect(collapsedByAncestor(button)).toBe(true)
  }
 })
 withDocument({status:{...base,component}},document=>{
  const controls=[...document.querySelectorAll('input,select')].filter(element=>!collapsedByAncestor(element))
  expect(controls.map(element=>element.getAttribute('aria-label'))).toEqual(['Lighting preset','Intensity','Intensity (0–8)','Sun elevation','Lighting color'])
  expect([...document.querySelectorAll('p')].filter(element=>!collapsedByAncestor(element))).toHaveLength(0)
 })
})

test('失败和文档读回问题摘要在首屏，完整原因只在默认关闭详情且不重复',()=>{
 const component=composeEnvironment(undefined,{hdri:{resourceId:'sky',version:2}}).component
 const error='HDRI_LOAD_FAILED: unavailable original at /fixture/sky-v2.hdr'
 const warnings=['ENVIRONMENT_FIELD_CLAMPED: exposure=99 clamped to [0, 8]']
 const ignored=[{entityId:'bad-environment',reason:'ENVIRONMENT_KIND_UNSUPPORTED: invalid'}]
 for(const active of [undefined,component])withDocument({status:{...base,component:active,error,warnings,ignored}},document=>{
  const failure=document.querySelector('[data-testid="environment-hdri-error"]')!
  const diagnostics=document.querySelector('[data-testid="environment-diagnostics"]')!
  expect(failure.querySelector('summary')?.textContent).toBe('HDRI failed to load')
  expect(diagnostics.querySelector('summary')?.textContent).toBe('Document readback issues (2)')
  for(const fold of [failure,diagnostics]){
   expect(fold.hasAttribute('open')).toBe(false)
   expect(collapsedByAncestor(fold)).toBe(false)
   for(const paragraph of fold.querySelectorAll('p'))expect(collapsedByAncestor(paragraph)).toBe(true)
  }
  expect(document.body.textContent?.split(error).length).toBe(2)
  expect(diagnostics.textContent).toContain(warnings[0])
  expect(diagnostics.textContent).toContain('bad-environment: ENVIRONMENT_KIND_UNSUPPORTED: invalid')
  failure.setAttribute('open','')
  expect(collapsedByAncestor(failure.querySelector('p')!)).toBe(false)
 })
})

test('HDRI 在途不冒充加载失败，失败/已载版本与场景背景保存语义仍可读',()=>{
 const component=composeEnvironment(undefined,{hdri:{resourceId:'sky',version:2},backgroundColor:'#112233'}).component
 for(const loading of [true,false])withDocument({status:{...base,component,hdri:{resourceId:'sky',version:2,loaded:false,loading,applied:{resourceId:'sky',version:1}}}},document=>{
  expect(document.querySelector('[data-testid="environment-hdri"] > summary')?.textContent).toBe(`HDRI environment map · ${loading?'loading':'not applied'}`)
  expect(document.querySelector('[data-testid="environment-hdri-error"]')).toBeNull()
  expect(document.body.textContent).toContain('still showing sky@1')
  expect((document.querySelector('input[aria-label="Environment color"]') as HTMLInputElement).value).toBe('#112233')
  expect((document.querySelector('input[aria-label="Save the background color in the scene"]') as HTMLInputElement).checked).toBe(true)
 })
 withDocument({status:{...base,component:composeEnvironment(component,{backgroundColor:null}).component}},document=>{
  expect((document.querySelector('input[aria-label="Environment color"]') as HTMLInputElement).value).toBe('#242a32')
  expect((document.querySelector('input[aria-label="Save the background color in the scene"]') as HTMLInputElement).checked).toBe(false)
 })
})
