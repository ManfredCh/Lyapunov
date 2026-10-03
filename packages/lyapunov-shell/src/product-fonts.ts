import {readFile} from "node:fs/promises"
import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-connection"

export const PRODUCT_FONT_ASSETS={"lyapunov-fonts.css":"text/css; charset=utf-8","NotoSansSC-Regular.otf":"font/otf","OFL.txt":"text/plain; charset=utf-8","NOTICE.txt":"text/plain; charset=utf-8","SOURCES.json":"application/json"} as const
/** src 与 dist 的相对目录相同；固定随包资产，不接受用户路径或远程字体地址。 */
export async function productFontResponse(name:string):Promise<Response>{
 if(!Object.hasOwn(PRODUCT_FONT_ASSETS,name))return new Response("Not found",{status:404})
 const bytes=await readFile(new URL(`../../desktop/renderer/fonts/${name}`,import.meta.url))
 return new Response(bytes,{headers:{"content-type":PRODUCT_FONT_ASSETS[name as keyof typeof PRODUCT_FONT_ASSETS],"cache-control":"private, max-age=86400"}})
}
export function applyProductFontsHost(ctx:Context){
 for(const name of Object.keys(PRODUCT_FONT_ASSETS))ctx.effect(()=>ctx.connection.fetch.register({path:`/api/lyapunov/fonts/${name}`,methods:["GET"],requestBody:"buffered",fetch:()=>productFontResponse(name)}))
}
