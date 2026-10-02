import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mark, BrandName, WelcomeHeadline } from '../src/product-ui.tsx'
import { LYAPUNOV_ICON_DATA_URL, LYAPUNOV_ICON_SHA256 } from '../src/brand-artwork.ts'
import { createWelcomeVerseStore, welcomeVerses } from '../src/welcome-verses.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

test('侧栏/hero使用同一真实随包PNG，字节完全相等，收起/展开几何由owner决定',()=>{
 const original=readFileSync(join(import.meta.dirname,'../../desktop/icons/lyapunov.png'))
 const encoded=Buffer.from(LYAPUNOV_ICON_DATA_URL.split(',')[1]!,'base64')
 expect(encoded.equals(original)).toBe(true)
 expect(createHash('sha256').update(original).digest('hex')).toBe(LYAPUNOV_ICON_SHA256)
 for(const size of [24,34]){const html=renderToStaticMarkup(<Mark size={size} className="native-owner"/>);expect(html).toContain(`width="${size}"`);expect(html).toContain(`height="${size}"`);expect(html).toContain('aria-hidden="true"');expect(html).not.toContain('<svg')}
 const name=renderToStaticMarkup(<BrandName t={key=>key}/>)
 expect(name).toContain('Lyapunov');expect(name).toContain('Noto Sans')
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
