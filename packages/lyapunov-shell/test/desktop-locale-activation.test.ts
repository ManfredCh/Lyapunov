import {expect,test} from 'bun:test'
import {Context} from '@deepseek-ai/cordis'
import {applyProductUI} from '../src/product-ui.tsx'
import {readFileSync} from 'node:fs'

// 客户端entry的实际依赖声明；不加载与本回归无关的WebGL/Viewer入口。
const declaration=readFileSync(new URL('../src/client.tsx',import.meta.url),'utf8').match(/export const inject=(\[[^\]]+\])/)
if(!declaration)throw Error('客户端注入声明未读到')
const inject=JSON.parse(declaration[1]!) as string[]

test('真实Cordis注入边界下Electron桥接能激活品牌和原生locale设置',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window')
 const projected:string[]=[],binds:string[]=[]
 const desktop={uiLocale:async()=>({active:'en',requested:undefined,revision:0}),setUiLocale:async(value:string)=>{projected.push(value)},onUiLocaleChanged:()=>()=>{}}
 Object.defineProperty(globalThis,'window',{value:{lyapunovDesktop:desktop},configurable:true})
 const ctx=new Context()
 const locale={register:()=>()=>{},getSnapshot:()=>({active:'en'}),subscribe:()=>()=>{},setLocale:()=>{}}
 const slots={inject:(_name:string,callback:()=>unknown)=>callback(),register:()=>()=>{}}
 const settingsScope={bind:({namespace}:{namespace:string})=>{binds.push(namespace);return {getSnapshot:()=>({status:'ready'}),subscribe:()=>()=>{}}}}
 try{
  for(const name of inject)ctx.provide(name,(name==='locale'?locale:name==='slots'?slots:name==='settingsScope'?settingsScope:{}) as never)
  await ctx.plugin({inject,apply:applyProductUI})
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(binds).toEqual(['locale'])
  expect(projected).toEqual(['en'])
 }finally{await ctx.fiber.dispose();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window')}
})
