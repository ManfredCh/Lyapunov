import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mark, BrandName, WelcomeHeadline } from '../src/product-ui.tsx'
import { LYAPUNOV_ICON_DATA_URL, LYAPUNOV_ICON_SHA256 } from '../src/brand-artwork.ts'
import { createWelcomeVerseStore, welcomeVerses } from '../src/welcome-verses.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { accountLocales,desktopLocales,type DesktopLocaleState } from '../../desktop/src/account-locales.ts'
import { productFontResponse } from '../src/product-fonts.ts'
import { synchronizeDesktopLocale } from '../src/product-locale.ts'

test('侧栏/hero使用同一真实随包PNG，字节完全相等，收起/展开几何由owner决定',()=>{
 const original=readFileSync(join(import.meta.dirname,'../../desktop/icons/lyapunov.png'))
 const encoded=Buffer.from(LYAPUNOV_ICON_DATA_URL.split(',')[1]!,'base64')
 expect(encoded.equals(original)).toBe(true)
 expect(createHash('sha256').update(original).digest('hex')).toBe(LYAPUNOV_ICON_SHA256)
 for(const size of [24,34]){const html=renderToStaticMarkup(<Mark size={size} className="native-owner"/>);expect(html).toContain(`width="${size}"`);expect(html).toContain(`height="${size}"`);expect(html).toContain('aria-hidden="true"');expect(html).not.toContain('<svg')}
 const name=renderToStaticMarkup(<BrandName t={key=>key}/>)
 expect(name).toContain('Lyapunov');expect(name).toContain('Noto Sans')
})
test('英文欢迎只显示原生语言对应文案，中文诗句与来源保留且切换不换句',()=>{
 const store=createWelcomeVerseStore(()=>0),id=SessionId('bilingual-welcome')
 const zh=renderToStaticMarkup(<WelcomeHeadline sessionId={id} store={store} locale="zh"/>),en=renderToStaticMarkup(<WelcomeHeadline sessionId={id} store={store} locale="en" welcome="Welcome to Lyapunov"/>)
 expect(zh).toContain(store.get('session:'+id).text);expect(zh).toContain('title=')
 expect(en).toContain('Welcome to Lyapunov');expect(en).not.toMatch(/[\u3400-\u9fff]/);expect(en).not.toContain('title=')
 expect(renderToStaticMarkup(<WelcomeHeadline sessionId={id} store={store} locale="zh"/>)).toBe(zh)
})
test('桌面等待原生持久locale读回，账户选择仍经原生入口，销毁后不继续投影',async()=>{
 let active='en',status:'loading'|'ready'='loading',revision=0
 const localeListeners=new Set<()=>void>(),scopeListeners=new Set<()=>void>(),writes:string[]=[],reports:string[]=[]
 let desktopListener!:(value:DesktopLocaleState)=>void
 const locale={getSnapshot:()=>({active}),subscribe:(listener:()=>void)=>{localeListeners.add(listener);return()=>{localeListeners.delete(listener)}},setLocale:(id:string)=>{writes.push(id);active=id;for(const listener of localeListeners)listener()}}
 const scope={getSnapshot:()=>({status}),subscribe:(listener:()=>void)=>{scopeListeners.add(listener);return()=>{scopeListeners.delete(listener)}}}
 const stop=synchronizeDesktopLocale(locale,scope,{uiLocale:async()=>({active:'en',revision:0}),setUiLocale:async id=>{reports.push(id)},onUiLocaleChanged:listener=>{desktopListener=listener;return()=>{desktopListener=()=>{}}}})
 await Promise.resolve();expect(reports).toEqual([])
 active='zh';status='ready';for(const listener of scopeListeners)listener()
 expect(reports).toEqual(['zh']);expect(writes).toEqual([])
 desktopListener({active:'en',requested:'en',revision:++revision})
 expect(writes).toEqual(['en']);expect(reports.at(-1)).toBe('en')
 desktopListener({active:'zh',requested:'zh',revision:0});expect(active).toBe('en')
 stop();active='zh';for(const listener of localeListeners)listener();for(const listener of scopeListeners)listener();desktopListener({active:'zh',requested:'zh',revision:++revision})
 expect(reports.at(-1)).toBe('en');expect(writes).toEqual(['en'])
})
test('随包原始字库的真实cmap覆盖桌面中文与四句欢迎诗，CSS/Host引用同一可重定位文件',async()=>{
 const font=readFileSync(join(import.meta.dirname,'../../desktop/renderer/fonts/NotoSansSC-Regular.otf'))
 expect(createHash('sha256').update(font).digest('hex')).toBe('faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9')
 let cmap=-1
 for(let i=0;i<font.readUInt16BE(4);i++){const row=12+i*16;if(font.toString('ascii',row,row+4)==='cmap')cmap=font.readUInt32BE(row+8)}
 expect(cmap).toBeGreaterThan(0)
 let format12=-1
 for(let i=0;i<font.readUInt16BE(cmap+2);i++){const row=cmap+4+i*8,table=cmap+font.readUInt32BE(row+4);if([0,3].includes(font.readUInt16BE(row))&&font.readUInt16BE(table)===12)format12=table}
 expect(format12).toBeGreaterThan(0)
 const groups=Array.from({length:font.readUInt32BE(format12+12)},(_,i)=>{const row=format12+16+i*12;return {start:font.readUInt32BE(row),end:font.readUInt32BE(row+4),glyph:font.readUInt32BE(row+8)}})
 const sample=[...Object.values(accountLocales.zh),...Object.values(desktopLocales.zh),...welcomeVerses.map(item=>item.text),'中文登录设置工作台欢迎诗句机器人资源㐀㐁龥'].join('')
 const missing=[...new Set([...sample].filter(char=>{const cp=char.codePointAt(0)!;return cp>=0x3400&&cp<=0x9fff&&!groups.some(group=>cp>=group.start&&cp<=group.end&&group.glyph+cp-group.start>0)}))]
 expect(missing).toEqual([])
 const response=await productFontResponse('NotoSansSC-Regular.otf');expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('font/otf');expect(Buffer.from(await response.arrayBuffer()).equals(font)).toBe(true)
 const css=await (await productFontResponse('lyapunov-fonts.css')).text();expect(css).toContain('url("./NotoSansSC-Regular.otf")');expect(css).toContain('--dsw-font-family:');expect(css).not.toContain('http')
 expect((await productFontResponse('../NotoSansSC-Regular.otf')).status).toBe(404)
 expect(await (await productFontResponse('OFL.txt')).text()).toContain('SIL OPEN FONT LICENSE')
 const accountStyle=readFileSync(join(import.meta.dirname,'../../desktop/renderer/style.css'),'utf8'),accountHTML=readFileSync(join(import.meta.dirname,'../../desktop/renderer/index.html'),'utf8')
 expect(accountStyle).toContain('@import url("./fonts/lyapunov-fonts.css")');expect(accountHTML).toContain("font-src 'self'")
})
test('短句同欢迎身份重复render稳定，新身份排除上一句；来源无伪造诗人/后端API',()=>{
 let calls=0;const store=createWelcomeVerseStore(()=>{calls++;return 0})
 const a=store.get('session-a');expect(store.get('session-a')).toBe(a);expect(calls).toBe(1)
 const b=store.get('session-b');expect(b.id).not.toBe(a.id);expect(store.get('session-b')).toBe(b);expect(calls).toBe(2)
 const id=SessionId('isolated-welcome-session')
 const first=renderToStaticMarkup(<WelcomeHeadline sessionId={id} store={store}/>),second=renderToStaticMarkup(<WelcomeHeadline sessionId={id} store={store}/>)
 expect(first).toBe(second);expect(first).toContain('lyapunov-welcome-verse');expect(first).toContain('Noto Serif CJK SC')
 expect(welcomeVerses.every(verse=>verse.author===null&&verse.verified&&verse.text.length<=9)).toBe(true)
 expect(welcomeVerses.every(verse=>verse.sourceURL.startsWith('https://vorynel.com/assets/'))).toBe(true)
})
test('Linux desktop identity与标准菜单entry同名；不改变原app名称、数据/Exec/沙箱逻辑',()=>{
 const main=readFileSync(join(import.meta.dirname,'../../desktop/src/main.ts'),'utf8')
 const desktop=readFileSync(join(import.meta.dirname,'../../../distribution/linux/lyapunov-desktop.desktop.in'),'utf8')
 expect(main).toContain('app.setDesktopName("lyapunov-desktop.desktop")')
 expect(main).toContain('app.setName("LyapunovDSH")')
 expect(desktop).toContain('StartupWMClass=lyapunov-desktop')
 expect(desktop).toContain('Exec=@LYAPUNOV_EXEC@')
 expect(desktop).toContain('Icon=@LYAPUNOV_ICON@')
})
